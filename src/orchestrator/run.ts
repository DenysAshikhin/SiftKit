import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  isOrchestratorTerminalPhase,
  type OrchestratorAttempt,
  type OrchestratorAttemptResult,
  type OrchestratorCheckResult,
  type OrchestratorChildWork,
  type OrchestratorDriftFinding,
  type OrchestratorDriftReview,
  type OrchestratorFailure,
  type OrchestratorPlan,
  type OrchestratorRunState,
  type OrchestratorStartRequest,
  type OrchestratorTask,
  type OrchestratorTaskStatus,
  type OrchestratorVerificationCheck,
  type RepoAgentApproval,
  type SiftPreset,
} from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.js';
import { toError } from '../lib/errors.js';
import { PresetCatalog } from '../preset-catalog.js';
import { resolveRepoScopedPath } from '../repo-search/engine/repo-paths.js';
import { readConfig } from '../status-server/config-store.js';
import type { OrchestratorLiveRun, RepositoryAccess, RepositoryLease } from '../status-server/orchestrator-runs.js';
import type { RepoAgentSession } from '../status-server/repo-agent-sessions.js';
import type { ServerContext } from '../status-server/server-types.js';
import { buildDriftCorrectionWork, validateDriftReview } from './drift-review.js';
import { OrchestratorPhaseRunner, type OrchestratorPhaseRequest } from './phase-runner.js';
import { renderOrchestratorPlan, validateOrchestratorPlan } from './plan.js';
import { buildDriftCorrectionPrompt, buildImplementationInstruction, type ImplementationRetryEvidence } from './prompts.js';
import { isMutatingTask, selectTasksToStart } from './scheduler.js';
import { evaluateAttempt, runVerificationChecks } from './verification.js';
import { startOrchestratorChild, toChildOutcome, type ChildOutcome } from './workers.js';
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
  type WorkspaceSnapshot,
} from './workspace.js';

const PLAN_PREPARATION_ATTEMPTS = 2;
const DRIFT_REVIEW_ATTEMPTS = 2;

/** A decision a person or the parent gives to one pending approval. */
export type OrchestratorApprovalAnswer =
  | { decision: 'approve' }
  | { decision: 'deny'; reason: string }
  | { decision: 'abort' };

type PendingUserDecision = { approvalId: string; resolve(answer: OrchestratorApprovalAnswer): void };

/** A stop with a precise, stored diagnosis. */
class OrchestratorRunFailure extends Error {
  constructor(readonly failure: OrchestratorFailure) {
    super(failure.message);
  }
}

function fail(code: string, message: string, detail: Partial<Omit<OrchestratorFailure, 'code' | 'message'>> = {}): OrchestratorRunFailure {
  return new OrchestratorRunFailure({ code, message, taskId: detail.taskId ?? null, purpose: detail.purpose ?? null,
    findingIds: detail.findingIds ?? [] });
}

type AttemptOutcome = { result: OrchestratorAttemptResult; findings: string[] };

/**
 * One live orchestrator parent: prepares the plan, schedules bounded children under the repository
 * gate, verifies their work independently, gates code changes on drift review, and records every
 * transition. It holds a model lease only inside finite phases, never across a child's wait.
 */
export class OrchestratorRun implements OrchestratorLiveRun {
  readonly runId: string;
  readonly settled: Promise<void>;
  private readonly abortController = new AbortController();
  private readonly phases: OrchestratorPhaseRunner;
  private readonly children = new Map<string, RepoAgentSession>();
  private pendingUserDecision: PendingUserDecision | null = null;
  private registered = false;
  private state: OrchestratorRunState;

  private constructor(private readonly ctx: ServerContext, state: OrchestratorRunState) {
    this.runId = state.runId;
    this.state = state;
    this.phases = new OrchestratorPhaseRunner(ctx);
    // Work begins on the next tick, and only once the registry owns this run.
    this.settled = Promise.resolve().then(() => (this.registered ? this.execute() : undefined));
    ctx.orchestratorRuns.register(this);
    this.registered = true;
  }

  /** Creates (or returns the existing parent for) a submission; only a new parent starts work. */
  static start(ctx: ServerContext, request: OrchestratorStartRequest): OrchestratorRunState {
    requireOrchestratorPreset(readConfig(ctx.configPath), request.presetId);
    const state = ctx.orchestratorRunStore.create(request);
    if (!isOrchestratorTerminalPhase(state.phase) && ctx.orchestratorRuns.get(state.runId) === undefined && state.revision === 0) {
      new OrchestratorRun(ctx, state);
    }
    return state;
  }

  abort(reason: string): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(new Error(reason));
    for (const child of this.children.values()) child.abort();
  }

  /** Answers the pending user approval; false when that approval is not the one waiting. */
  decide(approvalId: string, answer: OrchestratorApprovalAnswer): boolean {
    const pending = this.pendingUserDecision;
    if (pending === null || pending.approvalId !== approvalId) return false;
    this.pendingUserDecision = null;
    pending.resolve(answer);
    return true;
  }

  private get signal(): AbortSignal {
    return this.abortController.signal;
  }

  private get request(): OrchestratorStartRequest {
    return this.state.request;
  }

  // ---- lifecycle ----

  private async execute(): Promise<void> {
    try {
      const plan = await this.preparePlan();
      await this.executeTasks(plan);
      await this.verifyFinal(plan);
      this.commit({ phase: 'cleaning' }, 'Cleaning run scratch files.');
      this.cleanup(() => cleanupScratch(this.request.repoRoot, orchestratorScratchDir(this.runId)), null);
      this.commit({ phase: 'completed', failure: null }, 'Run completed.');
    } catch (error) {
      this.settleFailure(toError(error));
    } finally {
      this.pendingUserDecision = null;
      for (const child of this.children.values()) child.abort();
      await Promise.allSettled([...this.children.values()].map((child) => child.settled));
    }
  }

  private settleFailure(error: Error): void {
    const current = this.ctx.orchestratorRunStore.read(this.runId);
    if (isOrchestratorTerminalPhase(current.phase)) {
      this.state = current;
      return;
    }
    this.state = current;
    if (this.signal.aborted) {
      const message = toError(this.signal.reason).message;
      this.commit({ phase: 'aborted', approval: null,
        failure: { code: 'aborted', message, taskId: null, purpose: null, findingIds: [] } }, message);
      return;
    }
    const failure = error instanceof OrchestratorRunFailure
      ? error.failure
      : { code: 'internal_error', message: error.message, taskId: null, purpose: null, findingIds: [] };
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

  private phaseRequest(): OrchestratorPhaseRequest {
    const phaseRunId = randomUUID();
    this.commit({ phaseRunIds: [...this.state.phaseRunIds, phaseRunId] }, 'Parent phase started.');
    return { runId: this.runId, phaseRunId, presetId: this.request.presetId, repoRoot: this.request.repoRoot,
      abortSignal: this.signal };
  }

  private acquireRepository(access: RepositoryAccess): Promise<RepositoryLease> {
    return this.ctx.orchestratorRuns.repositoryGate.acquire(this.request.repoRoot, access, this.signal);
  }

  // ---- plan ----

  private async preparePlan(): Promise<OrchestratorPlan> {
    const config = readConfig(this.ctx.configPath);
    const supplied = this.request.planPath === null ? null : readSuppliedPlan(this.request.repoRoot, this.request.planPath);
    const workers = config.Presets
      .filter((preset) => preset.presetKind === 'repo-agent' || preset.presetKind === 'repo-search');
    let previousErrors: string[] = [];
    for (let attempt = 1; attempt <= PLAN_PREPARATION_ATTEMPTS; attempt += 1) {
      const lease = await this.acquireRepository('shared');
      let preparation;
      try {
        preparation = await this.phases.preparePlan(this.phaseRequest(), {
          task: this.request.task, planPath: supplied?.path ?? null, planMarkdown: supplied?.markdown ?? null, workers, previousErrors,
        });
      } catch (error) {
        this.signal.throwIfAborted();
        previousErrors = [toError(error).message];
        continue;
      } finally {
        lease.release();
      }
      if (preparation.status === 'blocked') throw fail('plan_blocked', `The plan could not be prepared: ${preparation.reason}`);
      this.commit({ phase: 'validating_plan' }, 'Validating the plan.');
      let plan: OrchestratorPlan;
      try {
        plan = validateOrchestratorPlan(preparation.plan, config, this.request.repoRoot);
      } catch (error) {
        previousErrors = [toError(error).message];
        this.commit({ phase: 'preparing_plan' }, `Plan rejected: ${previousErrors[0] ?? ''}`);
        continue;
      }
      const saved = preparation.status === 'ready' && supplied !== null
        ? { path: supplied.path, markdown: supplied.markdown }
        : await this.writeGeneratedPlan(plan);
      this.publish(this.ctx.orchestratorRunStore.savePlan(this.runId, this.state.revision, plan, saved.path, hashText(saved.markdown)));
      this.commit({ phase: 'executing' }, 'Executing the plan.');
      return plan;
    }
    throw fail('plan_invalid', `No valid plan after ${PLAN_PREPARATION_ATTEMPTS} attempts: ${previousErrors.join(' ')}`);
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
    const config = readConfig(this.ctx.configPath);
    const options = requireOrchestratorPreset(config, this.request.presetId).orchestrator;
    if (options === null) throw new Error(`Orchestrator preset '${this.request.presetId}' has no orchestrator options.`);
    const { planPath, planHash } = this.state;
    if (planPath === null || planHash === null) throw new Error('Tasks cannot start before the plan is saved.');
    const maxSubagents = options.maxSubagents;
    const running = new Map<string, { mutating: boolean; done: Promise<string> }>();
    for (;;) {
      this.signal.throwIfAborted();
      for (const task of selectTasksToStart({ config, plan, taskStates: this.state.tasks, maxSubagents,
        active: [...running].map(([taskId, entry]) => ({ taskId, mutating: entry.mutating })) })) {
        this.setTaskStatus(task.id, 'running');
        running.set(task.id, { mutating: isMutatingTask(config, task), done: this.runTask(task, config, planPath, planHash).then(() => task.id) });
      }
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

  private async runTask(task: OrchestratorTask, config: SiftConfig, planPath: string, planHash: string): Promise<void> {
    const lease = await this.acquireRepository(isMutatingTask(config, task) ? 'exclusive' : 'shared');
    try {
      const baseline = await captureWorkspace(this.request.repoRoot);
      let retry: ImplementationRetryEvidence | null = null;
      let passing: AttemptOutcome | null = null;
      while (passing === null) {
        const attempt = this.reserve(task.id, { kind: 'implementation', planPath, planHash, task });
        const instruction = buildImplementationInstruction({ task, planPath, planHash, attempt: attempt.attempt,
          scratchPath: orchestratorScratchDir(this.runId), preexistingDirtyPaths: [...baseline.keys()], retry });
        const outcome = await this.runAttempt(task, task.writePaths, attempt, instruction, baseline);
        if (outcome.result.passed) {
          passing = outcome;
        } else if (attempt.attempt >= 2) {
          this.setTaskStatus(task.id, 'failed');
          throw fail('implementation_failed', `Task '${task.id}' failed both implementation attempts: ${outcome.findings.join(' ')}`,
            { taskId: task.id, purpose: 'implementation' });
        } else {
          this.setTaskStatus(task.id, 'retry_pending');
          retry = { failure: outcome.findings.join('\n'), checks: outcome.result.checks, changedPaths: outcome.result.changedPaths,
            diff: await this.renderDiff(baseline, outcome.result.changedPaths) };
        }
      }
      await this.driftGate(task, baseline, passing.result.checks);
      this.cleanup(() => {
        for (const temporary of task.temporaryPaths) {
          removeOwnedTemporaryPath(this.request.repoRoot, orchestratorScratchDir(this.runId), temporary);
        }
      }, task.id);
      this.setTaskStatus(task.id, 'completed');
    } finally {
      lease.release();
    }
  }

  private cleanup(action: () => void, taskId: string | null): void {
    try {
      action();
    } catch (error) {
      throw fail('cleanup_failed', toError(error).message, { taskId });
    }
  }

  private reserve(taskId: string, work: OrchestratorChildWork): OrchestratorAttempt {
    const attempt = this.ctx.orchestratorRunStore.reserveAttempt(this.runId, this.state.revision, taskId, work);
    this.publish(this.ctx.orchestratorRunStore.read(this.runId));
    return attempt;
  }

  // ---- one child attempt: dispatch, supervise, verify ----

  private async runAttempt(
    task: OrchestratorTask,
    writePaths: readonly string[],
    attempt: OrchestratorAttempt,
    instruction: string,
    baseline: WorkspaceSnapshot,
  ): Promise<AttemptOutcome> {
    const child = await this.superviseChild(task, attempt, instruction);
    this.setTaskStatus(task.id, 'verifying');
    const checks = await this.runChecks(task.verification);
    const changes = await diffWorkspace(this.request.repoRoot, baseline);
    const scopeViolations = findScopeViolations(changes.paths, writePaths);
    const review = checks.some((check) => check.check.kind === 'evidence')
      ? await this.reviewEvidence(task, child, checks, changes.paths)
      : null;
    const evaluation = evaluateAttempt({ repoRoot: this.request.repoRoot, workerStatus: child.workerStatus, checks, scopeViolations,
      review: review?.review ?? null });
    const findings = [...(review?.error === undefined ? [] : [review.error]), ...evaluation.findings];
    const result: OrchestratorAttemptResult = {
      taskId: task.id, purpose: attempt.purpose, attempt: attempt.attempt, childRunId: attempt.childRunId,
      workerStatus: child.workerStatus, workerOutput: child.output, passed: findings.length === 0, checks, findings,
      changedPaths: changes.paths, scopeViolations, changeDigest: changes.digest,
    };
    this.publish(this.ctx.orchestratorRunStore.recordAttemptResult(this.runId, this.state.revision, result));
    return { result, findings };
  }

  private async reviewEvidence(task: OrchestratorTask, child: ChildOutcome, checks: OrchestratorCheckResult[], changedPaths: string[]) {
    try {
      return { review: await this.phases.reviewAttempt(this.phaseRequest(), {
        task, result: { workerOutput: child.output, checks, changedPaths } }) };
    } catch (error) {
      this.signal.throwIfAborted();
      return { review: null, error: `The evidence review failed: ${toError(error).message}` };
    }
  }

  private async superviseChild(task: OrchestratorTask, attempt: OrchestratorAttempt, instruction: string): Promise<ChildOutcome> {
    this.signal.throwIfAborted();
    const session = startOrchestratorChild(this.ctx, {
      runId: this.runId, taskId: task.id, attempt: attempt.attempt, childRunId: attempt.childRunId,
      workerPresetId: attempt.work.kind === 'drift_fix' ? 'repo-agent' : task.workerPresetId,
      repoRoot: this.request.repoRoot, work: attempt.work, instruction, approval: this.request.approval,
    });
    this.children.set(attempt.childRunId, session);
    this.publish(this.ctx.orchestratorRunStore.markAttemptRunning(this.runId, this.state.revision, attempt.childRunId));
    try {
      let seen = 0;
      for (;;) {
        const boundary = await session.waitForBoundary(seen, this.signal);
        seen = session.currentRevision();
        if (boundary.status !== 'approval_required') return toChildOutcome(boundary);
        const answer = await this.answerApproval(task, { kind: 'child', childRunId: attempt.childRunId }, boundary.approval,
          { purpose: attempt.purpose, attempt: attempt.attempt });
        if (answer.decision === 'abort') {
          this.abort('Aborted by user.');
          this.signal.throwIfAborted();
        }
        session.submitDecision(answer.decision === 'deny'
          ? { runId: attempt.childRunId, decision: 'deny', reason: answer.reason }
          : { runId: attempt.childRunId, decision: 'approve' });
        seen = session.currentRevision();
      }
    } catch (error) {
      session.abort();
      await session.settled;
      throw error;
    } finally {
      this.children.delete(attempt.childRunId);
    }
  }

  /**
   * Resolves one approval. Interactive runs ask the person; otherwise the parent decides on its
   * own model in a finite phase. The child holds no model lease while either happens.
   */
  private async answerApproval(
    task: OrchestratorTask | null,
    target: NonNullable<OrchestratorRunState['approval']>['target'],
    approval: RepoAgentApproval,
    child: { purpose: OrchestratorAttempt['purpose']; attempt: number } | null,
  ): Promise<OrchestratorApprovalAnswer> {
    const resumePhase = this.state.phase;
    this.commit({ approval: { target, taskId: task?.id ?? null, approval } },
      `Approval requested: ${approval.toolName} ${approval.command}`, task === null ? {} : { taskId: task.id });
    try {
      if (this.request.approval === 'interactive' || task === null || child === null) {
        this.commit({ phase: 'approval_required' }, 'Waiting for your approval decision.');
        return await this.waitForUserDecision(approval.approvalId);
      }
      try {
        const decision = await this.phases.decideChildApproval(this.phaseRequest(), { task, purpose: child.purpose,
          attempt: child.attempt, approval });
        return decision.decision === 'approve' ? { decision: 'approve' } : { decision: 'deny', reason: `orchestrator: ${decision.reason}` };
      } catch (error) {
        this.signal.throwIfAborted();
        return { decision: 'deny', reason: `The orchestrator could not decide this request: ${toError(error).message}` };
      }
    } finally {
      if (!this.signal.aborted) this.commit({ approval: null, phase: resumePhase }, 'Approval resolved.');
    }
  }

  private waitForUserDecision(approvalId: string): Promise<OrchestratorApprovalAnswer> {
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
      this.pendingUserDecision = { approvalId, resolve: (answer) => {
        this.signal.removeEventListener('abort', onAbort);
        resolve(answer);
      } };
    });
  }

  /** Command checks run for real; an interactive run asks before running them. */
  private async runChecks(checks: readonly OrchestratorVerificationCheck[]): Promise<OrchestratorCheckResult[]> {
    const commands = checks.flatMap((check) => (check.kind === 'command' ? [check.command] : []));
    if (commands.length > 0 && this.request.approval === 'interactive') {
      const phaseRunId = randomUUID();
      const answer = await this.answerApproval(null, { kind: 'phase', phaseRunId },
        { approvalId: randomUUID(), toolName: 'run', command: commands.join(' ; '), reviewPayload: null }, null);
      if (answer.decision === 'abort') {
        this.abort('Aborted by user.');
        this.signal.throwIfAborted();
      }
      if (answer.decision === 'deny') {
        return checks.map((check) => ({ check, executed: false, exitCode: null, timedOut: false,
          output: check.kind === 'command' ? `Not run: ${answer.reason}` : '' }));
      }
    }
    return runVerificationChecks({ repoRoot: this.request.repoRoot, checks, runId: this.runId, abortSignal: this.signal });
  }

  private renderDiff(baseline: WorkspaceSnapshot, paths: readonly string[]): Promise<string> {
    return renderWorkspaceDiff({ repoRoot: this.request.repoRoot, baseline, paths, scratchDir: orchestratorScratchDir(this.runId) });
  }

  // ---- drift gate ----

  private async driftGate(task: OrchestratorTask, baseline: WorkspaceSnapshot, initialChecks: OrchestratorCheckResult[]): Promise<void> {
    let checks = initialChecks;
    let openFindings: OrchestratorDriftFinding[] = [];
    let retryEvidence: string | null = null;
    for (;;) {
      const changes = await diffWorkspace(this.request.repoRoot, baseline);
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
      if (used >= 2) {
        throw fail('drift_unresolved', `Task '${task.id}' still has unresolved drift after two corrections.`,
          { taskId: task.id, purpose: 'drift_fix', findingIds: openFindings.map((finding) => finding.id) });
      }
      this.setTaskStatus(task.id, 'correcting_drift');
      const work = buildDriftCorrectionWork({ task, changeDigest: digest, findings: openFindings });
      const attempt = this.reserve(task.id, work);
      const outcome = await this.runAttempt({ ...task, verification: work.verification }, work.allowedPaths, attempt,
        buildDriftCorrectionPrompt(work, retryEvidence), baseline);
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
    let rejectedProblems: string[] = [];
    for (let attempt = 1; attempt <= DRIFT_REVIEW_ATTEMPTS; attempt += 1) {
      let review: OrchestratorDriftReview;
      try {
        review = await this.phases.reviewDrift(this.phaseRequest(), { task, changeDigest, diff, changedPaths, openFindings, checks,
          rejectedProblems });
      } catch (error) {
        this.signal.throwIfAborted();
        rejectedProblems = [toError(error).message];
        continue;
      }
      rejectedProblems = validateDriftReview({ review, repoRoot: this.request.repoRoot, taskId: task.id, changeDigest, changedPaths,
        openFindings });
      if (rejectedProblems.length === 0) return review;
    }
    throw fail('drift_review_invalid', `Task '${task.id}' drift review was unusable: ${rejectedProblems.join(' ')}`,
      { taskId: task.id, findingIds: openFindings.map((finding) => finding.id) });
  }

  // ---- final verification ----

  private async verifyFinal(plan: OrchestratorPlan): Promise<void> {
    this.commit({ phase: 'verifying' }, 'Running final verification.');
    // Global validation commands take exclusive ownership of the checkout.
    const lease = await this.acquireRepository('exclusive');
    try {
      const checks = await this.runChecks(plan.finalVerification);
      const review = checks.some((check) => check.check.kind === 'evidence')
        ? await this.phases.verifyFinal(this.phaseRequest(), { goal: plan.goal, checks })
        : null;
      const evaluation = evaluateAttempt({ repoRoot: this.request.repoRoot, workerStatus: 'completed', checks, scopeViolations: [], review });
      if (!evaluation.passed) throw fail('final_verification_failed', `Final verification failed: ${evaluation.findings.join(' ')}`);
    } finally {
      lease.release();
    }
  }
}

function requireOrchestratorPreset(config: SiftConfig, presetId: string): SiftPreset {
  const preset = PresetCatalog.fromPresets(config.Presets).requireById(presetId);
  if (preset.presetKind !== 'orchestrator') throw new Error(`Preset '${presetId}' is a ${preset.presetKind} preset, not an orchestrator.`);
  return preset;
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
