import { PRESET_ID_PATTERN } from '@siftkit/contracts';
import { parseJsonValueText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';
import { addMissingModelPresetFields, withMissingFields } from './stored-model-presets.ts';

const ADDED_FIELDS = { RamDiskCache: false, RamDiskCacheGiB: 10 };
const ConfigRowsSchema = z.array(z.object({ id: z.number().int(), server_model_presets_json: z.string(), server_exl3_json: z.string() }));
// Pins only what this step needs: preset ids, and objects to extend.
const StoredIdsSchema = z.array(z.object({ id: z.string() }));
const StoredObjectSchema = z.record(z.string(), JsonValueSchema);

/** Schema 94 -> 95: presets and session snapshots gain RamDiskCache/RamDiskCacheGiB, and the exl3 engine gains RamDisk. */
export function upgradeModelPresetRamDisk(database: RuntimeDatabase): void {
  const rows = ConfigRowsSchema.parse(database.prepare('SELECT id, server_model_presets_json, server_exl3_json FROM app_config').all());
  const updateEngine = database.prepare('UPDATE app_config SET server_exl3_json = ? WHERE id = ?');
  for (const row of rows) {
    const ids = StoredIdsSchema.safeParse(parseJsonValueText(row.server_model_presets_json));
    if (!ids.success) throw new Error(`Stored model presets are unreadable: ${ids.error.message}`);
    const bad = ids.data.find((preset) => !PRESET_ID_PATTERN.test(preset.id));
    if (bad !== undefined) throw new Error(`Model preset id '${bad.id}' must be lowercase words joined by dashes; rename it before upgrading.`);
    const engine = StoredObjectSchema.safeParse(parseJsonValueText(row.server_exl3_json));
    if (!engine.success) throw new Error(`Stored exl3 engine config is unreadable: ${engine.error.message}`);
    updateEngine.run(JSON.stringify(withMissingFields(engine.data, { RamDisk: { ToolPath: null, DriveLetter: 'S' } })), row.id);
  }
  addMissingModelPresetFields(database, ADDED_FIELDS);
}
