import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import type { JsonObject } from '../../lib/json-types.js';
import { commandMatchesDisplayText } from '../tool-command-display.js';
import { ensureRunLogsTable, tableExists } from './table.js';
import type { DashboardRunLogDeleteCriteria, DashboardRunLogType } from './types.js';

type DatabaseInstance = InstanceType<typeof Database>;

type RunLogIdRow = {
  run_id?: unknown;
};

type RunLogCountRow = {
  count?: unknown;
};

type ScorecardTaskPayload = {
  commands?: unknown;
};

function readJsonObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map((entry) => JsonRecordReader.asObject(entry)).filter((entry): entry is JsonObject => entry !== null)
    : [];
}

function removeCommandFromScorecard(scorecard: unknown, commandText: string): boolean {
  if (!scorecard || typeof scorecard !== 'object') {
    return false;
  }
  const scorecardRecord = JsonRecordReader.asObject(scorecard);
  const tasks = readJsonObjectArray(scorecardRecord?.tasks);
  let changed = false;
  for (const task of tasks) {
    const taskPayload = task as ScorecardTaskPayload;
    if (!Array.isArray(taskPayload.commands)) {
      continue;
    }
    const originalCommands = readJsonObjectArray(taskPayload.commands);
    const filteredCommands = originalCommands.filter((command) => !commandMatchesDisplayText(command, commandText));
    if (filteredCommands.length !== originalCommands.length) {
      taskPayload.commands = filteredCommands;
      changed = true;
    }
  }
  return changed;
}

function removeCommandFromTranscriptJsonl(text: string | null, commandText: string): { text: string | null; changed: boolean } {
  if (!text || !commandText) {
    return { text, changed: false };
  }
  const keptLines: string[] = [];
  let changed = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: JsonObject | null = null;
    try {
      parsed = JsonRecordReader.asObject(JSON.parse(line) as unknown);
    } catch {
      keptLines.push(line);
      continue;
    }
    if (!parsed) {
      keptLines.push(line);
      continue;
    }
    const payload = JsonRecordReader.asObject(parsed.payload) || parsed;
    const kind = String(parsed.kind || payload.kind || '');
    if (commandMatchesDisplayText(payload, commandText) && (kind === 'turn_command_result' || kind === 'tool_start' || kind === 'tool_result')) {
      changed = true;
      continue;
    }
    if (kind === 'run_done' && payload.scorecard && removeCommandFromScorecard(payload.scorecard, commandText)) {
      changed = true;
    }
    keptLines.push(JSON.stringify(parsed));
  }
  return { text: keptLines.length > 0 ? keptLines.join('\n') : null, changed };
}

export function removeDashboardRunCommandFromLogs(database: DatabaseInstance, runId: string, commandText: string): void {
  const normalizedRunId = String(runId || '').trim();
  const normalizedCommand = String(commandText || '').trim();
  if (!normalizedRunId || !normalizedCommand) {
    return;
  }
  ensureRunLogsTable(database);
  database.transaction(() => {
    const row = database.prepare(`
      SELECT repo_search_transcript_jsonl
      FROM run_logs
      WHERE run_id = ?
      LIMIT 1
    `).get(normalizedRunId) as { repo_search_transcript_jsonl?: string | null } | undefined;
    if (row) {
      const rewritten = removeCommandFromTranscriptJsonl(
        typeof row.repo_search_transcript_jsonl === 'string' ? row.repo_search_transcript_jsonl : null,
        normalizedCommand,
      );
      if (rewritten.changed) {
        database.prepare('UPDATE run_logs SET repo_search_transcript_jsonl = ? WHERE run_id = ?')
          .run(rewritten.text, normalizedRunId);
      }
    }
    if (tableExists(database, 'runtime_artifacts')) {
      const artifactRows = database.prepare(`
        SELECT id, content_json
        FROM runtime_artifacts
        WHERE request_id = ? AND content_json IS NOT NULL
      `).all(normalizedRunId) as Array<{ id: string; content_json: string | null }>;
      for (const artifactRow of artifactRows) {
        if (typeof artifactRow.content_json !== 'string' || !artifactRow.content_json.trim()) {
          continue;
        }
        let parsed: JsonObject | null;
        try {
          parsed = JsonRecordReader.asObject(JSON.parse(artifactRow.content_json) as unknown);
        } catch {
          continue;
        }
        if (!parsed) {
          continue;
        }
        const changed = removeCommandFromScorecard(parsed.scorecard ?? parsed, normalizedCommand);
        if (changed) {
          database.prepare('UPDATE runtime_artifacts SET content_json = ?, updated_at_utc = ? WHERE id = ?')
            .run(JSON.stringify(parsed), new Date().toISOString(), artifactRow.id);
        }
      }
    }
  })();
}

function buildRunLogTypeWhereClause(type: DashboardRunLogType): { clause: string; params: string[] } {
  if (type === 'all') {
    return { clause: '', params: [] };
  }
  return {
    clause: 'WHERE run_group = ?',
    params: [type],
  };
}

function buildRunLogTimestampSql(): string {
  return `COALESCE(started_at_utc, finished_at_utc, flushed_at_utc, '1970-01-01T00:00:00.000Z')`;
}

function listRunLogIdsForDeletion(database: DatabaseInstance, criteria: DashboardRunLogDeleteCriteria): string[] {
  ensureRunLogsTable(database);
  const { clause, params } = buildRunLogTypeWhereClause(criteria.type);
  if (criteria.mode === 'count') {
    return database.prepare(`
      SELECT run_id
      FROM run_logs
      ${clause}
      ORDER BY ${buildRunLogTimestampSql()} ASC, id ASC
      LIMIT ?
    `).all(...params, criteria.count).map((row) => String((row as RunLogIdRow).run_id || ''));
  }
  return database.prepare(`
    SELECT run_id
    FROM run_logs
    ${clause ? `${clause} AND ` : 'WHERE '}${buildRunLogTimestampSql()} < ?
    ORDER BY ${buildRunLogTimestampSql()} ASC, id ASC
  `).all(...params, `${criteria.beforeDate}T00:00:00.000Z`).map((row) => String((row as RunLogIdRow).run_id || ''));
}

const AUX_RUN_HISTORY_DELETE_STATEMENTS: { table: string; countSql: string; deleteSql: string }[] = [
  {
    table: 'runtime_artifacts',
    countSql: "SELECT COUNT(*) AS count FROM runtime_artifacts WHERE created_at_utc < ? AND artifact_kind != 'benchmark_run'",
    deleteSql: "DELETE FROM runtime_artifacts WHERE created_at_utc < ? AND artifact_kind != 'benchmark_run'",
  },
  {
    table: 'managed_llama_runs',
    countSql: "SELECT COUNT(*) AS count FROM managed_llama_runs WHERE status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?",
    deleteSql: "DELETE FROM managed_llama_runs WHERE status != 'running' AND COALESCE(finished_at_utc, started_at_utc) < ?",
  },
  {
    table: 'idle_summary_snapshots',
    countSql: 'SELECT COUNT(*) AS count FROM idle_summary_snapshots WHERE emitted_at_utc < ?',
    deleteSql: 'DELETE FROM idle_summary_snapshots WHERE emitted_at_utc < ?',
  },
  {
    table: 'runtime_error_events',
    countSql: 'SELECT COUNT(*) AS count FROM runtime_error_events WHERE created_at_utc < ?',
    deleteSql: 'DELETE FROM runtime_error_events WHERE created_at_utc < ?',
  },
];

function isFullHistoryDateWipe(
  criteria: DashboardRunLogDeleteCriteria,
): criteria is { mode: 'before_date'; type: 'all'; beforeDate: string } {
  return criteria.type === 'all' && criteria.mode === 'before_date';
}

function countLinkedRuntimeArtifacts(database: DatabaseInstance, runLogIds: string[]): number {
  if (runLogIds.length === 0 || !tableExists(database, 'runtime_artifacts')) {
    return 0;
  }
  const placeholders = runLogIds.map(() => '?').join(', ');
  const row = database.prepare(`
    SELECT COUNT(*) AS count FROM runtime_artifacts WHERE request_id IN (${placeholders})
  `).get(...runLogIds) as RunLogCountRow;
  return Number(row.count || 0);
}

function parseRunLogSourcePaths(sourcePathsJson: string | null): string[] {
  if (!sourcePathsJson) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourcePathsJson) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function listRunLogSourcePaths(database: DatabaseInstance, runLogIds: string[]): string[] {
  if (runLogIds.length === 0) {
    return [];
  }
  const placeholders = runLogIds.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT source_paths_json
    FROM run_logs
    WHERE run_id IN (${placeholders})
  `).all(...runLogIds) as Array<{ source_paths_json: string | null }>;
  const sourcePaths = new Set<string>();
  for (const row of rows) {
    for (const sourcePath of parseRunLogSourcePaths(row.source_paths_json)) {
      sourcePaths.add(sourcePath);
    }
  }
  return Array.from(sourcePaths);
}

function deleteRunLogSourceFiles(sourcePaths: string[]): void {
  for (const sourcePath of sourcePaths) {
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    fs.unlinkSync(sourcePath);
  }
}

export function previewDashboardRunLogDeletion(
  database: DatabaseInstance,
  criteria: DashboardRunLogDeleteCriteria,
): { matchCount: number } {
  ensureRunLogsTable(database);
  const runLogIds = listRunLogIdsForDeletion(database, criteria);
  if (isFullHistoryDateWipe(criteria)) {
    const cutoff = `${criteria.beforeDate}T00:00:00.000Z`;
    let matchCount = runLogIds.length;
    for (const { table, countSql } of AUX_RUN_HISTORY_DELETE_STATEMENTS) {
      if (!tableExists(database, table)) {
        continue;
      }
      const row = database.prepare(countSql).get(cutoff) as RunLogCountRow;
      matchCount += Number(row.count || 0);
    }
    return { matchCount };
  }
  return { matchCount: runLogIds.length + countLinkedRuntimeArtifacts(database, runLogIds) };
}

export function deleteDashboardRunLogs(
  database: DatabaseInstance,
  criteria: DashboardRunLogDeleteCriteria,
): { deletedCount: number; deletedRunIds: string[] } {
  ensureRunLogsTable(database);
  const deletedRunIds = listRunLogIdsForDeletion(database, criteria);
  const sourcePaths = listRunLogSourcePaths(database, deletedRunIds);
  deleteRunLogSourceFiles(sourcePaths);
  let deletedCount = 0;
  database.transaction(() => {
    if (deletedRunIds.length > 0) {
      const placeholders = deletedRunIds.map(() => '?').join(', ');
      const runLogResult = database
        .prepare(`DELETE FROM run_logs WHERE run_id IN (${placeholders})`)
        .run(...deletedRunIds);
      deletedCount += Number(runLogResult.changes) || 0;
    }
    if (isFullHistoryDateWipe(criteria)) {
      const cutoff = `${criteria.beforeDate}T00:00:00.000Z`;
      for (const { table, deleteSql } of AUX_RUN_HISTORY_DELETE_STATEMENTS) {
        if (!tableExists(database, table)) {
          continue;
        }
        const result = database.prepare(deleteSql).run(cutoff);
        deletedCount += Number(result.changes) || 0;
      }
    } else if (deletedRunIds.length > 0 && tableExists(database, 'runtime_artifacts')) {
      const placeholders = deletedRunIds.map(() => '?').join(', ');
      const artifactResult = database
        .prepare(`DELETE FROM runtime_artifacts WHERE request_id IN (${placeholders})`)
        .run(...deletedRunIds);
      deletedCount += Number(artifactResult.changes) || 0;
    }
  })();
  return {
    deletedCount,
    deletedRunIds,
  };
}
