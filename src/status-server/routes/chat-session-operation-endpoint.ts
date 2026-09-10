import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import {
  ChatOperationIdSchema,
  ChatQueueOperationKindSchema,
  type ChatRunEffectiveSettings,
  type ChatSessionOperationKind,
} from '@siftkit/contracts';

import { toError } from '../../lib/errors.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { ChatSession } from '../../state/chat-sessions.js';
import type { ChatQueuedMessage } from '../../state/chat-message-queue.js';
import { getRuntimeRoot } from '../paths.js';
import {
  getChatSessionPath,
  readChatSessionFromPath,
} from '../../state/chat-sessions.js';
import {
  parseChatMessageRequest,
  parseChatRepoRequest,
  type ChatMessageRequest,
} from '../chat-route-request-normalizers.js';
import type { ChatSessionOperation } from '../chat-session-operation-registry.js';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.js';
import { ChatRunRecorder } from '../chat-run-recorder.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../../state/runtime-db.js';
import { importChatSessionBaseline } from '../chat-history-import.js';
import { readConfig } from '../config-store.js';
import type { SiftConfig } from '../../config/types.js';
import { admitImagesForPreset } from '../../llm-protocol/preset-image-admission.js';
import { serverLogger } from '../server-logger.js';
import type { ServerContext } from '../server-types.js';
import { type RouteEndpoint, type RouteMatch } from '../route-table.js';

export type ResolvedChatRepoRequest = {
  content: string;
  images: string[];
  repoRoot: string;
};

/**
 * What a run commits about itself before it is allowed to publish or dispatch anything. An
 * operation that only edits history returns null: it is a revision, not a model run.
 */
export type ChatRunSubmission = {
  settings: ChatRunEffectiveSettings;
  content: string;
  images: string[];
};

export type ChatSessionOperationRequest<TParsed> = {
  queuedMessages?: ChatQueuedMessage[];
  queueIntentId?: string;
  sessionId: string;
  sessionPath: string;
  session: ChatSession;
  parsedBody: JsonObject;
  value: TParsed;
  lease: ChatSessionOperation | null;
  /** The run's durable writer, present whenever `describeRun` claimed this is a model run. */
  recorder: ChatRunRecorder | null;
};

export function requireChatRunRecorder(request: { recorder: ChatRunRecorder | null }): ChatRunRecorder {
  if (request.recorder === null) throw new Error('Web model operation has no admitted chat recorder.');
  return request.recorder;
}

function readChatSessionIdFromMatch(routeMatch: RouteMatch): string {
  const [rawSessionId] = routeMatch.captures;
  if (!rawSessionId) {
    throw new Error(`Chat route ${routeMatch.pathname} did not capture a session id.`);
  }
  return decodeURIComponent(rawSessionId);
}

function rejectBusyChatSession(
  ctx: ServerContext,
  res: ServerResponse,
  sessionId: string,
  requestedOperationKind: ChatSessionOperationKind,
  active: ChatSessionOperation,
): void {
  serverLogger.dim({
    scope: 'chat',
    id: sessionId,
    event: 'session_busy_rejected',
    fields: `requested=${requestedOperationKind} active=${active.operationKind} `
      + `active_duration_ms=${Date.now() - active.startedAtMs} active_sessions=${ctx.chatSessionOperations.getActiveCount()}`,
  });
  sendJson(res, 409, {
    error: 'Chat session already has an active operation.',
    sessionId,
    operationKind: active.operationKind,
  });
}

/** Sends a 400 and returns null when the body is not a valid chat message request. */
export function parseChatMessageOperationRequest(
  res: ServerResponse,
  parsedBody: JsonObject,
): ChatMessageRequest | null {
  const messageRequest = parseChatMessageRequest(parsedBody);
  if (!messageRequest) {
    sendJson(res, 400, { error: 'Expected content.' });
    return null;
  }
  return messageRequest;
}

/** Falls back to the session's saved root, exactly as the endpoints did. */
function resolveChatRepoRoot(requestedRepoRoot: string | undefined, session: ChatSession): string {
  return resolve(requestedRepoRoot || session.planRepoRoot);
}

/** Sends a 400 and returns null when the body is not a valid repo operation request. */
export function parseChatRepoOperationRequest(
  res: ServerResponse,
  session: ChatSession,
  parsedBody: JsonObject,
): ResolvedChatRepoRequest | null {
  const repoRequest = parseChatRepoRequest(parsedBody);
  if (!repoRequest) {
    sendJson(res, 400, { error: 'Expected content.' });
    return null;
  }
  const repoRoot = resolveChatRepoRoot(repoRequest.repoRoot, session);
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    sendJson(res, 400, { error: 'Expected existing repoRoot directory.' });
    return null;
  }
  return { content: repoRequest.content, images: repoRequest.images, repoRoot };
}

/**
 * Owns session lookup, body parsing, and the per-session operation lease so no chat
 * endpoint can run concurrently with another operation on the same session.
 */
export abstract class ChatSessionOperationEndpoint<TParsed> implements RouteEndpoint {
  protected abstract readonly operationKind: ChatSessionOperationKind;
  protected readonly useSessionOperationLease: boolean = true;
  protected readonly clientOwnedOperation: boolean = false;

  /**
   * What this operation records as a run, or null when it is not one. Every endpoint answers
   * explicitly: a Web run that silently skipped its recorder would not be recoverable.
   */
  protected abstract describeRun(
    session: ChatSession,
    value: TParsed,
    config: SiftConfig,
  ): ChatRunSubmission | null;

  /** Returns null after sending its own 4xx response. */
  protected abstract parseRequest(
    res: ServerResponse,
    session: ChatSession,
    parsedBody: JsonObject,
  ): TParsed | null;

  protected abstract run(
    ctx: ServerContext,
    req: IncomingMessage | null,
    res: ServerResponse | null,
    request: ChatSessionOperationRequest<TParsed>,
  ): Promise<void>;

  /** A successor opens its own run record: it is a separate operation, not a continuation. */
  async executeDetached(
    ctx: ServerContext,
    request: Omit<ChatSessionOperationRequest<TParsed>, 'recorder'>,
  ): Promise<void> {
    if (!this.clientOwnedOperation || !request.lease) throw new Error('This operation cannot execute detached.');
    const recorder = this.beginRun(ctx, request.sessionId, request.session, request.value, request.queuedMessages?.[0]?.id);
    await this.runRecorded(ctx, null, null, { ...request, recorder });
  }

  /**
   * Opens the run's journal record before the body can publish a frame or dispatch a model, and
   * closes it with whatever outcome the body reached. A run that cannot be recorded never starts.
   */
  private async runRecorded(
    ctx: ServerContext,
    req: IncomingMessage | null,
    res: ServerResponse | null,
    request: ChatSessionOperationRequest<TParsed>,
  ): Promise<void> {
    const recorder = request.recorder;
    if (recorder === null) {
      await this.run(ctx, req, res, request);
      return;
    }
    try {
      await this.run(ctx, req, res, request);
    } catch (error) {
      if (recorder.terminalCause === null) recorder.finish({
        terminalCause: 'execution_failure',
        detail: toError(error).message,
        usage: null,
        recoveryStatus: 'recovery_needed',
      });
      throw error;
    }
    if (recorder.terminalCause !== null) return;
    const failure = request.lease?.failure ?? ctx.chatSessionOperations.getBroadcast(request.sessionId)?.failure
      ?? (res && res.statusCode >= 400 ? `Chat operation returned HTTP ${res.statusCode}.` : null);
    recorder.finish({
      terminalCause: request.lease?.stopRequested ? 'user_stop' : failure ? 'execution_failure' : 'completed',
      detail: failure,
      usage: null,
      recoveryStatus: failure ? 'recovery_needed' : 'ok',
    });
  }

  /**
   * Begins the run record, or returns null when this operation is not a model run. The run's id is
   * minted here: a client's operation id is a reusable lease handle, not a durable run identity.
   */
  private beginRun(
    ctx: ServerContext,
    sessionId: string,
    session: ChatSession,
    value: TParsed,
    userMessageId: string = randomUUID(),
  ): ChatRunRecorder | null {
    const config = readConfig(ctx.configPath);
    ctx.chatRuntimeOwner.assertOwned();
    const submission = this.describeRun(session, value, config);
    if (submission === null) return null;
    importChatSessionBaseline(getRuntimeDatabase(getRuntimeDatabasePath()), session, config);
    const admittedImages = admitImagesForPreset(session.modelPreset, submission.images);
    return ChatRunRecorder.begin(getRuntimeDatabasePath(), {
      operationId: randomUUID(),
      sessionId,
      ownerEpoch: ctx.chatRunOwnerEpoch,
      operationKind: this.operationKind,
      userMessageId,
      content: submission.content,
      images: admittedImages.map(image => image.dataUrl),
      imageMeta: admittedImages.map(image => image.metadata),
      settings: submission.settings,
      retainedHistoryRevision: 0,
      startedAtUtc: new Date().toISOString(),
    });
  }

  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    routeMatch: RouteMatch,
  ): Promise<void> {
    const sessionId = readChatSessionIdFromMatch(routeMatch);
    const sessionPath = getChatSessionPath(getRuntimeRoot(), sessionId);
    const session = readChatSessionFromPath(sessionPath);
    if (!session) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const value = this.parseRequest(res, session, parsedBody);
    if (value === null) {
      return;
    }
    const operationId = this.clientOwnedOperation
      ? ChatOperationIdSchema.safeParse(parsedBody.operationId)
      : null;
    if (operationId && !operationId.success) {
      sendJson(res, 400, { error: 'operationId must be a UUID.' });
      return;
    }
    if (this.useSessionOperationLease && ChatQueueOperationKindSchema.safeParse(this.operationKind).success
      && !ctx.chatSessionOperations.getActive(sessionId)
      && ctx.chatMessageQueue.store.state(sessionId).messages.some((message) => message.state === 'pending')) {
      sendJson(res, 409, { error: 'Pending messages must be sent first with Force now.', queue: ctx.chatMessageQueue.state(sessionId) });
      return;
    }
    const acquisition = this.useSessionOperationLease
      ? ctx.chatSessionOperations.acquire(
          sessionId,
          this.operationKind,
          operationId?.data ?? randomUUID(),
          Date.now(),
        )
      : null;
    if (acquisition?.kind === 'conflict') {
      rejectBusyChatSession(ctx, res, sessionId, this.operationKind, acquisition.active);
      return;
    }
    const lease = acquisition?.kind === 'acquired' ? acquisition.lease : null;
    if (lease) ctx.chatMessageQueue.publish(sessionId);
    try {
      const recorder = this.beginRun(ctx, sessionId, session, value);
      await this.runRecorded(ctx, req, res, {
        sessionId,
        sessionPath,
        session,
        parsedBody,
        value,
        lease,
        recorder,
      });
      if (lease && res.statusCode >= 400) lease.failure ??= `Chat operation returned HTTP ${res.statusCode}.`;
      if (lease && !ctx.chatSessionOperations.finish(lease, { kind: 'completed' })) {
        throw new Error(`Failed to finish chat session operation ${lease.sessionId}.`);
      }
      if (lease) {
        if (ctx.chatSessionOperations.getCompletion(sessionId, lease.operationId)?.kind === 'completed') await ctx.chatQueueSuccessor?.startPending(sessionId);
        else ctx.chatMessageQueue.store.setPaused(sessionId, true);
        ctx.chatMessageQueue.publish(sessionId);
      }
    } catch (error) {
      if (lease) {
        ctx.chatSessionOperations.finish(lease, { kind: 'failed', error: toError(error).message });
        ctx.chatMessageQueue.store.setPaused(sessionId, true);
        ctx.chatMessageQueue.publish(sessionId);
      }
      throw error;
    }
  }
}
