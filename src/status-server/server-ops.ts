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
import { sleep } from '../lib/time.js';
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
  upsertRunArtifactPayload,
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
  logLine,
} from './managed-llama.js';

// ---------------------------------------------------------------------------
// Published status
// ---------------------------------------------------------------------------

export function hasPublishedActivity(ctx: ServerContext): boolean {
  return ctx.bootstrapManagedLlamaStartup
    || ctx.managedLlamaStarting
    || ctx.managedLlamaReady
    || hasActiveRuns(ctx)
    || ctx.idleSummaryPending;
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
  if (ctx.activeModelRequest || ctx.modelRequestQueue.length > 0) {
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

function removeModelRequestWaiter(ctx: ServerContext, queueToken: string): boolean {
  const index = ctx.modelRequestQueue.findIndex((entry) => entry.queueToken === queueToken);
  if (index < 0) {
    return false;
  }
  ctx.modelRequestQueue.splice(index, 1);
  return true;
}

export async function acquireModelRequestWithWait(
  ctx: ServerContext,
  kind: string,
  request?: http.IncomingMessage,
  response?: http.ServerResponse,
): Promise<ModelRequestLock | null> {
  let lock = acquireModelRequest(ctx, kind);
  if (lock) {
    return lock;
  }
  const waiter = {
    queueToken: crypto.randomUUID(),
    kind: String(kind),
    enqueuedAtUtc: new Date().toISOString(),
    cancelled: false,
  };
  ctx.modelRequestQueue.push(waiter);
  const cancelWaiter = (): void => {
    waiter.cancelled = true;
    removeModelRequestWaiter(ctx, waiter.queueToken);
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
  while (true) {
    if (response?.destroyed && !response.writableEnded) {
      cancelWaiter();
    }
    if (waiter.cancelled) {
      if (request) {
        request.off('aborted', onAbortedRequest);
        request.off('close', onClosedRequest);
      }
      if (response) {
        response.off('close', onClosedResponse);
      }
      return null;
    }
    if (!ctx.activeModelRequest && ctx.modelRequestQueue[0]?.queueToken === waiter.queueToken) {
      ctx.modelRequestQueue.shift();
      lock = {
        token: crypto.randomUUID(),
        kind: waiter.kind,
        startedAtUtc: new Date().toISOString(),
      };
      ctx.activeModelRequest = lock;
      if (request) {
        request.off('aborted', onAbortedRequest);
        request.off('close', onClosedRequest);
      }
      if (response) {
        response.off('close', onClosedResponse);
      }
      return lock;
    }
    await sleep(25);
  }
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
