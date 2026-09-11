import type { ImageMetadata } from '@siftkit/contracts';
import type { ChatQueuedMessage } from '../../state/chat-message-queue.js';
import type { TranscriptManager } from './transcript-manager.js';

/** A claimed queue entry after admission: its images are the accepted payloads with their metadata. */
export type ChatDeliveredMessage = ChatQueuedMessage & { imageMeta: ImageMetadata[] };

/** The one server-owned dependency used by a running loop to consume queued steering. */
export type ChatMessageQueueDelivery = {
  initial(): ChatDeliveredMessage[];
  consume(turn: number, transcript: TranscriptManager): ChatDeliveredMessage[];
};
