import type { ChatMessage as PlannerChatMessage } from './repo-search/planner-chat-message.js';
import type { PersistedChatTranscriptMessage } from '@siftkit/contracts';

export class ThinkingRetentionPolicy {
  constructor(private readonly maintainPerStepThinking: boolean) {}

  prunePersistedMessages(messages: PersistedChatTranscriptMessage[]): PersistedChatTranscriptMessage[] {
    if (this.maintainPerStepThinking) {
      return messages;
    }
    const latestThinkingIndex = this.findLatestPersistedThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return messages;
    }
    return messages.filter((message, index) => message.kind !== 'assistant_thinking' || index === latestThinkingIndex);
  }

  /** Returns the same array instance when nothing was dropped, so an owner can skip a no-op splice. */
  prunePlannerMessages(messages: readonly PlannerChatMessage[]): readonly PlannerChatMessage[] {
    if (this.maintainPerStepThinking) {
      return messages;
    }
    const latestThinkingIndex = this.findLatestPlannerThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return messages;
    }
    const stale = messages.some((message, index) => (
      index !== latestThinkingIndex && 'reasoning_content' in message
    ));
    if (!stale) {
      return messages;
    }
    return messages.map((message, index) => {
      if (index === latestThinkingIndex || !('reasoning_content' in message)) return message;
      const { reasoning_content: _dropped, ...retained } = message;
      return retained;
    });
  }

  recordTurnThinking(turnThinking: Record<number, string>, turn: number, thinkingText: string): void {
    if (!this.maintainPerStepThinking) {
      for (const key of Object.keys(turnThinking)) {
        delete turnThinking[Number(key)];
      }
    }
    turnThinking[turn] = thinkingText;
  }

  private findLatestPersistedThinkingIndex(messages: PersistedChatTranscriptMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].kind === 'assistant_thinking') {
        return index;
      }
    }
    return -1;
  }

  private findLatestPlannerThinkingIndex(messages: readonly PlannerChatMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const reasoningContent = messages[index].reasoning_content;
      if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
        return index;
      }
    }
    return -1;
  }
}
