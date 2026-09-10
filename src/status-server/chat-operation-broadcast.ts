import {
  isTerminalChatStreamEventName,
  type ChatStreamEventName,
} from '@siftkit/contracts';

import type { JsonSerializable } from '../lib/json-types.js';
import { z } from '../lib/zod.js';

/** One already-serialized SSE frame. Replaying the stored `data` reproduces the live bytes exactly. */
export type ChatOperationFrame = {
  event: ChatStreamEventName;
  data: string;
};

export type ChatOperationReplay = {
  frames: ChatOperationFrame[];
  truncated: boolean;
};

export interface ChatOperationSubscriber {
  onFrame(frame: ChatOperationFrame): void;
  onClosed(): void;
}

/**
 * Ceiling on retained frame payload. A long repo-agent run streams every generated character, so an
 * unbounded buffer is a memory leak; past the ceiling the oldest frames are dropped and the replay is
 * flagged truncated rather than silently starting mid-sentence with no explanation.
 */
export const CHAT_OPERATION_REPLAY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Retains one operation's SSE frames in order and fans them out to every attached reader, so the
 * client that started the run and a client that reconnects later see the same stream.
 */
export class ChatOperationBroadcast {
  failure: string | null = null;
  private readonly frames: ChatOperationFrame[] = [];
  private readonly subscribers = new Set<ChatOperationSubscriber>();
  private bufferedBytes = 0;
  private truncated = false;
  private closed = false;
  private terminal = false;

  constructor(private readonly maxBufferedBytes: number = CHAT_OPERATION_REPLAY_MAX_BYTES) {}

  writeEvent(event: ChatStreamEventName, payload: JsonSerializable): void {
    if (this.closed) {
      return;
    }
    if (event === 'error') this.failure = z.object({ error: z.string() }).parse(payload).error;
    const frame: ChatOperationFrame = { event, data: JSON.stringify(payload) };
    this.frames.push(frame);
    this.bufferedBytes += Buffer.byteLength(frame.data, 'utf8');
    if (isTerminalChatStreamEventName(event)) {
      this.terminal = true;
    }
    this.trim();
    for (const subscriber of this.subscribers) {
      subscriber.onFrame(frame);
    }
  }

  /**
   * Registers a reader and returns everything it missed. Both halves happen in one synchronous step,
   * so no frame can slip between the snapshot and the subscription.
   */
  attach(subscriber: ChatOperationSubscriber): ChatOperationReplay {
    const replay: ChatOperationReplay = { frames: this.frames.slice(), truncated: this.truncated };
    if (this.closed) {
      subscriber.onClosed();
      return replay;
    }
    this.subscribers.add(subscriber);
    return replay;
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

  private trim(): void {
    while (this.bufferedBytes > this.maxBufferedBytes && this.frames.length > 0) {
      const dropped = this.frames.shift();
      if (!dropped) {
        return;
      }
      this.bufferedBytes -= Buffer.byteLength(dropped.data, 'utf8');
      this.truncated = true;
    }
  }
}
