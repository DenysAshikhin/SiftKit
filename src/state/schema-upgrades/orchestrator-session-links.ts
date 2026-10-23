import { parseJsonValueText } from '../../lib/json.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const ColumnNameRowsSchema = z.array(z.object({ name: z.string() }));
const StoredRunRowsSchema = z.array(z.object({ run_id: z.string(), state_json: z.string() }));
// Pins only what this step reads: a schema-82 request may not name a session yet.
const StoredRunStateSchema = z.object({ request: z.object({ sessionId: z.string().uuid().nullable().optional() }).loose() }).loose();

function columnsOf(database: RuntimeDatabase, table: string): string[] {
  const columns = ColumnNameRowsSchema.parse(database.prepare('SELECT name FROM pragma_table_info(?)').all(table)).map((row) => row.name);
  if (columns.length === 0) throw new Error(`Schema 82 is missing ${table}; cannot link orchestrator runs to sessions.`);
  return columns;
}

/**
 * Schema 82 -> 83: a chat session records the orchestrator run it shows, which replaces finding runs by
 * repository (`repo_key`). Runs recorded before the link were started without a session.
 */
export function upgradeOrchestratorSessionLinks(database: RuntimeDatabase): void {
  if (!columnsOf(database, 'chat_sessions').includes('orchestrator_run_id')) {
    database.exec('ALTER TABLE chat_sessions ADD COLUMN orchestrator_run_id TEXT');
  }
  if (columnsOf(database, 'orchestrator_runs').includes('repo_key')) {
    database.exec('DROP INDEX IF EXISTS idx_orchestrator_runs_repo_key; ALTER TABLE orchestrator_runs DROP COLUMN repo_key;');
  }
  const update = database.prepare('UPDATE orchestrator_runs SET state_json = ? WHERE run_id = ?');
  for (const row of StoredRunRowsSchema.parse(database.prepare('SELECT run_id, state_json FROM orchestrator_runs').all())) {
    const state = StoredRunStateSchema.parse(parseJsonValueText(row.state_json));
    if (state.request.sessionId !== undefined) continue;
    update.run(JSON.stringify({ ...state, request: { ...state.request, sessionId: null } }), row.run_id);
  }
}
