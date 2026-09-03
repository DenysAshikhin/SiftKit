import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { ChatOperationIdSchema, type ChatSessionOperationKind } from '@siftkit/contracts';

import { toError } from '../../lib/errors.js';
import type { JsonObject } from '../../lib/json-types.js';
import type { ChatSession } from '../../state/chat-sessions.js';
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
import { serverLogger } from '../server-logger.js';
import type { ServerContext } from '../server-types.js';
import { type RouteEndpoint, type RouteMatch } from '../route-table.js';

export type ResolvedChatRepoRequest = {
  content: string;
  images: string[];
  repoRoot: string;
};

export type ChatSessionOperationRequest<TParsed> = {
  sessionId: string;
  sessionPath: string;
  session: ChatSession;
  parsedBody: JsonObject;
  value: TParsed;
  lease: ChatSessionOperation | null;
};

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

/** Falls back to the session's saved root, then to the process root, exactly as the endpoints did. */
function resolveChatRepoRoot(requestedRepoRoot: string | undefined, session: ChatSession): string {
  const sessionRepoRoot = typeof session.planRepoRoot === 'string' && session.planRepoRoot.trim()
    ? session.planRepoRoot.trim()
    : process.cwd();
  return resolve(requestedRepoRoot || sessionRepoRoot);
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

  /** Returns null after sending its own 4xx response. */
  protected abstract parseRequest(
    res: ServerResponse,
    session: ChatSession,
    parsedBody: JsonObject,
  ): TParsed | null;

  protected abstract run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<TParsed>,
  ): Promise<void>;

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
    try {
      await this.run(ctx, req, res, {
        sessionId,
        sessionPath,
        session,
        parsedBody,
        value,
        lease,
      });
      if (lease && !ctx.chatSessionOperations.finish(lease, { kind: 'completed' })) {
        throw new Error(`Failed to finish chat session operation ${lease.sessionId}.`);
      }
    } catch (error) {
      if (lease) {
        ctx.chatSessionOperations.finish(lease, { kind: 'failed', error: toError(error).message });
      }
      throw error;
    }
  }
}
