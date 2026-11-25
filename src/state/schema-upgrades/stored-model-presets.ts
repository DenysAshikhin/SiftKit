import { parseJsonValueText } from '../../lib/json.ts';
import { JsonValueSchema, type JsonValue } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';
import { readJournalEvents, replaceJournalEventBody } from './journal-event-bodies.ts';

const PresetRowsSchema = z.array(z.object({ id: z.number().int(), server_model_presets_json: z.string() }));
const SnapshotRowsSchema = z.array(z.object({ id: z.string(), model_preset_json: z.string().nullable() }));
// Pins only what preset-field steps need: stored presets and snapshots are objects.
const StoredPresetSchema = z.record(z.string(), JsonValueSchema);
const StoredPresetsSchema = z.array(StoredPresetSchema);

type StoredRecord = Readonly<Record<string, JsonValue>>;

/** `record` with the `fields` it lacks appended after its own keys; values it already stores are kept. */
export function withMissingFields(record: StoredRecord, fields: StoredRecord): StoredRecord {
  return { ...record, ...Object.fromEntries(Object.entries(fields).filter(([key]) => !(key in record))) };
}

/** Gives every stored model preset the fields it lacks, wherever one is kept: the config, each chat session's snapshot, each run's admission. */
export function addMissingModelPresetFields(database: RuntimeDatabase, fields: StoredRecord): void {
  addMissingConfigPresetFields(database, fields);
  addMissingSessionPresetFields(database, fields);
  addMissingAdmissionPresetFields(database, fields);
}

/** Keeps values a preset already stores. */
function addMissingConfigPresetFields(database: RuntimeDatabase, fields: StoredRecord): void {
  const rows = PresetRowsSchema.parse(database.prepare('SELECT id, server_model_presets_json FROM app_config').all());
  const update = database.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = ?');
  for (const row of rows) {
    const parsed = StoredPresetsSchema.safeParse(parseJsonValueText(row.server_model_presets_json));
    if (!parsed.success) throw new Error(`Stored model presets are unreadable: ${parsed.error.message}`);
    update.run(JSON.stringify(parsed.data.map((preset) => withMissingFields(preset, fields))), row.id);
  }
}

/** Keeps values a snapshot already stores. */
function addMissingSessionPresetFields(database: RuntimeDatabase, fields: StoredRecord): void {
  const rows = SnapshotRowsSchema.parse(database.prepare('SELECT id, model_preset_json FROM chat_sessions').all());
  const update = database.prepare('UPDATE chat_sessions SET model_preset_json = ? WHERE id = ?');
  for (const row of rows) {
    if (row.model_preset_json === null) continue;
    const parsed = StoredPresetSchema.safeParse(parseJsonValueText(row.model_preset_json));
    if (!parsed.success) throw new Error(`Chat session ${row.id} model preset snapshot is unreadable: ${parsed.error.message}`);
    update.run(JSON.stringify(withMissingFields(parsed.data, fields)), row.id);
  }
}

/** Gives the preset each run was admitted with the fields it lacks, keeping each event's digest in step. */
export function addMissingAdmissionPresetFields(database: RuntimeDatabase, fields: StoredRecord): void {
  for (const event of readJournalEvents(database, 'model_admitted')) {
    const preset = StoredPresetSchema.safeParse(event.body.modelPreset);
    if (!preset.success) throw new Error(`Chat journal event ${event.eventId} model preset is unreadable: ${preset.error.message}`);
    replaceJournalEventBody(database, event, { ...event.body, modelPreset: withMissingFields(preset.data, fields) });
  }
}
