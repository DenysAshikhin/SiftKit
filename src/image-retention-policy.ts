import { extractContentText } from './llm-protocol/image-attachments.js';
import type { InferenceContentPart } from './llm-protocol/types.js';

type RetainableMessage = {
  role: string;
  content?: string | InferenceContentPart[];
  imagePathKey?: string;
};

/**
 * Bounds how many images stay live in a message array, mirroring ThinkingRetentionPolicy.
 * The window counts individual images, not messages, because one message can carry several.
 * Ageing out is oldest-first, and a degraded image becomes a text part in place, so its still-live
 * siblings are untouched.
 */
export class ImageRetentionPolicy {
  constructor(private readonly retention: number) {}

  /** Rewrites `messages` in place. Returns the labels of the images it dropped, oldest first. */
  prune(messages: RetainableMessage[]): string[] {
    if (this.retention < 0) {
      return [];
    }
    const positions: Array<{ message: RetainableMessage; partIndex: number }> = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      message.content.forEach((part, partIndex) => {
        if (part.type === 'image_url') positions.push({ message, partIndex });
      });
    }
    const dropCount = Math.max(0, positions.length - this.retention);
    const dropped: string[] = [];
    for (const { message, partIndex } of positions.slice(0, dropCount)) {
      const label = extractContentText(message.content).trim() || 'image';
      if (message.imagePathKey !== undefined) {
        dropped.push(message.imagePathKey);
      }
      if (Array.isArray(message.content)) {
        message.content[partIndex] = { type: 'text', text: `[${label}, dropped from context]` };
      }
    }
    return dropped;
  }

}
