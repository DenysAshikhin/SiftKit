import type { IncomingMessage, ServerResponse } from 'node:http';

import { ActiveChatOperationsResponseSchema } from '@siftkit/contracts';

import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
import { sendJson } from '../http-utils.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { ServerContext } from '../server-types.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';
import { ChatJournalStore } from '../../state/chat-journal.js';
import { getRuntimeDatabase, getRuntimeDatabasePath } from '../../state/runtime-db.js';

export class GetChatOperationStreamEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): void {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const lease = ctx.chatSessionOperations.getActive(sessionId);
    const broadcast = ctx.chatSessionOperations.getBroadcast(sessionId);
    const databasePath = getRuntimeDatabasePath();
    const operationId = lease?.recorder?.operationId ?? new ChatJournalStore(getRuntimeDatabase(databasePath))
      .listSessionRuns(sessionId).filter(run => run.recordKind === 'execution').at(-1)?.operationId;
    if (lease && !lease.recorder) {
      sendJson(res, 409, { error: 'Chat admission is still preparing its durable record.' });
      return;
    }
    if (!operationId) {
      sendJson(res, 404, { error: 'No recorded operation for this session.' });
      return;
    }
    const writer = new SseResponseWriter(req, res);
    writer.open();
    const subscriber = new ChatOperationSseSubscriber(writer, { ctx, sessionId, operationId, databasePath });
    if (broadcast) broadcast.attach(subscriber);
    else subscriber.onClosed();
    subscriber.start();
    res.on('close', () => broadcast?.detach(subscriber));
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
