import { z } from '../../lib/zod.js';
import { stableStringify } from '../../lib/json.js';
import { digestStableJson } from '../../lib/json-digest.js';
import { JsonObjectSchema, type JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../database-handle.js';

/** Both progress shapes a marker-73 file can hold: the pre-batching whole-text payload and the delta that replaced it. Migration-only. */
const ProgressBodySchema = z.strictObject({
  kind: z.literal('display'),
  event: z.union([
    z.strictObject({ kind: z.literal('progress'), progress: z.strictObject({ turn: z.number().int().nonnegative(), text: z.string(), elapsedMs: z.number().nonnegative() }) }),
    z.strictObject({ kind: z.literal('progress'), delta: z.strictObject({ turn: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), text: z.string() }) }),
  ]),
});

const DisplayKindSchema = z.object({ kind: z.literal('display'), event: z.object({ kind: z.string() }) });

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int().positive(), event_id: z.string(), body_json: z.string(), payload_digest: z.string(),
}));

/**
 * 73 -> 74. Progress display events written before delta batching carried the whole bar text; the
 * reader now wants a delta, and offset 0 is the reducer's replace, so the same text at offset 0
 * projects identically. Rows already in delta shape are left alone; a progress row that fits neither
 * shape, or whose digest is corrupt, aborts the whole transaction.
 */
export function upgradeChatProgressEventsToDeltas(database: RuntimeDatabase): void {
  const rows = EventRowsSchema.parse(database.prepare(`
    SELECT operation_id, sequence, event_id, body_json, payload_digest FROM chat_run_events
    WHERE kind = 'display' AND body_json LIKE '%"kind":"progress"%' ORDER BY operation_id, sequence
  `).all());
  const update = database.prepare('UPDATE chat_run_events SET body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?');
  for (const row of rows) {
    const label = `Chat journal event ${row.event_id} in run ${row.operation_id}`;
    let body: JsonObject;
    try { body = JsonObjectSchema.parse(JSON.parse(row.body_json)); }
    catch (error) { throw new Error(`${label} has a malformed payload.`, { cause: error }); }
    const display = DisplayKindSchema.safeParse(body);
    if (!display.success || display.data.event.kind !== 'progress') continue;
    if (digestStableJson(body) !== row.payload_digest) throw new Error(`${label} has a corrupt payload digest.`);
    const progress = ProgressBodySchema.safeParse(body);
    if (!progress.success) throw new Error(`${label} has an invalid progress payload.`, { cause: progress.error });
    if ('delta' in progress.data.event) continue;
    const { turn, text } = progress.data.event.progress;
    const upgraded = { kind: 'display', event: { kind: 'progress', delta: { turn, offset: 0, text } } } satisfies JsonObject;
    update.run(stableStringify(upgraded), digestStableJson(upgraded), row.operation_id, row.sequence);
  }
}