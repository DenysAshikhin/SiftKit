import { SiftPresetSchema } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import { parseJsonValueText } from '../../lib/json.js';
import type { RuntimeDatabase } from '../database-handle.js';

const StoredCatalogRowsSchema = z.array(z.object({
  id: z.number().int(),
  presets_json: z.string(),
}));

// Pin schema-74 fields and enum values so later runtime additions cannot change this upgrade.
// Canonical field schemas retain the existing validation without admitting future fields.
const HistoricOperationPresetSchema = z.object({
  id: SiftPresetSchema.shape.id,
  label: SiftPresetSchema.shape.label,
  description: SiftPresetSchema.shape.description,
  presetKind: SiftPresetSchema.shape.presetKind.extract(['summary', 'chat', 'plan', 'repo-search', 'repo-agent']),
  operationMode: SiftPresetSchema.shape.operationMode.extract(['summary', 'read-only', 'full']),
  promptPrefix: SiftPresetSchema.shape.promptPrefix,
  allowedTools: z.array(SiftPresetSchema.shape.allowedTools.element.extract([
    'find_text', 'read_lines', 'json_filter', 'json_get',
    'read', 'grep', 'find', 'ls', 'git', 'web_search', 'web_fetch', 'write', 'edit', 'run',
  ])),
  surfaces: z.array(SiftPresetSchema.shape.surfaces.element.extract(['cli', 'web'])),
  useForSummary: SiftPresetSchema.shape.useForSummary,
  builtin: SiftPresetSchema.shape.builtin,
  deletable: SiftPresetSchema.shape.deletable,
  includeAgentsMd: SiftPresetSchema.shape.includeAgentsMd,
  includeRepoFileListing: SiftPresetSchema.shape.includeRepoFileListing,
  assistantMemory: SiftPresetSchema.shape.assistantMemory,
  autoloadFiles: SiftPresetSchema.shape.autoloadFiles,
  repoRootRequired: SiftPresetSchema.shape.repoRootRequired,
  maxTurns: SiftPresetSchema.shape.maxTurns,
}).strict();

const HistoricCatalogSchema = z.array(HistoricOperationPresetSchema);

// The caller's transaction rolls back invalid catalogs; historical run evidence stays untouched.
export function upgradePresetModelRouting(database: RuntimeDatabase): void {
  const rows = StoredCatalogRowsSchema.parse(
    database.prepare('SELECT id, presets_json FROM app_config').all(),
  );
  for (const row of rows) {
    const catalog = HistoricCatalogSchema.parse(parseJsonValueText(row.presets_json));
    const updated = catalog.map((preset) => ({ ...preset, modelPresetId: null }));
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = ?')
      .run(JSON.stringify(updated), row.id);
  }
}
