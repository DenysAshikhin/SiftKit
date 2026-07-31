/**
 * Dashboard chat session routes: CRUD, message generation, streaming,
 * plan/repo-search execution, condensation, and tool-context management.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ChatSession as WireChatSession,
  ChatMessage as WireChatMessage,
  ChatSessionResponse,
  ChatSessionsResponse,
} from '@siftkit/contracts';
import type { ChatMessage as PersistedChatMessage } from '../../state/chat-sessions.js';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { OptionalJsonValue } from '../../lib/json-types.js';
import type { ChatGroundingStatus } from '../../repo-search/chat-grounding-policy.js';
import { getRuntimeRoot } from '../paths.js';
import { toError } from '../../lib/errors.js';
import {
  readBody,
  parseJsonBody,
  sendBodyReadError,
  sendJson,
} from '../http-utils.js';
import { readConfig } from '../config-store.js';
import {
  applyHostLlamaRuntimeSettings,
  getActiveModelPreset,
  getConfiguredLlamaBaseUrl,
  getConfiguredLlamaNumCtx,
  getConfiguredReasoning,
  notifyStatusBackend,
  SIFT_DEFAULT_LLAMA_BASE_URL,
  type SiftConfig,
} from '../../config/index.js';
import { assertPresetAcceptsImages } from '../../llm-protocol/image-attachments.js';
import {
  type RepoSearchProgressEvent,
  buildRepoSearchProgressLogBody,
  removeDashboardRunCommandFromLogs,
} from '../dashboard-runs.js';
import {
  buildContextUsage,
  resolveChatSessionModel,
  resolveChatSessionContextWindow,
  resolveChatSessionConfig,
  type ContextUsage,
  type ChatUsage,
  type PersistTurn,
  appendChatMessagesWithUsage,
  buildChatSystemContent,
  buildChatHistoryMessages,
  condenseChatSession,
  getScorecardTotal,
  buildPersistTurnsFromRepoSearchResult,
  buildRetainedWebToolCalls,
} from '../chat.js';
import { buildChatPromptContext } from '../chat-prompt-context.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import {
  parseChatMessageRequest,
  parseChatRepoRequest,
  parseChatSessionCreateRequest,
  parseChatSessionUpdateRequest,
} from '../chat-route-request-normalizers.js';
import { normalizeRepoSearchScorecard, type RepoSearchTotals } from '../repo-search-scorecard-types.js';
import {
  type ChatSession,
  readChatSessionFromPath,
  readChatSessions,
  getChatSessionPath,
  deleteChatSession,
  deleteChatMessage,
  saveChatSession,
} from '../../state/chat-sessions.js';
import { getRuntimeDatabase } from '../../state/runtime-db.js';
import type { SiftPreset } from '../../presets.js';
import { PresetCatalog } from '../../preset-catalog.js';
import {
  ChatOperationPresetSelector,
  type SelectedChatOperationPreset,
} from '../chat-operation-preset.js';
import {
  ChatRepoOperationRunner,
  type ChatRepoOperationRequest,
} from '../chat-repo-operation-runner.js';
import { ChatTurnPhaseTracker } from '../chat-turn-phase-tracker.js';
import { ChatTurnTelemetry } from '../chat-turn-telemetry.js';
import {
  captureManagedLlamaSpeculativeMetricsSnapshot,
  getManagedLlamaSpeculativeMetricsDelta,
} from '../managed-llama.js';
import { serverLogger } from '../server-logger.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
  ensureActivePresetReadyForModelRequest,
} from '../server-ops.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';
import { ProgressWriter } from '../../lib/progress-writer.js';

const DEFAULT_STATUS_MODEL_REQUEST_TIMEOUT_MS = 30_000;

async function readEffectiveChatRouteConfig(configPath: string): Promise<SiftConfig> {
  const localConfig = readConfig(configPath);
  return await applyHostLlamaRuntimeSettings(localConfig);
}

function normalizeChatGroundingStatus(value: ChatGroundingStatus | null | undefined): ChatGroundingStatus | null {
  if (value === 'ungrounded' || value === 'snippet_only' || value === 'fetched') {
    return value;
  }
  return null;
}

function getChatGroundingStatus(scorecard: OptionalJsonValue): ChatGroundingStatus | null {
  return normalizeChatGroundingStatus(normalizeRepoSearchScorecard(scorecard).tasks[0]?.groundingStatus);
}

function requireToolCallId(event: RepoSearchProgressEvent): string {
  const value = typeof event.toolCallId === 'string' ? event.toolCallId.trim() : '';
  if (!value) {
    throw new Error(`repo-search ${event.kind} progress event missing toolCallId`);
  }
  return value;
}

function forwardRepoSearchToolEvent(
  writer: SseResponseWriter,
  event: RepoSearchProgressEvent,
  scope: 'plan' | 'rs',
  requestId: string,
): void {
  if (event.kind === 'tool_start') {
    const body = buildRepoSearchProgressLogBody(event);
    if (body) serverLogger.emitBody(scope, requestId, body);
    writer.writeEvent('tool_start', {
      toolCallId: requireToolCallId(event),
      turn: event.turn,
      maxTurns: event.maxTurns,
      command: event.command,
      promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
    });
    return;
  }
  if (event.kind === 'tool_result') {
    writer.writeEvent('tool_result', {
      toolCallId: requireToolCallId(event),
      turn: event.turn,
      maxTurns: event.maxTurns,
      command: event.command,
      exitCode: event.exitCode,
      outputSnippet: event.outputSnippet,
      outputTokens: Number.isFinite(event.outputTokens) ? Number(event.outputTokens) : null,
      outputTokensEstimated: event.outputTokensEstimated === true,
      promptTokenCount: Number.isFinite(event.promptTokenCount) ? Number(event.promptTokenCount) : null,
    });
  }
}

function withPromptContext(config: SiftConfig, session: ChatSession): ChatSession {
  return {
    ...session,
    promptContext: buildChatPromptContext(config, session),
  };
}

function toWireChatMessage(message: PersistedChatMessage): WireChatMessage {
  return { ...message, sourceRunId: message.sourceRunId ?? null };
}

function toWireChatSession(config: SiftConfig, session: ChatSession): WireChatSession {
  return {
    id: session.id,
    title: session.title ?? '',
    modelPresetId: session.modelPresetId,
    model: resolveChatSessionModel(config, session),
    contextWindowTokens: resolveChatSessionContextWindow(config, session),
    thinkingEnabled: session.thinkingEnabled,
    webSearchEnabled: session.webSearchEnabled,
    presetId: session.presetId,
    mode: session.mode,
    planRepoRoot: session.planRepoRoot,
    condensedSummary: session.condensedSummary ?? '',
    createdAtUtc: session.createdAtUtc ?? '',
    updatedAtUtc: session.updatedAtUtc ?? '',
    messages: (session.messages ?? []).map(toWireChatMessage),
    promptContext: session.promptContext,
  };
}

function buildChatSessionResponse(config: SiftConfig, session: ChatSession): ChatSessionResponse {
  return {
    session: toWireChatSession(config, withPromptContext(config, session)),
    contextUsage: buildContextUsage(config, session),
  };
}

function hasEstimatedScorecardTokens(scorecard: OptionalJsonValue, key: keyof RepoSearchTotals): boolean {
  const count = getScorecardTotal(scorecard, key);
  return count !== null && count > 0;
}

function getMockTokenConfig(config: SiftConfig, mockResponses: string[] | undefined): SiftConfig | undefined {
  return Array.isArray(mockResponses) ? undefined : config;
}

function getLocalTokenConfig(config: SiftConfig): SiftConfig | undefined {
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  return baseUrl === SIFT_DEFAULT_LLAMA_BASE_URL ? undefined : config;
}

function readRouteStringArray(reader: JsonRecordReader, key: string): string[] | undefined {
  const value = reader.value(key);
  return Array.isArray(value) ? value.map((entry) => String(entry)) : undefined;
}

function readRouteNumber(reader: JsonRecordReader, key: string): number | undefined {
  return reader.number(key) ?? undefined;
}

function buildChatRepoOperationRequest(options: {
  ctx: ServerContext;
  runtimeRoot: string;
  session: ChatSession;
  config: SiftConfig;
  content: string;
  repoRoot: string;
  reader: JsonRecordReader;
  parsedBody: ReturnType<typeof parseJsonBody>;
  requestId: string;
  progressWriter: ProgressWriter<RepoSearchProgressEvent>;
}): ChatRepoOperationRequest {
  return {
    runtimeRoot: options.runtimeRoot,
    session: options.session,
    config: options.config,
    content: options.content,
    repoRoot: options.repoRoot,
    statusBackendUrl: `${options.ctx.getServiceBaseUrl()}/status`,
    engineService: options.ctx.engineService,
    progressWriter: options.progressWriter,
    requestId: options.requestId,
    maxTurns: readRouteNumber(options.reader, 'maxTurns'),
    logFile: options.reader.optionalString('logFile'),
    availableModels: readRouteStringArray(options.reader, 'availableModels'),
    mockResponses: readRouteStringArray(options.reader, 'mockResponses'),
    mockCommandResults: normalizeRepoSearchMockCommandResults(options.parsedBody.mockCommandResults),
    managedLlamaRunId: options.ctx.managedLlamaLastStartupLogs?.runId ?? null,
  };
}

function readSessionRepoRoot(session: ChatSession): string {
  return typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
    ? session.planRepoRoot.trim()
    : process.cwd();
}

function resolveChatRepoRoot(request: { repoRoot?: string }, session: ChatSession): string {
  return resolve(request.repoRoot || readSessionRepoRoot(session));
}

type SessionSpeculativeMetrics = {
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
};

class ChatStreamProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(
    private readonly writer: SseResponseWriter,
    private readonly phaseTracker: ChatTurnPhaseTracker | null,
    private readonly scope: 'plan' | 'rs',
    private readonly requestId: string,
    private readonly thinkingEvent: 'thinking' | 'answer',
    private readonly streamAnswer: boolean,
  ) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'context_warning') {
      this.writer.writeEvent('warning', { warning: event.warningText ?? '' });
      return;
    }
    if (event.kind === 'thinking') {
      const text = event.thinkingText || '';
      this.phaseTracker?.observeThinking(text);
      this.writer.writeEvent(this.thinkingEvent, this.thinkingEvent === 'thinking'
        ? { thinking: text }
        : { answer: text });
      return;
    }
    if (event.kind === 'answer' && this.streamAnswer) {
      const text = event.answerText || '';
      this.phaseTracker?.observeAnswer(text);
      this.writer.writeEvent('answer', { answer: text });
      return;
    }
    forwardRepoSearchToolEvent(this.writer, event, this.scope, this.requestId);
  }
}

class RepoSearchToolLogProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(
    private readonly scope: 'plan' | 'rs',
    private readonly requestId: string,
  ) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    if (event.kind !== 'tool_start' && event.kind !== 'context_warning') return;
    const body = buildRepoSearchProgressLogBody(event);
    if (body) {
      serverLogger.emitBody(this.scope, this.requestId, body);
    }
  }
}

function captureManagedLlamaSessionCursor(ctx: ServerContext) {
  return captureManagedLlamaSpeculativeMetricsSnapshot(ctx.managedLlamaLastStartupLogs?.runId ?? null);
}

function readScorecardSpeculativeMetrics(scorecard: OptionalJsonValue): SessionSpeculativeMetrics {
  return {
    speculativeAcceptedTokens: getScorecardTotal(scorecard, 'speculativeAcceptedTokens'),
    speculativeGeneratedTokens: getScorecardTotal(scorecard, 'speculativeGeneratedTokens'),
  };
}

/**
 * One speculative-token policy for every chat route: the managed llama startup-log
 * delta wins, and the turn's own usage/scorecard totals fill in whenever no managed
 * process is being tracked.
 */
function resolveSessionSpeculativeMetrics(
  ctx: ServerContext,
  cursor: ReturnType<typeof captureManagedLlamaSessionCursor>,
  fallback: Partial<SessionSpeculativeMetrics>,
): SessionSpeculativeMetrics {
  const tracked = cursor
    ? getManagedLlamaSpeculativeMetricsDelta(ctx.managedLlamaLastStartupLogs?.runId ?? null, cursor)
    : null;
  return {
    speculativeAcceptedTokens: tracked?.speculativeAcceptedTokens ?? fallback.speculativeAcceptedTokens ?? null,
    speculativeGeneratedTokens: tracked?.speculativeGeneratedTokens ?? fallback.speculativeGeneratedTokens ?? null,
  };
}

class ListChatSessionsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const config = readConfig(configPath);
    const sessionsResponse: ChatSessionsResponse = {
      sessions: readChatSessions(runtimeRoot).map((session) => toWireChatSession(config, withPromptContext(config, session))),
    };
    sendJson(res, 200, sessionsResponse);
    return;
  }
}

class GetChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), session));
    return;
  }
}

class UpdateChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const requestReader = new JsonRecordReader(parsedBody);
    if (requestReader.value('mode') !== undefined) {
      sendJson(res, 400, { error: 'Session mode is derived from presetId.' });
      return;
    }
    const updateRequest = parseChatSessionUpdateRequest(parsedBody);
    if (requestReader.value('presetId') !== undefined && !updateRequest.presetId) {
      sendJson(res, 400, { error: 'Expected a non-empty presetId.' });
      return;
    }
    const updated: ChatSession = { ...session, updatedAtUtc: new Date().toISOString() };
    if (updateRequest.title) {
      updated.title = updateRequest.title;
    }
    if (updateRequest.thinkingEnabled !== undefined) {
      updated.thinkingEnabled = updateRequest.thinkingEnabled;
    }
    if (updateRequest.webSearchEnabled !== undefined) {
      updated.webSearchEnabled = updateRequest.webSearchEnabled;
    }
    const currentConfig = readConfig(configPath);
    const presets = PresetCatalog.fromPresets(currentConfig.Presets);
    if (updateRequest.presetId) {
      try {
        const preset = presets.requireById(updateRequest.presetId);
        updated.presetId = preset.id;
        updated.mode = presets.deriveChatSessionMode(preset.id);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    if (updateRequest.planRepoRoot) {
      updated.planRepoRoot = resolve(updateRequest.planRepoRoot);
    }
    saveChatSession(runtimeRoot, updated);
    sendJson(res, 200, buildChatSessionResponse(currentConfig, updated));
    return;
  }
}

class DeleteChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    const deleted = deleteChatSession(runtimeRoot, sessionId);
    if (!deleted) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    sendJson(res, 200, { ok: true, deleted: true, id: sessionId });
    return;
  }
}

class DeleteChatMessageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const match = /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/u.exec(pathname);
    const sessionId = decodeURIComponent(match?.[1] || '');
    const messageId = decodeURIComponent(match?.[2] || '');
    const result = deleteChatMessage(runtimeRoot, sessionId, messageId);
    if (!result) {
      sendJson(res, 404, { error: 'Message not found.' });
      return;
    }
    const deletedMessage = result.deletedMessage;
    const runId = typeof deletedMessage.sourceRunId === 'string' ? deletedMessage.sourceRunId.trim() : '';
    const commandText = typeof deletedMessage.toolCallCommand === 'string'
      ? deletedMessage.toolCallCommand.trim()
      : '';
    if (runId && commandText) {
      removeDashboardRunCommandFromLogs(getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite')), runId, commandText);
    }
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId)) || result.session;
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), session));
    return;
  }
}

class CreateChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const requestReader = new JsonRecordReader(parsedBody);
    const createRequest = parseChatSessionCreateRequest(parsedBody);
    if (requestReader.value('presetId') !== undefined && !requestReader.optionalString('presetId')) {
      sendJson(res, 400, { error: 'Expected a non-empty presetId.' });
      return;
    }
    const now = new Date().toISOString();
    const currentConfig = await readEffectiveChatRouteConfig(configPath);
    const presets = PresetCatalog.fromPresets(currentConfig.Presets);
    const activePreset = getActiveModelPreset(currentConfig);
    let preset: SiftPreset;
    try {
      preset = presets.requireById(createRequest.presetId);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const session: ChatSession = {
      id: randomUUID(),
      title: createRequest.title || 'New Session',
      modelPresetId: activePreset.id,
      modelPreset: activePreset,
      thinkingEnabled: getConfiguredReasoning(currentConfig) !== 'off',
      webSearchEnabled: currentConfig.WebSearch.EnabledDefault === true,
      presetId: preset.id,
      mode: presets.deriveChatSessionMode(preset.id),
      planRepoRoot: process.cwd(),
      condensedSummary: '',
      createdAtUtc: now,
      updatedAtUtc: now,
      messages: [],
    };
    saveChatSession(runtimeRoot, session);
    sendJson(res, 200, buildChatSessionResponse(currentConfig, session));
    return;
  }
}

type ChatTurnContent = {
  assistantContent: string;
  usage: Partial<ChatUsage>;
  persistTurns: PersistTurn[];
  sourceRunId: string | null;
};

/**
 * One turn on the non-streaming chat message route. The two modes are separate flows:
 * an engine turn is reported to /status by executeRepoSearch and correlates with the
 * engine run id, while a client-supplied assistant message makes no engine call, so it
 * reports itself and has no run to correlate with.
 */
class ChatMessageTurn {
  private readonly requestId = randomUUID();
  private readonly startedAt = Date.now();
  private readonly requestStartedAtUtc = new Date(this.startedAt).toISOString();
  private readonly managedLlamaCursor: ReturnType<typeof captureManagedLlamaSessionCursor>;

  constructor(
    private readonly ctx: ServerContext,
    private readonly res: ServerResponse,
    private readonly runtimeRoot: string,
    private readonly session: ChatSession,
    private readonly config: SiftConfig,
    private readonly preset: SiftPreset,
    private readonly userContent: string,
    private readonly userImages: string[],
    private readonly mockResponses: string[] | undefined,
  ) {
    this.managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
  }

  async runEngineTurn(): Promise<void> {
    const telemetry = new ChatTurnTelemetry(
      this.config,
      getMockTokenConfig(this.config, this.mockResponses),
    );
    try {
      const result = await this.ctx.engineService.executeRepoSearch({
        presetId: this.preset.id,
        taskKind: 'chat',
        prompt: this.userContent,
        repoRoot: process.cwd(),
        statusBackendUrl: `${this.ctx.getServiceBaseUrl()}/status`,
        config: resolveChatSessionConfig(this.config, this.session),
        systemPrompt: buildChatSystemContent(this.config, this.session),
        history: buildChatHistoryMessages(this.config, this.session),
        thinkingEnabled: this.session.thinkingEnabled !== false,
        allowedTools: [],
        initialUserImages: this.userImages,
        ...(this.mockResponses ? { mockResponses: this.mockResponses } : {}),
      });
      const scorecardTasks = normalizeRepoSearchScorecard(result.scorecard).tasks;
      const scorecardSpeculative = readScorecardSpeculativeMetrics(result.scorecard);
      await this.persistAndRespond(telemetry, {
        assistantContent: String(scorecardTasks[0]?.finalOutput || '').trim(),
        usage: {
          promptTokens: getScorecardTotal(result.scorecard, 'promptTokens'),
          completionTokens: getScorecardTotal(result.scorecard, 'outputTokens'),
          thinkingTokens: getScorecardTotal(result.scorecard, 'thinkingTokens'),
          outputTokensEstimated: hasEstimatedScorecardTokens(result.scorecard, 'outputTokensEstimatedCount'),
          thinkingTokensEstimated: hasEstimatedScorecardTokens(result.scorecard, 'thinkingTokensEstimatedCount'),
          promptCacheTokens: getScorecardTotal(result.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result.scorecard, 'promptEvalTokens'),
          speculativeAcceptedTokens: scorecardSpeculative.speculativeAcceptedTokens,
          speculativeGeneratedTokens: scorecardSpeculative.speculativeGeneratedTokens,
        },
        persistTurns: await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(result)),
        // Run rows are keyed by the engine request id, so deleting a tool bubble later
        // finds the run-log command to purge.
        sourceRunId: String(result.requestId || ''),
      });
    } catch (error) {
      this.sendFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async runProvidedAssistantTurn(assistantContent: string): Promise<void> {
    await this.notifyStatus({ running: true });
    try {
      await this.notifyStatus({
        running: false,
        terminalState: 'completed',
        outputChars: assistantContent.length,
      });
      await this.persistAndRespond(
        new ChatTurnTelemetry(this.config, getLocalTokenConfig(this.config)),
        {
          assistantContent,
          usage: {},
          persistTurns: [{ thinkingText: '', toolMessages: [] }],
          sourceRunId: null,
        },
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.notifyStatus({ running: false, terminalState: 'failed', errorMessage, outputChars: 0 });
      this.sendFailure(errorMessage);
    }
  }

  private async persistAndRespond(
    telemetry: ChatTurnTelemetry,
    turn: ChatTurnContent,
  ): Promise<void> {
    const speculativeMetrics = resolveSessionSpeculativeMetrics(this.ctx, this.managedLlamaCursor, turn.usage);
    const inputTokenCount = await telemetry.countInputTokens(this.userContent);
    const sessionWithTelemetry = appendChatMessagesWithUsage(
      this.runtimeRoot,
      this.session,
      this.userContent,
      turn.assistantContent,
      turn.usage,
      {
        turns: turn.persistTurns,
        maintainPerStepThinking: telemetry.shouldMaintainPerStepThinking(this.session),
        inputTokens: inputTokenCount.tokenCount,
        inputTokensEstimated: inputTokenCount.estimated,
        requestDurationMs: Date.now() - this.startedAt,
        requestStartedAtUtc: this.requestStartedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
        sourceRunId: turn.sourceRunId,
        images: this.userImages,
      },
    );
    sendJson(this.res, 200, buildChatSessionResponse(this.config, sessionWithTelemetry));
  }

  private async notifyStatus(options: {
    running: boolean;
    terminalState?: 'completed' | 'failed';
    errorMessage?: string;
    outputChars?: number;
  }): Promise<void> {
    try {
      await notifyStatusBackend({
        running: options.running,
        taskKind: 'chat',
        statusBackendUrl: `${this.ctx.getServiceBaseUrl()}/status`,
        requestId: this.requestId,
        rawInputCharacterCount: options.running ? this.userContent.length : undefined,
        promptCharacterCount: this.userContent.length,
        terminalState: options.terminalState,
        errorMessage: options.errorMessage,
        outputCharacterCount: options.outputChars,
        requestDurationMs: options.running ? undefined : Date.now() - this.startedAt,
      });
    } catch {
      // Best-effort metrics notification.
    }
  }

  private sendFailure(errorMessage: string): void {
    sendJson(this.res, 500, { error: errorMessage });
  }
}

class CreateChatMessageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const messageRequest = parseChatMessageRequest(parsedBody);
    if (!messageRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const providedAssistantContent = messageRequest.assistantContent || '';
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    if (!providedAssistantContent) {
      try {
        await ensureActivePresetReadyForModelRequest(ctx);
      } catch (error) {
        releaseModelRequest(ctx, modelRequestLock.token);
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    try {
      const config = readConfig(configPath);
      let selected: SelectedChatOperationPreset;
      try {
        selected = new ChatOperationPresetSelector(config.Presets)
          .select(activeSession, 'chat');
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      assertPresetAcceptsImages(getActiveModelPreset(config), messageRequest.images);
      const turn = new ChatMessageTurn(
        ctx,
        res,
        runtimeRoot,
        selected.session,
        config,
        selected.preset,
        messageRequest.content,
        messageRequest.images,
        readRouteStringArray(new JsonRecordReader(parsedBody), 'mockResponses'),
      );
      if (providedAssistantContent) {
        await turn.runProvidedAssistantTurn(providedAssistantContent);
      } else {
        await turn.runEngineTurn();
      }
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class StreamChatMessageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/messages\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const messageRequest = parseChatMessageRequest(parsedBody);
    if (!messageRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const sseWriter = new SseResponseWriter(req, res);
    sseWriter.open();
    const userContent = messageRequest.content;
    const startedAt = Date.now();
    const requestStartedAtUtc = new Date(startedAt).toISOString();
    const phaseTracker = new ChatTurnPhaseTracker(requestStartedAtUtc);
    const managedLlamaCursor = captureManagedLlamaSessionCursor(ctx);
    // Status reporting for this turn belongs to executeRepoSearchRequest; there is no
    // non-engine branch here to report for.
    try {
      const config = readConfig(configPath);
      const selected = new ChatOperationPresetSelector(config.Presets).select(activeSession, 'chat');
      assertPresetAcceptsImages(getActiveModelPreset(config), messageRequest.images);
      const selectedSession = selected.session;
      const reader = new JsonRecordReader(parsedBody);
      const webOverrideRaw = reader.optionalString('webSearchOverride');
      const webEnabled = webOverrideRaw === 'on'
        ? true
        : webOverrideRaw === 'off'
          ? false
          : selectedSession.webSearchEnabled === true;
      const mockResponses = readRouteStringArray(reader, 'mockResponses');
      const mockTokenConfig = getMockTokenConfig(config, mockResponses);
      const telemetry = new ChatTurnTelemetry(config, mockTokenConfig);
      const engineRequestId = randomUUID();
      const result = await ctx.engineService.executeRepoSearch({
        presetId: selected.preset.id,
        requestId: engineRequestId,
        taskKind: 'chat',
        prompt: userContent,
        repoRoot: process.cwd(),
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config: resolveChatSessionConfig(config, selectedSession),
        systemPrompt: buildChatSystemContent(config, selectedSession),
        history: buildChatHistoryMessages(config, selectedSession),
        thinkingEnabled: selectedSession.thinkingEnabled !== false,
        allowedTools: webEnabled ? ['web_search', 'web_fetch'] : [],
        retainedWebToolCalls: webEnabled ? buildRetainedWebToolCalls(selectedSession) : [],
        maxTurns: readRouteNumber(reader, 'maxTurns'),
        availableModels: readRouteStringArray(reader, 'availableModels'),
        mockCommandResults: normalizeRepoSearchMockCommandResults(parsedBody.mockCommandResults),
        initialUserImages: messageRequest.images,
        ...(mockResponses ? { mockResponses } : {}),
        progressWriter: new ChatStreamProgressWriter(
          sseWriter,
          phaseTracker,
          'plan',
          engineRequestId,
          'thinking',
          true,
        ),
      });
      const scorecardTasks = normalizeRepoSearchScorecard(result.scorecard).tasks;
      const assistantContent = String(scorecardTasks[0]?.finalOutput || '').trim();
      const scorecardSpeculative = readScorecardSpeculativeMetrics(result?.scorecard);
      const usage: ChatUsage = {
        promptTokens: getScorecardTotal(result?.scorecard, 'promptTokens'),
        completionTokens: getScorecardTotal(result?.scorecard, 'outputTokens'),
        thinkingTokens: getScorecardTotal(result?.scorecard, 'thinkingTokens'),
        outputTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'outputTokensEstimatedCount'),
        thinkingTokensEstimated: hasEstimatedScorecardTokens(result?.scorecard, 'thinkingTokensEstimatedCount'),
        promptCacheTokens: getScorecardTotal(result?.scorecard, 'promptCacheTokens'),
        promptEvalTokens: getScorecardTotal(result?.scorecard, 'promptEvalTokens'),
        promptEvalDurationMs: getScorecardTotal(result?.scorecard, 'promptEvalDurationMs'),
        generationDurationMs: getScorecardTotal(result?.scorecard, 'generationDurationMs'),
        promptTokensPerSecond: null,
        generationTokensPerSecond: null,
        speculativeAcceptedTokens: scorecardSpeculative.speculativeAcceptedTokens,
        speculativeGeneratedTokens: scorecardSpeculative.speculativeGeneratedTokens,
      };
      const persistTurns = await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(result));
      const speculativeMetrics = resolveSessionSpeculativeMetrics(ctx, managedLlamaCursor, scorecardSpeculative);
      phaseTracker.observeAnswer(assistantContent);
      const phaseTimestamps = phaseTracker.snapshot();
      const inputTokenCount = await telemetry.countInputTokens(userContent);
      const updatedSession = appendChatMessagesWithUsage(runtimeRoot, selectedSession, userContent, assistantContent, usage, {
        turns: persistTurns,
        maintainPerStepThinking: telemetry.shouldMaintainPerStepThinking(selectedSession),
        inputTokens: inputTokenCount.tokenCount,
        inputTokensEstimated: inputTokenCount.estimated,
        requestDurationMs: Date.now() - startedAt,
        requestStartedAtUtc: phaseTimestamps.requestStartedAtUtc,
        thinkingStartedAtUtc: phaseTimestamps.thinkingStartedAtUtc,
        thinkingEndedAtUtc: phaseTimestamps.thinkingEndedAtUtc,
        answerStartedAtUtc: phaseTimestamps.answerStartedAtUtc,
        answerEndedAtUtc: phaseTimestamps.answerEndedAtUtc,
        speculativeAcceptedTokens: speculativeMetrics.speculativeAcceptedTokens,
        speculativeGeneratedTokens: speculativeMetrics.speculativeGeneratedTokens,
        groundingStatus: getChatGroundingStatus(result.scorecard),
        sourceRunId: String(result.requestId || ''),
        images: messageRequest.images,
      });
      sseWriter.writeEvent('done', buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      sseWriter.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter.end();
    }
    return;
  }
}

class CreateChatPlanEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const repoRequest = parseChatRepoRequest(parsedBody);
    if (!repoRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const resolvedRepoRoot = resolveChatRepoRoot(repoRequest, session);
    if (!existsSync(resolvedRepoRoot) || !statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      try {
        await ensureActivePresetReadyForModelRequest(ctx);
      } catch (error) {
        sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const content = repoRequest.content;
      const reader = new JsonRecordReader(parsedBody);
      const config = readConfig(configPath);
      const engineRequestId = randomUUID();
      const result = await new ChatRepoOperationRunner().runPlan(buildChatRepoOperationRequest({
        ctx,
        runtimeRoot,
        session: activeSession,
        config,
        content,
        repoRoot: resolvedRepoRoot,
        reader,
        parsedBody,
        requestId: engineRequestId,
        progressWriter: new RepoSearchToolLogProgressWriter('plan', engineRequestId),
      }));
      sendJson(res, 200, {
        ...buildChatSessionResponse(config, result.updatedSession),
        repoSearch: result.repoSearch,
      });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return;
  }
}

class StreamChatPlanEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/plan\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const repoRequest = parseChatRepoRequest(parsedBody);
    if (!repoRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const resolvedRepoRoot = resolveChatRepoRoot(repoRequest, session);
    if (!existsSync(resolvedRepoRoot) || !statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const sseWriter = new SseResponseWriter(req, res);
    sseWriter.open();
    try {
      const content = repoRequest.content;
      const reader = new JsonRecordReader(parsedBody);
      const config = readConfig(configPath);
      const engineRequestId = randomUUID();
      const result = await new ChatRepoOperationRunner().runPlan(buildChatRepoOperationRequest({
        ctx,
        runtimeRoot,
        session: activeSession,
        config,
        content,
        repoRoot: resolvedRepoRoot,
        reader,
        parsedBody,
        requestId: engineRequestId,
        progressWriter: new ChatStreamProgressWriter(
          sseWriter,
          null,
          'plan',
          engineRequestId,
          'thinking',
          false,
        ),
      }));
      sseWriter.writeEvent('done', {
        ...buildChatSessionResponse(config, result.updatedSession),
        repoSearch: result.repoSearch,
      });
    } catch (error) {
      sseWriter.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter.end();
    }
    return;
  }
}

class StreamRepoSearchEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/repo-search\/stream$/u, ''));
    const sessionPath = getChatSessionPath(runtimeRoot, sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: ReturnType<typeof parseJsonBody>;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const repoRequest = parseChatRepoRequest(parsedBody);
    if (!repoRequest) {
      sendJson(res, 400, { error: 'Expected content.' });
      return;
    }
    const resolvedRepoRoot = resolveChatRepoRoot(repoRequest, session);
    if (!existsSync(resolvedRepoRoot) || !statSync(resolvedRepoRoot).isDirectory()) {
      sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
      return;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_repo_search_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const sseWriter = new SseResponseWriter(req, res);
    sseWriter.open();
    try {
      const content = repoRequest.content;
      const reader = new JsonRecordReader(parsedBody);
      const config = readConfig(configPath);
      const engineRequestId = randomUUID();
      const result = await new ChatRepoOperationRunner().runRepoSearch(buildChatRepoOperationRequest({
        ctx,
        runtimeRoot,
        session: activeSession,
        config,
        content,
        repoRoot: resolvedRepoRoot,
        reader,
        parsedBody,
        requestId: engineRequestId,
        progressWriter: new ChatStreamProgressWriter(
          sseWriter,
          null,
          'rs',
          engineRequestId,
          'answer',
          false,
        ),
      }));
      sseWriter.writeEvent('done', {
        ...buildChatSessionResponse(config, result.updatedSession),
        repoSearch: result.repoSearch,
      });
    } catch (error) {
      sseWriter.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter.end();
    }
    return;
  }
}

class CondenseChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const pathname = routeMatch.pathname;
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, '').replace(/\/condense$/u, ''));
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    const updatedSession = condenseChatSession(runtimeRoot, session);
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), updatedSession));
    return;
  }
}
const CHAT_ROUTES = new RouteTable([
  { method: 'GET', path: '/dashboard/chat/sessions', endpoint: new ListChatSessionsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new GetChatSessionEndpoint() },
  { method: 'PUT', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new UpdateChatSessionEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new DeleteChatSessionEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/u, endpoint: new DeleteChatMessageEndpoint() },
  { method: 'POST', path: '/dashboard/chat/sessions', endpoint: new CreateChatSessionEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages$/u, endpoint: new CreateChatMessageEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/stream$/u, endpoint: new StreamChatMessageEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan$/u, endpoint: new CreateChatPlanEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan\/stream$/u, endpoint: new StreamChatPlanEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-search\/stream$/u, endpoint: new StreamRepoSearchEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/condense$/u, endpoint: new CondenseChatSessionEndpoint() },
]);

export async function handleChatRoute(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  return await CHAT_ROUTES.handle(ctx, req, res, pathname);
}
