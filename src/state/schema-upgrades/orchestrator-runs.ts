import { existsSync } from 'node:fs';

import { parseJsonValueText } from '../../lib/json.js';
import { canonicalRepositoryKey } from '../../lib/repository-key.js';
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../database-handle.js';

const ExistingTableSchema = z.object({ name: z.string() }).nullable();

// A literal, so later schema edits cannot change what the 77 to 78 upgrade creates.
export const ORCHESTRATOR_RUNS_78_SQL = `
  CREATE TABLE IF NOT EXISTS orchestrator_runs (
    run_id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    revision INTEGER NOT NULL,
    phase TEXT NOT NULL,
    state_json TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orchestrator_attempts (
    run_id TEXT NOT NULL REFERENCES orchestrator_runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('implementation', 'drift_fix')),
    attempt INTEGER NOT NULL CHECK (attempt IN (1, 2)),
    child_run_id TEXT NOT NULL UNIQUE,
    attempt_json TEXT NOT NULL,
    PRIMARY KEY (run_id, task_id, purpose, attempt)
  );
  CREATE TABLE IF NOT EXISTS orchestrator_events (
    run_id TEXT NOT NULL REFERENCES orchestrator_runs(run_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
  );
`;

export function upgradeOrchestratorRuns(database: RuntimeDatabase): void {
  const existing = ExistingTableSchema.parse(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'orchestrator_%'",
  ).get() ?? null);
  if (existing) throw new Error(`Schema 77 unexpectedly contains ${existing.name}.`);
  database.exec(ORCHESTRATOR_RUNS_78_SQL);
}

const StoredRunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
const StoredRequestSchema = z.object({ request: z.object({ repoRoot: z.string().min(1) }).loose() }).loose();

/** Keys every stored run by repository identity; a repository that no longer exists has none. */
export function upgradeOrchestratorRepoKey(database: RuntimeDatabase): void {
  database.exec(`
    ALTER TABLE orchestrator_runs ADD COLUMN repo_key TEXT;
    CREATE INDEX idx_orchestrator_runs_repo_key ON orchestrator_runs (repo_key, created_at_utc);
  `);
  const update = database.prepare('UPDATE orchestrator_runs SET repo_key = ? WHERE run_id = ?');
  for (const row of StoredRunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const { repoRoot } = StoredRequestSchema.parse(parseJsonValueText(row.state_json)).request;
    update.run(existsSync(repoRoot) ? canonicalRepositoryKey(repoRoot) : null, row.run_id);
  }
}
