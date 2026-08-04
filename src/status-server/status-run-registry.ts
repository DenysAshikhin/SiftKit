/* c8 ignore next */
import type { ActiveStatusRun } from '@siftkit/contracts';
import type { ManagedLlamaSpeculativeMetricsSnapshot } from './managed-llama.js';
import type { TaskKind } from './metrics.js';
import type { StatusMetadata } from './status-file.js';

export const TERMINAL_SNAPSHOT_RETENTION_MS = 300_000;
export const COMPLETED_REQUEST_RETENTION_MS = 900_000;

export function buildStatusRunStartInput(
  requestId: string,
  statusPath: string,
  metadata: StatusMetadata,
  taskKind: TaskKind | null,
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null,
  nowMs: number,
) {
  return {
    requestId,
    statusPath,
    taskKind,
    nowMs,
    rawInputCharacterCount: metadata.rawInputCharacterCount,
    promptCharacterCount: metadata.promptCharacterCount,
    promptTokenCount: metadata.promptTokenCount,
    chunkIndex: metadata.chunkIndex,
    chunkTotal: metadata.chunkTotal,
    chunkPath: metadata.chunkPath,
    managedLlamaSpeculativeSnapshot,
  };
}

export type StatusRunStartInput = ReturnType<typeof buildStatusRunStartInput>;

export type CompletedStatusTerminalState = Exclude<StatusMetadata['terminalState'], null>;

function createActiveRunState(input: StatusRunStartInput) {
  return {
    requestId: input.requestId,
    statusPath: input.statusPath,
    taskKind: input.taskKind,
    overallStartedAt: input.nowMs,
    currentRequestStartedAt: input.nowMs,
    stepCount: 1,
    rawInputCharacterCount: input.rawInputCharacterCount,
    promptCharacterCount: input.promptCharacterCount,
    promptTokenCount: input.promptTokenCount,
    outputTokensTotal: 0,
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal,
    chunkPath: input.chunkPath,
    managedLlamaSpeculativeSnapshot: input.managedLlamaSpeculativeSnapshot,
  };
}

function createTerminalRunState(run: ActiveRunState | null, terminalState: CompletedStatusTerminalState, completedAtMs: number) {
  return { run, terminalState, completedAtMs };
}

function createStartedResult(run: ActiveRunState) { return { kind: 'started' as const, run }; }
function createAdvancedResult(run: ActiveRunState) { return { kind: 'advanced' as const, run }; }
function createLateResult(requestId: string) { return { kind: 'late' as const, requestId }; }
function createCompletedResult(run: TerminalRunState) { return { kind: 'completed' as const, run }; }
function createCompletedWithoutRunResult(run: TerminalRunState) {
  return { kind: 'completed-without-run' as const, run };
}
function createDuplicateResult(requestId: string) { return { kind: 'duplicate' as const, requestId }; }
function createUnknownResult(requestId: string) { return { kind: 'unknown' as const, requestId }; }
function createActiveTerminalResolution(run: ActiveRunState) { return { kind: 'active' as const, run }; }
function createAwaitingTerminalResolution(run: TerminalRunState) { return { kind: 'awaiting' as const, run }; }
function createFinalizedResult(requestId: string) { return { kind: 'finalized' as const, requestId }; }
function createExpiredStatusRun(requestId: string, phase: 'awaiting-terminal-metadata' | 'completed') {
  return { requestId, phase };
}

type ActiveRunState = ReturnType<typeof createActiveRunState>;
type TerminalRunState = ReturnType<typeof createTerminalRunState>;
export type StatusRunStartResult =
  | ReturnType<typeof createStartedResult>
  | ReturnType<typeof createAdvancedResult>
  | ReturnType<typeof createLateResult>;
export type StatusRunCompleteResult =
  | ReturnType<typeof createCompletedResult>
  | ReturnType<typeof createCompletedWithoutRunResult>
  | ReturnType<typeof createDuplicateResult>;
export type StatusTerminalResolution =
  | ReturnType<typeof createActiveTerminalResolution>
  | ReturnType<typeof createAwaitingTerminalResolution>
  | ReturnType<typeof createDuplicateResult>
  | ReturnType<typeof createUnknownResult>;
export type StatusTerminalFinalizeResult =
  | ReturnType<typeof createFinalizedResult>
  | ReturnType<typeof createDuplicateResult>
  | ReturnType<typeof createUnknownResult>;
export type ExpiredStatusRun = ReturnType<typeof createExpiredStatusRun>;

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function toActiveStatusRun(run: ActiveRunState): ActiveStatusRun {
  return {
    requestId: run.requestId,
    statusPath: run.statusPath,
    taskKind: run.taskKind,
    startedAtUtc: formatTimestamp(run.overallStartedAt),
    currentStepStartedAtUtc: formatTimestamp(run.currentRequestStartedAt),
    stepCount: run.stepCount,
    chunkIndex: run.chunkIndex,
    chunkTotal: run.chunkTotal,
  };
}

export class StatusRunRegistry {
  private readonly activeRuns = new Map<string, ActiveRunState>();
  private readonly awaitingTerminalMetadata = new Map<string, TerminalRunState>();
  private readonly completedAtByRequestId = new Map<string, number>();

  startOrAdvance(input: StatusRunStartInput): StatusRunStartResult {
    if (this.completedAtByRequestId.has(input.requestId)) {
      return createLateResult(input.requestId);
    }
    const existing = this.activeRuns.get(input.requestId) ?? null;
    if (existing) {
      existing.stepCount += 1;
      existing.currentRequestStartedAt = input.nowMs;
      existing.rawInputCharacterCount = input.rawInputCharacterCount;
      existing.promptCharacterCount = input.promptCharacterCount;
      existing.promptTokenCount = input.promptTokenCount;
      existing.chunkIndex = input.chunkIndex;
      existing.chunkTotal = input.chunkTotal;
      existing.chunkPath = input.chunkPath;
      existing.managedLlamaSpeculativeSnapshot = input.managedLlamaSpeculativeSnapshot;
      return createAdvancedResult(existing);
    }
    const run = createActiveRunState(input);
    this.activeRuns.set(input.requestId, run);
    return createStartedResult(run);
  }

  markComplete(requestId: string, terminalState: CompletedStatusTerminalState, nowMs: number): StatusRunCompleteResult {
    if (this.completedAtByRequestId.has(requestId)) {
      return createDuplicateResult(requestId);
    }
    const run = this.activeRuns.get(requestId) ?? null;
    this.activeRuns.delete(requestId);
    const terminalRun = createTerminalRunState(run, terminalState, nowMs);
    this.awaitingTerminalMetadata.set(requestId, terminalRun);
    this.completedAtByRequestId.set(requestId, nowMs);
    if (run === null) {
      return createCompletedWithoutRunResult(terminalRun);
    }
    return createCompletedResult(terminalRun);
  }

  resolveTerminalRun(requestId: string, nowMs: number): StatusTerminalResolution {
    if (this.completedAtByRequestId.has(requestId) && !this.awaitingTerminalMetadata.has(requestId)) {
      return createDuplicateResult(requestId);
    }
    const awaiting = this.awaitingTerminalMetadata.get(requestId) ?? null;
    if (awaiting !== null) {
      return createAwaitingTerminalResolution(awaiting);
    }
    const active = this.activeRuns.get(requestId) ?? null;
    if (active !== null) {
      return createActiveTerminalResolution(active);
    }
    return createUnknownResult(requestId);
  }

  finalizeTerminal(requestId: string, nowMs: number): StatusTerminalFinalizeResult {
    if (this.completedAtByRequestId.has(requestId) && !this.awaitingTerminalMetadata.has(requestId)) {
      return createDuplicateResult(requestId);
    }
    const awaiting = this.awaitingTerminalMetadata.get(requestId) ?? null;
    if (awaiting !== null) {
      this.awaitingTerminalMetadata.delete(requestId);
      return createFinalizedResult(requestId);
    }
    const active = this.activeRuns.get(requestId) ?? null;
    if (active !== null) {
      this.activeRuns.delete(requestId);
      this.completedAtByRequestId.set(requestId, nowMs);
      return createFinalizedResult(requestId);
    }
    return createUnknownResult(requestId);
  }

  getActiveRuns(nowMs: number): ActiveStatusRun[] {
    this.pruneExpired(nowMs);
    const runs: ActiveRunState[] = [];
    for (const run of this.activeRuns.values()) {
      runs.push(run);
    }
    runs.sort((a, b) => {
      const timeDiff = a.overallStartedAt - b.overallStartedAt;
      if (timeDiff !== 0) return timeDiff;
      return a.requestId.localeCompare(b.requestId);
    });
    return runs.map(toActiveStatusRun);
  }

  hasActiveRuns(nowMs: number): boolean {
    this.pruneExpired(nowMs);
    return this.activeRuns.size > 0;
  }

  pruneExpired(nowMs: number): ExpiredStatusRun[] {
    const expired: ExpiredStatusRun[] = [];
    for (const [requestId, terminalRun] of this.awaitingTerminalMetadata) {
      if (nowMs - terminalRun.completedAtMs >= TERMINAL_SNAPSHOT_RETENTION_MS) {
        this.awaitingTerminalMetadata.delete(requestId);
        expired.push(createExpiredStatusRun(requestId, 'awaiting-terminal-metadata'));
      }
    }
    for (const [requestId, completedAt] of this.completedAtByRequestId) {
      if (!this.awaitingTerminalMetadata.has(requestId) && nowMs - completedAt >= COMPLETED_REQUEST_RETENTION_MS) {
        this.completedAtByRequestId.delete(requestId);
        expired.push(createExpiredStatusRun(requestId, 'completed'));
      }
    }
    return expired;
  }
  /* c8 ignore next */
}
