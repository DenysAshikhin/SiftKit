import { parseJsonValueText } from '../../lib/json.ts';
import { JsonObjectSchema, JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const AttemptRowsSchema = z.array(z.object({ child_run_id: z.string(), attempt_json: z.string() }));
const CatalogRowsSchema = z.array(z.object({ id: z.number().int(), presets_json: z.string() }));
// Pins only what this step reads from schema-88 attempts and catalogs.
const Stored88AttemptSchema = z.object({
  result: z.object({
    report: z.object({ kind: z.enum(['agent', 'search']) }).catchall(JsonValueSchema).nullable(),
  }).catchall(JsonValueSchema).nullable(),
}).catchall(JsonValueSchema);
const Stored88CatalogSchema = z.array(z.object({ id: z.string(), description: z.string() }).catchall(JsonValueSchema));

// Literals, so later catalog edits cannot change what this upgrade matches or writes.
const ORCHESTRATOR_DESCRIPTION_88 = 'Prepares an implementation plan, delegates bounded steps to repo-agent and repo-search workers, and verifies each one.';
const ORCHESTRATOR_DESCRIPTION_89 = 'Plans from its own reading of the repository, delegates each task to a repo-agent worker, and verifies and reviews every one.';

function isStockOrchestrator(preset: z.infer<typeof Stored88CatalogSchema>[number]): boolean {
  return preset.id === 'orchestrator' && preset.description === ORCHESTRATOR_DESCRIPTION_88;
}

/** Schema 88 -> 89: one worker kind. Reports lose `kind`; a survey's search report, which no longer exists, becomes null. */
export function upgradeOrchestratorSingleWorker(database: RuntimeDatabase): void {
  const updateAttempt = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of AttemptRowsSchema.parse(database.prepare('SELECT child_run_id, attempt_json FROM orchestrator_attempts').all())) {
    const attempt = Stored88AttemptSchema.parse(JsonObjectSchema.parse(parseJsonValueText(row.attempt_json)));
    const report = attempt.result?.report ?? null;
    if (attempt.result === null || report === null) continue;
    const { kind, ...rest } = report;
    updateAttempt.run(JSON.stringify({ ...attempt, result: { ...attempt.result, report: kind === 'agent' ? rest : null } }), row.child_run_id);
  }
  const updateCatalog = database.prepare('UPDATE app_config SET presets_json = ? WHERE id = ?');
  for (const row of CatalogRowsSchema.parse(database.prepare('SELECT id, presets_json FROM app_config').all())) {
    const catalog = Stored88CatalogSchema.parse(parseJsonValueText(row.presets_json));
    if (!catalog.some(isStockOrchestrator)) continue;
    const updated = catalog.map((preset) => (isStockOrchestrator(preset) ? { ...preset, description: ORCHESTRATOR_DESCRIPTION_89 } : preset));
    updateCatalog.run(JSON.stringify(updated), row.id);
  }
}
