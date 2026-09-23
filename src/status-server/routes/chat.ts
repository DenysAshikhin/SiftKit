import { buildChatMessageId } from '@siftkit/contracts';
import { getChatRunFailure } from '../chat.js';
import { ChatMessageQueueEndpoint,ChatMessageQueueForceEndpoint,ChatMessageQueueStreamEndpoint } from './chat-message-queue.js';
/**
 * Dashboard chat session routes: CRUD, message generation, streaming,
 * plan/repo-search execution, condensation, and tool-context management.
 */
import {
StopChatOperationRequestSchema,
type ChatQueueOperationKind,
type ChatSessionsResponse,
type ImageMetadata,
} from '@siftkit/contracts';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import {
getActiveModelPreset,
getConfiguredReasoning,
notifyStatusBackend,
type SiftConfig
} from '../../config/index.js';
import { toError } from '../../lib/errors.js';
import { throwIfAborted } from '../../lib/abort.js';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { JsonObject,OptionalJsonValue } from '../../lib/json-types.js';
import { ProgressWriter } from '../../lib/progress-writer.js';
import { buildUserContent } from '../../llm-protocol/image-attachments.js';
import { admitImagesForPreset } from '../../llm-protocol/preset-image-admission.js';
import { MockPlannerResponsesSchema,type MockPlannerResponse } from '../../planner-protocol/mock-response.js';
import { PresetCatalog } from '../../preset-catalog.js';
import type { SiftPreset } from '../../presets.js';
import type { ChatGroundingStatus } from '../../repo-search/chat-grounding-policy.js';
import type { ChatMessageQueueDelivery } from '../../repo-search/engine/queue-delivery.js';
import type { ChatMessage as PersistedChatTranscriptMessage } from '../../state/chat-sessions.js';
import {
ChatMessageImageNotFoundError,deleteChatMessage,
deleteChatMessageImage,deleteChatSession,estimateTokenCount,getChatSessionPath,readChatSessionFromPath,
readChatSessionSummaries,saveChatSessionMetadata,type ChatSession
} from '../../state/chat-sessions.js';
import { ChatMemorySeam } from '../chat-memory-seam.js';
import { ChatOperationBroadcast } from '../chat-operation-broadcast.js';
import {
ChatOperationPresetSelector,
resolveChatRunAllowedTools,
type SelectedChatOperationPreset,
} from '../chat-operation-preset.js';
import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
import { buildChatSessionResponse, toWireChatSessionSummary } from '../chat-session-response.js';
import {
ChatRepoOperationRunner,
type ChatRepoOperationRequest,
} from '../chat-repo-operation-runner.js';
import type { ChatMessageRequest } from '../chat-route-request-normalizers.js';
import {
parseChatSessionCreateRequest,
parseChatSessionUpdateRequest,
} from '../chat-route-request-normalizers.js';
import { buildChatAnswerCompletion,buildChatRunSettings,type ChatRunRecorder } from '../chat-run-recorder.js';
import type { QuestionGate } from '../../repo-search/engine/question-gate.js';
import {
ChatStreamProgressWriter,
} from '../chat-stream-progress-writer.js';
import { ChatTurnPhaseTracker } from '../chat-turn-phase-tracker.js';
import { auditCompletedChatSessionThroughput, countChatInputTokens, getLocalTokenConfig, getMockTokenConfig } from '../chat-turn-telemetry.js';
import {
buildChatSystemContent,
buildRetainedWebToolCalls,
condenseChatSession,
} from '../chat.js';
import { readConfig } from '../config-store.js';
import { getConfiguredEngineNumCtx } from '../../config/getters.js';
import { applyHostEngineRuntimeSettings } from '../../config/host-sync.js';
import {
removeDashboardRunCommandFromLogs,
type RepoSearchProgressEvent,
} from '../dashboard-runs.js';
import {
parseJsonBody,
readBody,
sendBodyReadError,
sendJson,
} from '../http-utils.js';
import {
CompositeRepoSearchProgressWriter,
RepoSearchToolLogProgressWriter,
} from '../operation-progress-writers.js';
import { getRuntimeRoot } from '../paths.js';
import { normalizeRepoSearchMockCommandResults } from '../repo-search-request-normalizers.js';
import { normalizeRepoSearchScorecard } from '../repo-search-scorecard-types.js';
import { RouteTable,type RouteEndpoint,type RouteMatch } from '../route-table.js';
import { createServerJsonLogger,serverLogger } from '../server-logger.js';
import {
ModelRequestTargetError,
UncancelledModelWaitError,
acquireWebUiModelRequest,
releaseModelRequest,
} from '../server-ops.js';
import type { ModelRequestIntent } from '../../lib/model-request-intent.js';
import type { ModelRequestLock,ServerContext } from '../server-types.js';
import { SseResponseWriter } from '../sse-response-writer.js';
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
import { ChatQuestionAnswerEndpoint } from './chat-question.js';
import type { ChatRunSubmission, ChatOperationOutcome } from './chat-session-operation-endpoint.js';
import {
ChatRepoRootOperationEndpoint,
ChatSessionOperationEndpoint,
parseChatMessageOperationRequest,
parseChatRepoOperationRequest,previewChatOperationTarget,requireChatRunRecorder,requireQuestionGate,type ChatSessionOperationRequest,
type ResolvedChatRepoRequest
} from './chat-session-operation-endpoint.js';

function normalizeChatGroundingStatus(value: ChatGroundingStatus | null | undefined): ChatGroundingStatus | null {
  if (value === 'ungrounded' || value === 'snippet_only' || value === 'fetched') {
    return value;
  }
  return null;
}

function getChatGroundingStatus(scorecard: OptionalJsonValue): ChatGroundingStatus | null {
  return normalizeChatGroundingStatus(normalizeRepoSearchScorecard(scorecard).tasks[0]?.groundingStatus);
}


/** Admits images against the model `config` executes on: an operation's admitted snapshot, or a preview target. */
export function admitChatImagesForConfig(
  config: SiftConfig,
  requestedImages: string[],
): { images: string[]; imageMeta: ImageMetadata[] } {
  const admitted = admitImagesForPreset(getActiveModelPreset(config), requestedImages);
  return {
    images: admitted.map((image) => image.dataUrl),
    imageMeta: admitted.map((image) => image.metadata),
  };
}

/**
 * Checks queued images against the model their operation resolves to now. They are stored unmodified:
 * delivery admits them against the model the delivering run was actually admitted on.
 */
export function validateQueuedChatImages(ctx: ServerContext, session: ChatSession, operationKind: ChatQueueOperationKind,
  images: string[]): void {
  const operation = operationKind === 'message' ? 'chat' : operationKind;
  const selected = new ChatOperationPresetSelector(readConfig(ctx.configPath).Presets).select(session, operation);
  admitChatImagesForConfig(previewChatOperationTarget(ctx, selected.preset.id).config, images);
}

/** The operation preset the run was submitted under decides its model at admission. */
function chatRunIntent(recorder: ChatRunRecorder): ModelRequestIntent {
  return { presetId: recorder.settings.presetId, model: null };
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

function buildChatRepoOperationRequest(options: {
  recorder: ChatRunRecorder;
  questionGate: QuestionGate;
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
    recorder: options.recorder,
    questionGate: options.questionGate,
    session: options.session,
    config: options.config,
    content: options.content,
    images: options.images,
    repoRoot: options.repoRoot,
    statusBackendUrl: `${options.ctx.getServiceBaseUrl()}/status`,
    engineService: options.ctx.engineService,
    progressWriter: options.progressWriter,
    requestId: options.requestId,
    logFile: options.reader.optionalString('logFile'),
    availableModels: readRouteStringArray(options.reader, 'availableModels'),
    mockResponses: readRouteMockResponses(options.reader, 'mockResponses'),
    mockCommandResults: normalizeRepoSearchMockCommandResults(options.parsedBody.mockCommandResults),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.queueDelivery ? { queueDelivery: options.queueDelivery } : {}),
  };
}

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
  modelRequestLock: ModelRequestLock;
  activeSession: ChatSession;
};

/** The granted model is journaled before any engine work, so every run names the model it executed on. */
function journalChatAdmission(recorder: ChatRunRecorder, lock: ModelRequestLock): void {
  recorder.recordModelAdmitted(lock.context.modelPreset, getConfiguredEngineNumCtx(lock.context.config));
}

/** Admission readies the model before granting, so a refused target or failed load answers 503 here. */
async function acquireChatModelRequest(
  ctx: ServerContext,
  lockKind: string,
  req: IncomingMessage,
  res: ServerResponse,
  request: { recorder: ChatRunRecorder | null },
): Promise<ModelRequestLock | ChatOperationOutcome> {
  const recorder = requireChatRunRecorder(request);
  let lock: ModelRequestLock | null;
  try {
    lock = await acquireWebUiModelRequest(ctx, lockKind, chatRunIntent(recorder), recorder.abortSignal, req, res);
  } catch (error) {
    const message = toError(error).message;
    sendJson(res, error instanceof ModelRequestTargetError ? 400 : 503, { error: message });
    return { failure: message };
  }
  if (lock) {
    journalChatAdmission(recorder, lock);
    return lock;
  }
  // The run record settles Stop, deletion, and a closed client as cancellations.
  if (recorder.stopRequested || recorder.sessionDeleted || res.destroyed) return { failure: null };
  throwIfAborted(recorder.abortSignal);
  throw new UncancelledModelWaitError(lockKind);
}

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
): Promise<OpenedChatOperationStream | ChatOperationOutcome> {
  const stream = requireChatOperationBroadcast(ctx, request);
  const fail = (status: number, error: string): ChatOperationOutcome => {
    stream.fail(error);
    if (res) sendJson(res, status, { error });
    return { failure: error };
  };
  // The stream outlives its client: a reload reattaches through /operation/stream, so a closed
  // socket must not cancel a turn that is only waiting for the model lock.
  const recorder = requireChatRunRecorder(request);
  let modelRequestLock: ModelRequestLock | null;
  try {
    modelRequestLock = await acquireWebUiModelRequest(ctx, lockKind, chatRunIntent(recorder), recorder.abortSignal);
  } catch (error) {
    return fail(error instanceof ModelRequestTargetError ? 400 : 503, toError(error).message);
  }
  if (!modelRequestLock) {
    if (recorder.stopRequested || recorder.sessionDeleted) return { failure: null };
    throwIfAborted(recorder.abortSignal);
    const defect = new UncancelledModelWaitError(lockKind);
    fail(503, defect.message);
    throw defect;
  }
  journalChatAdmission(recorder, modelRequestLock);
  const activeSession = readChatSessionFromPath(request.sessionPath);
  if (!activeSession) {
    releaseModelRequest(ctx, modelRequestLock.token);
    return fail(404, 'Session not found.');
  }
  const sseWriter = req && res ? new SseResponseWriter(req, res) : null;
  if (sseWriter) {
    sseWriter.open();
    const subscriber = new ChatOperationSseSubscriber(sseWriter, { ctx, sessionId: request.sessionId,
      operationId: requireChatRunRecorder(request).operationId, database: ctx.runtimeDatabase });
    stream.attach(subscriber);
    subscriber.start();
    res?.on('close', () => stream.detach(subscriber));
  }
  return { stream, modelRequestLock, activeSession };
}

/** Runs one message operation without owning an HTTP request, so Force now can reuse the same
 * engine, transcript, persistence, and queue-delivery path as the attached stream. `config` is the
 * admitted snapshot: images, prompt, and engine all run on its model. */
async function runChatEngineTurn(options: {
  ctx: ServerContext;
  config: SiftConfig;
  recorder: ChatRunRecorder;
  questionGate: QuestionGate;
  session: ChatSession;
  content: string;
  images: string[];
  requestId: string;
  progressWriter: ChatStreamProgressWriter;
  operationProgressWriter: ProgressWriter<RepoSearchProgressEvent>;
  queueDelivery?: ChatMessageQueueDelivery;
  abortSignal?: AbortSignal;
  parsedBody: JsonObject;
  phaseTracker?: ChatTurnPhaseTracker;
  startedAtMs: number;
}): Promise<{ updatedSession: ChatSession; failure: string | null }> {
  const config = options.config;
  const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, options.recorder.abortSignal]) : options.recorder.abortSignal;
  throwIfAborted(abortSignal);
  const selected = new ChatOperationPresetSelector(config.Presets).select(options.session, 'chat');
  const selectedImages = admitChatImagesForConfig(config, options.images);
  const memory = new ChatMemorySeam(options.ctx.assistant);
  const memoryContext = await memory.buildMemoryContext(selected.preset, options.content);
  throwIfAborted(abortSignal);
  const reader = new JsonRecordReader(options.parsedBody);
  // Web access and the turn limit were settled at admission; execution does not re-read the body.
  const settings = options.recorder.settings;
  const webEnabled = settings.webSearchEnabled;
  const mockResponses = readRouteMockResponses(reader, 'mockResponses');
  options.recorder.bindEngine({ requestId: options.requestId, repoAgentSessionId: null });
  const result = await options.ctx.engineService.executeRepoSearch({
    evidenceRecorder: options.recorder,
    questionGate: options.questionGate,
    presetId: selected.preset.id,
    requestId: options.requestId,
    taskKind: 'chat',
    prompt: options.content,
    repoRoot: process.cwd(),
    statusBackendUrl: `${options.ctx.getServiceBaseUrl()}/status`,
    config,
    systemPrompt: buildChatSystemContent(
      config,
      selected.session,
      memoryContext.length === 0 ? {} : { memoryContext },
    ),
    history: options.recorder.readHistory(),
    thinkingEnabled: selected.session.thinkingEnabled !== false,
    allowedTools: resolveChatRunAllowedTools({ operation: 'chat', webEnabled }),
    webToolsEnabled: webEnabled,
    retainedWebToolCalls: webEnabled ? buildRetainedWebToolCalls(selected.session) : [],
    maxTurns: settings.maxTurns ?? undefined,
    availableModels: readRouteStringArray(reader, 'availableModels'),
    mockCommandResults: normalizeRepoSearchMockCommandResults(options.parsedBody.mockCommandResults),
    initialUserImages: selectedImages.images,
    ...(mockResponses ? { mockResponses } : {}),
    progressWriter: options.operationProgressWriter,
    queueDelivery: options.queueDelivery,
    abortSignal,
  });
  throwIfAborted(abortSignal);
  const assistantContent = String(normalizeRepoSearchScorecard(result.scorecard).tasks[0]?.finalOutput ?? '').trim();
  const phaseTracker = options.phaseTracker ?? new ChatTurnPhaseTracker(new Date(options.startedAtMs).toISOString());
  phaseTracker.observeAnswer(assistantContent);
  const phaseTimestamps = phaseTracker.snapshot();
  const failure = getChatRunFailure(result);
  options.progressWriter.flushPending();
  const updatedSession = options.recorder.completeAnswer({
    ...buildChatAnswerCompletion(result, assistantContent, {
      operationType: 'chat',
      operationId: result.scorecard.runId,
      requestId: result.requestId,
      model: result.scorecard.model,
      presetId: options.recorder.admittedModel.id,
    }),
    ...phaseTimestamps,
    requestDurationMs: Date.now() - options.startedAtMs,
    groundingStatus: getChatGroundingStatus(result.scorecard),
  }, failure ? 'execution_failure' : 'completed', failure);
  auditCompletedChatSessionThroughput(updatedSession, {
    requestId: result.requestId,
    model: result.scorecard.model,
    presetId: options.recorder.admittedModel.id,
  });
  ingestAssistantMemoryTurn(memory, selected.preset, selected.session.id, phaseTimestamps.requestStartedAtUtc ?? new Date().toISOString(), updatedSession.messages ?? []);
  return { updatedSession, failure };
}

class ListChatSessionsEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const sessions = readChatSessionSummaries(getRuntimeRoot()).map(summary => toWireChatSessionSummary(summary));
    // Listing never replays journals; it reports what reads of individual sessions already found.
    const sessionsResponse: ChatSessionsResponse = {
      sessions,
      recovery: sessions.flatMap(session => ctx.chatSessionRecovery.peek(session.id)),
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
    const runtimeRoot = getRuntimeRoot();
    const sessionId = decodeURIComponent(pathname.replace(/^\/dashboard\/chat\/sessions\//u, ''));
    let session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    const recovery = ctx.chatSessionRecovery.forSession(sessionId);
    session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
    if (!session) throw new Error('Chat session disappeared during synchronous reconciliation.');
    const config = readConfig(ctx.configPath);
    sendJson(res, 200, buildChatSessionResponse(config, runtimeRoot, session, recovery));
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
    const currentConfig = readConfig(ctx.configPath);
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
    saveChatSessionMetadata(runtimeRoot, updated);
    sendJson(res, 200, buildChatSessionResponse(currentConfig, runtimeRoot, updated));
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
    ctx.chatSessionRecovery.invalidate(sessionId);
    if (!deleted) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    const active = ctx.chatSessionOperations.getActive(sessionId);
    active?.recorder?.markSessionDeleted();
    active?.abort?.();
    ctx.chatSessionOperations.getBroadcast(sessionId)?.fail('Session not found.');
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
    const runtimeRoot = getRuntimeRoot();
    const match = /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/u.exec(pathname);
    const sessionId = decodeURIComponent(match?.[1] || '');
    const messageId = decodeURIComponent(match?.[2] || '');
    const result = deleteChatMessage(runtimeRoot, sessionId, messageId);
    // The transcript rows a replay validates against just changed, so the cached verdict is stale.
    ctx.chatSessionRecovery.invalidate(sessionId);
    if (!result) {
      sendJson(res, 404, { error: 'Message not found.' });
      return;
    }
    const deletedMessage = result.deletedMessage;
    const runId = deletedMessage.sourceRequestId;
    const commandText = typeof deletedMessage.toolCallCommand === 'string'
      ? deletedMessage.toolCallCommand.trim()
      : '';
    if (runId && commandText) {
      removeDashboardRunCommandFromLogs(ctx.runtimeDatabase, runId, commandText);
    }
    const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId)) || result.session;
    ctx.chatSessionOperations.getBroadcast(sessionId)?.notifyHistoryRevised();
    sendJson(res, 200, buildChatSessionResponse(readConfig(ctx.configPath), runtimeRoot, session));
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
    const runtimeRoot = getRuntimeRoot();
    const match = /^\/dashboard\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/([0-9]+)$/u
      .exec(routeMatch.pathname);
    const sessionId = decodeURIComponent(match?.[1] || '');
    const messageId = decodeURIComponent(match?.[2] || '');
    const imageIndex = Number(match?.[3]);
    try {
      deleteChatMessageImage(runtimeRoot, sessionId, messageId, imageIndex);
      // An image row is part of the transcript a replay validates against.
      ctx.chatSessionRecovery.invalidate(sessionId);
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
    ctx.chatSessionOperations.getBroadcast(sessionId)?.notifyHistoryRevised();
    sendJson(res, 200, buildChatSessionResponse(readConfig(ctx.configPath), runtimeRoot, session));
  }
}

class CreateChatSessionEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
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
    const currentConfig = readConfig(ctx.configPath);
    const presets = PresetCatalog.fromPresets(currentConfig.Presets);
    let preset: SiftPreset;
    let previewConfig: SiftConfig;
    let responseConfig: SiftConfig;
    try {
      preset = presets.requireById(createRequest.presetId);
      // A new session previews the model its preset resolves to now, as a pass-through host reports it.
      previewConfig = await applyHostEngineRuntimeSettings(previewChatOperationTarget(ctx, preset.id).config);
      responseConfig = await applyHostEngineRuntimeSettings(currentConfig);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const session: ChatSession = {
      id: randomUUID(),
      title: createRequest.title || 'New Session',
      modelPresetId: getActiveModelPreset(previewConfig).id,
      modelPreset: getActiveModelPreset(previewConfig),
      thinkingEnabled: getConfiguredReasoning(previewConfig) !== 'off',
      webSearchEnabled: currentConfig.WebSearch.EnabledDefault === true,
      presetId: preset.id,
      mode: presets.deriveChatSessionMode(preset.id),
      planRepoRoot: process.cwd(),
      createdAtUtc: now,
      updatedAtUtc: now,
      messages: [],
    };
    saveChatSessionMetadata(runtimeRoot, session);
    sendJson(res, 200, buildChatSessionResponse(responseConfig, runtimeRoot, session));
    return;
  }
}

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
  private readonly memory: ChatMemorySeam;

  constructor(
    private readonly ctx: ServerContext,
    private readonly runtimeRoot: string,
    private readonly res: ServerResponse,
    private readonly session: ChatSession,
    private readonly config: SiftConfig,
    private readonly preset: SiftPreset,
    private readonly userContent: string,
    private readonly userImages: string[],
    private readonly parsedBody: JsonObject,
    private readonly recorder: ChatRunRecorder,
    private readonly questionGate: QuestionGate,
  ) {
    this.memory = new ChatMemorySeam(ctx.assistant);
  }

  async runEngineTurn(): Promise<ChatOperationOutcome> {
    const progress = new ChatStreamProgressWriter(new ChatOperationBroadcast(), null, true, this.recorder);
    try {
      const mockResponses = readRouteMockResponses(new JsonRecordReader(this.parsedBody), 'mockResponses');
      await this.measureInputTokens(getMockTokenConfig(this.config, mockResponses));
      const { updatedSession, failure } = await runChatEngineTurn({
        ctx: this.ctx, config: this.config, recorder: this.recorder, questionGate: this.questionGate,
        session: this.session, content: this.userContent, images: this.userImages, requestId: this.requestId,
        progressWriter: progress, operationProgressWriter: progress, parsedBody: this.parsedBody, startedAtMs: this.startedAt,
        queueDelivery: this.ctx.chatMessageQueue.createDelivery({ recorder: this.recorder, sessionId: this.session.id,
          requestId: this.requestId, operationKind: 'message' }),
      });
      this.respond(updatedSession);
      return { failure };
    } catch (error) {
      return this.fail(toError(error));
    } finally {
      progress.flushPending();
    }
  }

  async runProvidedAssistantTurn(content: string): Promise<ChatOperationOutcome> {
    try {
      await this.measureInputTokens(getLocalTokenConfig(this.config));
      throwIfAborted(this.recorder.abortSignal);
      const statusBackendUrl = this.ctx.getServiceBaseUrl() + '/status';
      await notifyStatusBackend({ running: true, taskKind: 'chat', requestId: this.requestId, statusBackendUrl,
        promptCharacterCount: this.userContent.length, promptTokenCount: estimateTokenCount(this.userContent) });
      throwIfAborted(this.recorder.abortSignal);
      const history = this.recorder.readHistory();
      this.recorder.recordContextInitialized({ messages: [
        ...history, { role: 'user', content: buildUserContent(this.userContent, this.userImages), chatMessageId: this.recorder.userMessageId },
        { role: 'assistant', content, chatMessageId: buildChatMessageId(this.recorder.messageIdPrefix, { kind: 'answer-final' }) },
      ], contextRevision: 0, turnBoundary: history.length });
      const updated = this.recorder.completeAnswer({ content, outputTokensEstimate: estimateTokenCount(content), outputTokensEstimated: true,
        requestStartedAtUtc: new Date(this.startedAt).toISOString(), requestDurationMs: Date.now() - this.startedAt,
      });
      await notifyStatusBackend({ running: false, terminalState: 'completed', taskKind: 'chat', requestId: this.requestId, statusBackendUrl,
        promptCharacterCount: this.userContent.length, rawInputCharacterCount: this.userContent.length,
        inputTokens: estimateTokenCount(this.userContent), outputCharacterCount: content.length,
        outputTokens: estimateTokenCount(content), requestDurationMs: Date.now() - this.startedAt });
      ingestAssistantMemoryTurn(this.memory, this.preset, this.session.id, new Date(this.startedAt).toISOString(), updated.messages);
      this.respond(updated);
      return { failure: null };
    } catch (error) {
      return this.fail(toError(error));
    }
  }

  private async measureInputTokens(tokenConfig: SiftConfig | undefined): Promise<void> {
    const count = await countChatInputTokens(tokenConfig, this.userContent);
    this.recorder.recordDisplay({ kind: 'user_usage', messageId: this.recorder.userMessageId, inputTokens: count.tokenCount, estimated: count.estimated });
  }

  private respond(session: ChatSession): void {
    sendJson(this.res, 200, buildChatSessionResponse(this.config, this.runtimeRoot, session));
  }

  private fail(error: Error): ChatOperationOutcome {
    if (this.recorder.stopRequested || this.recorder.sessionDeleted) throw error;
    const detail = toError(error).message;
    if (this.recorder.terminalCause === null) this.recorder.finish({ terminalCause: 'execution_failure', detail, usage: null, recoveryStatus: 'recovery_needed' });
    this.recorder.readSession();
    sendJson(this.res, 500, { error: detail });
    return { failure: detail };
  }
}

/**
 * Admission-time settings for a message run: the selected chat preset, the request's turn limit
 * (falling back to the preset's), and the web override applied to the session default.
 */
function describeChatMessageRun(
  ctx: ServerContext,
  session: ChatSession,
  value: ChatMessageRequest,
  webToolsAllowed: boolean,
): ChatRunSubmission {
  const selected = new ChatOperationPresetSelector(readConfig(ctx.configPath).Presets).select(session, 'chat');
  const target = previewChatOperationTarget(ctx, selected.preset.id);
  const webSearchEnabled = webToolsAllowed && (value.webSearchOverride === 'on'
    ? true
    : value.webSearchOverride === 'off'
      ? false
      : selected.session.webSearchEnabled === true);
  return {
    target,
    settings: buildChatRunSettings({
      session: selected.session,
      target,
      operationKind: 'message',
      presetId: selected.preset.id,
      repoRoot: session.planRepoRoot,
      approval: null,
      maxTurns: value.maxTurns ?? selected.preset.maxTurns,
      webSearchEnabled,
    }),
    content: value.content,
    images: value.images,
  };
}

class CreateChatMessageEndpoint extends ChatSessionOperationEndpoint<ChatMessageRequest> {
  protected readonly operationKind = 'message' as const;

  protected describeRun(ctx: ServerContext, session: ChatSession, value: ChatMessageRequest): ChatRunSubmission {
    return describeChatMessageRun(ctx, session, value, false);
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
  ): Promise<ChatOperationOutcome> {
    const messageRequest = request.value;
    const providedAssistantContent = messageRequest.assistantContent || '';
    // Client-supplied assistant content makes no model call, so it neither queues nor loads a model.
    if (providedAssistantContent) {
      const turn = this.openTurn(ctx, res, request, request.session, readConfig(ctx.configPath));
      return 'failure' in turn ? turn : await turn.runProvidedAssistantTurn(providedAssistantContent);
    }
    const modelRequestLock = await acquireChatModelRequest(ctx, 'dashboard_chat', req, res, request);
    if ('failure' in modelRequestLock) return modelRequestLock;
    try {
      const activeSession = readChatSessionFromPath(request.sessionPath);
      if (!activeSession) {
        sendJson(res, 404, { error: 'Session not found.' });
        return { failure: 'Session not found.' };
      }
      const turn = this.openTurn(ctx, res, request, activeSession, modelRequestLock.context.config);
      return 'failure' in turn ? turn : await turn.runEngineTurn();
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }

  /** `config` is the admitted snapshot for an engine turn, or the saved config for a provided answer. */
  private openTurn(
    ctx: ServerContext,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ChatMessageRequest>,
    session: ChatSession,
    config: SiftConfig,
  ): ChatMessageTurn | ChatOperationOutcome {
    let selected: SelectedChatOperationPreset;
    try {
      selected = new ChatOperationPresetSelector(config.Presets).select(session, 'chat');
    } catch (error) {
      sendJson(res, 400, { error: toError(error).message });
      return { failure: toError(error).message };
    }
    const images = admitChatImagesForConfig(config, request.value.images).images;
    saveChatSessionMetadata(getRuntimeRoot(), selected.session);
    return new ChatMessageTurn(ctx, getRuntimeRoot(), res, selected.session, config, selected.preset,
      request.value.content, images, request.parsedBody, requireChatRunRecorder(request), requireQuestionGate(request));
  }
}

export class StreamChatMessageEndpoint extends ChatSessionOperationEndpoint<ChatMessageRequest> {
  protected readonly operationKind = 'message' as const;

  protected describeRun(ctx: ServerContext, session: ChatSession, value: ChatMessageRequest): ChatRunSubmission {
    return describeChatMessageRun(ctx, session, value, true);
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
  ): Promise<ChatOperationOutcome> {
    const messageRequest = request.value;
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const opened = await openChatOperationStream(ctx, req, res, request, 'dashboard_chat_stream');
    if ('failure' in opened) return opened;
    const { stream, modelRequestLock, activeSession } = opened;
    const userContent = messageRequest.content;
    const startedAt = Date.now();
    const requestStartedAtUtc = new Date(startedAt).toISOString();
    const phaseTracker = new ChatTurnPhaseTracker(requestStartedAtUtc);
    const engineRequestId = request.queuedMessages && request.lease ? request.lease.operationId : randomUUID();
    const progressWriter = new ChatStreamProgressWriter(stream, phaseTracker, true, requireChatRunRecorder(request));
    const queueDelivery = ctx.chatMessageQueue.createDelivery({
      recorder: requireChatRunRecorder(request),
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
    try {
      const { failure } = await runChatEngineTurn({
        ctx,
        config: modelRequestLock.context.config,
        recorder: requireChatRunRecorder(request),
        questionGate: requireQuestionGate(request),
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
      return { failure };
    } catch (error) {
      progressWriter.flushPending();
      const detail = toError(error).message;
      const stopped = abortController.signal.aborted;
      requireChatRunRecorder(request).stop(stopped ? 'user_stop' : 'execution_failure', stopped ? null : detail);
      if (!stopped) stream.fail(detail);
      return { failure: stopped ? null : detail };
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}

const CHAT_REPO_OPERATION_SETTINGS = {
  plan: { lockKind: 'dashboard_plan', streamLockKind: 'dashboard_plan_stream', logPrefix: 'plan' },
  'repo-search': { lockKind: 'dashboard_repo_search', streamLockKind: 'dashboard_repo_search_stream', logPrefix: 'rs' },
} as const;

abstract class ChatRepoOperationEndpoint extends ChatRepoRootOperationEndpoint<ResolvedChatRepoRequest> {
  constructor(protected readonly operationKind: 'plan' | 'repo-search') { super(); }

  /** A repository operation records the root it ran against and the turn limit the engine gets. */
  protected describeRun(ctx: ServerContext, session: ChatSession, value: ResolvedChatRepoRequest): ChatRunSubmission {
    const selected = new ChatOperationPresetSelector(readConfig(ctx.configPath).Presets).select(session, this.operationKind);
    const target = previewChatOperationTarget(ctx, selected.preset.id);
    return {
      target,
      settings: buildChatRunSettings({
        session: selected.session,
        target,
        operationKind: this.operationKind,
        presetId: selected.preset.id,
        repoRoot: value.repoRoot,
        approval: null,
        maxTurns: value.maxTurns ?? selected.preset.maxTurns,
        webSearchEnabled: selected.session.webSearchEnabled === true,
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

}

class CreateChatRepoOperationEndpoint extends ChatRepoOperationEndpoint {
  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<ChatOperationOutcome> {
    const runtimeRoot = getRuntimeRoot();
    const modelRequestLock = await acquireChatModelRequest(ctx, CHAT_REPO_OPERATION_SETTINGS[this.operationKind].lockKind, req, res, request);
    if ('failure' in modelRequestLock) return modelRequestLock;
    const activeSession = readChatSessionFromPath(request.sessionPath);
    if (!activeSession) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 404, { error: 'Session not found.' });
      return { failure: 'Session not found.' };
    }
    try {
      const content = request.value.content;
      const reader = new JsonRecordReader(request.parsedBody);
      const { config } = modelRequestLock.context;
      const engineRequestId = randomUUID();
      const progressWriter = new CompositeRepoSearchProgressWriter(
        new ChatStreamProgressWriter(new ChatOperationBroadcast(), null, false, requireChatRunRecorder(request)),
        new RepoSearchToolLogProgressWriter(CHAT_REPO_OPERATION_SETTINGS[this.operationKind].logPrefix, engineRequestId),
      );
      const result = await new ChatRepoOperationRunner().run(this.operationKind, buildChatRepoOperationRequest({
        ctx,
        recorder: requireChatRunRecorder(request),
        questionGate: requireQuestionGate(request),
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
          recorder: requireChatRunRecorder(request),
          sessionId: activeSession.id,
          requestId: engineRequestId,
          operationKind: this.operationKind,
          forceId: request.queueIntentId,
        }),
      }));
      sendJson(res, 200, {
        ...buildChatSessionResponse(config, runtimeRoot, result.updatedSession),
        repoSearch: result.repoSearch,
      });
      return { failure: result.failure };
    } catch (error) {
      if (requireChatRunRecorder(request).stopRequested || requireChatRunRecorder(request).sessionDeleted) throw error;
      sendJson(res, 500, { error: toError(error).message });
      return { failure: toError(error).message };
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}

export class StreamChatRepoOperationEndpoint extends ChatRepoOperationEndpoint {
  protected readonly clientOwnedOperation = true;

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage | null,
    res: ServerResponse | null,
    request: ChatSessionOperationRequest<ResolvedChatRepoRequest>,
  ): Promise<ChatOperationOutcome> {
    const runtimeRoot = getRuntimeRoot();
    const abortController = new AbortController();
    registerChatAbort(ctx, request, abortController);
    const opened = await openChatOperationStream(ctx, req, res, request, CHAT_REPO_OPERATION_SETTINGS[this.operationKind].streamLockKind);
    if ('failure' in opened) return opened;
    const { stream, modelRequestLock, activeSession } = opened;
    const engineRequestId = request.queuedMessages && request.lease ? request.lease.operationId : randomUUID();
    const progressWriter = new ChatStreamProgressWriter(stream, null, false, requireChatRunRecorder(request));
    const queueDelivery = ctx.chatMessageQueue.createDelivery({
      recorder: requireChatRunRecorder(request),
      sessionId: activeSession.id,
      requestId: engineRequestId,
      operationKind: this.operationKind,
      forceId: request.queueIntentId,
    });
    // One owner for the console: the presentation writer renders, this one logs.
    const operationProgressWriter = new CompositeRepoSearchProgressWriter(
      progressWriter,
      new RepoSearchToolLogProgressWriter(CHAT_REPO_OPERATION_SETTINGS[this.operationKind].logPrefix, engineRequestId),
    );
    try {
      const content = request.value.content;
      const reader = new JsonRecordReader(request.parsedBody);
      const { config } = modelRequestLock.context;
      const result = await new ChatRepoOperationRunner().run(this.operationKind, buildChatRepoOperationRequest({
        ctx,
        recorder: requireChatRunRecorder(request),
        questionGate: requireQuestionGate(request),
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
      return { failure: result.failure };
    } catch (error) {
      progressWriter.flushPending();
      const detail = toError(error).message;
      const stopped = abortController.signal.aborted;
      requireChatRunRecorder(request).stop(stopped ? 'user_stop' : 'execution_failure', stopped ? null : detail);
      if (!stopped) stream.fail(detail);
      return { failure: stopped ? null : detail };
    } finally {
      progressWriter.flushPending();
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}

class CondenseChatSessionEndpoint extends ChatSessionOperationEndpoint<'condense'> {
  protected readonly operationKind = 'condense' as const;

  /** Condense is a model run over the existing history; it carries no new user text of its own. */
  protected describeRun(ctx: ServerContext, session: ChatSession): ChatRunSubmission {
    // Condense summarizes under the session's own preset; it selects no task preset of its own.
    if (!session.presetId) throw new Error('Chat session presetId is required.');
    const target = previewChatOperationTarget(ctx, session.presetId);
    return {
      target,
      settings: buildChatRunSettings({
        session,
        target,
        operationKind: 'condense',
        presetId: session.presetId,
        repoRoot: session.planRepoRoot,
        approval: null,
        maxTurns: null,
        webSearchEnabled: false,
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
  ): Promise<ChatOperationOutcome> {
    // Condense now issues a real model request, so it takes the same lock and
    // readiness gate as any other turn.
    const modelRequestLock = await acquireChatModelRequest(ctx, 'dashboard_chat_condense', req, res, request);
    if ('failure' in modelRequestLock) return modelRequestLock;
    try {
      const { config } = modelRequestLock.context;
      const updatedSession = await condenseChatSession(
        requireChatRunRecorder(request),
        config,
        request.session,
        readRouteMockResponses(new JsonRecordReader(request.parsedBody), 'mockResponses'),
        createServerJsonLogger(serverLogger, 'condense', request.session.id),
      );
      sendJson(res, 200, buildChatSessionResponse(config, getRuntimeRoot(), updatedSession));
      return { failure: null };
    } catch (error) {
      if (requireChatRunRecorder(request).stopRequested || requireChatRunRecorder(request).sessionDeleted) throw error;
      sendJson(res, 500, { error: toError(error).message });
      return { failure: toError(error).message };
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
    if (!active?.recorder || active.recorder.sessionDeleted || active.operationId !== parsed.data.operationId) {
      sendJson(res, 409, { error: 'No matching stoppable operation is active for this session.' });
      return;
    }
    const completionPromise = ctx.chatSessionOperations.waitForCompletion(active);
    active.stopRequested = true;
    active.recorder.requestUserStop();
    ctx.chatMessageQueue.store.setPaused(sessionId, true);
    const force = ctx.chatMessageQueue.store.state(sessionId).force;
    if (force?.operationId === active.operationId) {
      ctx.chatMessageQueue.store.updateForce(sessionId, force.id, { phase: 'failed', failureDetail: 'Continuation cancelled by Stop.' });
      ctx.chatMessageQueue.store.clearForce(sessionId, force.id);
    }
    ctx.chatMessageQueue.publish(sessionId);
    active.abort?.();
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
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan$/u, endpoint: new CreateChatRepoOperationEndpoint('plan') },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/plan\/stream$/u, endpoint: new StreamChatRepoOperationEndpoint('plan') },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-search$/u, endpoint: new CreateChatRepoOperationEndpoint('repo-search') },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-search\/stream$/u, endpoint: new StreamChatRepoOperationEndpoint('repo-search') },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/stream$/u, endpoint: new StreamChatRepoAgentEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/decide$/u, endpoint: new ChatRepoAgentDecideEndpoint() },
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/question$/u, endpoint: new ChatQuestionAnswerEndpoint() },
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
