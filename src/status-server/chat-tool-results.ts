import type Database from 'better-sqlite3';

import {
  PersistedChatTranscriptMessageSchema,
  buildChatRunMessageIdPrefix,
  buildChatToolMessageId,
  type PersistedChatTranscriptMessage,
} from '@siftkit/contracts';

import { z } from '../lib/zod.js';
import { parseJsonValueText } from '../lib/json.js';
import { isJsonObject, type JsonValue } from '../lib/json-types.js';
import {
  ExecutedCommandResultSchema,
  RejectedCommandResultSchema,
  TurnCommandStartEventSchema,
} from '../repo-search/live-snapshot/schemas.js';

type DatabaseInstance = InstanceType<typeof Database>;

/** The kinds of failure a caller has to tell apart; none of them carry tool output. */
export const RepoAgentToolResultsFailureSchema = z.enum([
  'unavailable',
  'malformed',
  'duplicate_identity',
  'conflicting_sources',
  'unmatched_call',
]);
export type RepoAgentToolResultsFailure = z.infer<typeof RepoAgentToolResultsFailureSchema>;

/**
 * Reader failures name the run and the call, never the payload: this error travels into HTTP
 * responses and server logs, and a tool result can be an entire file.
 */
export class RepoAgentToolResultsError extends Error {
  constructor(
    readonly reason: RepoAgentToolResultsFailure,
    readonly requestId: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepoAgentToolResultsError';
  }
}

export const RepoAgentToolSourceSchema = z.enum(['runtime_artifact', 'run_log']);
export type RepoAgentToolSource = z.infer<typeof RepoAgentToolSourceSchema>;

export const RepoAgentToolOutcomeSchema = z.strictObject({
  /** Null only for transcripts written before call identity existed; those match canonically. */
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
export type RepoAgentToolOutcome = z.infer<typeof RepoAgentToolOutcomeSchema>;

export const RepoAgentToolResultsSchema = z.strictObject({
  requestId: z.string().min(1),
  source: RepoAgentToolSourceSchema,
  outcomes: z.array(RepoAgentToolOutcomeSchema),
  /** Calls whose execution started but never produced an outcome; they stay stopped. */
  startedWithoutResult: z.array(z.string().min(1)),
});
export type RepoAgentToolResults = z.infer<typeof RepoAgentToolResultsSchema>;

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
): { text: string; source: RepoAgentToolSource } {
  const artifacts = readRuntimeArtifactTranscripts(database, requestId);
  const distinctArtifacts = [...new Set(artifacts)];
  if (distinctArtifacts.length > 1) {
    throw new RepoAgentToolResultsError(
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
    throw new RepoAgentToolResultsError(
      'conflicting_sources',
      requestId,
      `Run ${requestId} has ${archived.length} differing archived run-log transcripts.`,
    );
  }
  const archivedText = archived[0];
  if (archivedText === undefined) {
    throw new RepoAgentToolResultsError(
      'unavailable',
      requestId,
      `No repo-agent transcript is retained for run ${requestId}.`,
    );
  }
  return { text: archivedText, source: 'run_log' };
}

const EventKindSchema = z.object({ kind: z.string() });

/**
 * Transcripts written before call identity existed still record the model-visible text, so they
 * remain readable — with a null identity. One parser covers both eras: relaxing the identity is
 * the only difference, and a null one simply never matches an exact-identity join.
 */
const OptionalIdentity = { toolCallId: z.string().min(1).nullable().default(null) } as const;
const CanonicalStartSchema = TurnCommandStartEventSchema.extend(OptionalIdentity);
const CanonicalExecutedSchema = ExecutedCommandResultSchema.extend(OptionalIdentity);
const CanonicalRejectedSchema = RejectedCommandResultSchema.extend(OptionalIdentity);

function parseTranscriptLine(requestId: string, line: string, lineNumber: number): JsonValue {
  try {
    return parseJsonValueText(line);
  } catch {
    throw new RepoAgentToolResultsError(
      'malformed',
      requestId,
      `Run ${requestId} transcript line ${lineNumber} is not valid JSON.`,
    );
  }
}

function toOutcome(
  requestId: string,
  lineNumber: number,
  event: JsonValue,
): RepoAgentToolOutcome {
  const executed = CanonicalExecutedSchema.safeParse(event);
  if (executed.success) {
    return RepoAgentToolOutcomeSchema.parse({
      toolCallId: executed.data.toolCallId,
      turn: executed.data.turn,
      requestedCommand: executed.data.requestedCommand,
      effectiveCommand: executed.data.executedCommand,
      exitCode: executed.data.exitCode,
      output: executed.data.insertedResultText,
    });
  }
  const rejected = CanonicalRejectedSchema.safeParse(event);
  if (rejected.success) {
    return RepoAgentToolOutcomeSchema.parse({
      toolCallId: rejected.data.toolCallId,
      turn: rejected.data.turn,
      requestedCommand: rejected.data.command,
      effectiveCommand: rejected.data.command,
      exitCode: null,
      output: rejected.data.output ?? '',
    });
  }
  throw new RepoAgentToolResultsError(
    'malformed',
    requestId,
    `Run ${requestId} transcript line ${lineNumber} is a tool outcome that does not match either outcome shape.`,
  );
}

/**
 * Reads exactly one run's model-visible tool outcomes. This is the authoritative replay source:
 * it never consults a scorecard, a browser preview, or the current state of the repository.
 */
export function readRepoAgentToolResults(
  database: DatabaseInstance,
  requestId: string,
): RepoAgentToolResults {
  const normalizedRequestId = z.string().min(1).parse(requestId.trim());
  const selected = selectTranscriptText(database, normalizedRequestId);
  const outcomes: RepoAgentToolOutcome[] = [];
  const seen = new Set<string>();
  const startedCallIds: string[] = [];
  const lines = selected.text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const parsed = parseTranscriptLine(normalizedRequestId, line, index + 1);
    if (!isJsonObject(parsed)) continue;
    const kind = EventKindSchema.safeParse(parsed);
    if (!kind.success) continue;
    if (kind.data.kind === 'turn_command_start') {
      const start = CanonicalStartSchema.safeParse(parsed);
      if (!start.success) {
        throw new RepoAgentToolResultsError(
          'malformed',
          normalizedRequestId,
          `Run ${normalizedRequestId} transcript line ${index + 1} is not a readable command start.`,
        );
      }
      // A start with no identity cannot be paired with anything, so it claims nothing.
      if (start.data.toolCallId !== null) startedCallIds.push(start.data.toolCallId);
      continue;
    }
    if (kind.data.kind !== 'turn_command_result') continue;
    const outcome = toOutcome(normalizedRequestId, index + 1, parsed);
    if (outcome.toolCallId !== null) {
      if (seen.has(outcome.toolCallId)) {
        throw new RepoAgentToolResultsError(
          'duplicate_identity',
          normalizedRequestId,
          `Run ${normalizedRequestId} records two outcomes for tool call ${outcome.toolCallId}.`,
        );
      }
      seen.add(outcome.toolCallId);
    }
    outcomes.push(outcome);
  }
  return RepoAgentToolResultsSchema.parse({
    requestId: normalizedRequestId,
    source: selected.source,
    outcomes,
    startedWithoutResult: startedCallIds.filter((callId) => !seen.has(callId)),
  });
}

/**
 * Replaces the live previews on a run's completed tool rows with the model-visible results the
 * run actually inserted. Ids, order, reasoning, activity metadata and approvals are untouched:
 * this is a projection of the retained rows, not a reconstruction of the conversation.
 *
 * A completed row with no canonical outcome is a history-integrity failure, not a short result —
 * the preview it is carrying was never the whole answer. Stopped rows are left stopped.
 */
export function hydrateRepoAgentToolMessages(
  messages: readonly PersistedChatTranscriptMessage[],
  canonicalResults: RepoAgentToolResults,
): PersistedChatTranscriptMessage[] {
  const prefix = buildChatRunMessageIdPrefix(canonicalResults.requestId);
  // Hydration of a live run demands the modern identity; an identity-less historical outcome can
  // never satisfy it, which is exactly what keeps the two eras' matching rules apart.
  const outcomesById = new Map(canonicalResults.outcomes
    .filter((outcome) => outcome.toolCallId !== null)
    .map((outcome) => [buildChatToolMessageId(prefix, String(outcome.toolCallId)), outcome] as const));
  return messages.map((message) => {
    if (message.kind !== 'assistant_tool_call' || message.toolCallStatus !== 'done') {
      return message;
    }
    const outcome = outcomesById.get(message.id);
    if (!outcome) {
      throw new RepoAgentToolResultsError(
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
export function hydrateTerminalRepoAgentMessages(
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
  return hydrateRepoAgentToolMessages(messages, readRepoAgentToolResults(database, requestId));
}
