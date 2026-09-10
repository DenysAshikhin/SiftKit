import { ChatMessageQueueEndpoint, ChatMessageQueueForceEndpoint, ChatMessageQueueStreamEndpoint } from './chat-message-queue.js';
import { getChatRunFailure } from '../chat.js';
/**
 * Dashboard chat session routes: CRUD, message generation, streaming,
 * plan/repo-search execution, condensation, and tool-context management.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PersistedChatTranscriptMessageSchema,
  StopChatOperationRequestSchema,
  type PersistedChatTranscriptMessage as WireChatMessage,
  type ChatSession as WireChatSession,
  type ChatSessionResponse,
  type ChatSessionsResponse,
  type ImageMetadata,
} from '@siftkit/contracts';
import type { ChatMessage as PersistedChatTranscriptMessage } from '../../state/chat-sessions.js';
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
  applyHostEngineRuntimeSettings,
  getActiveModelPreset,
  getConfiguredReasoning,
  notifyStatusBackend,
  type SiftConfig,
} from '../../config/index.js';
import { admitImagesForPreset } from '../../llm-protocol/preset-image-admission.js';
import {
  CompositeRepoSearchProgressWriter,
  RepoSearchToolLogProgressWriter,
} from '../operation-progress-writers.js';
import {
  type RepoSearchProgressEvent,
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
  appendChatStoppedTurn,
  buildChatSystemContent,
  buildChatHistoryMessages,
  condenseChatSession,
  getScorecardTotal,
  buildPersistTurnsFromRepoSearchResult,
  buildRetainedWebToolCalls,
} from '../chat.js';
import type { TurnTokenRecord } from '../../repo-search/engine/turn-token-record.js';
import { buildChatPromptContext } from '../chat-prompt-context.js';
import { ChatMemorySeam } from '../chat-memory-seam.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { ChatOperationBroadcast } from '../chat-operation-broadcast.js';
import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
import {
  parseChatSessionCreateRequest,
  parseChatSessionUpdateRequest,
} from '../chat-route-request-normalizers.js';
import { normalizeRepoSearchScorecard } from '../repo-search-scorecard-types.js';
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
import type { ChatFrameWriter } from '../chat-stream-frames.js';
import { buildChatRunSettings } from '../chat-run-recorder.js';
import {
  ChatStreamProgressWriter,
  STOPPED_BY_USER_MARKER,
} from '../chat-stream-progress-writer.js';
import {
  acquireModelRequestWithWait,
  releaseModelRequest,
  ensureActivePresetReadyForModelRequest,
} from '../server-ops.js';
import { RouteTable, type RouteEndpoint, type RouteMatch } from '../route-table.js';
import type { ModelRequestLock, ServerContext } from '../server-types.js';
import { ProgressWriter } from '../../lib/progress-writer.js';
import {
  ChatSessionOperationEndpoint,
  parseChatMessageOperationRequest,
  parseChatRepoOperationRequest,
  type ChatSessionOperationRequest,
  type ResolvedChatRepoRequest,
} from './chat-session-operation-endpoint.js';
import type { ChatRunSubmission } from './chat-session-operation-endpoint.js';
import { ChatImageCaptionEndpoint } from './chat-image-caption.js';
import {
  GetActiveChatOperationsEndpoint,
  GetChatOperationStreamEndpoint,
} from './chat-operation-attach.js';
import {
  ChatRepoAgentApprovalModeEndpoint,
  ChatRepoAgentDecideEndpoint,
  GetChatRepoAgentActiveEndpoint,
  StreamChatRepoAgentEndpoint,
} from './chat-repo-agent.js';
import type { ChatMessageRequest } from '../chat-route-request-normalizers.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { ChatMessageQueueDelivery } from '../../repo-search/engine/queue-delivery.js';
import { ChatMessageQueueStore } from '../../state/chat-message-queue.js';

async function readEffectiveChatRouteConfig(configPath: string): Promise<SiftConfig> {
  const localConfig = readConfig(configPath);
  return await applyHostEngineRuntimeSettings(localConfig);
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


function withPromptContext(config: SiftConfig, session: ChatSession): ChatSession {
  return {
    ...session,
    promptContext: buildChatPromptContext(config, session),
  };
}

function toWireChatMessage(message: PersistedChatTranscriptMessage): WireChatMessage {
  const sourceRunId = message.sourceRunId ?? null;
  return PersistedChatTranscriptMessageSchema.parse({ ...message, sourceRunId });
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

export function admitSelectedChatImages(
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
  queueDelivery?: ChatMessageQueueDelivery;
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
    ...(options.queueDelivery ? { queueDelivery: options.queueDelivery } : {}),
  };
}

type SessionSpeculativeMetrics = {
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
};

/**
 * Presentation only: it builds the live transcript and the client's frames. Server logging belongs
 * to whoever owns the operation — the repo-agent session, or the composed log writer at a
 * standalone route's boundary — so attaching a second reader can never double a console line.
 */

function registerChatAbort<T>(
  ctx: ServerContext,
  request: ChatSessionOperationRequest<T>,
  controller: AbortController,
): void {
  if (!request.lease || !ctx.chatSessionOperations.registerAbort(request.lease, () => controller.abort())) {
    throw new Error(`Failed to register abort for chat session ${request.sessionId}.`);
  }
}

const CHAT_STREAM_NOT_ADMITTED_ERROR = 'The turn was not admitted before the model queue wait ended.';

export function requireChatOperationBroadcast<T>(
  ctx: ServerContext,
  request: ChatSessionOperationRequest<T>,
): ChatOperationBroadcast {
  const broadcast = request.lease ? ctx.chatSessionOperations.getBroadcast(request.lease.sessionId) : null;
  if (!broadcast) {
    throw new Error(`Chat session ${request.sessionId} has no active operation broadcast.`);
  }
  return broadcast;
}

/** Everything a streaming chat endpoint needs before it can run its body. */
type OpenedChatOperationStream = {
  stream: ChatOperationBroadcast;
  sseWriter: SseResponseWriter | null;
  modelRequestLock: ModelRequestLock;
  activeSession: ChatSession;
};

/**
 * The shared head of every streaming chat endpoint: buffer the prompt, take the model lock without
 * letting a closed socket cancel a queued turn, reload the session, warm the preset, and open the
 * SSE response. Every early exit reports on both channels, because a reader attached to the
 * broadcast never sees the HTTP status and the caller never sees the frames.
 */
async function openChatOperationStream<TParsed extends { content: string; images: string[] }>(
  ctx: ServerContext,
  req: IncomingMessage | null,
  res: ServerResponse | null,
  request: ChatSessionOperationRequest<TParsed>,
  lockKind: string,
): Promise<OpenedChatOperationStream | null> {
  const stream = requireChatOperationBroadcast(ctx, request);
  // Buffered before the queue wait, so a client that attaches while this turn is still queued
  // already sees the prompt that started it.
  if (!request.queuedMessages) stream.writeEvent('submitted', { content: request.value.content, images: request.value.images });
  const fail = (status: number, error: string): null => {
    stream.writeEvent('error', { error });
    if (res) sendJson(res, status, { error });
    return null;
  };
  // The stream outlives its client: a reload reattaches through /operation/stream, so a closed
  // socket must not cancel a turn that is only waiting for the model lock.
  const modelRequestLock = await acquireModelRequestWithWait(ctx, lockKind, undefined, undefined);
  if (!modelRequestLock) {
    return fail(503, CHAT_STREAM_NOT_ADMITTED_ERROR);
  }
  const activeSession = readChatSessionFromPath(request.sessionPath);
  if (!activeSession) {
    releaseModelRequest(ctx, modelRequestLock.token);
    return fail(404, 'Session not found.');
  }
  try {
    await ensureActivePresetReadyForModelRequest(ctx);
  } catch (error) {
    releaseModelRequest(ctx, modelRequestLock.token);
    return fail(503, error instanceof Error ? error.message : String(error));
  }
  const sseWriter = req && res ? new SseResponseWriter(req, res) : null;
  if (sseWriter) {
    sseWriter.open();
    stream.attach(new ChatOperationSseSubscriber(sseWriter));
  }
  return { stream, sseWriter, modelRequestLock, activeSession };
}

function finishStoppedChatStream(options: {
  signal: AbortSignal;
  failureDetail: string;
  runtimeRoot: string;
  session: ChatSession;
  content: string;
  images: string[];
  imageMeta: ImageMetadata[];
  stoppedMessages: PersistedChatTranscriptMessage[];
  /** The engine request the turn ran as; the shared writer hydrates completed tools from it. */
  requestId: string;
  configPath: string;
  writer: ChatFrameWriter;
}): boolean {
  const deliveries = new ChatMessageQueueStore(getRuntimeDatabase(join(options.runtimeRoot, 'runtime.sqlite')))
    .listDelivered(options.session.id, options.requestId);
  if (!options.signal.aborted && deliveries.length === 0) {
    return false;
  }
  const updatedSession = appendChatStoppedTurn(options.runtimeRoot, options.session, {
    content: options.content,
    images: options.images,
    imageMeta: options.imageMeta,
    transcriptMessages: options.stoppedMessages,
    approvalMessages: [],
    requestId: options.requestId,
  });
  options.writer.writeEvent('done', buildChatSessionResponse(readConfig(options.configPath), updatedSession));
  if (!options.signal.aborted) options.writer.writeEvent('error', { error: options.failureDetail });
  return true;
}

/** Runs one message operation without owning an HTTP request, so Force now can reuse the same
 * engine, transcript, persistence, and queue-delivery path as the attached stream. */
export async function executeChatMessageOperation(options: {
  ctx: ServerContext;
  session: ChatSession;
  content: string;
  images: string[];
  requestId: string;
  progressWriter: ChatStreamProgressWriter;
  operationProgressWriter: ProgressWriter<RepoSearchProgressEvent>;
  queueDelivery?: ChatMessageQueueDelivery;
  abortSignal?: AbortSignal;
  parsedBody: ReturnType<typeof parseJsonBody>;
  phaseTracker?: ChatTurnPhaseTracker;
  startedAtMs?: number;
}): Promise<{ updatedSession: ChatSession; failure: string | null }> {
  const runtimeRoot = getRuntimeRoot();
  const config = readConfig(options.ctx.configPath);
  const selected = new ChatOperationPresetSelector(config.Presets).select(options.session, 'chat');
  const selectedImages = admitSelectedChatImages(config, selected.session, options.images);
  const memory = new ChatMemorySeam(options.ctx.assistant);
  const memoryContext = await memory.buildMemoryContext(selected.preset, options.content);
  const reader = new JsonRecordReader(options.parsedBody);
  const webOverrideRaw = reader.optionalString('webSearchOverride');
  const webEnabled = webOverrideRaw === 'on'
    ? true
    : webOverrideRaw === 'off'
      ? false
      : selected.session.webSearchEnabled === true;
  const mockResponses = readRouteMockResponses(reader, 'mockResponses');
  const effectiveConfig = selectedImages.effectiveConfig;
  const telemetry = new ChatTurnTelemetry(effectiveConfig, getMockTokenConfig(effectiveConfig, mockResponses));
  const result = await options.ctx.engineService.executeRepoSearch({
    presetId: selected.preset.id,
    requestId: options.requestId,
    taskKind: 'chat',
    modelPresetId: selected.session.modelPresetId,
    modelPreset: selected.session.modelPreset,
    prompt: options.content,
    repoRoot: process.cwd(),
    statusBackendUrl: `${options.ctx.getServiceBaseUrl()}/status`,
    config: effectiveConfig,
    systemPrompt: buildChatSystemContent(
      effectiveConfig,
      selected.session,
      memoryContext.length === 0 ? {} : { memoryContext },
    ),
    history: buildChatHistoryMessages(effectiveConfig, selected.session),
    thinkingEnabled: selected.session.thinkingEnabled !== false,
    allowedTools: ['web_search', 'web_fetch'],
    webToolsEnabled: webEnabled,
    retainedWebToolCalls: webEnabled ? buildRetainedWebToolCalls(selected.session) : [],
    maxTurns: readRouteNumber(reader, 'maxTurns'),
    availableModels: readRouteStringArray(reader, 'availableModels'),
    mockCommandResults: normalizeRepoSearchMockCommandResults(options.parsedBody.mockCommandResults),
    initialUserImages: selectedImages.images,
    ...(mockResponses ? { mockResponses } : {}),
    progressWriter: options.operationProgressWriter,
    queueDelivery: options.queueDelivery,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  const scorecardTasks = normalizeRepoSearchScorecard(result.scorecard).tasks;
  const assistantContent = String(scorecardTasks[0]?.finalOutput || '').trim();
  const scorecardSpeculative = readScorecardSpeculativeMetrics(result.scorecard);
  const usage: ChatUsage = {
    promptTokens: getScorecardTotal(result.scorecard, 'promptTokens'),
    promptCacheTokens: getScorecardTotal(result.scorecard, 'promptCacheTokens'),
    promptEvalTokens: getScorecardTotal(result.scorecard, 'promptEvalTokens'),
    promptEvalDurationMs: getScorecardTotal(result.scorecard, 'promptEvalDurationMs'),
    generationDurationMs: getScorecardTotal(result.scorecard, 'generationDurationMs'),
    promptTokensPerSecond: null,
    generationTokensPerSecond: null,
    speculativeAcceptedTokens: scorecardSpeculative.speculativeAcceptedTokens,
    speculativeGeneratedTokens: scorecardSpeculative.speculativeGeneratedTokens,
  };
  const persistTurns = await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(result));
  const phaseTracker = options.phaseTracker ?? new ChatTurnPhaseTracker(new Date().toISOString());
  phaseTracker.observeAnswer(assistantContent);
  const phaseTimestamps = phaseTracker.snapshot();
  const inputTokenCount = await telemetry.countInputTokens(options.content);
  const updatedSession = appendChatMessagesWithUsage(runtimeRoot, selected.session, options.content, assistantContent, usage, {
    turns: persistTurns,
    turnRecords: result.turnRecords,
    maintainPerStepThinking: telemetry.shouldMaintainPerStepThinking(selected.session),
    inputTokens: inputTokenCount.tokenCount,
    inputTokensEstimated: inputTokenCount.estimated,
    requestDurationMs: Date.now() - (options.startedAtMs ?? Date.now()),
    requestStartedAtUtc: phaseTimestamps.requestStartedAtUtc,
    thinkingStartedAtUtc: phaseTimestamps.thinkingStartedAtUtc,
    thinkingEndedAtUtc: phaseTimestamps.thinkingEndedAtUtc,
    answerStartedAtUtc: phaseTimestamps.answerStartedAtUtc,
    answerEndedAtUtc: phaseTimestamps.answerEndedAtUtc,
    speculativeAcceptedTokens: scorecardSpeculative.speculativeAcceptedTokens,
    speculativeGeneratedTokens: scorecardSpeculative.speculativeGeneratedTokens,
    groundingStatus: getChatGroundingStatus(result.scorecard),
    sourceRunId: String(result.requestId || ''),
    compactionSummary: scorecardTasks[0]?.compactionSummary ?? '',
    images: selectedImages.images,
    imageMeta: selectedImages.imageMeta,
  });
  ingestAssistantMemoryTurn(memory, selected.preset, selected.session.id, phaseTimestamps.requestStartedAtUtc ?? new Date().toISOString(), updatedSession.messages ?? []);
  options.progressWriter.flushPending();
  return { updatedSession, failure: getChatRunFailure(result) };
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
  turnRecords: TurnTokenRecord[];
  sourceRunId: string | null;
  compactionSummary: string;
};

function ingestAssistantMemoryTurn(
  memory: ChatMemorySeam,
  preset: SiftPreset,
  sessionId: string,
  capturedAtUtc: string,
  messages: readonly PersistedChatTranscriptMessage[],
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
        modelPresetId: this.session.modelPresetId,
        modelPreset: this.session.modelPreset,
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
          promptCacheTokens: getScorecardTotal(result.scorecard, 'promptCacheTokens'),
          promptEvalTokens: getScorecardTotal(result.scorecard, 'promptEvalTokens'),
          speculativeAcceptedTokens: scorecardSpeculative.speculativeAcceptedTokens,
          speculativeGeneratedTokens: scorecardSpeculative.speculativeGeneratedTokens,
        },
        persistTurns: await telemetry.countThinkingTokens(buildPersistTurnsFromRepoSearchResult(result)),
        turnRecords: result.turnRecords,
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
          turnRecords: [],
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
        turnRecords: turn.turnRecords,
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

  protected describeRun(
    session: ChatSession,
    value: ChatMessageRequest,
    config: SiftConfig,
  ): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'message',
        repoRoot: session.planRepoRoot,
        approval: null,
        maxTurns: null,
      }),
      content: value.content,
      images: value.images,
    };
  }

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

export class StreamChatMessageEndpoint extends ChatSessionOperationEndpoint<ChatMessageRequest> {
  protected readonly operationKind = 'message' as const;

  protected describeRun(
    session: ChatSession,
    value: ChatMessageRequest,
    config: SiftConfig,
  ): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'message',
        repoRoot: session.planRepoRoot,
        approval: null,
        maxTurns: null,
      }),
      content: value.content,
      images: value.images,
    };
  }
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
    req: IncomingMessage | null,
    res: ServerResponse | null,
    request: ChatSessionOperationRequest<ChatMessageRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const messageRequest = request.value;
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const opened = await openChatOperationStream(ctx, req, res, request, 'dashboard_chat_stream');
    if (!opened) {
      return;
    }
    const { stream, sseWriter, modelRequestLock, activeSession } = opened;
    const userContent = messageRequest.content;
    const startedAt = Date.now();
    const requestStartedAtUtc = new Date(startedAt).toISOString();
    const phaseTracker = new ChatTurnPhaseTracker(requestStartedAtUtc);
    const engineRequestId = request.queuedMessages && request.lease ? request.lease.operationId : randomUUID();
    const progressWriter = new ChatStreamProgressWriter(stream, phaseTracker, engineRequestId, true);
    const queueDelivery = ctx.chatMessageQueue.createDelivery({
      sessionId: activeSession.id,
      requestId: engineRequestId,
      operationKind: 'message',
      forceId: request.queueIntentId,
    });
    // One owner for the console: the presentation writer renders, this one logs.
    const operationProgressWriter = new CompositeRepoSearchProgressWriter(
      progressWriter,
      new RepoSearchToolLogProgressWriter('plan', engineRequestId),
    );
    let selectedImagesForError: { images: string[]; imageMeta: ImageMetadata[]; visionMaxImagePixels: number } | null = null;
    try {
      const config = readConfig(configPath);
      const selected = new ChatOperationPresetSelector(config.Presets).select(activeSession, 'chat');
      const selectedImages = admitSelectedChatImages(config, selected.session, messageRequest.images);
      selectedImagesForError = {
        images: selectedImages.images,
        imageMeta: selectedImages.imageMeta,
        visionMaxImagePixels: getActiveModelPreset(selectedImages.effectiveConfig).VisionMaxImagePixels,
      };
      const { updatedSession, failure } = await executeChatMessageOperation({
        ctx,
        session: activeSession,
        content: userContent,
        images: messageRequest.images,
        requestId: engineRequestId,
        progressWriter,
        operationProgressWriter,
        queueDelivery,
        abortSignal: abortController.signal,
        parsedBody: request.parsedBody,
        phaseTracker,
        startedAtMs: startedAt,
      });
      progressWriter.flushPending();
      if (failure && request.lease) request.lease.failure = failure;
      stream.writeEvent('done', buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      progressWriter.flushPending();
      if (!finishStoppedChatStream({
        signal: abortController.signal,
        failureDetail: toError(error).message,
        runtimeRoot,
        session: activeSession,
        content: userContent,
        images: selectedImagesForError?.images ?? messageRequest.images,
        imageMeta: selectedImagesForError?.imageMeta ?? [],
        stoppedMessages: progressWriter.getStoppedMessages(abortController.signal.aborted ? STOPPED_BY_USER_MARKER : `*Run failed: ${toError(error).message}*`),
        requestId: engineRequestId,
        configPath,
        writer: stream,
      })) {
        stream.writeEvent('error', {
          error: formatChatEngineError(error instanceof Error ? error : String(error)),
        });
      }
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter?.end();
    }
  }
}

class CreateChatPlanEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'plan' as const;

  /** A repository operation records the root it ran against; approval and turns are fixed here. */
  protected describeRun(
    session: ChatSession,
    value: ResolvedChatRepoRequest,
    config: SiftConfig,
  ): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'plan',
        repoRoot: value.repoRoot,
        approval: null,
        maxTurns: null,
      }),
      content: value.content,
      images: value.images,
    };
  }

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
      const progressWriter = new RepoSearchToolLogProgressWriter('plan', engineRequestId);
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
        queueDelivery: ctx.chatMessageQueue.createDelivery({
          sessionId: activeSession.id,
          requestId: engineRequestId,
          operationKind: 'plan',
      forceId: request.queueIntentId,
        }),
      }));
      if (result.failure && request.lease) request.lease.failure = result.failure;
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

export class StreamChatPlanEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'plan' as const;

  /** A repository operation records the root it ran against; approval and turns are fixed here. */
  protected describeRun(
    session: ChatSession,
    value: ResolvedChatRepoRequest,
    config: SiftConfig,
  ): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'plan',
        repoRoot: value.repoRoot,
        approval: null,
        maxTurns: null,
      }),
      content: value.content,
      images: value.images,
    };
  }
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
    req: IncomingMessage | null,
    res: ServerResponse | null,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const opened = await openChatOperationStream(ctx, req, res, request, 'dashboard_plan_stream');
    if (!opened) {
      return;
    }
    const { stream, sseWriter, modelRequestLock, activeSession } = opened;
    const engineRequestId = request.queuedMessages && request.lease ? request.lease.operationId : randomUUID();
    const progressWriter = new ChatStreamProgressWriter(stream, null, engineRequestId, false);
    const queueDelivery = ctx.chatMessageQueue.createDelivery({
      sessionId: activeSession.id,
      requestId: engineRequestId,
      operationKind: 'plan',
      forceId: request.queueIntentId,
    });
    // One owner for the console: the presentation writer renders, this one logs.
    const operationProgressWriter = new CompositeRepoSearchProgressWriter(
      progressWriter,
      new RepoSearchToolLogProgressWriter('plan', engineRequestId),
    );
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
        progressWriter: operationProgressWriter,
        abortSignal: abortController.signal,
        queueDelivery,
      }));
      progressWriter.flushPending();
      if (result.failure && request.lease) request.lease.failure = result.failure;
      stream.writeEvent('done', {
        ...buildChatSessionResponse(config, result.updatedSession),
        repoSearch: result.repoSearch,
      });
    } catch (error) {
      progressWriter.flushPending();
      if (!finishStoppedChatStream({
        signal: abortController.signal,
        failureDetail: toError(error).message,
        runtimeRoot,
        session: activeSession,
        content: request.value.content,
        images: request.value.images,
        imageMeta: [],
        stoppedMessages: progressWriter.getStoppedMessages(abortController.signal.aborted ? STOPPED_BY_USER_MARKER : `*Run failed: ${toError(error).message}*`),
        requestId: engineRequestId,
        configPath,
        writer: stream,
      })) {
        stream.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter?.end();
    }
  }
}

class CreateRepoSearchEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'repo-search' as const;

  /** A repository operation records the root it ran against; approval and turns are fixed here. */
  protected describeRun(
    session: ChatSession,
    value: ResolvedChatRepoRequest,
    config: SiftConfig,
  ): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'repo-search',
        repoRoot: value.repoRoot,
        approval: null,
        maxTurns: null,
      }),
      content: value.content,
      images: value.images,
    };
  }

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
      const progressWriter = new RepoSearchToolLogProgressWriter('rs', engineRequestId);
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
        queueDelivery: ctx.chatMessageQueue.createDelivery({
          sessionId: activeSession.id,
          requestId: engineRequestId,
          operationKind: 'repo-search',
      forceId: request.queueIntentId,
        }),
      }));
      if (result.failure && request.lease) request.lease.failure = result.failure;
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

export class StreamRepoSearchEndpoint extends ChatSessionOperationEndpoint<ResolvedChatRepoRequest> {
  protected readonly operationKind = 'repo-search' as const;

  /** A repository operation records the root it ran against; approval and turns are fixed here. */
  protected describeRun(
    session: ChatSession,
    value: ResolvedChatRepoRequest,
    config: SiftConfig,
  ): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'repo-search',
        repoRoot: value.repoRoot,
        approval: null,
        maxTurns: null,
      }),
      content: value.content,
      images: value.images,
    };
  }
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
    req: IncomingMessage | null,
    res: ServerResponse | null,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<void> {
    const { configPath } = ctx;
    const runtimeRoot = getRuntimeRoot();
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const opened = await openChatOperationStream(ctx, req, res, request, 'dashboard_repo_search_stream');
    if (!opened) {
      return;
    }
    const { stream, sseWriter, modelRequestLock, activeSession } = opened;
    const engineRequestId = request.queuedMessages && request.lease ? request.lease.operationId : randomUUID();
    const progressWriter = new ChatStreamProgressWriter(stream, null, engineRequestId, false);
    const queueDelivery = ctx.chatMessageQueue.createDelivery({
      sessionId: activeSession.id,
      requestId: engineRequestId,
      operationKind: 'repo-search',
      forceId: request.queueIntentId,
    });
    // One owner for the console: the presentation writer renders, this one logs.
    const operationProgressWriter = new CompositeRepoSearchProgressWriter(
      progressWriter,
      new RepoSearchToolLogProgressWriter('rs', engineRequestId),
    );
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
        progressWriter: operationProgressWriter,
        abortSignal: abortController.signal,
        queueDelivery,
      }));
      progressWriter.flushPending();
      if (result.failure && request.lease) request.lease.failure = result.failure;
      stream.writeEvent('done', {
        ...buildChatSessionResponse(config, result.updatedSession),
        repoSearch: result.repoSearch,
      });
    } catch (error) {
      progressWriter.flushPending();
      if (!finishStoppedChatStream({
        signal: abortController.signal,
        failureDetail: toError(error).message,
        runtimeRoot,
        session: activeSession,
        content: request.value.content,
        images: request.value.images,
        imageMeta: [],
        stoppedMessages: progressWriter.getStoppedMessages(abortController.signal.aborted ? STOPPED_BY_USER_MARKER : `*Run failed: ${toError(error).message}*`),
        requestId: engineRequestId,
        configPath,
        writer: stream,
      })) {
        stream.writeEvent('error', { error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
      sseWriter?.end();
    }
  }
}

class CondenseChatSessionEndpoint extends ChatSessionOperationEndpoint<'condense'> {
  protected readonly operationKind = 'condense' as const;

  /** Condense is a model run over the existing history; it carries no new user text of its own. */
  protected describeRun(session: ChatSession, _value: 'condense', config: SiftConfig): ChatRunSubmission {
    return {
      settings: buildChatRunSettings({
        session,
        config,
        operationKind: 'condense',
        repoRoot: session.planRepoRoot,
        approval: null,
        maxTurns: null,
      }),
      content: '',
      images: [],
    };
  }

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
    const completionPromise = ctx.chatSessionOperations.waitForCompletion(active);
    ctx.chatMessageQueue.store.setPaused(sessionId, true);
    const force = ctx.chatMessageQueue.store.state(sessionId).force;
    if (force?.operationId === active.operationId) {
      ctx.chatMessageQueue.store.updateForce(sessionId, force.id, { phase: 'failed', failureDetail: 'Continuation cancelled by Stop.' });
      ctx.chatMessageQueue.store.clearForce(sessionId, force.id);
    }
    ctx.chatMessageQueue.publish(sessionId);
    active.abort();
    const completion = await completionPromise;
    if (completion.kind === 'failed') {
      sendJson(res, 500, { error: completion.error });
      return;
    }
    sendJson(res, 200, { ok: true, operationKind: active.operationKind });
  }
}
const CHAT_ROUTES = new RouteTable([
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/queue\/stream$/u, endpoint: new ChatMessageQueueStreamEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/queue\/force$/u, endpoint: new ChatMessageQueueForceEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/queue\/([^/]+)$/u, endpoint: new ChatMessageQueueEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/queue$/u, endpoint: new ChatMessageQueueEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/queue$/u, endpoint: new ChatMessageQueueEndpoint() },
  { method: 'PUT', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/queue\/([^/]+)$/u, endpoint: new ChatMessageQueueEndpoint() },
  { method: 'DELETE', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/queue\/([^/]+)$/u, endpoint: new ChatMessageQueueEndpoint() },
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
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/approval-mode$/u, endpoint: new ChatRepoAgentApprovalModeEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/active$/u, endpoint: new GetChatRepoAgentActiveEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/operations$/u, endpoint: new GetActiveChatOperationsEndpoint() },
  { method: 'GET', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/operation\/stream$/u, endpoint: new GetChatOperationStreamEndpoint() },
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
