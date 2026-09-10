import type { ChatQueuedMessage } from '../../state/chat-message-queue.js';
import type { TranscriptManager } from './transcript-manager.js';

/** The one server-owned dependency used by a running loop to consume queued steering. */
export type ChatMessageQueueDelivery = {
  initial(): ChatQueuedMessage[];
  consume(turn: number, transcript: TranscriptManager): ChatQueuedMessage[];
};
