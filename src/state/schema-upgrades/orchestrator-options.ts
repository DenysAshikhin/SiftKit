import { SiftPresetSchema } from '@siftkit/contracts';
import { z } from '../../lib/zod.ts';
import { parseJsonValueText } from '../../lib/json.ts';
import type { RuntimeDatabase } from '../database-handle.ts';
import { HistoricOperationPresetSchema } from './preset-model-routing.ts';

const StoredCatalogRowsSchema = z.array(z.object({
  id: z.number().int(),
  presets_json: z.string(),
}));

// Pins the schema-79 record: the schema-76 fields, the orchestrator kind, and its subagent cap.
const Historic79CatalogSchema = z.array(HistoricOperationPresetSchema.extend({
  presetKind: SiftPresetSchema.shape.presetKind.extract(['summary', 'chat', 'plan', 'repo-search', 'repo-agent', 'orchestrator']),
  modelPresetId: SiftPresetSchema.shape.modelPresetId,
  orchestrator: z.object({ maxSubagents: z.number().int().positive() }).strict().nullable(),
}).strict());

/** Concurrency now follows the worker model's parallel slots, so the stored subagent cap is dropped. */
export function upgradeOrchestratorOptions(database: RuntimeDatabase): void {
  const rows = StoredCatalogRowsSchema.parse(database.prepare('SELECT id, presets_json FROM app_config').all());
  for (const row of rows) {
    const catalog = Historic79CatalogSchema.parse(parseJsonValueText(row.presets_json));
    const updated = catalog.map(({ orchestrator: _removed, ...preset }) => preset);
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = ?').run(JSON.stringify(updated), row.id);
  }
}
