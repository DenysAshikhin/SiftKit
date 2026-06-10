import type { Dict } from './lib/types.js';
import type { ChatMessage } from './repo-search/planner-protocol.js';

export class ThinkingRetentionPolicy {
  constructor(private readonly maintainPerStepThinking: boolean) {}

  prunePersistedMessages(messages: Dict[]): Dict[] {
    if (this.maintainPerStepThinking) {
      return messages;
    }
    const latestThinkingIndex = this.findLatestPersistedThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return messages;
    }
    return messages.filter((message, index) => message.kind !== 'assistant_thinking' || index === latestThinkingIndex);
  }

  prunePlannerMessages(messages: ChatMessage[]): void {
    if (this.maintainPerStepThinking) {
      return;
    }
    const latestThinkingIndex = this.findLatestPlannerThinkingIndex(messages);
    if (latestThinkingIndex < 0) {
      return;
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (index !== latestThinkingIndex) {
        delete messages[index].reasoning_content;
      }
    }
  }

  recordTurnThinking(turnThinking: Record<number, string>, turn: number, thinkingText: string): void {
    if (!this.maintainPerStepThinking) {
      for (const key of Object.keys(turnThinking)) {
        delete turnThinking[Number(key)];
      }
    }
    turnThinking[turn] = thinkingText;
  }

  private findLatestPersistedThinkingIndex(messages: Dict[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].kind === 'assistant_thinking') {
        return index;
      }
    }
    return -1;
  }

  private findLatestPlannerThinkingIndex(messages: ChatMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const reasoningContent = messages[index].reasoning_content;
      if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
        return index;
      }
    }
    return -1;
  }
}
