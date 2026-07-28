import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { ensureDirectory, saveContentAtomically } from '../lib/fs.js';
import { parseJsonText } from '../lib/json.js';
import { z } from '../lib/zod.js';
import {
  RepoAgentApprovalSchema,
  RepoAgentDecisionSchema,
  RepoAgentRunStateSchema,
  RepoAgentWorkerRequestSchema,
  isTerminalStatus,
  type RepoAgentApproval,
  type RepoAgentDecision,
  type RepoAgentRunState,
  type RepoAgentWorkerRequest,
} from './run-schemas.js';

const RunIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().nonnegative();

function serialize(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function workerPid(state: RepoAgentRunState): number | undefined {
  if (state.status === 'starting') {
    return undefined;
  }
  return state.pid;
}

export class RepoAgentRunStore {
  private readonly runsRoot: string;

  constructor(runsRoot: string) {
    this.runsRoot = z.string().min(1).parse(runsRoot);
  }

  getRunsRoot(): string {
    return this.runsRoot;
  }

  create(input: RepoAgentWorkerRequest): RepoAgentRunState {
    const request = RepoAgentWorkerRequestSchema.parse(input);
    const runDir = this.runDir(request.runId);
    if (existsSync(runDir)) {
      throw new Error(`Run already exists: ${request.runId}`);
    }

    ensureDirectory(runDir);
    try {
      saveContentAtomically(this.requestPath(request.runId), serialize(request));
      const state = RepoAgentRunStateSchema.parse({
        runId: request.runId,
        revision: 0,
        updatedAtUtc: new Date().toISOString(),
        status: 'starting',
      });
      saveContentAtomically(this.statePath(request.runId), serialize(state));
      return state;
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      throw error;
    }
  }

  readRequest(runId: string): RepoAgentWorkerRequest {
    return this.readRequestFile(this.validRunId(runId));
  }

  readState(runId: string): RepoAgentRunState {
    return this.readStateFile(this.validRunId(runId));
  }

  transition(
    runId: string,
    expectedRevision: number,
    next: RepoAgentRunState,
  ): RepoAgentRunState {
    const validatedRunId = this.validRunId(runId);
    const validatedRevision = RevisionSchema.parse(expectedRevision);
    const current = this.readStateFile(validatedRunId);
    this.assertCurrentRevision(current, validatedRevision);
    if (isTerminalStatus(current.status)) {
      throw new Error(`Run ${validatedRunId} is already terminal.`);
    }

    const validatedNext = RepoAgentRunStateSchema.parse(next);
    if (validatedNext.runId !== validatedRunId) {
      throw new Error('The next state runId must match the transitioned run identity.');
    }
    if (validatedNext.revision !== validatedRevision + 1) {
      throw new Error('The next revision must increase exactly once.');
    }
    this.assertWorkerPidPreserved(current, validatedNext);
    this.writeState(validatedNext);
    return validatedNext;
  }

  publishApproval(
    runId: string,
    expectedRevision: number,
    input: RepoAgentApproval,
  ): RepoAgentRunState {
    const validatedRunId = this.validRunId(runId);
    const validatedRevision = RevisionSchema.parse(expectedRevision);
    const current = this.readStateFile(validatedRunId);
    this.assertCurrentRevision(current, validatedRevision);
    if (current.status !== 'running') {
      throw new Error('An approval can only be published from running state.');
    }
    if (
      existsSync(this.decisionPath(validatedRunId))
      || existsSync(this.decisionClaimPath(validatedRunId))
    ) {
      throw new Error('A decision already exists for this run.');
    }

    const approval = RepoAgentApprovalSchema.parse(input);
    const next = RepoAgentRunStateSchema.parse({
      runId: validatedRunId,
      revision: validatedRevision + 1,
      updatedAtUtc: new Date().toISOString(),
      status: 'approval_required',
      pid: current.pid,
      approval,
    });
    this.writeState(next);
    return next;
  }

  submitDecision(input: RepoAgentDecision): void {
    const decision = RepoAgentDecisionSchema.parse(input);
    const runId = this.validRunId(decision.runId);
    const current = this.readStateFile(runId);
    if (current.status !== 'approval_required') {
      throw new Error(`Run ${runId} has no pending approval.`);
    }
    if (current.revision !== decision.observedRevision) {
      throw new Error(
        `Stale revision: expected ${current.revision}, received ${decision.observedRevision}.`,
      );
    }
    if (current.approval.approvalId !== decision.approvalId) {
      throw new Error('The decision approval ID does not match the pending approval.');
    }

    const decisionPath = this.decisionPath(runId);
    const claimPath = this.decisionClaimPath(runId);
    if (existsSync(decisionPath) || existsSync(claimPath)) {
      throw new Error('A decision was already submitted for this approval.');
    }

    try {
      const descriptor = openSync(claimPath, 'wx');
      closeSync(descriptor);
    } catch (error) {
      if (existsSync(claimPath)) {
        throw new Error('A decision was already submitted for this approval.');
      }
      throw error;
    }

    try {
      saveContentAtomically(decisionPath, serialize(decision));
    } catch (error) {
      rmSync(claimPath, { force: true });
      throw error;
    }
  }

  consumeDecision(
    runId: string,
    approvalId: string,
    expectedRevision: number,
  ): RepoAgentDecision | null {
    const validatedRunId = this.validRunId(runId);
    const validatedApprovalId = z.string().uuid().parse(approvalId);
    const validatedRevision = RevisionSchema.parse(expectedRevision);
    const current = this.readStateFile(validatedRunId);
    if (
      current.status !== 'approval_required'
      || current.revision !== validatedRevision
      || current.approval.approvalId !== validatedApprovalId
    ) {
      return null;
    }

    const decisionPath = this.decisionPath(validatedRunId);
    if (!existsSync(decisionPath)) {
      return null;
    }
    const decision = this.readDecisionFile(validatedRunId);
    if (
      decision.approvalId !== validatedApprovalId
      || decision.observedRevision !== validatedRevision
    ) {
      return null;
    }
    rmSync(decisionPath, { force: true });
    return decision;
  }

  clearPendingApproval(
    runId: string,
    expectedRevision: number,
    status: 'running' | 'aborted',
  ): RepoAgentRunState {
    const validatedRunId = this.validRunId(runId);
    const validatedRevision = RevisionSchema.parse(expectedRevision);
    const current = this.readStateFile(validatedRunId);
    this.assertCurrentRevision(current, validatedRevision);
    if (current.status !== 'approval_required') {
      throw new Error(`Run ${validatedRunId} has no pending approval_required state.`);
    }

    rmSync(this.decisionPath(validatedRunId), { force: true });
    rmSync(this.decisionClaimPath(validatedRunId), { force: true });
    const shared = {
      runId: validatedRunId,
      revision: validatedRevision + 1,
      updatedAtUtc: new Date().toISOString(),
      pid: current.pid,
    };
    const next = status === 'running'
      ? RepoAgentRunStateSchema.parse({ ...shared, status: 'running' })
      : RepoAgentRunStateSchema.parse({ ...shared, status: 'aborted' });
    this.writeState(next);
    return next;
  }

  pruneTerminalRuns(retentionDays: number, now: Date): string[] {
    const validatedRetentionDays = z.number().nonnegative().finite().parse(retentionDays);
    const cutoffMs = now.getTime() - validatedRetentionDays * 24 * 60 * 60 * 1000;
    const pruned: string[] = [];
    if (!existsSync(this.runsRoot)) {
      return pruned;
    }

    const entries = readdirSync(this.runsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const runId = RunIdSchema.safeParse(entry.name);
      if (!runId.success) {
        continue;
      }

      let state: RepoAgentRunState;
      try {
        state = this.readStateFile(runId.data);
      } catch {
        continue;
      }
      if (
        !isTerminalStatus(state.status)
        || new Date(state.updatedAtUtc).getTime() >= cutoffMs
      ) {
        continue;
      }
      rmSync(this.runDir(runId.data), { recursive: true, force: true });
      pruned.push(runId.data);
    }
    return pruned;
  }

  private validRunId(runId: string): string {
    const parsed = RunIdSchema.safeParse(runId);
    if (!parsed.success) {
      throw new Error(`Invalid runId: ${runId}`);
    }
    return parsed.data;
  }

  private runDir(runId: string): string {
    return join(this.runsRoot, this.validRunId(runId));
  }

  private requestPath(runId: string): string {
    return join(this.runDir(runId), 'request.json');
  }

  private statePath(runId: string): string {
    return join(this.runDir(runId), 'state.json');
  }

  private decisionPath(runId: string): string {
    return join(this.runDir(runId), 'decision.json');
  }

  private decisionClaimPath(runId: string): string {
    return join(this.runDir(runId), 'decision.claim');
  }

  private readRequestFile(runId: string): RepoAgentWorkerRequest {
    const filePath = this.requestPath(runId);
    if (!existsSync(filePath)) {
      throw new Error(`Request file not found for run ${runId}.`);
    }
    try {
      return parseJsonText(
        readFileSync(filePath, 'utf8'),
        RepoAgentWorkerRequestSchema,
      );
    } catch {
      throw new Error(`Malformed request file for run ${runId}.`);
    }
  }

  private readStateFile(runId: string): RepoAgentRunState {
    const filePath = this.statePath(runId);
    if (!existsSync(filePath)) {
      throw new Error(`State file not found for run ${runId}.`);
    }
    try {
      return parseJsonText(readFileSync(filePath, 'utf8'), RepoAgentRunStateSchema);
    } catch {
      throw new Error(`Malformed state file for run ${runId}.`);
    }
  }

  private readDecisionFile(runId: string): RepoAgentDecision {
    try {
      return parseJsonText(
        readFileSync(this.decisionPath(runId), 'utf8'),
        RepoAgentDecisionSchema,
      );
    } catch {
      throw new Error(`Malformed decision file for run ${runId}.`);
    }
  }

  private assertCurrentRevision(
    current: RepoAgentRunState,
    expectedRevision: number,
  ): void {
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Stale revision: expected ${expectedRevision}, actual ${current.revision}.`,
      );
    }
  }

  private assertWorkerPidPreserved(
    current: RepoAgentRunState,
    next: RepoAgentRunState,
  ): void {
    const currentPid = workerPid(current);
    if (currentPid !== undefined && workerPid(next) !== currentPid) {
      throw new Error('A run must preserve its worker pid across transitions.');
    }
  }

  private writeState(state: RepoAgentRunState): void {
    saveContentAtomically(this.statePath(state.runId), serialize(state));
  }
}
