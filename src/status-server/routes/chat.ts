/**
 * Dashboard chat session routes: CRUD, message generation, streaming,
 * plan/repo-search execution, condensation, and tool-context management.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PersistedChatMessageSchema,
  ChatStreamTextDeltaSchema,
  StopChatOperationRequestSchema,
  type PersistedChatMessage as WireChatMessage,
  type ChatSession as WireChatSession,
  type ChatSessionResponse,
  type ChatSessionsResponse,
  type ImageMetadata,
} from '@siftkit/contracts';
import type { ChatMessage as PersistedChatMessage } from '../../state/chat-sessions.js';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { OptionalJsonValue } from '../../lib/json-types.js';
import { MockPlannerResponsesSchema, type MockPlannerResponse } from '../../planner-protocol/mock-response.js';
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
  getConfiguredReasoning,
  notifyStatusBackend,
  type SiftConfig,
} from '../../config/index.js';
import { admitImagesForPreset } from '../../llm-protocol/preset-image-admission.js';
import {
  type RepoSearchProgressEvent,
  buildRepoSearchProgressLogBody,
  isServerLoggedProgressEvent,
  removeDashboardRunCommandFromLogs,
} from '../dashboard-runs.js';
import {
  buildContextUsage,
  resolveChatSessionModel,
  resolveChatSessionContextWindow,
  resolveChatSessionConfig,
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
import { ChatMemorySeam } from '../chat-memory-seam.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import {
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
  deleteChatMessageImage,
  ChatMessageImageNotFoundError,
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
import {
  ChatTurnTelemetry,
  getLocalTokenConfig,
  getMockTokenConfig,
} from '../chat-turn-telemetry.js';
import { createServerJsonLogger, serverLogger } from '../server-logger.js';
import { LIVE_TEXT_FLUSH_MAX_LATENCY_MS, LiveTextDeltaTracker } from '../live-text-delta.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
  ensureActivePresetReadyForModelRequest,
} from '../server-ops.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';
import { ProgressWriter } from '../../lib/progress-writer.js';
import {
  ChatSessionOperationEndpoint,
  parseChatMessageOperationRequest,
  parseChatRepoOperationRequest,
  type ChatSessionOperationRequest,
  type ResolvedChatRepoRequest,
} from './chat-session-operation-endpoint.js';
import { ChatImageCaptionEndpoint } from './chat-image-caption.js';
import {
  ChatRepoAgentDecideEndpoint,
  GetChatRepoAgentActiveEndpoint,
  StreamChatRepoAgentEndpoint,
} from './chat-repo-agent.js';
import type { ChatMessageRequest } from '../chat-route-request-normalizers.js';
import type { JsonObject } from '../../lib/json-types.js';

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
      toolCallId: event.toolCallId,
      turn: event.turn,
      maxTurns: event.maxTurns,
      activityKind: event.activityKind,
      activitySubject: event.activitySubject,
      command: event.command,
      promptTokenCount: event.promptTokenCount,
    });
    return;
  }
  if (event.kind === 'tool_result') {
    writer.writeEvent('tool_result', {
      toolCallId: event.toolCallId,
      turn: event.turn,
      maxTurns: event.maxTurns,
      activityKind: event.activityKind,
      activitySubject: event.activitySubject,
      command: event.command,
      exitCode: event.exitCode,
      outputSnippet: event.outputSnippet,
      outputTokens: event.outputTokens,
      outputTokensEstimated: event.outputTokensEstimated,
      promptTokenCount: event.promptTokenCount,
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
  const sourceRunId = message.sourceRunId ?? null;
  if (message.kind === 'assistant_tool_call') {
    return PersistedChatMessageSchema.parse({ ...message, sourceRunId, toolCallStatus: 'done' });
  }
  return PersistedChatMessageSchema.parse({ ...message, sourceRunId });
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
    createdAtUtc: session.createdAtUtc ?? '',
    updatedAtUtc: session.updatedAtUtc ?? '',
    messages: (session.messages ?? []).map(toWireChatMessage),
    promptContext: session.promptContext,
  };
}

export function buildChatSessionResponse(config: SiftConfig, session: ChatSession): ChatSessionResponse {
  return {
    session: toWireChatSession(config, withPromptContext(config, session)),
    contextUsage: buildContextUsage(config, session),
  };
}

function hasEstimatedScorecardTokens(scorecard: OptionalJsonValue, key: keyof RepoSearchTotals): boolean {
  const count = getScorecardTotal(scorecard, key);
  return count !== null && count > 0;
}

function admitSelectedChatImages(
  config: SiftConfig,
  session: ChatSession,
  requestedImages: string[],
): { effectiveConfig: SiftConfig; images: string[]; imageMeta: ImageMetadata[] } {
  const effectiveConfig = resolveChatSessionConfig(config, session);
  const activePreset = getActiveModelPreset(effectiveConfig);
  const admitted = admitImagesForPreset(activePreset, requestedImages);
  return {
    effectiveConfig,
    images: admitted.map((image) => image.dataUrl),
    imageMeta: admitted.map((image) => image.metadata),
  };
}

export function formatChatEngineError(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

function readRouteStringArray(reader: JsonRecordReader, key: string): string[] | undefined {
  const value = reader.value(key);
  return Array.isArray(value) ? value.map((entry) => String(entry)) : undefined;
}

function readRouteMockResponses(reader: JsonRecordReader, key: string): MockPlannerResponse[] | undefined {
  const value = reader.value(key);
  return Array.isArray(value) ? MockPlannerResponsesSchema.parse(value) : undefined;
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
  images: string[];
  repoRoot: string;
  reader: JsonRecordReader;
  parsedBody: ReturnType<typeof parseJsonBody>;
  requestId: string;
  progressWriter: ProgressWriter<RepoSearchProgressEvent>;
  abortSignal?: AbortSignal;
}): ChatRepoOperationRequest {
  return {
    runtimeRoot: options.runtimeRoot,
    session: options.session,
    config: options.config,
    content: options.content,
    images: options.images,
    repoRoot: options.repoRoot,
    statusBackendUrl: `${options.ctx.getServiceBaseUrl()}/status`,
    engineService: options.ctx.engineService,
    progressWriter: options.progressWriter,
    requestId: options.requestId,
    maxTurns: readRouteNumber(options.reader, 'maxTurns'),
    logFile: options.reader.optionalString('logFile'),
    availableModels: readRouteStringArray(options.reader, 'availableModels'),
    mockResponses: readRouteMockResponses(options.reader, 'mockResponses'),
    mockCommandResults: normalizeRepoSearchMockCommandResults(options.parsedBody.mockCommandResults),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };
}

type SessionSpeculativeMetrics = {
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
};

export class ChatStreamProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  constructor(
    private readonly writer: SseResponseWriter,
    private readonly phaseTracker: ChatTurnPhaseTracker | null,
    private readonly scope: 'plan' | 'rs',
    private readonly requestId: string,
    private readonly streamAnswer: boolean,
  ) {
    super();
  }

  get enabled(): boolean {
    return true;
  }

  private readonly thinkingDeltas = new LiveTextDeltaTracker();
  private readonly narrationDeltas = new LiveTextDeltaTracker();
  private readonly answerDeltas = new LiveTextDeltaTracker();
  private latestAnswerText = '';
  private flushTimer: NodeJS.Timeout | null = null;

  write(event: RepoSearchProgressEvent): void {
    if (event.kind === 'answer') {
      this.latestAnswerText = event.answerText;
    }
    if (event.kind === 'thinking') {
      this.phaseTracker?.observeThinking(event.thinkingText);
      this.thinkingDeltas.pushSnapshot(event.turn, event.thinkingText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'narration') {
      this.narrationDeltas.pushSnapshot(event.turn, event.narrationText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'answer' && this.streamAnswer) {
      this.phaseTracker?.observeAnswer(event.answerText);
      this.answerDeltas.pushSnapshot(event.turn, event.answerText, Date.now());
      this.emitDueDeltas(false);
      return;
    }
    if (event.kind === 'context_warning') {
      this.flushPending();
      this.writer.writeEvent('warning', { warning: event.warningText });
      return;
    }
    if (event.kind === 'progress_update') {
      this.flushPending();
      this.writer.writeEvent('progress', {
        turn: event.turn,
        text: event.progressText,
        elapsedMs: event.elapsedMs,
      });
      return;
    }
    this.flushPending();
    forwardRepoSearchToolEvent(this.writer, event, this.scope, this.requestId);
  }

  flushPending(): void {
    this.emitDueDeltas(true);
  }

  getAnswerText(): string {
    return this.latestAnswerText;
  }

  private emitDueDeltas(force: boolean): void {
    const now = Date.now();
    this.emitTrackerDeltas(this.thinkingDeltas, 'thinking', now, force);
    this.emitTrackerDeltas(this.narrationDeltas, 'narration', now, force);
    this.emitTrackerDeltas(this.answerDeltas, 'answer', now, force);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.thinkingDeltas.hasPending() || this.narrationDeltas.hasPending() || this.answerDeltas.hasPending()) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.emitDueDeltas(true);
      }, LIVE_TEXT_FLUSH_MAX_LATENCY_MS);
    }
  }

  private emitTrackerDeltas(
    tracker: LiveTextDeltaTracker,
    event: 'thinking' | 'narration' | 'answer',
    now: number,
    force: boolean,
  ): void {
    for (
      let delta = tracker.takeDue(now, force);
      delta !== null;
      delta = tracker.takeDue(now, force)
    ) {
      this.writer.writeEvent(event, ChatStreamTextDeltaSchema.parse(delta));
    }
  }
}

const STOPPED_BY_USER_MARKER = '*Stopped by user.*';

function registerChatAbort<T>(
  ctx: ServerContext,
  request: ChatSessionOperationRequest<T>,
  controller: AbortController,
): void {
  if (!request.lease || !ctx.chatSessionOperations.registerAbort(request.lease, () => controller.abort())) {
    throw new Error(`Failed to register abort for chat session ${request.sessionId}.`);
  }
}

function appendStoppedChatTurn(
  runtimeRoot: string,
  session: ChatSession,
  content: string,
  images: string[],
  partialAnswer: string,
): ChatSession {
  const partial = partialAnswer.trimEnd();
  return appendChatMessagesWithUsage(
    runtimeRoot,
    session,
    content,
    partial ? `${partial}\n\n${STOPPED_BY_USER_MARKER}` : STOPPED_BY_USER_MARKER,
    {},
    { turns: [], images },
  );
}

function finishStoppedChatStream(options: {
  signal: AbortSignal;
  runtimeRoot: string;
  session: ChatSession;
  content: string;
  images: string[];
  partialAnswer: string;
  configPath: string;
  writer: SseResponseWriter;
}): boolean {
  if (!options.signal.aborted) {
    return false;
  }
  const updatedSession = appendStoppedChatTurn(
    options.runtimeRoot,
    options.session,
    options.content,
    options.images,
    options.partialAnswer,
  );
  options.writer.writeEvent('done', buildChatSessionResponse(readConfig(options.configPath), updatedSession));
  return true;
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

  override get wantsLiveText(): boolean {
    return false;
  }

  write(event: RepoSearchProgressEvent): void {
    if (!isServerLoggedProgressEvent(event)) return;
    const body = buildRepoSearchProgressLogBody(event);
    if (body) {
      serverLogger.emitBody(this.scope, this.requestId, body);
    }
  }
}

function readScorecardSpeculativeMetrics(scorecard: OptionalJsonValue): SessionSpeculativeMetrics {
  return {
    speculativeAcceptedTokens: getScorecardTotal(scorecard, 'speculativeAcceptedTokens'),
    speculativeGeneratedTokens: getScorecardTotal(scorecard, 'speculativeGeneratedTokens'),
  };
}

/** One speculative-token policy for every chat route: the turn's own usage/scorecard totals. */
function resolveSessionSpeculativeMetrics(usage: Partial<SessionSpeculativeMetrics>): SessionSpeculativeMetrics {
  return {
    speculativeAcceptedTokens: usage.speculativeAcceptedTokens ?? null,
    speculativeGeneratedTokens: usage.speculativeGeneratedTokens ?? null,
  };
}

class ListChatSessionsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
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

class DeleteChatMessageImageEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const match = /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/([0-9]+)$/u
      .exec(routeMatch.pathname);
    const sessionId = decodeURIComponent(match?.[1] || '');
    const messageId = decodeURIComponent(match?.[2] || '');
    const imageIndex = Number(match?.[3]);
    try {
      deleteChatMessageImage(runtimeRoot, sessionId, messageId, imageIndex);
    } catch (error) {
      if (error instanceof ChatMessageImageNotFoundError) {
        sendJson(res, 404, { error: 'Image not found.' });
        return;
      }
      throw error;
    }
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    sendJson(res, 200, buildChatSessionResponse(readConfig(configPath), session));
  }
}

class CreateChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
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
  compactionSummary: string;
};

function ingestAssistantMemoryTurn(
  memory: ChatMemorySeam,
  preset: SiftPreset,
  sessionId: string,
  capturedAtUtc: string,
  messages: readonly PersistedChatMessage[],
): void {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const lastAssistant = [...messages].reverse().find(
    (message) => message.role === 'assistant'
      && (message.kind ?? 'assistant_answer') === 'assistant_answer',
  );
  if (lastUser === undefined || lastAssistant === undefined) {
    return;
  }
  memory.ingestTurn(preset, {
    sessionId,
    capturedAtUtc,
    userMessageId: lastUser.id,
    userText: lastUser.content,
    assistantMessageId: lastAssistant.id,
    assistantText: lastAssistant.content,
  });
}

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
  private readonly memory: ChatMemorySeam;

  constructor(
    private readonly ctx: ServerContext,
    private readonly res: ServerResponse,
    private readonly runtimeRoot: string,
    private readonly session: ChatSession,
    private readonly config: SiftConfig,
    private readonly preset: SiftPreset,
    private readonly userContent: string,
    private readonly userImages: string[],
    private readonly userImageMeta: ImageMetadata[],
    private readonly mockResponses: MockPlannerResponse[] | undefined,
  ) {
    this.memory = new ChatMemorySeam(ctx.assistant);
  }

  async runEngineTurn(): Promise<void> {
    const telemetry = new ChatTurnTelemetry(
      this.config,
      getMockTokenConfig(this.config, this.mockResponses),
    );
    try {
      const memoryContext = await this.memory.buildMemoryContext(this.preset, this.userContent);
      const result = await this.ctx.engineService.executeRepoSearch({
        presetId: this.preset.id,
        taskKind: 'chat',
        prompt: this.userContent,
        repoRoot: process.cwd(),
        statusBackendUrl: `${this.ctx.getServiceBaseUrl()}/status`,
        config: resolveChatSessionConfig(this.config, this.session),
        systemPrompt: buildChatSystemContent(
          this.config,
          this.session,
          memoryContext.length === 0 ? {} : { memoryContext },
        ),
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
        compactionSummary: scorecardTasks[0]?.compactionSummary ?? '',
      });
    } catch (error) {
      this.sendFailure(formatChatEngineError(error instanceof Error ? error : String(error)));
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
          compactionSummary: '',
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
    const speculativeMetrics = resolveSessionSpeculativeMetrics(turn.usage);
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
        compactionSummary: turn.compactionSummary,
        images: this.userImages,
        imageMeta: this.userImageMeta,
      },
    );
    ingestAssistantMemoryTurn(
      this.memory,
      this.preset,
      this.session.id,
      this.requestStartedAtUtc,
      sessionWithTelemetry.messages ?? [],
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

class CreateChatMessageEndpoint extends ChatSessionOperationEndpoint<ChatMessageRequest> {
  protected readonly operationKind = 'message' as const;

  protected parseRequest(
    res: ServerResponse,
    _session: ChatSession,
    parsedBody: JsonObject,
  ): ChatMessageRequest | null {
    return parseChatMessageOperationRequest(res, parsedBody);
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ChatMessageRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const messageRequest = request.value;
    const providedAssistantContent = messageRequest.assistantContent || '';
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
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
        selected = new ChatOperationPresetSelector(config.Presets).select(activeSession, 'chat');
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const selectedImages = admitSelectedChatImages(config, selected.session, messageRequest.images);
      const turn = new ChatMessageTurn(
        ctx,
        res,
        runtimeRoot,
        selected.session,
        selectedImages.effectiveConfig,
        selected.preset,
        messageRequest.content,
        selectedImages.images,
        selectedImages.imageMeta,
        readRouteMockResponses(new JsonRecordReader(request.parsedBody), 'mockResponses'),
      );
      if (providedAssistantContent) {
        await turn.runProvidedAssistantTurn(providedAssistantContent);
      } else {
        await turn.runEngineTurn();
      }
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}

class StreamChatMessageEndpoint extends ChatSessionOperationEndpoint<ChatMessageRequest> {
  protected readonly operationKind = 'message' as const;
  protected readonly clientOwnedOperation = true;

  protected parseRequest(
    res: ServerResponse,
    _session: ChatSession,
    parsedBody: JsonObject,
  ): ChatMessageRequest | null {
    return parseChatMessageOperationRequest(res, parsedBody);
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ChatMessageRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const messageRequest = request.value;
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
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
    const engineRequestId = randomUUID();
    const progressWriter = new ChatStreamProgressWriter(sseWriter, phaseTracker, 'plan', engineRequestId, true);
    let selectedImagesForError: { images: string[] } | null = null;
    // Status reporting for this turn belongs to executeRepoSearchRequest; there is no
    // non-engine branch here to report for.
    try {
      const config = readConfig(configPath);
      const selected = new ChatOperationPresetSelector(config.Presets).select(activeSession, 'chat');
      const selectedImages = admitSelectedChatImages(config, selected.session, messageRequest.images);
      selectedImagesForError = { images: selectedImages.images };
      const selectedSession = selected.session;
      const memory = new ChatMemorySeam(ctx.assistant);
      const memoryContext = await memory.buildMemoryContext(selected.preset, userContent);
      const reader = new JsonRecordReader(request.parsedBody);
      const webOverrideRaw = reader.optionalString('webSearchOverride');
      const webEnabled = webOverrideRaw === 'on'
        ? true
        : webOverrideRaw === 'off'
          ? false
          : selectedSession.webSearchEnabled === true;
      const mockResponses = readRouteMockResponses(reader, 'mockResponses');
      const mockTokenConfig = getMockTokenConfig(selectedImages.effectiveConfig, mockResponses);
      const telemetry = new ChatTurnTelemetry(selectedImages.effectiveConfig, mockTokenConfig);
      const result = await ctx.engineService.executeRepoSearch({
        presetId: selected.preset.id,
        requestId: engineRequestId,
        taskKind: 'chat',
        prompt: userContent,
        repoRoot: process.cwd(),
        statusBackendUrl: `${ctx.getServiceBaseUrl()}/status`,
        config: selectedImages.effectiveConfig,
        systemPrompt: buildChatSystemContent(
          selectedImages.effectiveConfig,
          selectedSession,
          memoryContext.length === 0 ? {} : { memoryContext },
        ),
        history: buildChatHistoryMessages(selectedImages.effectiveConfig, selectedSession),
        thinkingEnabled: selectedSession.thinkingEnabled !== false,
        // Chat's tool surface is always web-only; whether the web tools are actually
        // offered is decided once, by the web tool policy reading `webToolsEnabled`.
        allowedTools: ['web_search', 'web_fetch'],
        webToolsEnabled: webEnabled,
        retainedWebToolCalls: webEnabled ? buildRetainedWebToolCalls(selectedSession) : [],
        maxTurns: readRouteNumber(reader, 'maxTurns'),
        availableModels: readRouteStringArray(reader, 'availableModels'),
        mockCommandResults: normalizeRepoSearchMockCommandResults(request.parsedBody.mockCommandResults),
        initialUserImages: selectedImages.images,
        ...(mockResponses ? { mockResponses } : {}),
        progressWriter,
        abortSignal: abortController.signal,
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
      const speculativeMetrics = resolveSessionSpeculativeMetrics(scorecardSpeculative);
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
        compactionSummary: scorecardTasks[0]?.compactionSummary ?? '',
        images: selectedImages.images,
        imageMeta: selectedImages.imageMeta,
      });
      ingestAssistantMemoryTurn(
        memory,
        selected.preset,
        selectedSession.id,
        requestStartedAtUtc,
        updatedSession.messages ?? [],
      );
      progressWriter.flushPending();
      sseWriter.writeEvent('done', buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      progressWriter.flushPending();
      if (!finishStoppedChatStream({
        signal: abortController.signal,
        runtimeRoot,
        session: activeSession,
        content: userContent,
        images: selectedImagesForError?.images ?? messageRequest.images,
        partialAnswer: progressWriter.getAnswerText(),
        configPath,
        writer: sseWriter,
      })) {
        sseWriter.writeEvent('error', {
          error: formatChatEngineError(error instanceof Error ? error : String(error)),
        });
      }
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter.end();
    }
  }
}

class CreateChatPlanEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'plan' as const;

  protected parseRequest(
    res: ServerResponse,
    session: ChatSession,
    parsedBody: JsonObject,
  ): ResolvedChatRepoRequest | null {
    return parseChatRepoOperationRequest(res, session, parsedBody);
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
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
      const content = request.value.content;
      const reader = new JsonRecordReader(request.parsedBody);
      const config = readConfig(configPath);
      const engineRequestId = randomUUID();
      const result = await new ChatRepoOperationRunner().runPlan(buildChatRepoOperationRequest({
        ctx,
        runtimeRoot,
        session: activeSession,
        config,
        content,
        images: request.value.images,
        repoRoot: request.value.repoRoot,
        reader,
        parsedBody: request.parsedBody,
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
  }
}

class StreamChatPlanEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'plan' as const;
  protected readonly clientOwnedOperation = true;

  protected parseRequest(
    res: ServerResponse,
    session: ChatSession,
    parsedBody: JsonObject,
  ): ResolvedChatRepoRequest | null {
    return parseChatRepoOperationRequest(res, session, parsedBody);
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_plan_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
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
    const engineRequestId = randomUUID();
    const progressWriter = new ChatStreamProgressWriter(sseWriter, null, 'plan', engineRequestId, false);
    try {
      const content = request.value.content;
      const reader = new JsonRecordReader(request.parsedBody);
      const config = readConfig(configPath);
      const result = await new ChatRepoOperationRunner().runPlan(buildChatRepoOperationRequest({
        ctx,
        runtimeRoot,
        session: activeSession,
        config,
        content,
        images: request.value.images,
        repoRoot: request.value.repoRoot,
        reader,
        parsedBody: request.parsedBody,
        requestId: engineRequestId,
        progressWriter,
        abortSignal: abortController.signal,
      }));
      progressWriter.flushPending();
      sseWriter.writeEvent('done', {
        ...buildChatSessionResponse(config, result.updatedSession),
        repoSearch: result.repoSearch,
      });
    } catch (error) {
      progressWriter.flushPending();
      if (!finishStoppedChatStream({
        signal: abortController.signal,
        runtimeRoot,
        session: activeSession,
        content: request.value.content,
        images: request.value.images,
        partialAnswer: progressWriter.getAnswerText(),
        configPath,
        writer: sseWriter,
      })) {
        sseWriter.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter.end();
    }
  }
}

class CreateRepoSearchEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'repo-search' as const;

  protected parseRequest(
    res: ServerResponse,
    session: ChatSession,
    parsedBody: JsonObject,
  ): ResolvedChatRepoRequest | null {
    return parseChatRepoOperationRequest(res, session, parsedBody);
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_repo_search', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
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
      const content = request.value.content;
      const reader = new JsonRecordReader(request.parsedBody);
      const config = readConfig(configPath);
      const engineRequestId = randomUUID();
      const result = await new ChatRepoOperationRunner().runRepoSearch(buildChatRepoOperationRequest({
        ctx,
        runtimeRoot,
        session: activeSession,
        config,
        content,
        images: request.value.images,
        repoRoot: request.value.repoRoot,
        reader,
        parsedBody: request.parsedBody,
        requestId: engineRequestId,
        progressWriter: new RepoSearchToolLogProgressWriter('rs', engineRequestId),
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
  }
}

class StreamRepoSearchEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'repo-search' as const;
  protected readonly clientOwnedOperation = true;

  protected parseRequest(
    res: ServerResponse,
    session: ChatSession,
    parsedBody: JsonObject,
  ): ResolvedChatRepoRequest | null {
    return parseChatRepoOperationRequest(res, session, parsedBody);
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_repo_search_stream', req, res);
    if (!modelRequestLock) {
      return;
    }
    const activeSession = readChatSessionFromPath(request.sessionPath);
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
    const engineRequestId = randomUUID();
    const progressWriter = new ChatStreamProgressWriter(sseWriter, null, 'rs', engineRequestId, false);
    try {
      const content = request.value.content;
      const reader = new JsonRecordReader(request.parsedBody);
      const config = readConfig(configPath);
      const result = await new ChatRepoOperationRunner().runRepoSearch(buildChatRepoOperationRequest({
        ctx,
        runtimeRoot,
        session: activeSession,
        config,
        content,
        images: request.value.images,
        repoRoot: request.value.repoRoot,
        reader,
        parsedBody: request.parsedBody,
        requestId: engineRequestId,
        progressWriter,
        abortSignal: abortController.signal,
      }));
      progressWriter.flushPending();
      sseWriter.writeEvent('done', {
        ...buildChatSessionResponse(config, result.updatedSession),
        repoSearch: result.repoSearch,
      });
    } catch (error) {
      progressWriter.flushPending();
      if (!finishStoppedChatStream({
        signal: abortController.signal,
        runtimeRoot,
        session: activeSession,
        content: request.value.content,
        images: request.value.images,
        partialAnswer: progressWriter.getAnswerText(),
        configPath,
        writer: sseWriter,
      })) {
        sseWriter.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter.end();
    }
  }
}

class CondenseChatSessionEndpoint extends ChatSessionOperationEndpoint<'condense'> {
  protected readonly operationKind = 'condense' as const;

  protected parseRequest(): 'condense' {
    return 'condense';
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<'condense'>,
  ): Promise<void> {
    // Condense now issues a real model request, so it takes the same lock and
    // readiness gate as any other turn.
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_condense', req, res);
    if (!modelRequestLock) {
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const config = readConfig(ctx.configPath);
      const updatedSession = await condenseChatSession(
        getRuntimeRoot(),
        config,
        request.session,
        readRouteMockResponses(new JsonRecordReader(request.parsedBody), 'mockResponses'),
        createServerJsonLogger(serverLogger, 'condense', request.session.id),
      );
      sendJson(res, 200, buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}

export class GetChatOperationEndpoint implements RouteEndpoint {
  handle(
    ctx: ServerContext,
    _req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): void {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const active = ctx.chatSessionOperations.getActive(sessionId);
    if (!active) {
      sendJson(res, 404, { error: 'No active operation for this session.' });
      return;
    }
    sendJson(res, 200, {
      operationKind: active.operationKind,
      startedAtUtc: new Date(active.startedAtMs).toISOString(),
    });
  }
}

export class StopChatOperationEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = StopChatOperationRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'operationId must be a UUID.' });
      return;
    }
    const active = ctx.chatSessionOperations.getActive(sessionId);
    if (!active?.abort || active.operationId !== parsed.data.operationId) {
      sendJson(res, 409, { error: 'No matching stoppable operation is active for this session.' });
      return;
    }
    active.abort();
    sendJson(res, 200, { ok: true, operationKind: active.operationKind });
  }
}
const CHAT_ROUTES = new RouteTable([
  { method: 'GET', path: '/dashboard/chat/sessions', endpoint: new ListChatSessionsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new GetChatSessionEndpoint() },
  { method: 'PUT', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new UpdateChatSessionEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)$/u, endpoint: new DeleteChatSessionEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/([0-9]+)$/u, endpoint: new DeleteChatMessageImageEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/u, endpoint: new DeleteChatMessageEndpoint() },
  { method: 'POST', path: '/dashboard/chat/sessions', endpoint: new CreateChatSessionEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages$/u, endpoint: new CreateChatMessageEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/images\/caption$/u, endpoint: new ChatImageCaptionEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/stream$/u, endpoint: new StreamChatMessageEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan$/u, endpoint: new CreateChatPlanEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan\/stream$/u, endpoint: new StreamChatPlanEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-search$/u, endpoint: new CreateRepoSearchEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-search\/stream$/u, endpoint: new StreamRepoSearchEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/stream$/u, endpoint: new StreamChatRepoAgentEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/decide$/u, endpoint: new ChatRepoAgentDecideEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/active$/u, endpoint: new GetChatRepoAgentActiveEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/operation$/u, endpoint: new GetChatOperationEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/stop$/u, endpoint: new StopChatOperationEndpoint() },
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
