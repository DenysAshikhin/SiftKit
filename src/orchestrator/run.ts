import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  OrchestratorChildPurposeSchema,
  OrchestratorFinishSchema,
  isOrchestratorTerminalPhase,
  orchestratorAttemptsSpent,
  orchestratorCheckFailure,
  type OrchestratorActivity,
  type OrchestratorAttempt,
  type OrchestratorAttemptResult,
  type OrchestratorChangeApproachArgs,
  type OrchestratorCheckResult,
  type OrchestratorDecideArgs,
  type OrchestratorDispatchArgs,
  type OrchestratorFailure,
  type OrchestratorFailureCode,
  type OrchestratorFinish,
  type OrchestratorPendingApproval,
  type OrchestratorPlan,
  type OrchestratorRecordReviewArgs,
  type OrchestratorRunCheckArgs,
  type OrchestratorRunState,
  type OrchestratorSavePlanArgs,
  type OrchestratorUpdateTasksArgs,
  type OrchestratorStartRequest,
  type OrchestratorTask,
  type OrchestratorTaskStatus,
  type OrchestratorVerificationCheck,
  type RepoAgentApproval,
  type RepoAgentDecision,
} from '@siftkit/contracts';

import { getActiveModelPreset, getConfiguredContextTokens } from '../config/getters.ts';
import type { SiftConfig } from '../config/types.ts';
import { toError } from '../lib/errors.ts';
import { ModelJson } from '../lib/model-json.ts';
import { ProgressWriter } from '../lib/progress-writer.ts';
import { PresetCatalog } from '../preset-catalog.ts';
import { PresetSystemContextBuilder } from '../preset-system-context.ts';
import type { OrchestratorToolHost, OrchestratorToolOutcome } from '../repo-search/engine/orchestrator-tool-host.ts';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.ts';
import { findPathsOutsideRepo } from '../repo-search/engine/shell-command-policy.ts';
import type { SubmissionGate, SubmissionVerdict } from '../repo-search/engine/submission-gate.ts';
import { taskPassed } from '../repo-search/engine/task-loop-support.ts';
import type { OrchestratorToolCall } from '../repo-search/repo-tool-arguments.ts';
import { resolveRunSystemPrompt } from '../repo-search/run-system-prompt.ts';
import type { OperationProgressEvent, RepoSearchProgressEvent } from '../repo-search/types.ts';
import { readConfig } from '../status-server/config-store.ts';
import { resolveNewSessionModelConfig } from '../status-server/new-chat-session.ts';
import type { OrchestratorLiveRun, RepositoryLease } from '../status-server/orchestrator-runs.ts';
import type { RepoAgentSession } from '../status-server/repo-agent-sessions.ts';
import type { ServerContext } from '../status-server/server-types.ts';
import { chatSessionExists } from '../state/chat-sessions.ts';
import { budgetDeadlineMs, budgetUsage, dispatchBudgetSpent, renderBudget } from './budget.ts';
import { showRunInChatSession } from './chat-sessions.ts';
import { findUnrunnableChecks } from './check-preflight.ts';
import { renderRunDigest } from './digest.ts';
import { renderAttemptForParent, renderCheckOutput } from './handoff.ts';
import { renderLedger } from './ledger.ts';
import { OrchestratorLiveActivity } from './live-activity.ts';
import { OrchestratorInfrastructureError, ParentLease } from './parent-lease.ts';
import { findTestPathsOutsideScope, renderOrchestratorPlan, validateOrchestratorPlan } from './plan.ts';
import { activeApproach, changeApproach, finishProblem, reviseTasks, startPlan, type PlanState, type PlanTransition } from './plan-state.ts';
import { buildChildInstruction, buildOrchestratorPrompt } from './prompts.ts';
import { findReviewProblems } from './review.ts';
import { describeSchedule, dispatchProblem, orchestratorWorkers, type PlanWorker } from './scheduler.ts';
import { WorkerSubmission, type SubmissionHost } from './submission.ts';
import { runVerificationCheck, unexecutedCheck } from './verification.ts';
import { startOrchestratorChild, toChildOutcome } from './workers.ts';
import {
  captureWorkspace,
  checkpointWorkspace,
  cleanupScratch,
  diffstatWorkspace,
  diffWorkspace,
  orchestratorArtifactDir,
  orchestratorScratchDir,
  removeOwnedTemporaryPath,
  restoreWorkspace,
  type DiffstatEntry,
  type WorkspaceChanges,
  type WorkspaceCheckpoint,
  type WorkspaceSnapshot,
} from './workspace.ts';

/** No turn count ends the orchestrator: its budget does. The engine still needs a finite limit, far above any real run. */
const PARENT_TURN_CEILING = 1_000_000;
/** How much of a command's output tail the orchestrator reads back, after the check's digest. */
export const COMMAND_TAIL_CHARS = 4_000;
/** How many restored paths a rollback's result lists. */
const RESTORED_PATHS_SHOWN = 20;

/** The one child between its start and its settled result. */
type LiveChild = {
  attempt: OrchestratorAttempt;
  task: OrchestratorTask;
  baseline: WorkspaceSnapshot;
  repository: RepositoryLease;
  submission: WorkerSubmission;
  session: RepoAgentSession;
  /** Ends the subscription that stores the child's warnings as run events. */
  detachWarnings: () => void;
};

/** An answered approval the run continues with; an abort never returns. */
type ContinuingDecision = Exclude<RepoAgentDecision, { decision: 'abort' }>;

/** A child approval waiting on the orchestrator's decide; `announced` once a tool result showed it. */
type Escalation = { child: LiveChild; approval: RepoAgentApproval; announced: boolean; resolve(decision: OrchestratorDecideArgs): void };

type PendingUserDecision = { approvalId: string; resolve(decision: RepoAgentDecision): void };

/** How the orchestrator's finish ended; null until a finish is accepted. */
type FinishOutcome =
  | { status: 'completed' }
  | { status: 'blocked'; reason: string }
  | { status: 'budget_exhausted'; findings: string[] };

/** A stop with a precise, stored diagnosis. */
class OrchestratorRunFailure extends Error {
  readonly failure: OrchestratorFailure;

  constructor(failure: OrchestratorFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

function fail(code: OrchestratorFailureCode, message: string, taskId: string | null = null): OrchestratorRunFailure {
  return new OrchestratorRunFailure({ code, message, taskId });
}

/** Keeps the parent's lease alive and hands each streamed event to its run. */
class ParentProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  private readonly lease: ParentLease;
  private readonly run: OrchestratorRun;

  constructor(lease: ParentLease, run: OrchestratorRun) {
    super();
    this.lease = lease;
    this.run = run;
  }

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    this.lease.renew();
    this.run.applyParentProgress(event);
  }

  override recordActivity(): void {
    this.lease.renew();
  }
}

/**
 * One orchestrator run: a single parent conversation that plans, dispatches one fresh child at a time, reviews
 * each report, and finishes. Code owns every invariant: the plan's validity, one child at a time, measured changes,
 * check execution, attempt and resubmit limits, citations, and approvals. The parent releases its model
 * whenever its child or a check works, and the run keeps the configuration it started with.
 */
export class OrchestratorRun implements OrchestratorLiveRun, OrchestratorToolHost, SubmissionGate, SubmissionHost {
  readonly runId: string;
  readonly settled: Promise<void>;
  private readonly abortController = new AbortController();
  private readonly activity: OrchestratorLiveActivity;
  private child: LiveChild | null = null;
  private escalation: Escalation | null = null;
  /** The child's settled result until the parent's wait hands it over. */
  private settledReport: { result: OrchestratorAttemptResult; diffstat: DiffstatEntry[] } | null = null;
  /** Reports handed to the parent and not yet reviewed, by task; the digest repeats them after a compaction. */
  private readonly awaitingReview = new Map<string, string>();
  /** run_check commands that passed since the latest child started: review evidence for the tree as it is now. */
  private passedRunChecks: string[] = [];
  /** The tree as it was when the active approach began; a rollback restores it. */
  private checkpoint: WorkspaceCheckpoint | null = null;
  private childFailure: Error | null = null;
  /** Wakes the parent's wait for its child; replaced by each wait. */
  private wakeWaiter: (() => void) | null = null;
  private pendingUserDecision: PendingUserDecision | null = null;
  /** Settles when the latest user approval is answered; one approval is pending at a time. */
  private approvalTurn: Promise<void> = Promise.resolve();
  /** Why the last finish failed final verification; the digest repeats it after a compaction. */
  private lastFailedFinish: string[] | null = null;
  /** Set by a failed finish and cleared when a child starts or a rollback restores files: until then a finish would fail again. */
  private finishNeedsChange = false;
  private finishOutcome: FinishOutcome | null = null;
  private registered = false;
  private state: OrchestratorRunState;
  private readonly workers: PlanWorker[];
  private readonly lease: ParentLease;

  private readonly ctx: ServerContext;
  private readonly config: SiftConfig;

  private constructor(ctx: ServerContext, state: OrchestratorRunState, config: SiftConfig) {
    this.ctx = ctx;
    this.config = config;
    this.workers = orchestratorWorkers(config);
    this.runId = state.runId;
    this.state = state;
    this.activity = new OrchestratorLiveActivity(state.runId, ctx.orchestratorRuns);
    this.lease = new ParentLease(ctx, { presetId: state.request.presetId, ownerRunId: state.runId, abortSignal: this.abortController.signal });
    // Work begins on the next tick, and only once the registry owns this run.
    this.settled = Promise.resolve().then(() => (this.registered ? this.run() : undefined));
    ctx.orchestratorRuns.register(this);
    this.registered = true;
  }

  /** Creates (or returns the existing run for) a submission; only a new run starts work. Every run shows in a chat session. */
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
    this.stop(new Error(reason));
  }

  /** Ends the run from outside its conversation: a person's abort, or a spent time budget. */
  private stop(cause: Error): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(cause);
    this.child?.session.abort();
    this.wake();
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

  private get statusUrl(): string {
    return `${this.ctx.getServiceBaseUrl()}/status`;
  }

  private wake(): void {
    const waiter = this.wakeWaiter;
    this.wakeWaiter = null;
    waiter?.();
  }

  // ---- lifecycle ----

  /** Runs the parent conversation, then stops its child; only then does a failed run clean its scratch files and settle. */
  private async run(): Promise<void> {
    const { minutes } = this.request.budget;
    // The time budget stops the run wherever it is: mid-conversation, mid-child, or waiting on a person.
    const deadline = setTimeout(() => this.stop(fail('budget_exhausted', `The run's time budget of ${minutes} minutes is spent.`)),
      Math.max(0, budgetDeadlineMs(this.state) - Date.now()));
    let failure: Error | null = null;
    try {
      await this.converse();
      this.commit({ phase: 'cleaning' }, 'Cleaning run scratch files.');
      const cleanupProblem = this.cleanupRunScratch();
      if (cleanupProblem !== null) throw fail('cleanup_failed', cleanupProblem);
      this.commit({ phase: 'completed', failure: null }, 'Run completed.');
    } catch (error) {
      failure = toError(error);
    } finally {
      clearTimeout(deadline);
    }
    this.lease.release();
    this.pendingUserDecision = null;
    const { child } = this;
    if (child !== null) {
      child.session.abort();
      await Promise.allSettled([child.session.settled]);
    }
    this.activity.close();
    if (failure === null) return;
    const cleanupProblem = this.cleanupRunScratch();
    this.settleFailure(failure, cleanupProblem === null ? null : `Scratch cleanup also failed: ${cleanupProblem}`);
  }

  /** The one parent conversation; its accepted finish decides how the run ends. */
  private async converse(): Promise<void> {
    const preset = PresetCatalog.fromPresets(this.config.Presets).requireById(this.request.presetId);
    const systemContext = new PresetSystemContextBuilder(this.request.repoRoot).build(preset);
    const suppliedPlan = this.request.planPath === null ? null : readSuppliedPlan(this.request.repoRoot, this.request.planPath);
    const prompt = buildOrchestratorPrompt({
      repoRoot: this.request.repoRoot, task: this.request.task, suppliedPlan, workers: this.workers, approval: this.request.approval,
      budget: this.request.budget, preexistingDirtyPaths: [...(await captureWorkspace(this.request.repoRoot)).keys()],
    });
    const parentRunId = randomUUID();
    this.commit({ parentRunIds: [...this.state.parentRunIds, parentRunId] }, 'Orchestrator started.');
    await this.lease.acquire();
    const allowedTools = [...preset.allowedTools];
    this.activity.startParent({ user: prompt, system: resolveRunSystemPrompt({
      promptKind: 'orchestrator', allowedTools, promptPrefix: preset.promptPrefix, systemContext,
      webSearch: this.lease.config.WebSearch, webToolsEnabled: undefined, webChatTools: false, orchestratorTools: true,
      visionEnabled: getActiveModelPreset(this.lease.config).VisionEnabled === true,
    }).systemPrompt }, getConfiguredContextTokens(this.lease.config).totalContextTokens);
    const result = await this.ctx.engineService.executeRepoSearch({
      presetId: this.request.presetId, taskKind: 'orchestrator', prompt, requestId: parentRunId, repoRoot: this.request.repoRoot,
      systemContext, statusBackendUrl: this.statusUrl, config: this.lease.config, allowedTools,
      maxTurns: PARENT_TURN_CEILING, abortSignal: this.signal, progressWriter: new ParentProgressWriter(this.lease, this),
      orchestratorTools: this, submissionGate: this,
    }).catch((error) => {
      this.signal.throwIfAborted();
      if (this.childFailure !== null) throw this.childFailure;
      throw error instanceof OrchestratorRunFailure ? error : new OrchestratorInfrastructureError(toError(error).message);
    });
    this.lease.release();
    const task = result.scorecard.tasks[0];
    const finish = this.finishOutcome;
    if (!task || !taskPassed(task) || finish === null) {
      throw fail('orchestrator_incomplete', `The orchestrator stopped without finishing (${task?.reason ?? 'no task'}).`);
    }
    if (finish.status === 'blocked') throw fail('blocked', `The orchestrator stopped: ${finish.reason}`);
    if (finish.status === 'budget_exhausted') {
      const { dispatches } = this.request.budget;
      throw fail('budget_exhausted',
        `Final verification still fails and the dispatch budget is spent (${dispatches} of ${dispatches}): ${finish.findings.join(' ')}`);
    }
  }

  private settleFailure(error: Error, cleanupProblem: string | null): void {
    const current = this.ctx.orchestratorRunStore.read(this.runId);
    this.state = current;
    if (isOrchestratorTerminalPhase(current.phase)) return;
    const withCleanup = (message: string): string => [message, cleanupProblem].filter((part) => part !== null).join(' ');
    const cause = this.signal.aborted ? toError(this.signal.reason) : error;
    if (this.signal.aborted && !(cause instanceof OrchestratorRunFailure)) {
      const message = withCleanup(cause.message);
      this.commit({ phase: 'aborted', approval: null, failure: { code: 'aborted', message, taskId: null } }, message);
      return;
    }
    const stored = cause instanceof OrchestratorRunFailure
      ? cause.failure
      : fail(cause instanceof OrchestratorInfrastructureError ? 'infrastructure_failed' : 'internal_error', cause.message).failure;
    const failure = { ...stored, message: withCleanup(stored.message) };
    this.commit({ phase: 'failed', approval: null, failure }, failure.message);
  }

  private commit(changes: Parameters<ServerContext['orchestratorRunStore']['update']>[2], message: string,
    detail: { taskId?: string; purpose?: OrchestratorAttempt['purpose']; attempt?: number; childRunId?: string } = {}): void {
    this.publish(this.ctx.orchestratorRunStore.update(this.runId, this.state.revision, changes, { message, ...detail }));
  }

  /** The parent's streamed event: its live view follows it, and a context warning becomes a run event. */
  applyParentProgress(event: RepoSearchProgressEvent): void {
    this.activity.applyParent(event);
    this.recordWarning(event, null);
  }

  /** Stores a parent or child context warning, such as a prompt-cache break, as a run event the CLI prints. */
  private recordWarning(event: OperationProgressEvent, child: { taskId: string; childRunId: string } | null): void {
    if (event.kind !== 'context_warning' || isOrchestratorTerminalPhase(this.state.phase)) return;
    this.commit({}, `${child === null ? 'Orchestrator' : 'Worker'} warning: ${event.warningText}`, child ?? {});
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
    this.setTask(taskId, { status }, `Task ${taskId}: ${status}.`);
  }

  /** The parent and its one child each hold the repository exclusively, never at the same time. */
  private acquireRepository(): Promise<RepositoryLease> {
    return this.ctx.orchestratorRuns.repositoryGate.acquire(this.request.repoRoot, 'exclusive', this.signal);
  }

  /** Runs `work` while the parent holds the repository exclusively. */
  private async withRepository<T>(work: () => Promise<T>): Promise<T> {
    const lease = await this.acquireRepository();
    try {
      return await work();
    } finally {
      lease.release();
    }
  }

  /** Releases the parent's model while `work` runs, then takes it back; the conversation never notices. */
  private async withModelReleased<T>(work: () => Promise<T>): Promise<T> {
    this.lease.release();
    this.activity.setParentParked(true);
    const result = await work();
    this.signal.throwIfAborted();
    await this.lease.acquire();
    this.activity.setParentParked(false);
    return result;
  }

  // ---- the parent's tools ----

  execute(call: OrchestratorToolCall): Promise<OrchestratorToolOutcome> {
    this.signal.throwIfAborted();
    switch (call.toolName) {
      case 'save_plan':
        return this.savePlan(call.args);
      case 'update_tasks':
        return this.updateTasks(call.args);
      case 'change_approach':
        return this.changeApproach(call.args);
      case 'dispatch':
        return this.dispatch(call.args);
      case 'decide':
        return this.answerEscalation(call.args);
      case 'run_check':
        return this.runCheck(call.args);
      case 'record_review':
        return Promise.resolve(this.recordReview(call.args));
    }
  }

  contextDigest(): string {
    return renderRunDigest({
      plan: this.state.plan, planPath: this.state.planPath, tasks: this.state.tasks, ledger: this.ledger(),
      approaches: this.state.approaches, retiredTasks: this.state.retiredTasks,
      pendingReports: [...this.awaitingReview.values()],
      pendingApprovals: this.escalation?.announced === true ? [renderEscalation(this.escalation)] : [],
      lastFailedFinish: this.lastFailedFinish,
    });
  }

  private ledger(): string {
    return renderLedger(this.state, Date.now());
  }

  planSaved(): boolean {
    return this.state.plan !== null;
  }

  private refuse(problems: readonly string[]): OrchestratorToolOutcome {
    return { ok: false, output: ['Not done:', ...problems.map((problem) => `- ${problem}`)].join('\n') };
  }

  /** Why a busy child blocks this call; waitForChild returns mid-child only when the child waits on the parent's decide. */
  private childBlocker(): string | null {
    if (this.escalation !== null) {
      return `Child approval ${this.escalation.approval.approvalId} is waiting for your decide; the child stays paused until you answer it.`;
    }
    if (this.child !== null) throw new Error('The orchestrator acted while its child ran with no approval waiting on it.');
    return null;
  }

  private planState(): PlanState {
    const { plan, tasks, approaches, retiredTasks } = this.state;
    return { plan, tasks, approaches, retiredTasks };
  }

  /** Repository-relative path of the Markdown plan the host writes. */
  private get planFile(): string {
    return `${orchestratorArtifactDir(this.runId)}/plan.md`;
  }

  private async savePlan(args: OrchestratorSavePlanArgs): Promise<OrchestratorToolOutcome> {
    const problems = await this.storePlan(startPlan(this.planState(), args.plan, new Date().toISOString()), true);
    if (problems.length > 0) return this.refuse(problems);
    this.checkpoint = await this.withRepository(() => checkpointWorkspace(this.request.repoRoot));
    return { ok: true, output: [`Plan saved to ${this.planFile} with ${this.state.tasks.length} task(s).`, this.ledger()].join('\n') };
  }

  private async updateTasks(args: OrchestratorUpdateTasksArgs): Promise<OrchestratorToolOutcome> {
    const problems = await this.storePlan(reviseTasks(this.planState(), args, this.state.attempts, new Date().toISOString()), true);
    if (problems.length > 0) return this.refuse(problems);
    for (const { taskId } of args.retire) this.awaitingReview.delete(taskId);
    return { ok: true, output: [`Plan updated: ${this.planFile} now has ${this.state.tasks.length} task(s).`, this.ledger()].join('\n') };
  }

  /** Ends the active approach: restores its files when asked, stores the transition, and checkpoints the next approach. */
  private async changeApproach(args: OrchestratorChangeApproachArgs): Promise<OrchestratorToolOutcome> {
    const blocker = this.childBlocker();
    if (blocker !== null) return this.refuse([blocker]);
    const ended = activeApproach(this.state);
    const transition = changeApproach(this.planState(), args, this.state.attempts, new Date().toISOString());
    if (!transition.ok) return this.refuse(transition.problems);
    const { checkpoint } = this;
    if (ended === null || checkpoint === null) throw new Error('A planned run has no checkpoint for its active approach.');
    let restored: string[] = [];
    if (args.rollback) {
      try {
        restored = await this.withRepository(() => restoreWorkspace(this.request.repoRoot, checkpoint));
      } catch (error) {
        return this.refuse([toError(error).message]);
      }
      // The files changed under every check that passed before.
      this.passedRunChecks = [];
      this.finishNeedsChange = false;
    }
    const problems = await this.storePlan(transition, false);
    if (problems.length > 0) return this.refuse(problems);
    this.checkpoint = await this.withRepository(() => checkpointWorkspace(this.request.repoRoot));
    const live = new Set(this.state.tasks.map((task) => task.taskId));
    for (const taskId of [...this.awaitingReview.keys()]) {
      if (!live.has(taskId)) this.awaitingReview.delete(taskId);
    }
    const outcome = args.rollback ? `rolled back (${restored.length} file(s) restored)` : 'kept';
    this.commit({}, `Approach ${ended.number} ${outcome}; approach ${ended.number + 1} began: ${args.title}.`);
    const more = restored.length > RESTORED_PATHS_SHOWN ? `, and ${restored.length - RESTORED_PATHS_SHOWN} more` : '';
    return { ok: true, output: [
      `Approach ${ended.number} ended, ${outcome}. Approach ${ended.number + 1} is active: ${args.title}.`,
      ...(restored.length === 0 ? [] : [`Restored: ${restored.slice(0, RESTORED_PATHS_SHOWN).join(', ')}${more}`]),
      'Add its tasks with update_tasks.', this.ledger(),
    ].join('\n') };
  }

  /** Validates a plan transition, stores it, and rewrites plan.md. Returns why it was refused; empty means stored. */
  private async storePlan(transition: PlanTransition, preflight: boolean): Promise<readonly string[]> {
    const blocker = this.childBlocker();
    if (blocker !== null) return [blocker];
    if (!transition.ok) return transition.problems;
    if (transition.next.plan === null) throw new Error('A plan transition produced no plan.');
    let plan: OrchestratorPlan;
    try {
      plan = validateOrchestratorPlan(transition.next.plan, this.config, this.request.repoRoot);
    } catch (error) {
      return [toError(error).message];
    }
    if (preflight) {
      const unrunnable = await findUnrunnableChecks(this.request.repoRoot,
        [...plan.tasks.flatMap((task) => task.verification), ...plan.finalVerification], this.signal);
      if (unrunnable.length > 0) return unrunnable;
    }
    const markdown = renderOrchestratorPlan(plan);
    this.publish(this.ctx.orchestratorRunStore.savePlan(this.runId, this.state.revision, { ...transition.next, plan }, this.planFile,
      hashText(markdown)));
    // The host, not the model, writes the Markdown plan, under exclusive repository ownership.
    await this.withRepository(() => {
      const absolute = join(this.request.repoRoot, this.planFile);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, markdown, 'utf8');
      return Promise.resolve();
    });
    if (this.state.phase === 'preparing_plan') this.commit({ phase: 'executing' }, 'Executing the plan.');
    return [];
  }

  private async dispatch(args: OrchestratorDispatchArgs): Promise<OrchestratorToolOutcome> {
    const { plan, planPath, planHash } = this.state;
    const approach = activeApproach(this.state);
    if (plan === null || planPath === null || planHash === null || approach === null) return this.refuse(['Save a plan first.']);
    const blocker = this.childBlocker();
    if (blocker !== null) return this.refuse([blocker]);
    const task = plan.tasks.find((entry) => entry.id === args.taskId);
    if (task === undefined) return this.refuse([`Task '${args.taskId}' is not in the saved plan.`]);
    if (dispatchBudgetSpent(this.state)) {
      return this.refuse([`The run's dispatch budget is spent (${this.state.attempts.length} of ${this.request.budget.dispatches}). `
        + 'Finish now: completed if final verification can pass, otherwise blocked with what was tried.']);
    }
    const problem = dispatchProblem({ taskStates: this.state.tasks, attempts: this.state.attempts, activeApproach: approach.number,
      request: { task, purpose: args.purpose } });
    if (problem !== null) return this.refuse([problem]);
    const outside = findPathsOutsideRepo(args.instruction, this.request.repoRoot);
    if (outside.length > 0) {
      return this.refuse([`The instruction names ${outside.join(', ')}, outside the repository root ${this.request.repoRoot}; `
        + 'a child works only in this repository, so name repository-relative paths.']);
    }
    this.activity.setSchedule(describeSchedule(this.workers, plan, this.state.tasks));
    await this.startChild(task, { kind: args.purpose, planPath, planHash, task, instruction: args.instruction });
    return this.waitForChild();
  }

  private async startChild(task: OrchestratorTask, work: OrchestratorAttempt['work']): Promise<void> {
    const repository = await this.acquireRepository();
    const attempt = this.ctx.orchestratorRunStore.reserveAttempt(this.runId, this.state.revision, task.id, work);
    this.publish(this.ctx.orchestratorRunStore.read(this.runId));
    this.setTaskStatus(task.id, 'running');
    // The child changes the tree, so a check that passed before it proves nothing about its work.
    this.passedRunChecks = [];
    this.finishNeedsChange = false;
    const baseline = await captureWorkspace(this.request.repoRoot);
    const instruction = buildChildInstruction({ work, attempt: attempt.attempt, repoRoot: this.request.repoRoot,
      scratchPath: orchestratorScratchDir(this.runId),
      preexistingDirtyPaths: [...baseline.keys()] });
    const submission = new WorkerSubmission(this);
    const session = startOrchestratorChild(this.ctx, this.config, {
      runId: this.runId, taskId: task.id, attempt: attempt.attempt, childRunId: attempt.childRunId,
      workerPresetId: task.workerPresetId, repoRoot: this.request.repoRoot, work, instruction,
    }, submission);
    const source = { taskId: task.id, childRunId: attempt.childRunId };
    const detachWarnings = session.attach({ wantsLiveText: false, writeProgress: (event) => this.recordWarning(event, source) });
    const child: LiveChild = { attempt, task, baseline, repository, submission, session, detachWarnings };
    this.child = child;
    this.activity.track(session, source);
    this.publish(this.ctx.orchestratorRunStore.markAttemptRunning(this.runId, this.state.revision, attempt.childRunId));
    this.superviseChild(child, session).catch((error) => {
      this.childFailure ??= toError(error);
      this.wake();
    });
  }

  /** Follows one child to its end, answering its escalated approvals, then records its result. */
  private async superviseChild(child: LiveChild, session: RepoAgentSession): Promise<void> {
    try {
      let seen = 0;
      for (;;) {
        const boundary = await session.waitForBoundary(seen, this.signal);
        seen = session.currentRevision();
        if (boundary.status !== 'approval_required') {
          const outcome = toChildOutcome(boundary);
          await this.settleChild(child, outcome.workerStatus, outcome.output, await diffWorkspace(this.request.repoRoot, child.baseline));
          return;
        }
        const decision = await this.resolveChildApproval(child, boundary.approval);
        session.submitDecision({ runId: child.attempt.childRunId, ...decision });
        seen = session.currentRevision();
      }
    } catch (error) {
      session.abort();
      await session.settled;
      throw error;
    } finally {
      child.repository.release();
      this.child = null;
      this.activity.untrack(child.attempt.childRunId);
      child.detachWarnings();
      this.wake();
    }
  }

  private async settleChild(child: LiveChild, workerStatus: OrchestratorAttemptResult['workerStatus'], workerOutput: string,
    measured: WorkspaceChanges): Promise<void> {
    const record = child.submission.record();
    const changes = record?.changes ?? measured;
    const outcome = record?.outcome ?? 'not_submitted';
    const outsideScope = findTestPathsOutsideScope(child.task, changes.paths);
    const result: OrchestratorAttemptResult = {
      taskId: child.task.id, purpose: child.attempt.purpose, attempt: child.attempt.attempt, childRunId: child.attempt.childRunId,
      workerStatus, workerOutput, report: record?.report ?? null, outcome, submissions: record?.submissions ?? 0,
      passed: workerStatus === 'completed' && outcome === 'passed', checks: record?.checks ?? [],
      findings: [
        ...(workerStatus === 'completed' ? [] : [`The worker ended ${workerStatus}.`]),
        ...(record === null ? ['The child never submitted a report.'] : record.findings),
        ...(outsideScope.length === 0 ? [] : [`Changed test files outside this task's writePaths: ${outsideScope.join(', ')}.`]),
      ],
      changedPaths: changes.paths,
      changeDigest: changes.digest,
    };
    this.publish(this.ctx.orchestratorRunStore.recordAttemptResult(this.runId, this.state.revision, result));
    this.setTaskStatus(child.task.id, 'reviewing');
    const diffstat = await diffstatWorkspace({ repoRoot: this.request.repoRoot, baseline: child.baseline, paths: changes.paths,
      scratchDir: orchestratorScratchDir(this.runId) });
    this.settledReport = { result, diffstat };
  }

  /** Releases the parent's model until the child has settled or needs the parent's decision. */
  private async waitForChild(): Promise<OrchestratorToolOutcome> {
    await this.withModelReleased(async () => {
      while (this.child !== null && this.childFailure === null && (this.escalation === null || this.escalation.announced)) {
        await new Promise<void>((resolve) => {
          this.wakeWaiter = resolve;
        });
        this.signal.throwIfAborted();
      }
    });
    if (this.childFailure !== null) throw this.childFailure;
    const sections: string[] = [];
    const { escalation, settledReport, child } = this;
    if (escalation !== null && !escalation.announced) {
      escalation.announced = true;
      sections.push(renderEscalation(escalation));
    }
    if (settledReport !== null) {
      this.settledReport = null;
      const report = renderAttemptForParent(settledReport.result, settledReport.diffstat);
      if (this.state.tasks.some((task) => task.taskId === settledReport.result.taskId && task.status === 'reviewing')) {
        this.awaitingReview.set(settledReport.result.taskId, report);
      }
      sections.push(report);
    }
    if (child !== null) sections.push(`Still running: ${child.task.id} (${child.attempt.purpose} attempt ${child.attempt.attempt}).`);
    return { ok: true, output: [...sections, this.ledger()].join('\n\n') };
  }

  /**
   * A child's escalated approval: approved outright when approval is off, answered by the person when it is
   * interactive, and otherwise put to the parent, which may hand it on to the person.
   */
  private async resolveChildApproval(child: LiveChild, approval: RepoAgentApproval): Promise<ContinuingDecision> {
    if (this.request.approval === 'off') return { decision: 'approve' };
    const pending: OrchestratorPendingApproval = { kind: 'child', childRunId: child.attempt.childRunId, taskId: child.task.id, ...approval };
    if (this.request.approval === 'interactive') return this.askUser(pending);
    const answer = await new Promise<OrchestratorDecideArgs>((resolve) => {
      this.escalation = { child, approval, announced: false, resolve };
      this.wake();
    });
    switch (answer.decision) {
      case 'approve':
        return { decision: 'approve' };
      case 'deny':
        return { decision: 'deny', reason: `orchestrator: ${answer.reason}` };
      case 'escalate':
        return this.askUser(pending);
    }
  }

  private async answerEscalation(args: OrchestratorDecideArgs): Promise<OrchestratorToolOutcome> {
    const { escalation } = this;
    if (escalation === null || !escalation.announced || escalation.approval.approvalId !== args.approvalId) {
      return this.refuse([`No approval ${args.approvalId} is waiting for you.`]);
    }
    this.escalation = null;
    this.commit({}, `Orchestrator ${args.decision}: ${escalation.approval.toolName} ${escalation.approval.command}`,
      { taskId: escalation.child.task.id });
    escalation.resolve(args);
    return this.waitForChild();
  }

  /** Asks the person; approvals take turns, so exactly one is pending at a time. */
  private askUser(pending: OrchestratorPendingApproval): Promise<ContinuingDecision> {
    const decision = this.approvalTurn.then(() => this.waitForUserDecision(pending));
    this.approvalTurn = decision.then(() => undefined, () => undefined);
    return decision;
  }

  private async waitForUserDecision(pending: OrchestratorPendingApproval): Promise<ContinuingDecision> {
    this.signal.throwIfAborted();
    const resumePhase = this.state.phase;
    const action = pending.kind === 'child' ? `${pending.toolName} ${pending.command}` : `run ${pending.command}`;
    this.commit({ approval: pending, phase: 'approval_required' }, `Approval requested: ${action}`,
      pending.taskId === null ? {} : { taskId: pending.taskId });
    const decision = await new Promise<RepoAgentDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.pendingUserDecision = null;
        reject(toError(this.signal.reason));
      };
      if (this.signal.aborted) {
        onAbort();
        return;
      }
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.pendingUserDecision = { approvalId: pending.approvalId, resolve: (answer) => {
        this.signal.removeEventListener('abort', onAbort);
        resolve(answer);
      } };
    });
    this.commit({ approval: null, phase: resumePhase },
      decision.decision === 'deny' ? `Approval resolved: deny (${decision.reason}).` : `Approval resolved: ${decision.decision}.`);
    if (decision.decision === 'abort') {
      this.abort('Aborted by user.');
      throw toError(this.signal.reason);
    }
    return decision;
  }

  /** Runs command checks in order; in an interactive run the person approves each one before it runs. */
  private async runChecks(checks: readonly OrchestratorVerificationCheck[], taskId: string | null): Promise<OrchestratorCheckResult[]> {
    const results: OrchestratorCheckResult[] = [];
    for (const check of checks) {
      if (check.kind === 'evidence') {
        results.push(unexecutedCheck(check, ''));
        continue;
      }
      const decision: ContinuingDecision = this.request.approval === 'interactive'
        ? await this.askUser({ kind: 'check', approvalId: randomUUID(), taskId, command: check.command, cwd: check.cwd })
        : { decision: 'approve' };
      results.push(decision.decision === 'deny'
        ? unexecutedCheck(check, `Not run: ${decision.reason}`)
        : await runVerificationCheck({ repoRoot: this.request.repoRoot, check, abortSignal: this.signal }));
    }
    return results;
  }

  /** Runs `checks` under exclusive repository ownership with the parent's model released. */
  private runOwnedChecks(checks: readonly OrchestratorVerificationCheck[]): Promise<OrchestratorCheckResult[]> {
    return this.withModelReleased(() => this.withRepository(() => this.runChecks(checks, null)));
  }

  private async runCheck(args: OrchestratorRunCheckArgs): Promise<OrchestratorToolOutcome> {
    const blocker = this.childBlocker();
    if (blocker !== null) return this.refuse([blocker]);
    const check: OrchestratorVerificationCheck = { kind: 'command', command: args.command, cwd: args.cwd, expectedExitCode: 0 };
    const unrunnable = await findUnrunnableChecks(this.request.repoRoot, [check], this.signal);
    if (unrunnable.length > 0) return this.refuse(unrunnable);
    const [result] = await this.runOwnedChecks([check]);
    if (result === undefined) throw new Error('A check run returned no result.');
    const status = !result.executed ? 'not run' : result.timedOut ? 'timed out' : `exit ${result.exitCode ?? 'unknown'}`;
    const ok = orchestratorCheckFailure(result) === null;
    if (ok) this.passedRunChecks.push(args.command);
    return { ok, output: `${status}\n${renderCheckOutput(result, COMMAND_TAIL_CHARS)}` };
  }

  private recordReview(args: OrchestratorRecordReviewArgs): OrchestratorToolOutcome {
    const task = this.state.plan?.tasks.find((entry) => entry.id === args.taskId);
    const taskState = this.state.tasks.find((entry) => entry.taskId === args.taskId);
    if (task === undefined || taskState === undefined) return this.refuse([`Task '${args.taskId}' is not in the saved plan.`]);
    if (taskState.status !== 'reviewing') return this.refuse([`Task '${args.taskId}' is ${taskState.status}; only a reported task is reviewed.`]);
    const attempt = this.state.attempts.filter((entry) => entry.taskId === args.taskId && entry.result !== null).at(-1);
    const result = attempt?.result ?? null;
    if (attempt === undefined || result === null) return this.refuse([`Task '${args.taskId}' has no settled attempt.`]);
    const problems = findReviewProblems({ repoRoot: this.request.repoRoot, task, result, passedRunChecks: this.passedRunChecks, review: args });
    if (problems.length > 0) return this.refuse(problems);
    const exhausted = OrchestratorChildPurposeSchema.options.every((purpose) => orchestratorAttemptsSpent(this.state.attempts, args.taskId, purpose));
    const status: OrchestratorTaskStatus = args.verdict === 'pass' ? 'completed' : exhausted ? 'failed' : 'reviewing';
    const review = { attempt: attempt.attempt, purpose: attempt.purpose, verdict: args.verdict, criteria: args.criteria, findings: args.findings };
    this.setTask(args.taskId, { status, review }, `Task ${args.taskId}: review ${args.verdict}.`);
    this.awaitingReview.delete(args.taskId);
    if (status === 'completed') this.cleanupTaskTemporaries(task);
    const hint = status === 'failed' ? ' It is out of attempts: retire it with update_tasks and add a replacement task that does it differently.' : '';
    return { ok: true, output: [`Recorded ${args.verdict} for ${args.taskId}; it is now ${status}.${hint}`, this.ledger()].join('\n') };
  }

  // ---- worker submissions ----

  /** The running child; none is a caller bug. */
  private requireChild(): LiveChild {
    if (this.child === null) throw new Error('No child is running.');
    return this.child;
  }

  /** Runs the child's task checks with its model released, so a check may itself call this server's models. */
  async runTaskChecks(): Promise<OrchestratorCheckResult[]> {
    const { task, session } = this.requireChild();
    session.park();
    try {
      return await this.runChecks(task.verification, task.id);
    } finally {
      await session.resume();
    }
  }

  /** The changes charged to the child since its baseline. */
  measureChanges(): Promise<WorkspaceChanges> {
    return diffWorkspace(this.request.repoRoot, this.requireChild().baseline);
  }

  // ---- the parent's finish ----

  /** The parent's finish: code checks the plan is complete, then runs the final verification and hands back failures. */
  async review(answer: string): Promise<SubmissionVerdict> {
    let finish: OrchestratorFinish;
    try {
      finish = ModelJson.parseObject(answer, OrchestratorFinishSchema, 'orchestrator finish');
    } catch (error) {
      return { kind: 'reject', message: `Your finish could not be used: ${toError(error).message}` };
    }
    if (finish.status === 'blocked') {
      this.finishOutcome = { status: 'blocked', reason: finish.reason };
      return { kind: 'accept', output: answer };
    }
    const blocker = this.childBlocker();
    if (blocker !== null) return { kind: 'reject', message: blocker };
    const problem = finishProblem(this.planState());
    if (problem !== null) return { kind: 'reject', message: problem };
    const { plan } = this.state;
    if (plan === null) throw new Error('A finishable run has no plan.');
    if (this.finishNeedsChange) {
      return { kind: 'reject', message: 'Final verification failed and no child has run since, so it would fail again: '
        + 'dispatch a fix, replace what cannot work, or change approach before finishing.' };
    }
    this.commit({ phase: 'verifying' }, 'Running final verification.');
    const checks = await this.runOwnedChecks(plan.finalVerification);
    this.commit({ phase: 'executing' }, 'Final verification finished.');
    const failing = checks.filter((check) => orchestratorCheckFailure(check) !== null);
    if (failing.length === 0) {
      this.finishOutcome = { status: 'completed' };
      return { kind: 'accept', output: answer };
    }
    const findings = failing.map((check) => orchestratorCheckFailure(check) ?? '');
    this.lastFailedFinish = findings;
    this.finishNeedsChange = true;
    if (dispatchBudgetSpent(this.state)) {
      this.finishOutcome = { status: 'budget_exhausted', findings };
      return { kind: 'accept', output: answer };
    }
    return { kind: 'reject', message: [
      'Final verification failed:',
      ...failing.map((check) => `${orchestratorCheckFailure(check) ?? ''}\n${renderCheckOutput(check, COMMAND_TAIL_CHARS)}`),
      'Dispatch fixes for the tasks responsible, or replace what cannot work, then finish again.',
      renderBudget(budgetUsage(this.state, Date.now())),
    ].join('\n') };
  }

  // ---- scratch ----

  private cleanupTaskTemporaries(task: OrchestratorTask): void {
    try {
      for (const temporary of task.temporaryPaths) {
        removeOwnedTemporaryPath(this.request.repoRoot, orchestratorScratchDir(this.runId), temporary);
      }
    } catch (error) {
      throw fail('cleanup_failed', toError(error).message, task.id);
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
}

function renderEscalation({ child, approval }: Escalation): string {
  return [
    `## Approval needed: child for ${child.task.id} (${child.attempt.purpose} attempt ${child.attempt.attempt})`,
    `Tool: ${approval.toolName}`, `Action: ${approval.command}`,
    ...(approval.reviewPayload === null ? [] : ['Proposed content:', approval.reviewPayload]),
    `Files it expects to change: ${child.task.writePaths.join(', ')}`,
    `Answer with decide, approvalId "${approval.approvalId}".`,
  ].join('\n');
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
