/**
 * Shared server-operational helpers: published status, run state tracking, idle
 * summary scheduling, execution lease, and model-request serialisation.
 *
 * Every function takes a `ServerContext` as its first argument so the mutable
 * state lives in one place (created by `startStatusServer` in index.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MIXED_MODEL_PRESET_LABEL } from '@siftkit/contracts';
import { getErrorMessage, toError } from '../lib/errors.js';
import { readConfig, persistAppliedModelSelection } from './config-store.js';
import { MissingModelPathError } from '../inference-presets/exl3-preset-adapter.js';
import {
  resolveModelRequestContext,
  type ModelRequestContext,
} from './model-request-context.js';
import type { ModelRequestIntent } from '../lib/model-request-intent.js';
import type { ModelRequestWaitingReason, ModelResidencyDiagnostics } from '../lib/operation-stream.js';
import {
  selectNextModelRequest,
  type ModelRequestCandidate,
} from './model-request-selection.js';
import type { SiftConfig } from '../config/types.js';
import { getActiveModelPreset } from '../config/getters.js';
import {
  STATUS_TRUE,
  STATUS_FALSE,
  writeStatusText,
} from './status-file.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { upsertRuntimeJsonArtifact } from '../state/runtime-artifacts.js';
import {
  buildIdleSummarySnapshot,
  buildIdleSummarySnapshotMessage,
  persistIdleSummarySnapshot,
  type IdleSummarySnapshot,
} from './idle-summary.js';
import { auditInferenceThroughput } from './inference-throughput-audit.js';
import {
  upsertRunArtifactPayload,
} from './dashboard-runs.js';
import {
  getStatusArtifactId,
  getStatusArtifactUri,
  type DeferredArtifact,
} from '../state/status-artifacts.js';
import type {
  DatabaseInstance,
  ModelQueueTimeout,
  ModelRequestQueueDiagnostics,
  ModelRequestLock,
  ModelRequestSelection,
  ModelRequestWaitOptions,
  ModelRequestWaiter,
  ServerContext,
} from './server-types.js';
import { serverLogger } from './server-logger.js';

export const DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS = 900_000;
/**
 * Longest a request may hold the model without activity before the server takes the lock back.
 *
 * This is not a work deadline: run-owned holders renew it on every sign of progress, so it only
 * fires on a holder that has gone silent. A holder that deadlocks keeps the lock forever — one
 * held it for 943s with a queue behind it — and every later request waits on a run that will
 * never finish.
 */
export const DEFAULT_MODEL_REQUEST_HOLD_CEILING_MS = 3_600_000;
export const DEFAULT_IDLE_SUMMARY_DELAY_MS = 600_000;

function readModelRequestQueueTimeoutMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_MODEL_REQUEST_QUEUE_TIMEOUT_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_REQUEST_QUEUE_TIMEOUT_MS;
}

function readModelRequestInactivityTimeoutMs(): number {
  const parsed = Number.parseInt(String(process.env.SIFTKIT_MODEL_REQUEST_HOLD_CEILING_MS || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_REQUEST_HOLD_CEILING_MS;
}

// ---------------------------------------------------------------------------
// Published status
// ---------------------------------------------------------------------------

export function hasPublishedActivity(ctx: ServerContext): boolean {
  return ctx.engineBootstrap.inProgress
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
    databasePath: ctx.runtimeDatabasePath,
  });
  upsertRunArtifactPayload({
    database: getIdleSummaryDatabase(ctx),
    requestId: artifact.artifactRequestId,
    artifactType: artifact.artifactType,
    artifactPayload: artifact.artifactPayload,
    identity: artifact.identity,
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

/**
 * Persists everything still queued and resolves once the queue is empty. A reader that must
 * see an operation's artifacts (benchmark metrics, for one) has to wait for the 25ms-deferred
 * drain rather than race it and treat "not written yet" as "does not exist".
 */
export async function flushDeferredArtifacts(ctx: ServerContext): Promise<void> {
  while (ctx.deferredArtifactQueue.length > 0 || ctx.deferredArtifactDrainRunning) {
    if (ctx.deferredArtifactDrainRunning) {
      // A drain already owns the queue and returns early for re-entrant callers, so yield the
      // loop rather than spinning on a flag this call cannot clear.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      continue;
    }
    await drainDeferredArtifacts(ctx);
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
  return getRuntimeDatabase(ctx.idleSummarySnapshotsPath);
}

/** Audits the runtime-wide generation speed of one emitted snapshot against its own backend reference. */
export function auditIdleSummarySnapshot(snapshot: IdleSummarySnapshot): void {
  auditInferenceThroughput({
    operationType: MIXED_MODEL_PRESET_LABEL,
    operationId: 'runtime_metrics',
    requestId: snapshot.emittedAtUtc,
    stage: 'idle_summary',
    model: MIXED_MODEL_PRESET_LABEL,
    presetId: null,
    scope: 'published',
  }, snapshot.throughput, {
    pp: null,
    decode: Number.isFinite(snapshot.avgTokensPerSecond) ? snapshot.avgTokensPerSecond : null,
  });
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
    auditIdleSummarySnapshot(snapshot);
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

/** Arrival order only: a request for the resident model may be served before earlier arrivals. */
function getIncomingModelRequestArrivalPosition(ctx: ServerContext): number {
  return ctx.activeModelRequests.size + ctx.modelRequestQueue.length + 1;
}

function logIncomingModelRequest(ctx: ServerContext, kind: string): void {
  const taskKind = String(kind).trim() || 'unknown';
  serverLogger.dim({
    scope: 'st',
    id: '',
    event: 'incoming',
    fields: `task=${taskKind} arrival_position=${getIncomingModelRequestArrivalPosition(ctx)}`,
  });
}

function getElapsedMsSinceIso(isoTimestamp: string): number {
  const startedAtMs = Date.parse(isoTimestamp);
  return Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;
}

/** Publishes only a SHA-256 fingerprint: the internal key carries engine environment values. */
function describeResidency(modelPresetId: string, residencyKey: string | null): ModelResidencyDiagnostics {
  return {
    modelPresetId,
    residencyFingerprint: residencyKey === null ? null : createHash('sha256').update(residencyKey).digest('hex'),
  };
}

function readModelRequestWaitingReason(
  ctx: ServerContext,
  waiter: ModelRequestWaiter,
  appliedKey: string | null,
): ModelRequestWaitingReason {
  if (ctx.presetRuntimeCoordinator?.canGrantModelRequest() === false) return 'transition';
  if (waiter.resolution !== null && !isResidentSelection(ctx, waiter.resolution, appliedKey)) return 'different_model';
  return 'capacity';
}

export function getModelRequestQueueDiagnostics(ctx: ServerContext): ModelRequestQueueDiagnostics {
  const appliedKey = readAppliedResidencyKey(ctx);
  return {
    resident: describeResidency(ctx.appliedModelPresetState.getPreset().id, appliedKey),
    activeCount: ctx.activeModelRequests.size,
    activeRequests: [...ctx.activeModelRequests.values()].map((lock) => ({
      kind: lock.kind,
      startedAtUtc: lock.startedAtUtc,
      heldMs: getElapsedMsSinceIso(lock.startedAtUtc),
      ownerRunId: lock.ownerRunId,
      model: describeResidency(lock.context.modelPreset.id, lock.residencyKey),
    })),
    queueLength: ctx.modelRequestQueue.length,
    queuedRequests: ctx.modelRequestQueue.map((entry) => ({
      kind: entry.kind,
      enqueuedAtUtc: entry.enqueuedAtUtc,
      waitMs: getElapsedMsSinceIso(entry.enqueuedAtUtc),
      hasDeadline: entry.queueTimeout !== 'none',
      requested: entry.intent,
      resolved: entry.resolution === null
        ? null
        : describeResidency(entry.resolution.context.modelPreset.id, entry.resolution.residencyKey),
      waitingReason: readModelRequestWaitingReason(ctx, entry, appliedKey),
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
    fields: `reason=model_inactivity_timeout task=${lock.kind} held_ms=${getElapsedMsSinceIso(lock.startedAtUtc)}`,
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

export function getModelRequestCapacity(ctx: ServerContext): number {
  return ctx.appliedModelPresetState.getParallelSlots();
}

function createModelRequestLock(
  kind: string,
  ownerRunId: string | null,
  context: ModelRequestContext,
  residencyKey: string | null,
): ModelRequestLock {
  return {
    token: randomUUID(),
    kind: String(kind),
    startedAtUtc: new Date().toISOString(),
    ownerRunId,
    context,
    residencyKey,
    lastActivityAtMs: Date.now(),
    inactivityTimeoutHandle: null,
  };
}

/**
 * The only way a lock enters the active set, so no path can grant one without an inactivity
 * timeout. Expiry runs the ordinary release, which drains the queue behind the stuck holder.
 */
function registerActiveModelRequest(ctx: ServerContext, lock: ModelRequestLock): void {
  ctx.activeModelRequests.set(lock.token, lock);
  armModelRequestInactivityTimeout(ctx, lock, readModelRequestInactivityTimeoutMs());
}

/**
 * Arms one timer that expires the lock only if the holder is still silent when it fires.
 * Activity since then re-arms for the remaining window, so renewal costs a timestamp write
 * rather than a timer swap — a holder signals on every progress event it emits.
 */
function armModelRequestInactivityTimeout(ctx: ServerContext, lock: ModelRequestLock, delayMs: number): void {
  const inactivityTimeoutHandle = setTimeout(() => {
    lock.inactivityTimeoutHandle = null;
    const remainingMs = readModelRequestInactivityTimeoutMs() - (Date.now() - lock.lastActivityAtMs);
    if (remainingMs > 0) {
      armModelRequestInactivityTimeout(ctx, lock, remainingMs);
      return;
    }
    logModelRequestExpired(lock);
    releaseModelRequest(ctx, lock.token);
  }, delayMs);
  inactivityTimeoutHandle.unref?.();
  lock.inactivityTimeoutHandle = inactivityTimeoutHandle;
}

/**
 * Records a sign of life from the holder, keeping its original acquisition time. False once the
 * token has been released or expired, so a settled run cannot revive ownership it no longer holds.
 */
export function renewModelRequestActivity(ctx: ServerContext, token: string): boolean {
  const lock = ctx.activeModelRequests.get(token);
  if (!lock) {
    return false;
  }
  lock.lastActivityAtMs = Date.now();
  return true;
}

function clearModelRequestInactivityTimeout(lock: ModelRequestLock): void {
  if (!lock.inactivityTimeoutHandle) {
    return;
  }
  clearTimeout(lock.inactivityTimeoutHandle);
  lock.inactivityTimeoutHandle = null;
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
  if (waiter.queueTimeout === 'none') {
    return;
  }
  const timeoutHandle = setTimeout(() => {
    cancelModelRequestWaiter(ctx, waiter, 'model_queue_timeout');
  }, waiter.queueTimeout);
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
    if (waiter.cancelled || waiter.grantedLock || waiter.queueTimeout === 'none') {
      continue;
    }
    const queueIndex = ctx.modelRequestQueue.indexOf(waiter);
    if (queueIndex < 0) {
      continue;
    }
    // Only an earlier waiter leaving improves a waiter's progress; a later resident match that
    // bypasses it must not extend its deadline.
    if (queueIndex < waiter.lastQueueIndex) {
      waiter.lastQueueIndex = queueIndex;
      restartModelRequestWaiterTimeout(ctx, waiter);
    } else if (queueIndex > waiter.lastQueueIndex) {
      waiter.lastQueueIndex = queueIndex;
    }
  }
}

function cancelModelRequestWaiter(
  ctx: ServerContext,
  waiter: ModelRequestWaiter,
  reason: 'client_cancelled' | 'operation_cancelled' | 'model_queue_timeout',
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
  // An earlier waiter leaving improves the remaining waiters' progress; restart their windows.
  refreshQueuedModelRequestTimeouts(ctx);
  requestModelRequestDrain(ctx);
  syncInferenceRunFlushQueueModelState(ctx);
  scheduleIdleSummaryIfNeeded(ctx);
}

function rejectModelRequestWaiter(
  ctx: ServerContext,
  waiter: ModelRequestWaiter,
  reason: 'model_target_invalid' | 'model_readiness_failed',
  error: Error,
): void {
  if (waiter.cancelled || waiter.grantedLock) {
    return;
  }
  waiter.cancelled = true;
  clearModelRequestWaiterTimeout(waiter);
  removeModelRequestWaiter(ctx, waiter.queueToken);
  logModelRequestDropped(waiter, reason);
  waiter.rejectLock(error);
  syncInferenceRunFlushQueueModelState(ctx);
  refreshQueuedModelRequestTimeouts(ctx);
  scheduleIdleSummaryIfNeeded(ctx);
}

function grantModelRequestWaiter(ctx: ServerContext, waiter: ModelRequestWaiter, selection: ModelRequestSelection): void {
  const lock = createModelRequestLock(waiter.kind, waiter.ownerRunId, selection.context, selection.residencyKey);
  waiter.grantedLock = lock;
  removeModelRequestWaiter(ctx, waiter.queueToken);
  registerActiveModelRequest(ctx, lock);
  clearModelRequestWaiterTimeout(waiter);
  logModelRequestLockAcquired(lock, getElapsedMsSinceIso(waiter.enqueuedAtUtc));
  waiter.resolveLock(lock);
  syncInferenceRunFlushQueueModelState(ctx);
  refreshQueuedModelRequestTimeouts(ctx);
}

/**
 * The single admission drain owner: every acquire, release, configuration resume, and
 * transition-completion wake joins here, so one pass schedules the whole queue.
 */
function requestModelRequestDrain(ctx: ServerContext): void {
  if (ctx.modelRequestDrainPromise !== null) {
    ctx.modelRequestDrainRequested = true;
    return;
  }
  if (ctx.modelRequestQueue.length === 0) {
    return;
  }
  ctx.modelRequestDrainRequested = true;
  ctx.modelRequestDrainPromise = runModelRequestDrain(ctx);
}

async function runModelRequestDrain(ctx: ServerContext): Promise<void> {
  // Yield first so the caller publishes this pass as the owner before any queue work runs.
  await Promise.resolve();
  try {
    // A wake during a pass means the queue changed after it was examined; stop only once stable.
    while (ctx.modelRequestDrainRequested) {
      ctx.modelRequestDrainRequested = false;
      while (await advanceModelRequestDrain(ctx)) {
        // A grant, rejection, or settled readiness may enable more progress; re-evaluate.
      }
    }
  } catch (error) {
    process.stderr.write(`[siftKitStatus] Model request drain failed: ${getErrorMessage(error)}\n`);
  } finally {
    ctx.modelRequestDrainPromise = null;
    // Admission work suppressed idle arming; a pass that leaves nothing running (a cancelled
    // selection's load, a rejected target) must arm it or the model stays resident indefinitely.
    if (ctx.activeModelRequests.size === 0) armActivePresetIdle(ctx, Date.now());
  }
}

/** Null when the applied profile has no derivable loading identity, e.g. no ModelPath behind an external server. */
function readAppliedResidencyKey(ctx: ServerContext): string | null {
  try {
    return ctx.modelRuntime.getPresetResidencyKey(ctx.appliedModelPresetState.getPreset());
  } catch (error) {
    if (error instanceof MissingModelPathError) return null;
    throw error;
  }
}

/** Evaluated against the current applied profile, never cached, so a finished switch is seen at once. */
function isResidentSelection(ctx: ServerContext, selection: ModelRequestSelection, appliedKey: string | null): boolean {
  // The applied profile is resident by definition, whether or not its identity can be derived.
  return ctx.appliedModelPresetState.isApplied(selection.context.modelPreset)
    || (selection.residencyKey !== null && selection.residencyKey === appliedKey);
}

/** An intent naming a missing operation preset, model preset, or CLI model; a request error, not a lifecycle failure. */
export class ModelRequestTargetError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = 'ModelRequestTargetError';
  }
}

function resolveModelRequestTarget(ctx: ServerContext, config: SiftConfig, intent: ModelRequestIntent): ModelRequestContext {
  // A coordinator applies a newer saved selection at the next admission; without one, the
  // config route already moved the applied state, which is all an inherited request can use.
  const inherited = ctx.presetRuntimeCoordinator ? getActiveModelPreset(config) : ctx.appliedModelPresetState.getPreset();
  try {
    return resolveModelRequestContext(config, inherited, intent);
  } catch (error) {
    throw new ModelRequestTargetError(toError(error));
  }
}

/**
 * The target an intent would be admitted with right now. Routes call it before queueing so an
 * invalid target is a 400; admission re-resolves at grant time and freezes that result instead.
 */
export function previewModelRequestTarget(ctx: ServerContext, intent: ModelRequestIntent): ModelRequestContext {
  return resolveModelRequestTarget(ctx, readConfig(ctx.configPath), intent);
}

function resolveModelRequestSelection(
  ctx: ServerContext,
  config: SiftConfig,
  appliedKey: string | null,
  intent: ModelRequestIntent,
): ModelRequestSelection {
  const context = resolveModelRequestTarget(ctx, config, intent);
  const residencyKey = ctx.appliedModelPresetState.isApplied(context.modelPreset)
    ? appliedKey
    : ctx.modelRuntime.getPresetResidencyKey(context.modelPreset);
  return { context, residencyKey };
}

async function advanceModelRequestDrain(ctx: ServerContext): Promise<boolean> {
  if (ctx.modelRequestQueue.length === 0) {
    return false;
  }
  const coordinator = ctx.presetRuntimeCoordinator;
  if (coordinator && !coordinator.canGrantModelRequest()) {
    // Join the in-flight transition; its completion is this drain's wake.
    await coordinator.waitForCurrentAdmissionBlocker();
    return true;
  }
  // Resolve even at full capacity so diagnostics can report a waiter that needs another model.
  const config = readConfig(ctx.configPath);
  const candidates: ModelRequestCandidate[] = [];
  for (const waiter of [...ctx.modelRequestQueue]) {
    if (waiter.cancelled) {
      continue;
    }
    try {
      // Per waiter: an applied profile with an invalid identity rejects each request loudly.
      const appliedKey = readAppliedResidencyKey(ctx);
      waiter.resolution = resolveModelRequestSelection(ctx, config, appliedKey, waiter.intent);
      candidates.push({ queueToken: waiter.queueToken, resident: isResidentSelection(ctx, waiter.resolution, appliedKey) });
    } catch (error) {
      rejectModelRequestWaiter(ctx, waiter, 'model_target_invalid', toError(error));
    }
  }
  if (ctx.activeModelRequests.size >= getModelRequestCapacity(ctx)) {
    return false;
  }
  const token = selectNextModelRequest(candidates, ctx.activeModelRequests.size);
  const waiter = ctx.modelRequestQueue.find((entry) => entry.queueToken === token);
  const selection = waiter?.resolution;
  if (!waiter || !selection) {
    return false;
  }
  try {
    if (coordinator) {
      await coordinator.ensureRequestPresetReady(selection.context.modelPreset);
    } else {
      admitCompatibleProfileWithoutCoordinator(ctx, config, selection);
    }
  } catch (error) {
    rejectModelRequestWaiter(ctx, waiter, 'model_readiness_failed', toError(error));
    return true;
  }
  // Re-check after readiness: the waiter may have cancelled, capacity may have moved, and a
  // transition may have started. A cancelled selection never executes its operation.
  if (waiter.cancelled) {
    return true;
  }
  if (ctx.activeModelRequests.size >= getModelRequestCapacity(ctx)) {
    return true;
  }
  if (coordinator && !coordinator.canGrantModelRequest()) {
    return true;
  }
  grantModelRequestWaiter(ctx, waiter, selection);
  return true;
}

/**
 * No-coordinator mode owns no model lifecycle: it admits only targets whose residency matches the
 * applied profile, updates that profile for compatible metadata edits, and fails the rest clearly.
 */
function admitCompatibleProfileWithoutCoordinator(
  ctx: ServerContext,
  config: SiftConfig,
  selection: ModelRequestSelection,
): void {
  if (!isResidentSelection(ctx, selection, readAppliedResidencyKey(ctx))) {
    throw new Error(
      `Model preset '${selection.context.modelPreset.id}' needs a different resident model; this server has no managed runtime and cannot switch it.`,
    );
  }
  if (ctx.appliedModelPresetState.isApplied(selection.context.modelPreset)) {
    return;
  }
  ctx.appliedModelPresetState.applyPreset(selection.context.modelPreset);
  persistAppliedModelSelection(ctx.configPath, config, selection.context.modelPreset);
}

function resolveModelRequestQueueTimeout(requested: ModelQueueTimeout | undefined): ModelQueueTimeout {
  if (requested === undefined) return readModelRequestQueueTimeoutMs();
  if (requested !== 'none' && !(Number.isInteger(requested) && requested > 0)) {
    throw new Error(`Model queue timeout must be a positive integer of milliseconds or 'none'; received ${requested}.`);
  }
  return requested;
}

/** A wait with no deadline ends without a lock only through cancellation; any other ending is a queue defect. */
export class UncancelledModelWaitError extends Error {
  constructor(kind: string) {
    super(`Model wait for ${kind} ended without admission or cancellation.`);
    this.name = 'UncancelledModelWaitError';
  }
}

/** Web UI work waits for a model slot until admitted or cancelled: Stop, deletion, or a closed client. */
export const WEB_UI_MODEL_QUEUE_TIMEOUT = 'none' satisfies ModelQueueTimeout;

export function acquireWebUiModelRequest(
  ctx: ServerContext,
  kind: string,
  intent: ModelRequestIntent,
  abortSignal: AbortSignal | undefined,
  request?: IncomingMessage,
  response?: ServerResponse,
): Promise<ModelRequestLock | null> {
  return acquireModelRequestWithWait(ctx, kind, request, response, {
    queueTimeout: WEB_UI_MODEL_QUEUE_TIMEOUT,
    abortSignal,
    intent,
  });
}

export async function acquireModelRequestWithWait(
  ctx: ServerContext,
  kind: string,
  request?: IncomingMessage,
  response?: ServerResponse,
  options: ModelRequestWaitOptions = {},
): Promise<ModelRequestLock | null> {
  const queueTimeout = resolveModelRequestQueueTimeout(options.queueTimeout);
  if (options.abortSignal?.aborted) return null;
  ctx.modelIdleController?.clearForIncomingRequest();
  ctx.assistant?.onInteractiveRequest();
  logIncomingModelRequest(ctx, kind);
  clearIdleSummaryTimer(ctx);
  const initialQueueIndex = ctx.modelRequestQueue.length;
  let resolveWaiterLock: (resolvedLock: ModelRequestLock | null) => void = () => {};
  let rejectWaiterLock: (error: Error) => void = () => {};
  const waiterLockPromise = new Promise<ModelRequestLock | null>((resolve, reject) => {
    resolveWaiterLock = resolve;
    rejectWaiterLock = reject;
  });
  const waiter: ModelRequestWaiter = {
    queueToken: randomUUID(),
    kind: String(kind),
    ownerRunId: options.ownerRunId ?? null,
    enqueuedAtUtc: new Date().toISOString(),
    intent: options.intent ?? { presetId: null, model: null },
    resolution: null,
    cancelled: false,
    grantedLock: null,
    timeoutHandle: null,
    queueTimeout,
    lastQueueIndex: initialQueueIndex,
    resolveLock: resolveWaiterLock,
    rejectLock: rejectWaiterLock,
  };
  ctx.modelRequestQueue.push(waiter);
  syncInferenceRunFlushQueueModelState(ctx);
  const onAbortedRequest = (): void => {
    cancelModelRequestWaiter(ctx, waiter, 'client_cancelled');
  };
  const onAbortedOperation = (): void => { cancelModelRequestWaiter(ctx, waiter, 'operation_cancelled'); };
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
  options.abortSignal?.addEventListener('abort', onAbortedOperation, { once: true });
  if (options.abortSignal?.aborted) onAbortedOperation();
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
  requestModelRequestDrain(ctx);
  try {
    const granted = await waiterLockPromise;
    if (options.abortSignal?.aborted && granted) {
      releaseModelRequest(ctx, granted.token);
      return null;
    }
    return granted;
  } finally {
    options.abortSignal?.removeEventListener('abort', onAbortedOperation);
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
  clearModelRequestInactivityTimeout(releasedLock);
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
      requestModelRequestDrain(ctx);
      if (ctx.activeModelRequests.size === 0) armActivePresetIdle(ctx, finishedAtMs);
      syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
      scheduleIdleSummaryIfNeeded(ctx);
    }).catch((error) => {
      process.stderr.write(`[siftKitStatus] Backend transition failed: ${getErrorMessage(error)}\n`);
    });
  } else {
    requestModelRequestDrain(ctx);
    if (ctx.activeModelRequests.size === 0) armActivePresetIdle(ctx, finishedAtMs);
  }
  syncInferenceRunFlushQueueModelState(ctx, finishedAtMs);
  scheduleIdleSummaryIfNeeded(ctx);
  return true;
}

function armActivePresetIdle(ctx: ServerContext, finishedAtMs: number): void {
  // Only a coordinator can unload, and the applied state already holds the preset the
  // runtime is actually running — looking it back up in config would only reintroduce a
  // second source of truth that silently skips arming whenever the two drift.
  if (!ctx.presetRuntimeCoordinator) return;
  // Queued work keeps the model resident; a drain that settles with nothing running re-arms on exit.
  if (ctx.modelRequestQueue.length > 0) return;
  ctx.modelIdleController?.armAfterRequest(ctx.appliedModelPresetState.getPreset(), finishedAtMs);
}

export function resumeModelRequestAdmission(ctx: ServerContext): void {
  requestModelRequestDrain(ctx);
}
