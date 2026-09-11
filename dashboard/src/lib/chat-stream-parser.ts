import type { JsonValue, JsonObject } from '../../../src/lib/json-types.js';
import { parseJsonValueText } from '../../../src/lib/json.js';
import {
  CHAT_PROJECTION_MAX_FRAME_BYTES,
  ChatMessageQueueStateSchema,
  ChatProjectionFrameSchema,
  type ChatMessageQueueState,
  type ChatProjectionFrame,
} from '@siftkit/contracts';

/** What a chat SSE body carries: bounded projection frames, or queue state on the queue-only stream. */
export type ChatStreamEvent =
  | { kind: 'projection'; frame: ChatProjectionFrame }
  | { kind: 'queue'; queue: ChatMessageQueueState };

type ParsedPacket = { eventName: string; data: JsonValue } | null;

function invalidFrame(): never { throw new Error('Malformed chat stream frame. Reconnect to recover the conversation.'); }

function readPacket(packet: string): ParsedPacket {
  const lines = packet.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (dataLines.length === 0) return eventLine ? invalidFrame() : null;
  const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
  try {
    return { eventName, data: parseJsonValueText(dataLines.map(line => line.slice(5).trim()).join('\n')) };
  } catch {
    return invalidFrame();
  }
}

function isRecord(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseChatStreamPacket(packet: string): ChatStreamEvent | null {
  const parsed = readPacket(packet);
  if (!parsed) return null;
  if (!isRecord(parsed.data)) return invalidFrame();
  const record = parsed.data;
  switch (parsed.eventName) {
    case 'chat_projection': {
      const result = ChatProjectionFrameSchema.safeParse(record);
      return result.success ? { kind: 'projection', frame: result.data } : invalidFrame();
    }
    case 'queue': {
      const result = ChatMessageQueueStateSchema.safeParse(record);
      return result.success ? { kind: 'queue', queue: result.data } : invalidFrame();
    }
    default:
      throw new Error(`Unsupported chat stream event: ${parsed.eventName}`);
  }
}

const PACKET_BOUNDARY = /\r?\n\r?\n/u;
const utf8 = new TextEncoder();

/**
 * Splits a body into packets as bytes arrive. Invalid UTF-8 fails at once; a packet that outgrows
 * `maxPacketBytes` fails before the remainder is buffered. The queue-only stream carries queued
 * images and passes null: that endpoint keeps its unbounded contract.
 */
export class ChatStreamReader {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly maxPacketBytes: number | null = CHAT_PROJECTION_MAX_FRAME_BYTES,
  ) {}

  async *events(): AsyncGenerator<ChatStreamEvent> {
    try {
      for (;;) {
        const next = await this.reader.read();
        if (next.done) break;
        this.buffer += this.decoder.decode(next.value, { stream: true });
        yield* this.drainPackets();
        this.requireBounded(this.buffer);
      }
      this.buffer += this.decoder.decode();
      yield* this.drainPackets();
      if (this.buffer.length > 0) {
        const finalEvent = this.parsePacket(this.buffer);
        this.buffer = '';
        if (finalEvent) yield finalEvent;
      }
    } finally {
      this.reader.releaseLock();
    }
  }

  /** Every complete packet in the buffer, one at a time, however many one network chunk carried. */
  private *drainPackets(): Generator<ChatStreamEvent> {
    for (let boundary = PACKET_BOUNDARY.exec(this.buffer); boundary; boundary = PACKET_BOUNDARY.exec(this.buffer)) {
      const packet = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const event = this.parsePacket(packet);
      if (event) yield event;
    }
  }

  private parsePacket(packet: string): ChatStreamEvent | null {
    this.requireBounded(packet);
    return parseChatStreamPacket(packet);
  }

  private requireBounded(text: string): void {
    if (this.maxPacketBytes !== null && utf8.encode(text).length > this.maxPacketBytes) {
      throw new Error(`Chat stream packet exceeds ${String(this.maxPacketBytes)} bytes. Reconnect to recover the conversation.`);
    }
  }
}
