import { getErrorMessage } from '../../../src/lib/errors.js';
import { ChatSessionBusyError } from '../api';
import type { ChatSessionRuntimeTransition } from './chat-session-runtime-store';
import type { ChatStreamEvent } from './chat-stream-parser';
import type { ChatSessionOperationKind } from '../types';

/**
 * Turns one chat stream into the runtime transitions it implies. Yields data only, so the
 * caller owns how state is published and two streams can be drained concurrently.
 */
export async function* toRuntimeTransitions(
  sessionId: string,
  operationKind: ChatSessionOperationKind,
  operationId: string,
  stream: AsyncGenerator<ChatStreamEvent>,
  thinkingEnabled: boolean,
): AsyncGenerator<ChatSessionRuntimeTransition> {
  yield { kind: 'begin', sessionId, operationKind, operationId };
  let completed = false;
  try {
    for await (const event of stream) {
      if (event.kind === 'thinking') {
        if (thinkingEnabled) {
          yield { kind: 'thinking', sessionId, delta: event.delta };
        }
      } else if (event.kind === 'narration') {
        yield { kind: 'narration', sessionId, delta: event.delta };
      } else if (event.kind === 'warning') {
        yield { kind: 'warning', sessionId, text: event.text };
      } else if (event.kind === 'tool') {
        yield { kind: 'tool', sessionId, toolEvent: event.tool };
      } else if (event.kind === 'progress') {
        yield { kind: 'progress', sessionId, progress: event.progress };
      } else if (event.kind === 'approval') {
        yield { kind: 'approval', sessionId, approval: event.approval };
      } else if (event.kind === 'answer') {
        yield { kind: 'answer', sessionId, delta: event.delta };
      } else if (event.kind === 'done') {
        if (event.payload.session.id !== sessionId) {
          throw new Error(
            `Chat stream session mismatch: expected "${sessionId}", received "${event.payload.session.id}"`,
          );
        }
        yield { kind: 'done', sessionId, response: event.payload };
        completed = true;
      }
    }
    if (!completed) {
      throw new Error('Chat stream ended before the done event');
    }
  } catch (error) {
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
