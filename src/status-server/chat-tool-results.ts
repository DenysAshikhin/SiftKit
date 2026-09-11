import type Database from 'better-sqlite3';

import { PersistedChatTranscriptMessageSchema, RunOperationTypeSchema, buildChatRunMessageIdPrefix, buildChatMessageId, type PersistedChatTranscriptMessage } from '@siftkit/contracts';

import { z } from '../lib/zod.js';
import { parseJsonValueText } from '../lib/json.js';
import { isJsonObject, type JsonObject } from '../lib/json-types.js';
import {
  ExecutedCommandResultSchema,
  IDENTIFIED_TOOL_RESULT_FORMAT,
  RejectedCommandResultSchema,
  ToolResultFormatSchema,
  TurnCommandStartEventSchema,
  TurnCommandResultFinalizedEventSchema,
  type ToolResultFormat,
} from '../repo-search/live-snapshot/schemas.js';

type DatabaseInstance = InstanceType<typeof Database>;

/** The kinds of failure a caller has to tell apart; none of them carry tool output. */
export const ChatToolResultsFailureSchema = z.enum([
  'unavailable',
  'malformed',
  'unsupported_format',
  'invalid_identity',
  'mixed_identity',
  'duplicate_identity',
  'conflicting_sources',
  'historical_format',
  'unmatched_call',
  'missing_result',
]);
export type ChatToolResultsFailure = z.infer<typeof ChatToolResultsFailureSchema>;

/**
 * Reader failures name the run and the call, never the payload: this error travels into HTTP
 * responses and server logs, and a tool result can be an entire file.
 */
export class ChatToolResultsError extends Error {
  constructor(
    readonly reason: ChatToolResultsFailure,
    readonly requestId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ChatToolResultsError';
  }
}

export const ChatToolSourceSchema = z.enum(['runtime_artifact', 'run_log']);
export type ChatToolSource = z.infer<typeof ChatToolSourceSchema>;

export const ChatToolOutcomeSchema = z.strictObject({
  /** Null exactly when the transcript is `historical-unidentified`; identified outcomes always carry one. */
  toolCallId: z.string().min(1).nullable(),
  turn: z.number().int().nonnegative(),
  /** What the model asked for; an adjusted read keeps this distinct from what ran. */
  requestedCommand: z.string(),
  /** What the transcript associates the outcome with — the returned range for an adjusted read. */
  effectiveCommand: z.string(),
  /** Null exactly when the call was rejected instead of executed. */
  exitCode: z.number().int().nullable(),
  /** The complete model-visible text, empty string included. */
  output: z.string(),
});
export type ChatToolOutcome = z.infer<typeof ChatToolOutcomeSchema>;

export const ChatToolResultsSchema = z.strictObject({
  requestId: z.string().min(1),
  source: ChatToolSourceSchema,
  format: ToolResultFormatSchema,
  /** The operation the transcript declares for itself; null for transcripts written before the header carried it. */
  operationType: RunOperationTypeSchema.nullable(),
  outcomes: z.array(ChatToolOutcomeSchema),
  /** Calls whose execution started but never produced an outcome; they stay stopped. */
  startedWithoutResult: z.array(z.string().min(1)),
});
export type ChatToolResults = z.infer<typeof ChatToolResultsSchema>;

/**
 * The one contract for a completed tool row that is about to be written or replayed: its full
 * model-visible result is a string, and the empty string is a complete result.
 */
export const DurableToolResultSchema = z.string();

export function requireDurableToolResult(message: {
  id: string;
  sourceRunId?: string | null;
  toolCallOutput?: string | null;
}): string {
  const parsed = DurableToolResultSchema.safeParse(message.toolCallOutput);
  if (!parsed.success) {
    throw new ChatToolResultsError(
      'missing_result',
      message.sourceRunId ?? null,
      `Chat tool row ${message.id} has no complete result to persist or replay.`,
    );
  }
  return parsed.data;
}

const ArtifactRowSchema = z.object({ content_text: z.string().nullable() });
const RunLogRowSchema = z.object({ repo_search_transcript_jsonl: z.string().nullable() });

function readRuntimeArtifactTranscripts(database: DatabaseInstance, requestId: string): string[] {
  const rows = database.prepare(`
    SELECT content_text
    FROM runtime_artifacts
    WHERE artifact_kind = 'repo_search_transcript' AND request_id = ?
  `).all(requestId);
  return z.array(ArtifactRowSchema).parse(rows)
    .map((row) => row.content_text)
    .filter((text): text is string => typeof text === 'string');
}

function readRunLogTranscripts(database: DatabaseInstance, requestId: string): string[] {
  const rows = database.prepare(`
    SELECT repo_search_transcript_jsonl
    FROM run_logs
    WHERE request_id = ?
  `).all(requestId);
  return z.array(RunLogRowSchema).parse(rows)
    .map((row) => row.repo_search_transcript_jsonl)
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
}

/**
 * The live artifact is written before the run returns; the run-log column is a deferred archive
 * copy of the same text. Preferring the artifact is what lets a stop read the run's own evidence
 * without waiting on the dashboard projection, and the archive keeps old runs readable after the
 * artifact is swept.
 */
function selectTranscriptText(
  database: DatabaseInstance,
  requestId: string,
): { text: string; source: ChatToolSource } {
  const artifacts = readRuntimeArtifactTranscripts(database, requestId);
  const distinctArtifacts = [...new Set(artifacts)];
  if (distinctArtifacts.length > 1) {
    throw new ChatToolResultsError(
      'conflicting_sources',
      requestId,
      `Run ${requestId} has ${distinctArtifacts.length} differing repo_search_transcript artifacts.`,
    );
  }
  const artifactText = distinctArtifacts[0];
  if (artifactText !== undefined && artifactText.length > 0) {
    return { text: artifactText, source: 'runtime_artifact' };
  }
  const archived = [...new Set(readRunLogTranscripts(database, requestId))];
  if (archived.length > 1) {
    throw new ChatToolResultsError(
      'conflicting_sources',
      requestId,
      `Run ${requestId} has ${archived.length} differing archived run-log transcripts.`,
    );
  }
  const archivedText = archived[0];
  if (archivedText === undefined) {
    throw new ChatToolResultsError(
      'unavailable',
      requestId,
      `No tool transcript is retained for run ${requestId}.`,
    );
  }
  return { text: archivedText, source: 'run_log' };
}

const EventKindSchema = z.object({ kind: z.string() });

/** The header fields this reader depends on; anything else the run logged is ignored. */
const RunStartHeaderSchema = z.object({
  operationType: RunOperationTypeSchema.nullable().optional(),
  toolResultFormat: z.string().optional(),
});

/** Identity is read from the wire exactly once, so "absent" and "present but empty" stay distinct. */
const IdentityFieldSchema = z.object({ toolCallId: z.string().min(1) });

const HistoricalStartSchema = TurnCommandStartEventSchema.omit({ toolCallId: true });
const HistoricalExecutedSchema = ExecutedCommandResultSchema.omit({ toolCallId: true });
const CompleteRejectedSchema = RejectedCommandResultSchema.extend({ output: z.string() });
const HistoricalRejectedSchema = CompleteRejectedSchema.omit({ toolCallId: true });

type TranscriptEvent = { lineNumber: number; kind: string; event: JsonObject };

export type ChatToolTranscript = {
  requestId: string;
  source: ChatToolSource;
  operationType: ChatToolResults['operationType'];
  events: TranscriptEvent[];
  parseError: ChatToolResultsError | null;
};

function parseTranscriptEvents(requestId: string, text: string): Pick<ChatToolTranscript, 'events' | 'parseError'> {
  const events: TranscriptEvent[] = [];
  let parseError: ChatToolResultsError | null = null;
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = parseJsonValueText(line);
    } catch {
      parseError ??= new ChatToolResultsError(
        'malformed',
        requestId,
        `Run ${requestId} transcript line ${index + 1} is not valid JSON.`,
      );
      continue;
    }
    if (!isJsonObject(parsed)) continue;
    const kind = EventKindSchema.safeParse(parsed);
    if (!kind.success) continue;
    events.push({ lineNumber: index + 1, kind: kind.data.kind, event: parsed });
  }
  return { events, parseError };
}

/** Establish origin before interpreting result identities or format. Parse each JSON line only once. */
export function readChatToolTranscript(database: DatabaseInstance, requestId: string): ChatToolTranscript {
  const normalizedRequestId = z.string().min(1).parse(requestId.trim());
  const selected = selectTranscriptText(database, normalizedRequestId);
  const parsed = parseTranscriptEvents(normalizedRequestId, selected.text);
  const starts = parsed.events.filter((entry) => entry.kind === 'run_start');
  const operationHeader = z.object({ operationType: RunOperationTypeSchema.nullable().optional() });
  const operations = starts.map((entry) => operationHeader.safeParse(entry.event));
  if (starts.length > 1) {
    throw new ChatToolResultsError('conflicting_sources', normalizedRequestId, `Run ${normalizedRequestId} declares multiple source headers.`);
  }
  if (operations.some((entry) => !entry.success)) {
    throw new ChatToolResultsError('malformed', normalizedRequestId, `Run ${normalizedRequestId} has unreadable operation provenance.`);
  }
  return {
    requestId: normalizedRequestId,
    source: selected.source,
    operationType: operations[0]?.data?.operationType ?? null,
    ...parsed,
  };
}

function isToolEvent(event: TranscriptEvent): boolean {
  return event.kind === 'turn_command_start' || event.kind === 'turn_command_result'
    || event.kind === 'turn_command_result_finalized';
}

type TranscriptHeader = { format: ToolResultFormat | null; operationType: ChatToolResults['operationType'] };

function readHeader(requestId: string, events: readonly TranscriptEvent[]): TranscriptHeader {
  const starts = events.filter((entry) => entry.kind === 'run_start');
  if (starts.length > 1) {
    throw new ChatToolResultsError(
      'malformed',
      requestId,
      `Run ${requestId} transcript declares ${starts.length} run_start headers.`,
    );
  }
  const start = starts[0];
  if (!start) return { format: null, operationType: null };
  const header = RunStartHeaderSchema.safeParse(start.event);
  if (!header.success) {
    throw new ChatToolResultsError(
      'malformed',
      requestId,
      `Run ${requestId} transcript line ${start.lineNumber} has an unreadable run_start header.`,
    );
  }
  if (header.data.toolResultFormat === undefined) {
    return { format: null, operationType: header.data.operationType ?? null };
  }
  if (header.data.toolResultFormat !== IDENTIFIED_TOOL_RESULT_FORMAT) {
    throw new ChatToolResultsError(
      'unsupported_format',
      requestId,
      `Run ${requestId} transcript declares an unsupported tool result format.`,
    );
  }
  return { format: IDENTIFIED_TOOL_RESULT_FORMAT, operationType: header.data.operationType ?? null };
}

/**
 * The classification table: an explicit marker wins; without one, the events decide — any event
 * carrying the identity field makes the whole transcript identified. A present-but-empty identity,
 * or a mix of identified and unidentified events, is an integrity failure, never historical data.
 */
function classifyFormat(
  requestId: string,
  header: TranscriptHeader,
  events: readonly TranscriptEvent[],
): ToolResultFormat {
  let identified = 0;
  let unidentified = 0;
  for (const entry of events.filter(isToolEvent)) {
    if (!('toolCallId' in entry.event)) {
      unidentified += 1;
      continue;
    }
    if (!IdentityFieldSchema.safeParse(entry.event).success) {
      throw new ChatToolResultsError(
        'invalid_identity',
        requestId,
        `Run ${requestId} transcript line ${entry.lineNumber} carries an empty or non-string tool call identity.`,
      );
    }
    identified += 1;
  }
  if (unidentified > 0 && (identified > 0 || header.format === IDENTIFIED_TOOL_RESULT_FORMAT)) {
    throw new ChatToolResultsError(
      'mixed_identity',
      requestId,
      `Run ${requestId} transcript mixes identified and unidentified tool events.`,
    );
  }
  if (unidentified > 0) return 'historical-unidentified';
  return IDENTIFIED_TOOL_RESULT_FORMAT;
}

function toOutcome(requestId: string, entry: TranscriptEvent, format: ToolResultFormat): ChatToolOutcome {
  const identity = format === IDENTIFIED_TOOL_RESULT_FORMAT
    ? IdentityFieldSchema.parse(entry.event).toolCallId
    : null;
  const executed = (format === IDENTIFIED_TOOL_RESULT_FORMAT ? ExecutedCommandResultSchema : HistoricalExecutedSchema)
    .safeParse(entry.event);
  if (executed.success) {
    return ChatToolOutcomeSchema.parse({
      toolCallId: identity,
      turn: executed.data.turn,
      requestedCommand: executed.data.requestedCommand,
      effectiveCommand: executed.data.executedCommand,
      exitCode: executed.data.exitCode,
      output: executed.data.insertedResultText,
    });
  }
  const rejected = (format === IDENTIFIED_TOOL_RESULT_FORMAT ? CompleteRejectedSchema : HistoricalRejectedSchema)
    .safeParse(entry.event);
  if (rejected.success) {
    return ChatToolOutcomeSchema.parse({
      toolCallId: identity,
      turn: rejected.data.turn,
      requestedCommand: rejected.data.command,
      effectiveCommand: rejected.data.command,
      exitCode: null,
      output: rejected.data.output,
    });
  }
  throw new ChatToolResultsError(
    'malformed',
    requestId,
    `Run ${requestId} transcript line ${entry.lineNumber} is a tool outcome that does not match either outcome shape.`,
  );
}

/**
 * Reads exactly one run's model-visible tool outcomes. This is the authoritative replay source:
 * it never consults a scorecard, a browser preview, or the current state of the repository.
 * The format is established from the header and the events before any outcome is matched.
 */
export function readChatToolResults(
  database: DatabaseInstance,
  requestId: string,
): ChatToolResults {
  return readChatToolResultsFromTranscript(readChatToolTranscript(database, requestId));
}

export function readChatToolResultsFromTranscript(transcript: ChatToolTranscript): ChatToolResults {
  const { requestId: normalizedRequestId, events } = transcript;
  if (transcript.parseError) throw transcript.parseError;
  const header = readHeader(normalizedRequestId, events);
  const format = classifyFormat(normalizedRequestId, header, events);
  const outcomes: ChatToolOutcome[] = [];
  const seen = new Set<string>();
  const finalized = new Set<string>();
  const startedCallIds = new Set<string>();
  for (const entry of events) {
    if (entry.kind === 'turn_command_result_finalized') {
      const finalization = TurnCommandResultFinalizedEventSchema.safeParse(entry.event);
      if (!finalization.success) {
        throw new ChatToolResultsError('malformed', normalizedRequestId, `Run ${normalizedRequestId} transcript line ${entry.lineNumber} has an invalid result finalization.`);
      }
      const { toolCallId, turn, insertedResultText } = finalization.data;
      const outcome = outcomes.find((result) => result.toolCallId === toolCallId);
      if (!outcome || outcome.turn !== turn) {
        throw new ChatToolResultsError('unmatched_call', normalizedRequestId, `Run ${normalizedRequestId} finalization has no matching outcome for call ${toolCallId}.`);
      }
      if (finalized.has(toolCallId)) {
        throw new ChatToolResultsError('duplicate_identity', normalizedRequestId, `Run ${normalizedRequestId} repeats finalization for call ${toolCallId}.`);
      }
      finalized.add(toolCallId);
      outcome.output = insertedResultText;
      continue;
    }
    if (entry.kind === 'turn_command_start') {
      const start = (format === IDENTIFIED_TOOL_RESULT_FORMAT ? TurnCommandStartEventSchema : HistoricalStartSchema)
        .safeParse(entry.event);
      if (!start.success) {
        throw new ChatToolResultsError(
          'malformed',
          normalizedRequestId,
          `Run ${normalizedRequestId} transcript line ${entry.lineNumber} is not a readable command start.`,
        );
      }
      // A historical start has no identity to pair with, so it claims nothing.
      if (format === IDENTIFIED_TOOL_RESULT_FORMAT) {
        const toolCallId = IdentityFieldSchema.parse(entry.event).toolCallId;
        if (startedCallIds.has(toolCallId)) {
          throw new ChatToolResultsError(
            'duplicate_identity',
            normalizedRequestId,
            `Run ${normalizedRequestId} records two starts for tool call ${toolCallId}.`,
          );
        }
        startedCallIds.add(toolCallId);
      }
      continue;
    }
    if (entry.kind !== 'turn_command_result') continue;
    const outcome = toOutcome(normalizedRequestId, entry, format);
    if (outcome.toolCallId !== null) {
      if (seen.has(outcome.toolCallId)) {
        throw new ChatToolResultsError(
          'duplicate_identity',
          normalizedRequestId,
          `Run ${normalizedRequestId} records two outcomes for tool call ${outcome.toolCallId}.`,
        );
      }
      seen.add(outcome.toolCallId);
    }
    outcomes.push(outcome);
  }
  return ChatToolResultsSchema.parse({
    requestId: normalizedRequestId,
    source: transcript.source,
    format,
    operationType: header.operationType,
    outcomes,
    startedWithoutResult: [...startedCallIds].filter((callId) => !seen.has(callId)),
  });
}

/**
 * Replaces the live previews on a run's completed tool rows with the model-visible results the
 * run actually inserted. Ids, order, reasoning, activity metadata and approvals are untouched:
 * this is a projection of the retained rows, not a reconstruction of the conversation.
 *
 * Only identified transcripts can hydrate a new write; a completed row with no exact-identity
 * outcome is a history-integrity failure, not a short result. Stopped rows are left stopped.
 */
export function hydrateChatToolMessages(
  messages: readonly PersistedChatTranscriptMessage[],
  canonicalResults: ChatToolResults,
): PersistedChatTranscriptMessage[] {
  if (canonicalResults.format !== IDENTIFIED_TOOL_RESULT_FORMAT) {
    throw new ChatToolResultsError(
      'historical_format',
      canonicalResults.requestId,
      `Run ${canonicalResults.requestId} is a ${canonicalResults.format} transcript and cannot hydrate a live turn.`,
    );
  }
  const prefix = buildChatRunMessageIdPrefix(canonicalResults.requestId);
  const outcomesById = new Map(canonicalResults.outcomes
    .map((outcome) => [buildChatMessageId(prefix, { kind: 'tool', toolCallId: String(outcome.toolCallId) }), outcome] as const));
  return messages.map((message) => {
    if (message.kind !== 'assistant_tool_call' || message.toolCallStatus !== 'done') {
      return message;
    }
    const outcome = outcomesById.get(message.id);
    if (!outcome
      || message.sourceRunId !== canonicalResults.requestId
      || message.toolCallTurn !== outcome.turn
      || message.toolCallCommand !== outcome.effectiveCommand
      || message.toolCallExitCode !== outcome.exitCode) {
      throw new ChatToolResultsError(
        'unmatched_call',
        canonicalResults.requestId,
        `Chat tool row ${message.id} has no canonical outcome in run ${canonicalResults.requestId}.`,
      );
    }
    return PersistedChatTranscriptMessageSchema.parse({ ...message, toolCallOutput: outcome.output });
  });
}

/**
 * Hydrates only when the turn actually completed a tool: a run that streamed no tool result has
 * nothing to restore, and reading a transcript it never wrote would fail a healthy stop.
 */
export function hydrateTerminalChatMessages(
  database: DatabaseInstance,
  requestId: string,
  messages: readonly PersistedChatTranscriptMessage[],
): PersistedChatTranscriptMessage[] {
  const hasCompletedTool = messages.some(
    (message) => message.kind === 'assistant_tool_call' && message.toolCallStatus === 'done',
  );
  if (!hasCompletedTool) {
    return [...messages];
  }
  return hydrateChatToolMessages(messages, readChatToolResults(database, requestId));
}
