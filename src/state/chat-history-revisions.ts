import { randomUUID } from 'node:crypto';
import { buildChatRunMessageIdPrefix, buildChatToolMessageId, type ChatTranscriptMessage } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { RuntimeDatabase } from './database-handle.js';
import { ChatJournalStore } from './chat-journal.js';
import { ChatHistoryRevisionSchema, ChatJournalEventSchema, type ChatHistoryRevision } from './chat-journal-schema.js';

export function readChatHistoryRevisions(database: RuntimeDatabase, sessionId: string): ChatHistoryRevision[] {
  return z.array(z.object({ body_json: z.string() })).parse(database.prepare(`
    SELECT e.body_json FROM chat_run_events e JOIN chat_runs r ON r.operation_id=e.operation_id
    WHERE r.session_id=? AND e.kind='history_revised' ORDER BY r.run_order, e.sequence
  `).all(sessionId)).map(row => {
    const event = ChatJournalEventSchema.parse(JSON.parse(row.body_json));
    if (event.kind !== 'history_revised') throw new Error('Chat history revision discriminator is corrupt.');
    return event.revision;
  });
}

/** User-directed history changes are committed records, never model execution runs. */
export function recordChatHistoryRevision(database: RuntimeDatabase, sessionId: string, input: ChatHistoryRevision): void {
  let revision = ChatHistoryRevisionSchema.parse(input);
  const store = new ChatJournalStore(database);
  const runs = store.listSessionRuns(sessionId);
  // A legacy-only session is imported as its already-edited baseline before its first Web run.
  if (runs.length === 0) return;
  if (revision.action === 'message_deleted') {
    const ids = new Set(revision.messageIds);
    const proposals = z.array(z.object({ operation_id: z.string(), body_json: z.string() })).parse(database.prepare(`
      SELECT e.operation_id, e.body_json FROM chat_run_events e JOIN chat_runs r ON r.operation_id=e.operation_id
      WHERE r.session_id=? AND e.kind='tool_proposed'
    `).all(sessionId));
    const toolCallIds = proposals.flatMap(row => {
      const event = ChatJournalEventSchema.parse(JSON.parse(row.body_json));
      return event.kind === 'tool_proposed' && ids.has(buildChatToolMessageId(buildChatRunMessageIdPrefix(row.operation_id), event.call.displayToolCallId))
        ? [event.call.toolCallId] : [];
    });
    revision = { ...revision, toolCallIds };
  }
  const operationId = randomUUID();
  const now = new Date().toISOString();
  database.transaction(() => {
    store.begin({ operationId, sessionId, recordKind: 'history_revision', operationKind: null,
      ownerEpoch: 'history-edit', settings: null, provenance: null, createdAtUtc: now });
    store.append({ operationId, ownerEpoch: 'history-edit', expectedSequence: 0, eventId: 'revision', occurredAtUtc: now,
      event: { kind: 'history_revised', revision, expectedSessionRevision: readChatHistoryRevisions(database, sessionId).length } });
    store.finish({ operationId, ownerEpoch: 'history-edit', terminalCause: 'completed', updatedAtUtc: now });
  })();
}

export function applyChatDisplayRevisions(messages: readonly ChatTranscriptMessage[], revisions: readonly ChatHistoryRevision[]): ChatTranscriptMessage[] {
  let retained = [...messages];
  for (const revision of revisions) {
    if (revision.action === 'message_deleted') {
      const ids = new Set(revision.messageIds);
      retained = retained.filter(message => !ids.has(message.id));
    } else if (revision.action === 'message_edited') {
      retained = retained.map(message => message.id === revision.messageId ? { ...message, content: revision.content } : message);
    } else if (revision.action === 'image_removed') {
      retained = retained.map(message => message.id === revision.messageId ? { ...message,
        images: message.images?.filter((_, index) => index !== revision.imageIndex),
        imageMeta: message.imageMeta?.filter((_, index) => index !== revision.imageIndex),
        removedImageCount: (message.removedImageCount ?? 0) + 1,
      } : message);
    } else if (revision.action === 'image_caption_updated') {
      retained = retained.map(message => message.id === revision.messageId ? { ...message,
        imageMeta: message.imageMeta?.map((metadata, index) => index === revision.imageIndex ? { ...metadata, caption: revision.caption } : metadata),
      } : message);
    } else if (revision.action === 'condensed') {
      const ids = new Set(revision.compressedMessageIds);
      retained = retained.map(message => ids.has(message.id) ? { ...message, compressedIntoSummary: true } : message);
    }
  }
  return retained;
}
