import { ChatOperationSnapshotSchema, ChatOperationUpdateSchema, type ChatOperationSnapshot } from '@siftkit/contracts';
import { ChatOperationProjection } from '../../dashboard/src/lib/chat-operation-projection.js';
import type { SseResponse } from './dashboard-http.js';

/** Exercise the browser's actual page/update assembly against HTTP test responses. */
export function readChatStreamViews(response: SseResponse) {
  const views: { snapshot: ChatOperationSnapshot; receivedAtMs: number }[] = [];
  let projection: ChatOperationProjection | null = null;
  for (const event of response.events) {
    let snapshot: ChatOperationSnapshot | null = null;
    if (event.event === 'snapshot') {
      const page = ChatOperationSnapshotSchema.parse(event.payload);
      projection ??= new ChatOperationProjection(page.sessionId);
      snapshot = projection.acceptSnapshotPage(page);
    } else if (event.event === 'projection') {
      if (!projection) throw new Error('HTTP update arrived before its snapshot.');
      snapshot = projection.acceptUpdate(ChatOperationUpdateSchema.parse(event.payload));
    }
    if (snapshot) views.push({ snapshot, receivedAtMs: event.receivedAtMs });
  }
  return views;
}
