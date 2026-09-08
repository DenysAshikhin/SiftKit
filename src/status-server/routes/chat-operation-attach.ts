import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ActiveChatOperationsResponseSchema,
  ChatOperationAttachedEventSchema,
  ChatStreamApprovalStateSchema,
  type ChatStreamApproval,
} from '@siftkit/contracts';

import type { JsonSerializable } from '../../lib/json-types.js';
import type { ChatOperationFrame, ChatOperationReplay } from '../chat-operation-broadcast.js';
import { ChatOperationSseSubscriber } from '../chat-operation-sse-subscriber.js';
import type { ChatSessionOperation } from '../chat-session-operation-registry.js';
import { sendJson } from '../http-utils.js';
import { SseResponseWriter } from '../sse-response-writer.js';
import type { ServerContext } from '../server-types.js';
import type { RouteEndpoint, RouteMatch } from '../route-table.js';

/** Approval history is replaced by live state on attach, so a decided card is never resurrected. */
const REPLAY_SUPPRESSED_EVENTS = new Set(['approval', 'approval_resolved']);

function toFrame(event: string, payload: JsonSerializable): ChatOperationFrame {
  return { event, data: JSON.stringify(payload) };
}

/**
 * Builds everything an attaching reader receives before it starts following live frames: which run
 * it latched onto, the retained transcript, and the current approval state.
 */
export function buildChatOperationAttachFrames(
  lease: ChatSessionOperation,
  replay: ChatOperationReplay,
  approval: ChatStreamApproval | null,
): ChatOperationFrame[] {
  return [
    toFrame('attached', ChatOperationAttachedEventSchema.parse({
      operationKind: lease.operationKind,
      operationId: lease.operationId,
      startedAtUtc: new Date(lease.startedAtMs).toISOString(),
      replayTruncated: replay.truncated,
    })),
    ...replay.frames.filter((frame) => !REPLAY_SUPPRESSED_EVENTS.has(frame.event)),
    toFrame('approval_state', ChatStreamApprovalStateSchema.parse({ approval })),
  ];
}

/** Reads the live pending approval for a session, or null when nothing is parked. */
export function readPendingChatApproval(
  ctx: ServerContext,
  sessionId: string,
): ChatStreamApproval | null {
  const binding = ctx.chatRepoAgentRuns.get(sessionId);
  const session = binding ? ctx.repoAgentSessions.get(binding.runId) : undefined;
  if (!binding || !session) {
    return null;
  }
  const state = session.getState();
  if (state.status !== 'approval_required') {
    return null;
  }
  return {
    runId: binding.runId,
    approvalId: state.approval.approvalId,
    toolName: state.approval.toolName,
    command: state.approval.command,
    reviewPayload: state.approval.reviewPayload ?? null,
  };
}

export class GetChatOperationStreamEndpoint implements RouteEndpoint {
  handle(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, match: RouteMatch): void {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    const lease = ctx.chatSessionOperations.getActive(sessionId);
    const broadcast = ctx.chatSessionOperations.getBroadcast(sessionId);
    if (!lease || !broadcast) {
      sendJson(res, 404, { error: 'No active operation for this session.' });
      return;
    }
    const writer = new SseResponseWriter(req, res);
    writer.open();
    const subscriber = new ChatOperationSseSubscriber(writer);
    // attach() snapshots and subscribes in one synchronous step, so a frame written while the
    // preamble is being sent queues behind it instead of being lost between the two.
    const replay = broadcast.attach(subscriber);
    const preamble = buildChatOperationAttachFrames(
      lease,
      replay,
      readPendingChatApproval(ctx, sessionId),
    );
    for (const frame of preamble) {
      writer.writeSerializedEvent(frame.event, frame.data);
    }
    res.on('close', () => broadcast.detach(subscriber));
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
