import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { ensureDirectory, saveContentAtomically } from '../lib/fs.js';
import { parseJsonText } from '../lib/json.js';
import { z } from '../lib/zod.js';
import {
  NodeProcessInspector,
  type ProcessInspector,
} from '../lib/process-inspector.js';
import {
  RepoAgentApprovalSchema,
  RepoAgentRunIdSchema,
  RepoAgentRunStateSchema,
  RepoAgentRunRequestSchema,
  isActiveStatus,
  isTerminalStatus,
  type RepoAgentApproval,
  type RepoAgentRunRequest,
  type RepoAgentRunState,
} from './run-schemas.js';
import { RepoAgentRunStateLease } from './run-state-lease.js';

const RevisionSchema = z.number().int().nonnegative();

function serialize(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ownerPid(state: RepoAgentRunState): number | undefined {
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

  hasRun(runId: string): boolean {
    try {
      const runPath = this.runDir(runId);
      if (!statSync(runPath).isDirectory()) {
        throw new Error(`Run path is not a directory: ${runPath}.`);
      }
      return true;
    } catch (error) {
      if (
        error !== null
        && typeof error === 'object'
        && 'code' in error
        && typeof error.code === 'string'
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return false;
      }
      throw error;
    }
  }

  create(input: RepoAgentRunRequest): RepoAgentRunState {
    const request = RepoAgentRunRequestSchema.parse(input);
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
        pid: process.pid,
      });
      saveContentAtomically(this.statePath(request.runId), serialize(state));
      return state;
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      throw error;
    }
  }

  readRequest(runId: string): RepoAgentRunRequest {
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
    const lease = this.stateLease(validatedRunId);
    lease.acquire();
    try {
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
    } finally {
      lease.release();
    }
  }

  publishApproval(
    runId: string,
    expectedRevision: number,
    input: RepoAgentApproval,
  ): RepoAgentRunState {
    const validatedRunId = this.validRunId(runId);
    const validatedRevision = RevisionSchema.parse(expectedRevision);
    const lease = this.stateLease(validatedRunId);
    lease.acquire();
    try {
      const current = this.readStateFile(validatedRunId);
      this.assertCurrentRevision(current, validatedRevision);
      if (current.status !== 'running') {
        throw new Error('An approval can only be published from running state.');
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
    } finally {
      lease.release();
    }
  }

  clearPendingApproval(
    runId: string,
    expectedRevision: number,
    status: 'running' | 'aborted' | 'approval_timeout',
  ): RepoAgentRunState {
    const validatedRunId = this.validRunId(runId);
    const validatedRevision = RevisionSchema.parse(expectedRevision);
    const lease = this.stateLease(validatedRunId);
    lease.acquire();
    try {
      const current = this.readStateFile(validatedRunId);
      this.assertCurrentRevision(current, validatedRevision);
      if (current.status !== 'approval_required') {
        throw new Error(`Run ${validatedRunId} has no pending approval_required state.`);
      }

      const shared = {
        runId: validatedRunId,
        revision: validatedRevision + 1,
        updatedAtUtc: new Date().toISOString(),
        pid: current.pid,
      };
      // approval_timeout keeps what stalled visible to the overseer but drops the
      // bulky review payload, matching the no-sensitive-content rule for settled states.
      const next = status === 'approval_timeout'
        ? RepoAgentRunStateSchema.parse({
          ...shared,
          status: 'approval_timeout',
          approval: { ...current.approval, reviewPayload: null },
        })
        : RepoAgentRunStateSchema.parse({ ...shared, status });
      this.writeState(next);
      return next;
    } finally {
      lease.release();
    }
  }

  /** Terminalizes a run the server can no longer resume (restart lost the in-memory conversation). */
  markNotResumable(runId: string): RepoAgentRunState {
    const validatedRunId = this.validRunId(runId);
    const lease = this.stateLease(validatedRunId);
    lease.acquire();
    try {
      const current = this.readStateFile(validatedRunId);
      if (isTerminalStatus(current.status)) {
        return current;
      }
      const pid = ownerPid(current);
      const next = RepoAgentRunStateSchema.parse({
        runId: validatedRunId,
        revision: current.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'failed',
        ...(pid === undefined ? {} : { pid }),
        error: 'Run is not resumable: the status server restarted while the run was active and the in-memory conversation was lost. Start a new run.',
      });
      this.writeState(next);
      return next;
    } finally {
      lease.release();
    }
  }

  /** Reads state; if the recorded server pid is dead on an active state, records the failure first. */
  reconcile(
    runId: string,
    inspector: ProcessInspector = new NodeProcessInspector(),
  ): RepoAgentRunState {
    const state = this.readState(runId);
    if (!isActiveStatus(state.status)) {
      return state;
    }
    const pid = ownerPid(state);
    if (pid === undefined || inspector.isAlive(pid)) {
      return state;
    }
    try {
      return this.transition(runId, state.revision, {
        runId,
        revision: state.revision + 1,
        updatedAtUtc: new Date().toISOString(),
        status: 'failed',
        pid,
        error: `Owning server process ${pid} died while the run was active.`,
      });
    } catch (error) {
      let freshState: RepoAgentRunState;
      try {
        freshState = this.readState(runId);
      } catch {
        throw error;
      }
      if (freshState.revision === state.revision) {
        throw error;
      }
      return freshState;
    }
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
      const runId = RepoAgentRunIdSchema.safeParse(entry.name);
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
    const parsed = RepoAgentRunIdSchema.safeParse(runId);
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

  private stateLease(runId: string): RepoAgentRunStateLease {
    return new RepoAgentRunStateLease(join(this.runDir(runId), 'state.lock'));
  }

  private readRequestFile(runId: string): RepoAgentRunRequest {
    const filePath = this.requestPath(runId);
    if (!existsSync(filePath)) {
      throw new Error(`Request file not found for run ${runId}.`);
    }
    try {
      return parseJsonText(
        readFileSync(filePath, 'utf8'),
        RepoAgentRunRequestSchema,
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
    const currentPid = ownerPid(current);
    if (currentPid !== undefined && ownerPid(next) !== currentPid) {
      throw new Error('A run must preserve its owning server pid across transitions.');
    }
  }

  private writeState(state: RepoAgentRunState): void {
    saveContentAtomically(this.statePath(state.runId), serialize(state));
  }
}
