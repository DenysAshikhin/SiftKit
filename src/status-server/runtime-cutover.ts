import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Dict } from '../lib/types.js';
import {
  getRuntimeDatabase,
  getRuntimeDatabasePath,
  getRuntimeMetadataValue,
  setRuntimeMetadataValue,
  type RuntimeDatabase,
} from '../state/runtime-db.js';
import { saveChatSession } from '../state/chat-sessions.js';
import { normalizeObservedBudgetState, writeObservedBudgetState } from '../state/observed-budget.js';
import { upsertRuntimeJsonArtifact, upsertRuntimeTextArtifact } from '../state/runtime-artifacts.js';
import { getRuntimeRoot } from './paths.js';
import { writeConfig } from './config-store.js';
import { writeStatusText } from './status-file.js';
import { normalizeMetrics, writeMetrics, type Metrics } from './metrics.js';
import { ensureIdleSummarySnapshotsTable } from './idle-summary.js';
import { ensureRunLogsTable, migrateExistingRunLogsToDbAndDeleteBounded } from './dashboard-runs.js';

const RUNTIME_CUTOVER_MARKER_KEY = 'runtime_cutover_v1_complete';

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).replace(/\\/gu, '/');
}

function listFilesRecursive(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }
  const output: string[] = [];
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const targetPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(targetPath);
      } else if (entry.isFile()) {
        output.push(targetPath);
      }
    }
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function readLegacyJsonObject(targetPath: string): Dict {
  const text = fs.readFileSync(targetPath, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${targetPath}`);
  }
  return parsed as Dict;
}

function deleteFileAndSqliteSidecars(targetPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${targetPath}${suffix}`;
    if (!fs.existsSync(candidate)) {
      continue;
    }
    fs.rmSync(candidate, { force: true });
  }
}

function importLegacyConfig(runtimeRoot: string, databasePath: string): void {
  const legacyPath = path.join(runtimeRoot, 'config.json');
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  const configPayload = readLegacyJsonObject(legacyPath);
  writeConfig(databasePath, configPayload);
  fs.rmSync(legacyPath, { force: true });
}

function importLegacyStatus(runtimeRoot: string, databasePath: string): void {
  const legacyPath = path.join(runtimeRoot, 'status', 'inference.txt');
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  const statusText = fs.readFileSync(legacyPath, 'utf8').trim().toLowerCase();
  writeStatusText(databasePath, statusText);
  fs.rmSync(legacyPath, { force: true });
}

function importLegacyMetrics(runtimeRoot: string, databasePath: string): void {
  const candidates = [
    path.join(runtimeRoot, 'metrics', 'compression.json'),
    path.join(runtimeRoot, 'status', 'compression-metrics.json'),
  ];
  for (const legacyPath of candidates) {
    if (!fs.existsSync(legacyPath)) {
      continue;
    }
    const payload = readLegacyJsonObject(legacyPath);
    writeMetrics(databasePath, normalizeMetrics(payload as Metrics));
    fs.rmSync(legacyPath, { force: true });
    return;
  }
}

function importLegacyObservedBudget(runtimeRoot: string): void {
  const legacyPath = path.join(runtimeRoot, 'metrics', 'observed-budget.json');
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  const payload = readLegacyJsonObject(legacyPath);
  writeObservedBudgetState(normalizeObservedBudgetState(payload));
  fs.rmSync(legacyPath, { force: true });
}

function importLegacyChatSessions(runtimeRoot: string): void {
  const sessionsRoot = path.join(runtimeRoot, 'chat', 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    return;
  }
  for (const filePath of listFilesRecursive(sessionsRoot)) {
    const baseName = path.basename(filePath);
    const match = /^session_(.+)\.json$/iu.exec(baseName);
    if (!match || !match[1]) {
      continue;
    }
    const payload = readLegacyJsonObject(filePath);
    const sessionId = String((payload.id as string) || match[1] || '').trim();
    if (!sessionId) {
      throw new Error(`Legacy chat session missing id: ${filePath}`);
    }
    saveChatSession(runtimeRoot, {
      ...payload,
      id: sessionId,
    });
    fs.rmSync(filePath, { force: true });
  }
}

function tableExists(database: RuntimeDatabase | InstanceType<typeof Database>, name: string): boolean {
  const row = database.prepare(`
    SELECT 1 AS exists_flag
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(name) as { exists_flag?: number } | undefined;
  return Number(row?.exists_flag) === 1;
}

function importLegacyIdleSummaryDatabase(runtimeRoot: string, database: RuntimeDatabase, databasePath: string): void {
  const legacyDatabasePath = path.join(runtimeRoot, 'status', 'idle-summary.sqlite');
  const resolvedLegacy = path.resolve(legacyDatabasePath);
  const resolvedRuntime = path.resolve(databasePath);
  if (!fs.existsSync(resolvedLegacy) || resolvedLegacy === resolvedRuntime) {
    return;
  }

  const legacyDatabase = new Database(resolvedLegacy, { readonly: true });
  try {
    ensureIdleSummarySnapshotsTable(database);
    ensureRunLogsTable(database);

    if (tableExists(legacyDatabase, 'idle_summary_snapshots')) {
      const rows = legacyDatabase.prepare('SELECT * FROM idle_summary_snapshots ORDER BY id ASC').all() as Dict[];
      const insertSnapshot = database.prepare(`
        INSERT INTO idle_summary_snapshots (
          emitted_at_utc,
          completed_request_count,
          input_characters_total,
          output_characters_total,
          input_tokens_total,
          output_tokens_total,
          thinking_tokens_total,
          tool_tokens_total,
          prompt_cache_tokens_total,
          prompt_eval_tokens_total,
          speculative_accepted_tokens_total,
          speculative_generated_tokens_total,
          task_totals_json,
          tool_stats_json,
          saved_tokens,
          saved_percent,
          compression_ratio,
          request_duration_ms_total,
          avg_request_ms,
          avg_tokens_per_second
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        insertSnapshot.run(
          typeof row.emitted_at_utc === 'string' ? row.emitted_at_utc : new Date(0).toISOString(),
          Number(row.completed_request_count) || 0,
          Number(row.input_characters_total) || 0,
          Number(row.output_characters_total) || 0,
          Number(row.input_tokens_total) || 0,
          Number(row.output_tokens_total) || 0,
          Number(row.thinking_tokens_total) || 0,
          Number(row.tool_tokens_total) || 0,
          Number(row.prompt_cache_tokens_total) || 0,
          Number(row.prompt_eval_tokens_total) || 0,
          Number(row.speculative_accepted_tokens_total) || 0,
          Number(row.speculative_generated_tokens_total) || 0,
          typeof row.task_totals_json === 'string' ? row.task_totals_json : '{}',
          typeof row.tool_stats_json === 'string' ? row.tool_stats_json : '{}',
          Number(row.saved_tokens) || 0,
          Number.isFinite(Number(row.saved_percent)) ? Number(row.saved_percent) : null,
          Number.isFinite(Number(row.compression_ratio)) ? Number(row.compression_ratio) : null,
          Number(row.request_duration_ms_total) || 0,
          Number.isFinite(Number(row.avg_request_ms)) ? Number(row.avg_request_ms) : null,
          Number.isFinite(Number(row.avg_tokens_per_second)) ? Number(row.avg_tokens_per_second) : null,
        );
      }
    }

    if (tableExists(legacyDatabase, 'run_logs')) {
      const rows = legacyDatabase.prepare('SELECT * FROM run_logs ORDER BY id ASC').all() as Dict[];
      const insertRunLog = database.prepare(`
        INSERT INTO run_logs (
          run_id,
          request_id,
          run_kind,
          run_group,
          terminal_state,
          started_at_utc,
          finished_at_utc,
          title,
          model,
          backend,
          repo_root,
          input_tokens,
          output_tokens,
          thinking_tokens,
          tool_tokens,
          prompt_cache_tokens,
          prompt_eval_tokens,
          speculative_accepted_tokens,
          speculative_generated_tokens,
          duration_ms,
          request_json,
          planner_debug_json,
          failed_request_json,
          abandoned_request_json,
          repo_search_json,
          repo_search_transcript_jsonl,
          source_paths_json,
          flushed_at_utc,
          source_deleted_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING
      `);
      for (const row of rows) {
        const runId = String((row.run_id as string) || '').trim();
        if (!runId) {
          continue;
        }
        const requestId = String((row.request_id as string) || runId).trim() || runId;
        insertRunLog.run(
          runId,
          requestId,
          typeof row.run_kind === 'string' ? row.run_kind : 'unknown',
          typeof row.run_group === 'string' ? row.run_group : 'other',
          typeof row.terminal_state === 'string' ? row.terminal_state : 'unknown',
          typeof row.started_at_utc === 'string' ? row.started_at_utc : null,
          typeof row.finished_at_utc === 'string' ? row.finished_at_utc : null,
          typeof row.title === 'string' ? row.title : `${runId}`,
          typeof row.model === 'string' ? row.model : null,
          typeof row.backend === 'string' ? row.backend : null,
          typeof row.repo_root === 'string' ? row.repo_root : null,
          Number.isFinite(Number(row.input_tokens)) ? Number(row.input_tokens) : null,
          Number.isFinite(Number(row.output_tokens)) ? Number(row.output_tokens) : null,
          Number.isFinite(Number(row.thinking_tokens)) ? Number(row.thinking_tokens) : null,
          Number.isFinite(Number(row.tool_tokens)) ? Number(row.tool_tokens) : null,
          Number.isFinite(Number(row.prompt_cache_tokens)) ? Number(row.prompt_cache_tokens) : null,
          Number.isFinite(Number(row.prompt_eval_tokens)) ? Number(row.prompt_eval_tokens) : null,
          Number.isFinite(Number(row.speculative_accepted_tokens)) ? Number(row.speculative_accepted_tokens) : null,
          Number.isFinite(Number(row.speculative_generated_tokens)) ? Number(row.speculative_generated_tokens) : null,
          Number.isFinite(Number(row.duration_ms)) ? Number(row.duration_ms) : null,
          typeof row.request_json === 'string' ? row.request_json : null,
          typeof row.planner_debug_json === 'string' ? row.planner_debug_json : null,
          typeof row.failed_request_json === 'string' ? row.failed_request_json : null,
          typeof row.abandoned_request_json === 'string' ? row.abandoned_request_json : null,
          typeof row.repo_search_json === 'string' ? row.repo_search_json : null,
          typeof row.repo_search_transcript_jsonl === 'string' ? row.repo_search_transcript_jsonl : null,
          typeof row.source_paths_json === 'string' ? row.source_paths_json : '[]',
          typeof row.flushed_at_utc === 'string' ? row.flushed_at_utc : new Date().toISOString(),
          typeof row.source_deleted_at_utc === 'string' ? row.source_deleted_at_utc : null,
        );
      }
    }
  } finally {
    legacyDatabase.close();
  }

  deleteFileAndSqliteSidecars(resolvedLegacy);
}

function importLegacyEvalAndBenchmarkJson(runtimeRoot: string, database: RuntimeDatabase): void {
  const resultsRoot = path.join(runtimeRoot, 'eval', 'results');
  if (!fs.existsSync(resultsRoot)) {
    return;
  }
  const insertBenchmarkRun = database.prepare(`
    INSERT INTO benchmark_runs (id, payload_json, created_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json = excluded.payload_json
  `);
  const insertEvalResult = database.prepare(`
    INSERT INTO eval_results (id, payload_json, created_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json = excluded.payload_json
  `);
  for (const filePath of listFilesRecursive(resultsRoot)) {
    const relativePath = toPosixRelativePath(runtimeRoot, filePath);
    if (!filePath.toLowerCase().endsWith('.json')) {
      const fileText = fs.readFileSync(filePath, 'utf8');
      upsertRuntimeTextArtifact({
        id: `legacy:${relativePath}`,
        artifactKind: 'legacy_eval_log_text',
        title: relativePath,
        content: fileText,
      });
      fs.rmSync(filePath, { force: true });
      continue;
    }
    const payload = readLegacyJsonObject(filePath);
    const createdAtUtc = new Date().toISOString();
    if (Array.isArray(payload.Results) && typeof payload.Status === 'string') {
      insertBenchmarkRun.run(
        `legacy:${relativePath}`,
        JSON.stringify(payload),
        createdAtUtc,
      );
    } else if (Array.isArray(payload.Results) && typeof payload.Backend === 'string') {
      insertEvalResult.run(
        `legacy:${relativePath}`,
        JSON.stringify(payload),
        createdAtUtc,
      );
    } else {
      upsertRuntimeJsonArtifact({
        id: `legacy:${relativePath}`,
        artifactKind: 'legacy_eval_json',
        title: relativePath,
        payload,
      });
    }
    fs.rmSync(filePath, { force: true });
  }
}

function importRemainingLegacyLogFiles(runtimeRoot: string): void {
  const logsRoot = path.join(runtimeRoot, 'logs');
  if (!fs.existsSync(logsRoot)) {
    return;
  }
  for (const filePath of listFilesRecursive(logsRoot)) {
    const lower = filePath.toLowerCase();
    const relativePath = toPosixRelativePath(runtimeRoot, filePath);
    const fileText = fs.readFileSync(filePath, 'utf8');
    if (lower.endsWith('.json')) {
      try {
        const payload = JSON.parse(fileText) as unknown;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          upsertRuntimeJsonArtifact({
            id: `legacy:${relativePath}`,
            artifactKind: 'legacy_runtime_log_json',
            title: relativePath,
            payload: payload as Dict,
          });
        } else {
          upsertRuntimeTextArtifact({
            id: `legacy:${relativePath}`,
            artifactKind: 'legacy_runtime_log_text',
            title: relativePath,
            content: fileText,
          });
        }
      } catch {
        upsertRuntimeTextArtifact({
          id: `legacy:${relativePath}`,
          artifactKind: 'legacy_runtime_log_text',
          title: relativePath,
          content: fileText,
        });
      }
    } else {
      upsertRuntimeTextArtifact({
        id: `legacy:${relativePath}`,
        artifactKind: 'legacy_runtime_log_text',
        title: relativePath,
        content: fileText,
      });
    }
    fs.rmSync(filePath, { force: true });
  }
}

function importRemainingLegacyRuntimeFiles(runtimeRoot: string, databasePath: string): void {
  for (const filePath of collectLegacyRuntimeFiles(runtimeRoot, databasePath)) {
    const relativePath = toPosixRelativePath(runtimeRoot, filePath);
    const fileText = fs.readFileSync(filePath, 'utf8');
    if (filePath.toLowerCase().endsWith('.json')) {
      try {
        const payload = JSON.parse(fileText) as unknown;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          upsertRuntimeJsonArtifact({
            id: `legacy:${relativePath}`,
            artifactKind: 'legacy_runtime_file_json',
            title: relativePath,
            payload: payload as Dict,
          });
        } else {
          upsertRuntimeTextArtifact({
            id: `legacy:${relativePath}`,
            artifactKind: 'legacy_runtime_file_text',
            title: relativePath,
            content: fileText,
          });
        }
      } catch {
        upsertRuntimeTextArtifact({
          id: `legacy:${relativePath}`,
          artifactKind: 'legacy_runtime_file_text',
          title: relativePath,
          content: fileText,
        });
      }
    } else {
      upsertRuntimeTextArtifact({
        id: `legacy:${relativePath}`,
        artifactKind: 'legacy_runtime_file_text',
        title: relativePath,
        content: fileText,
      });
    }
    fs.rmSync(filePath, { force: true });
  }
}

function collectLegacyRuntimeFiles(runtimeRoot: string, databasePath: string): string[] {
  const allowed = new Set<string>([
    path.resolve(databasePath),
    path.resolve(`${databasePath}-wal`),
    path.resolve(`${databasePath}-shm`),
  ]);
  return listFilesRecursive(runtimeRoot)
    .map((targetPath) => path.resolve(targetPath))
    .filter((targetPath) => {
      if (allowed.has(targetPath)) {
        return false;
      }
      return true;
    });
}

function getLegacyRuntimeErrorMessage(runtimeRoot: string, files: string[]): string {
  const preview = files.slice(0, 20)
    .map((filePath) => toPosixRelativePath(runtimeRoot, filePath))
    .join(', ');
  const suffix = files.length > 20 ? ` (+${files.length - 20} more)` : '';
  return `Legacy runtime files detected after migration: ${preview}${suffix}`;
}

export function runRuntimeCutoverMigration(): void {
  const runtimeRoot = getRuntimeRoot();
  const databasePath = getRuntimeDatabasePath();
  const alreadyMigrated = Boolean(getRuntimeMetadataValue(RUNTIME_CUTOVER_MARKER_KEY, databasePath));

  const database = getRuntimeDatabase(databasePath);
  ensureIdleSummarySnapshotsTable(database);
  ensureRunLogsTable(database);

  importLegacyConfig(runtimeRoot, databasePath);
  importLegacyStatus(runtimeRoot, databasePath);
  importLegacyMetrics(runtimeRoot, databasePath);
  importLegacyObservedBudget(runtimeRoot);
  importLegacyChatSessions(runtimeRoot);
  importLegacyIdleSummaryDatabase(runtimeRoot, database, databasePath);
  migrateExistingRunLogsToDbAndDeleteBounded(database);
  importRemainingLegacyLogFiles(runtimeRoot);
  importLegacyEvalAndBenchmarkJson(runtimeRoot, database);
  importRemainingLegacyRuntimeFiles(runtimeRoot, databasePath);

  const offendingFiles = collectLegacyRuntimeFiles(runtimeRoot, databasePath);
  if (offendingFiles.length > 0) {
    throw new Error(getLegacyRuntimeErrorMessage(runtimeRoot, offendingFiles));
  }

  if (!alreadyMigrated) {
    setRuntimeMetadataValue(RUNTIME_CUTOVER_MARKER_KEY, new Date().toISOString(), databasePath);
  }
}

export { RUNTIME_CUTOVER_MARKER_KEY };
