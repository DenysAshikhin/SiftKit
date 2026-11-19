import { parseJsonValueText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const ConfigRowsSchema = z.array(z.object({ id: z.number().int(), server_exl3_json: z.string() }));
// Pins only what this step needs: the engine's RamDisk object, which schema 95 added.
const StoredEngineSchema = z.object({ RamDisk: z.record(z.string(), JsonValueSchema) }).catchall(JsonValueSchema);

/** Schema 96 -> 97: SiftKit ships its own aim_ll, so the exl3 engine's RamDisk drops its ToolPath setting. */
export function upgradeExl3RamDiskBundledTool(database: RuntimeDatabase): void {
  const rows = ConfigRowsSchema.parse(database.prepare('SELECT id, server_exl3_json FROM app_config').all());
  const updateEngine = database.prepare('UPDATE app_config SET server_exl3_json = ? WHERE id = ?');
  for (const row of rows) {
    const engine = StoredEngineSchema.safeParse(parseJsonValueText(row.server_exl3_json));
    if (!engine.success) throw new Error(`Stored exl3 engine config is unreadable: ${engine.error.message}`);
    const { ToolPath: _toolPath, ...ramDisk } = engine.data.RamDisk;
    updateEngine.run(JSON.stringify({ ...engine.data, RamDisk: ramDisk }), row.id);
  }
}
