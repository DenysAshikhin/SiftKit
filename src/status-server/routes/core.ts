/**
 * Core API routes: health, status, execution lease, repo-search, and config.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { toError } from '../../lib/errors.js';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import { parseJsonValueText } from '../../lib/json.js';
import { JsonValueSchema, type JsonValue, type OptionalJsonValue } from '../../lib/json-types.js';
import { LlamaCppClient } from '../../llm-protocol/llama-cpp-client.js';
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
import { recordWebSearchUsage } from '../web-search-usage.js';
import {
  readConfig,
  writeConfig,
  normalizeConfig,
  mergeConfig,
} from '../config-store.js';
import { resolveEffectiveAgentsMd, resolveEffectiveRepoFileListing } from './chat.js';
import {
  type RepoSearchProgressEvent,
  buildStatusRequestLogMessage,
  buildRepoSearchProgressLogMessage,
  getStatusArtifactPath,
  upsertRunArtifactPayload,
  upsertRunLog,
  updateRunLogSpeculativeMetricsByRequestId,
} from '../dashboard-runs.js';
import { RepoSearchResponseSanityChecker } from '../../repo-search/response-sanity.js';
import { StatusPresetRunner } from '../preset-runner.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import {
  parseRepoSearchRequest,
  parseSummaryRequest,
  type RepoSearchRouteRequest,
} from '../route-request-normalizers.js';
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
  getModelRequestQueueDiagnostics,
} from '../server-ops.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import { getRuntimeDatabase } from '../../state/runtime-db.js';
import type {
  ActiveRunState,
  ServerContext,
  TerminalMetadataQueueItem,
} from '../server-types.js';

const llamaCppClient = new LlamaCppClient();
const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_SECONDS = 240;

type RepoSearchAdmissionRecord = {
  requestId: string;
  startedAtUtc: string;
  prompt: string;
  repoRoot: string;
  model: string | null;
  maxTurns: number | null;
};

function normalizeTaskKind(value: OptionalJsonValue): TaskKind | null {
  return value === 'summary' || value === 'plan' || value === 'repo-search' || value === 'chat'
    ? value
    : null;
}

function createRepoSearchAdmissionRecord(parsedBody: RepoSearchRouteRequest): RepoSearchAdmissionRecord {
  return {
    requestId: randomUUID(),
    startedAtUtc: new Date().toISOString(),
    prompt: parsedBody.prompt,
    repoRoot: parsedBody.repoRoot,
    model: parsedBody.model,
    maxTurns: parsedBody.maxTurns,
  };
}

function upsertRepoSearchAdmission(record: RepoSearchAdmissionRecord): void {
  upsertRunLog(getRuntimeDatabase(), {
    runId: record.requestId,
    requestId: record.requestId,
    runKind: 'repo_search',
    runGroup: 'repo_search',
    terminalState: 'unknown',
    startedAtUtc: record.startedAtUtc,
    finishedAtUtc: null,
    title: record.prompt,
    model: record.model,
    backend: 'llama.cpp',
    repoRoot: record.repoRoot,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    toolTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
    durationMs: null,
    providerDurationMs: null,
    wallDurationMs: null,
    requestJson: JSON.stringify({
      requestId: record.requestId,
      prompt: record.prompt,
      repoRoot: record.repoRoot,
      model: record.model,
      maxTurns: record.maxTurns,
      queuedAtUtc: record.startedAtUtc,
    }, null, 2),
    plannerDebugJson: null,
    failedRequestJson: null,
    abandonedRequestJson: null,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: record.startedAtUtc,
  });
}

function markRepoSearchAdmissionFailed(record: RepoSearchAdmissionRecord, errorMessage: string): void {
  const finishedAtUtc = new Date().toISOString();
  upsertRunLog(getRuntimeDatabase(), {
    runId: record.requestId,
    requestId: record.requestId,
    runKind: 'repo_search',
    runGroup: 'repo_search',
    terminalState: 'failed',
    startedAtUtc: record.startedAtUtc,
    finishedAtUtc,
    title: record.prompt,
    model: record.model,
    backend: 'llama.cpp',
    repoRoot: record.repoRoot,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    toolTokens: null,
    promptCacheTokens: null,
    promptEvalTokens: null,
    promptEvalDurationMs: null,
    generationDurationMs: null,
    speculativeAcceptedTokens: null,
    speculativeGeneratedTokens: null,
    durationMs: Math.max(0, Date.parse(finishedAtUtc) - Date.parse(record.startedAtUtc)),
    providerDurationMs: null,
    wallDurationMs: null,
    requestJson: null,
    plannerDebugJson: null,
    failedRequestJson: JSON.stringify({
      requestId: record.requestId,
      prompt: record.prompt,
      repoRoot: record.repoRoot,
      error: errorMessage,
      failedAtUtc: finishedAtUtc,
    }, null, 2),
    abandonedRequestJson: null,
    repoSearchJson: null,
    repoSearchTranscriptJsonl: null,
    sourcePathsJson: '[]',
    flushedAtUtc: finishedAtUtc,
  });
}

function normalizeSummaryPolicyProfile(value: OptionalJsonValue): SummaryPolicyProfile {
  return (
    value === 'pass-fail'
    || value === 'unique-errors'
    || value === 'buried-critical'
    || value === 'json-extraction'
    || value === 'diff-summary'
    || value === 'risky-operation'
  ) ? value : 'general';
}

function normalizeSummarySourceKind(value: OptionalJsonValue): SummarySourceKind {
  return value === 'command-output' ? 'command-output' : 'standalone';
}

function normalizeCommandOutputKind(value: OptionalJsonValue): 'command' | 'interactive' {
  return value === 'interactive' ? 'interactive' : 'command';
}

function normalizeCommandOutputRiskLevel(value: OptionalJsonValue): 'informational' | 'debug' | 'risky' | undefined {
  return value === 'informational' || value === 'debug' || value === 'risky' ? value : undefined;
}

function normalizeCommandOutputReducerProfile(value: OptionalJsonValue): 'smart' | 'errors' | 'tail' | 'diff' | 'none' | undefined {
  return value === 'smart' || value === 'errors' || value === 'tail' || value === 'diff' || value === 'none' ? value : undefined;
}

function isStrictConfigPayload(value: OptionalJsonValue): boolean {
  const record = JsonRecordReader.asObject(value);
  if (!record) {
    return false;
  }
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
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return false;
    }
  }
  const runtime = JsonRecordReader.asObject(record.Runtime);
  const thresholds = JsonRecordReader.asObject(record.Thresholds);
  const interactive = JsonRecordReader.asObject(record.Interactive);
  const server = JsonRecordReader.asObject(record.Server);
  if (!runtime || !thresholds || !interactive || !server) {
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
  recordWebSearchUsage(ctx.metricsPath, Number(metadata.toolStats?.web_search?.calls) || 0, new Date());
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

class HealthEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
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
    return;
  }
}

class StatusReadEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const currentStatus = getPublishedStatusText(ctx);
    sendJson(res, 200, {
      running: currentStatus === STATUS_TRUE,
      status: currentStatus,
      statusPath,
      configPath,
      metrics: ctx.metrics,
      idleSummarySnapshotsPath: ctx.idleSummarySnapshotsPath,
      modelRequests: getModelRequestQueueDiagnostics(ctx),
    });
    return;
  }
}

class CommandOutputAnalyzeEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const reader = new JsonRecordReader(parsedBody);
    const combinedText = typeof parsedBody.combinedText === 'string' ? parsedBody.combinedText : '';
    const exitCode = reader.number('exitCode') ?? 1;
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 503, { error: 'Timed out waiting for model request queue.', modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return;
      }
      const result = await ctx.engineService.analyzeCommandOutput({
        outputKind: normalizeCommandOutputKind(parsedBody.outputKind),
        exitCode,
        combinedText,
        commandText: reader.optionalString('commandText'),
        question: reader.optionalString('question'),
        riskLevel: normalizeCommandOutputRiskLevel(parsedBody.riskLevel),
        reducerProfile: normalizeCommandOutputReducerProfile(parsedBody.reducerProfile),
        format: parsedBody.format === 'json' ? 'json' : 'text',
        policyProfile: normalizeSummaryPolicyProfile(parsedBody.policyProfile),
        backend: reader.optionalString('backend'),
        model: reader.optionalString('model'),
        noSummarize: parsedBody.noSummarize === true,
        config: readConfig(configPath),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class PresetListEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    try {
      const result = new StatusPresetRunner(ctx.engineService).listPresets();
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    }
    return;
  }
}

class PresetRunEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const reader = new JsonRecordReader(parsedBody);
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 503, { error: 'Timed out waiting for model request queue.', modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return;
      }
      const result = await new StatusPresetRunner(ctx.engineService).run({
        presetId: String(parsedBody.presetId || ''),
        prompt: reader.optionalString('prompt'),
        question: reader.optionalString('question'),
        inputText: typeof parsedBody.inputText === 'string' ? parsedBody.inputText : undefined,
        format: parsedBody.format === 'json' ? 'json' : 'text',
        backend: reader.optionalString('backend'),
        model: reader.optionalString('model'),
        profile: reader.optionalString('profile'),
        sourceKind: normalizeSummarySourceKind(parsedBody.sourceKind),
        commandExitCode: reader.number('commandExitCode') ?? undefined,
        repoRoot: reader.optionalString('repoRoot'),
        maxTurns: reader.number('maxTurns') ?? undefined,
        logFile: reader.optionalString('logFile'),
      }, {
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class EvalRunEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const reader = new JsonRecordReader(parsedBody);
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 503, { error: 'Timed out waiting for model request queue.', modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return;
      }
      const result = await ctx.engineService.runEvaluation({
        FixtureRoot: reader.optionalString('FixtureRoot'),
        RealLogPath: Array.isArray(parsedBody.RealLogPath) ? parsedBody.RealLogPath.map((value) => String(value)) : [],
        Backend: reader.optionalString('Backend'),
        Model: reader.optionalString('Model'),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class RepoSearchEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const repoSearchRequest = parseRepoSearchRequest(parsedBody);
    if (!repoSearchRequest) {
      sendJson(res, 400, { error: 'Expected prompt.' });
      return;
    }
    const reader = new JsonRecordReader(parsedBody);
    const admission = createRepoSearchAdmissionRecord(repoSearchRequest);
    upsertRepoSearchAdmission(admission);
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'repo_search', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        const message = 'Timed out waiting for model request queue.';
        markRepoSearchAdmissionFailed(admission, message);
        sendJson(res, 503, { error: message, requestId: admission.requestId, modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        markRepoSearchAdmissionFailed(admission, error instanceof Error ? error.message : String(error));
        sendServerErrorJson(req, res, 503, error, { taskKind: 'repo-search' });
        return;
      }
      if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
        await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
      }
      const config = readConfig(configPath);
      const result = await ctx.engineService.executeRepoSearch({
        taskKind: 'repo-search',
        prompt: repoSearchRequest.prompt,
        requestId: admission.requestId,
        startedAtUtc: admission.startedAtUtc,
        promptPrefix: reader.optionalString('promptPrefix'),
        repoRoot: admission.repoRoot,
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config,
        allowedTools: Array.isArray(parsedBody.allowedTools) ? parsedBody.allowedTools.map((value) => String(value)) : undefined,
        includeAgentsMd: resolveEffectiveAgentsMd(config, null),
        includeRepoFileListing: resolveEffectiveRepoFileListing(config, null),
        model: reader.optionalString('model'),
        maxTurns: reader.number('maxTurns') ?? undefined,
        logFile: reader.optionalString('logFile'),
        availableModels: Array.isArray(parsedBody.availableModels) ? parsedBody.availableModels.map((v) => String(v)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? parsedBody.mockResponses.map((v) => String(v)) : undefined,
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
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
    return;
  }
}

class SummaryEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const summaryRequest = parseSummaryRequest(parsedBody);
    if (!summaryRequest) {
      sendJson(res, 400, { error: 'Expected question and inputText.' });
      return;
    }

    const serviceBaseUrl = ctx.getServiceBaseUrl();
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 503, { error: 'Timed out waiting for model request queue.', modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return;
      }
      const result = await ctx.engineService.summarize({
        question: summaryRequest.question,
        inputText: summaryRequest.inputText,
        format: summaryRequest.format,
        policyProfile: summaryRequest.policyProfile,
        backend: summaryRequest.backend,
        model: summaryRequest.model,
        sourceKind: summaryRequest.sourceKind,
        commandExitCode: summaryRequest.commandExitCode,
        requestTimeoutSeconds: summaryRequest.requestTimeoutSeconds,
        timing: summaryRequest.timing,
        statusBackendUrl: `${serviceBaseUrl}/status`,
        config: readConfig(configPath),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class StatusCompleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const routeStartedAt = Date.now();
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const requestId = typeof parsedBody.requestId === 'string' ? parsedBody.requestId.trim() : '';
    const terminalState = typeof parsedBody.terminalState === 'string' ? parsedBody.terminalState.trim() : '';
    const completedStatusPath = statusPath;
    if (!requestId) {
      sendJson(res, 400, { error: 'Expected requestId.' });
      return;
    }
    if (terminalState !== 'completed' && terminalState !== 'failed') {
      sendJson(res, 400, { error: 'Expected terminalState=completed|failed.' });
      return;
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
    return;
  }
}

type StatusPostMetadata = ReturnType<typeof parseStatusMetadata>;
type StatusPostDeferredMetadata = ReturnType<typeof parseStatusMetadataRecord>;
type StatusPostTimingResult = {
  elapsedMs: number | null;
  totalElapsedMs: number | null;
  requestCompleted: boolean;
  suppressLogLine: boolean;
};
type StatusPostCurrentStatusExtra = {
  queued?: true;
};

class StatusPostEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    await new StatusPostRequestHandler(ctx, req, res).handle();
  }
}

class StatusPostRequestHandler {
  constructor(
    private readonly ctx: ServerContext,
    private readonly req: IncomingMessage,
    private readonly res: ServerResponse,
  ) {}

  private get configPath(): string { return this.ctx.configPath; }
  private get statusPath(): string { return this.ctx.statusPath; }
  private get metricsPath(): string { return this.ctx.metricsPath; }

  async handle(): Promise<void> {
    const terminalMetadataPost = new URL(this.req.url || '/', 'http://localhost').pathname === '/status/terminal-metadata';
    const bodyText = await readBody(this.req);
    const running = parseRunning(bodyText);
    if (running === null) {
      sendJson(this.res, 400, { error: 'Expected running=true|false or status=true|false.' });
      return;
    }
    const metadata = parseStatusMetadata(bodyText);
    const deferredMetadata = this.resolveDeferredMetadata(metadata);
    if (!this.validatePost(running, terminalMetadataPost, metadata, deferredMetadata)) return;
    if (terminalMetadataPost) {
      this.enqueueTerminalMetadata(metadata, bodyText);
      return;
    }
    if (this.persistArtifactPost(metadata)) return;
    if (this.isArtifactOnlyPost(metadata, deferredMetadata)) {
      this.sendCurrentStatus();
      return;
    }
    const requestId = getResolvedRequestId(metadata, this.statusPath);
    if (this.handleLateOrRunningPost(running, requestId, metadata)) return;
    const timing = running
      ? this.startRunState(requestId, metadata)
      : this.finishRunState(requestId, metadata, deferredMetadata);
    this.logStatusPost(running, requestId, metadata, deferredMetadata, timing);
    this.finalizeStatusPost(running, metadata, deferredMetadata, timing);
  }

  private resolveDeferredMetadata(metadata: StatusPostMetadata): StatusPostDeferredMetadata | null {
    const deferredMetadata = metadata.deferredMetadata ? parseStatusMetadataRecord(metadata.deferredMetadata) : null;
    if (!deferredMetadata) return null;
    deferredMetadata.requestId = metadata.requestId ?? deferredMetadata.requestId;
    deferredMetadata.taskKind = metadata.taskKind ?? deferredMetadata.taskKind;
    deferredMetadata.terminalState = metadata.terminalState ?? deferredMetadata.terminalState;
    deferredMetadata.errorMessage = deferredMetadata.errorMessage ?? metadata.errorMessage;
    return deferredMetadata;
  }

  private validatePost(
    running: boolean,
    terminalMetadataPost: boolean,
    metadata: StatusPostMetadata,
    deferredMetadata: StatusPostDeferredMetadata | null,
  ): boolean {
    if (!terminalMetadataPost && !running && metadata.terminalState !== null) {
      sendJson(this.res, 400, { error: 'Terminal status must use /status/complete and /status/terminal-metadata.' });
      return false;
    }
    if (terminalMetadataPost && running) {
      sendJson(this.res, 400, { error: 'Terminal metadata requires running=false.' });
      return false;
    }
    if (terminalMetadataPost && metadata.terminalState !== 'completed' && metadata.terminalState !== 'failed') {
      sendJson(this.res, 400, { error: 'Terminal metadata requires terminalState=completed|failed.' });
      return false;
    }
    if (deferredMetadata && (running || metadata.terminalState === null)) {
      sendJson(this.res, 400, { error: 'deferredMetadata is only accepted on terminal running=false posts.' });
      return false;
    }
    if (metadata.deferredArtifacts && (running || metadata.terminalState === null)) {
      sendJson(this.res, 400, { error: 'deferredArtifacts are only accepted on terminal running=false posts.' });
      return false;
    }
    return true;
  }

  private enqueueTerminalMetadata(metadata: StatusPostMetadata, bodyText: string): void {
    const requestId = getResolvedRequestId(metadata, this.statusPath);
    enqueueTerminalMetadata(this.ctx, {
      requestId,
      terminalState: z.enum(['completed', 'failed']).parse(metadata.terminalState),
      bodyText,
      capturedAtMs: Date.now(),
    });
    this.sendCurrentStatus({ queued: true });
  }

  private persistArtifactPost(metadata: StatusPostMetadata): boolean {
    if (metadata.artifactType === null) return false;
    if (!metadata.artifactRequestId) {
      sendJson(this.res, 400, { error: 'Expected artifactRequestId when artifactType is provided.' });
      return true;
    }
    if (!metadata.artifactPayload) {
      sendJson(this.res, 400, { error: 'Expected artifactPayload object when artifactType is provided.' });
      return true;
    }
    const artifactPath = getStatusArtifactPath(metadata);
    if (!artifactPath) {
      sendJson(this.res, 400, { error: 'Unsupported artifactType.' });
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
        database: getIdleSummaryDatabase(this.ctx),
        requestId: metadata.artifactRequestId,
        artifactType: z.enum(['summary_request', 'planner_debug', 'planner_failed', 'request_abandoned']).parse(metadata.artifactType),
        artifactPayload: metadata.artifactPayload,
      });
      return false;
    } catch (error) {
      sendServerErrorJson(this.req, this.res, 500, error, {
        taskKind: metadata.taskKind ?? null,
        requestId: metadata.requestId ?? null,
      });
      return true;
    }
  }

  private isArtifactOnlyPost(metadata: StatusPostMetadata, deferredMetadata: StatusPostDeferredMetadata | null): boolean {
    return metadata.artifactType !== null
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
  }

  private handleLateOrRunningPost(running: boolean, requestId: string, metadata: StatusPostMetadata): boolean {
    clearCompletedStatusRequestIdForDifferentRequest(this.ctx, this.statusPath, requestId);
    if (running && this.ctx.completedRequestIdByStatusPath.get(this.statusPath) === requestId) {
      logLine(`request late_running_ignored request_id=${requestId} task=${metadata.taskKind ?? 'unknown'}`);
      this.sendCurrentStatus();
      return true;
    }
    if (running && normalizeTaskKind(metadata.taskKind) !== null && !this.ctx.activeModelRequest) {
      wakeManagedLlamaForIncomingModelRequest(this.ctx);
    }
    return false;
  }

  private startRunState(requestId: string, metadata: StatusPostMetadata): StatusPostTimingResult {
    clearIdleSummaryTimer(this.ctx);
    const now = Date.now();
    const activeRequestId = this.ctx.activeRequestIdByStatusPath.get(this.statusPath) || null;
    const activeRun = activeRequestId ? this.ctx.activeRunsByRequestId.get(activeRequestId) || null : null;
    this.capturePendingIdleSummaryMetadata(metadata);
    if (activeRun && activeRequestId !== requestId) {
      logLine(`request stale_status_abandoned active_request_id=${activeRequestId} incoming_request_id=${requestId} lock_task=${this.ctx.activeModelRequest?.kind ?? 'none'}`);
      logAbandonedRun(this.ctx, activeRun, now);
      clearRunState(this.ctx, activeRequestId);
    }
    const runState = this.buildActiveRunState(requestId, metadata, now);
    runState.managedLlamaSpeculativeSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot(this.ctx.managedLlamaLastStartupLogs);
    this.ctx.activeRunsByRequestId.set(requestId, runState);
    this.ctx.activeRequestIdByStatusPath.set(this.statusPath, requestId);
    return { elapsedMs: null, totalElapsedMs: null, requestCompleted: false, suppressLogLine: false };
  }

  private capturePendingIdleSummaryMetadata(metadata: StatusPostMetadata): void {
    if (metadata.inputCharactersPerContextToken !== null) {
      this.ctx.pendingIdleSummaryMetadata.inputCharactersPerContextToken = metadata.inputCharactersPerContextToken;
    }
    if (metadata.chunkThresholdCharacters !== null) {
      this.ctx.pendingIdleSummaryMetadata.chunkThresholdCharacters = metadata.chunkThresholdCharacters;
    }
  }

  private buildActiveRunState(requestId: string, metadata: StatusPostMetadata, now: number): ActiveRunState {
    const existingRunState = this.ctx.activeRunsByRequestId.get(requestId) || null;
    if (!existingRunState) {
      return {
        requestId,
        statusPath: this.statusPath,
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
    }
    existingRunState.currentRequestStartedAt = now;
    existingRunState.stepCount = Number.isFinite(existingRunState.stepCount) ? existingRunState.stepCount + 1 : 1;
    if (existingRunState.rawInputCharacterCount === null && metadata.rawInputCharacterCount !== null) {
      existingRunState.rawInputCharacterCount = metadata.rawInputCharacterCount;
    }
    if (metadata.promptCharacterCount !== null) existingRunState.promptCharacterCount = metadata.promptCharacterCount;
    if (metadata.promptTokenCount !== null) existingRunState.promptTokenCount = metadata.promptTokenCount;
    if (metadata.chunkIndex !== null) existingRunState.chunkIndex = metadata.chunkIndex;
    if (metadata.chunkTotal !== null) existingRunState.chunkTotal = metadata.chunkTotal;
    if (metadata.chunkPath !== null) existingRunState.chunkPath = metadata.chunkPath;
    return existingRunState;
  }

  private finishRunState(
    requestId: string,
    metadata: StatusPostMetadata,
    deferredMetadata: StatusPostDeferredMetadata | null,
  ): StatusPostTimingResult {
    const runState = this.ctx.activeRunsByRequestId.get(requestId) || null;
    if (deferredMetadata && metadata.terminalState !== null) {
      return this.scheduleDeferredTerminalPost(requestId, metadata, deferredMetadata, runState);
    }
    return this.finishDirectTerminalPost(requestId, metadata, runState);
  }

  private scheduleDeferredTerminalPost(
    requestId: string,
    metadata: StatusPostMetadata,
    deferredMetadata: StatusPostDeferredMetadata,
    runState: ActiveRunState | null,
  ): StatusPostTimingResult {
    const timing = this.applyRunStateToTerminalMetadata(requestId, metadata, deferredMetadata, runState);
    scheduleDeferredTerminalMetadata(this.ctx, {
      requestId,
      metadata: deferredMetadata,
      elapsedMs: timing.elapsedMs,
      totalElapsedMs: timing.totalElapsedMs,
      requestCompleted: timing.requestCompleted,
      suppressLogLine: timing.suppressLogLine,
    });
    return { elapsedMs: null, totalElapsedMs: null, requestCompleted: false, suppressLogLine: timing.suppressLogLine };
  }

  private finishDirectTerminalPost(
    requestId: string,
    metadata: StatusPostMetadata,
    runState: ActiveRunState | null,
  ): StatusPostTimingResult {
    const timing = this.applyRunStateToTerminalMetadata(requestId, metadata, metadata, runState);
    if (!runState && (metadata.speculativeAcceptedTokens !== null || metadata.speculativeGeneratedTokens !== null)) {
      updateRunLogSpeculativeMetricsByRequestId({
        database: getRuntimeDatabase(),
        requestId,
        speculativeAcceptedTokens: metadata.speculativeAcceptedTokens,
        speculativeGeneratedTokens: metadata.speculativeGeneratedTokens,
      });
    }
    this.updateStatusMetrics(metadata, timing);
    return timing;
  }

  private applyRunStateToTerminalMetadata(
    requestId: string,
    sourceMetadata: StatusPostMetadata,
    targetMetadata: StatusPostMetadata | StatusPostDeferredMetadata,
    runState: ActiveRunState | null,
  ): StatusPostTimingResult {
    const timing: StatusPostTimingResult = { elapsedMs: null, totalElapsedMs: null, requestCompleted: false, suppressLogLine: false };
    if (!runState || !Number.isFinite(runState.currentRequestStartedAt)) return timing;
    const now = Date.now();
    const resolvedOutputTokens = targetMetadata.outputTokens ?? 0;
    const isSingleStepNonChunk = runState.stepCount === 1 && runState.chunkIndex === null && runState.chunkTotal === null && runState.chunkPath === null;
    timing.suppressLogLine = sourceMetadata.terminalState === null && isSingleStepNonChunk;
    timing.elapsedMs = now - runState.currentRequestStartedAt;
    runState.outputTokensTotal += resolvedOutputTokens;
    this.copyRunStateMetadata(targetMetadata, runState);
    this.applySpeculativeMetrics(requestId, sourceMetadata, targetMetadata, runState);
    if (sourceMetadata.terminalState === null) {
      runState.managedLlamaSpeculativeSnapshot = captureManagedLlamaSpeculativeMetricsSnapshot(this.ctx.managedLlamaLastStartupLogs);
    } else if (sourceMetadata.terminalState === 'completed') {
      timing.totalElapsedMs = now - runState.overallStartedAt;
      targetMetadata.totalOutputTokens = runState.outputTokensTotal;
      clearRunState(this.ctx, requestId);
      timing.requestCompleted = true;
    } else if (sourceMetadata.terminalState === 'failed') {
      timing.totalElapsedMs = now - runState.overallStartedAt;
      clearRunState(this.ctx, requestId);
    }
    return timing;
  }

  private copyRunStateMetadata(metadata: StatusPostMetadata | StatusPostDeferredMetadata, runState: ActiveRunState): void {
    if (metadata.rawInputCharacterCount === null && runState.rawInputCharacterCount !== null) metadata.rawInputCharacterCount = runState.rawInputCharacterCount;
    if (metadata.promptCharacterCount === null && runState.promptCharacterCount !== null) metadata.promptCharacterCount = runState.promptCharacterCount;
    if (metadata.promptTokenCount === null && runState.promptTokenCount !== null) metadata.promptTokenCount = runState.promptTokenCount;
    if (metadata.chunkIndex === null && runState.chunkIndex !== null) metadata.chunkIndex = runState.chunkIndex;
    if (metadata.chunkTotal === null && runState.chunkTotal !== null) metadata.chunkTotal = runState.chunkTotal;
    if (metadata.chunkPath === null && runState.chunkPath !== null) metadata.chunkPath = runState.chunkPath;
  }

  private applySpeculativeMetrics(
    requestId: string,
    sourceMetadata: StatusPostMetadata,
    targetMetadata: StatusPostMetadata | StatusPostDeferredMetadata,
    runState: ActiveRunState,
  ): void {
    const speculativeMetrics = getManagedLlamaSpeculativeMetricsDelta(
      this.ctx.managedLlamaLastStartupLogs,
      runState.managedLlamaSpeculativeSnapshot,
    );
    if (speculativeMetrics) {
      targetMetadata.speculativeAcceptedTokens = speculativeMetrics.speculativeAcceptedTokens;
      targetMetadata.speculativeGeneratedTokens = speculativeMetrics.speculativeGeneratedTokens;
    }
    if (sourceMetadata.terminalState !== null && (targetMetadata.speculativeAcceptedTokens !== null || targetMetadata.speculativeGeneratedTokens !== null)) {
      updateRunLogSpeculativeMetricsByRequestId({
        database: getRuntimeDatabase(),
        requestId,
        speculativeAcceptedTokens: targetMetadata.speculativeAcceptedTokens,
        speculativeGeneratedTokens: targetMetadata.speculativeGeneratedTokens,
      });
    }
  }

  private updateStatusMetrics(metadata: StatusPostMetadata, timing: StatusPostTimingResult): void {
    const taskKind = normalizeTaskKind(metadata.taskKind);
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
    const requestDurationMsDelta = metadata.requestDurationMs ?? (metadata.terminalState ? 0 : (timing.elapsedMs ?? 0));
    const wallDurationMsDelta = metadata.wallDurationMs ?? 0;
    const taskTotals = { ...this.ctx.metrics.taskTotals };
    const toolStats = { ...this.ctx.metrics.toolStats };
    if (taskKind) {
      const previousTaskTotals = this.ctx.metrics.taskTotals[taskKind];
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
        stdinWaitMsTotal: previousTaskTotals.stdinWaitMsTotal + (metadata.stdinWaitMs ?? 0),
        serverPreflightMsTotal: previousTaskTotals.serverPreflightMsTotal + (metadata.serverPreflightMs ?? 0),
        lockWaitMsTotal: previousTaskTotals.lockWaitMsTotal + (metadata.lockWaitMs ?? 0),
        statusRunningMsTotal: previousTaskTotals.statusRunningMsTotal + (metadata.statusRunningMs ?? 0),
        terminalStatusMsTotal: previousTaskTotals.terminalStatusMsTotal + (metadata.terminalStatusMs ?? 0),
        completedRequestCount: previousTaskTotals.completedRequestCount + (timing.requestCompleted ? 1 : 0),
      };
      toolStats[taskKind] = mergeToolTypeStats(this.ctx.metrics.toolStats[taskKind], metadata.toolStats);
    }
    this.ctx.metrics = normalizeMetrics({
      ...this.ctx.metrics,
      inputCharactersTotal: this.ctx.metrics.inputCharactersTotal + inputCharactersDelta,
      outputCharactersTotal: this.ctx.metrics.outputCharactersTotal + outputCharactersDelta,
      inputTokensTotal: this.ctx.metrics.inputTokensTotal + inputTokensDelta,
      outputTokensTotal: this.ctx.metrics.outputTokensTotal + outputTokensDelta,
      toolTokensTotal: this.ctx.metrics.toolTokensTotal + toolTokensDelta,
      thinkingTokensTotal: this.ctx.metrics.thinkingTokensTotal + thinkingTokensDelta,
      promptCacheTokensTotal: this.ctx.metrics.promptCacheTokensTotal + promptCacheTokensDelta,
      promptEvalTokensTotal: this.ctx.metrics.promptEvalTokensTotal + promptEvalTokensDelta,
      speculativeAcceptedTokensTotal: this.ctx.metrics.speculativeAcceptedTokensTotal + speculativeAcceptedTokensDelta,
      speculativeGeneratedTokensTotal: this.ctx.metrics.speculativeGeneratedTokensTotal + speculativeGeneratedTokensDelta,
      requestDurationMsTotal: this.ctx.metrics.requestDurationMsTotal + requestDurationMsDelta,
      wallDurationMsTotal: this.ctx.metrics.wallDurationMsTotal + wallDurationMsDelta,
      stdinWaitMsTotal: this.ctx.metrics.stdinWaitMsTotal + (metadata.stdinWaitMs ?? 0),
      serverPreflightMsTotal: this.ctx.metrics.serverPreflightMsTotal + (metadata.serverPreflightMs ?? 0),
      lockWaitMsTotal: this.ctx.metrics.lockWaitMsTotal + (metadata.lockWaitMs ?? 0),
      statusRunningMsTotal: this.ctx.metrics.statusRunningMsTotal + (metadata.statusRunningMs ?? 0),
      terminalStatusMsTotal: this.ctx.metrics.terminalStatusMsTotal + (metadata.terminalStatusMs ?? 0),
      completedRequestCount: this.ctx.metrics.completedRequestCount + (timing.requestCompleted ? 1 : 0),
      taskTotals,
      toolStats,
      updatedAtUtc: new Date().toISOString(),
    });
    writeMetrics(this.metricsPath, this.ctx.metrics);
    recordWebSearchUsage(this.metricsPath, Number(metadata.toolStats?.web_search?.calls) || 0, new Date());
    if (timing.requestCompleted) {
      this.ctx.idleSummaryPending = true;
      scheduleIdleSummaryIfNeeded(this.ctx);
    }
  }

  private logStatusPost(
    running: boolean,
    requestId: string,
    metadata: StatusPostMetadata,
    deferredMetadata: StatusPostDeferredMetadata | null,
    timing: StatusPostTimingResult,
  ): void {
    const logMessage = buildStatusRequestLogMessage({
      running,
      statusPath: this.statusPath,
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
      elapsedMs: timing.elapsedMs,
      totalElapsedMs: timing.totalElapsedMs,
      outputTokens: metadata.outputTokens,
      toolTokens: metadata.toolTokens,
      totalOutputTokens: metadata.totalOutputTokens ?? null,
    });
    if (!timing.suppressLogLine && deferredMetadata === null) logLine(logMessage);
    if (!running && deferredMetadata === null) this.logToolStats(metadata);
  }

  private logToolStats(metadata: StatusPostMetadata): void {
    const taskKind = normalizeTaskKind(metadata.taskKind);
    if (!taskKind || !metadata.toolStats) return;
    for (const toolLogLine of buildToolStatsLogMessages(taskKind, metadata.toolStats)) {
      logLine(toolLogLine);
    }
  }

  private finalizeStatusPost(
    running: boolean,
    metadata: StatusPostMetadata,
    deferredMetadata: StatusPostDeferredMetadata | null,
    timing: StatusPostTimingResult,
  ): void {
    const publishedStatus = getPublishedStatusText(this.ctx);
    writePublishedStatus(this.ctx, publishedStatus);
    if (!running && metadata.deferredArtifacts) enqueueDeferredArtifacts(this.ctx, metadata.deferredArtifacts);
    sendJson(this.res, 200, {
      ok: true,
      running: publishedStatus === STATUS_TRUE,
      status: publishedStatus,
      statusPath: this.statusPath,
      configPath: this.configPath,
    });
    void deferredMetadata;
    void timing;
  }

  private sendCurrentStatus(extra: StatusPostCurrentStatusExtra = {}): void {
    const publishedStatus = getPublishedStatusText(this.ctx);
    sendJson(this.res, 200, {
      ok: true,
      ...extra,
      running: publishedStatus === STATUS_TRUE,
      status: publishedStatus,
      statusPath: this.statusPath,
      configPath: this.configPath,
    });
  }
}
class LlamaCppConfigTestEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'Expected valid JSON object.' });
      return;
    }
    const baseUrl = typeof parsedBody.BaseUrl === 'string' && parsedBody.BaseUrl.trim()
      ? parsedBody.BaseUrl.trim().replace(/\/$/u, '')
      : '';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'BaseUrl must be an http(s) URL.' });
      return;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      sendJson(res, 400, { ok: false, statusCode: 0, error: 'BaseUrl must be an http(s) URL.' });
      return;
    }
    const timeoutMs = Number.isFinite(Number(parsedBody.HealthcheckTimeoutMs)) && Number(parsedBody.HealthcheckTimeoutMs) > 0
      ? Math.min(Math.trunc(Number(parsedBody.HealthcheckTimeoutMs)), 30_000)
      : 2_000;
    try {
      const response = await llamaCppClient.probeModelsAtBaseUrl(baseUrl, timeoutMs);
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
    return;
  }
}

class ConfigReadEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const skipReady = requestUrl.searchParams.get('skip_ready') === '1';
    try {
      if (skipReady || disableManagedLlamaStartup) {
        sendJson(res, 200, readConfig(configPath));
        return;
      }
      if (ctx.bootstrapManagedLlamaStartup && (ctx.managedLlamaStarting || ctx.managedLlamaStartupPromise)) {
        sendJson(res, 200, readConfig(configPath));
        return;
      }
      sendJson(res, 200, await ctx.ensureManagedLlamaReady({ allowUnconfigured: true }));
    } catch (error) {
      sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
    }
    return;
  }
}

class ConfigUpdateEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    let parsedBody: JsonValue;
    try {
      parsedBody = parseJsonValueText(await readBody(req) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return;
    }
    const baseConfig = readConfig(configPath);
    const nextConfig = isStrictConfigPayload(parsedBody)
      ? normalizeConfig(parsedBody)
      : normalizeConfig(mergeConfig(JsonValueSchema.parse(baseConfig), parsedBody));
    writeConfig(configPath, nextConfig);
    sendJson(res, 200, nextConfig);
    return;
  }
}

class StatusRestartEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (disableManagedLlamaStartup) {
      sendJson(res, 400, { ok: false, restarted: false, error: 'Managed backend restart is disabled for this server.' });
      return;
    }
    const currentConfig = readConfig(configPath);
    if (String(currentConfig.Backend || '').trim().toLowerCase() !== 'llama.cpp') {
      sendJson(res, 400, { ok: false, restarted: false, error: 'Backend restart is only supported for llama.cpp.' });
      return;
    }
    try {
      await ctx.shutdownManagedLlamaIfNeeded({ force: true, timeoutMs: 10_000 });
      const nextConfig = await ctx.ensureManagedLlamaReady();
      sendJson(res, 200, { ok: true, restarted: true, config: nextConfig });
    } catch (error) {
      const startupFailure = getManagedLlamaStartupFailure(toError(error));
      sendJson(res, 503, {
        ok: false,
        restarted: false,
        error: error instanceof Error ? error.message : String(error),
        startupFailure,
      });
    }
    return;
  }
}
const STATUS_POST_ENDPOINT = new StatusPostEndpoint();

const CORE_ROUTES = new RouteTable([
  { method: 'GET', path: '/health', endpoint: new HealthEndpoint() },
  { method: 'GET', path: '/status', endpoint: new StatusReadEndpoint() },
  { method: 'POST', path: '/command-output/analyze', endpoint: new CommandOutputAnalyzeEndpoint() },
  { method: 'GET', path: '/preset/list', endpoint: new PresetListEndpoint() },
  { method: 'POST', path: '/preset/run', endpoint: new PresetRunEndpoint() },
  { method: 'POST', path: '/eval/run', endpoint: new EvalRunEndpoint() },
  { method: 'POST', path: '/repo-search', endpoint: new RepoSearchEndpoint() },
  { method: 'POST', path: '/summary', endpoint: new SummaryEndpoint() },
  { method: 'POST', path: /^\/status\/complete(?:\?.*)?$/u, endpoint: new StatusCompleteEndpoint() },
  { method: 'POST', path: '/status', endpoint: STATUS_POST_ENDPOINT },
  { method: 'POST', path: /^\/status\/terminal-metadata(?:\?.*)?$/u, endpoint: STATUS_POST_ENDPOINT },
  { method: 'POST', path: /^\/config\/llama-cpp\/test(?:\?.*)?$/u, endpoint: new LlamaCppConfigTestEndpoint() },
  { method: 'GET', path: /^\/config(?:\?.*)?$/u, endpoint: new ConfigReadEndpoint() },
  { method: 'PUT', path: /^\/config(?:\?.*)?$/u, endpoint: new ConfigUpdateEndpoint() },
  { method: 'POST', path: '/status/restart', endpoint: new StatusRestartEndpoint() },
]);

export async function handleCoreRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await CORE_ROUTES.handle(ctx, req, res, req.url || '/');
}
