import type Database from 'better-sqlite3';

import {
  RunOperationTypeSchema,
  buildChatRunMessageIdPrefix,
  buildChatToolMessageId,
  type RunOperationType,
} from '@siftkit/contracts';

import { z } from '../lib/zod.js';
import { getRuntimeMetadataValue, setRuntimeMetadataValue } from '../state/runtime-db.js';
import {
  ChatToolResultsError,
  readChatToolResults,
  readChatToolTranscript,
  readChatToolResultsFromTranscript,
  type ChatToolOutcome,
  type ChatToolResults,
  type ChatToolTranscript,
} from './chat-tool-results.js';

type DatabaseInstance = InstanceType<typeof Database>;

function historyMigrationKey(sessionId: string): string {
  return `repo-agent-history-v1:${z.string().min(1).parse(sessionId.trim())}`;
}

export const RepoAgentHistoryRepairModeSchema = z.enum(['dry-run', 'apply']);
export type RepoAgentHistoryRepairMode = z.infer<typeof RepoAgentHistoryRepairModeSchema>;

/**
 * `changed`, `unchanged`, `unavailable` and `ambiguous` describe eligible repo-agent rows. The
 * other two describe rows this migration deliberately does not touch: evidence that belongs to a
 * different operation, and evidence whose origin could not be established at all.
 */
export const RepoAgentHistoryRowStatusSchema = z.enum([
  'changed',
  'unchanged',
  'unavailable',
  'ambiguous',
  'excluded_other_operation',
  'unclassified_origin',
]);
export type RepoAgentHistoryRowStatus = z.infer<typeof RepoAgentHistoryRowStatusSchema>;

const ELIGIBLE_BLOCKING_STATUSES: readonly RepoAgentHistoryRowStatus[] = ['unavailable', 'ambiguous'];

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
  excludedOtherOperation: z.number().int().nonnegative(),
  unclassifiedOrigin: z.number().int().nonnegative(),
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
 * Completed tool rows that still name a source run. Compacted rows are excluded: their evidence
 * was deliberately replaced by a summary, and deleted rows are simply not here. Naming a run is
 * not proof of origin — that is established separately, before any transcript is read.
 */
function readSourcedToolRows(database: DatabaseInstance, sessionId: string): ToolRow[] {
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

const RunLogProvenanceRowSchema = z.object({ operation_type: z.string().nullable() });

/** Distinct recorded operations for one engine request; a value outside the canonical union reads as "not recorded". */
function readRunLogOperationTypes(database: DatabaseInstance, requestId: string): RunOperationType[] {
  const rows = database.prepare('SELECT operation_type FROM run_logs WHERE request_id = ?').all(requestId);
  const recorded = z.array(RunLogProvenanceRowSchema).parse(rows)
    .map((row) => RunOperationTypeSchema.safeParse(row.operation_type).data ?? null)
    .filter((value): value is RunOperationType => value !== null);
  return [...new Set(recorded)];
}

type SourceClassification =
  | { kind: 'eligible'; transcript: ChatToolTranscript | null }
  | { kind: 'excluded_other_operation'; detail: string }
  | { kind: 'unclassified_origin'; detail: string };

function classifyByOperation(operationType: RunOperationType, transcript: ChatToolTranscript | null): SourceClassification {
  return operationType === 'repo-agent'
    ? { kind: 'eligible', transcript }
    : { kind: 'excluded_other_operation', detail: operationType };
}

/**
 * Origin comes from the retained run identity first; only when that is absent does the transcript's
 * own header speak for it. Two disagreeing records are an integrity failure, not a choice. A
 * transcript read here is handed on to the matching step so no source is parsed twice.
 */
function classifySource(database: DatabaseInstance, sourceRunId: string): SourceClassification {
  const recorded = readRunLogOperationTypes(database, sourceRunId);
  if (recorded.length > 1) {
    return { kind: 'unclassified_origin', detail: 'conflicting_provenance' };
  }
  const recordedOperation = recorded[0];
  if (recordedOperation !== undefined) {
    return classifyByOperation(recordedOperation, null);
  }
  let transcript: ChatToolTranscript;
  try {
    transcript = readChatToolTranscript(database, sourceRunId);
  } catch (error) {
    if (!(error instanceof ChatToolResultsError)) throw error;
    return { kind: 'unclassified_origin', detail: error.reason };
  }
  if (transcript.operationType === null) {
    return { kind: 'unclassified_origin', detail: 'no operation provenance' };
  }
  return classifyByOperation(transcript.operationType, transcript);
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

type RowMatch = { kind: 'matched'; outcome: ChatToolOutcome } | { kind: 'ambiguous' } | { kind: 'unmatched' };

/**
 * Historical transcripts recorded no identity, so their rows are matched on what they did record:
 * the turn and the effective command, confirmed by exit code and the stored preview. A command
 * repeated in one turn cannot be told apart this way and is reported rather than guessed.
 */
function findHistoricalMatch(row: ToolRow, canonical: ChatToolResults): RowMatch {
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

/** Identified transcripts match on exact call identity; a miss stays a miss whatever else agrees. */
function findIdentifiedMatch(row: ToolRow, canonical: ChatToolResults): RowMatch {
  const prefix = buildChatRunMessageIdPrefix(row.source_run_id);
  const identified = canonical.outcomes.find(
    (outcome) => outcome.toolCallId !== null
      && buildChatToolMessageId(prefix, outcome.toolCallId) === row.id
      && outcome.effectiveCommand === (row.tool_call_command ?? '')
      && outcome.turn === row.tool_call_turn
      && outcome.exitCode === row.tool_call_exit_code,
  );
  return identified ? { kind: 'matched', outcome: identified } : { kind: 'unmatched' };
}

function findOutcomeForRow(row: ToolRow, canonical: ChatToolResults): RowMatch {
  return canonical.format === 'identified-v1'
    ? findIdentifiedMatch(row, canonical)
    : findHistoricalMatch(row, canonical);
}

type PlannedRow = {
  row: ToolRow;
  status: RepoAgentHistoryRowStatus;
  detail: string;
  output: string | null;
};

function isBlockingHistoryRow(row: { status: RepoAgentHistoryRowStatus; detail: string }): boolean {
  return ELIGIBLE_BLOCKING_STATUSES.includes(row.status)
    || row.detail === 'conflicting_provenance'
    || row.detail === 'conflicting_sources';
}

function planExcludedRows(rows: readonly ToolRow[], classification: Exclude<SourceClassification, { kind: 'eligible' }>): PlannedRow[] {
  return rows.map((row) => ({ row, status: classification.kind, detail: classification.detail, output: null }));
}

function planEligibleRun(
  rows: readonly ToolRow[],
  sourceRunId: string,
  database: DatabaseInstance,
  preloaded: ChatToolTranscript | null,
): PlannedRow[] {
  let canonical: ChatToolResults;
  try {
    canonical = preloaded ? readChatToolResultsFromTranscript(preloaded) : readChatToolResults(database, sourceRunId);
  } catch (error) {
    if (!(error instanceof ChatToolResultsError)) throw error;
    return rows.map((row) => ({ row, status: 'unavailable', detail: error.reason, output: null }));
  }
  // The retained identity said repo-agent; a transcript that names another operation contradicts it.
  if (canonical.operationType !== null && canonical.operationType !== 'repo-agent') {
    return rows.map((row) => ({ row, status: 'unclassified_origin', detail: 'conflicting_provenance', output: null }));
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
 * Restores the model-visible results on one chat session's completed repo-agent tool rows from
 * the runs that produced them. Only `tool_call_output` is ever written, and only for rows whose
 * origin is positively repo-agent and whose canonical outcome was found and validated first; every
 * other column, row and ordering is left alone.
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
  const grouped = groupBySourceRun(readSourcedToolRows(database, normalizedSessionId));
  const planned: PlannedRow[] = [];
  for (const [sourceRunId, rows] of grouped) {
    const classification = classifySource(database, sourceRunId);
    if (classification.kind !== 'eligible') {
      planned.push(...planExcludedRows(rows, classification));
      continue;
    }
    const runPlan = planEligibleRun(rows, sourceRunId, database, classification.transcript);
    const blocked = runPlan.some(isBlockingHistoryRow);
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
    excludedOtherOperation: countOf('excluded_other_operation'),
    unclassifiedOrigin: countOf('unclassified_origin'),
    rows: planned.map((entry) => ({
      sourceRunId: entry.row.source_run_id,
      messageId: entry.row.id,
      status: entry.status,
      detail: entry.detail,
    })),
  });
  // The marker means "eligible repo-agent history is converted"; excluded and unclassified rows are
  // reported, not verified. Conflicting provenance is an integrity failure, not unknown origin.
  if (parsedMode === 'apply' && !report.rows.some(isBlockingHistoryRow)) {
    setRuntimeMetadataValue(historyMigrationKey(normalizedSessionId), 'complete', database.name);
  }
  return report;
}

/**
 * Convert pre-fix repo-agent history once per session. New terminal writes already store canonical
 * outputs, so subsequent requests need only this durable marker, not the old runs or their
 * transcripts. Unresolved eligible history is never marked migrated and can be retried after
 * evidence is restored.
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
  return [...new Set(report.rows
    .filter(isBlockingHistoryRow)
    .map((row) => `${row.sourceRunId} (${row.status}: ${row.detail})`))];
}
