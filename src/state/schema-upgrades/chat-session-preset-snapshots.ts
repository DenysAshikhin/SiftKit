import { parseJsonValueText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const SnapshotRowsSchema = z.array(z.object({ id: z.string(), model_preset_json: z.string().nullable() }));
// Pins only what this step needs from a schema-92 snapshot: an object.
const Stored92SnapshotSchema = z.record(z.string(), JsonValueSchema);
/** Fields added to model presets after sessions stored snapshots; the 91 and 92 steps migrated only the config's list. */
const ADDED_FIELDS = { SparseDraftHead: 0, CacheAuto: false, CacheContexts: 1.1 };

/** Schema 92 -> 93: chat session preset snapshots gain the fields their config presets gained in 91 and 92. */
export function upgradeChatSessionPresetSnapshots(database: RuntimeDatabase): void {
  const rows = SnapshotRowsSchema.parse(database.prepare('SELECT id, model_preset_json FROM chat_sessions').all());
  const update = database.prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?');
  for (const row of rows) {
    if (row.model_preset_json === null) continue;
    const parsed = Stored92SnapshotSchema.safeParse(parseJsonValueText(row.model_preset_json));
    if (!parsed.success) throw new Error(`Chat session ${row.id} model preset snapshot is unreadable: ${parsed.error.message}`);
    update.run(JSON.stringify({ ...ADDED_FIELDS, ...parsed.data }), row.id);
  }
}
