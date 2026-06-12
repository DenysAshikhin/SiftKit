import Database from 'better-sqlite3';

type DatabaseInstance = InstanceType<typeof Database>;

export function ensureRunLogsTable(database: DatabaseInstance): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      run_kind TEXT NOT NULL
        CHECK (run_kind IN ('summary_request','failed_request','request_abandoned','repo_search','chat','plan','unknown')),
      run_group TEXT NOT NULL
        CHECK (run_group IN ('summary','repo_search','planner','chat','other')),
      terminal_state TEXT NOT NULL
        CHECK (terminal_state IN ('completed','failed','abandoned','unknown')),
      started_at_utc TEXT,
      finished_at_utc TEXT,
      title TEXT NOT NULL,
      model TEXT,
      backend TEXT,
      repo_root TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      thinking_tokens INTEGER,
      tool_tokens INTEGER,
      prompt_cache_tokens INTEGER,
      prompt_eval_tokens INTEGER,
      prompt_eval_duration_ms INTEGER,
      generation_duration_ms INTEGER,
      speculative_accepted_tokens INTEGER,
      speculative_generated_tokens INTEGER,
      duration_ms INTEGER,
      provider_duration_ms INTEGER,
      wall_duration_ms INTEGER,
      request_json TEXT,
      planner_debug_json TEXT,
      failed_request_json TEXT,
      abandoned_request_json TEXT,
      repo_search_json TEXT,
      repo_search_transcript_jsonl TEXT,
      source_paths_json TEXT NOT NULL DEFAULT '[]',
      flushed_at_utc TEXT NOT NULL,
      source_deleted_at_utc TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_logs_started ON run_logs(started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_group_started ON run_logs(run_group, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_kind_started ON run_logs(run_kind, started_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_run_logs_request_id ON run_logs(request_id);
    CREATE INDEX IF NOT EXISTS idx_run_logs_dashboard_order
      ON run_logs(COALESCE(finished_at_utc, started_at_utc, '1970-01-01T00:00:00.000Z') DESC, id DESC);
  `);
  const existingColumns = (database.prepare('PRAGMA table_info(run_logs)').all() as Array<{ name: unknown }>)
    .map((column) => String(column.name));
  if (!existingColumns.includes('speculative_accepted_tokens')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN speculative_accepted_tokens INTEGER;');
  }
  if (!existingColumns.includes('speculative_generated_tokens')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN speculative_generated_tokens INTEGER;');
  }
  if (!existingColumns.includes('prompt_eval_duration_ms')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN prompt_eval_duration_ms INTEGER;');
  }
  if (!existingColumns.includes('generation_duration_ms')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN generation_duration_ms INTEGER;');
  }
  if (!existingColumns.includes('provider_duration_ms')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN provider_duration_ms INTEGER;');
  }
  if (!existingColumns.includes('wall_duration_ms')) {
    database.exec('ALTER TABLE run_logs ADD COLUMN wall_duration_ms INTEGER;');
  }
}

export function tableExists(database: DatabaseInstance, name: string): boolean {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}
