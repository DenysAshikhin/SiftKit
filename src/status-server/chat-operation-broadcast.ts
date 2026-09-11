import {
  isTerminalChatStreamEventName,
  type ChatStreamEventName,
} from '@siftkit/contracts';

import type { JsonSerializable } from '../lib/json-types.js';

/** One already-serialized SSE frame. Replaying the stored `data` reproduces the live bytes exactly. */
export type ChatOperationFrame = {
  event: ChatStreamEventName;
  data: string;
};

export interface ChatOperationSubscriber {
  onFrame(frame: ChatOperationFrame): void;
  /** The session's history changed outside the run (edit, deletion, purge); re-read the journal. */
  onHistoryRevised(): void;
  onClosed(): void;
}

/** Wakes subscribers after committed publications. The journal owns replay and transcript data. */
export class ChatOperationBroadcast {
  private readonly subscribers = new Set<ChatOperationSubscriber>();
  private closed = false;
  private terminal = false;

  writeEvent(event: ChatStreamEventName, payload: JsonSerializable): void {
    if (this.closed) {
      return;
    }
    const frame: ChatOperationFrame = { event, data: JSON.stringify(payload) };
    if (isTerminalChatStreamEventName(event)) {
      this.terminal = true;
    }
    for (const subscriber of this.subscribers) {
      subscriber.onFrame(frame);
    }
  }

  /** Wakes readers after a committed history revision; there is no frame because nothing streamed. */
  notifyHistoryRevised(): void {
    if (this.closed) return;
    for (const subscriber of this.subscribers) subscriber.onHistoryRevised();
  }

  /** Subscribe before capturing a journal snapshot, so concurrent publications trigger catch-up. */
  attach(subscriber: ChatOperationSubscriber): void {
    if (this.closed) {
      subscriber.onClosed();
      return;
    }
    this.subscribers.add(subscriber);
  }

  detach(subscriber: ChatOperationSubscriber): void {
    this.subscribers.delete(subscriber);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) {
      subscriber.onClosed();
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  hasTerminalFrame(): boolean {
    return this.terminal;
  }

}
