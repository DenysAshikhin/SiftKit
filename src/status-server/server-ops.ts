/**
 * Shared server-operational helpers: GPU lock, run state tracking, idle
 * summary scheduling, execution lease, and model-request serialisation.
 *
 * Every function takes a `ServerContext` as its first argument so the mutable
 * state lives in one place (created by `startStatusServer` in index.ts).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { getRuntimeRoot } from './paths.js';
import {
  STATUS_TRUE,
  STATUS_FALSE,
  STATUS_LOCK_REQUESTED,
  STATUS_FOREIGN_LOCK,
  readStatusText,
} from './status-file.js';
import { writeText, ensureDirectory, saveContentAtomically } from '../lib/fs.js';
import { sleep } from '../lib/time.js';
import { normalizeMetrics, writeMetrics } from './metrics.js';
import {
  buildIdleSummarySnapshot,
  buildIdleSummarySnapshotMessage,
  ensureIdleSummarySnapshotsTable,
  persistIdleSummarySnapshot,
  queryRecentSnapshots,
} from './idle-summary.js';
import {
  type StatusMetadata,
} from './status-file.js';
import {
  buildStatusRequestLogMessage,
} from './dashboard-runs.js';
import type {
  ActiveRunState,
  DatabaseInstance,
  ExecutionLease,
  ModelRequestLock,
  ServerContext,
} from './server-types.js';
import {
  EXECUTION_LEASE_STALE_MS,
  IDLE_SUMMARY_DELAY_MS,
  GPU_LOCK_POLL_DELAY_MS,
  logLine,
} from './managed-llama.js';

// ---------------------------------------------------------------------------
// GPU lock
// ---------------------------------------------------------------------------

export function hasSiftKitGpuDemand(ctx: ServerContext): boolean {
  return ctx.bootstrapManagedLlamaStartup
    || ctx.managedLlamaStarting
    || ctx.managedLlamaReady
    || hasActiveRuns(ctx)
    || ctx.idleSummaryPending
    || Boolean(ctx.gpuLockAcquisitionPromise);
}

export function getPublishedStatusText(ctx: ServerContext): string {
  if (ctx.siftKitWaitingForGpuLock) {
    return STATUS_LOCK_REQUESTED;
  }
  if (ctx.siftKitOwnsGpuLock) {
    return STATUS_TRUE;
  }
  const sharedStatus = readStatusText(ctx.statusPath);
  return sharedStatus === STATUS_FOREIGN_LOCK ? STATUS_FOREIGN_LOCK : STATUS_FALSE;
}

export function writePublishedStatus(ctx: ServerContext, publishedStatus: string = getPublishedStatusText(ctx)): void {
  writeText(ctx.statusPath, ctx.disableManagedLlamaStartup ? STATUS_TRUE : publishedStatus);
}

export function publishStatus(ctx: ServerContext): void {
  writePublishedStatus(ctx);
}

export function releaseSiftKitGpuLockIfIdle(ctx: ServerContext): void {
  if (hasSiftKitGpuDemand(ctx)) {
    return;
  }
  ctx.siftKitWaitingForGpuLock = false;
  ctx.siftKitOwnsGpuLock = false;
  publishStatus(ctx);
}

export async function ensureSiftKitGpuLockAcquired(ctx: ServerContext): Promise<void> {
  if (ctx.siftKitOwnsGpuLock) {
    return;
  }
  if (ctx.gpuLockAcquisitionPromise) {
    await ctx.gpuLockAcquisitionPromise;
    return;
  }
  ctx.gpuLockAcquisitionPromise = (async () => {
    while (true) {
      const sharedStatus = readStatusText(ctx.statusPath);
      if (sharedStatus === STATUS_FALSE || sharedStatus === STATUS_TRUE) {
        ctx.siftKitWaitingForGpuLock = false;
        ctx.siftKitOwnsGpuLock = true;
        publishStatus(ctx);
        return;
      }
      ctx.siftKitWaitingForGpuLock = true;
      ctx.siftKitOwnsGpuLock = false;
      publishStatus(ctx);
      await sleep(GPU_LOCK_POLL_DELAY_MS);
    }
  })().finally(() => {
    ctx.gpuLockAcquisitionPromise = null;
  });
  await ctx.gpuLockAcquisitionPromise;
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export function hasActiveRuns(ctx: ServerContext): boolean {
  return ctx.activeRequestIdByStatusPath.has(ctx.statusPath);
}

export function getResolvedRequestId(metadata: StatusMetadata, currentStatusPath: string): string {
  if (metadata.requestId) {
    return metadata.requestId;
  }
  return `legacy:${currentStatusPath}`;
}

export function clearRunState(ctx: ServerContext, requestId: string | null): ActiveRunState | null {
  if (!requestId) return null;
  const runState = ctx.activeRunsByRequestId.get(requestId);
  if (!runState) {
    return null;
  }
  ctx.activeRunsByRequestId.delete(requestId);
  if (ctx.activeRequestIdByStatusPath.get(runState.statusPath) === requestId) {
    ctx.activeRequestIdByStatusPath.delete(runState.statusPath);
  }
  return runState;
}

export function logAbandonedRun(ctx: ServerContext, runState: ActiveRunState, now: number): void {
  logLine(buildStatusRequestLogMessage({
    running: false,
    requestId: runState.requestId,
    terminalState: 'failed',
    errorMessage: 'Abandoned because a new request started before terminal status.',
    rawInputCharacterCount: runState.rawInputCharacterCount,
    promptCharacterCount: runState.promptCharacterCount,
    promptTokenCount: runState.promptTokenCount,
    chunkIndex: runState.chunkIndex,
    chunkTotal: runState.chunkTotal,
    chunkPath: runState.chunkPath,
    totalElapsedMs: now - runState.overallStartedAt,
  }));
  const logsPath = path.join(getRuntimeRoot(), 'logs');
  const abandonedPath = path.join(logsPath, 'abandoned', `request_abandoned_${runState.requestId}.json`);
  try {
    saveContentAtomically(abandonedPath, JSON.stringify({
      requestId: runState.requestId,
      reason: 'Abandoned because a new request started before terminal status.',
      abandonedAtUtc: new Date(now).toISOString(),
      totalElapsedMs: now - runState.overallStartedAt,
      stepCount: runState.stepCount,
      rawInputCharacterCount: runState.rawInputCharacterCount,
      promptCharacterCount: runState.promptCharacterCount,
      promptTokenCount: runState.promptTokenCount,
      outputTokensTotal: runState.outputTokensTotal,
      chunkIndex: runState.chunkIndex,
      chunkTotal: runState.chunkTotal,
      chunkPath: runState.chunkPath,
    }, null, 2) + '\n');
  } catch {
    // Best-effort — don't fail the incoming request.
  }
}

// ---------------------------------------------------------------------------
// Idle summary scheduling
// ---------------------------------------------------------------------------

export function isIdle(ctx: ServerContext): boolean {
  return !hasActiveRuns(ctx) && !getActiveExecutionLease(ctx);
}

export function clearIdleSummaryTimer(ctx: ServerContext): void {
  if (ctx.idleSummaryTimer) {
    clearTimeout(ctx.idleSummaryTimer);
    ctx.idleSummaryTimer = null;
  }
}

export function resetPendingIdleSummaryMetadata(ctx: ServerContext): void {
  ctx.pendingIdleSummaryMetadata = {
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
  };
}

export function getIdleSummaryDatabase(ctx: ServerContext): DatabaseInstance {
  if (ctx.idleSummaryDatabase) {
    return ctx.idleSummaryDatabase;
  }
  ensureDirectory(path.dirname(ctx.idleSummarySnapshotsPath));
  ctx.idleSummaryDatabase = new Database(ctx.idleSummarySnapshotsPath);
  ensureIdleSummarySnapshotsTable(ctx.idleSummaryDatabase);
  return ctx.idleSummaryDatabase;
}

export function scheduleIdleSummaryIfNeeded(ctx: ServerContext): void {
  if (!ctx.idleSummaryPending || !isIdle(ctx)) {
    clearIdleSummaryTimer(ctx);
    return;
  }
  clearIdleSummaryTimer(ctx);
  ctx.idleSummaryTimer = setTimeout(async () => {
    ctx.idleSummaryTimer = null;
    if (!ctx.idleSummaryPending || !isIdle(ctx)) {
      return;
    }
    const emittedAt = new Date();
    const snapshot = buildIdleSummarySnapshot({
      ...ctx.metrics,
      ...ctx.pendingIdleSummaryMetadata,
    }, emittedAt);
    try {
      persistIdleSummarySnapshot(getIdleSummaryDatabase(ctx), snapshot);
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Failed to persist idle summary snapshot to ${ctx.idleSummarySnapshotsPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    logLine(buildIdleSummarySnapshotMessage(snapshot), emittedAt);
    ctx.idleSummaryPending = false;
    resetPendingIdleSummaryMetadata(ctx);
    releaseSiftKitGpuLockIfIdle(ctx);
    await ctx.shutdownManagedLlamaIfNeeded();
  }, IDLE_SUMMARY_DELAY_MS);
  if (typeof ctx.idleSummaryTimer.unref === 'function') {
    ctx.idleSummaryTimer.unref();
  }
}

// ---------------------------------------------------------------------------
// Execution lease
// ---------------------------------------------------------------------------

export function getActiveExecutionLease(ctx: ServerContext): ExecutionLease | null {
  if (!ctx.activeExecutionLease) {
    return null;
  }
  if ((Date.now() - ctx.activeExecutionLease.heartbeatAt) >= EXECUTION_LEASE_STALE_MS) {
    ctx.activeExecutionLease = null;
    return null;
  }
  return ctx.activeExecutionLease;
}

export function releaseExecutionLease(ctx: ServerContext, token: string): boolean {
  const lease = getActiveExecutionLease(ctx);
  if (!lease || lease.token !== token) {
    return false;
  }
  ctx.activeExecutionLease = null;
  scheduleIdleSummaryIfNeeded(ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Model request serialisation
// ---------------------------------------------------------------------------

export function acquireModelRequest(ctx: ServerContext, kind: string): ModelRequestLock | null {
  if (ctx.activeModelRequest) {
    return null;
  }
  const lock: ModelRequestLock = {
    token: crypto.randomUUID(),
    kind: String(kind),
    startedAtUtc: new Date().toISOString(),
  };
  ctx.activeModelRequest = lock;
  return lock;
}

export async function acquireModelRequestWithWait(ctx: ServerContext, kind: string): Promise<ModelRequestLock> {
  let lock = acquireModelRequest(ctx, kind);
  while (!lock) {
    await sleep(25);
    lock = acquireModelRequest(ctx, kind);
  }
  return lock;
}

export function releaseModelRequest(ctx: ServerContext, token: string): boolean {
  if (!ctx.activeModelRequest || ctx.activeModelRequest.token !== token) {
    return false;
  }
  ctx.activeModelRequest = null;
  return true;
}

export async function ensureManagedLlamaReadyForModelRequest(ctx: ServerContext): Promise<void> {
  if (ctx.disableManagedLlamaStartup) {
    return;
  }
  await ctx.ensureManagedLlamaReady();
}
