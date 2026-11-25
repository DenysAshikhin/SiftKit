import { digestStableJson } from '../../lib/json-digest.ts';
import { parseJsonObjectText } from '../../lib/json.ts';
import type { JsonObject } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const EventRowsSchema = z.array(z.object({
  operation_id: z.string(), sequence: z.number().int(), event_id: z.string(), body_json: z.string(), payload_digest: z.string(),
}));

export type StoredJournalEvent = { operationId: string; sequence: number; eventId: string; body: JsonObject };

/** Every stored event of one kind; a corrupt digest aborts the upgrade. */
export function readJournalEvents(database: RuntimeDatabase, kind: string): StoredJournalEvent[] {
  const rows = EventRowsSchema.parse(database.prepare(
    'SELECT operation_id, sequence, event_id, body_json, payload_digest FROM chat_run_events WHERE kind = ?',
  ).all(kind));
  return rows.map((row) => {
    const body = parseJsonObjectText(row.body_json);
    if (digestStableJson(body) !== row.payload_digest) throw new Error(`Chat journal event ${row.event_id} has a corrupt payload digest.`);
    return { operationId: row.operation_id, sequence: row.sequence, eventId: row.event_id, body };
  });
}

/** Stores a new body for an event and keeps its digest in step. */
export function replaceJournalEventBody(database: RuntimeDatabase, event: StoredJournalEvent, body: JsonObject): void {
  database.prepare('UPDATE chat_run_events SET body_json = ?, payload_digest = ? WHERE operation_id = ? AND sequence = ?')
    .run(JSON.stringify(body), digestStableJson(body), event.operationId, event.sequence);
}
