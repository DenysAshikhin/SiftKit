import { parseJsonValueText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const PresetRowsSchema = z.array(z.object({ id: z.number().int(), server_model_presets_json: z.string() }));
// Pins only what this step needs from schema-91 model presets: a list of objects.
const Stored91PresetsSchema = z.array(z.record(z.string(), JsonValueSchema));

/** Schema 91 -> 92: model presets gain `CacheAuto` and `CacheContexts`; stored presets keep their manual MiB sizes. */
export function upgradeModelPresetCacheAuto(database: RuntimeDatabase): void {
  const rows = PresetRowsSchema.parse(database.prepare('SELECT id, server_model_presets_json FROM app_config').all());
  const update = database.prepare('UPDATE app_config SET server_model_presets_json = ? WHERE id = ?');
  for (const row of rows) {
    const parsed = Stored91PresetsSchema.safeParse(parseJsonValueText(row.server_model_presets_json));
    if (!parsed.success) throw new Error(`Stored model presets are unreadable: ${parsed.error.message}`);
    const presets = parsed.data.map((preset) => ('CacheAuto' in preset ? preset : { ...preset, CacheAuto: false, CacheContexts: 1.1 }));
    update.run(JSON.stringify(presets), row.id);
  }
}
