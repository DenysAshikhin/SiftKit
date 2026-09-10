import type { JsonValue, JsonObject } from '../../../src/lib/json-types.js';
import {
  ChatOperationAttachedEventSchema,
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
  type ChatSessionOperationKind,
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
  | { kind: 'attached'; operationKind: ChatSessionOperationKind; operationId: string; replayTruncated: boolean }
  | { kind: 'submitted'; content: string; images: string[] }
  | { kind: 'approval-state'; approval: ChatStreamApproval | null }
  | { kind: 'approval-resolved'; resolution: ChatStreamApprovalResolved }
  | { kind: 'ended' }
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

export function parseChatStreamPacket(packet: string): ChatStreamEvent | null {
  const parsed = readPacket(packet);
  if (!parsed || !isRecord(parsed.data)) return null;
  const record = parsed.data;
  switch (parsed.eventName) {
    case 'queue': {
      const result = ChatMessageQueueStateSchema.safeParse(record);
      return result.success ? { kind: 'queue', queue: result.data } : null;
    }
    case 'queued_user_message': {
      const result = ChatStreamQueuedUserMessageSchema.safeParse(record);
      return result.success ? { kind: 'queued-user', message: result.data } : null;
    }
    case 'thinking': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'thinking', delta: result.data } : null;
    }
    case 'narration': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'narration', delta: result.data } : null;
    }
    case 'warning':
      return { kind: 'warning', text: String(record.warning ?? '') };
    case 'tool_start':
    case 'tool_result': {
      const result = ChatStreamToolEventSchema.safeParse({ kind: parsed.eventName, ...record });
      return result.success ? { kind: 'tool', tool: result.data } : null;
    }
    case 'progress': {
      const result = ChatStreamProgressSchema.safeParse(record);
      return result.success ? { kind: 'progress', progress: result.data } : null;
    }
    case 'approval': {
      const result = ChatStreamApprovalSchema.safeParse(record);
      return result.success ? { kind: 'approval', approval: result.data } : null;
    }
    case 'answer': {
      const result = ChatStreamTextDeltaSchema.safeParse(record);
      return result.success ? { kind: 'answer', delta: result.data } : null;
    }
    case 'done': {
      const result = ChatSessionResponseSchema.safeParse(record);
      return result.success ? { kind: 'done', payload: result.data } : null;
    }
    case 'error':
      return { kind: 'error', message: String(record.error ?? 'stream error') };
    case 'usage': {
      const result = ChatStreamUsageEventSchema.safeParse(record);
      return result.success ? { kind: 'usage', usage: result.data } : null;
    }
    case 'prompt': {
      const result = ChatStreamPromptEventSchema.safeParse(record);
      return result.success ? { kind: 'prompt', prompt: result.data } : null;
    }
    case 'attached': {
      const result = ChatOperationAttachedEventSchema.safeParse(record);
      return result.success
        ? {
            kind: 'attached',
            operationKind: result.data.operationKind,
            operationId: result.data.operationId,
            replayTruncated: result.data.replayTruncated,
          }
        : null;
    }
    case 'submitted': {
      const result = ChatStreamSubmittedSchema.safeParse(record);
      return result.success
        ? { kind: 'submitted', content: result.data.content, images: result.data.images }
        : null;
    }
    case 'approval_state': {
      const result = ChatStreamApprovalStateSchema.safeParse(record);
      return result.success ? { kind: 'approval-state', approval: result.data.approval } : null;
    }
    case 'approval_resolved': {
      const result = ChatStreamApprovalResolvedSchema.safeParse(record);
      return result.success ? { kind: 'approval-resolved', resolution: result.data } : null;
    }
    case 'ended':
      return { kind: 'ended' };
    default:
      return null;
  }
}

export class ChatStreamReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async *events(): AsyncGenerator<ChatStreamEvent> {
    try {
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
    } finally {
      this.reader.releaseLock();
    }
  }
}
