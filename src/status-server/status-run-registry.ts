import type { ActiveStatusRun } from '@siftkit/contracts';
import type { ManagedLlamaSpeculativeMetricsSnapshot } from './managed-llama.js';
import type { TaskKind } from './metrics.js';
import type { StatusMetadata } from './status-file.js';

export const TERMINAL_SNAPSHOT_RETENTION_MS = 300_000;
export const COMPLETED_REQUEST_RETENTION_MS = 900_000;

export type CompletedStatusTerminalState = Exclude<StatusMetadata['terminalState'], null>;

export type StatusRunStartInput = {
  requestId: string;
  statusPath: string;
  taskKind: TaskKind | null;
  nowMs: number;
  rawInputCharacterCount: number | null;
  promptCharacterCount: number | null;
  promptTokenCount: number | null;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
};

export type ActiveRunState = {
  requestId: string;
  statusPath: string;
  taskKind: TaskKind | null;
  overallStartedAt: number;
  currentRequestStartedAt: number;
  stepCount: number;
  rawInputCharacterCount: number | null;
  promptCharacterCount: number | null;
  promptTokenCount: number | null;
  outputTokensTotal: number;
  chunkIndex: number | null;
  chunkTotal: number | null;
  chunkPath: string | null;
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null;
};

export type TerminalRunState = {
  run: ActiveRunState | null;
  terminalState: CompletedStatusTerminalState;
  completedAtMs: number;
};

export type StatusRunStartResult =
  | { kind: 'started'; run: ActiveRunState }
  | { kind: 'advanced'; run: ActiveRunState }
  | { kind: 'late'; requestId: string };

export type StatusRunCompleteResult =
  | { kind: 'completed'; run: TerminalRunState }
  | { kind: 'completed-without-run'; run: TerminalRunState }
  | { kind: 'duplicate'; requestId: string };

export type StatusTerminalResolution =
  | { kind: 'active'; run: ActiveRunState }
  | { kind: 'awaiting'; run: TerminalRunState }
  | { kind: 'duplicate'; requestId: string }
  | { kind: 'unknown'; requestId: string };

export type StatusTerminalFinalizeResult =
  | { kind: 'finalized'; requestId: string }
  | { kind: 'duplicate'; requestId: string }
  | { kind: 'unknown'; requestId: string };

export type ExpiredStatusRun = {
  requestId: string;
  phase: 'awaiting-terminal-metadata' | 'completed';
};

export function buildStatusRunStartInput(
  requestId: string,
  statusPath: string,
  metadata: StatusMetadata,
  taskKind: TaskKind | null,
  managedLlamaSpeculativeSnapshot: ManagedLlamaSpeculativeMetricsSnapshot | null,
  nowMs: number,
): StatusRunStartInput {
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

function createActiveRunState(input: StatusRunStartInput): ActiveRunState {
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
      return { kind: 'late', requestId: input.requestId };
    }
    const existing = this.activeRuns.get(input.requestId) ?? null;
    if (existing) {
      existing.stepCount += 1;
      existing.currentRequestStartedAt = input.nowMs;
      if (existing.rawInputCharacterCount === null && input.rawInputCharacterCount !== null) {
        existing.rawInputCharacterCount = input.rawInputCharacterCount;
      }
      if (input.promptCharacterCount !== null) existing.promptCharacterCount = input.promptCharacterCount;
      if (input.promptTokenCount !== null) existing.promptTokenCount = input.promptTokenCount;
      if (input.chunkIndex !== null) existing.chunkIndex = input.chunkIndex;
      if (input.chunkTotal !== null) existing.chunkTotal = input.chunkTotal;
      if (input.chunkPath !== null) existing.chunkPath = input.chunkPath;
      if (input.managedLlamaSpeculativeSnapshot !== null) {
        existing.managedLlamaSpeculativeSnapshot = input.managedLlamaSpeculativeSnapshot;
      }
      return { kind: 'advanced', run: existing };
    }
    const run = createActiveRunState(input);
    this.activeRuns.set(input.requestId, run);
    return { kind: 'started', run };
  }

  markComplete(requestId: string, terminalState: CompletedStatusTerminalState, nowMs: number): StatusRunCompleteResult {
    if (this.completedAtByRequestId.has(requestId)) {
      return { kind: 'duplicate', requestId };
    }
    const run = this.activeRuns.get(requestId) ?? null;
    this.activeRuns.delete(requestId);
    const terminalRun = { run, terminalState, completedAtMs: nowMs };
    this.awaitingTerminalMetadata.set(requestId, terminalRun);
    this.completedAtByRequestId.set(requestId, nowMs);
    if (run === null) {
      return { kind: 'completed-without-run', run: terminalRun };
    }
    return { kind: 'completed', run: terminalRun };
  }

  resolveTerminalRun(requestId: string): StatusTerminalResolution {
    if (this.completedAtByRequestId.has(requestId) && !this.awaitingTerminalMetadata.has(requestId)) {
      return { kind: 'duplicate', requestId };
    }
    const awaiting = this.awaitingTerminalMetadata.get(requestId) ?? null;
    if (awaiting !== null) {
      return { kind: 'awaiting', run: awaiting };
    }
    const active = this.activeRuns.get(requestId) ?? null;
    if (active !== null) {
      return { kind: 'active', run: active };
    }
    return { kind: 'unknown', requestId };
  }

  finalizeTerminal(requestId: string, nowMs: number): StatusTerminalFinalizeResult {
    if (this.completedAtByRequestId.has(requestId) && !this.awaitingTerminalMetadata.has(requestId)) {
      return { kind: 'duplicate', requestId };
    }
    const awaiting = this.awaitingTerminalMetadata.get(requestId) ?? null;
    if (awaiting !== null) {
      this.awaitingTerminalMetadata.delete(requestId);
      return { kind: 'finalized', requestId };
    }
    const active = this.activeRuns.get(requestId) ?? null;
    if (active !== null) {
      this.activeRuns.delete(requestId);
      this.completedAtByRequestId.set(requestId, nowMs);
      return { kind: 'finalized', requestId };
    }
    return { kind: 'unknown', requestId };
  }

  getActiveRuns(nowMs: number): ActiveStatusRun[] {
    this.pruneExpired(nowMs);
    const runs = [...this.activeRuns.values()];
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
        expired.push({ requestId, phase: 'awaiting-terminal-metadata' });
      }
    }
    for (const [requestId, completedAt] of this.completedAtByRequestId) {
      if (!this.awaitingTerminalMetadata.has(requestId) && nowMs - completedAt >= COMPLETED_REQUEST_RETENTION_MS) {
        this.completedAtByRequestId.delete(requestId);
        expired.push({ requestId, phase: 'completed' });
      }
    }
    return expired;
  }
}
