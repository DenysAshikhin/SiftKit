import { extractContentText } from './llm-protocol/image-attachments.js';
import type { ChatMessage } from './repo-search/planner-chat-message.js';

export type ImageRetentionOutcome = {
  /** The same array instance when nothing aged out, so an owner can skip recording a no-op splice. */
  messages: readonly ChatMessage[];
  /** Labels of the images that aged out, oldest first. */
  droppedPathKeys: string[];
};

/**
 * Bounds how many images stay live in a message array, mirroring ThinkingRetentionPolicy.
 * The window counts individual images, not messages, because one message can carry several.
 * Ageing out is oldest-first, and a degraded image becomes a text part in place, so its still-live
 * siblings are untouched. Messages are rebuilt rather than edited: the transcript that owns them
 * decides when a rewrite becomes a recorded mutation.
 */
export class ImageRetentionPolicy {
  constructor(private readonly retention: number) {}

  prune(messages: readonly ChatMessage[]): ImageRetentionOutcome {
    if (this.retention < 0) {
      return { messages, droppedPathKeys: [] };
    }
    const positions: Array<{ messageIndex: number; partIndex: number }> = [];
    messages.forEach((message, messageIndex) => {
      if (!Array.isArray(message.content)) return;
      message.content.forEach((part, partIndex) => {
        if (part.type === 'image_url') positions.push({ messageIndex, partIndex });
      });
    });
    const dropCount = Math.max(0, positions.length - this.retention);
    if (dropCount === 0) {
      return { messages, droppedPathKeys: [] };
    }
    const rewritten = messages.map((message) => ({ ...message }));
    const droppedPathKeys: string[] = [];
    for (const { messageIndex, partIndex } of positions.slice(0, dropCount)) {
      const message = rewritten[messageIndex];
      if (!Array.isArray(message.content)) continue;
      const label = extractContentText(message.content).trim() || 'image';
      if (message.imagePathKey !== undefined) {
        droppedPathKeys.push(message.imagePathKey);
      }
      message.content = message.content.map((part, index) => (
        index === partIndex ? { type: 'text', text: `[${label}, dropped from context]` } : part
      ));
    }
    return { messages: rewritten, droppedPathKeys };
  }
}
