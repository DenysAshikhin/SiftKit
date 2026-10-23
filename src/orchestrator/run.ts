import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  OrchestratorApprovalDecisionSchema,
  OrchestratorDriftReviewSchema,
  OrchestratorPlanPreparationSchema,
  OrchestratorTaskReviewSchema,
  isOrchestratorTerminalPhase,
  type OrchestratorActivity,
  type OrchestratorAttempt,
  type OrchestratorAttemptResult,
  type OrchestratorCheckResult,
  type OrchestratorChildWork,
  type OrchestratorCommandCheck,
  type OrchestratorDriftFinding,
  type OrchestratorDriftReview,
  type OrchestratorFailure,
  type OrchestratorFailureCode,
  type OrchestratorPendingApproval,
  type OrchestratorPlan,
  type OrchestratorPlanPreparation,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
  type OrchestratorTask,
  type OrchestratorTaskReview,
  type OrchestratorTaskStatus,
  type OrchestratorVerificationCheck,
  type RepoAgentApproval,
  type RepoAgentDecision,
} from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.ts';
import { toError } from '../lib/errors.ts';
import { ModelJson } from '../lib/model-json.ts';
import type { z } from '../lib/zod.ts';
import { buildPlannerJsonSchema } from '../planner-protocol/json-schema.ts';
import { PresetCatalog } from '../preset-catalog.ts';
import { PresetSystemContextBuilder, type PresetSystemContext } from '../preset-system-context.ts';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';
import { readConfig } from '../status-server/config-store.ts';
import type { OrchestratorLiveRun, RepositoryAccess, RepositoryLease } from '../status-server/orchestrator-runs.ts';
import type { RepoAgentSession } from '../status-server/repo-agent-sessions.ts';
import type { ServerContext } from '../status-server/server-types.ts';
import { chatSessionExists } from '../state/chat-sessions.ts';
import { resolveNewSessionModelConfig } from '../status-server/new-chat-session.ts';
import { showRunInChatSession } from './chat-sessions.ts';
import { findUnrunnableChecks } from './check-preflight.ts';
import { buildDriftCorrectionWork, validateDriftReview } from './drift-review.ts';
import {
  ORCHESTRATOR_PHASE_ANSWER_NAMES,
  OrchestratorInfrastructureError,
  OrchestratorPhaseRunner,
  type OrchestratorPhaseLabel,
} from './phase-runner.ts';
import { OrchestratorLiveActivity } from './live-activity.ts';
import { renderOrchestratorPlan, validateOrchestratorPlan } from './plan.ts';
import {
  buildAttemptReviewPrompt,
  buildChildApprovalPrompt,
  buildCheckApprovalPrompt,
  buildDriftCorrectionPrompt,
  buildDriftReviewPrompt,
  buildFinalVerificationPrompt,
  buildImplementationInstruction,
  buildParentPrompt,
  buildPlanPreparationPrompt,
  describeRejection,
  type ImplementationRetryEvidence,
  type PlanWorker,
  type RunContext,
} from './prompts.ts';
import { isMutatingTask, schedulePass, workerModelPreset } from './scheduler.ts';
import { evaluateAttempt, findReviewEvidenceProblems, runVerificationCheck, unexecutedCheck } from './verification.ts';
import { startOrchestratorChild, toChildOutcome, type ChildOutcome } from './workers.ts';
import {
  captureWorkspace,
  changesNeedDriftReview,
  cleanupScratch,
  diffWorkspace,
  findScopeViolations,
  orchestratorArtifactDir,
  orchestratorScratchDir,
  removeOwnedTemporaryPath,
  renderWorkspaceDiff,
  type WorkspaceChanges,
  type WorkspaceSnapshot,
} from './workspace.ts';

/** Each parent phase gets this many tries for its infrastructure, and separately for usable answers. */
const PARENT_PHASE_ATTEMPTS = 2;

/** A parsed parent answer, or the problems that make it unusable so the caller can ask again with them. */
type ParentReply<T> = { ok: true; answer: T } | { ok: false; problems: string[] };

/** A task between its lease and its completion; a reader collects paths an overlapping writer changed. */
type RunningTask = { task: OrchestratorTask; mutating: boolean; baseline: WorkspaceSnapshot; writerPaths: Set<string> };

/** What the parent's evidence review covers: one task attempt, or the run's final verification. */
type EvidenceReviewRequest =
  | { kind: 'task'; running: RunningTask; child: ChildOutcome; checks: OrchestratorCheckResult[]; changedPaths: string[] }
  | { kind: 'final'; checks: OrchestratorCheckResult[] };

/** An answered approval the run continues with; an abort never returns. */
type ContinuingDecision = Exclude<RepoAgentDecision, { decision: 'abort' }>;

type PendingUserDecision = { approvalId: string; resolve(decision: RepoAgentDecision): void };

/** Captured once before the plan: the parent's frozen system context and the checkout's dirty paths. */
type RunStart = { systemContext: PresetSystemContext; dirtyPaths: string[] };

/** A stop with a precise, stored diagnosis. */
class OrchestratorRunFailure extends Error {
  readonly failure: OrchestratorFailure;

  constructor(failure: OrchestratorFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

function fail(code: OrchestratorFailureCode, message: string, detail: Partial<Omit<OrchestratorFailure, 'code' | 'message'>> = {}): OrchestratorRunFailure {
  return new OrchestratorRunFailure({ code, message, taskId: detail.taskId ?? null, purpose: detail.purpose ?? null,
    findingIds: detail.findingIds ?? [] });
}

type AttemptOutcome = { result: OrchestratorAttemptResult; findings: string[] };

/**
 * One live orchestrator parent: prepares the plan, schedules bounded children under the repository
 * gate, verifies their work independently, gates code changes on drift review, and records every
 * transition. It holds a model lease only inside finite phases, never across a child's wait, and
 * runs on the configuration it was started with.
 */
export class OrchestratorRun implements OrchestratorLiveRun {
  readonly runId: string;
  readonly settled: Promise<void>;
  private readonly abortController = new AbortController();
  private readonly phases: OrchestratorPhaseRunner;
  private readonly children = new Map<string, RepoAgentSession>();
  private readonly activity: OrchestratorLiveActivity;
  private pendingUserDecision: PendingUserDecision | null = null;
  /** Settles when the latest approval is answered; parallel tasks take turns so one approval is pending at a time. */
  private approvalTurn: Promise<void> = Promise.resolve();
  private readonly runningTasks = new Set<RunningTask>();
  private registered = false;
  private state: OrchestratorRunState;
  private readonly workers: PlanWorker[];
  private runStart: RunStart | null = null;

  private readonly ctx: ServerContext;
  private readonly config: SiftConfig;

  private constructor(ctx: ServerContext, state: OrchestratorRunState, config: SiftConfig) {
    this.ctx = ctx;
    this.config = config;
    this.workers = config.Presets
      .filter((preset) => preset.presetKind === 'repo-agent' || preset.presetKind === 'repo-search')
      .map((preset) => ({ preset, model: workerModelPreset(config, preset) }));
    this.runId = state.runId;
    this.state = state;
    this.phases = new OrchestratorPhaseRunner(ctx, config);
    this.activity = new OrchestratorLiveActivity(state.runId, ctx.orchestratorRuns);
    // Work begins on the next tick, and only once the registry owns this run.
    this.settled = Promise.resolve().then(() => (this.registered ? this.execute() : undefined));
    ctx.orchestratorRuns.register(this);
    this.registered = true;
  }

  /** Creates (or returns the existing parent for) a submission; only a new parent starts work. Every run shows in a chat session. */
  static async start(ctx: ServerContext, request: OrchestratorStartRequest): Promise<OrchestratorRunState> {
    const config = readConfig(ctx.configPath);
    requireOrchestratorPreset(config, request.presetId);
    // Resolved before any write, so creating the run and linking its session stay one synchronous step.
    const modelConfig = await resolveNewSessionModelConfig(ctx, request.presetId);
    if (!existsSync(request.repoRoot) || !statSync(request.repoRoot).isDirectory()) {
      throw new Error(`Repository folder '${request.repoRoot}' does not exist.`);
    }
    if (request.sessionId !== null && !chatSessionExists(ctx.runtimeDatabase, request.sessionId)) {
      throw new Error(`Chat session '${request.sessionId}' does not exist.`);
    }
    const state = ctx.orchestratorRunStore.create(request);
    showRunInChatSession(ctx, config, modelConfig, request, state.runId);
    if (!isOrchestratorTerminalPhase(state.phase) && ctx.orchestratorRuns.get(state.runId) === undefined && state.revision === 0) {
      new OrchestratorRun(ctx, state, config);
    }
    return state;
  }

  abort(reason: string): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(new Error(reason));
    for (const child of this.children.values()) child.abort();
  }

  decide(approvalId: string, decision: RepoAgentDecision): boolean {
    const pending = this.pendingUserDecision;
    if (pending === null || pending.approvalId !== approvalId) return false;
    this.pendingUserDecision = null;
    pending.resolve(decision);
    return true;
  }

  activitySnapshot(): OrchestratorActivity {
    return this.activity.snapshot();
  }

  private get signal(): AbortSignal {
    return this.abortController.signal;
  }

  private get request(): OrchestratorStartRequest {
    return this.state.request;
  }

  private requireRunStart(): RunStart {
    if (this.runStart === null) throw new Error('The run start must be captured before any parent phase.');
    return this.runStart;
  }

  /** The block every parent prompt starts with; every phase after plan preparation requires the saved plan. */
  private runContext(label: OrchestratorPhaseLabel): RunContext {
    const { plan, planPath, planHash } = this.state;
    const saved = plan === null || planPath === null || planHash === null ? null : { path: planPath, hash: planHash, plan };
    if (saved === null && label !== 'plan preparation') throw new Error(`The plan must be saved before the ${label} phase.`);
    return { task: this.request.task, workers: this.workers, preexistingDirtyPaths: this.requireRunStart().dirtyPaths, plan: saved };
  }

  // ---- lifecycle ----

  /** Runs the work, then stops every child; only then does a failed run clean its scratch files and settle. */
  private async execute(): Promise<void> {
    let failure: Error | null = null;
    try {
      this.runStart = {
        systemContext: new PresetSystemContextBuilder(this.request.repoRoot)
          .build(PresetCatalog.fromPresets(this.config.Presets).requireById(this.request.presetId)),
        dirtyPaths: [...(await captureWorkspace(this.request.repoRoot)).keys()],
      };
      const plan = await this.preparePlan();
      await this.executeTasks(plan);
      await this.verifyFinal(plan);
      this.commit({ phase: 'cleaning' }, 'Cleaning run scratch files.');
      const cleanupProblem = this.cleanupRunScratch();
      if (cleanupProblem !== null) throw fail('cleanup_failed', cleanupProblem);
      this.commit({ phase: 'completed', failure: null }, 'Run completed.');
    } catch (error) {
      failure = toError(error);
    }
    this.pendingUserDecision = null;
    for (const child of this.children.values()) child.abort();
    await Promise.allSettled([...this.children.values()].map((child) => child.settled));
    if (failure === null) return;
    const cleanupProblem = this.cleanupRunScratch();
    this.settleFailure(failure, cleanupProblem === null ? null : `Scratch cleanup also failed: ${cleanupProblem}`);
  }

  private settleFailure(error: Error, cleanupProblem: string | null): void {
    const current = this.ctx.orchestratorRunStore.read(this.runId);
    if (isOrchestratorTerminalPhase(current.phase)) {
      this.state = current;
      return;
    }
    this.state = current;
    const withCleanup = (message: string): string => [message, cleanupProblem].filter((part) => part !== null).join(' ');
    if (this.signal.aborted) {
      const message = withCleanup(toError(this.signal.reason).message);
      this.commit({ phase: 'aborted', approval: null,
        failure: { code: 'aborted', message, taskId: null, purpose: null, findingIds: [] } }, message);
      return;
    }
    const stored = error instanceof OrchestratorRunFailure
      ? error.failure
      : fail(error instanceof OrchestratorInfrastructureError ? 'infrastructure_failed' : 'internal_error', error.message).failure;
    const failure = { ...stored, message: withCleanup(stored.message) };
    this.commit({ phase: 'failed', approval: null, failure }, failure.message);
  }

  private commit(changes: Parameters<ServerContext['orchestratorRunStore']['update']>[2], message: string,
    detail: { taskId?: string; purpose?: OrchestratorAttempt['purpose']; attempt?: number; childRunId?: string } = {}): void {
    this.publish(this.ctx.orchestratorRunStore.update(this.runId, this.state.revision, changes, { message, ...detail }));
  }

  private publish(state: OrchestratorRunState): void {
    this.state = state;
    this.ctx.orchestratorRuns.publish(state);
  }

  private setTask(taskId: string, change: Partial<Omit<OrchestratorRunState['tasks'][number], 'taskId'>>, message: string): void {
    const tasks = this.state.tasks.map((task) => (task.taskId === taskId ? { ...task, ...change } : task));
    this.commit({ tasks }, message, { taskId });
  }

  private setTaskStatus(taskId: string, status: OrchestratorTaskStatus): void {
    this.setTask(taskId, { status }, `Task ${taskId}: ${status.replace(/_/gu, ' ')}.`);
  }

  /**
   * One parent answer, each try committed as a phase. An infrastructure failure is retried once and then ends
   * the run; an unusable answer comes back as its problems, which `rejected` carries into the next ask.
   */
  private async askParent<T>(label: OrchestratorPhaseLabel, phasePrompt: string, schema: z.ZodType<T>,
    rejected: readonly string[]): Promise<ParentReply<T>> {
    const prompt = buildParentPrompt(this.runContext(label), phasePrompt, buildPlannerJsonSchema(schema));
    let retryReason = rejected.length === 0 ? null : rejected.join(' ');
    for (let attempt = 1; ; attempt += 1) {
      const phaseRunId = randomUUID();
      this.commit({ phaseRunIds: [...this.state.phaseRunIds, phaseRunId] },
        retryReason === null ? `Parent phase started: ${label}.` : `Parent phase started: ${label}; retrying after: ${retryReason}`);
      let output: string;
      try {
        output = await this.phases.infer({ runId: this.runId, phaseRunId, presetId: this.request.presetId,
          repoRoot: this.request.repoRoot, systemContext: this.requireRunStart().systemContext, abortSignal: this.signal }, prompt, label, schema);
      } catch (error) {
        this.signal.throwIfAborted();
        if (!(error instanceof OrchestratorInfrastructureError)) return { ok: false, problems: [toError(error).message] };
        if (attempt >= PARENT_PHASE_ATTEMPTS) {
          throw new OrchestratorInfrastructureError(`Orchestrator ${label} phase failed ${attempt} times: ${error.message}`);
        }
        retryReason = `infrastructure failure: ${error.message}`;
        continue;
      }
      try {
        return { ok: true, answer: ModelJson.parseObject(output, schema, ORCHESTRATOR_PHASE_ANSWER_NAMES[label]) };
      } catch (error) {
        return { ok: false, problems: [toError(error).message] };
      }
    }
  }

  private acquireRepository(access: RepositoryAccess): Promise<RepositoryLease> {
    return this.ctx.orchestratorRuns.repositoryGate.acquire(this.request.repoRoot, access, this.runId, this.signal);
  }

  // ---- plan ----

  private async preparePlan(): Promise<OrchestratorPlan> {
    const supplied = this.request.planPath === null ? null : readSuppliedPlan(this.request.repoRoot, this.request.planPath);
    let rejected: string[] = [];
    for (let attempt = 1; attempt <= PARENT_PHASE_ATTEMPTS; attempt += 1) {
      const lease = await this.acquireRepository('shared');
      let reply: ParentReply<OrchestratorPlanPreparation>;
      try {
        reply = await this.askParent('plan preparation', buildPlanPreparationPrompt({
          planPath: supplied?.path ?? null, planMarkdown: supplied?.markdown ?? null, rejectedProblems: rejected,
        }), OrchestratorPlanPreparationSchema, rejected);
      } finally {
        lease.release();
      }
      if (!reply.ok) {
        rejected = reply.problems;
        continue;
      }
      const preparation = reply.answer;
      if (preparation.status === 'blocked') throw fail('plan_blocked', `The plan could not be prepared: ${preparation.reason}`);
      this.commit({ phase: 'validating_plan' }, 'Validating the plan.');
      let plan: OrchestratorPlan;
      try {
        plan = validateOrchestratorPlan(preparation.plan, this.config, this.request.repoRoot);
      } catch (error) {
        rejected = [toError(error).message];
        this.commit({ phase: 'preparing_plan' }, `Plan rejected: ${rejected[0] ?? ''}`);
        continue;
      }
      const unrunnable = await findUnrunnableChecks(this.request.repoRoot,
        [...plan.tasks.flatMap((task) => task.verification), ...plan.finalVerification], this.signal);
      if (unrunnable.length > 0) {
        rejected = unrunnable;
        this.commit({ phase: 'preparing_plan' }, `Plan rejected: ${unrunnable[0] ?? ''}`);
        continue;
      }
      const saved = preparation.status === 'ready' && supplied !== null
        ? { path: supplied.path, markdown: supplied.markdown }
        : await this.writeGeneratedPlan(plan);
      this.publish(this.ctx.orchestratorRunStore.savePlan(this.runId, this.state.revision, plan, saved.path, hashText(saved.markdown)));
      this.commit({ phase: 'executing' }, 'Executing the plan.');
      return plan;
    }
    throw fail('plan_invalid', `No valid plan after ${PARENT_PHASE_ATTEMPTS} attempts: ${rejected.join(' ')}`);
  }

  /** The host, not the model, writes the Markdown plan, under exclusive repository ownership. */
  private async writeGeneratedPlan(plan: OrchestratorPlan): Promise<{ path: string; markdown: string }> {
    const path = `${orchestratorArtifactDir(this.runId)}/plan.md`;
    const markdown = renderOrchestratorPlan(plan);
    const lease = await this.acquireRepository('exclusive');
    try {
      const absolute = join(this.request.repoRoot, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, markdown, 'utf8');
    } finally {
      lease.release();
    }
    return { path, markdown };
  }

  // ---- scheduling ----

  private async executeTasks(plan: OrchestratorPlan): Promise<void> {
    const { planPath, planHash } = this.state;
    if (planPath === null || planHash === null) throw new Error('Tasks cannot start before the plan is saved.');
    const running = new Map<string, { task: OrchestratorTask; done: Promise<string> }>();
    for (;;) {
      this.signal.throwIfAborted();
      const pass = schedulePass({ config: this.config, plan, taskStates: this.state.tasks,
        active: [...running.values()].map((entry) => entry.task) });
      for (const task of pass.start) {
        this.setTaskStatus(task.id, 'running');
        running.set(task.id, { task, done: this.runTask(task, planPath, planHash).then(() => task.id) });
      }
      this.activity.setSchedule(pass.schedule);
      if (running.size === 0) {
        const unfinished = this.state.tasks.filter((task) => task.status !== 'completed').map((task) => task.taskId);
        if (unfinished.length === 0) return;
        throw fail('blocked', `Tasks cannot start: ${unfinished.join(', ')}.`);
      }
      try {
        running.delete(await Promise.race([...running.values()].map((entry) => entry.done)));
      } catch (error) {
        // Stop scheduling, stop owned children, and let them settle before reporting the failure.
        for (const child of this.children.values()) child.abort();
        await Promise.allSettled([...running.values()].map((entry) => entry.done));
        throw error;
      }
    }
  }

  private async runTask(task: OrchestratorTask, planPath: string, planHash: string): Promise<void> {
    const mutating = isMutatingTask(this.config, task);
    const lease = await this.acquireRepository(mutating ? 'exclusive' : 'shared');
    try {
      const running: RunningTask = { task, mutating, baseline: await captureWorkspace(this.request.repoRoot), writerPaths: new Set() };
      this.runningTasks.add(running);
      try {
        await this.implementTask(running, planPath, planHash);
      } finally {
        this.runningTasks.delete(running);
      }
    } finally {
      lease.release();
    }
  }

  /** Implementation attempts until one passes, then the drift gate and cleanup. */
  private async implementTask(running: RunningTask, planPath: string, planHash: string): Promise<void> {
    const { task, baseline } = running;
    let retry: ImplementationRetryEvidence | null = null;
    let passing: AttemptOutcome | null = null;
    while (passing === null) {
      const attempt = this.reserve(task.id, { kind: 'implementation', planPath, planHash, task });
      const instruction = buildImplementationInstruction({ task, planPath, planHash, attempt: attempt.attempt,
        scratchPath: orchestratorScratchDir(this.runId), preexistingDirtyPaths: [...baseline.keys()], retry });
      const outcome = await this.runAttempt(running, task, task.writePaths, attempt, instruction);
      if (outcome.result.passed) {
        passing = outcome;
      } else if (attempt.attempt >= ORCHESTRATOR_MAX_ATTEMPTS) {
        this.setTaskStatus(task.id, 'failed');
        throw fail('implementation_failed',
          `Task '${task.id}' failed all ${ORCHESTRATOR_MAX_ATTEMPTS} implementation attempts: ${outcome.findings.join(' ')}`,
          { taskId: task.id, purpose: 'implementation' });
      } else {
        this.setTaskStatus(task.id, 'retry_pending');
        retry = { failure: outcome.findings.join('\n'), checks: outcome.result.checks, changedPaths: outcome.result.changedPaths,
          diff: await this.renderDiff(baseline, outcome.result.changedPaths) };
      }
    }
    await this.driftGate(running, passing.result.checks);
    this.cleanupTaskTemporaries(task);
    this.setTaskStatus(task.id, 'completed');
  }

  /**
   * The task's changes since its baseline. A writer's changes are passed to every reader running beside it,
   * and a reader is charged with neither those nor the live writer's; a reader that started later is charged in full.
   */
  private async taskChanges(running: RunningTask): Promise<WorkspaceChanges> {
    const { repoRoot } = this.request;
    if (running.mutating) {
      const changes = await diffWorkspace(repoRoot, running.baseline);
      for (const reader of this.runningTasks) {
        if (!reader.mutating) for (const path of changes.paths) reader.writerPaths.add(path);
      }
      return changes;
    }
    const writer = [...this.runningTasks].find((other) => other.mutating);
    const livePaths = writer === undefined ? [] : (await diffWorkspace(repoRoot, writer.baseline)).paths;
    return diffWorkspace(repoRoot, running.baseline, new Set([...running.writerPaths, ...livePaths]));
  }

  private cleanupTaskTemporaries(task: OrchestratorTask): void {
    try {
      for (const temporary of task.temporaryPaths) {
        removeOwnedTemporaryPath(this.request.repoRoot, orchestratorScratchDir(this.runId), temporary);
      }
    } catch (error) {
      throw fail('cleanup_failed', toError(error).message, { taskId: task.id });
    }
  }

  /** Removes the run's scratch files; returns why that failed, or null. */
  private cleanupRunScratch(): string | null {
    try {
      cleanupScratch(this.request.repoRoot, orchestratorScratchDir(this.runId));
      return null;
    } catch (error) {
      return toError(error).message;
    }
  }

  private reserve(taskId: string, work: OrchestratorChildWork): OrchestratorAttempt {
    const attempt = this.ctx.orchestratorRunStore.reserveAttempt(this.runId, this.state.revision, taskId, work);
    this.publish(this.ctx.orchestratorRunStore.read(this.runId));
    return attempt;
  }

  // ---- one child attempt: dispatch, supervise, verify ----

  /** One child attempt for `running`; `task` is its work for this attempt (a drift fix carries its own checks). */
  private async runAttempt(
    running: RunningTask,
    task: OrchestratorTask,
    writePaths: readonly string[],
    attempt: OrchestratorAttempt,
    instruction: string,
  ): Promise<AttemptOutcome> {
    const child = await this.superviseChild(task, attempt, instruction);
    this.setTaskStatus(task.id, 'verifying');
    const checks = await this.runChecks(task.verification, task);
    const changes = await this.taskChanges(running);
    const scopeViolations = findScopeViolations(changes.paths, writePaths);
    const review = checks.some((check) => check.check.kind === 'evidence')
      ? await this.askEvidenceReview({ kind: 'task', running, child, checks, changedPaths: changes.paths })
      : null;
    const { findings } = evaluateAttempt({ repoRoot: this.request.repoRoot, workerStatus: child.workerStatus, checks, scopeViolations,
      review });
    const result: OrchestratorAttemptResult = {
      taskId: task.id, purpose: attempt.purpose, attempt: attempt.attempt, childRunId: attempt.childRunId,
      workerStatus: child.workerStatus, workerOutput: child.output, passed: findings.length === 0, checks, findings,
      changedPaths: changes.paths, scopeViolations, changeDigest: changes.digest,
    };
    this.publish(this.ctx.orchestratorRunStore.recordAttemptResult(this.runId, this.state.revision, result));
    return { result, findings };
  }

  /** The parent's evidence review. Its own unusable answers and bad citations are retried here, never charged to the work. */
  private async askEvidenceReview(review: EvidenceReviewRequest): Promise<OrchestratorTaskReview> {
    let rejected: string[] = [];
    let described = this.describeEvidenceReview(review, rejected);
    for (let attempt = 1; attempt <= PARENT_PHASE_ATTEMPTS; attempt += 1) {
      described = this.describeEvidenceReview(review, rejected);
      const reply = await this.askParent(described.label, described.prompt, OrchestratorTaskReviewSchema, rejected);
      rejected = reply.ok ? findReviewEvidenceProblems(this.request.repoRoot, reply.answer) : reply.problems;
      if (reply.ok && rejected.length === 0) return reply.answer;
    }
    throw fail(described.failureCode, `${described.subject} was unusable: ${rejected.join(' ')}`, { taskId: described.taskId });
  }

  /** One evidence review's phase, prompt, and the failure it ends in when no answer is usable. */
  private describeEvidenceReview(review: EvidenceReviewRequest, rejectedProblems: readonly string[]):
    { label: OrchestratorPhaseLabel; prompt: string; failureCode: OrchestratorFailureCode; subject: string; taskId: string | null } {
    switch (review.kind) {
      case 'task': {
        const { task, baseline } = review.running;
        const runDirty = new Set(this.requireRunStart().dirtyPaths);
        return { label: 'task review', failureCode: 'task_review_invalid', subject: `Task '${task.id}' evidence review`, taskId: task.id,
          prompt: buildAttemptReviewPrompt({ task, result: { workerOutput: review.child.output, checks: review.checks,
            changedPaths: review.changedPaths }, preexistingDirtyPaths: [...baseline.keys()].filter((path) => !runDirty.has(path)),
            rejectedProblems }) };
      }
      case 'final':
        return { label: 'final verification', failureCode: 'final_review_invalid', subject: 'The final evidence review', taskId: null,
          prompt: buildFinalVerificationPrompt({ checks: review.checks, rejectedProblems }) };
    }
  }

  private async superviseChild(task: OrchestratorTask, attempt: OrchestratorAttempt, instruction: string): Promise<ChildOutcome> {
    this.signal.throwIfAborted();
    // Every attempt, drift corrections included, runs on the task's worker: the model slot it claimed.
    const session = startOrchestratorChild(this.ctx, this.config, {
      runId: this.runId, taskId: task.id, attempt: attempt.attempt, childRunId: attempt.childRunId,
      workerPresetId: task.workerPresetId, repoRoot: this.request.repoRoot, work: attempt.work, instruction, approval: this.request.approval,
    });
    this.children.set(attempt.childRunId, session);
    this.activity.track(session, { childRunId: attempt.childRunId, taskId: task.id });
    this.publish(this.ctx.orchestratorRunStore.markAttemptRunning(this.runId, this.state.revision, attempt.childRunId));
    try {
      let seen = 0;
      for (;;) {
        const boundary = await session.waitForBoundary(seen, this.signal);
        seen = session.currentRevision();
        if (boundary.status !== 'approval_required') return toChildOutcome(boundary);
        const decision = await this.answerChildApproval(task, attempt, boundary.approval);
        session.submitDecision({ runId: attempt.childRunId, ...decision });
        seen = session.currentRevision();
      }
    } catch (error) {
      session.abort();
      await session.settled;
      throw error;
    } finally {
      this.children.delete(attempt.childRunId);
      this.activity.untrack(attempt.childRunId);
    }
  }

  private answerChildApproval(task: OrchestratorTask, attempt: OrchestratorAttempt, approval: RepoAgentApproval): Promise<ContinuingDecision> {
    return this.answerApproval({ kind: 'child', childRunId: attempt.childRunId, taskId: task.id, ...approval },
      buildChildApprovalPrompt({ task, purpose: attempt.purpose, attempt: attempt.attempt, approval }));
  }

  /**
   * Resolves one approval. Interactive runs ask the person; auto runs let the parent decide on its
   * own model in a finite phase with `parentPrompt`. No child holds a model lease meanwhile.
   */
  private async answerApproval(pending: OrchestratorPendingApproval, parentPrompt: string): Promise<ContinuingDecision> {
    const decision = this.approvalTurn.then(() => this.resolveApproval(pending, parentPrompt));
    this.approvalTurn = decision.then(() => undefined, () => undefined);
    return decision;
  }

  private async resolveApproval(pending: OrchestratorPendingApproval, parentPrompt: string): Promise<ContinuingDecision> {
    this.signal.throwIfAborted();
    const resumePhase = this.state.phase;
    const action = pending.kind === 'child' ? `${pending.toolName} ${pending.command}` : `run ${pending.command}`;
    this.commit({ approval: pending }, `Approval requested: ${action}`, pending.taskId === null ? {} : { taskId: pending.taskId });
    let decision: RepoAgentDecision;
    try {
      decision = this.request.approval === 'interactive'
        ? await this.waitForUserDecision(pending.approvalId)
        : await this.decideOnParentModel(parentPrompt);
    } catch (error) {
      if (!this.signal.aborted) this.commit({ approval: null, phase: resumePhase }, 'Approval could not be resolved.');
      throw error;
    }
    if (!this.signal.aborted) this.commit({ approval: null, phase: resumePhase }, describeApprovalDecision(decision));
    if (decision.decision === 'abort') {
      this.abort('Aborted by user.');
      throw toError(this.signal.reason);
    }
    return decision;
  }

  private async decideOnParentModel(prompt: string): Promise<ContinuingDecision> {
    let rejected: string[] = [];
    for (let attempt = 1; attempt <= PARENT_PHASE_ATTEMPTS; attempt += 1) {
      const reply = await this.askParent('approval decision', [prompt, ...describeRejection('answer', rejected)].join('\n'),
        OrchestratorApprovalDecisionSchema, rejected);
      if (reply.ok) {
        const decision = reply.answer;
        return decision.decision === 'approve' ? { decision: 'approve' } : { decision: 'deny', reason: `orchestrator: ${decision.reason}` };
      }
      rejected = reply.problems;
    }
    throw fail('approval_decision_invalid', `The orchestrator gave no usable approval decision: ${rejected.join(' ')}`);
  }

  private waitForUserDecision(approvalId: string): Promise<RepoAgentDecision> {
    this.commit({ phase: 'approval_required' }, 'Waiting for your approval decision.');
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.pendingUserDecision = null;
        reject(toError(this.signal.reason));
      };
      if (this.signal.aborted) {
        onAbort();
        return;
      }
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.pendingUserDecision = { approvalId, resolve: (decision) => {
        this.signal.removeEventListener('abort', onAbort);
        resolve(decision);
      } };
    });
  }

  /** Runs checks in order; unless approval is off, each command is approved on its own before it runs. */
  private async runChecks(checks: readonly OrchestratorVerificationCheck[], task: OrchestratorTask | null): Promise<OrchestratorCheckResult[]> {
    const results: OrchestratorCheckResult[] = [];
    for (const check of checks) {
      if (check.kind === 'evidence') {
        results.push(unexecutedCheck(check, ''));
        continue;
      }
      const denial = await this.checkDenial(check, task);
      results.push(denial === null
        ? await runVerificationCheck({ repoRoot: this.request.repoRoot, check, runId: this.runId, abortSignal: this.signal })
        : unexecutedCheck(check, `Not run: ${denial}`));
    }
    return results;
  }

  /** The reason a check command may not run, or null once it is approved (or approval is off). */
  private async checkDenial(check: OrchestratorCommandCheck, task: OrchestratorTask | null): Promise<string | null> {
    if (this.request.approval === 'off') return null;
    const decision = await this.answerApproval(
      { kind: 'check', approvalId: randomUUID(), taskId: task?.id ?? null, command: check.command, cwd: check.cwd },
      buildCheckApprovalPrompt({ task, check }),
    );
    return decision.decision === 'deny' ? decision.reason : null;
  }

  private renderDiff(baseline: WorkspaceSnapshot, paths: readonly string[]): Promise<string> {
    return renderWorkspaceDiff({ repoRoot: this.request.repoRoot, baseline, paths, scratchDir: orchestratorScratchDir(this.runId) });
  }

  // ---- drift gate ----

  private async driftGate(running: RunningTask, initialChecks: OrchestratorCheckResult[]): Promise<void> {
    const { task, baseline } = running;
    let checks = initialChecks;
    let openFindings: OrchestratorDriftFinding[] = [];
    let retryEvidence: string | null = null;
    for (;;) {
      const changes = await this.taskChanges(running);
      if (changes.digest === null || !changesNeedDriftReview(changes.paths)) {
        const review: OrchestratorDriftReview = { taskId: task.id, changeDigest: changes.digest ?? 'none', scopePaths: changes.paths,
          resolutions: [], status: 'not_required', reason: 'no_code_changes' };
        this.setTask(task.id, { driftReview: review }, `Task ${task.id}: no code changes to review.`);
        if (retryEvidence === null) return;
        throw fail('drift_unresolved', `Task '${task.id}' drift correction failed: ${retryEvidence}`, { taskId: task.id, purpose: 'drift_fix' });
      }
      const digest = changes.digest;
      if (retryEvidence === null) {
        this.setTaskStatus(task.id, 'reviewing_drift');
        const review = await this.reviewDrift(task, baseline, digest, changes.paths, openFindings, checks);
        const reviewedDigests = [...new Set([...(this.state.tasks.find((entry) => entry.taskId === task.id)?.reviewedDigests ?? []), digest])];
        this.setTask(task.id, { driftReview: review, reviewedDigests },
          review.status === 'actionable' ? `Task ${task.id}: ${review.findings.length} drift finding(s).` : `Task ${task.id}: no actionable drift.`);
        if (review.status !== 'actionable') return;
        openFindings = review.findings;
      }
      const used = this.state.attempts.filter((attempt) => attempt.taskId === task.id && attempt.purpose === 'drift_fix').length;
      if (used >= ORCHESTRATOR_MAX_ATTEMPTS) {
        throw fail('drift_unresolved', `Task '${task.id}' still has unresolved drift after ${ORCHESTRATOR_MAX_ATTEMPTS} corrections.`,
          { taskId: task.id, purpose: 'drift_fix', findingIds: openFindings.map((finding) => finding.id) });
      }
      this.setTaskStatus(task.id, 'correcting_drift');
      const work = buildDriftCorrectionWork({ task, changeDigest: digest, findings: openFindings });
      const attempt = this.reserve(task.id, work);
      const outcome = await this.runAttempt(running, { ...task, verification: work.verification }, work.allowedPaths, attempt,
        buildDriftCorrectionPrompt(work, retryEvidence));
      checks = outcome.result.checks;
      // A functional regression from a correction must be fixed inside the same correction budget.
      retryEvidence = outcome.result.passed ? null : outcome.findings.join('\n');
    }
  }

  private async reviewDrift(
    task: OrchestratorTask,
    baseline: WorkspaceSnapshot,
    changeDigest: string,
    changedPaths: string[],
    openFindings: OrchestratorDriftFinding[],
    checks: OrchestratorCheckResult[],
  ): Promise<OrchestratorDriftReview> {
    const diff = await this.renderDiff(baseline, changedPaths);
    let rejected: string[] = [];
    for (let attempt = 1; attempt <= PARENT_PHASE_ATTEMPTS; attempt += 1) {
      const reply = await this.askParent('drift review', buildDriftReviewPrompt({ task, changeDigest, diff, changedPaths, openFindings,
        checks, rejectedProblems: rejected }), OrchestratorDriftReviewSchema, rejected);
      if (!reply.ok) {
        rejected = reply.problems;
        continue;
      }
      const review = reply.answer;
      rejected = validateDriftReview({ review, repoRoot: this.request.repoRoot, taskId: task.id, changeDigest, changedPaths,
        openFindings });
      if (rejected.length === 0 && review.status === 'actionable') {
        rejected = await findUnrunnableChecks(this.request.repoRoot, review.findings.flatMap((finding) => finding.verification),
          this.signal);
      }
      if (rejected.length === 0) return review;
    }
    throw fail('drift_review_invalid', `Task '${task.id}' drift review was unusable: ${rejected.join(' ')}`,
      { taskId: task.id, findingIds: openFindings.map((finding) => finding.id) });
  }

  // ---- final verification ----

  private async verifyFinal(plan: OrchestratorPlan): Promise<void> {
    this.commit({ phase: 'verifying' }, 'Running final verification.');
    // Global validation commands take exclusive ownership of the checkout.
    const lease = await this.acquireRepository('exclusive');
    try {
      const checks = await this.runChecks(plan.finalVerification, null);
      const review = checks.some((check) => check.check.kind === 'evidence')
        ? await this.askEvidenceReview({ kind: 'final', checks })
        : null;
      const evaluation = evaluateAttempt({ repoRoot: this.request.repoRoot, workerStatus: 'completed', checks, scopeViolations: [], review });
      if (!evaluation.passed) throw fail('final_verification_failed', `Final verification failed: ${evaluation.findings.join(' ')}`);
    } finally {
      lease.release();
    }
  }
}

function describeApprovalDecision(decision: RepoAgentDecision): string {
  return decision.decision === 'deny' ? `Approval resolved: deny (${decision.reason}).` : `Approval resolved: ${decision.decision}.`;
}

function requireOrchestratorPreset(config: SiftConfig, presetId: string): void {
  const preset = PresetCatalog.fromPresets(config.Presets).requireById(presetId);
  if (preset.presetKind !== 'orchestrator') throw new Error(`Preset '${presetId}' is a ${preset.presetKind} preset, not an orchestrator.`);
}

function readSuppliedPlan(repoRoot: string, planPath: string): { path: string; markdown: string } {
  const resolved = resolveRepoScopedPath(repoRoot, planPath);
  if (resolved === null || !existsSync(resolved.absolutePath) || !statSync(resolved.absolutePath).isFile()) {
    throw fail('plan_not_found', `Plan '${planPath}' is not a file inside the repository.`);
  }
  return { path: resolved.relativePath, markdown: readFileSync(resolved.absolutePath, 'utf8') };
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
