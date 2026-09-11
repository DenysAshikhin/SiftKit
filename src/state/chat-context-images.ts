import { createHash } from 'node:crypto';
import { buildChatMessageId, buildChatRunMessageIdPrefix } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import type { RuntimeDatabase } from './database-handle.js';
import { ChatJournalStore } from './chat-journal.js';
import type { ChatJournalEnvelope } from './chat-journal-schema.js';
import { readChatHistoryRevisions } from './chat-history-revisions.js';
import { PlannerChatMessagesSchema, type ChatMessage } from '../repo-search/planner-chat-message.js';

const EventLocatorRowsSchema = z.array(z.object({ operation_id: z.string(), sequence: z.number().int().positive() }));
const ToolResultLocatorRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int().positive(), display_tool_call_id: z.string(),
}));

/** Surviving admitted payloads for one display owner, counted per identical occurrence. */
type ImageInventory = Map<string, number>;

function countOccurrences(images: readonly string[]): ImageInventory {
  const inventory: ImageInventory = new Map();
  for (const image of images) inventory.set(image, (inventory.get(image) ?? 0) + 1);
  return inventory;
}

function readEnvelope(store: ChatJournalStore, operationId: string, sequence: number): ChatJournalEnvelope {
  const envelope = store.readAfter(operationId, sequence - 1, 1)[0];
  if (!envelope || envelope.sequence !== sequence) throw new Error(`Chat image owner evidence ${operationId}:${String(sequence)} is missing.`);
  return envelope;
}

/** Locates every admission, delivery, tool result or baseline row that owns `messageId`. */
function readOwnerImages(database: RuntimeDatabase, sessionId: string, messageId: string): string[][] {
  const store = new ChatJournalStore(database);
  const sources: string[][] = [];
  const admissions = EventLocatorRowsSchema.parse(database.prepare(`
    SELECT e.operation_id, e.sequence FROM chat_run_events e JOIN chat_runs r ON r.operation_id = e.operation_id
    WHERE r.session_id = ? AND (
      (e.kind = 'run_started' AND json_extract(e.body_json, '$.userMessageId') = ?)
      OR (e.kind = 'queue_delivered' AND json_extract(e.body_json, '$.message.id') = ?)
      OR e.kind = 'baseline_imported'
    ) ORDER BY r.run_order, e.sequence
  `).all(sessionId, messageId, messageId));
  for (const row of admissions) {
    const { event } = readEnvelope(store, row.operation_id, row.sequence);
    if (event.kind === 'run_started') sources.push(event.images);
    else if (event.kind === 'queue_delivered') sources.push(event.message.images);
    else if (event.kind === 'baseline_imported') {
      const baseline = event.messages.find(message => message.id === messageId);
      if (baseline) sources.push(baseline.images ?? []);
    }
  }
  const toolResults = ToolResultLocatorRowsSchema.parse(database.prepare(`
    SELECT e.operation_id, e.sequence, json_extract(e.body_json, '$.call.displayToolCallId') AS display_tool_call_id
    FROM chat_run_events e JOIN chat_runs r ON r.operation_id = e.operation_id
    WHERE r.session_id = ? AND e.kind = 'tool_result' ORDER BY r.run_order, e.sequence
  `).all(sessionId));
  for (const row of toolResults) {
    const owner = buildChatMessageId(buildChatRunMessageIdPrefix(row.operation_id), { kind: 'tool', toolCallId: row.display_tool_call_id });
    if (owner !== messageId) continue;
    const { event } = readEnvelope(store, row.operation_id, row.sequence);
    if (event.kind === 'tool_result') sources.push(event.images);
  }
  return sources;
}

function readSurvivingInventory(database: RuntimeDatabase, sessionId: string, messageId: string): ImageInventory {
  const sources = readOwnerImages(database, sessionId, messageId);
  const [first, ...rest] = sources;
  if (first === undefined) throw new Error(`Chat image owner ${messageId} has no admitted evidence to sanitize against.`);
  // Forced delivery repeats one identity in admission and queue evidence; the copies must agree and count once.
  for (const copy of rest) {
    if (JSON.stringify(copy) !== JSON.stringify(first)) throw new Error(`Chat image owner ${messageId} has conflicting admitted evidence.`);
  }
  return countOccurrences(first);
}

function keepSurvivingParts(message: ChatMessage, inventory: ImageInventory): ChatMessage {
  if (!Array.isArray(message.content)) return message;
  const remaining = new Map(inventory);
  const content = message.content.filter(part => {
    if (part.type !== 'image_url' || !part.image_url) return true;
    const count = remaining.get(part.image_url.url) ?? 0;
    if (count === 0) return false;
    remaining.set(part.image_url.url, count - 1);
    return true;
  });
  return content.length === message.content.length ? message : { ...message, content };
}

/**
 * Filters a proposed context write against the session's committed image deletions. Call inside
 * the append transaction: a deletion that commits first is seen here, one that commits later sweeps.
 */
export function sanitizeChatContextImages(database: RuntimeDatabase, sessionId: string, messages: readonly ChatMessage[]): ChatMessage[] {
  const proposal = PlannerChatMessagesSchema.parse(messages);
  const removals = readChatHistoryRevisions(database, sessionId).flatMap(revision => revision.action === 'image_removed' ? [revision] : []);
  if (removals.length === 0) return proposal;
  const affectedOwners = new Set(removals.map(revision => revision.messageId));
  const deletedDigests = new Set(removals.map(revision => revision.payloadDigest));
  const inventories = new Map<string, ImageInventory>();
  return proposal.map(message => {
    if (!Array.isArray(message.content)) return message;
    const urls = message.content.flatMap(part => part.type === 'image_url' && part.image_url ? [part.image_url.url] : []);
    if (urls.length === 0) return message;
    if (message.chatMessageId === undefined) {
      if (urls.some(url => deletedDigests.has(createHash('sha256').update(url).digest('hex')))) {
        throw new Error('A deleted chat image has no attributable display owner in this context write.');
      }
      return message;
    }
    if (!affectedOwners.has(message.chatMessageId)) return message;
    let inventory = inventories.get(message.chatMessageId);
    if (!inventory) {
      inventory = readSurvivingInventory(database, sessionId, message.chatMessageId);
      inventories.set(message.chatMessageId, inventory);
    }
    return keepSurvivingParts(message, inventory);
  });
}
