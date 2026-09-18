import type { IncomingMessage, ServerResponse } from 'node:http';

import { ActiveChatOperationsResponseSchema } from '@siftkit/contracts';

import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
import { sendJson } from '../http-utils.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { ServerContext } from '../server-types.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import { ChatJournalStore } from '../../state/chat-journal.js';
import { closeOrphanedChatRun } from '../chat-run-recovery.js';

export function streamRecordedChatOperation(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  runOperationId: string,
): void {
  const run = new ChatJournalStore(ctx.runtimeDatabase).readRun(runOperationId);
  if (!run || run.sessionId !== sessionId || run.recordKind !== 'execution') {
    sendJson(res, 500, { error: 'Chat submission receipt references an invalid run.' });
    return;
  }
  const lease = ctx.chatSessionOperations.getActive(sessionId);
  const broadcast = lease?.recorder?.operationId === runOperationId
    ? ctx.chatSessionOperations.getBroadcast(sessionId)
    : null;
  // No live lease holds this run and its journal never finished: nothing will ever finish it,
  // so close it under this owner now and let the subscriber transfer its terminal record.
  if (!broadcast && run.terminalCause === null) {
    closeOrphanedChatRun(ctx.runtimeDatabase, new ChatJournalStore(ctx.runtimeDatabase),
      { operationId: runOperationId, sessionId }, ctx.chatRunOwnerEpoch, 'lease_lost');
  }
  const writer = new SseResponseWriter(req, res);
  writer.open();
  const subscriber = new ChatOperationSseSubscriber(writer, {
    ctx, sessionId, operationId: runOperationId, database: ctx.runtimeDatabase,
  });
  if (broadcast) broadcast.attach(subscriber);
  else subscriber.onClosed({ failure: null });
  subscriber.start();
  res.on('close', () => broadcast?.detach(subscriber));
}

export class GetChatOperationStreamEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): void {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const lease = ctx.chatSessionOperations.getActive(sessionId);
    const operationId = lease?.recorder?.operationId ?? new ChatJournalStore(ctx.runtimeDatabase)
      .listSessionRuns(sessionId).filter(run => run.recordKind === 'execution').at(-1)?.operationId;
    if (lease && !lease.recorder) {
      sendJson(res, 409, { error: 'Chat admission is still preparing its durable record.' });
      return;
    }
    if (!operationId) {
      sendJson(res, 404, { error: 'No recorded operation for this session.' });
      return;
    }
    streamRecordedChatOperation(ctx, req, res, sessionId, operationId);
  }
}

export class GetActiveChatOperationsEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, _req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, ActiveChatOperationsResponseSchema.parse({
      operations: ctx.chatSessionOperations.listActive().map((lease) => ({
        sessionId: lease.sessionId,
        operationKind: lease.operationKind,
        operationId: lease.operationId,
        startedAtUtc: new Date(lease.startedAtMs).toISOString(),
      })),
    }));
  }
}
