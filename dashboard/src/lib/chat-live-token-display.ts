import { buildChatTextMessageId } from '@siftkit/contracts';
import type { ChatSessionRuntime } from './chat-session-runtime-store';
import { getLiveMessageTokenDisplay, type TokenDisplay } from './format';

/** Provisional text counts belong to the view; canonical transcript rows remain measured only. */
export function buildLiveTokenDisplays(runtime: ChatSessionRuntime): ReadonlyMap<string, TokenDisplay> {
  const displays = new Map<string, TokenDisplay>();
  const messages = new Map(runtime.liveMessages.map((message) => [message.id, message]));
  for (const message of runtime.liveMessages) {
    const generated = message.kind === 'assistant_thinking' || message.kind === 'assistant_answer';
    displays.set(message.id, generated
      ? { tokenCount: message.content.length ? null : 0, exact: false, imageTokens: 0 }
      : getLiveMessageTokenDisplay(message));
  }
  let precedingOutput = 0;
  for (const [turn, { prompt, usage }] of [...runtime.tokenTurns].sort(([a], [b]) => a - b)) {
    for (const kind of ['thinking', 'narration', 'answer'] as const) {
      const id = buildChatTextMessageId(kind, turn, {
        messageIdPrefix: 'live',
      });
      const message = messages.get(id);
      if (!message || (message.kind !== 'assistant_thinking' && message.kind !== 'assistant_answer')) continue;
      const thinking = message.kind === 'assistant_thinking';
      const estimated = message.content.length === 0 ? 0 : prompt ? Math.ceil(message.content.length / prompt.charsPerToken) : null;
      displays.set(id, {
        tokenCount: usage
          ? thinking ? usage.record.thinkingTokens : usage.totals.outputTokens
          : estimated === null ? null : estimated + (thinking ? 0 : precedingOutput),
        exact: usage !== null && !(thinking ? usage.record.thinkingTokensEstimated : usage.totals.outputTokensEstimatedCount > 0),
        imageTokens: 0,
      });
    }
    if (usage) precedingOutput = usage.totals.outputTokens;
  }
  return displays;
}
