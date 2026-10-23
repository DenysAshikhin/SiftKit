import type { IncomingMessage, ServerResponse } from 'node:http';

import { ActiveChatOperationsResponseSchema } from '@siftkit/contracts';

import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.ts';
import { sendJson } from '../http-utils.ts';
import { SseResponseWriter } from '../sse-response-writer.ts';
import type { ServerContext } from '../server-types.ts';
import type { RouteEndpoint, RouteMatch } from '../route-table.ts';
import { ChatJournalStore } from '../../state/chat-journal.ts';
import { listActiveChatSessionOrchestratorRuns } from '../../state/chat-sessions.ts';
import { closeOrphanedChatRun } from '../chat-run-recovery.ts';

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
  // so close it under this owner now and let the subscriber transfer its terminal record. Why the
  // run was abandoned is not knowable here, so the closure only says no owner is left to finish it.
  if (!broadcast && run.terminalCause === null) {
    closeOrphanedChatRun(ctx.runtimeDatabase, { operationId: runOperationId, sessionId }, ctx.chatRunOwnerEpoch, 'abandoned');
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
    // A session whose board shows a run that has not settled is doing work, exactly as a session with
    // a live chat operation is; the run's own ID is what the session reports busy with.
    const orchestratorWork = listActiveChatSessionOrchestratorRuns(ctx.runtimeDatabase).map((activity) => ({
      sessionId: activity.sessionId,
      operationKind: 'orchestrator' as const,
      operationId: activity.runId,
      startedAtUtc: activity.startedAtUtc,
    }));
    sendJson(res, 200, ActiveChatOperationsResponseSchema.parse({
      operations: [
        ...ctx.chatSessionOperations.listActive().map((lease) => ({
          sessionId: lease.sessionId,
          operationKind: lease.operationKind,
          operationId: lease.operationId,
          startedAtUtc: new Date(lease.startedAtMs).toISOString(),
        })),
        ...orchestratorWork,
      ],
    }));
  }
}
