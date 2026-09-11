import {
  buildChatMessageId, buildChatRunMessageIdPrefix, reduceChatTranscript,
  type ChatOperationSnapshot, type ChatSnapshotTokenTurn, type ChatStreamPromptEvent, type ChatTranscriptEvent, type ChatTranscriptMessage,
} from '@siftkit/contracts';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { chatSnapshot, FIXTURE_OPERATION_ID } from './chat-snapshot-fixture.js';

/** A prompt measurement folded into the view exactly as the server's snapshot reader does. */
export type LiveTranscriptStep = ChatTranscriptEvent | { kind: 'prompt'; prompt: ChatStreamPromptEvent };

export const LIVE_TRANSCRIPT_PREFIX = buildChatRunMessageIdPrefix(FIXTURE_OPERATION_ID);

/** The journal-projected id of a streamed text row, which every committed view carries. */
export function liveRowId(kind: 'thinking' | 'narration' | 'answer', turn: number): string {
  return buildChatMessageId(LIVE_TRANSCRIPT_PREFIX, { kind, turn });
}

/**
 * The committed view a run's evidence projects to. Tests seed live state through it because a
 * stream delivers only committed views; the fold mirrors the server's snapshot reader.
 */
export function liveTranscriptSnapshot(
  sessionId: string, steps: readonly LiveTranscriptStep[], overrides: Partial<ChatOperationSnapshot> = {},
): ChatOperationSnapshot {
  let messages: ChatTranscriptMessage[] = [];
  const tokenTurns = new Map<number, ChatSnapshotTokenTurn>();
  let streamedCharsSinceBase = 0;
  for (const step of steps) {
    if (step.kind === 'prompt') {
      streamedCharsSinceBase = 0;
      tokenTurns.set(step.prompt.turn, { turn: step.prompt.turn, prompt: step.prompt, usage: tokenTurns.get(step.prompt.turn)?.usage ?? null });
      continue;
    }
    if (step.kind === 'usage') tokenTurns.set(step.usage.turn, { turn: step.usage.turn, prompt: tokenTurns.get(step.usage.turn)?.prompt ?? null, usage: step.usage });
    if (step.kind === 'thinking' || step.kind === 'narration' || step.kind === 'answer') streamedCharsSinceBase += step.delta.text.length;
    messages = reduceChatTranscript(messages, step, { messageIdPrefix: LIVE_TRANSCRIPT_PREFIX, sourceRunId: FIXTURE_OPERATION_ID, createdAtUtc: '2026-09-08T12:00:00.000Z' });
  }
  return chatSnapshot({ sessionId, operationId: FIXTURE_OPERATION_ID, messages, streamedCharsSinceBase,
    tokenTurns: [...tokenTurns.values()].sort((a, b) => a.turn - b.turn), ...overrides });
}

export function applyLiveTranscript(
  store: ChatSessionRuntimeStore, sessionId: string, steps: readonly LiveTranscriptStep[], overrides: Partial<ChatOperationSnapshot> = {},
): ChatSessionRuntimeStore {
  return store.apply({ kind: 'snapshot', sessionId, snapshot: liveTranscriptSnapshot(sessionId, steps, overrides) });
}
