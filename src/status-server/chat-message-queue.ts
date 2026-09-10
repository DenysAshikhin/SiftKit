import { ChatOperationBroadcast, type ChatOperationSubscriber } from './chat-operation-broadcast.js';
import type { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import type { ChatSessionOperationRegistry } from './chat-session-operation-registry.js';
import type { ChatQueueOperationKind } from '@siftkit/contracts';
import type { TranscriptManager } from '../repo-search/engine/transcript-manager.js';
import type { ChatMessageQueueDelivery } from '../repo-search/engine/queue-delivery.js';
import type { ChatRunRecorder } from './chat-run-recorder.js';

type QueueDeliveryOptions = {
  recorder: ChatRunRecorder;
  sessionId: string;
  requestId: string;
  operationKind: ChatQueueOperationKind;
  forceId?: string;
};

/** Owns bounded queue subscriptions, including sessions without an active generation. */
export class ChatMessageQueue {
  private readonly channels = new Map<string, { broadcast: ChatOperationBroadcast; subscribers: Set<ChatOperationSubscriber> }>();

  constructor(readonly store: ChatMessageQueueStore, private readonly operations: ChatSessionOperationRegistry) {}

  state(sessionId: string) {
    const active = this.operations.getActiveOperation(sessionId);
    return {
      ...this.store.state(sessionId),
      activeOperationId: active?.operationId ?? null,
      activeOperationKind: active?.operationKind ?? null,
    };
  }

  createDelivery(options: QueueDeliveryOptions): ChatMessageQueueDelivery {
    return new SessionChatMessageQueueDelivery(this, options);
  }

  publish(sessionId: string): void {
    const state = this.state(sessionId);
    this.operations.getBroadcast(sessionId)?.writeEvent('queue', state);
    this.channels.get(sessionId)?.broadcast.writeEvent('queue', state);
  }

  attach(sessionId: string, subscriber: ChatOperationSubscriber): void {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = { broadcast: new ChatOperationBroadcast(0), subscribers: new Set() };
      this.channels.set(sessionId, channel);
    }
    channel.subscribers.add(subscriber);
    channel.broadcast.attach(subscriber);
    subscriber.onFrame({ event: 'queue', data: JSON.stringify(this.state(sessionId)) });
  }

  detach(sessionId: string, subscriber: ChatOperationSubscriber): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    channel.broadcast.detach(subscriber);
    channel.subscribers.delete(subscriber);
    if (channel.subscribers.size === 0) this.channels.delete(sessionId);
  }
}

class SessionChatMessageQueueDelivery implements ChatMessageQueueDelivery {
  constructor(
    private readonly owner: ChatMessageQueue,
    private readonly options: QueueDeliveryOptions,
  ) {}

  initial() {
    if (!this.options.forceId) return [];
    const force = this.owner.store.state(this.options.sessionId).force;
    if (!force || force.id !== this.options.forceId || force.phase === 'failed') throw new Error('Queued continuation was cancelled.');
    const messages = this.options.recorder.claimQueuedMessages(this.options.sessionId,
      { requestId: this.options.requestId, turn: 0, ids: force.messageIds }, force.id);
    this.owner.publish(this.options.sessionId);
    return messages;
  }

  consume(turn: number, transcript: TranscriptManager) {
    const state = this.owner.store.state(this.options.sessionId);
    if (state.paused || state.force !== null) return [];
    const pending = this.owner.store.listPending(this.options.sessionId);
    const conflicting = pending.find((message) => message.options.operationKind !== this.options.operationKind);
    if (conflicting) {
      throw new Error(
        `Queued message ${conflicting.id} requests ${conflicting.options.operationKind}, `
        + `but active operation is ${this.options.operationKind}.`,
      );
    }
    const claimed = this.options.recorder.claimQueuedMessages(this.options.sessionId, {
      requestId: this.options.requestId,
      turn,
      ids: pending.map((message) => message.id),
    });
    for (const message of claimed) {
      transcript.pushQueuedUser(message.id, message.content, message.images);
    }
    if (claimed.length > 0) this.owner.publish(this.options.sessionId);
    return claimed;
  }
}
