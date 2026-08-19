import { sleep, formatElapsed } from '../lib/time.js';
import { mergeToolTypeStats } from '../line-read-guidance.js';
import { recordWebSearchUsage } from './web-search-usage.js';
import { parseStatusMetadata, parseStatusMetadataRecord } from './status-file.js';
import { normalizeMetrics, writeMetrics } from './metrics.js';
import {
  buildStatusRequestLogBody,
  updateRunLogSpeculativeMetricsByRequestId,
} from './dashboard-runs.js';
import {
  enqueueDeferredArtifacts,
  getPublishedStatusText,
  scheduleIdleSummaryIfNeeded,
  writePublishedStatus,
} from './server-ops.js';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { getManagedLlamaSpeculativeMetricsDelta } from './managed-llama.js';
import { serverLogger } from './server-logger.js';
import type { ServerContext, TerminalMetadataQueueItem } from './server-types.js';
import type { ActiveRunState } from './status-run-registry.js';
import { RepeatSuppressor } from './repeat-suppressor.js';
import {
  logToolStatsLines,
  normalizeTaskKind,
  persistStatusRunLog,
  type DeferredTerminalMetadataJob,
} from './status-run-log.js';

/** Folds the per-cycle terminal-metadata drain wait into an entry and a resume line. */
const terminalMetadataDrainSuppressor = new RepeatSuppressor();

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
  persistStatusRunLog(ctx, job, taskKind);
  recordWebSearchUsage(ctx.metricsPath, Number(metadata.toolStats?.web_search?.calls) || 0, new Date());
  if (job.requestCompleted) {
    ctx.idleSummary.pending = true;
    scheduleIdleSummaryIfNeeded(ctx);
  }
  const logBody = buildStatusRequestLogBody({
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
    serverLogger.emitBody('st', job.requestId, logBody);
  }
  if (taskKind && metadata.toolStats) {
    logToolStatsLines(job.requestId, taskKind, metadata.toolStats);
  }
}

export function scheduleDeferredTerminalMetadata(ctx: ServerContext, job: DeferredTerminalMetadataJob): void {
  const timer = setTimeout(() => {
    applyDeferredTerminalMetadata(ctx, job);
  }, 25);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function getTerminalMetadataIdleWaitMs(ctx: ServerContext, fallbackStartedAtMs: number): number {
  if (ctx.activeModelRequests.size > 0 || ctx.modelRequestQueue.length > 0) {
    return Math.max(1, Math.min(1000, ctx.terminalMetadata.idleDelayMs || 1000));
  }
  const lastFinishedAtMs = ctx.terminalMetadata.lastModelRequestFinishedAtMs ?? fallbackStartedAtMs;
  const idleWaitMs = Math.max(0, ctx.terminalMetadata.idleDelayMs - (Date.now() - lastFinishedAtMs));
  if (idleWaitMs > 0) {
    return idleWaitMs;
  }
  if (!ctx.inferenceRunFlushQueue.isIdle()) {
    return Math.max(1, Math.min(1000, ctx.terminalMetadata.idleDelayMs || 1000));
  }
  return 0;
}

function scheduleTerminalMetadataDrain(ctx: ServerContext, delayMs: number = 0): void {
  if (ctx.terminalMetadata.drainScheduled || ctx.terminalMetadata.drainRunning || ctx.terminalMetadata.queue.length === 0) {
    return;
  }
  ctx.terminalMetadata.drainScheduled = true;
  const timer = setTimeout(() => {
    drainTerminalMetadataQueue(ctx);
  }, Math.max(0, Math.trunc(delayMs)));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

export function enqueueTerminalMetadata(ctx: ServerContext, item: TerminalMetadataQueueItem): void {
  ctx.terminalMetadata.queue.push(item);
  serverLogger.debug({
    scope: 'st',
    id: item.requestId,
    event: 'terminal_metadata_enqueued',
    fields: `state=${item.terminalState} q=${ctx.terminalMetadata.queue.length}`,
  });
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
  const requestId = item.requestId;
  let elapsedMs: number | null = null;
  let totalElapsedMs: number | null = null;
  let requestCompleted = false;
  let suppressLogLine = false;
  let runState: ActiveRunState | null = null;
  const resolution = ctx.statusRuns.resolveTerminalRun(requestId);
  switch (resolution.kind) {
    case 'active':
      runState = resolution.run;
      break;
    case 'awaiting':
      runState = resolution.run.run;
      break;
    case 'duplicate':
      serverLogger.dim({ scope: 'st', id: requestId, event: 'terminal_metadata_duplicate', fields: '' });
      return;
    case 'unknown':
      ctx.statusRuns.markComplete(requestId, item.terminalState, item.capturedAtMs);
      break;
  }
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
      ctx.managedLlamaLastStartupLogs?.runId ?? null,
      runState.managedLlamaSpeculativeSnapshot,
    );
    if (speculativeMetrics) {
      targetMetadata.speculativeAcceptedTokens = speculativeMetrics.speculativeAcceptedTokens;
      targetMetadata.speculativeGeneratedTokens = speculativeMetrics.speculativeGeneratedTokens;
    }
    if (metadata.terminalState === 'completed') {
      totalElapsedMs = item.capturedAtMs - runState.overallStartedAt;
      targetMetadata.totalOutputTokens = runState.outputTokensTotal;
      requestCompleted = true;
    } else if (metadata.terminalState === 'failed') {
      totalElapsedMs = item.capturedAtMs - runState.overallStartedAt;
    }
  }
  ctx.statusRuns.finalizeTerminal(requestId, item.capturedAtMs);
  writePublishedStatus(ctx, getPublishedStatusText(ctx));
  applyDeferredTerminalMetadata(ctx, {
    requestId,
    metadata: targetMetadata,
    startedAtUtc: runState ? new Date(runState.overallStartedAt).toISOString() : null,
    finishedAtUtc: new Date(item.capturedAtMs).toISOString(),
    elapsedMs,
    totalElapsedMs,
    requestCompleted,
    suppressLogLine,
  });
  if (metadata.deferredArtifacts) {
    enqueueDeferredArtifacts(ctx, metadata.deferredArtifacts);
  }
}

function drainTerminalMetadataQueue(ctx: ServerContext): void {
  if (ctx.terminalMetadata.drainRunning) {
    return;
  }
  ctx.terminalMetadata.drainScheduled = false;
  const nextItem = ctx.terminalMetadata.queue[0] || null;
  if (!nextItem) {
    return;
  }
  const waitMs = getTerminalMetadataIdleWaitMs(ctx, nextItem.capturedAtMs);
  const drainKey = `drain:${nextItem.requestId}:${nextItem.terminalState}`;
  if (waitMs > 0) {
    if (terminalMetadataDrainSuppressor.observe(drainKey, Date.now()).shouldLog) {
      serverLogger.dim({
        scope: 'st',
        id: nextItem.requestId,
        event: 'drain_wait',
        fields: `state=${nextItem.terminalState} wait_ms=${Math.max(1, Math.trunc(waitMs))} `
          + `active=${ctx.activeModelRequests.size > 0 ? 'true' : 'false'} `
          + `q=${ctx.terminalMetadata.queue.length} model_q=${ctx.modelRequestQueue.length}`,
      });
    }
    scheduleTerminalMetadataDrain(ctx, waitMs);
    return;
  }
  const drainRelease = terminalMetadataDrainSuppressor.release(drainKey, Date.now());
  if (drainRelease) {
    serverLogger.dim({
      scope: 'st',
      id: nextItem.requestId,
      event: 'drain_resume',
      fields: `waited=${formatElapsed(drainRelease.elapsedMs)}  cycles=${drainRelease.repeatCount + 1}  `
        + `q=${ctx.terminalMetadata.queue.length}`,
    });
  }
  ctx.terminalMetadata.drainRunning = true;
  const item = ctx.terminalMetadata.queue.shift();
  if (!item) {
    ctx.terminalMetadata.drainRunning = false;
    return;
  }
  const startedAt = Date.now();
  serverLogger.debug({
    scope: 'st',
    id: item.requestId,
    event: 'terminal_metadata_process_start',
    fields: `state=${item.terminalState}`,
  });
  try {
    processTerminalMetadataBody(ctx, item);
    serverLogger.dim({
      scope: 'st',
      id: item.requestId,
      event: 'terminal_metadata_process_done',
      fields: `state=${item.terminalState} duration_ms=${Date.now() - startedAt}`,
    });
  } catch (error) {
    serverLogger.error({
      scope: 'st',
      id: item.requestId,
      event: 'terminal_metadata_process_failed',
      fields: `state=${item.terminalState} duration_ms=${Date.now() - startedAt} `
        + `error=${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    ctx.terminalMetadata.drainRunning = false;
    if (ctx.terminalMetadata.queue.length > 0) {
      scheduleTerminalMetadataDrain(ctx);
    }
  }
}

function isTerminalMetadataIdle(ctx: ServerContext, minimumCompletedRequestCount: number): boolean {
  return ctx.terminalMetadata.queue.length === 0
    && !ctx.terminalMetadata.drainScheduled
    && !ctx.terminalMetadata.drainRunning
    && ctx.metrics.completedRequestCount >= minimumCompletedRequestCount;
}

export async function waitForTerminalMetadataIdle(
  ctx: ServerContext,
  timeoutMs: number,
  minimumCompletedRequestCount: number = ctx.metrics.completedRequestCount,
): Promise<void> {
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0;
  const normalizedMinimumCount = Number.isFinite(minimumCompletedRequestCount)
    ? Math.max(0, Math.trunc(minimumCompletedRequestCount))
    : 0;
  const deadline = Date.now() + normalizedTimeoutMs;
  while (!isTerminalMetadataIdle(ctx, normalizedMinimumCount)) {
    if (Date.now() >= deadline) {
      const nextRequestId = ctx.terminalMetadata.queue[0]?.requestId ?? 'none';
      throw new Error(
        `Timed out waiting for terminal metadata after ${normalizedTimeoutMs}ms: `
        + `queue=${ctx.terminalMetadata.queue.length} scheduled=${ctx.terminalMetadata.drainScheduled} `
        + `running=${ctx.terminalMetadata.drainRunning} request=${nextRequestId} `
        + `completed=${ctx.metrics.completedRequestCount} expected=${normalizedMinimumCount}`,
      );
    }
    await sleep(Math.min(10, Math.max(1, deadline - Date.now())));
  }
}
