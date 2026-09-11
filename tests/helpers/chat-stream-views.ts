import { ChatProjectionFrameSchema, type ChatOperationSnapshot, type ChatProjectionTerminalRecord, type ChatStreamError } from '@siftkit/contracts';
import { ChatOperationProjection } from '../../dashboard/src/lib/chat-operation-projection.js';
import { requestJson, type Dict, type SseResponse } from './dashboard-http.js';

export type ChatStreamView = { snapshot: ChatOperationSnapshot; receivedAtMs: number };

/** Exercise the browser's actual transfer assembly against HTTP test responses. */
export function readChatStream(response: SseResponse, sessionId: string) {
  const projection = new ChatOperationProjection(sessionId);
  const views: ChatStreamView[] = [];
  let terminal: ChatProjectionTerminalRecord | null = null;
  let failure: ChatStreamError | null = null;
  for (const event of response.events) {
    if (event.event !== 'chat_projection') continue;
    if (terminal || failure !== null) throw new Error('Frames arrived after the stream settled.');
    const delivery = projection.acceptFrame(ChatProjectionFrameSchema.parse(event.payload));
    if (delivery === null) continue;
    if (delivery.kind === 'view') views.push({ snapshot: delivery.snapshot, receivedAtMs: event.receivedAtMs });
    else if (delivery.kind === 'terminal') terminal = delivery.terminal;
    else failure = delivery.failure;
  }
  return { views, terminal, failure };
}

export function readChatStreamViews(response: SseResponse, sessionId: string): ChatStreamView[] {
  return readChatStream(response, sessionId).views;
}

/** The stream settled cleanly; returns what the browser then reads back: the persisted session response. */
export async function readSettledChatSession(baseUrl: string, sessionId: string, response: SseResponse): Promise<Dict> {
  const { terminal, failure } = readChatStream(response, sessionId);
  if (failure !== null) throw new Error(`Chat stream failed: ${failure.error}`);
  if (!terminal) throw new Error('Chat stream ended before its terminal record.');
  const persisted = await requestJson(`${baseUrl}/dashboard/chat/sessions/${encodeURIComponent(sessionId)}`);
  if (persisted.statusCode !== 200) throw new Error(`Session read failed (${persisted.statusCode}).`);
  return persisted.body;
}
