import type { ChatMessageQueueStore } from '../state/chat-message-queue.ts';
import type { ChatSessionOperationRegistry } from './chat-session-operation-registry.ts';
import type { ChatMessageQueueState, ChatQueueOperationKind } from '@siftkit/contracts';
import type { TranscriptManager } from '../repo-search/engine/transcript-manager.ts';
import type { ChatMessageQueueDelivery } from '../repo-search/engine/queue-delivery.ts';
import type { ChatRunRecorder } from './chat-run-recorder.ts';

type QueueDeliveryOptions = {
  recorder: ChatRunRecorder;
  sessionId: string;
  requestId: string;
  operationKind: ChatQueueOperationKind;
  forceId?: string;
};

/** A reader of one session's queue state, which the independent queue stream forwards verbatim. */
export interface ChatQueueSubscriber {
  onQueue(state: ChatMessageQueueState): void;
}

/** Owns bounded queue subscriptions, including sessions without an active generation. */
export class ChatMessageQueue {
  private readonly channels = new Map<string, Set<ChatQueueSubscriber>>();

  readonly store: ChatMessageQueueStore;
  private readonly operations: ChatSessionOperationRegistry;

  constructor(store: ChatMessageQueueStore, operations: ChatSessionOperationRegistry) {
    this.store = store;
    this.operations = operations;
  }

  state(sessionId: string): ChatMessageQueueState {
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

  /** Operation readers re-read the queue from their own capture; queue-only readers get the state. */
  publish(sessionId: string): void {
    this.operations.getBroadcast(sessionId)?.publish();
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    const state = this.state(sessionId);
    for (const subscriber of channel) subscriber.onQueue(state);
  }

  attach(sessionId: string, subscriber: ChatQueueSubscriber): void {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = new Set();
      this.channels.set(sessionId, channel);
    }
    channel.add(subscriber);
    subscriber.onQueue(this.state(sessionId));
  }

  detach(sessionId: string, subscriber: ChatQueueSubscriber): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    channel.delete(subscriber);
    if (channel.size === 0) this.channels.delete(sessionId);
  }
}

class SessionChatMessageQueueDelivery implements ChatMessageQueueDelivery {
  private readonly owner: ChatMessageQueue;
  private readonly options: QueueDeliveryOptions;

  constructor(
    owner: ChatMessageQueue,
    options: QueueDeliveryOptions,
  ) {
    this.owner = owner;
    this.options = options;
  }

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
