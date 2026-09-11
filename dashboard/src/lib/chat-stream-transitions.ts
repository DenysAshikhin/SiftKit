import { getErrorMessage } from '../../../src/lib/errors.js';
import { ChatOperationIdleError, ChatSessionBusyError } from '../api';
import type { ChatSessionRuntimeTransition } from './chat-session-runtime-store';
import type { ChatStreamEvent } from './chat-stream-parser';
import type { ChatSessionOperationKind } from '../types';
import { ChatOperationProjection } from './chat-operation-projection';

/** How this stream came to be: a turn this client started, or a run it latched onto. */
export type ChatStreamStart =
  | { kind: 'owned'; operationKind: ChatSessionOperationKind; operationId: string }
  | { kind: 'attached' };

/**
 * Turns one chat stream into the runtime transitions it implies. Yields data only, so the
 * caller owns how state is published and two streams can be drained concurrently.
 */
export async function* toRuntimeTransitions(
  sessionId: string,
  start: ChatStreamStart,
  stream: AsyncGenerator<ChatStreamEvent>,
  thinkingEnabled: boolean,
): AsyncGenerator<ChatSessionRuntimeTransition> {
  if (start.kind === 'owned') {
    yield { kind: 'begin', sessionId, operationKind: start.operationKind, operationId: start.operationId };
  }
  let settled = false;
  const projection = new ChatOperationProjection(sessionId);
  try {
    for await (const event of stream) {
      if (event.kind === 'queue') {
        if (event.queue.sessionId !== sessionId) throw new Error('Queue stream session mismatch.');
        yield { kind: 'queue', sessionId, queue: event.queue };
        continue;
      }
      const delivery = projection.acceptFrame(event.frame);
      if (delivery === null) continue;
      if (delivery.kind === 'view') {
        const snapshot = delivery.snapshot;
        yield { kind: 'snapshot', sessionId, snapshot: thinkingEnabled ? snapshot
          : { ...snapshot, messages: snapshot.messages.filter(message => message.kind !== 'assistant_thinking') } };
        if (delivery.queue) yield { kind: 'queue', sessionId, queue: delivery.queue };
      } else if (delivery.kind === 'terminal') {
        yield { kind: 'terminal', sessionId, terminal: delivery.terminal };
        settled = true;
      } else {
        yield { kind: 'failure', sessionId, message: delivery.failure.error, ...(delivery.failure.issue ? { issue: delivery.failure.issue } : {}) };
        return;
      }
    }
    if (!settled) throw new Error('Chat stream ended before its terminal record');
  } catch (error) {
    // Idleness is not a failure: the caller falls back to the stored session.
    if (error instanceof ChatOperationIdleError) {
      throw error;
    }
    if (error instanceof ChatSessionBusyError) {
      yield {
        kind: 'remote-begin',
        sessionId,
        operationKind: error.response.operationKind,
      };
      yield { kind: 'control-error', sessionId, message: getErrorMessage(error) };
      return;
    }
    yield {
      kind: 'failure',
      sessionId,
      message: getErrorMessage(error),
    };
  }
}
