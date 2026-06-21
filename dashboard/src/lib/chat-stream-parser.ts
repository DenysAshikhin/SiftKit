import { z } from '../../../src/lib/zod.js';
import type { JsonValue, JsonObject } from '../../../src/lib/json-types.js';
import type { ChatSessionResponse } from '../types.js';

const ChatSessionResponseSchema = z.custom<ChatSessionResponse>(
  (value) => typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'session' in value
    && 'contextUsage' in value,
);

export type ChatStreamToolEvent = {
  kind: 'tool_start' | 'tool_result';
  toolCallId: string;
  turn: number;
  maxTurns: number;
  command: string;
  exitCode?: number;
  outputSnippet?: string;
  outputTokens?: number;
  outputTokensEstimated?: boolean;
  promptTokenCount?: number;
};

export type ChatStreamEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool: ChatStreamToolEvent }
  | { kind: 'answer'; text: string }
  | { kind: 'done'; payload: ChatSessionResponse }
  | { kind: 'error'; message: string };

type ParsedPacket = { eventName: string; data: JsonValue } | null;

function readPacket(packet: string): ParsedPacket {
  const lines = packet.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLine = lines.find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  const eventName = eventLine ? eventLine.slice(6).trim() : 'message';
  try {
    return { eventName, data: JSON.parse(dataLine.slice(5).trim()) };
  } catch {
    return null;
  }
}

function isRecord(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildToolEvent(kind: 'tool_start' | 'tool_result', record: JsonObject): ChatStreamToolEvent {
  const tool: ChatStreamToolEvent = {
    kind,
    toolCallId: String(record.toolCallId ?? ''),
    turn: Number(record.turn ?? 0),
    maxTurns: Number(record.maxTurns ?? 0),
    command: String(record.command ?? ''),
  };
  if (typeof record.exitCode === 'number') tool.exitCode = record.exitCode;
  if (typeof record.outputSnippet === 'string') tool.outputSnippet = record.outputSnippet;
  if (typeof record.outputTokens === 'number') tool.outputTokens = record.outputTokens;
  if (typeof record.outputTokensEstimated === 'boolean') tool.outputTokensEstimated = record.outputTokensEstimated;
  if (typeof record.promptTokenCount === 'number') tool.promptTokenCount = record.promptTokenCount;
  return tool;
}

export function parseChatStreamPacket(packet: string): ChatStreamEvent | null {
  const parsed = readPacket(packet);
  if (!parsed || !isRecord(parsed.data)) return null;
  const record = parsed.data;
  switch (parsed.eventName) {
    case 'thinking':
      return { kind: 'thinking', text: String(record.thinking ?? '') };
    case 'tool_start':
    case 'tool_result':
      return { kind: 'tool', tool: buildToolEvent(parsed.eventName, record) };
    case 'answer':
      return { kind: 'answer', text: String(record.answer ?? '') };
    case 'done': {
      const result = ChatSessionResponseSchema.safeParse(record);
      return result.success ? { kind: 'done', payload: result.data } : null;
    }
    case 'error':
      return { kind: 'error', message: String(record.error ?? 'stream error') };
    default:
      return null;
  }
}

export class ChatStreamReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async *events(): AsyncGenerator<ChatStreamEvent> {
    for (;;) {
      const next = await this.reader.read();
      if (next.done) {
        break;
      }
      this.buffer += this.decoder.decode(next.value, { stream: true });
      let boundary = this.buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const packet = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const event = parseChatStreamPacket(packet);
        if (event) yield event;
        boundary = this.buffer.indexOf('\n\n');
      }
    }
    if (this.buffer.length > 0) {
      const finalEvent = parseChatStreamPacket(this.buffer);
      this.buffer = '';
      if (finalEvent) yield finalEvent;
    }
  }
}
