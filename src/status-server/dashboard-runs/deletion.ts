import { existsSync, unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import { z } from '../../lib/zod.js';
import { JsonRecordReader } from '../../lib/json-record-reader.js';
import { parseJsonValueText } from '../../lib/json.js';
import type { JsonObject, OptionalJsonValue } from '../../lib/json-types.js';
import { commandMatchesDisplayText } from '../tool-command-display.js';
import { ensureRunLogsTable, tableExists } from './table.js';
import type { DashboardRunLogDeleteCriteria, DashboardRunLogType } from './types.js';

type DatabaseInstance = InstanceType<typeof Database>;

const RunIdRowSchema = z.object({ run_id: z.string().nullable() });
const CountRowSchema = z.object({ count: z.number() });
const TranscriptRowSchema = z.object({ repo_search_transcript_jsonl: z.string().nullable() });
const ArtifactRowSchema = z.object({ id: z.string(), content_json: z.string().nullable() });
const SourcePathsRowSchema = z.object({ source_paths_json: z.string().nullable() });

type ScorecardRewriteResult = {
  scorecard: JsonObject;
  changed: boolean;
};

function readJsonObjectArray(value: OptionalJsonValue): JsonObject[] {
  return Array.isArray(value)
    ? value.map((entry) => JsonRecordReader.asObject(entry)).filter((entry): entry is JsonObject => entry !== null)
    : [];
}

function removeCommandFromScorecard(scorecard: OptionalJsonValue, commandText: string): ScorecardRewriteResult | null {
  if (!scorecard || typeof scorecard !== 'object') {
    return null;
  }
  const scorecardRecord = JsonRecordReader.asObject(scorecard);
  if (!scorecardRecord) {
    return null;
  }
  const tasksValue = scorecardRecord.tasks;
  if (!Array.isArray(tasksValue)) {
    return { scorecard: scorecardRecord, changed: false };
  }
  let changed = false;
  const tasks = tasksValue.map((taskValue) => {
    const task = JsonRecordReader.asObject(taskValue);
    if (!task) {
      return taskValue;
    }
    if (!Array.isArray(task.commands)) {
      return task;
    }
    const originalCommands = readJsonObjectArray(task.commands);
    const filteredCommands = originalCommands.filter((command) => !commandMatchesDisplayText(command, commandText));
    if (filteredCommands.length !== originalCommands.length) {
      changed = true;
      return { ...task, commands: filteredCommands };
    }
    return task;
  });
  return {
    scorecard: changed ? { ...scorecardRecord, tasks } : scorecardRecord,
    changed,
  };
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
      parsed = JsonRecordReader.asObject(parseJsonValueText(line));
    } catch {
      keptLines.push(line);
      continue;
    }
    if (!parsed) {
      keptLines.push(line);
      continue;
    }
    const nestedPayload = JsonRecordReader.asObject(parsed.payload);
    const payload = nestedPayload || parsed;
    const kind = String(parsed.kind || payload.kind || '');
    if (commandMatchesDisplayText(payload, commandText) && (kind === 'turn_command_result' || kind === 'tool_start' || kind === 'tool_result')) {
      changed = true;
      continue;
    }
    let outputRecord = parsed;
    if (kind === 'run_done' && payload.scorecard) {
      const rewrittenScorecard = removeCommandFromScorecard(payload.scorecard, commandText);
      if (rewrittenScorecard?.changed) {
        outputRecord = nestedPayload
          ? { ...parsed, payload: { ...nestedPayload, scorecard: rewrittenScorecard.scorecard } }
          : { ...parsed, scorecard: rewrittenScorecard.scorecard };
        changed = true;
      }
    }
    keptLines.push(JSON.stringify(outputRecord));
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
    const rawTranscriptRow = database.prepare(`
      SELECT repo_search_transcript_jsonl
      FROM run_logs
      WHERE run_id = ?
      LIMIT 1
    `).get(normalizedRunId);
    const row = rawTranscriptRow == null ? undefined : TranscriptRowSchema.parse(rawTranscriptRow);
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
      const artifactRows = z.array(ArtifactRowSchema).parse(database.prepare(`
        SELECT id, content_json
        FROM runtime_artifacts
        WHERE request_id = ? AND content_json IS NOT NULL
      `).all(normalizedRunId));
      for (const artifactRow of artifactRows) {
        if (typeof artifactRow.content_json !== 'string' || !artifactRow.content_json.trim()) {
          continue;
        }
        let parsed: JsonObject | null;
        try {
          parsed = JsonRecordReader.asObject(parseJsonValueText(artifactRow.content_json));
        } catch {
          continue;
        }
        if (!parsed) {
          continue;
        }
        const rewrittenScorecard = removeCommandFromScorecard(parsed.scorecard ?? parsed, normalizedCommand);
        if (rewrittenScorecard?.changed) {
          const rewrittenArtifact = parsed.scorecard
            ? { ...parsed, scorecard: rewrittenScorecard.scorecard }
            : rewrittenScorecard.scorecard;
          database.prepare('UPDATE runtime_artifacts SET content_json = ?, updated_at_utc = ? WHERE id = ?')
            .run(JSON.stringify(rewrittenArtifact), new Date().toISOString(), artifactRow.id);
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
    return z.array(RunIdRowSchema).parse(database.prepare(`
      SELECT run_id
      FROM run_logs
      ${clause}
      ORDER BY ${buildRunLogTimestampSql()} ASC, id ASC
      LIMIT ?
    `).all(...params, criteria.count)).map((row) => String(row.run_id || ''));
  }
  return z.array(RunIdRowSchema).parse(database.prepare(`
    SELECT run_id
    FROM run_logs
    ${clause ? `${clause} AND ` : 'WHERE '}${buildRunLogTimestampSql()} < ?
    ORDER BY ${buildRunLogTimestampSql()} ASC, id ASC
  `).all(...params, `${criteria.beforeDate}T00:00:00.000Z`)).map((row) => String(row.run_id || ''));
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
  const row = CountRowSchema.parse(database.prepare(`
    SELECT COUNT(*) AS count FROM runtime_artifacts WHERE request_id IN (${placeholders})
  `).get(...runLogIds));
  return Number(row.count || 0);
}

function parseRunLogSourcePaths(sourcePathsJson: string | null): string[] {
  if (!sourcePathsJson) {
    return [];
  }
  let parsed: OptionalJsonValue;
  try {
    parsed = parseJsonValueText(sourcePathsJson);
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
  const rows = z.array(SourcePathsRowSchema).parse(database.prepare(`
    SELECT source_paths_json
    FROM run_logs
    WHERE run_id IN (${placeholders})
  `).all(...runLogIds));
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
    if (!existsSync(sourcePath)) {
      continue;
    }
    unlinkSync(sourcePath);
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
      const row = CountRowSchema.parse(database.prepare(countSql).get(cutoff));
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
