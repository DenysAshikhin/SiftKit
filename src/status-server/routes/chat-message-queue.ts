import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ChatQueueEnqueueRequestSchema, ChatQueueEditRequestSchema, ChatQueuedMessageIdSchema, ChatMessageQueueResponseSchema, ChatQueueMessageResponseSchema, ChatQueueForceRequestSchema, ChatQueueForceResponseSchema } from '@siftkit/contracts';
import { toError } from '../../lib/errors.js';
import { getChatSessionPath, readChatSessionFromPath } from '../../state/chat-sessions.js';
import { getRuntimeRoot } from '../paths.js';
import { parseJsonBody, readBody, sendBodyReadError, sendJson } from '../http-utils.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import type { ServerContext } from '../server-types.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { ChatOperationSubscriber } from '../chat-operation-broadcast.js';
import { admitSelectedChatImages } from './chat.js';
import { readConfig } from '../config-store.js';
import { z } from '../../lib/zod.js';

function readQueueSessionId(match: RouteMatch, res: ServerResponse): string | null {
  try {
    return z.string().trim().min(1).parse(decodeURIComponent(z.string().min(1).parse(match.captures[0])));
  } catch {
    sendJson(res, 400, { error: 'Expected a valid session identity.' });
    return null;
  }
}

export class ChatMessageQueueEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): Promise<void> {
    const sessionId = readQueueSessionId(match, res);
    if (sessionId === null) return;
    const session = readChatSessionFromPath(getChatSessionPath(getRuntimeRoot(), sessionId));
    if (!session) { sendJson(res, 404, { error: 'Session not found.' }); return; }
    const owner = ctx.chatMessageQueue;
    const rawId = match.captures[1];
    const parsedId = ChatQueuedMessageIdSchema.safeParse(rawId === undefined ? undefined : decodeURIComponent(rawId));
    if (req.method === 'GET') {
      if (rawId !== undefined) {
        if (!parsedId.success) { sendJson(res, 400, { error: 'Expected message UUID.' }); return; }
        const message = owner.store.get(sessionId, parsedId.data);
        if (!message) { sendJson(res, 404, { error: 'Queued message not found.' }); return; }
        if (message.state !== 'pending') { sendJson(res, 409, { error: 'not_pending', queue: owner.state(sessionId) }); return; }
        sendJson(res, 200, ChatQueueMessageResponseSchema.parse({ message: { id: message.id, content: message.content, revision: message.revision, imageCount: message.images.length } }));
        return;
      }
      sendJson(res, 200, ChatMessageQueueResponseSchema.parse({ queue: owner.state(sessionId) }));
      return;
    }
    if (req.method !== 'POST' && !parsedId.success) { sendJson(res, 400, { error: 'Expected message UUID.' }); return; }
    let kind: string;
    let afterOperationId: string | undefined;
    if (req.method === 'DELETE' && parsedId.success) {
      kind = owner.store.remove(sessionId, parsedId.data).kind;
    } else {
      let body;
      try { body = parseJsonBody(await readBody(req)); }
      catch (error) { sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' }); return; }
      if (req.method === 'POST') {
        const parsed = ChatQueueEnqueueRequestSchema.safeParse(body);
        if (!parsed.success) { sendJson(res, 400, { error: parsed.error.message }); return; }
        const active = ctx.chatSessionOperations.getActiveOperation(sessionId);
        const pendingMode = owner.store.listPending(sessionId)[0]?.options.operationKind;
        if ((active && active.operationKind !== parsed.data.options.operationKind)
          || (pendingMode && pendingMode !== parsed.data.options.operationKind)) {
          sendJson(res, 409, { error: 'Queued messages must use the current operation mode.', queue: owner.state(sessionId) });
          return;
        }
        let images;
        try { images = admitSelectedChatImages(readConfig(ctx.configPath), session, parsed.data.images).images; }
        catch (error) { sendJson(res, 400, { error: toError(error).message }); return; }
        kind = owner.store.enqueue(sessionId, { ...parsed.data, images }).kind;
        afterOperationId = parsed.data.afterOperationId;
      } else {
        const parsed = ChatQueueEditRequestSchema.safeParse(body);
        if (!parsed.success || !parsedId.success) { sendJson(res, 400, { error: 'Expected content and revision.' }); return; }
        kind = owner.store.edit(sessionId, parsedId.data, parsed.data.content, parsed.data.revision).kind;
      }
    }
    const ok = ['enqueued', 'duplicate', 'already_persisted', 'applied'].includes(kind);
    if (ok) owner.publish(sessionId);
    if (kind === 'enqueued' && afterOperationId && !ctx.chatSessionOperations.getActive(sessionId)) {
      if (ctx.chatSessionOperations.getCompletion(sessionId, afterOperationId)?.kind === 'completed') await ctx.chatQueueSuccessor?.startPending(sessionId);
      else owner.store.setPaused(sessionId, true);
      owner.publish(sessionId);
    }
    const queue = owner.state(sessionId);
    sendJson(res, ok ? 200 : kind === 'not_found' ? 404 : 409, ok ? { queue } : { error: kind, queue });
  }
}

export class ChatMessageQueueStreamEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): void {
    const sessionId = readQueueSessionId(match, res);
    if (sessionId === null) return;
    if (!readChatSessionFromPath(getChatSessionPath(getRuntimeRoot(), sessionId))) { sendJson(res, 404, { error: 'Session not found.' }); return; }
    const writer = new SseResponseWriter(req, res);
    writer.open();
    const subscriber: ChatOperationSubscriber = {
      onFrame(frame) { writer.writeSerializedEvent(frame.event, frame.data); },
      onClosed() { writer.end(); },
    };
    ctx.chatMessageQueue.attach(sessionId, subscriber);
    res.on('close', () => ctx.chatMessageQueue.detach(sessionId, subscriber));
  }
}

export class ChatMessageQueueForceEndpoint implements RouteEndpoint {
  async handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): Promise<void> {
    const sessionId = readQueueSessionId(match, res);
    if (sessionId === null) return;
    if (!readChatSessionFromPath(getChatSessionPath(getRuntimeRoot(), sessionId))) {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    let body;
    try { body = parseJsonBody(await readBody(req)); }
    catch (error) { sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' }); return; }
    const parsed = ChatQueueForceRequestSchema.safeParse(body);
    if (!parsed.success) { sendJson(res, 400, { error: parsed.error.message }); return; }
    const receipt = ctx.chatMessageQueue.store.readForceReceipt(sessionId, parsed.data.id);
    if (receipt) {
      if (receipt.operationId !== parsed.data.operationId || receipt.phase === 'failed') {
        sendJson(res, 409, { error: receipt.failureDetail ?? 'Force idempotency conflict.', queue: ctx.chatMessageQueue.state(sessionId) });
      } else sendJson(res, 200, ChatQueueForceResponseSchema.parse({ ok: true, successorOperationId: receipt.successorOperationId, queue: ctx.chatMessageQueue.state(sessionId) }));
      return;
    }
    const active = ctx.chatSessionOperations.getActiveOperation(sessionId);
    if (parsed.data.operationId !== null
      && (active ? active.operationId !== parsed.data.operationId || !active.abort
        : ctx.chatSessionOperations.getCompletion(sessionId, parsed.data.operationId)?.kind !== 'completed')) {
      sendJson(res, 409, { error: 'No matching active operation for Force now.', queue: ctx.chatMessageQueue.state(sessionId) });
      return;
    }
    if (parsed.data.operationId === null && active !== null) {
      sendJson(res, 409, { error: 'An active operation must be named for Force now.', queue: ctx.chatMessageQueue.state(sessionId) });
      return;
    }
    const successorOperationId = randomUUID();
    const started = ctx.chatMessageQueue.store.beginForce(sessionId, parsed.data, successorOperationId);
    if (started.kind === 'empty') {
      sendJson(res, 409, { error: 'No pending messages to force.', queue: ctx.chatMessageQueue.state(sessionId) });
      return;
    }
    if (started.kind === 'missing_session') {
      sendJson(res, 404, { error: 'Session not found.' });
      return;
    }
    if (started.kind === 'conflict' || (started.kind === 'duplicate' && started.force.phase === 'failed')) {
      sendJson(res, 409, { error: started.kind === 'duplicate' ? 'Force now previously failed.' : 'Force now is already active.', queue: ctx.chatMessageQueue.state(sessionId) });
      return;
    }
    ctx.chatMessageQueue.publish(sessionId);
    if (started.kind === 'duplicate') {
      sendJson(res, 200, ChatQueueForceResponseSchema.parse({
        ok: true,
        successorOperationId: started.force.successorOperationId,
        queue: ctx.chatMessageQueue.state(sessionId),
      }));
      return;
    }
    if (active) {
      if (!active.abort) {
        sendJson(res, 409, { error: 'Active operation cannot be stopped.', queue: ctx.chatMessageQueue.state(sessionId) });
        return;
      }
      const completionPromise = ctx.chatSessionOperations.waitForCompletion(active);
      active.abort();
      const completion = await completionPromise;
      const currentForce = ctx.chatMessageQueue.store.state(sessionId).force;
      if (!currentForce || currentForce.id !== started.force.id) {
        sendJson(res, 409, { error: 'Force now was cancelled while the operation stopped.', queue: ctx.chatMessageQueue.state(sessionId) });
        return;
      }
      if (completion.kind === 'failed') {
        ctx.chatMessageQueue.store.failForce(sessionId, started.force, completion.error);
        ctx.chatMessageQueue.publish(sessionId);
        sendJson(res, 500, { error: completion.error, queue: ctx.chatMessageQueue.state(sessionId) });
        return;
      }
    }
    const successor = ctx.chatQueueSuccessor;
    if (!successor) {
      const error = 'Force successor runner is unavailable.';
      ctx.chatMessageQueue.store.failForce(sessionId, started.force, error);
      ctx.chatMessageQueue.publish(sessionId);
      sendJson(res, 503, { error, queue: ctx.chatMessageQueue.state(sessionId) });
      return;
    }
    ctx.chatMessageQueue.store.updateForce(sessionId, started.force.id, { phase: 'sending', failureDetail: null });
    ctx.chatMessageQueue.publish(sessionId);
    try {
      await successor.start(sessionId, started.force);
    } catch (error) {
      const message = toError(error).message;
      ctx.chatMessageQueue.store.failForce(sessionId, started.force, message);
      ctx.chatMessageQueue.publish(sessionId);
      sendJson(res, 500, { error: message, queue: ctx.chatMessageQueue.state(sessionId) });
      return;
    }
    sendJson(res, 200, ChatQueueForceResponseSchema.parse({
      ok: true,
      successorOperationId: started.force.successorOperationId,
      queue: ctx.chatMessageQueue.state(sessionId),
    }));
  }
}
