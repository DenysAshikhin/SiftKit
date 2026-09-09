import type Database from 'better-sqlite3';

import { buildChatRunMessageIdPrefix, buildChatToolMessageId } from '@siftkit/contracts';

import { z } from '../lib/zod.js';
import { getRuntimeMetadataValue, setRuntimeMetadataValue } from '../state/runtime-db.js';
import {
  RepoAgentToolResultsError,
  readRepoAgentToolResults,
  type RepoAgentToolOutcome,
  type RepoAgentToolResults,
} from './repo-agent-tool-results.js';

type DatabaseInstance = InstanceType<typeof Database>;

function historyMigrationKey(sessionId: string): string {
  return `repo-agent-history-v1:${z.string().min(1).parse(sessionId.trim())}`;
}

export const RepoAgentHistoryRepairModeSchema = z.enum(['dry-run', 'apply']);
export type RepoAgentHistoryRepairMode = z.infer<typeof RepoAgentHistoryRepairModeSchema>;

export const RepoAgentHistoryRowStatusSchema = z.enum([
  'changed',
  'unchanged',
  'unavailable',
  'ambiguous',
]);
export type RepoAgentHistoryRowStatus = z.infer<typeof RepoAgentHistoryRowStatusSchema>;

/**
 * Identifiers and counts only. A repair report is printed, logged and pasted into issues, and a
 * tool result can be an entire file — no payload ever belongs in it.
 */
export const RepoAgentHistoryRepairReportSchema = z.strictObject({
  sessionId: z.string().min(1),
  mode: RepoAgentHistoryRepairModeSchema,
  matched: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  rows: z.array(z.strictObject({
    sourceRunId: z.string().min(1),
    messageId: z.string().min(1),
    status: RepoAgentHistoryRowStatusSchema,
    detail: z.string(),
  })),
});
export type RepoAgentHistoryRepairReport = z.infer<typeof RepoAgentHistoryRepairReportSchema>;

const ToolRowSchema = z.object({
  id: z.string(),
  source_run_id: z.string(),
  tool_call_command: z.string().nullable(),
  tool_call_turn: z.number().nullable(),
  tool_call_exit_code: z.number().nullable(),
  tool_call_output: z.string().nullable(),
  tool_call_output_snippet: z.string().nullable(),
});
type ToolRow = z.infer<typeof ToolRowSchema>;

/**
 * Completed tool rows that still have a run to check against. Compacted rows are excluded: their
 * evidence was deliberately replaced by a summary, and deleted rows are simply not here.
 */
function readRepairableToolRows(database: DatabaseInstance, sessionId: string): ToolRow[] {
  const rows = database.prepare(`
    SELECT
      id, source_run_id, tool_call_command, tool_call_turn,
      tool_call_exit_code, tool_call_output, tool_call_output_snippet
    FROM chat_messages
    WHERE session_id = ?
      AND kind = 'assistant_tool_call'
      AND tool_call_status = 'done'
      AND compressed_into_summary = 0
      AND source_run_id IS NOT NULL
      AND TRIM(source_run_id) <> ''
    ORDER BY position ASC
  `).all(sessionId);
  return z.array(ToolRowSchema).parse(rows);
}

/**
 * The stored preview is either the whole short result or its first 200 characters plus an ellipsis.
 * Both readings are accepted, because a genuine result may itself be 203 characters or end in an
 * ellipsis — length alone is never treated as proof of truncation.
 */
function previewIsConsistent(snippet: string, output: string): boolean {
  if (snippet.length === 0) return true;
  if (output === snippet) return true;
  return snippet.length === 203 && snippet.endsWith('...') && output.startsWith(snippet.slice(0, 200));
}

/**
 * Historical rows predate call identity, so they are matched on what the transcript did record:
 * the turn and the effective command, confirmed by exit code and the stored preview. A command
 * repeated in one turn cannot be told apart this way and is reported rather than guessed.
 */
function findHistoricalMatch(row: ToolRow, canonical: RepoAgentToolResults): {
  kind: 'matched';
  outcome: RepoAgentToolOutcome;
} | { kind: 'ambiguous' } | { kind: 'unmatched' } {
  const command = row.tool_call_command ?? '';
  const snippet = row.tool_call_output_snippet ?? '';
  const candidates = canonical.outcomes.filter((outcome) => (
    outcome.effectiveCommand === command
    && outcome.turn === row.tool_call_turn
    && outcome.exitCode === row.tool_call_exit_code
    && previewIsConsistent(snippet, outcome.output)
  ));
  if (candidates.length > 1) return { kind: 'ambiguous' };
  const outcome = candidates[0];
  return outcome ? { kind: 'matched', outcome } : { kind: 'unmatched' };
}

function findOutcomeForRow(row: ToolRow, canonical: RepoAgentToolResults): {
  kind: 'matched';
  outcome: RepoAgentToolOutcome;
} | { kind: 'ambiguous' } | { kind: 'unmatched' } {
  const prefix = buildChatRunMessageIdPrefix(row.source_run_id);
  const identified = canonical.outcomes.find(
    (outcome) => outcome.toolCallId !== null
      && buildChatToolMessageId(prefix, outcome.toolCallId) === row.id,
  );
  if (identified) return { kind: 'matched', outcome: identified };
  return findHistoricalMatch(row, canonical);
}

type PlannedRow = {
  row: ToolRow;
  status: RepoAgentHistoryRowStatus;
  detail: string;
  output: string | null;
};

function planRunRepair(rows: readonly ToolRow[], sourceRunId: string, database: DatabaseInstance): PlannedRow[] {
  let canonical: RepoAgentToolResults;
  try {
    canonical = readRepoAgentToolResults(database, sourceRunId);
  } catch (error) {
    if (!(error instanceof RepoAgentToolResultsError)) throw error;
    return rows.map((row) => ({ row, status: 'unavailable', detail: error.reason, output: null }));
  }
  return rows.map((row) => {
    const match = findOutcomeForRow(row, canonical);
    if (match.kind === 'ambiguous') {
      return { row, status: 'ambiguous' as const, detail: 'multiple canonical outcomes match', output: null };
    }
    if (match.kind === 'unmatched') {
      return { row, status: 'unavailable' as const, detail: 'no canonical outcome matches', output: null };
    }
    if (row.tool_call_output === match.outcome.output) {
      return { row, status: 'unchanged' as const, detail: canonical.source, output: null };
    }
    return { row, status: 'changed' as const, detail: canonical.source, output: match.outcome.output };
  });
}

function groupBySourceRun(rows: readonly ToolRow[]): Map<string, ToolRow[]> {
  const grouped = new Map<string, ToolRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.source_run_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.source_run_id, [row]);
  }
  return grouped;
}

/**
 * Restores the model-visible results on one chat session's completed tool rows from the runs that
 * produced them. Only `tool_call_output` is ever written, and only for rows whose canonical
 * outcome was found and validated first; every other column, row and ordering is left alone.
 *
 * A run whose rows cannot all be resolved is left entirely unchanged, so a partial repair can
 * never leave half a turn restored and half of it stale.
 */
export function repairRepoAgentHistory(
  database: DatabaseInstance,
  sessionId: string,
  mode: RepoAgentHistoryRepairMode,
): RepoAgentHistoryRepairReport {
  const normalizedSessionId = z.string().min(1).parse(sessionId.trim());
  const parsedMode = RepoAgentHistoryRepairModeSchema.parse(mode);
  const grouped = groupBySourceRun(readRepairableToolRows(database, normalizedSessionId));
  const planned: PlannedRow[] = [];
  for (const [sourceRunId, rows] of grouped) {
    const runPlan = planRunRepair(rows, sourceRunId, database);
    const blocked = runPlan.some((entry) => entry.status === 'ambiguous' || entry.status === 'unavailable');
    const repairs = blocked
      ? []
      : runPlan.filter((entry): entry is PlannedRow & { output: string } => entry.output !== null);
    if (parsedMode === 'apply' && repairs.length > 0) {
      const update = database.prepare(
        'UPDATE chat_messages SET tool_call_output = ? WHERE session_id = ? AND id = ?',
      );
      database.transaction(() => {
        for (const repair of repairs) {
          update.run(repair.output, normalizedSessionId, repair.row.id);
        }
      })();
    }
    planned.push(...(blocked
      ? runPlan.map((entry) => entry.status === 'changed'
        ? { ...entry, status: 'unavailable' as const, detail: 'run blocked by an unresolved row', output: null }
        : entry)
      : runPlan));
  }
  const countOf = (status: RepoAgentHistoryRowStatus): number => (
    planned.filter((entry) => entry.status === status).length
  );
  const report = RepoAgentHistoryRepairReportSchema.parse({
    sessionId: normalizedSessionId,
    mode: parsedMode,
    matched: countOf('changed') + countOf('unchanged'),
    changed: countOf('changed'),
    unchanged: countOf('unchanged'),
    unavailable: countOf('unavailable'),
    ambiguous: countOf('ambiguous'),
    rows: planned.map((entry) => ({
      sourceRunId: entry.row.source_run_id,
      messageId: entry.row.id,
      status: entry.status,
      detail: entry.detail,
    })),
  });
  if (parsedMode === 'apply' && report.unavailable === 0 && report.ambiguous === 0) {
    setRuntimeMetadataValue(historyMigrationKey(normalizedSessionId), 'complete', database.name);
  }
  return report;
}

/**
 * Convert pre-fix history once per session. New terminal writes already store canonical outputs,
 * so subsequent requests need only this durable marker, not the old runs or their transcripts.
 * Unresolved history is never marked migrated and can be retried after evidence is restored.
 */
export function migrateRepoAgentHistory(
  database: DatabaseInstance,
  sessionId: string,
): string[] {
  const marker = getRuntimeMetadataValue(historyMigrationKey(sessionId), database.name);
  if (marker !== null) {
    z.literal('complete').parse(marker);
    return [];
  }
  const report = repairRepoAgentHistory(database, sessionId, 'apply');
  const blockers = [...new Set(report.rows
    .filter((row) => row.status === 'unavailable' || row.status === 'ambiguous')
    .map((row) => `${row.sourceRunId} (${row.status}: ${row.detail})`))];
  return blockers;
}
