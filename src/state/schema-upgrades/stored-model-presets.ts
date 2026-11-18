import { parseJsonValueText } from '../../lib/json.ts';
import { JsonValueSchema, type JsonValue } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const PresetRowsSchema = z.array(z.object({ id: z.number().int(), server_model_presets_json: z.string() }));
// Pins only what preset-field steps need from stored model presets: a list of objects.
const StoredPresetsSchema = z.array(z.record(z.string(), JsonValueSchema));

type StoredRecord = Readonly<Record<string, JsonValue>>;

/** `record` with the `fields` it lacks appended after its own keys; values it already stores are kept. */
export function withMissingFields(record: StoredRecord, fields: StoredRecord): StoredRecord {
  return { ...record, ...Object.fromEntries(Object.entries(fields).filter(([key]) => !(key in record))) };
}

/** Gives every stored model preset the fields it lacks, keeping values a preset already stores. */
export function addMissingStoredPresetFields(database: RuntimeDatabase, fields: StoredRecord): void {
  const rows = PresetRowsSchema.parse(database.prepare('SELECT id, server_model_presets_json FROM app_config').all());
  const update = database.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = ?');
  for (const row of rows) {
    const parsed = StoredPresetsSchema.safeParse(parseJsonValueText(row.server_model_presets_json));
    if (!parsed.success) throw new Error(`Stored model presets are unreadable: ${parsed.error.message}`);
    update.run(JSON.stringify(parsed.data.map((preset) => withMissingFields(preset, fields))), row.id);
  }
}
