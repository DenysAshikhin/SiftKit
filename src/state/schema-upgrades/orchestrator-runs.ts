import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../database-handle.js';
import { ORCHESTRATOR_RUNS_SCHEMA_SQL } from '../runtime-schema.js';

const ExistingTableSchema = z.object({ name: z.string() }).nullable();

export function upgradeOrchestratorRuns(database: RuntimeDatabase): void {
  const existing = ExistingTableSchema.parse(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'orchestrator_%'",
  ).get() ?? null);
  if (existing) throw new Error(`Schema 77 unexpectedly contains ${existing.name}.`);
  database.exec(ORCHESTRATOR_RUNS_SCHEMA_SQL);
}
