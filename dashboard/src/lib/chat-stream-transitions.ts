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
  let completed = false;
  const projection = new ChatOperationProjection(sessionId);
  try {
    for await (const event of stream) {
      if (event.kind === 'snapshot' || event.kind === 'projection') {
        const snapshot = event.kind === 'snapshot' ? projection.acceptSnapshotPage(event.snapshot) : projection.acceptUpdate(event.update);
        if (snapshot) yield { kind: 'snapshot', sessionId, snapshot: thinkingEnabled ? snapshot
          : { ...snapshot, messages: snapshot.messages.filter(message => message.kind !== 'assistant_thinking') } };
      } else if (event.kind === 'error') {
        yield { kind: 'failure', sessionId, message: event.message, ...(event.issue ? { issue: event.issue } : {}) };
        return;
      } else if (event.kind === 'queue') {
        if (event.queue.sessionId !== sessionId) throw new Error('Queue stream session mismatch.');
        yield { kind: 'queue', sessionId, queue: event.queue };
      } else if (event.kind === 'queued-user') {
        yield { kind: 'queued-user', sessionId, message: event.message };
      } else if (event.kind === 'thinking') {
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
      } else if (event.kind === 'usage') {
        yield { kind: 'usage', sessionId, usage: event.usage };
      } else if (event.kind === 'prompt') {
        yield { kind: 'prompt', sessionId, prompt: event.prompt };
      } else if (event.kind === 'submitted') {
        yield { kind: 'user-turn', sessionId, content: event.content, images: event.images };
      } else if (event.kind === 'approval-state') {
        yield event.approval
          ? { kind: 'approval', sessionId, approval: event.approval }
          : { kind: 'approval-clear', sessionId };
      } else if (event.kind === 'approval-resolved') {
        yield { kind: 'approval-decision', sessionId, resolution: event.resolution };
      } else if (event.kind === 'ended') {
        yield { kind: 'detach', sessionId };
        completed = true;
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
