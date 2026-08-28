/**
 * Shared server-operational helpers: published status, run state tracking, idle
 * summary scheduling, execution lease, and model-request serialisation.
 *
 * Every function takes a `ServerContext` as its first argument so the mutable
 * state lives in one place (created by `startStatusServer` in index.ts).
 */
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { getErrorMessage } from '../lib/errors.js';
import {
  STATUS_TRUE,
  STATUS_FALSE,
  writeStatusText,
} from './status-file.js';
import { ensureDirectory } from '../lib/fs.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import {
  buildIdleSummarySnapshot,
  buildIdleSummarySnapshotMessage,
  ensureIdleSummarySnapshotsTable,
  persistIdleSummarySnapshot,
} from './idle-summary.js';
import {
  ensureRunLogsTable,
  upsertRunArtifactPayload,
} from './dashboard-runs.js';
import {
  getStatusArtifactId,
  getStatusArtifactUri,
  type DeferredArtifact,
} from '../state/status-artifacts.js';
import type {
  DatabaseInstance,
  ModelRequestQueueDiagnostics,
  ModelRequestLock,
  ModelRequestWaitOptions,
  ModelRequestWaiter,
  ServerContext,
} from './server-types.js';
import { serverLogger } from './server-logger.js';

export const DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS = 900_000;
/**
 * Longest a single request may hold the model before the server takes the lock back.
 *
 * Deliberately far beyond any legitimate operation: this is not a work deadline, it is the floor
 * under a wedge. A holder that deadlocks keeps the lock forever — one held it for 943s with a
 * queue behind it — and every later request waits on a run that will never finish.
 */
export const DEFAULT_MODEL_REQUEST_HOLD_CEILING_MS = 3_600_000;
export const DEFAULT_IDLE_SUMMARY_DELAY_MS = 600_000;

function readModelRequestQueueTimeoutMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS;
}

function readModelRequestHoldCeilingMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_MODEL_REQUEST_HOLD_CEILING_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_REQUEST_HOLD_CEILING_MS;
}

// ---------------------------------------------------------------------------
// Published status
// ---------------------------------------------------------------------------

export function hasPublishedActivity(ctx: ServerContext): boolean {
  return ctx.managedLlama.bootstrapStartup
    || ctx.managedLlama.starting
    || ctx.activeModelRequests.size > 0
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
  return ctx.statusRuns.hasActiveRuns(Date.now());
}

function persistDeferredArtifact(ctx: ServerContext, artifact: DeferredArtifact): void {
  upsertRuntimeJsonArtifact({
    id: getStatusArtifactId(artifact.artifactType, artifact.artifactRequestId),
    artifactKind: `status_${artifact.artifactType}`,
    requestId: artifact.artifactRequestId,
    title: getStatusArtifactUri(artifact.artifactType, artifact.artifactRequestId),
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
    && ctx.activeModelRequests.size === 0
    && ctx.modelRequestQueue.length === 0;
}

export function clearIdleSummaryTimer(ctx: ServerContext): void {
  if (ctx.idleSummary.timer) {
    clearTimeout(ctx.idleSummary.timer);
    ctx.idleSummary.timer = null;
  }
}

export function resetPendingIdleSummaryMetadata(ctx: ServerContext): void {
  ctx.idleSummary.pendingMetadata = {
    inputCharactersPerContextToken: null,
    chunkThresholdCharacters: null,
  };
}

export function getIdleSummaryDatabase(ctx: ServerContext): DatabaseInstance {
  if (ctx.idleSummary.database) {
    return ctx.idleSummary.database;
  }
  ensureDirectory(dirname(ctx.idleSummarySnapshotsPath));
  ctx.idleSummary.database = new Database(ctx.idleSummarySnapshotsPath);
  ensureIdleSummarySnapshotsTable(ctx.idleSummary.database);
  ensureRunLogsTable(ctx.idleSummary.database);
  return ctx.idleSummary.database;
}

export function scheduleIdleSummaryIfNeeded(ctx: ServerContext): void {
  if (!ctx.idleSummary.pending || !isIdle(ctx)) {
    clearIdleSummaryTimer(ctx);
    return;
  }
  clearIdleSummaryTimer(ctx);
  ctx.idleSummary.timer = setTimeout(async () => {
    ctx.idleSummary.timer = null;
    if (!ctx.idleSummary.pending || !isIdle(ctx)) {
      return;
    }
    const emittedAt = new Date();
    const snapshot = buildIdleSummarySnapshot({
      ...ctx.metrics,
      ...ctx.idleSummary.pendingMetadata,
    }, emittedAt);
    try {
      persistIdleSummarySnapshot(getIdleSummaryDatabase(ctx), snapshot);
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Failed to persist idle summary snapshot to ${ctx.idleSummarySnapshotsPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    serverLogger.report(buildIdleSummarySnapshotMessage(snapshot), emittedAt);
    ctx.idleSummary.pending = false;
    resetPendingIdleSummaryMetadata(ctx);
    publishStatus(ctx);
  }, ctx.idleSummary.delayMs);
  if (typeof ctx.idleSummary.timer.unref === 'function') {
    ctx.idleSummary.timer.unref();
  }
}

// ---------------------------------------------------------------------------
// Model request serialisation
// ---------------------------------------------------------------------------

function getIncomingModelRequestQueuePosition(ctx: ServerContext): number {
  return ctx.activeModelRequests.size + ctx.modelRequestQueue.length + 1;
}

function getQueuedModelRequestQueuePosition(ctx: ServerContext, waiter: ModelRequestWaiter): number {
  const queueIndex = ctx.modelRequestQueue.findIndex((entry) => entry.queueToken === waiter.queueToken);
  if (queueIndex < 0) {
    return 0;
  }
  return ctx.activeModelRequests.size + queueIndex + 1;
}

function logIncomingModelRequest(ctx: ServerContext, kind: string): void {
  const taskKind = String(kind).trim() || 'unknown';
  serverLogger.dim({
    scope: 'st',
    id: '',
    event: 'incoming',
    fields: `task=${taskKind} queue_position=${getIncomingModelRequestQueuePosition(ctx)}`,
  });
}

function getElapsedMsSinceIso(isoTimestamp: string): number {
  const startedAtMs = Date.parse(isoTimestamp);
  return Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
}

export function getModelRequestQueueDiagnostics(ctx: ServerContext): ModelRequestQueueDiagnostics {
  return {
    activeCount: ctx.activeModelRequests.size,
    activeRequests: [...ctx.activeModelRequests.values()].map((lock) => ({
      kind: lock.kind,
      startedAtUtc: lock.startedAtUtc,
      heldMs: getElapsedMsSinceIso(lock.startedAtUtc),
      ownerRunId: lock.ownerRunId,
    })),
    queueLength: ctx.modelRequestQueue.length,
    queuedRequests: ctx.modelRequestQueue.map((entry) => ({
      kind: entry.kind,
      enqueuedAtUtc: entry.enqueuedAtUtc,
      waitMs: getElapsedMsSinceIso(entry.enqueuedAtUtc),
    })),
  };
}

function logModelRequestLockAcquired(lock: ModelRequestLock, waitMs: number): void {
  serverLogger.dim({
    scope: 'st',
    id: lock.token,
    event: 'lock_acquired',
    fields: `task=${lock.kind} wait_ms=${Math.max(0, Math.trunc(waitMs))}`,
  });
}

function logModelRequestLockReleased(lock: ModelRequestLock, queueLength: number): void {
  serverLogger.dim({
    scope: 'st',
    id: lock.token,
    event: 'lock_released',
    fields: `task=${lock.kind} held_ms=${getElapsedMsSinceIso(lock.startedAtUtc)} `
      + `queue_remaining=${Math.max(0, queueLength)}`,
  });
}

function logModelRequestWaitCancelled(waiter: ModelRequestWaiter): void {
  serverLogger.dim({
    scope: 'st',
    id: waiter.queueToken,
    event: 'lock_cancelled',
    fields: `task=${waiter.kind} wait_ms=${getElapsedMsSinceIso(waiter.enqueuedAtUtc)}`,
  });
}

function logModelRequestExpired(lock: ModelRequestLock): void {
  serverLogger.error({
    scope: 'st',
    id: lock.token,
    event: 'expired',
    fields: `reason=model_hold_ceiling task=${lock.kind} held_ms=${getElapsedMsSinceIso(lock.startedAtUtc)}`,
  });
}

function logModelRequestDropped(waiter: ModelRequestWaiter, reason: string): void {
  serverLogger.error({
    scope: 'st',
    id: waiter.queueToken,
    event: 'dropped',
    fields: `reason=${reason} task=${waiter.kind} wait_ms=${getElapsedMsSinceIso(waiter.enqueuedAtUtc)}`,
  });
}

function syncInferenceRunFlushQueueModelState(ctx: ServerContext, lastFinishedAtMs?: number): void {
  ctx.inferenceRunFlushQueue.setModelRequestState({
    active: ctx.activeModelRequests.size > 0,
    queueLength: ctx.modelRequestQueue.length,
    lastFinishedAtMs: lastFinishedAtMs ?? ctx.terminalMetadata.lastModelRequestFinishedAtMs,
  });
}

export function wakeManagedLlamaForIncomingModelRequest(ctx: ServerContext): void {
  if (ctx.disableManagedLlamaStartup || ctx.presetRuntimeCoordinator) {
    return;
  }
  void ctx.ensureManagedLlamaReady({ allowUnconfigured: true }).catch((error) => {
    const message = getErrorMessage(error);
    ctx.managedLlama.startupWarning = message;
    publishStatus(ctx);
    process.stderr.write(`[siftKitStatus] Failed to wake llama.cpp for incoming request: ${message}\n`);
  });
}

export function getModelRequestCapacity(ctx: ServerContext): number {
  return ctx.appliedModelPresetState.getParallelSlots();
}

export function acquireModelRequest(ctx: ServerContext, kind: string, ownerRunId: string | null = null): ModelRequestLock | null {
  if (
    ctx.activeModelRequests.size >= getModelRequestCapacity(ctx)
    || ctx.modelRequestQueue.length > 0
    || ctx.presetRuntimeCoordinator?.canGrantModelRequest() === false
  ) {
    return null;
  }
  const lock = createModelRequestLock(kind, ownerRunId);
  registerActiveModelRequest(ctx, lock);
  syncInferenceRunFlushQueueModelState(ctx);
  return lock;
}

function createModelRequestLock(kind: string, ownerRunId: string | null): ModelRequestLock {
  return {
    token: randomUUID(),
    kind: String(kind),
    startedAtUtc: new Date().toISOString(),
    ownerRunId,
    holdTimeoutHandle: null,
  };
}

/**
 * The only way a lock enters the active set, so no path can grant one without a ceiling.
 * Expiry runs the ordinary release, which is what drains the queue behind the stuck holder.
 */
function registerActiveModelRequest(ctx: ServerContext, lock: ModelRequestLock): void {
  ctx.activeModelRequests.set(lock.token, lock);
  const holdTimeoutHandle = setTimeout(() => {
    logModelRequestExpired(lock);
    releaseModelRequest(ctx, lock.token);
  }, readModelRequestHoldCeilingMs());
  holdTimeoutHandle.unref?.();
  lock.holdTimeoutHandle = holdTimeoutHandle;
}

function clearModelRequestHoldCeiling(lock: ModelRequestLock): void {
  if (!lock.holdTimeoutHandle) {
    return;
  }
  clearTimeout(lock.holdTimeoutHandle);
  lock.holdTimeoutHandle = null;
}

function removeModelRequestWaiter(ctx: ServerContext, queueToken: string): boolean {
  const index = ctx.modelRequestQueue.findIndex((entry) => entry.queueToken === queueToken);
  if (index < 0) {
    return false;
  }
  ctx.modelRequestQueue.splice(index, 1);
  return true;
}

function clearModelRequestWaiterTimeout(waiter: ModelRequestWaiter): void {
  if (!waiter.timeoutHandle) {
    return;
  }
  clearTimeout(waiter.timeoutHandle);
  waiter.timeoutHandle = null;
}

function startModelRequestWaiterTimeout(ctx: ServerContext, waiter: ModelRequestWaiter): void {
  clearModelRequestWaiterTimeout(waiter);
  const timeoutHandle = setTimeout(() => {
    cancelModelRequestWaiter(ctx, waiter, 'model_queue_timeout');
  }, waiter.timeoutMs);
  timeoutHandle.unref?.();
  waiter.timeoutHandle = timeoutHandle;
}

function restartModelRequestWaiterTimeout(ctx: ServerContext, waiter: ModelRequestWaiter): void {
  if (waiter.cancelled || waiter.grantedLock) {
    return;
  }
  startModelRequestWaiterTimeout(ctx, waiter);
}

function refreshQueuedModelRequestTimeouts(ctx: ServerContext): void {
  for (const waiter of ctx.modelRequestQueue) {
    if (waiter.cancelled || waiter.grantedLock) {
      continue;
    }
    const currentPosition = getQueuedModelRequestQueuePosition(ctx, waiter);
    if (currentPosition <= 0) {
      continue;
    }
    if (currentPosition < waiter.lastQueuePosition) {
      waiter.lastQueuePosition = currentPosition;
      restartModelRequestWaiterTimeout(ctx, waiter);
    } else if (currentPosition > waiter.lastQueuePosition) {
      waiter.lastQueuePosition = currentPosition;
    }
  }
}

function cancelModelRequestWaiter(
  ctx: ServerContext,
  waiter: ModelRequestWaiter,
  reason: 'client_cancelled' | 'model_queue_timeout',
): void {
  if (waiter.cancelled || waiter.grantedLock) {
    return;
  }
  waiter.cancelled = true;
  clearModelRequestWaiterTimeout(waiter);
  removeModelRequestWaiter(ctx, waiter.queueToken);
  if (reason === 'model_queue_timeout') {
    logModelRequestDropped(waiter, reason);
  } else {
    logModelRequestWaitCancelled(waiter);
  }
  waiter.resolveLock(null);
  grantQueuedModelRequests(ctx);
  syncInferenceRunFlushQueueModelState(ctx);
  scheduleIdleSummaryIfNeeded(ctx);
}

function grantQueuedModelRequests(ctx: ServerContext): void {
  while (
    ctx.activeModelRequests.size < getModelRequestCapacity(ctx)
    && ctx.presetRuntimeCoordinator?.canGrantModelRequest() !== false
    && ctx.modelRequestQueue.length > 0
  ) {
    const waiter = ctx.modelRequestQueue.shift();
    if (!waiter || waiter.cancelled) {
      continue;
    }
    const lock = createModelRequestLock(waiter.kind, waiter.ownerRunId);
    waiter.grantedLock = lock;
    registerActiveModelRequest(ctx, lock);
    clearModelRequestWaiterTimeout(waiter);
    logModelRequestLockAcquired(lock, getElapsedMsSinceIso(waiter.enqueuedAtUtc));
    waiter.resolveLock(lock);
  }
  syncInferenceRunFlushQueueModelState(ctx);
  refreshQueuedModelRequestTimeouts(ctx);
}

function waitForModelRequestAdmission(ctx: ServerContext): void {
  const coordinator = ctx.presetRuntimeCoordinator;
  if (!coordinator) {
    grantQueuedModelRequests(ctx);
    return;
  }
  void coordinator.waitForCurrentAdmissionBlocker().then(() => {
    grantQueuedModelRequests(ctx);
  }).catch((error) => {
    process.stderr.write(`[siftKitStatus] Model request admission wake failed: ${getErrorMessage(error)}\n`);
  });
}

export async function acquireModelRequestWithWait(
  ctx: ServerContext,
  kind: string,
  request?: IncomingMessage,
  response?: ServerResponse,
  options: ModelRequestWaitOptions = {},
): Promise<ModelRequestLock | null> {
  ctx.modelIdleController?.clearForIncomingRequest();
  ctx.assistant?.onInteractiveRequest();
  ctx.assistantIdleGate?.noteActivity();
  logIncomingModelRequest(ctx, kind);
  clearIdleSummaryTimer(ctx);
  let lock = acquireModelRequest(ctx, kind, options.ownerRunId ?? null);
  if (lock) {
    logModelRequestLockAcquired(lock, 0);
    return lock;
  }
  const initialQueuePosition = getIncomingModelRequestQueuePosition(ctx);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.trunc(Number(options.timeoutMs))
    : readModelRequestQueueTimeoutMs();
  let resolveWaiterLock: (resolvedLock: ModelRequestLock | null) => void = () => {};
  const waiterLockPromise = new Promise<ModelRequestLock | null>((resolve) => {
    resolveWaiterLock = resolve;
  });
  const waiter: ModelRequestWaiter = {
    queueToken: randomUUID(),
    kind: String(kind),
    ownerRunId: options.ownerRunId ?? null,
    enqueuedAtUtc: new Date().toISOString(),
    cancelled: false,
    grantedLock: null,
    timeoutHandle: null,
    timeoutMs,
    lastQueuePosition: initialQueuePosition,
    resolveLock: resolveWaiterLock,
  };
  ctx.modelRequestQueue.push(waiter);
  syncInferenceRunFlushQueueModelState(ctx);
  const onAbortedRequest = (): void => {
    cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
  };
  const onClosedRequest = (): void => {
    if (request?.complete) {
      return;
    }
    cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
  };
  const onClosedResponse = (): void => {
    if (response?.writableEnded) {
      return;
    }
    cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
  };
  startModelRequestWaiterTimeout(ctx, waiter);
  if (request) {
    request.once('aborted', onAbortedRequest);
    request.once('close', onClosedRequest);
  }
  if (response) {
    response.once('close', onClosedResponse);
  }
  if (response?.destroyed && !response.writableEnded) {
    cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
  }
  waitForModelRequestAdmission(ctx);
  try {
    return await waiterLockPromise;
  } finally {
    clearModelRequestWaiterTimeout(waiter);
    if (response?.destroyed && !response.writableEnded) {
      cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
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
  const releasedLock = ctx.activeModelRequests.get(token);
  if (!releasedLock) {
    return false;
  }
  clearModelRequestHoldCeiling(releasedLock);
  ctx.activeModelRequests.delete(token);
  const finishedAtMs = Date.now();
  ctx.terminalMetadata.lastModelRequestFinishedAtMs = finishedAtMs;
  syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
  logModelRequestLockReleased(releasedLock, ctx.modelRequestQueue.length);
  const coordinator = ctx.presetRuntimeCoordinator;
  if (coordinator?.canGrantModelRequest() === false) {
    for (const waiter of ctx.modelRequestQueue) {
      restartModelRequestWaiterTimeout(ctx, waiter);
    }
    void coordinator.onModelRequestReleased().then(() => {
      waitForModelRequestAdmission(ctx);
      if (ctx.activeModelRequests.size === 0) armActivePresetIdle(ctx, Date.now());
      syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
      scheduleIdleSummaryIfNeeded(ctx);
    }).catch((error) => {
      process.stderr.write(`[siftKitStatus] Backend transition failed: ${getErrorMessage(error)}\n`);
    });
  } else {
    grantQueuedModelRequests(ctx);
    if (ctx.activeModelRequests.size === 0) armActivePresetIdle(ctx, finishedAtMs);
  }
  syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
  if (ctx.managedLlama.lastStartupLogs?.runId) {
    ctx.inferenceRunFlushQueue.enqueue(ctx.managedLlama.lastStartupLogs.runId, 'llama');
  }
  scheduleIdleSummaryIfNeeded(ctx);
  return true;
}

function armActivePresetIdle(ctx: ServerContext, finishedAtMs: number): void {
  // Only a coordinator can unload, and the applied state already holds the preset the
  // runtime is actually running — looking it back up in config would only reintroduce a
  // second source of truth that silently skips arming whenever the two drift.
  if (!ctx.presetRuntimeCoordinator) return;
  ctx.modelIdleController?.armAfterRequest(ctx.appliedModelPresetState.getPreset(), finishedAtMs);
}

export function resumeModelRequestAdmission(ctx: ServerContext): void {
  waitForModelRequestAdmission(ctx);
}

export async function ensureActivePresetReadyForModelRequest(ctx: ServerContext): Promise<void> {
  const coordinator = ctx.presetRuntimeCoordinator;
  if (coordinator) {
    await coordinator.ensureActivePresetReady();
    return;
  }
  if (ctx.disableManagedLlamaStartup) {
    return;
  }
  await ctx.ensureManagedLlamaReady();
}
