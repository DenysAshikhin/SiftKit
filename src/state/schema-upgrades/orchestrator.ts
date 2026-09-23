import { SiftPresetSchema } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import { parseJsonValueText } from '../../lib/json.js';
import type { RuntimeDatabase } from '../database-handle.js';
import { HistoricOperationPresetSchema } from './preset-model-routing.js';

const StoredCatalogRowsSchema = z.array(z.object({
  id: z.number().int(),
  presets_json: z.string(),
}));

// Pins the schema-76 record: the schema-74 fields plus model routing, and no orchestrator options.
const Historic76CatalogSchema = z.array(HistoricOperationPresetSchema.extend({
  modelPresetId: SiftPresetSchema.shape.modelPresetId,
}).strict());

// A literal, so later catalog edits cannot change what this upgrade writes.
const ORCHESTRATOR_BUILTIN_77 = {
  id: 'orchestrator',
  label: 'Orchestrator',
  description: 'Prepares an implementation plan, delegates bounded steps to repo-agent and repo-search workers, and verifies each one.',
  presetKind: 'orchestrator',
  operationMode: 'read-only',
  promptPrefix: '',
  allowedTools: ['read', 'grep', 'find', 'ls', 'git'],
  surfaces: ['cli', 'web'],
  useForSummary: false,
  builtin: true,
  deletable: false,
  includeAgentsMd: true,
  includeRepoFileListing: true,
  assistantMemory: false,
  autoloadFiles: [],
  repoRootRequired: true,
  maxTurns: 45,
  modelPresetId: null,
  orchestrator: { maxSubagents: 1 },
} as const;

export function upgradeOrchestratorPreset(database: RuntimeDatabase): void {
  const rows = StoredCatalogRowsSchema.parse(database.prepare('SELECT id, presets_json FROM app_config').all());
  for (const row of rows) {
    const catalog = Historic76CatalogSchema.parse(parseJsonValueText(row.presets_json));
    if (catalog.some((preset) => preset.id === ORCHESTRATOR_BUILTIN_77.id)) {
      throw new Error("Custom preset 'orchestrator' conflicts with the built-in orchestrator preset; rename it before upgrading to schema 77.");
    }
    const updated = [...catalog.map((preset) => ({ ...preset, orchestrator: null })), ORCHESTRATOR_BUILTIN_77];
    database.prepare('UPDATE app_config SET presets_json = ? WHERE id = ?').run(JSON.stringify(updated), row.id);
  }
}
