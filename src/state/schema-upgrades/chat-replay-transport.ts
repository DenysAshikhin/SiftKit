import { createHash } from 'node:crypto';
import { z } from '../../lib/zod.js';
import { stableStringify } from '../../lib/json.js';
import { JsonObjectSchema, JsonValueSchema } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../database-handle.js';

const LEGACY_EVENT_VERSION = 1;
const UPGRADED_EVENT_VERSION = 2;

/** Frozen v1 splice: the exact top-level keys that shipped, bodies kept opaque. Migration-only. */
const LegacyContextSplicedEventSchema = z.strictObject({
  kind: z.literal('context_spliced'),
  compressedMessageIds: z.array(z.string()).optional(),
  queueMessageIds: z.array(z.string()).optional(),
  expectedRevision: z.number().int().nonnegative(),
  contextRevision: z.number().int().positive(),
  startIndex: z.number().int().nonnegative(),
  deleteCount: z.number().int().nonnegative(),
  inserted: z.array(JsonObjectSchema),
  turnBoundary: z.number().int().nonnegative(),
  reason: z.string(),
});

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int().positive(), event_id: z.string(),
  version: z.number().int(), kind: z.string(), body_json: z.string(), payload_digest: z.string(),
}));

function digestBody(body: z.infer<typeof JsonValueSchema>): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * 70 -> 71. Journal events move to version 2: every `context_spliced` body gains the required
 * `coalescedToolCallIds` list (empty for history, which never declared one). Every row's digest is
 * verified before it is touched; an unknown version or corrupt row aborts the whole transaction.
 */
export function upgradeChatJournalEventsToVersion2(database: RuntimeDatabase): void {
  const rows = EventRowsSchema.parse(database.prepare(
    'SELECT operation_id, sequence, event_id, version, kind, body_json, payload_digest FROM chat_run_events ORDER BY operation_id, sequence',
  ).all());
  const update = database.prepare('UPDATE chat_run_events SET version = ?, body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?');
  for (const row of rows) {
    const label = `Chat journal event ${row.event_id} in run ${row.operation_id}`;
    if (row.version !== LEGACY_EVENT_VERSION) throw new Error(`${label} has unsupported version ${String(row.version)}; expected ${String(LEGACY_EVENT_VERSION)}.`);
    let body: z.infer<typeof JsonObjectSchema>;
    try { body = JsonObjectSchema.parse(JSON.parse(row.body_json)); }
    catch (error) { throw new Error(`${label} has a malformed payload.`, { cause: error }); }
    if (digestBody(body) !== row.payload_digest) throw new Error(`${label} has a corrupt payload digest.`);
    if (row.kind !== 'context_spliced') {
      update.run(UPGRADED_EVENT_VERSION, row.body_json, row.payload_digest, row.operation_id, row.sequence);
      continue;
    }
    const splice = LegacyContextSplicedEventSchema.parse(body);
    const upgraded = JsonObjectSchema.parse({ ...splice, coalescedToolCallIds: [] });
    update.run(UPGRADED_EVENT_VERSION, JSON.stringify(upgraded), digestBody(upgraded), row.operation_id, row.sequence);
  }
}
