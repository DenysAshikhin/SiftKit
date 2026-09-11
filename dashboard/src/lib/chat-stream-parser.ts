import type { JsonValue, JsonObject } from '../../../src/lib/json-types.js';
import { parseJsonValueText } from '../../../src/lib/json.js';
import { z } from '../../../src/lib/zod.js';
import {
  ChatOperationSnapshotSchema,
  ChatOperationUpdateSchema,
  ChatStreamErrorSchema,
  type ChatRecoveryIssue,
  type ChatOperationSnapshot,
  type ChatOperationUpdate,
  ChatMessageQueueStateSchema,
  ChatStreamQueuedUserMessageSchema,
  type ChatMessageQueueState,
  type ChatStreamQueuedUserMessage,
  ChatSessionResponseSchema,
  ChatStreamApprovalResolvedSchema,
  ChatStreamApprovalSchema,
  ChatStreamApprovalStateSchema,
  ChatStreamProgressSchema,
  ChatStreamPromptEventSchema,
  ChatStreamTextDeltaSchema,
  ChatStreamToolEventSchema,
  ChatStreamSubmittedSchema,
  ChatStreamUsageEventSchema,
  type ChatSessionResponse,
  type ChatStreamApproval,
  type ChatStreamApprovalResolved,
  type ChatStreamProgress,
  type ChatStreamPromptEvent,
  type ChatStreamTextDelta,
  type ChatStreamToolEvent,
  type ChatStreamUsageEvent,
} from '@siftkit/contracts';

export type { ChatStreamToolEvent } from '@siftkit/contracts';

export type ChatStreamEvent =
  | { kind: 'snapshot'; snapshot: ChatOperationSnapshot }
  | { kind: 'projection'; update: ChatOperationUpdate }
  | { kind: 'queue'; queue: ChatMessageQueueState }
  | { kind: 'queued-user'; message: ChatStreamQueuedUserMessage }
  | { kind: 'thinking'; delta: ChatStreamTextDelta }
  | { kind: 'narration'; delta: ChatStreamTextDelta }
  | { kind: 'warning'; text: string }
  | { kind: 'tool'; tool: ChatStreamToolEvent }
  | { kind: 'progress'; progress: ChatStreamProgress }
  | { kind: 'approval'; approval: ChatStreamApproval }
  | { kind: 'answer'; delta: ChatStreamTextDelta }
  | { kind: 'done'; payload: ChatSessionResponse }
  | { kind: 'usage'; usage: ChatStreamUsageEvent }
  | { kind: 'prompt'; prompt: ChatStreamPromptEvent }
  | { kind: 'submitted'; content: string; images: string[] }
  | { kind: 'approval-state'; approval: ChatStreamApproval | null }
  | { kind: 'approval-resolved'; resolution: ChatStreamApprovalResolved }
  | { kind: 'ended' }
  | { kind: 'error'; message: string; issue?: ChatRecoveryIssue };

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
    case 'snapshot':
      return { kind: 'snapshot', snapshot: ChatOperationSnapshotSchema.parse(record) };
    case 'projection':
      return { kind: 'projection', update: ChatOperationUpdateSchema.parse(record) };
    case 'queue': {
      const result = ChatMessageQueueStateSchema.safeParse(record);
      return result.success ? { kind: 'queue', queue: result.data } : invalidFrame();
    }
    case 'queued_user_message': {
      const result = ChatStreamQueuedUserMessageSchema.safeParse(record);
      return result.success ? { kind: 'queued-user', message: result.data } : invalidFrame();
    }
    case 'thinking': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'thinking', delta: result.data } : invalidFrame();
    }
    case 'narration': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'narration', delta: result.data } : invalidFrame();
    }
    case 'warning':
      return { kind: 'warning', text: z.object({ warning: z.string() }).parse(record).warning };
    case 'tool_start':
    case 'tool_result': {
      const result = ChatStreamToolEventSchema.safeParse({ kind: parsed.eventName, ...record });
      return result.success ? { kind: 'tool', tool: result.data } : invalidFrame();
    }
    case 'progress': {
      const result = ChatStreamProgressSchema.safeParse(record);
      return result.success ? { kind: 'progress', progress: result.data } : invalidFrame();
    }
    case 'approval': {
      const result = ChatStreamApprovalSchema.safeParse(record);
      return result.success ? { kind: 'approval', approval: result.data } : invalidFrame();
    }
    case 'answer': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'answer', delta: result.data } : invalidFrame();
    }
    case 'done': {
      const result = ChatSessionResponseSchema.safeParse(record);
      return result.success ? { kind: 'done', payload: result.data } : invalidFrame();
    }
    case 'error': {
      const failure = ChatStreamErrorSchema.parse(record);
      return { kind: 'error', message: failure.error, ...(failure.issue ? { issue: failure.issue } : {}) };
    }
    case 'usage': {
      const result = ChatStreamUsageEventSchema.safeParse(record);
      return result.success ? { kind: 'usage', usage: result.data } : invalidFrame();
    }
    case 'prompt': {
      const result = ChatStreamPromptEventSchema.safeParse(record);
      return result.success ? { kind: 'prompt', prompt: result.data } : invalidFrame();
    }
    case 'submitted': {
      const result = ChatStreamSubmittedSchema.safeParse(record);
      return result.success
        ? { kind: 'submitted', content: result.data.content, images: result.data.images }
        : invalidFrame();
    }
    case 'approval_state': {
      const result = ChatStreamApprovalStateSchema.safeParse(record);
      return result.success ? { kind: 'approval-state', approval: result.data.approval } : invalidFrame();
    }
    case 'approval_resolved': {
      const result = ChatStreamApprovalResolvedSchema.safeParse(record);
      return result.success ? { kind: 'approval-resolved', resolution: result.data } : invalidFrame();
    }
    case 'ended':
      z.strictObject({}).parse(record);
      return { kind: 'ended' };
    default:
      throw new Error(`Unsupported chat stream event: ${parsed.eventName}`);
  }
}

export class ChatStreamReader {
  private buffer = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async *events(): AsyncGenerator<ChatStreamEvent> {
    try {
      for (;;) {
        const next = await this.reader.read();
        if (next.done) {
          break;
        }
        this.buffer += this.decoder.decode(next.value, { stream: true });
        let boundary = /\r?\n\r?\n/u.exec(this.buffer);
        while (boundary) {
          const packet = this.buffer.slice(0, boundary.index);
          this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
          const event = parseChatStreamPacket(packet);
          if (event) yield event;
          boundary = /\r?\n\r?\n/u.exec(this.buffer);
        }
      }
      this.buffer += this.decoder.decode();
      if (this.buffer.length > 0) {
        const finalEvent = parseChatStreamPacket(this.buffer);
        this.buffer = '';
        if (finalEvent) yield finalEvent;
      }
    } finally {
      this.reader.releaseLock();
    }
  }
}
