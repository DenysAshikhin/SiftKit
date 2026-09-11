import { createHash, randomUUID } from 'node:crypto';
import { buildChatMessageId, buildChatRunMessageIdPrefix, type ChatTranscriptMessage } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { RuntimeDatabase } from './database-handle.js';
import { ChatJournalIntegrityError, ChatJournalStore, digestChatJournalEvent } from './chat-journal.js';
import { CHAT_JOURNAL_EVENT_VERSION, ChatHistoryRevisionSchema, ChatJournalEventSchema, type ChatHistoryRevision, type ChatJournalEvent } from './chat-journal-schema.js';
import type { ChatMessage } from '../repo-search/planner-chat-message.js';

export function readChatCompactionRevisions(database: RuntimeDatabase, sessionId: string) {
  const rows = z.array(z.object({ operation_id: z.string(), event_id: z.string().min(1), sequence: z.number().int().positive(), run_order: z.number().int().positive() })).parse(database.prepare(`
    SELECT e.operation_id, e.event_id, e.sequence, r.run_order FROM chat_run_events e JOIN chat_runs r ON r.operation_id=e.operation_id
    WHERE r.session_id=? AND e.kind='context_spliced' AND json_extract(e.body_json, '$.reason')='compacted'
    ORDER BY r.run_order, e.sequence
  `).all(sessionId));
  const store = new ChatJournalStore(database);
  return rows.map(row => {
    const envelope = store.readAfter(row.operation_id, row.sequence - 1, 1)[0];
    if (envelope?.event.kind !== 'context_spliced' || envelope.event.reason !== 'compacted') {
      throw new ChatJournalIntegrityError('context_gap', row.operation_id, row.event_id, row.sequence, 'compaction evidence is missing.');
    }
    return { operationId: row.operation_id, runOrder: row.run_order, compressedMessageIds: envelope.event.compressedMessageIds ?? [] };
  });
}

export function readChatHistoryRevisions(database: RuntimeDatabase, sessionId: string): ChatHistoryRevision[] {
  return z.array(z.object({ body_json: z.string(), payload_digest: z.string(), event_id: z.string(), operation_id: z.string(),
    version: z.literal(CHAT_JOURNAL_EVENT_VERSION), record_kind: z.literal('history_revision') })).parse(database.prepare(`
    SELECT e.body_json, e.payload_digest, e.event_id, e.operation_id, e.version, r.record_kind FROM chat_run_events e JOIN chat_runs r ON r.operation_id=e.operation_id
    WHERE r.session_id=? AND e.kind='history_revised' ORDER BY r.run_order, e.sequence
  `).all(sessionId)).map((row, index) => {
    const event = ChatJournalEventSchema.parse(JSON.parse(row.body_json));
    if (event.kind !== 'history_revised') throw new Error('Chat history revision discriminator is corrupt.');
    if (digestChatJournalEvent(event) !== row.payload_digest) throw new Error(`Chat history revision ${row.event_id} in run ${row.operation_id} has a corrupt digest.`);
    if (event.expectedSessionRevision !== index) throw new Error(`Chat history revision ${row.event_id} in run ${row.operation_id} has a revision gap.`);
    return event.revision;
  });
}

/** User-directed history changes are committed records, never model execution runs. */
export function recordChatHistoryRevision(database: RuntimeDatabase, sessionId: string, input: ChatHistoryRevision): void {
  const revision = ChatHistoryRevisionSchema.parse(input);
  const store = new ChatJournalStore(database);
  const runs = store.listSessionRuns(sessionId);
  // A legacy-only session is imported as its already-edited baseline before its first Web run.
  if (runs.length === 0) return;
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
        // Image bodies are purged from source evidence in the revision transaction.
        removedImageCount: (message.removedImageCount ?? 0) + 1,
      } : message);
    } else if (revision.action === 'image_caption_updated') {
      retained = retained.map(message => message.id === revision.messageId ? { ...message,
        imageMeta: message.imageMeta?.map((metadata, index) => originalImageIndex(revisions, message.id, index) === revision.originalImageIndex
          ? { ...metadata, caption: revision.caption } : metadata),
      } : message);
    } else if (revision.action === 'condensed') {
      const ids = new Set(revision.compressedMessageIds);
      retained = retained.map(message => ids.has(message.id) ? { ...message, compressedIntoSummary: true } : message);
    }
  }
  return retained;
}

/** Image positions refer to the original admitted message, even after earlier attachments vanish. */
function originalImageIndex(revisions: readonly ChatHistoryRevision[], messageId: string, visibleIndex: number): number {
  const removed = new Set(revisions.flatMap(revision => revision.action === 'image_removed' && revision.messageId === messageId ? [revision.originalImageIndex] : []));
  let original = visibleIndex;
  for (const index of [...removed].sort((left, right) => left - right)) if (index <= original) original += 1;
  return original;
}

export function resolveOriginalChatImageIndex(database: RuntimeDatabase, sessionId: string, messageId: string, visibleIndex: number): number {
  return originalImageIndex(readChatHistoryRevisions(database, sessionId), messageId, visibleIndex);
}

/** Privacy deletion is the deliberate exception to append-only payload retention. */
export function removeChatImageEvidence(database: RuntimeDatabase, sessionId: string, messageId: string, imageIndex: number, payload: string): void {
  database.transaction(() => {
    const originalImageIndex = resolveOriginalChatImageIndex(database, sessionId, messageId, imageIndex);
    const store = new ChatJournalStore(database);
    for (const run of store.listSessionRuns(sessionId)) {
      for (const envelope of store.readAll(run.operationId)) {
          const updated = ChatJournalEventSchema.parse(removeImageFromEvent(envelope.event, envelope.operationId, messageId, imageIndex, payload));
          if (JSON.stringify(updated) !== JSON.stringify(envelope.event)) {
            database.prepare('UPDATE chat_run_events SET body_json=?, payload_digest=? WHERE operation_id=? AND sequence=?')
              .run(JSON.stringify(updated), digestChatJournalEvent(updated), run.operationId, envelope.sequence);
          }
      }
    }
    database.prepare('DELETE FROM chat_context_snapshots WHERE operation_id IN (SELECT operation_id FROM chat_runs WHERE session_id=?)').run(sessionId);
    recordChatHistoryRevision(database, sessionId, { action: 'image_removed', messageId, imageIndex, originalImageIndex, imagePathKey: null,
      payloadDigest: createHash('sha256').update(payload).digest('hex') });
  })();
}

function removeImageFromNative(message: ChatMessage, messageId: string, imageIndex: number, payload?: string): ChatMessage {
  if (!Array.isArray(message.content)) return message;
  if (payload !== undefined && message.chatMessageId === undefined && message.content.some(part => part.image_url?.url === payload)) {
    throw new Error('Image deletion requires migrated native message identities.');
  }
  if (message.chatMessageId !== messageId) return message;
  let index = 0;
  return { ...message, content: message.content.filter(part => part.type !== 'image_url' || index++ !== imageIndex) };
}

/** The live array still holds pixels already purged from durable source; apply each new removal once. */
export function applyLiveChatContextRevisions(messages: readonly ChatMessage[], revisions: readonly ChatHistoryRevision[]): ChatMessage[] {
  let retained = applyChatContextRevisions(messages, revisions);
  for (const revision of revisions) {
    if (revision.action === 'image_removed') retained = retained.map(message => removeImageFromNative(message, revision.messageId, revision.imageIndex));
  }
  return retained;
}

function removeImageFromEvent(event: ChatJournalEvent, operationId: string, messageId: string, imageIndex: number, payload: string): ChatJournalEvent {
  if (event.kind === 'tool_result' && messageId === buildChatMessageId(buildChatRunMessageIdPrefix(operationId), { kind: 'tool', toolCallId: event.call.displayToolCallId })) {
    return { ...event, images: event.images.filter((_, index) => index !== imageIndex), imageMeta: event.imageMeta.filter((_, index) => index !== imageIndex) };
  }
  if (event.kind === 'run_started' && event.userMessageId === messageId) return { ...event,
    images: event.images.filter((_, index) => index !== imageIndex), imageMeta: event.imageMeta.filter((_, index) => index !== imageIndex) };
  if (event.kind === 'queue_delivered' && event.message.id === messageId) return { ...event,
    message: { ...event.message, images: event.message.images.filter((_, index) => index !== imageIndex) },
    imageMeta: event.imageMeta.filter((_, index) => index !== imageIndex) };
  if (event.kind === 'context_initialized') return { ...event,
    messages: event.messages.map(message => removeImageFromNative(message, messageId, imageIndex, payload)) };
  if (event.kind === 'context_spliced') return { ...event,
    inserted: event.inserted.map(message => removeImageFromNative(message, messageId, imageIndex, payload)) };
  if (event.kind === 'baseline_imported') return { ...event,
    messages: event.messages.map(message => message.id === messageId ? { ...message,
      images: message.images?.filter((_, index) => index !== imageIndex), imageMeta: message.imageMeta?.filter((_, index) => index !== imageIndex) } : message),
    retainedContext: event.retainedContext.map(message => removeImageFromNative(message, messageId, imageIndex, payload)) };
  if (event.kind === 'display' && event.event.kind === 'submission' && event.event.message.id === messageId) {
    return { ...event, event: { ...event.event, message: { ...event.event.message,
      images: event.event.message.images.filter((_, index) => index !== imageIndex) } } };
  }
  if (event.kind === 'display' && event.event.kind === 'user_message' && event.event.message.id === messageId) {
    return { ...event, event: { ...event.event, message: { ...event.event.message,
      images: event.event.message.images.filter((_, index) => index !== imageIndex) } } };
  }
  return event;
}

/** Remove both sides of deleted tool exchanges while retaining other calls in the batch. */
export function applyChatContextRevisions(messages: readonly ChatMessage[], revisions: readonly ChatHistoryRevision[]): ChatMessage[] {
  let retained = [...messages];
  for (const revision of revisions) {
    if (revision.action !== 'message_deleted') continue;
    const messageIds = new Set(revision.messageIds);
    const openCalls: { id: string; assistantIndex: number }[] = [];
    const removedCalls = new Map<number, Set<string>>();
    for (const [index, message] of retained.entries()) {
      for (const call of message.tool_calls ?? []) openCalls.push({ id: call.id, assistantIndex: index });
      if (message.role !== 'tool') continue;
      const call = openCalls.shift();
      if (message.chatMessageId === undefined || !messageIds.has(message.chatMessageId)) continue;
      if (!call || call.id !== message.tool_call_id) throw new Error('Deleted tool result has no matching native declaration.');
      const ids = removedCalls.get(call.assistantIndex) ?? new Set<string>();
      ids.add(call.id);
      removedCalls.set(call.assistantIndex, ids);
    }
    retained = retained.flatMap((message, index) => {
      const next = { ...message };
      if (next.chatMessageId !== undefined && messageIds.has(next.chatMessageId)) {
        if (!next.tool_calls?.length) return [];
        delete next.content;
        delete next.chatMessageId;
      }
      if (next.thinkingMessageId !== undefined && messageIds.has(next.thinkingMessageId)) {
        delete next.reasoning_content;
        delete next.thinkingMessageId;
      }
      if (next.tool_calls === undefined) return [next];
      const toolCalls = next.tool_calls.filter(call => !removedCalls.get(index)?.has(call.id));
      if (toolCalls.length > 0) return [{ ...next, tool_calls: toolCalls }];
      delete next.tool_calls;
      return next.content || next.reasoning_content ? [next] : [];
    });
  }
  return retained;
}
