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
  type StatusMetadata,
} from './status-file.js';
import {
  buildStatusRequestLogBody,
  ensureRunLogsTable,
  upsertRunArtifactPayload,
} from './dashboard-runs.js';
import {
  getStatusArtifactId,
  getStatusArtifactUri,
  type DeferredArtifact,
} from '../state/status-artifacts.js';
import type {
  ActiveRunState,
  DatabaseInstance,
  ModelRequestQueueDiagnostics,
  ModelRequestLock,
  ModelRequestWaitOptions,
  ModelRequestWaiter,
  ServerContext,
} from './server-types.js';
import { serverLogger } from './server-logger.js';
import { readConfig } from './config-store.js';

export const MAX_COMPLETED_STATUS_PATH_ENTRIES = 1000;
export const DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS = 900_000;
export const DEFAULT_IDLE_SUMMARY_DELAY_MS = 600_000;

function readModelRequestQueueTimeoutMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS;
}

export function rememberCompletedStatusRequestId(ctx: ServerContext, statusPath: string, requestId: string): void {
  ctx.completedRequestIdByStatusPath.delete(statusPath);
  ctx.completedRequestIdByStatusPath.set(statusPath, requestId);
  while (ctx.completedRequestIdByStatusPath.size > MAX_COMPLETED_STATUS_PATH_ENTRIES) {
    const oldestStatusPath = ctx.completedRequestIdByStatusPath.keys().next().value;
    if (!oldestStatusPath) {
      return;
    }
    ctx.completedRequestIdByStatusPath.delete(oldestStatusPath);
  }
}

export function clearCompletedStatusRequestIdForDifferentRequest(
  ctx: ServerContext,
  statusPath: string,
  requestId: string,
): void {
  const completedRequestId = ctx.completedRequestIdByStatusPath.get(statusPath);
  if (completedRequestId && completedRequestId !== requestId) {
    ctx.completedRequestIdByStatusPath.delete(statusPath);
  }
}

// ---------------------------------------------------------------------------
// Published status
// ---------------------------------------------------------------------------

export function hasPublishedActivity(ctx: ServerContext): boolean {
  return ctx.bootstrapManagedLlamaStartup
    || ctx.managedLlamaStarting
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
  serverLogger.emitBody('st', runState.requestId, buildStatusRequestLogBody({
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
  ensureDirectory(dirname(ctx.idleSummarySnapshotsPath));
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
    serverLogger.report(buildIdleSummarySnapshotMessage(snapshot), emittedAt);
    ctx.idleSummaryPending = false;
    resetPendingIdleSummaryMetadata(ctx);
    publishStatus(ctx);
  }, ctx.idleSummaryDelayMs);
  if (typeof ctx.idleSummaryTimer.unref === 'function') {
    ctx.idleSummaryTimer.unref();
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
    lastFinishedAtMs: lastFinishedAtMs ?? ctx.terminalMetadataLastModelRequestFinishedAtMs,
  });
}

export function wakeManagedLlamaForIncomingModelRequest(ctx: ServerContext): void {
  if (ctx.disableManagedLlamaStartup || ctx.presetRuntimeCoordinator) {
    return;
  }
  void ctx.ensureManagedLlamaReady({ allowUnconfigured: true }).catch((error) => {
    const message = getErrorMessage(error);
    ctx.managedLlamaStartupWarning = message;
    publishStatus(ctx);
    process.stderr.write(`[siftKitStatus] Failed to wake llama.cpp for incoming request: ${message}\n`);
  });
}

// llama.cpp serves one request at a time; exl3's paged scheduler dedups, batches and
// fair-shares everything admitted, so admission past ParallelSlots is its problem, not ours.
export function getModelRequestCapacity(ctx: ServerContext): number {
  return ctx.presetRuntimeCoordinator?.getActiveBackend() === 'exl3' ? Number.POSITIVE_INFINITY : 1;
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
  ctx.activeModelRequests.set(lock.token, lock);
  syncInferenceRunFlushQueueModelState(ctx);
  return lock;
}

function createModelRequestLock(kind: string, ownerRunId: string | null): ModelRequestLock {
  return {
    token: randomUUID(),
    kind: String(kind),
    startedAtUtc: new Date().toISOString(),
    ownerRunId,
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
    ctx.activeModelRequests.set(lock.token, lock);
    clearModelRequestWaiterTimeout(waiter);
    logModelRequestLockAcquired(lock, getElapsedMsSinceIso(waiter.enqueuedAtUtc));
    waiter.resolveLock(lock);
  }
  syncInferenceRunFlushQueueModelState(ctx);
  refreshQueuedModelRequestTimeouts(ctx);
}

export async function acquireModelRequestWithWait(
  ctx: ServerContext,
  kind: string,
  request?: IncomingMessage,
  response?: ServerResponse,
  options: ModelRequestWaitOptions = {},
): Promise<ModelRequestLock | null> {
  ctx.modelIdleController?.clearForIncomingRequest();
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
  ctx.activeModelRequests.delete(token);
  const finishedAtMs = Date.now();
  ctx.terminalMetadataLastModelRequestFinishedAtMs = finishedAtMs;
  syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
  logModelRequestLockReleased(releasedLock, ctx.modelRequestQueue.length);
  const coordinator = ctx.presetRuntimeCoordinator;
  if (coordinator?.canGrantModelRequest() === false) {
    for (const waiter of ctx.modelRequestQueue) {
      restartModelRequestWaiterTimeout(ctx, waiter);
    }
    void coordinator.onModelRequestReleased().then(() => {
      grantQueuedModelRequests(ctx);
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
  if (ctx.managedLlamaLastStartupLogs?.runId) {
    ctx.inferenceRunFlushQueue.enqueue(ctx.managedLlamaLastStartupLogs.runId, 'llama');
  }
  scheduleIdleSummaryIfNeeded(ctx);
  return true;
}

function armActivePresetIdle(ctx: ServerContext, finishedAtMs: number): void {
  const coordinator = ctx.presetRuntimeCoordinator;
  if (!coordinator) return;
  const status = coordinator.getStatus();
  const config = readConfig(ctx.configPath);
  const preset = config.Server.ModelPresets.Presets.find((candidate) => candidate.id === status.activePresetId);
  if (preset) ctx.modelIdleController?.armAfterRequest(preset, finishedAtMs);
}

export function resumeModelRequestAdmission(ctx: ServerContext): void {
  grantQueuedModelRequests(ctx);
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
