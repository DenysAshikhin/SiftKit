import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { ensureDirectory } from '../lib/fs.js';
import { findNearestSiftKitRepoRoot } from '../lib/paths.js';

export type RuntimeDatabase = InstanceType<typeof Database>;

const CURRENT_SCHEMA_VERSION = 2;

let cachedDatabasePath: string | null = null;
let cachedDatabase: RuntimeDatabase | null = null;

function getSchemaVersion(database: RuntimeDatabase): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);
  const row = database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get() as { version?: number } | undefined;
  return Number.isFinite(row?.version) ? Number(row?.version) : 0;
}

function setSchemaVersion(database: RuntimeDatabase, version: number): void {
  database.prepare(`
    INSERT INTO runtime_schema (id, version)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version
  `).run(version);
}

function applyBaseSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      backend TEXT NOT NULL,
      policy_mode TEXT NOT NULL,
      raw_log_retention INTEGER NOT NULL CHECK (raw_log_retention IN (0, 1)),
      prompt_prefix TEXT,
      runtime_model TEXT,
      llama_base_url TEXT,
      llama_num_ctx INTEGER,
      llama_model_path TEXT,
      llama_temperature REAL,
      llama_top_p REAL,
      llama_top_k INTEGER,
      llama_min_p REAL,
      llama_presence_penalty REAL,
      llama_repetition_penalty REAL,
      llama_max_tokens INTEGER,
      llama_gpu_layers INTEGER,
      llama_threads INTEGER,
      llama_flash_attention INTEGER CHECK (llama_flash_attention IN (0, 1) OR llama_flash_attention IS NULL),
      llama_parallel_slots INTEGER,
      llama_reasoning TEXT,
      thresholds_min_characters_for_summary INTEGER NOT NULL,
      thresholds_min_lines_for_summary INTEGER NOT NULL,
      interactive_enabled INTEGER NOT NULL CHECK (interactive_enabled IN (0, 1)),
      interactive_wrapped_commands_json TEXT NOT NULL,
      interactive_idle_timeout_ms INTEGER NOT NULL,
      interactive_max_transcript_characters INTEGER NOT NULL,
      interactive_transcript_retention INTEGER NOT NULL CHECK (interactive_transcript_retention IN (0, 1)),
      server_startup_script TEXT,
      server_shutdown_script TEXT,
      server_startup_timeout_ms INTEGER,
      server_healthcheck_timeout_ms INTEGER,
      server_healthcheck_interval_ms INTEGER,
      server_verbose_logging INTEGER CHECK (server_verbose_logging IN (0, 1) OR server_verbose_logging IS NULL),
      server_verbose_args_json TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status_text TEXT NOT NULL
        CHECK (status_text IN ('true', 'false', 'lock_requested', 'foreign_lock')),
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_metrics_totals (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      input_characters_total INTEGER NOT NULL,
      output_characters_total INTEGER NOT NULL,
      input_tokens_total INTEGER NOT NULL,
      output_tokens_total INTEGER NOT NULL,
      thinking_tokens_total INTEGER NOT NULL,
      tool_tokens_total INTEGER NOT NULL,
      prompt_cache_tokens_total INTEGER NOT NULL,
      prompt_eval_tokens_total INTEGER NOT NULL,
      request_duration_ms_total INTEGER NOT NULL,
      completed_request_count INTEGER NOT NULL,
      task_totals_json TEXT NOT NULL,
      tool_stats_json TEXT NOT NULL,
      updated_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS observed_budget_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      observed_telemetry_seen INTEGER NOT NULL CHECK (observed_telemetry_seen IN (0, 1)),
      last_known_chars_per_token REAL,
      updated_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      context_window_tokens INTEGER NOT NULL,
      thinking_enabled INTEGER NOT NULL CHECK (thinking_enabled IN (0, 1)),
      mode TEXT NOT NULL CHECK (mode IN ('chat', 'plan', 'repo-search')),
      plan_repo_root TEXT NOT NULL,
      condensed_summary TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      input_tokens_estimate INTEGER NOT NULL,
      output_tokens_estimate INTEGER NOT NULL,
      thinking_tokens INTEGER NOT NULL,
      input_tokens_estimated INTEGER NOT NULL CHECK (input_tokens_estimated IN (0, 1)),
      output_tokens_estimated INTEGER NOT NULL CHECK (output_tokens_estimated IN (0, 1)),
      thinking_tokens_estimated INTEGER NOT NULL CHECK (thinking_tokens_estimated IN (0, 1)),
      prompt_cache_tokens INTEGER,
      prompt_eval_tokens INTEGER,
      associated_tool_tokens INTEGER,
      thinking_content TEXT,
      created_at_utc TEXT NOT NULL,
      source_run_id TEXT,
      compressed_into_summary INTEGER NOT NULL CHECK (compressed_into_summary IN (0, 1)),
      position INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS chat_hidden_tool_contexts (
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      source_message_id TEXT,
      created_at_utc TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_results (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_artifacts (
      id TEXT PRIMARY KEY,
      artifact_kind TEXT NOT NULL,
      request_id TEXT,
      title TEXT,
      content_text TEXT,
      content_json TEXT,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_kind_created
      ON runtime_artifacts(artifact_kind, created_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_request
      ON runtime_artifacts(request_id, created_at_utc DESC);
  `);
}

function ensureRuntimeArtifactsSchema(database: RuntimeDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_artifacts (
      id TEXT PRIMARY KEY,
      artifact_kind TEXT NOT NULL,
      request_id TEXT,
      title TEXT,
      content_text TEXT,
      content_json TEXT,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_kind_created
      ON runtime_artifacts(artifact_kind, created_at_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_request
      ON runtime_artifacts(request_id, created_at_utc DESC);
  `);
}

function ensureSchema(database: RuntimeDatabase): void {
  database.exec('PRAGMA foreign_keys = ON;');
  const currentVersion = getSchemaVersion(database);
  if (currentVersion <= 0) {
    applyBaseSchema(database);
    setSchemaVersion(database, CURRENT_SCHEMA_VERSION);
    return;
  }
  if (currentVersion < 2) {
    ensureRuntimeArtifactsSchema(database);
    setSchemaVersion(database, 2);
  }
}

export function getRepoRuntimeRoot(startPath: string = process.cwd()): string {
  const repoRoot = findNearestSiftKitRepoRoot(startPath);
  if (!repoRoot) {
    throw new Error('SiftKit runtime requires running inside a siftkit repo.');
  }
  return path.join(repoRoot, '.siftkit');
}

export function getRuntimeDatabasePath(startPath: string = process.cwd()): string {
  return path.join(getRepoRuntimeRoot(startPath), 'runtime.sqlite');
}

export function getRuntimeDatabase(databasePath: string = getRuntimeDatabasePath()): RuntimeDatabase {
  const resolvedPath = path.resolve(databasePath);
  if (cachedDatabase && cachedDatabasePath === resolvedPath) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.close();
    cachedDatabase = null;
    cachedDatabasePath = null;
  }
  ensureDirectory(path.dirname(resolvedPath));
  let database: RuntimeDatabase = new Database(resolvedPath);
  try {
    ensureSchema(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a database|SQLITE_NOTADB/iu.test(message)) {
      throw error;
    }
    try {
      database.close();
    } catch {
      // Best effort close before reset.
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const targetPath = `${resolvedPath}${suffix}`;
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true });
      }
    }
    database = new Database(resolvedPath);
    ensureSchema(database);
  }
  cachedDatabase = database;
  cachedDatabasePath = resolvedPath;
  return database;
}

export function closeRuntimeDatabase(): void {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.close();
  cachedDatabase = null;
  cachedDatabasePath = null;
}

export function getRuntimeMetadataValue(
  key: string,
  databasePath: string = getRuntimeDatabasePath(),
): string | null {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    return null;
  }
  const database = getRuntimeDatabase(databasePath);
  const row = database.prepare(`
    SELECT value
    FROM runtime_metadata
    WHERE key = ?
    LIMIT 1
  `).get(normalizedKey) as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

export function setRuntimeMetadataValue(
  key: string,
  value: string,
  databasePath: string = getRuntimeDatabasePath(),
): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('Runtime metadata key is required.');
  }
  const database = getRuntimeDatabase(databasePath);
  database.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    normalizedKey,
    String(value || ''),
    new Date().toISOString(),
  );
}
