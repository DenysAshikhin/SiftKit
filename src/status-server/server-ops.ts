/**
 * Shared server-operational helpers: published status, run state tracking, idle
 * summary scheduling, execution lease, and model-request serialisation.
 *
 * Every function takes a `ServerContext` as its first argument so the mutable
 * state lives in one place (created by `startStatusServer` in index.ts).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import Database from 'better-sqlite3';
import { getRuntimeRoot } from './paths.js';
import {
  STATUS_TRUE,
  STATUS_FALSE,
  writeStatusText,
} from './status-file.js';
import { ensureDirectory } from '../lib/fs.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
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
  ensureRunLogsTable,
  getStatusArtifactPath,
  upsertRunArtifactPayload,
} from './dashboard-runs.js';
import type {
  ActiveRunState,
  DatabaseInstance,
  DeferredArtifact,
  ExecutionLease,
  ModelRequestLock,
  ModelRequestWaiter,
  ServerContext,
} from './server-types.js';
import {
  EXECUTION_LEASE_STALE_MS,
  IDLE_SUMMARY_DELAY_MS,
  logLine,
} from './managed-llama.js';

// ---------------------------------------------------------------------------
// Published status
// ---------------------------------------------------------------------------

export function hasPublishedActivity(ctx: ServerContext): boolean {
  return ctx.bootstrapManagedLlamaStartup
    || ctx.managedLlamaStarting
    || Boolean(ctx.activeModelRequest)
    || ctx.modelRequestQueue.some((request) => !request.cancelled)
    || hasActiveRuns(ctx);
}

export function getPublishedStatusText(ctx: ServerContext): string {
  return hasPublishedActivity(ctx) ? STATUS_TRUE : STATUS_FALSE;
}

export function writePublishedStatus(ctx: ServerContext, publishedStatus: string = getPublishedStatusText(ctx)): void {
  writeStatusText(ctx.statusPath, publishedStatus);
}

export function publishStatus(ctx: ServerContext): void {
  writePublishedStatus(ctx);
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
  const payload = {
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
  };
  try {
    upsertRuntimeJsonArtifact({
      id: `status:request_abandoned:${runState.requestId}`,
      artifactKind: 'status_request_abandoned',
      requestId: runState.requestId,
      payload,
    });
    upsertRunArtifactPayload({
      database: getIdleSummaryDatabase(ctx),
      requestId: runState.requestId,
      artifactType: 'request_abandoned',
      artifactPayload: payload,
    });
  } catch {
    // Best-effort - don't fail the incoming request.
  }
}

function persistDeferredArtifact(ctx: ServerContext, artifact: DeferredArtifact): void {
  const artifactPath = getStatusArtifactPath({
    requestId: artifact.artifactRequestId,
    taskKind: null,
    terminalState: null,
    errorMessage: null,
    promptCharacterCount: null,
    promptTokenCount: null,
    rawInputCharacterCount: null,
    chunkInputCharacterCount: null,
    budgetSource: null,
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
    chunkIndex: null,
    chunkTotal: null,
    chunkPath: null,
    inputTokens: null,
    outputCharacterCount: null,
    outputTokens: null,
    toolTokens: null,
    thinkingTokens: null,
    toolStats: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
    requestDurationMs: null,
    providerDurationMs: null,
    wallDurationMs: null,
    stdinWaitMs: null,
    serverPreflightMs: null,
    lockWaitMs: null,
    statusRunningMs: null,
    terminalStatusMs: null,
    artifactType: artifact.artifactType,
    artifactRequestId: artifact.artifactRequestId,
    artifactPayload: artifact.artifactPayload,
    deferredMetadata: null,
    deferredArtifacts: null,
  });
  if (!artifactPath) {
    throw new Error(`Unsupported deferred artifact type: ${artifact.artifactType}`);
  }
  upsertRuntimeJsonArtifact({
    id: `status:${artifact.artifactType}:${artifact.artifactRequestId}`,
    artifactKind: `status_${artifact.artifactType}`,
    requestId: artifact.artifactRequestId,
    title: artifactPath,
    payload: artifact.artifactPayload,
  });
  upsertRunArtifactPayload({
    database: getIdleSummaryDatabase(ctx),
    requestId: artifact.artifactRequestId,
    artifactType: artifact.artifactType,
    artifactPayload: artifact.artifactPayload,
  });
}

function scheduleDeferredArtifactDrain(ctx: ServerContext): void {
  if (ctx.deferredArtifactDrainScheduled || ctx.deferredArtifactDrainRunning || ctx.deferredArtifactQueue.length === 0) {
    return;
  }
  ctx.deferredArtifactDrainScheduled = true;
  const timer = setTimeout(() => {
    void drainDeferredArtifacts(ctx);
  }, 25);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

async function drainDeferredArtifacts(ctx: ServerContext): Promise<void> {
  if (ctx.deferredArtifactDrainRunning) {
    return;
  }
  ctx.deferredArtifactDrainScheduled = false;
  ctx.deferredArtifactDrainRunning = true;
  try {
    while (ctx.deferredArtifactQueue.length > 0) {
      const artifact = ctx.deferredArtifactQueue.shift();
      if (!artifact) {
        continue;
      }
      try {
        persistDeferredArtifact(ctx, artifact);
      } catch (error) {
        process.stderr.write(
          `[siftKitStatus] Failed to persist deferred artifact type=${artifact.artifactType} `
          + `request_id=${artifact.artifactRequestId}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  } finally {
    ctx.deferredArtifactDrainRunning = false;
    if (ctx.deferredArtifactQueue.length > 0) {
      scheduleDeferredArtifactDrain(ctx);
    }
  }
}

export function enqueueDeferredArtifacts(ctx: ServerContext, artifacts: DeferredArtifact[]): void {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return;
  }
  ctx.deferredArtifactQueue.push(...artifacts);
  scheduleDeferredArtifactDrain(ctx);
}

// ---------------------------------------------------------------------------
// Idle summary scheduling
// ---------------------------------------------------------------------------

export function isIdle(ctx: ServerContext): boolean {
  return !hasActiveRuns(ctx)
    && !getActiveExecutionLease(ctx)
    && !ctx.activeModelRequest
    && ctx.modelRequestQueue.length === 0;
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
  ensureRunLogsTable(ctx.idleSummaryDatabase);
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
    publishStatus(ctx);
    if (!isIdle(ctx)) {
      logLine('idle_summary shutdown_aborted reason=request_arrived_during_snapshot');
      scheduleIdleSummaryIfNeeded(ctx);
      return;
    }
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

function getIncomingModelRequestQueuePosition(ctx: ServerContext): number {
  const activePosition = ctx.activeModelRequest ? 1 : 0;
  return activePosition + ctx.modelRequestQueue.length + 1;
}

function logIncomingModelRequest(ctx: ServerContext, kind: string): void {
  const taskKind = String(kind).trim() || 'unknown';
  logLine(`request incoming task=${taskKind} queue_position=${getIncomingModelRequestQueuePosition(ctx)}`);
}

function getElapsedMsSinceIso(isoTimestamp: string): number {
  const startedAtMs = Date.parse(isoTimestamp);
  return Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
}

function logModelRequestLockAcquired(lock: ModelRequestLock, waitMs: number): void {
  logLine(`request lock_acquired task=${lock.kind} wait_ms=${Math.max(0, Math.trunc(waitMs))} token=${lock.token}`);
}

function logModelRequestLockReleased(lock: ModelRequestLock, queueLength: number): void {
  logLine(
    `request lock_released task=${lock.kind} held_ms=${getElapsedMsSinceIso(lock.startedAtUtc)} `
    + `queue_remaining=${Math.max(0, queueLength)} token=${lock.token}`,
  );
}

function logModelRequestWaitCancelled(waiter: ModelRequestWaiter): void {
  logLine(
    `request lock_cancelled task=${waiter.kind} wait_ms=${getElapsedMsSinceIso(waiter.enqueuedAtUtc)} `
    + `token=${waiter.queueToken}`,
  );
}

function syncManagedLlamaFlushQueueModelState(ctx: ServerContext, lastFinishedAtMs?: number): void {
  ctx.managedLlamaFlushQueue.setModelRequestState({
    active: Boolean(ctx.activeModelRequest),
    queueLength: ctx.modelRequestQueue.length,
    lastFinishedAtMs: lastFinishedAtMs ?? ctx.terminalMetadataLastModelRequestFinishedAtMs,
  });
}

export function wakeManagedLlamaForIncomingModelRequest(ctx: ServerContext): void {
  if (ctx.disableManagedLlamaStartup) {
    return;
  }
  void ctx.ensureManagedLlamaReady({ allowUnconfigured: true }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.managedLlamaStartupWarning = message;
    publishStatus(ctx);
    process.stderr.write(`[siftKitStatus] Failed to wake llama.cpp for incoming request: ${message}\n`);
  });
}

export function acquireModelRequest(ctx: ServerContext, kind: string): ModelRequestLock | null {
  if (ctx.activeModelRequest || ctx.modelRequestQueue.length > 0) {
    return null;
  }
  const lock = createModelRequestLock(kind);
  ctx.activeModelRequest = lock;
  syncManagedLlamaFlushQueueModelState(ctx);
  return lock;
}

function createModelRequestLock(kind: string): ModelRequestLock {
  return {
    token: crypto.randomUUID(),
    kind: String(kind),
    startedAtUtc: new Date().toISOString(),
  };
}

function removeModelRequestWaiter(ctx: ServerContext, queueToken: string): boolean {
  const index = ctx.modelRequestQueue.findIndex((entry) => entry.queueToken === queueToken);
  if (index < 0) {
    return false;
  }
  ctx.modelRequestQueue.splice(index, 1);
  return true;
}

function grantNextModelRequest(ctx: ServerContext): boolean {
  if (ctx.activeModelRequest) {
    return false;
  }
  while (ctx.modelRequestQueue.length > 0) {
    const waiter = ctx.modelRequestQueue.shift();
    if (!waiter || waiter.cancelled) {
      continue;
    }
    const lock = createModelRequestLock(waiter.kind);
    waiter.grantedLock = lock;
    ctx.activeModelRequest = lock;
    logModelRequestLockAcquired(lock, getElapsedMsSinceIso(waiter.enqueuedAtUtc));
    syncManagedLlamaFlushQueueModelState(ctx);
    waiter.resolveLock(lock);
    return true;
  }
  syncManagedLlamaFlushQueueModelState(ctx);
  return false;
}

export async function acquireModelRequestWithWait(
  ctx: ServerContext,
  kind: string,
  request?: http.IncomingMessage,
  response?: http.ServerResponse,
): Promise<ModelRequestLock | null> {
  logIncomingModelRequest(ctx, kind);
  clearIdleSummaryTimer(ctx);
  let lock = acquireModelRequest(ctx, kind);
  if (lock) {
    logModelRequestLockAcquired(lock, 0);
    return lock;
  }
  let resolveWaiterLock: (resolvedLock: ModelRequestLock | null) => void = () => {};
  const waiterLockPromise = new Promise<ModelRequestLock | null>((resolve) => {
    resolveWaiterLock = resolve;
  });
  const waiter: ModelRequestWaiter = {
    queueToken: crypto.randomUUID(),
    kind: String(kind),
    enqueuedAtUtc: new Date().toISOString(),
    cancelled: false,
    grantedLock: null,
    resolveLock: resolveWaiterLock,
  };
  ctx.modelRequestQueue.push(waiter);
  syncManagedLlamaFlushQueueModelState(ctx);
  const cancelWaiter = (): void => {
    if (waiter.grantedLock) {
      return;
    }
    waiter.cancelled = true;
    removeModelRequestWaiter(ctx, waiter.queueToken);
    logModelRequestWaitCancelled(waiter);
    waiter.resolveLock(null);
    grantNextModelRequest(ctx);
    syncManagedLlamaFlushQueueModelState(ctx);
    scheduleIdleSummaryIfNeeded(ctx);
  };
  const onAbortedRequest = (): void => {
    cancelWaiter();
  };
  const onClosedRequest = (): void => {
    if (request?.complete) {
      return;
    }
    cancelWaiter();
  };
  const onClosedResponse = (): void => {
    if (response?.writableEnded) {
      return;
    }
    cancelWaiter();
  };
  if (request) {
    request.once('aborted', onAbortedRequest);
    request.once('close', onClosedRequest);
  }
  if (response) {
    response.once('close', onClosedResponse);
  }
  if (response?.destroyed && !response.writableEnded) {
    cancelWaiter();
  }
  try {
    return await waiterLockPromise;
  } finally {
    if (response?.destroyed && !response.writableEnded) {
      cancelWaiter();
    }
    if (request) {
      request.off('aborted', onAbortedRequest);
      request.off('close', onClosedRequest);
    }
    if (response) {
      response.off('close', onClosedResponse);
    }
  }
}

export function releaseModelRequest(ctx: ServerContext, token: string): boolean {
  if (!ctx.activeModelRequest || ctx.activeModelRequest.token !== token) {
    return false;
  }
  const releasedLock = ctx.activeModelRequest;
  ctx.activeModelRequest = null;
  const finishedAtMs = Date.now();
  ctx.terminalMetadataLastModelRequestFinishedAtMs = finishedAtMs;
  syncManagedLlamaFlushQueueModelState(ctx, finishedAtMs);
  logModelRequestLockReleased(releasedLock, ctx.modelRequestQueue.length);
  grantNextModelRequest(ctx);
  syncManagedLlamaFlushQueueModelState(ctx, finishedAtMs);
  if (ctx.managedLlamaLastStartupLogs?.runId) {
    ctx.managedLlamaFlushQueue.enqueue(ctx.managedLlamaLastStartupLogs.runId);
  }
  scheduleIdleSummaryIfNeeded(ctx);
  return true;
}

export async function ensureManagedLlamaReadyForModelRequest(ctx: ServerContext): Promise<void> {
  if (ctx.disableManagedLlamaStartup) {
    return;
  }
  await ctx.ensureManagedLlamaReady();
}
