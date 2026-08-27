import { getErrorMessage } from '../../../src/lib/errors.js';
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
  stream: AsyncGenerator<ChatStreamEvent>,
  thinkingEnabled: boolean,
): AsyncGenerator<ChatSessionRuntimeTransition> {
  yield { kind: 'begin', sessionId, operationKind };
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
    yield { kind: 'failure', sessionId, message: getErrorMessage(error) };
  }
}
