/**
 * Core API routes: health, status, execution lease, repo-search, and config.
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { Dict } from '../../lib/types.js';
import { requestText } from '../../lib/http.js';
import { summarizeRequest } from '../../summary/core.js';
import type { SiftConfig } from '../../config/index.js';
import type {
  SummaryPolicyProfile,
  SummarySourceKind,
} from '../../summary/types.js';
import { mergeToolTypeStats } from '../../line-read-guidance.js';
import { getRuntimeRoot } from '../paths.js';
import { sleep } from '../../lib/time.js';
import { upsertRuntimeJsonArtifact } from '../../state/runtime-artifacts.js';
import {
  readBody,
  parseJsonBody,
  sendJson,
} from '../http-utils.js';
import { sendServerErrorJson } from '../error-response.js';
import {
  STATUS_TRUE,
  parseRunning,
  parseStatusMetadata,
  parseStatusMetadataRecord,
} from '../status-file.js';
import { normalizeMetrics, writeMetrics, type TaskKind, type ToolTypeStats } from '../metrics.js';
import {
  readConfig,
  writeConfig,
  normalizeConfig,
  mergeConfig,
} from '../config-store.js';
import { resolveEffectiveRepoFileListing } from './chat.js';
import {
  type RepoSearchProgressEvent,
  buildStatusRequestLogMessage,
  buildRepoSearchProgressLogMessage,
  getStatusArtifactPath,
  upsertRunArtifactPayload,
  updateRunLogSpeculativeMetricsByRequestId,
} from '../dashboard-runs.js';
import { loadRepoSearchExecutor } from '../chat.js';
import { RepoSearchResponseSanityChecker } from '../../repo-search/response-sanity.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaSpeculativeMetricsDelta,
  getManagedLlamaStartupFailure,
  logLine,
} from '../managed-llama.js';
import {
  getPublishedStatusText,
  writePublishedStatus,
  clearIdleSummaryTimer,
  scheduleIdleSummaryIfNeeded,
  getActiveExecutionLease,
  releaseExecutionLease,
  acquireModelRequestWithWait,
  releaseModelRequest,
  ensureManagedLlamaReadyForModelRequest,
  enqueueDeferredArtifacts,
  getResolvedRequestId,
  clearRunState,
  logAbandonedRun,
  hasActiveRuns,
  getIdleSummaryDatabase,
  wakeManagedLlamaForIncomingModelRequest,
  clearCompletedStatusRequestIdForDifferentRequest,
  rememberCompletedStatusRequestId,
} from '../server-ops.js';
import { getRuntimeDatabase } from '../../state/runtime-db.js';
import type {
  ActiveRunState,
  ServerContext,
  TerminalMetadataQueueItem,
} from '../server-types.js';

const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS = 240;

function normalizeTaskKind(value: unknown): TaskKind | null {
  return value === 'summary' || value === 'plan' || value === 'repo-search' || value === 'chat'
    ? value
    : null;
}

function normalizeSummaryFormat(value: unknown): 'text' | 'json' {
  return value === 'json' ? 'json' : 'text';
}

function normalizeSummaryPolicyProfile(value: unknown): SummaryPolicyProfile {
  return (
    value === 'pass-fail'
    || value === 'unique-errors'
    || value === 'buried-critical'
    || value === 'json-extraction'
    || value === 'diff-summary'
    || value === 'risky-operation'
  ) ? value : 'general';
}

function normalizeSummarySourceKind(value: unknown): SummarySourceKind {
  return value === 'command-output' ? 'command-output' : 'standalone';
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function getPositiveNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function getSummaryTiming(value: unknown): { processStartedAtMs?: number | null; stdinWaitMs?: number | null; serverPreflightMs?: number | null } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Dict;
  return {
    processStartedAtMs: getOptionalNumber(record.processStartedAtMs) ?? null,
    stdinWaitMs: getOptionalNumber(record.stdinWaitMs) ?? null,
    serverPreflightMs: getOptionalNumber(record.serverPreflightMs) ?? null,
  };
}

function isStrictConfigPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const payload = value as Dict;
  const topLevelRequired = [
    'Version',
    'Backend',
    'PolicyMode',
    'RawLogRetention',
    'IncludeRepoFileListing',
    'PromptPrefix',
    'LlamaCpp',
    'Runtime',
    'Thresholds',
    'Interactive',
    'Server',
  ];
  for (const key of topLevelRequired) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      return false;
    }
  }
  const runtime = payload.Runtime as Dict;
  const thresholds = payload.Thresholds as Dict;
  const interactive = payload.Interactive as Dict;
  const server = payload.Server as Dict;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    return false;
  }
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    return false;
  }
  if (!interactive || typeof interactive !== 'object' || Array.isArray(interactive)) {
    return false;
  }
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(runtime, 'Model')
    && Object.prototype.hasOwnProperty.call(runtime, 'LlamaCpp')
    && Object.prototype.hasOwnProperty.call(thresholds, 'MinCharactersForSummary')
    && Object.prototype.hasOwnProperty.call(thresholds, 'MinLinesForSummary')
    && Object.prototype.hasOwnProperty.call(interactive, 'Enabled')
    && Object.prototype.hasOwnProperty.call(interactive, 'WrappedCommands')
    && Object.prototype.hasOwnProperty.call(interactive, 'IdleTimeoutMs')
    && Object.prototype.hasOwnProperty.call(interactive, 'MaxTranscriptCharacters')
    && Object.prototype.hasOwnProperty.call(interactive, 'TranscriptRetention')
    && Object.prototype.hasOwnProperty.call(server, 'LlamaCpp');
}

function buildToolStatsLogMessages(taskKind: TaskKind, stats: Record<string, ToolTypeStats> | null): string[] {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    return [];
  }
  const lines: string[] = [];
  for (const [toolType, toolStats] of Object.entries(stats)) {
    const safeToolType = String(toolType || '').trim();
    if (!safeToolType) {
      continue;
    }
    lines.push(
      `tool_stats task=${taskKind} tool=${safeToolType} calls=${Math.max(0, Number(toolStats.calls || 0))}`
      + ` output_chars=${Math.max(0, Number(toolStats.outputCharsTotal || 0))}`
      + ` output_tokens=${Math.max(0, Number(toolStats.outputTokensTotal || 0))}`
      + ` output_tokens_estimated=${Math.max(0, Number(toolStats.outputTokensEstimatedCount || 0))}`,
    );
  }
  return lines;
}

type DeferredTerminalMetadataJob = {
  requestId: string;
  metadata: ReturnType<typeof parseStatusMetadata>;
  elapsedMs: number | null;
  totalElapsedMs: number | null;
  requestCompleted: boolean;
  suppressLogLine: boolean;
};

function applyDeferredTerminalMetadata(ctx: ServerContext, job: DeferredTerminalMetadataJob): void {
  const metadata = job.metadata;
  if (metadata.speculativeAcceptedTokens !== null || metadata.speculativeGeneratedTokens !== null) {
    updateRunLogSpeculativeMetricsByRequestId({
      database: getRuntimeDatabase(),
      requestId: job.requestId,
      speculativeAcceptedTokens: metadata.speculativeAcceptedTokens,
      speculativeGeneratedTokens: metadata.speculativeGeneratedTokens,
    });
  }
  const inputCharactersDelta = metadata.promptCharacterCount ?? 0;
  const outputCharactersDelta = metadata.outputCharacterCount ?? 0;
  const inputTokensDelta = metadata.inputTokens ?? 0;
  const outputTokensDelta = metadata.outputTokens ?? 0;
  const toolTokensDelta = metadata.toolTokens ?? 0;
  const thinkingTokensDelta = metadata.thinkingTokens ?? 0;
  const promptCacheTokensDelta = metadata.promptCacheTokens ?? 0;
  const promptEvalTokensDelta = metadata.promptEvalTokens ?? 0;
  const speculativeAcceptedTokensDelta = metadata.speculativeAcceptedTokens ?? 0;
  const speculativeGeneratedTokensDelta = metadata.speculativeGeneratedTokens ?? 0;
  const requestDurationMsDelta = metadata.requestDurationMs ?? 0;
  const wallDurationMsDelta = metadata.wallDurationMs ?? 0;
  const stdinWaitMsDelta = metadata.stdinWaitMs ?? 0;
  const serverPreflightMsDelta = metadata.serverPreflightMs ?? 0;
  const lockWaitMsDelta = metadata.lockWaitMs ?? 0;
  const statusRunningMsDelta = metadata.statusRunningMs ?? 0;
  const terminalStatusMsDelta = metadata.terminalStatusMs ?? 0;
  const completedRequestDelta = job.requestCompleted ? 1 : 0;
  const taskKind = normalizeTaskKind(metadata.taskKind);
  const taskTotals = {
    ...ctx.metrics.taskTotals,
  };
  const toolStats = {
    ...ctx.metrics.toolStats,
  };
  if (taskKind) {
    const previousTaskTotals = ctx.metrics.taskTotals[taskKind];
    taskTotals[taskKind] = {
      ...previousTaskTotals,
      inputCharactersTotal: previousTaskTotals.inputCharactersTotal + inputCharactersDelta,
      outputCharactersTotal: previousTaskTotals.outputCharactersTotal + outputCharactersDelta,
      inputTokensTotal: previousTaskTotals.inputTokensTotal + inputTokensDelta,
      outputTokensTotal: previousTaskTotals.outputTokensTotal + outputTokensDelta,
      toolTokensTotal: previousTaskTotals.toolTokensTotal + toolTokensDelta,
      thinkingTokensTotal: previousTaskTotals.thinkingTokensTotal + thinkingTokensDelta,
      promptCacheTokensTotal: previousTaskTotals.promptCacheTokensTotal + promptCacheTokensDelta,
      promptEvalTokensTotal: previousTaskTotals.promptEvalTokensTotal + promptEvalTokensDelta,
      speculativeAcceptedTokensTotal: previousTaskTotals.speculativeAcceptedTokensTotal + speculativeAcceptedTokensDelta,
      speculativeGeneratedTokensTotal: previousTaskTotals.speculativeGeneratedTokensTotal + speculativeGeneratedTokensDelta,
      requestDurationMsTotal: previousTaskTotals.requestDurationMsTotal + requestDurationMsDelta,
      wallDurationMsTotal: previousTaskTotals.wallDurationMsTotal + wallDurationMsDelta,
      stdinWaitMsTotal: previousTaskTotals.stdinWaitMsTotal + stdinWaitMsDelta,
      serverPreflightMsTotal: previousTaskTotals.serverPreflightMsTotal + serverPreflightMsDelta,
      lockWaitMsTotal: previousTaskTotals.lockWaitMsTotal + lockWaitMsDelta,
      statusRunningMsTotal: previousTaskTotals.statusRunningMsTotal + statusRunningMsDelta,
      terminalStatusMsTotal: previousTaskTotals.terminalStatusMsTotal + terminalStatusMsDelta,
      completedRequestCount: previousTaskTotals.completedRequestCount + completedRequestDelta,
    };
    toolStats[taskKind] = mergeToolTypeStats(
      ctx.metrics.toolStats[taskKind],
      metadata.toolStats,
    );
  }
  ctx.metrics = normalizeMetrics({
    ...ctx.metrics,
    inputCharactersTotal: ctx.metrics.inputCharactersTotal + inputCharactersDelta,
    outputCharactersTotal: ctx.metrics.outputCharactersTotal + outputCharactersDelta,
    inputTokensTotal: ctx.metrics.inputTokensTotal + inputTokensDelta,
    outputTokensTotal: ctx.metrics.outputTokensTotal + outputTokensDelta,
    toolTokensTotal: ctx.metrics.toolTokensTotal + toolTokensDelta,
    thinkingTokensTotal: ctx.metrics.thinkingTokensTotal + thinkingTokensDelta,
    promptCacheTokensTotal: ctx.metrics.promptCacheTokensTotal + promptCacheTokensDelta,
    promptEvalTokensTotal: ctx.metrics.promptEvalTokensTotal + promptEvalTokensDelta,
    speculativeAcceptedTokensTotal: ctx.metrics.speculativeAcceptedTokensTotal + speculativeAcceptedTokensDelta,
    speculativeGeneratedTokensTotal: ctx.metrics.speculativeGeneratedTokensTotal + speculativeGeneratedTokensDelta,
    requestDurationMsTotal: ctx.metrics.requestDurationMsTotal + requestDurationMsDelta,
    wallDurationMsTotal: ctx.metrics.wallDurationMsTotal + wallDurationMsDelta,
    stdinWaitMsTotal: ctx.metrics.stdinWaitMsTotal + stdinWaitMsDelta,
    serverPreflightMsTotal: ctx.metrics.serverPreflightMsTotal + serverPreflightMsDelta,
    lockWaitMsTotal: ctx.metrics.lockWaitMsTotal + lockWaitMsDelta,
    statusRunningMsTotal: ctx.metrics.statusRunningMsTotal + statusRunningMsDelta,
    terminalStatusMsTotal: ctx.metrics.terminalStatusMsTotal + terminalStatusMsDelta,
    completedRequestCount: ctx.metrics.completedRequestCount + completedRequestDelta,
    taskTotals,
    toolStats,
    updatedAtUtc: new Date().toISOString(),
  });
  writeMetrics(ctx.metricsPath, ctx.metrics);
  if (job.requestCompleted) {
    ctx.idleSummaryPending = true;
    scheduleIdleSummaryIfNeeded(ctx);
  }
  const logMessage = buildStatusRequestLogMessage({
    running: false,
    statusPath: ctx.statusPath,
    requestId: job.requestId,
    taskKind: metadata.taskKind,
    terminalState: metadata.terminalState,
    errorMessage: metadata.errorMessage,
    promptCharacterCount: metadata.promptCharacterCount,
    promptTokenCount: metadata.promptTokenCount,
    rawInputCharacterCount: metadata.rawInputCharacterCount,
    chunkInputCharacterCount: metadata.chunkInputCharacterCount,
    budgetSource: metadata.budgetSource,
    inputCharactersPerContextToken: metadata.inputCharactersPerContextToken,
    chunkThresholdCharacters: metadata.chunkThresholdCharacters,
    chunkIndex: metadata.chunkIndex,
    chunkTotal: metadata.chunkTotal,
    chunkPath: metadata.chunkPath,
    elapsedMs: job.elapsedMs,
    totalElapsedMs: job.totalElapsedMs,
    outputTokens: metadata.outputTokens,
    toolTokens: metadata.toolTokens,
    totalOutputTokens: metadata.totalOutputTokens ?? null,
  });
  if (!job.suppressLogLine) {
    logLine(logMessage);
  }
  if (taskKind && metadata.toolStats) {
    for (const toolLogLine of buildToolStatsLogMessages(taskKind, metadata.toolStats)) {
      logLine(toolLogLine);
    }
  }
}

function scheduleDeferredTerminalMetadata(ctx: ServerContext, job: DeferredTerminalMetadataJob): void {
  const timer = setTimeout(() => {
    applyDeferredTerminalMetadata(ctx, job);
  }, 25);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function getTerminalMetadataIdleWaitMs(ctx: ServerContext, fallbackStartedAtMs: number): number {
  if (ctx.activeModelRequest || ctx.modelRequestQueue.length > 0) {
    return Math.max(1, Math.min(1000, ctx.terminalMetadataIdleDelayMs || 1000));
  }
  const lastFinishedAtMs = ctx.terminalMetadataLastModelRequestFinishedAtMs ?? fallbackStartedAtMs;
  const idleWaitMs = Math.max(0, ctx.terminalMetadataIdleDelayMs - (Date.now() - lastFinishedAtMs));
  if (idleWaitMs > 0) {
    return idleWaitMs;
  }
  if (!ctx.managedLlamaFlushQueue.isIdle()) {
    return Math.max(1, Math.min(1000, ctx.terminalMetadataIdleDelayMs || 1000));
  }
  return 0;
}

function scheduleTerminalMetadataDrain(ctx: ServerContext, delayMs: number = 0): void {
  if (ctx.terminalMetadataDrainScheduled || ctx.terminalMetadataDrainRunning || ctx.terminalMetadataQueue.length === 0) {
    return;
  }
  ctx.terminalMetadataDrainScheduled = true;
  const timer = setTimeout(() => {
    drainTerminalMetadataQueue(ctx);
  }, Math.max(0, Math.trunc(delayMs)));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function enqueueTerminalMetadata(ctx: ServerContext, item: TerminalMetadataQueueItem): void {
  ctx.terminalMetadataQueue.push(item);
  logLine(
    `status terminal_metadata_enqueued request_id=${item.requestId} state=${item.terminalState} `
    + `queue_length=${ctx.terminalMetadataQueue.length}`,
  );
  scheduleTerminalMetadataDrain(ctx);
}

function processTerminalMetadataBody(ctx: ServerContext, item: TerminalMetadataQueueItem): void {
  const metadata = parseStatusMetadata(item.bodyText);
  const deferredMetadata = metadata.deferredMetadata
    ? parseStatusMetadataRecord(metadata.deferredMetadata)
    : null;
  if (deferredMetadata) {
    deferredMetadata.requestId = metadata.requestId ?? deferredMetadata.requestId;
    deferredMetadata.taskKind = metadata.taskKind ?? deferredMetadata.taskKind;
    deferredMetadata.terminalState = metadata.terminalState ?? deferredMetadata.terminalState;
    deferredMetadata.errorMessage = deferredMetadata.errorMessage ?? metadata.errorMessage;
  }
  const requestId = getResolvedRequestId(metadata, ctx.statusPath);
  let elapsedMs: number | null = null;
  let totalElapsedMs: number | null = null;
  let requestCompleted = false;
  let suppressLogLine = false;
  const runState: ActiveRunState | null = ctx.activeRunsByRequestId.get(requestId) || null;
  const targetMetadata = deferredMetadata ?? metadata;
  if (runState && Number.isFinite(runState.currentRequestStartedAt)) {
    const resolvedOutputTokens = targetMetadata.outputTokens ?? 0;
    const isSingleStepNonChunk = runState.stepCount === 1
      && runState.chunkIndex === null
      && runState.chunkTotal === null
      && runState.chunkPath === null;
    suppressLogLine = metadata.terminalState === null && isSingleStepNonChunk;
    elapsedMs = item.capturedAtMs - runState.currentRequestStartedAt;
    runState.outputTokensTotal += resolvedOutputTokens;
    if (targetMetadata.rawInputCharacterCount === null && runState.rawInputCharacterCount !== null) {
      targetMetadata.rawInputCharacterCount = runState.rawInputCharacterCount;
    }
    if (targetMetadata.promptCharacterCount === null && runState.promptCharacterCount !== null) {
      targetMetadata.promptCharacterCount = runState.promptCharacterCount;
    }
    if (targetMetadata.promptTokenCount === null && runState.promptTokenCount !== null) {
      targetMetadata.promptTokenCount = runState.promptTokenCount;
    }
    if (targetMetadata.chunkIndex === null && runState.chunkIndex !== null) {
      targetMetadata.chunkIndex = runState.chunkIndex;
    }
    if (targetMetadata.chunkTotal === null && runState.chunkTotal !== null) {
      targetMetadata.chunkTotal = runState.chunkTotal;
    }
    if (targetMetadata.chunkPath === null && runState.chunkPath !== null) {
      targetMetadata.chunkPath = runState.chunkPath;
    }
    const speculativeMetrics = getManagedLlamaSpeculativeMetricsDelta(
      ctx.managedLlamaLastStartupLogs,
      runState.managedLlamaSpeculativeSnapshot,
    );
    if (speculativeMetrics) {
      targetMetadata.speculativeAcceptedTokens = speculativeMetrics.speculativeAcceptedTokens;
      targetMetadata.speculativeGeneratedTokens = speculativeMetrics.speculativeGeneratedTokens;
    }
    if (metadata.terminalState === 'completed') {
      totalElapsedMs = item.capturedAtMs - runState.overallStartedAt;
      targetMetadata.totalOutputTokens = runState.outputTokensTotal;
      clearRunState(ctx, requestId);
      requestCompleted = true;
    } else if (metadata.terminalState === 'failed') {
      totalElapsedMs = item.capturedAtMs - runState.overallStartedAt;
      clearRunState(ctx, requestId);
    }
  }
  applyDeferredTerminalMetadata(ctx, {
    requestId,
    metadata: targetMetadata,
    elapsedMs,
    totalElapsedMs,
    requestCompleted,
    suppressLogLine,
  });
  writePublishedStatus(ctx, getPublishedStatusText(ctx));
  if (metadata.deferredArtifacts) {
    enqueueDeferredArtifacts(ctx, metadata.deferredArtifacts);
  }
}

function drainTerminalMetadataQueue(ctx: ServerContext): void {
  if (ctx.terminalMetadataDrainRunning) {
    return;
  }
  ctx.terminalMetadataDrainScheduled = false;
  const nextItem = ctx.terminalMetadataQueue[0] || null;
  if (!nextItem) {
    return;
  }
  const waitMs = getTerminalMetadataIdleWaitMs(ctx, nextItem.capturedAtMs);
  if (waitMs > 0) {
    logLine(
      `status terminal_metadata_drain_wait request_id=${nextItem.requestId} state=${nextItem.terminalState} `
      + `wait_ms=${Math.max(1, Math.trunc(waitMs))} active=${ctx.activeModelRequest ? 'true' : 'false'} `
      + `queue_length=${ctx.terminalMetadataQueue.length} model_queue_length=${ctx.modelRequestQueue.length}`,
    );
    scheduleTerminalMetadataDrain(ctx, waitMs);
    return;
  }
  ctx.terminalMetadataDrainRunning = true;
  const item = ctx.terminalMetadataQueue.shift();
  if (!item) {
    ctx.terminalMetadataDrainRunning = false;
    return;
  }
  const startedAt = Date.now();
  logLine(`status terminal_metadata_process_start request_id=${item.requestId} state=${item.terminalState}`);
  try {
    processTerminalMetadataBody(ctx, item);
    logLine(
      `status terminal_metadata_process_done request_id=${item.requestId} state=${item.terminalState} `
      + `duration_ms=${Date.now() - startedAt}`,
    );
  } catch (error) {
    logLine(
      `status terminal_metadata_process_failed request_id=${item.requestId} state=${item.terminalState} `
      + `duration_ms=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    ctx.terminalMetadataDrainRunning = false;
    if (ctx.terminalMetadataQueue.length > 0) {
      scheduleTerminalMetadataDrain(ctx);
    }
  }
}

export async function handleCoreRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
  const requestUrl = new URL(req.url || '/', 'http://localhost');

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && req.url === '/health') {
    const startupPending = Boolean(ctx.bootstrapManagedLlamaStartup || ctx.managedLlamaStarting || ctx.managedLlamaStartupPromise);
    sendJson(res, startupPending ? 503 : 200, {
      ok: !startupPending,
      startupPending,
      disableManagedLlamaStartup,
      statusPath,
      configPath,
      metricsPath,
      idleSummarySnapshotsPath: ctx.idleSummarySnapshotsPath,
      runtimeRoot: getRuntimeRoot(),
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Status (GET)
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && req.url === '/status') {
    const currentStatus = getPublishedStatusText(ctx);
    sendJson(res, 200, { running: currentStatus === STATUS_TRUE, status: currentStatus, statusPath, configPath, metrics: ctx.metrics, idleSummarySnapshotsPath: ctx.idleSummarySnapshotsPath });
    return true;
  }

  // -------------------------------------------------------------------------
  // Execution lease
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && req.url === '/execution') {
    const lease = getActiveExecutionLease(ctx);
    sendJson(res, 200, { busy: Boolean(lease), statusPath, configPath });
    return true;
  }

  if (req.method === 'POST' && req.url === '/execution/acquire') {
    clearIdleSummaryTimer(ctx);
    const lease = getActiveExecutionLease(ctx);
    if (lease) {
      sendJson(res, 200, { ok: true, acquired: false, busy: true });
      return true;
    }
    const token = crypto.randomUUID();
    ctx.activeExecutionLease = { token, heartbeatAt: Date.now() };
    sendJson(res, 200, { ok: true, acquired: true, busy: true, token });
    return true;
  }

  if (req.method === 'POST' && req.url === '/execution/heartbeat') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.token !== 'string' || !(parsedBody.token as string).trim()) {
      sendJson(res, 400, { error: 'Expected token.' });
      return true;
    }
    const lease = getActiveExecutionLease(ctx);
    if (!lease || lease.token !== parsedBody.token) {
      sendJson(res, 409, { error: 'Execution lease is not active.' });
      return true;
    }
    lease.heartbeatAt = Date.now();
    sendJson(res, 200, { ok: true, busy: true });
    return true;
  }

  if (req.method === 'POST' && req.url === '/execution/release') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.token !== 'string' || !(parsedBody.token as string).trim()) {
      sendJson(res, 400, { error: 'Expected token.' });
      return true;
    }
    const released = releaseExecutionLease(ctx, parsedBody.token as string);
    sendJson(res, released ? 200 : 409, { ok: released, released, busy: Boolean(getActiveExecutionLease(ctx)) });
    return true;
  }

  // -------------------------------------------------------------------------
  // Repo search (top-level, non-session)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && req.url === '/repo-search') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.prompt !== 'string' || !(parsedBody.prompt as string).trim()) {
      sendJson(res, 400, { error: 'Expected prompt.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'repo_search', req, res);
    if (!modelRequestLock) {
      return true;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'repo-search' });
        return true;
      }
      if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
        await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
      }
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const config = readConfig(configPath);
      const result = await executeRepoSearchRequest({
        taskKind: 'repo-search',
        prompt: parsedBody.prompt,
        promptPrefix: typeof parsedBody.promptPrefix === 'string' ? (parsedBody.promptPrefix as string) : undefined,
        repoRoot: typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim() ? (parsedBody.repoRoot as string).trim() : process.cwd(),
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        allowedTools: Array.isArray(parsedBody.allowedTools) ? (parsedBody.allowedTools as unknown[]).map((value) => String(value)) : undefined,
        includeRepoFileListing: resolveEffectiveRepoFileListing(config, null),
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
        availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
        mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'tool_start') {
            const logMessage = buildRepoSearchProgressLogMessage(event, 'repo_search');
            if (logMessage) logLine(logMessage);
          }
        },
      });
      RepoSearchResponseSanityChecker.assertSafeToSend(result);
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'repo-search' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Summary (top-level)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && req.url === '/summary') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const question = getOptionalString(parsedBody.question);
    if (!question) {
      sendJson(res, 400, { error: 'Expected question.' });
      return true;
    }
    const inputText = typeof parsedBody.inputText === 'string' ? parsedBody.inputText : '';
    if (!inputText.trim()) {
      sendJson(res, 400, { error: 'Expected inputText.' });
      return true;
    }

    const serviceBaseUrl = ctx.getServiceBaseUrl();
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      return true;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return true;
      }
      const result = await summarizeRequest({
        question,
        inputText,
        format: normalizeSummaryFormat(parsedBody.format),
        policyProfile: normalizeSummaryPolicyProfile(parsedBody.policyProfile),
        backend: getOptionalString(parsedBody.backend),
        model: getOptionalString(parsedBody.model),
        sourceKind: normalizeSummarySourceKind(parsedBody.sourceKind),
        commandExitCode: getOptionalNumber(parsedBody.commandExitCode),
        requestTimeoutSeconds: getPositiveNumber(parsedBody.requestTimeoutSeconds, DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS),
        timing: getSummaryTiming(parsedBody.timing),
        statusBackendUrl: `${serviceBaseUrl}/status`,
        skipExecutionLock: true,
        config: readConfig(configPath) as SiftConfig,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return true;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/status/complete') {
    const routeStartedAt = Date.now();
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const requestId = typeof parsedBody.requestId === 'string' ? parsedBody.requestId.trim() : '';
    const terminalState = typeof parsedBody.terminalState === 'string' ? parsedBody.terminalState.trim() : '';
    const completedStatusPath = statusPath;
    if (!requestId) {
      sendJson(res, 400, { error: 'Expected requestId.' });
      return true;
    }
    if (terminalState !== 'completed' && terminalState !== 'failed') {
      sendJson(res, 400, { error: 'Expected terminalState=completed|failed.' });
      return true;
    }
    logLine(`status complete_start request_id=${requestId} state=${terminalState}`);
    rememberCompletedStatusRequestId(ctx, completedStatusPath, requestId);
    if (ctx.activeRequestIdByStatusPath.get(completedStatusPath) === requestId) {
      ctx.activeRequestIdByStatusPath.delete(completedStatusPath);
    }
    writePublishedStatus(ctx, getPublishedStatusText(ctx));
    logLine(
      `status complete_done request_id=${requestId} state=${terminalState} `
      + `duration_ms=${Date.now() - routeStartedAt}`,
    );
    sendJson(res, 200, { ok: true, requestId, terminalState, statusPath: completedStatusPath });
    return true;
  }

  // -------------------------------------------------------------------------
  // Status (POST)
  // -------------------------------------------------------------------------

  if (
    req.method === 'POST'
    && (req.url === '/status' || requestUrl.pathname === '/status/terminal-metadata')
  ) {
    const terminalMetadataPost = requestUrl.pathname === '/status/terminal-metadata';
    const bodyText = await readBody(req);
    const running = parseRunning(bodyText);
    if (running === null) {
      sendJson(res, 400, { error: 'Expected running=true|false or status=true|false.' });
      return true;
    }
    const metadata = parseStatusMetadata(bodyText);
    if (!terminalMetadataPost && !running && metadata.terminalState !== null) {
      sendJson(res, 400, { error: 'Terminal status must use /status/complete and /status/terminal-metadata.' });
      return true;
    }
    if (terminalMetadataPost && running) {
      sendJson(res, 400, { error: 'Terminal metadata requires running=false.' });
      return true;
    }
    if (
      terminalMetadataPost
      && metadata.terminalState !== 'completed'
      && metadata.terminalState !== 'failed'
    ) {
      sendJson(res, 400, { error: 'Terminal metadata requires terminalState=completed|failed.' });
      return true;
    }
    const deferredMetadata = metadata.deferredMetadata
      ? parseStatusMetadataRecord(metadata.deferredMetadata)
      : null;
    if (deferredMetadata) {
      deferredMetadata.requestId = metadata.requestId ?? deferredMetadata.requestId;
      deferredMetadata.taskKind = metadata.taskKind ?? deferredMetadata.taskKind;
      deferredMetadata.terminalState = metadata.terminalState ?? deferredMetadata.terminalState;
      deferredMetadata.errorMessage = deferredMetadata.errorMessage ?? metadata.errorMessage;
    }
    if (deferredMetadata && (running || metadata.terminalState === null)) {
      sendJson(res, 400, { error: 'deferredMetadata is only accepted on terminal running=false posts.' });
      return true;
    }
    if (metadata.deferredArtifacts && (running || metadata.terminalState === null)) {
      sendJson(res, 400, { error: 'deferredArtifacts are only accepted on terminal running=false posts.' });
      return true;
    }
    if (terminalMetadataPost) {
      const requestId = getResolvedRequestId(metadata, statusPath);
      enqueueTerminalMetadata(ctx, {
        requestId,
        terminalState: metadata.terminalState as 'completed' | 'failed',
        bodyText,
        capturedAtMs: Date.now(),
      });
      const publishedStatus = getPublishedStatusText(ctx);
      sendJson(res, 200, { ok: true, queued: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
      return true;
    }
    if (metadata.artifactType !== null) {
      if (!metadata.artifactRequestId) {
        sendJson(res, 400, { error: 'Expected artifactRequestId when artifactType is provided.' });
        return true;
      }
      if (!metadata.artifactPayload) {
        sendJson(res, 400, { error: 'Expected artifactPayload object when artifactType is provided.' });
        return true;
      }
      const artifactPath = getStatusArtifactPath(metadata);
      if (!artifactPath) {
        sendJson(res, 400, { error: 'Unsupported artifactType.' });
        return true;
      }
      try {
        upsertRuntimeJsonArtifact({
          id: `status:${metadata.artifactType}:${metadata.artifactRequestId}`,
          artifactKind: `status_${metadata.artifactType}`,
          requestId: metadata.artifactRequestId,
          title: artifactPath,
          payload: metadata.artifactPayload,
        });
        upsertRunArtifactPayload({
          database: getIdleSummaryDatabase(ctx),
          requestId: metadata.artifactRequestId,
          artifactType: metadata.artifactType as 'summary_request' | 'planner_debug' | 'planner_failed' | 'request_abandoned',
          artifactPayload: metadata.artifactPayload,
        });
      } catch (error) {
        sendServerErrorJson(req, res, 500, error, {
          taskKind: metadata.taskKind ?? null,
          requestId: metadata.requestId ?? null,
        });
        return true;
      }
    }
    const isArtifactOnlyPost = metadata.artifactType !== null
      && metadata.terminalState === null
      && metadata.errorMessage === null
      && metadata.taskKind === null
      && metadata.promptCharacterCount === null
      && metadata.promptTokenCount === null
      && metadata.rawInputCharacterCount === null
      && metadata.chunkInputCharacterCount === null
      && metadata.chunkIndex === null
      && metadata.chunkTotal === null
      && metadata.chunkPath === null
      && metadata.inputTokens === null
      && metadata.outputCharacterCount === null
      && metadata.outputTokens === null
      && metadata.toolTokens === null
      && metadata.thinkingTokens === null
      && metadata.toolStats === null
      && metadata.promptCacheTokens === null
      && metadata.promptEvalTokens === null
      && metadata.speculativeAcceptedTokens === null
      && metadata.speculativeGeneratedTokens === null
      && deferredMetadata === null
      && metadata.deferredArtifacts === null
      && metadata.requestDurationMs === null;
    if (isArtifactOnlyPost) {
      const publishedStatus = getPublishedStatusText(ctx);
      sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
      return true;
    }
    const requestId = getResolvedRequestId(metadata, statusPath);
    clearCompletedStatusRequestIdForDifferentRequest(ctx, statusPath, requestId);
    if (running && ctx.completedRequestIdByStatusPath.get(statusPath) === requestId) {
      logLine(`request late_running_ignored request_id=${requestId} task=${metadata.taskKind ?? 'unknown'}`);
      const publishedStatus = getPublishedStatusText(ctx);
      sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
      return true;
    }
    if (running && normalizeTaskKind(metadata.taskKind) !== null && !ctx.activeModelRequest) {
      wakeManagedLlamaForIncomingModelRequest(ctx);
    }
    let elapsedMs: number | null = null;
    let totalElapsedMs: number | null = null;
    let requestCompleted = false;
    let suppressLogLine = false;
    let runState: ActiveRunState | null = ctx.activeRunsByRequestId.get(requestId) || null;
    if (running) {
      clearIdleSummaryTimer(ctx);
      const now = Date.now();
      const activeRequestId = ctx.activeRequestIdByStatusPath.get(statusPath) || null;
      const activeRun = activeRequestId ? ctx.activeRunsByRequestId.get(activeRequestId) || null : null;
      if (metadata.inputCharactersPerContextToken !== null) {
        ctx.pendingIdleSummaryMetadata.inputCharactersPerContextToken = metadata.inputCharactersPerContextToken;
      }
      if (metadata.chunkThresholdCharacters !== null) {
        ctx.pendingIdleSummaryMetadata.chunkThresholdCharacters = metadata.chunkThresholdCharacters;
      }
      if (activeRun && activeRequestId !== requestId) {
        // Status is observational; the model request queue owns admission control.
        logLine(
          `request stale_status_abandoned active_request_id=${activeRequestId} incoming_request_id=${requestId} `
          + `lock_task=${ctx.activeModelRequest?.kind ?? 'none'}`,
        );
        logAbandonedRun(ctx, activeRun, now);
        clearRunState(ctx, activeRequestId);
      }
      runState = ctx.activeRunsByRequestId.get(requestId) || null;
      if (!runState) {
        runState = {
          requestId,
          statusPath,
          overallStartedAt: now,
          currentRequestStartedAt: now,
          stepCount: 1,
          rawInputCharacterCount: metadata.rawInputCharacterCount,
          promptCharacterCount: metadata.promptCharacterCount,
          promptTokenCount: metadata.promptTokenCount,
          outputTokensTotal: 0,
          chunkIndex: metadata.chunkIndex,
          chunkTotal: metadata.chunkTotal,
          chunkPath: metadata.chunkPath,
          managedLlamaSpeculativeSnapshot: null,
        };
      } else {
        runState.currentRequestStartedAt = now;
        runState.stepCount = Number.isFinite(runState.stepCount) ? runState.stepCount + 1 : 1;
        if (runState.rawInputCharacterCount === null && metadata.rawInputCharacterCount !== null) {
          runState.rawInputCharacterCount = metadata.rawInputCharacterCount;
        }
        if (metadata.promptCharacterCount !== null) {
          runState.promptCharacterCount = metadata.promptCharacterCount;
        }
        if (metadata.promptTokenCount !== null) {
          runState.promptTokenCount = metadata.promptTokenCount;
        }
        if (metadata.chunkIndex !== null) {
          runState.chunkIndex = metadata.chunkIndex;
        }
        if (metadata.chunkTotal !== null) {
          runState.chunkTotal = metadata.chunkTotal;
        }
        if (metadata.chunkPath !== null) {
          runState.chunkPath = metadata.chunkPath;
        }
      }
      runState.managedLlamaSpeculativeSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot(ctx.managedLlamaLastStartupLogs);
      ctx.activeRunsByRequestId.set(requestId, runState);
      ctx.activeRequestIdByStatusPath.set(statusPath, requestId);
    } else {
      if (deferredMetadata && metadata.terminalState !== null) {
        let requestCompletedFromQueue = false;
        let queuedElapsedMs: number | null = null;
        let queuedTotalElapsedMs: number | null = null;
        if (runState && Number.isFinite(runState.currentRequestStartedAt)) {
          const now = Date.now();
          const resolvedOutputTokens = deferredMetadata.outputTokens ?? 0;
          const isSingleStepNonChunk = runState.stepCount === 1
            && runState.chunkIndex === null
            && runState.chunkTotal === null
            && runState.chunkPath === null;
          suppressLogLine = metadata.terminalState === null && isSingleStepNonChunk;
          queuedElapsedMs = now - runState.currentRequestStartedAt;
          runState.outputTokensTotal += resolvedOutputTokens;
          if (deferredMetadata.rawInputCharacterCount === null && runState.rawInputCharacterCount !== null) {
            deferredMetadata.rawInputCharacterCount = runState.rawInputCharacterCount;
          }
          if (deferredMetadata.promptCharacterCount === null && runState.promptCharacterCount !== null) {
            deferredMetadata.promptCharacterCount = runState.promptCharacterCount;
          }
          if (deferredMetadata.promptTokenCount === null && runState.promptTokenCount !== null) {
            deferredMetadata.promptTokenCount = runState.promptTokenCount;
          }
          if (deferredMetadata.chunkIndex === null && runState.chunkIndex !== null) {
            deferredMetadata.chunkIndex = runState.chunkIndex;
          }
          if (deferredMetadata.chunkTotal === null && runState.chunkTotal !== null) {
            deferredMetadata.chunkTotal = runState.chunkTotal;
          }
          if (deferredMetadata.chunkPath === null && runState.chunkPath !== null) {
            deferredMetadata.chunkPath = runState.chunkPath;
          }
          const speculativeMetrics = getManagedLlamaSpeculativeMetricsDelta(
            ctx.managedLlamaLastStartupLogs,
            runState.managedLlamaSpeculativeSnapshot,
          );
          if (speculativeMetrics) {
            deferredMetadata.speculativeAcceptedTokens = speculativeMetrics.speculativeAcceptedTokens;
            deferredMetadata.speculativeGeneratedTokens = speculativeMetrics.speculativeGeneratedTokens;
          }
          if (metadata.terminalState === 'completed') {
            queuedTotalElapsedMs = now - runState.overallStartedAt;
            deferredMetadata.totalOutputTokens = runState.outputTokensTotal;
            clearRunState(ctx, requestId);
            requestCompletedFromQueue = true;
          } else if (metadata.terminalState === 'failed') {
            queuedTotalElapsedMs = now - runState.overallStartedAt;
            clearRunState(ctx, requestId);
          }
        }
        scheduleDeferredTerminalMetadata(ctx, {
          requestId,
          metadata: deferredMetadata,
          elapsedMs: queuedElapsedMs,
          totalElapsedMs: queuedTotalElapsedMs,
          requestCompleted: requestCompletedFromQueue,
          suppressLogLine,
        });
      } else {
      if (runState && Number.isFinite(runState.currentRequestStartedAt)) {
        const now = Date.now();
        const resolvedOutputTokens = metadata.outputTokens ?? 0;
        const isSingleStepNonChunk = runState.stepCount === 1
          && runState.chunkIndex === null
          && runState.chunkTotal === null
          && runState.chunkPath === null;
        suppressLogLine = metadata.terminalState === null && isSingleStepNonChunk;
        elapsedMs = now - runState.currentRequestStartedAt;
        runState.outputTokensTotal += resolvedOutputTokens;
        if (metadata.rawInputCharacterCount === null && runState.rawInputCharacterCount !== null) {
          metadata.rawInputCharacterCount = runState.rawInputCharacterCount;
        }
        if (metadata.promptCharacterCount === null && runState.promptCharacterCount !== null) {
          metadata.promptCharacterCount = runState.promptCharacterCount;
        }
        if (metadata.promptTokenCount === null && runState.promptTokenCount !== null) {
          metadata.promptTokenCount = runState.promptTokenCount;
        }
        if (metadata.chunkIndex === null && runState.chunkIndex !== null) {
          metadata.chunkIndex = runState.chunkIndex;
        }
        if (metadata.chunkTotal === null && runState.chunkTotal !== null) {
          metadata.chunkTotal = runState.chunkTotal;
        }
        if (metadata.chunkPath === null && runState.chunkPath !== null) {
          metadata.chunkPath = runState.chunkPath;
        }
        const speculativeMetrics = getManagedLlamaSpeculativeMetricsDelta(
          ctx.managedLlamaLastStartupLogs,
          runState.managedLlamaSpeculativeSnapshot,
        );
        if (speculativeMetrics) {
          metadata.speculativeAcceptedTokens = speculativeMetrics.speculativeAcceptedTokens;
          metadata.speculativeGeneratedTokens = speculativeMetrics.speculativeGeneratedTokens;
        }
        if (metadata.terminalState === null) {
          runState.managedLlamaSpeculativeSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot(ctx.managedLlamaLastStartupLogs);
        }
        if (metadata.speculativeAcceptedTokens !== null || metadata.speculativeGeneratedTokens !== null) {
          updateRunLogSpeculativeMetricsByRequestId({
            database: getRuntimeDatabase(),
            requestId,
            speculativeAcceptedTokens: metadata.speculativeAcceptedTokens,
            speculativeGeneratedTokens: metadata.speculativeGeneratedTokens,
          });
        }
        if (metadata.terminalState === 'completed') {
          totalElapsedMs = now - runState.overallStartedAt;
          metadata.totalOutputTokens = runState.outputTokensTotal;
          clearRunState(ctx, requestId);
          requestCompleted = true;
        } else if (metadata.terminalState === 'failed') {
          totalElapsedMs = now - runState.overallStartedAt;
          clearRunState(ctx, requestId);
        }
      }
      if (!runState && (metadata.speculativeAcceptedTokens !== null || metadata.speculativeGeneratedTokens !== null)) {
        updateRunLogSpeculativeMetricsByRequestId({
          database: getRuntimeDatabase(),
          requestId,
          speculativeAcceptedTokens: metadata.speculativeAcceptedTokens,
          speculativeGeneratedTokens: metadata.speculativeGeneratedTokens,
        });
      }
      const inputCharactersDelta = metadata.promptCharacterCount ?? 0;
      const outputCharactersDelta = metadata.outputCharacterCount ?? 0;
      const inputTokensDelta = metadata.inputTokens ?? 0;
      const outputTokensDelta = metadata.outputTokens ?? 0;
      const toolTokensDelta = metadata.toolTokens ?? 0;
      const thinkingTokensDelta = metadata.thinkingTokens ?? 0;
      const promptCacheTokensDelta = metadata.promptCacheTokens ?? 0;
      const promptEvalTokensDelta = metadata.promptEvalTokens ?? 0;
      const speculativeAcceptedTokensDelta = metadata.speculativeAcceptedTokens ?? 0;
      const speculativeGeneratedTokensDelta = metadata.speculativeGeneratedTokens ?? 0;
      const requestDurationMsDelta = (
        metadata.requestDurationMs
        ?? (metadata.terminalState ? 0 : (elapsedMs ?? 0))
      );
      const wallDurationMsDelta = metadata.wallDurationMs ?? 0;
      const stdinWaitMsDelta = metadata.stdinWaitMs ?? 0;
      const serverPreflightMsDelta = metadata.serverPreflightMs ?? 0;
      const lockWaitMsDelta = metadata.lockWaitMs ?? 0;
      const statusRunningMsDelta = metadata.statusRunningMs ?? 0;
      const terminalStatusMsDelta = metadata.terminalStatusMs ?? 0;
      const completedRequestDelta = requestCompleted ? 1 : 0;
      const taskKind = normalizeTaskKind(metadata.taskKind);
      const taskTotals = {
        ...ctx.metrics.taskTotals,
      };
      const toolStats = {
        ...ctx.metrics.toolStats,
      };
      if (taskKind) {
        const previousTaskTotals = ctx.metrics.taskTotals[taskKind];
        taskTotals[taskKind] = {
          ...previousTaskTotals,
          inputCharactersTotal: previousTaskTotals.inputCharactersTotal + inputCharactersDelta,
          outputCharactersTotal: previousTaskTotals.outputCharactersTotal + outputCharactersDelta,
          inputTokensTotal: previousTaskTotals.inputTokensTotal + inputTokensDelta,
          outputTokensTotal: previousTaskTotals.outputTokensTotal + outputTokensDelta,
          toolTokensTotal: previousTaskTotals.toolTokensTotal + toolTokensDelta,
          thinkingTokensTotal: previousTaskTotals.thinkingTokensTotal + thinkingTokensDelta,
          promptCacheTokensTotal: previousTaskTotals.promptCacheTokensTotal + promptCacheTokensDelta,
          promptEvalTokensTotal: previousTaskTotals.promptEvalTokensTotal + promptEvalTokensDelta,
          speculativeAcceptedTokensTotal: previousTaskTotals.speculativeAcceptedTokensTotal + speculativeAcceptedTokensDelta,
          speculativeGeneratedTokensTotal: previousTaskTotals.speculativeGeneratedTokensTotal + speculativeGeneratedTokensDelta,
          requestDurationMsTotal: previousTaskTotals.requestDurationMsTotal + requestDurationMsDelta,
          wallDurationMsTotal: previousTaskTotals.wallDurationMsTotal + wallDurationMsDelta,
          stdinWaitMsTotal: previousTaskTotals.stdinWaitMsTotal + stdinWaitMsDelta,
          serverPreflightMsTotal: previousTaskTotals.serverPreflightMsTotal + serverPreflightMsDelta,
          lockWaitMsTotal: previousTaskTotals.lockWaitMsTotal + lockWaitMsDelta,
          statusRunningMsTotal: previousTaskTotals.statusRunningMsTotal + statusRunningMsDelta,
          terminalStatusMsTotal: previousTaskTotals.terminalStatusMsTotal + terminalStatusMsDelta,
          completedRequestCount: previousTaskTotals.completedRequestCount + completedRequestDelta,
        };
        toolStats[taskKind] = mergeToolTypeStats(
          ctx.metrics.toolStats[taskKind],
          metadata.toolStats,
        );
      }
      ctx.metrics = normalizeMetrics({
        ...ctx.metrics,
        inputCharactersTotal: ctx.metrics.inputCharactersTotal + inputCharactersDelta,
        outputCharactersTotal: ctx.metrics.outputCharactersTotal + outputCharactersDelta,
        inputTokensTotal: ctx.metrics.inputTokensTotal + inputTokensDelta,
        outputTokensTotal: ctx.metrics.outputTokensTotal + outputTokensDelta,
        toolTokensTotal: ctx.metrics.toolTokensTotal + toolTokensDelta,
        thinkingTokensTotal: ctx.metrics.thinkingTokensTotal + thinkingTokensDelta,
        promptCacheTokensTotal: ctx.metrics.promptCacheTokensTotal + promptCacheTokensDelta,
        promptEvalTokensTotal: ctx.metrics.promptEvalTokensTotal + promptEvalTokensDelta,
        speculativeAcceptedTokensTotal: ctx.metrics.speculativeAcceptedTokensTotal + speculativeAcceptedTokensDelta,
        speculativeGeneratedTokensTotal: ctx.metrics.speculativeGeneratedTokensTotal + speculativeGeneratedTokensDelta,
        requestDurationMsTotal: ctx.metrics.requestDurationMsTotal + requestDurationMsDelta,
        wallDurationMsTotal: ctx.metrics.wallDurationMsTotal + wallDurationMsDelta,
        stdinWaitMsTotal: ctx.metrics.stdinWaitMsTotal + stdinWaitMsDelta,
        serverPreflightMsTotal: ctx.metrics.serverPreflightMsTotal + serverPreflightMsDelta,
        lockWaitMsTotal: ctx.metrics.lockWaitMsTotal + lockWaitMsDelta,
        statusRunningMsTotal: ctx.metrics.statusRunningMsTotal + statusRunningMsDelta,
        terminalStatusMsTotal: ctx.metrics.terminalStatusMsTotal + terminalStatusMsDelta,
        completedRequestCount: ctx.metrics.completedRequestCount + completedRequestDelta,
        taskTotals,
        toolStats,
        updatedAtUtc: new Date().toISOString(),
      });
      writeMetrics(metricsPath, ctx.metrics);
      if (requestCompleted) {
        ctx.idleSummaryPending = true;
        scheduleIdleSummaryIfNeeded(ctx);
      }
      }
    }
    const logMessage = buildStatusRequestLogMessage({
      running,
      statusPath,
      requestId,
      taskKind: metadata.taskKind,
      terminalState: metadata.terminalState,
      errorMessage: metadata.errorMessage,
      promptCharacterCount: metadata.promptCharacterCount,
      promptTokenCount: metadata.promptTokenCount,
      rawInputCharacterCount: metadata.rawInputCharacterCount,
      chunkInputCharacterCount: metadata.chunkInputCharacterCount,
      budgetSource: metadata.budgetSource,
      inputCharactersPerContextToken: metadata.inputCharactersPerContextToken,
      chunkThresholdCharacters: metadata.chunkThresholdCharacters,
      chunkIndex: metadata.chunkIndex,
      chunkTotal: metadata.chunkTotal,
      chunkPath: metadata.chunkPath,
      elapsedMs,
      totalElapsedMs,
      outputTokens: metadata.outputTokens,
      toolTokens: metadata.toolTokens,
      totalOutputTokens: metadata.totalOutputTokens ?? null,
    });
    if (!suppressLogLine && deferredMetadata === null) {
      logLine(logMessage);
    }
    if (!running && deferredMetadata === null) {
      const taskKind = normalizeTaskKind(metadata.taskKind);
      if (taskKind && metadata.toolStats) {
        for (const toolLogLine of buildToolStatsLogMessages(taskKind, metadata.toolStats)) {
          logLine(toolLogLine);
        }
      }
    }
    const publishedStatus = getPublishedStatusText(ctx);
    writePublishedStatus(ctx, publishedStatus);
    if (!running && metadata.deferredArtifacts) {
      enqueueDeferredArtifacts(ctx, metadata.deferredArtifacts);
    }
    sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
    return true;
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && requestUrl.pathname === '/config/llama-cpp/test') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'Expected valid JSON object.' });
      return true;
    }
    const baseUrl = typeof parsedBody.BaseUrl === 'string' && parsedBody.BaseUrl.trim()
      ? parsedBody.BaseUrl.trim().replace(/\/$/u, '')
      : '';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'BaseUrl must be an http(s) URL.' });
      return true;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'BaseUrl must be an http(s) URL.' });
      return true;
    }
    const timeoutMs = Number.isFinite(Number(parsedBody.HealthcheckTimeoutMs)) && Number(parsedBody.HealthcheckTimeoutMs) > 0
      ? Math.min(Math.trunc(Number(parsedBody.HealthcheckTimeoutMs)), 30_000)
      : 2_000;
    try {
      const response = await requestText({ url: `${baseUrl}/v1/models`, timeoutMs });
      sendJson(res, 200, {
        ok: response.statusCode > 0 && response.statusCode < 400,
        statusCode: response.statusCode,
        baseUrl,
      });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        statusCode: 0,
        baseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/config') {
    const skipReady = requestUrl.searchParams.get('skip_ready') === '1';
    try {
      if (skipReady || disableManagedLlamaStartup) {
        sendJson(res, 200, readConfig(configPath));
        return true;
      }
      if (ctx.bootstrapManagedLlamaStartup && (ctx.managedLlamaStarting || ctx.managedLlamaStartupPromise)) {
        sendJson(res, 200, readConfig(configPath));
        return true;
      }
      sendJson(res, 200, await ctx.ensureManagedLlamaReady({ allowUnconfigured: true }));
    } catch (error) {
      sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
    }
    return true;
  }

  if (req.method === 'PUT' && requestUrl.pathname === '/config') {
    let parsedBody: Dict;
    try {
      parsedBody = JSON.parse(await readBody(req) || '{}') as Dict;
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const baseConfig = readConfig(configPath);
    const nextConfig = isStrictConfigPayload(parsedBody)
      ? normalizeConfig(parsedBody)
      : normalizeConfig(mergeConfig(baseConfig, parsedBody) as Dict);
    writeConfig(configPath, nextConfig);
    sendJson(res, 200, nextConfig);
    return true;
  }

  if (req.method === 'POST' && req.url === '/status/restart') {
    if (disableManagedLlamaStartup) {
      sendJson(res, 400, { ok: false, restarted: false, error: 'Managed backend restart is disabled for this server.' });
      return true;
    }
    const currentConfig = readConfig(configPath);
    if (String(currentConfig.Backend || '').trim().toLowerCase() !== 'llama.cpp') {
      sendJson(res, 400, { ok: false, restarted: false, error: 'Backend restart is only supported for llama.cpp.' });
      return true;
    }
    try {
      await ctx.shutdownManagedLlamaIfNeeded({ force: true, timeoutMs: 10_000 });
      const nextConfig = await ctx.ensureManagedLlamaReady();
      sendJson(res, 200, { ok: true, restarted: true, config: nextConfig });
    } catch (error) {
      const startupFailure = getManagedLlamaStartupFailure(error);
      sendJson(res, 503, {
        ok: false,
        restarted: false,
        error: error instanceof Error ? error.message : String(error),
        startupFailure,
      });
    }
    return true;
  }

  return false;
}
