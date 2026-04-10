/**
 * Core API routes: health, status, execution lease, repo-search, and config.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { Dict } from '../../lib/types.js';
import { mergeToolTypeStats } from '../../line-read-guidance.js';
import { getRuntimeRoot } from '../paths.js';
import { saveContentAtomically } from '../../lib/fs.js';
import { sleep } from '../../lib/time.js';
import {
  readBody,
  parseJsonBody,
  sendJson,
} from '../http-utils.js';
import {
  STATUS_TRUE,
  parseRunning,
  parseStatusMetadata,
} from '../status-file.js';
import { normalizeMetrics, writeMetrics, type TaskKind, type ToolTypeStats } from '../metrics.js';
import {
  readConfig,
  writeConfig,
  normalizeConfig,
  mergeConfig,
} from '../config-store.js';
import {
  type RepoSearchProgressEvent,
  buildStatusRequestLogMessage,
  buildRepoSearchProgressLogMessage,
  getStatusArtifactPath,
} from '../dashboard-runs.js';
import { loadRepoSearchExecutor } from '../chat.js';
import { logLine } from '../managed-llama.js';
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
  getResolvedRequestId,
  clearRunState,
  logAbandonedRun,
  ensureSiftKitGpuLockAcquired,
  hasActiveRuns,
} from '../server-ops.js';
import type {
  ActiveRunState,
  ServerContext,
} from '../server-types.js';

function normalizeTaskKind(value: unknown): TaskKind | null {
  return value === 'summary' || value === 'plan' || value === 'repo-search' || value === 'chat'
    ? value
    : null;
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

export async function handleCoreRoute(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const { configPath, statusPath, metricsPath, disableManagedLlamaStartup } = ctx;

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
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
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'repo_search');
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    if (typeof parsedBody.prompt !== 'string' || !(parsedBody.prompt as string).trim()) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 400, { error: 'Expected prompt.' });
      return true;
    }
    if (Number.isFinite(Number(parsedBody.simulateWorkMs)) && Number(parsedBody.simulateWorkMs) > 0) {
      await sleep(Math.max(1, Math.trunc(Number(parsedBody.simulateWorkMs))));
    }
    try {
      await ensureManagedLlamaReadyForModelRequest(ctx);
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const result = await executeRepoSearchRequest({
        taskKind: 'repo-search',
        prompt: parsedBody.prompt,
        repoRoot: typeof parsedBody.repoRoot === 'string' && (parsedBody.repoRoot as string).trim() ? (parsedBody.repoRoot as string).trim() : process.cwd(),
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config: readConfig(configPath),
        model: typeof parsedBody.model === 'string' && (parsedBody.model as string).trim() ? (parsedBody.model as string).trim() : undefined,
        maxTurns: Number.isFinite(Number(parsedBody.maxTurns)) ? Number(parsedBody.maxTurns) : undefined,
        thinkingInterval: Number.isFinite(Number(parsedBody.thinkingInterval)) ? Number(parsedBody.thinkingInterval) : undefined,
        logFile: typeof parsedBody.logFile === 'string' && (parsedBody.logFile as string).trim() ? (parsedBody.logFile as string).trim() : undefined,
        availableModels: Array.isArray(parsedBody.availableModels) ? (parsedBody.availableModels as unknown[]).map((v) => String(v)) : undefined,
        mockResponses: Array.isArray(parsedBody.mockResponses) ? (parsedBody.mockResponses as unknown[]).map((v) => String(v)) : undefined,
        mockCommandResults: (parsedBody.mockCommandResults && typeof parsedBody.mockCommandResults === 'object' && !Array.isArray(parsedBody.mockCommandResults)) ? parsedBody.mockCommandResults : undefined,
        onProgress(event: RepoSearchProgressEvent) {
          if (event.kind === 'tool_start' || event.kind === 'llm_start' || event.kind === 'llm_end') {
            const logMessage = buildRepoSearchProgressLogMessage(event, 'repo_search');
            if (logMessage) logLine(logMessage);
          }
        },
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Status (POST)
  // -------------------------------------------------------------------------

  if (req.method === 'POST' && req.url === '/status') {
    const bodyText = await readBody(req);
    const running = parseRunning(bodyText);
    if (running === null) {
      sendJson(res, 400, { error: 'Expected running=true|false or status=true|false.' });
      return true;
    }
    const metadata = parseStatusMetadata(bodyText);
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
        saveContentAtomically(artifactPath, `${JSON.stringify(metadata.artifactPayload, null, 2)}\n`);
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
      && metadata.requestDurationMs === null;
    if (isArtifactOnlyPost) {
      const publishedStatus = getPublishedStatusText(ctx);
      sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
      return true;
    }
    const requestId = getResolvedRequestId(metadata, statusPath);
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
      const needsGpuLock = !activeRun;
      if (metadata.inputCharactersPerContextToken !== null) {
        ctx.pendingIdleSummaryMetadata.inputCharactersPerContextToken = metadata.inputCharactersPerContextToken;
      }
      if (metadata.chunkThresholdCharacters !== null) {
        ctx.pendingIdleSummaryMetadata.chunkThresholdCharacters = metadata.chunkThresholdCharacters;
      }
      if (activeRun && activeRequestId !== requestId) {
        if (activeRun.lastNotificationWasRunning) {
          // Another request is actively running — tell the caller to wait and retry.
          sendJson(res, 200, { ok: true, busy: true, statusPath, configPath });
          return true;
        }
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
          lastNotificationWasRunning: true,
        };
      } else {
        runState.lastNotificationWasRunning = true;
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
      ctx.activeRunsByRequestId.set(requestId, runState);
      ctx.activeRequestIdByStatusPath.set(statusPath, requestId);
      if (needsGpuLock) {
        await ensureSiftKitGpuLockAcquired(ctx);
      }
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
        if (metadata.terminalState === null) {
          runState.lastNotificationWasRunning = false;
        }
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
      const inputCharactersDelta = metadata.promptCharacterCount ?? 0;
      const outputCharactersDelta = metadata.outputCharacterCount ?? 0;
      const inputTokensDelta = metadata.inputTokens ?? 0;
      const outputTokensDelta = metadata.outputTokens ?? 0;
      const toolTokensDelta = metadata.toolTokens ?? 0;
      const thinkingTokensDelta = metadata.thinkingTokens ?? 0;
      const promptCacheTokensDelta = metadata.promptCacheTokens ?? 0;
      const promptEvalTokensDelta = metadata.promptEvalTokens ?? 0;
      const requestDurationMsDelta = (
        metadata.requestDurationMs
        ?? (metadata.terminalState ? 0 : (elapsedMs ?? 0))
      );
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
          requestDurationMsTotal: previousTaskTotals.requestDurationMsTotal + requestDurationMsDelta,
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
        requestDurationMsTotal: ctx.metrics.requestDurationMsTotal + requestDurationMsDelta,
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
    if (!suppressLogLine) {
      logLine(logMessage);
    }
    if (!running) {
      const taskKind = normalizeTaskKind(metadata.taskKind);
      if (taskKind && metadata.toolStats) {
        for (const toolLogLine of buildToolStatsLogMessages(taskKind, metadata.toolStats)) {
          logLine(toolLogLine);
        }
      }
    }
    const publishedStatus = getPublishedStatusText(ctx);
    writePublishedStatus(ctx, publishedStatus);
    sendJson(res, 200, { ok: true, running: publishedStatus === STATUS_TRUE, status: publishedStatus, statusPath, configPath });
    return true;
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  if (req.method === 'GET' && req.url === '/config') {
    try {
      if (disableManagedLlamaStartup) {
        sendJson(res, 200, readConfig(configPath));
        return true;
      }
      if (ctx.bootstrapManagedLlamaStartup && (ctx.managedLlamaStarting || ctx.managedLlamaStartupPromise)) {
        sendJson(res, 200, readConfig(configPath));
        return true;
      }
      sendJson(res, 200, await ctx.ensureManagedLlamaReady());
    } catch (error) {
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === 'PUT' && req.url === '/config') {
    let parsedBody: Dict;
    try {
      parsedBody = JSON.parse(await readBody(req) || '{}') as Dict;
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const nextConfig = normalizeConfig(mergeConfig(readConfig(configPath), parsedBody));
    writeConfig(configPath, nextConfig);
    sendJson(res, 200, nextConfig);
    return true;
  }

  return false;
}
