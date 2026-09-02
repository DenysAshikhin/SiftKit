import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from '../../lib/zod.js';
import { toError } from '../../lib/errors.js';
import { mergeToolTypeStats } from '../../line-read-guidance.js';
import { getRuntimeDatabase } from '../../state/runtime-db.js';
import { upsertRuntimeJsonArtifact } from '../../state/runtime-artifacts.js';
import {
  STATUS_TRUE,
  parseRunning,
  parseStatusMetadata,
  parseStatusMetadataRecord,
} from '../status-file.js';
import { normalizeMetrics, writeMetrics } from '../metrics.js';
import { recordWebSearchUsage } from '../web-search-usage.js';
import {
  buildStatusRequestLogBody,
  upsertRunArtifactPayload,
  updateRunLogSpeculativeMetricsByRequestId,
} from '../dashboard-runs.js';
import {
  StatusArtifactTypeSchema,
  getStatusArtifactId,
  getStatusArtifactUri,
} from '../../state/status-artifacts.js';
import { serverLogger } from '../server-logger.js';
import type { ServerContext } from '../server-types.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import {
  clearIdleSummaryTimer,
  enqueueDeferredArtifacts,
  getIdleSummaryDatabase,
  getPublishedStatusText,
  scheduleIdleSummaryIfNeeded,
  writePublishedStatus,
} from '../server-ops.js';
import {
  buildStatusRunStartInput,
  type ActiveRunState,
} from '../status-run-registry.js';
import {
  enqueueTerminalMetadata,
  scheduleDeferredTerminalMetadata,
} from '../terminal-metadata.js';
import {
  logToolStatsLines,
  normalizeTaskKind,
} from '../status-run-log.js';
import {
  readBody,
  parseJsonBody,
  sendBodyReadError,
  sendJson,
} from '../http-utils.js';
import { sendServerErrorJson } from '../error-response.js';

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

export class StatusCompleteEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    _match: RouteMatch,
  ): Promise<void> {
    const { statusPath } = ctx;
    const routeStartedAt = Date.now();
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
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
    serverLogger.debug({ scope: 'st', id: requestId, event: 'complete_start', fields: `state=${terminalState}` });
    const result = ctx.statusRuns.markComplete(requestId, terminalState, Date.now());
    switch (result.kind) {
      case 'completed':
      case 'completed-without-run':
        break;
      case 'duplicate':
        serverLogger.dim({ scope: 'st', id: requestId, event: 'complete_duplicate', fields: `state=${terminalState}` });
        break;
    }
    writePublishedStatus(ctx, getPublishedStatusText(ctx));
    serverLogger.ok({
      scope: 'st',
      id: requestId,
      event: 'complete_done',
      fields: `state=${terminalState} duration_ms=${Date.now() - routeStartedAt}`,
    });
    sendJson(res, 200, { ok: true, requestId, terminalState, statusPath: completedStatusPath });
    return;
  }
}

export class StatusPostEndpoint implements RouteEndpoint {
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
    let bodyText: string;
    try {
      bodyText = await readBody(this.req);
    } catch (error) {
      sendBodyReadError(this.res, toError(error), { error: 'Expected running=true|false or status=true|false.' });
      return;
    }
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
    const requestId = metadata.requestId;
    if (!requestId) {
      sendJson(this.res, 400, { error: 'Expected requestId.' });
      return;
    }
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
    const requestId = metadata.requestId;
    if (!requestId) {
      sendJson(this.res, 400, { error: 'Expected requestId.' });
      return;
    }
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
    const parsedArtifactType = StatusArtifactTypeSchema.safeParse(metadata.artifactType);
    if (!parsedArtifactType.success) {
      sendJson(this.res, 400, { error: 'Unsupported artifactType.' });
      return true;
    }
    const artifactType = parsedArtifactType.data;
    try {
      upsertRuntimeJsonArtifact({
        id: getStatusArtifactId(artifactType, metadata.artifactRequestId),
        artifactKind: `status_${artifactType}`,
        requestId: metadata.artifactRequestId,
        title: getStatusArtifactUri(artifactType, metadata.artifactRequestId),
        payload: metadata.artifactPayload,
      });
      upsertRunArtifactPayload({
        database: getIdleSummaryDatabase(this.ctx),
        requestId: metadata.artifactRequestId,
        artifactType,
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
    const resolution = this.ctx.statusRuns.resolveTerminalRun(requestId);
    switch (resolution.kind) {
      case 'awaiting':
      case 'duplicate':
        serverLogger.dim({
          scope: 'st',
          id: requestId,
          event: running ? 'late_running_ignored' : 'late_status_ignored',
          fields: `task=${metadata.taskKind ?? 'unknown'}`,
        });
        this.sendCurrentStatus();
        return true;
      case 'active':
      case 'unknown':
        break;
    }
    return false;
  }

  private startRunState(requestId: string, metadata: StatusPostMetadata): StatusPostTimingResult {
    clearIdleSummaryTimer(this.ctx);
    const now = Date.now();
    this.capturePendingIdleSummaryMetadata(metadata);
    this.ctx.statusRuns.startOrAdvance(buildStatusRunStartInput(
      requestId,
      this.statusPath,
      metadata,
      normalizeTaskKind(metadata.taskKind),
      now,
    ));
    return { elapsedMs: null, totalElapsedMs: null, requestCompleted: false, suppressLogLine: false };
  }

  private capturePendingIdleSummaryMetadata(metadata: StatusPostMetadata): void {
    if (metadata.inputCharactersPerContextToken !== null) {
      this.ctx.idleSummary.pendingMetadata.inputCharactersPerContextToken = metadata.inputCharactersPerContextToken;
    }
    if (metadata.chunkThresholdCharacters !== null) {
      this.ctx.idleSummary.pendingMetadata.chunkThresholdCharacters = metadata.chunkThresholdCharacters;
    }
  }

  private finishRunState(
    requestId: string,
    metadata: StatusPostMetadata,
    deferredMetadata: StatusPostDeferredMetadata | null,
  ): StatusPostTimingResult {
    const resolution = this.ctx.statusRuns.resolveTerminalRun(requestId);
    const runState = resolution.kind === 'active' ? resolution.run : null;
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
      startedAtUtc: runState ? new Date(runState.overallStartedAt).toISOString() : null,
      finishedAtUtc: new Date().toISOString(),
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
    this.applySpeculativeMetrics(requestId, sourceMetadata, targetMetadata);
    if (sourceMetadata.terminalState === 'completed') {
      timing.totalElapsedMs = now - runState.overallStartedAt;
      targetMetadata.totalOutputTokens = runState.outputTokensTotal;
      this.ctx.statusRuns.finalizeTerminal(requestId, now);
      timing.requestCompleted = true;
    } else if (sourceMetadata.terminalState === 'failed') {
      timing.totalElapsedMs = now - runState.overallStartedAt;
      this.ctx.statusRuns.finalizeTerminal(requestId, now);
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
  ): void {
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
      this.ctx.idleSummary.pending = true;
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
    const logBody = buildStatusRequestLogBody({
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
      thinkingTokens: metadata.thinkingTokens,
      toolTokens: metadata.toolTokens,
      totalOutputTokens: metadata.totalOutputTokens ?? null,
    });
    if (!timing.suppressLogLine && deferredMetadata === null) serverLogger.emitBody('st', requestId, logBody);
    if (!running && deferredMetadata === null) this.logToolStats(requestId, metadata);
  }

  private logToolStats(requestId: string, metadata: StatusPostMetadata): void {
    const taskKind = normalizeTaskKind(metadata.taskKind);
    if (!taskKind || !metadata.toolStats) return;
    logToolStatsLines(requestId, taskKind, metadata.toolStats);
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
