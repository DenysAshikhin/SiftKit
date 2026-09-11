import { z } from '../lib/zod.js';
import { createHash } from 'node:crypto';
import { RunOperationTypeSchema } from '@siftkit/contracts';
import { JsonObjectSchema } from '../lib/json-types.js';
import { PlannerChatMessagesSchema, findPlannerContextViolation, type ChatMessage } from '../repo-search/planner-chat-message.js';
import { readChatToolResultsFromTranscript, type ChatToolTranscript } from './chat-tool-results.js';
import type { RuntimeDatabase } from '../state/database-handle.js';

export const ChatArchiveSourceSchema = z.strictObject({
  sourceId: z.string().min(1),
  sourceKind: z.enum(['runtime_artifact', 'run_log']),
  text: z.string().min(1),
});

/** Reads every exact retained copy. Import never prefers one conflicting source over another. */
export function readChatHistoryArchiveSources(database: RuntimeDatabase, requestId: string) {
  const artifacts = z.array(z.object({ id: z.string(), content_text: z.string().nullable() })).parse(database.prepare(
    "SELECT id, content_text FROM runtime_artifacts WHERE request_id=? AND artifact_kind='repo_search_transcript' ORDER BY id").all(requestId));
  const archives = z.array(z.object({ run_id: z.string(), repo_search_transcript_jsonl: z.string().nullable() })).parse(database.prepare(
    'SELECT run_id, repo_search_transcript_jsonl FROM run_logs WHERE request_id=? ORDER BY run_id').all(requestId));
  return z.array(ChatArchiveSourceSchema).min(1).parse([
    ...artifacts.filter(row => row.content_text !== null).map(row => ({ sourceId: row.id, sourceKind: 'runtime_artifact', text: row.content_text })),
    ...archives.filter(row => row.repo_search_transcript_jsonl !== null).map(row => ({ sourceId: row.run_id, sourceKind: 'run_log', text: row.repo_search_transcript_jsonl })),
  ]);
}

export function digestChatArchiveSources(sources: readonly z.infer<typeof ChatArchiveSourceSchema>[]) {
  return sources.map(source => ({ sourceId: source.sourceId, sourceKind: source.sourceKind,
    digest: createHash('sha256').update(source.text).digest('hex'), bytes: Buffer.byteLength(source.text) }))
    .sort((left, right) => `${left.sourceKind}:${left.sourceId}`.localeCompare(`${right.sourceKind}:${right.sourceId}`));
}

const EventHeaderSchema = z.object({ at: z.string().datetime(), kind: z.string().min(1) });
const RunHeaderSchema = z.object({ operationType: RunOperationTypeSchema });
const ContextSchema = z.object({ turn: z.number().int().positive(), messages: PlannerChatMessagesSchema });
const ResponseSchema = z.object({ turn: z.number().int().positive(), text: z.string(), thinkingText: z.string() });

// These historical records report diagnostics only; none replaces or appends planner context.
const DIAGNOSTIC_KINDS = new Set([
  'model_inventory', 'turn_preflight_start', 'turn_preflight_budget', 'turn_model_request',
  'provider_request_start', 'provider_request_done', 'provider_request_error',
  'prompt_cache_epoch_reset', 'turn_progress',
]);
const EVIDENCE_KINDS = new Set([
  'run_start', 'turn_new_messages', 'turn_model_response', 'turn_command_start',
  'turn_command_result', 'turn_command_result_finalized', 'queued_user_message',
  'turn_preflight_compaction_applied', 'approval_verdict', 'task_done',
]);

/** Strict historical import boundary. Runtime diagnostic readers have a different source policy. */
export function readChatHistoryArchive(requestId: string, sources: readonly z.infer<typeof ChatArchiveSourceSchema>[]) {
  z.string().min(1).parse(requestId);
  const validated = z.array(ChatArchiveSourceSchema).min(1).parse(sources);
  const selected = validated[0];
  if (!selected) throw new Error(`Run ${requestId} has no archive source.`);
  if (new Set(validated.map(source => `${source.sourceKind}:${source.sourceId}`)).size !== validated.length) {
    throw new Error(`Run ${requestId} has duplicate source identities.`);
  }
  if (validated.some(source => source.text !== selected.text)) {
    throw new Error(`Run ${requestId} has conflicting archive sources.`);
  }
  const events: ChatToolTranscript['events'] = [];
  let previousTime = '';
  let modelTurns = 0;
  let contextTurn = 0;
  let operationType: ChatToolTranscript['operationType'] = null;
  for (const [index, line] of selected.text.split('\n').entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    let event;
    let header;
    try {
      event = JsonObjectSchema.parse(JSON.parse(line));
      header = EventHeaderSchema.parse(event);
      if (!DIAGNOSTIC_KINDS.has(header.kind) && !EVIDENCE_KINDS.has(header.kind)) throw new Error('unsupported event');
      if (header.at < previousTime) throw new Error('unordered timestamps');
      previousTime = header.at;
      if (header.kind === 'run_start') {
        if (events.length > 0) throw new Error('misplaced source header');
        operationType = RunHeaderSchema.parse(event).operationType;
      } else if (operationType === null) throw new Error('missing source header');
      if (header.kind === 'turn_new_messages') {
        const context = ContextSchema.parse(event);
        if (context.turn !== contextTurn + 1 || contextTurn !== modelTurns) throw new Error('context turn gap');
        contextTurn = context.turn;
      }
      if (header.kind === 'turn_model_response') {
        const response = ResponseSchema.parse(event);
        if (response.turn !== modelTurns + 1 || response.turn !== contextTurn) throw new Error('response turn gap');
        modelTurns = response.turn;
      }
    } catch {
      // Never include private source text or a schema diagnostic containing payload values.
      throw new Error(`Run ${requestId} archive line ${lineNumber} has malformed, unsupported, or out-of-order turn evidence.`);
    }
    events.push({ lineNumber, kind: header.kind, event });
  }
  if (operationType === null) throw new Error(`Run ${requestId} is missing its source header.`);
  const tools = readChatToolResultsFromTranscript({ requestId, source: selected.sourceKind, operationType, events, parseError: null });
  return {
    modelTurns,
    completedToolResults: tools.outcomes.length,
    executedToolResults: tools.outcomes.filter(outcome => outcome.exitCode !== null).length,
    rejectedToolResults: tools.outcomes.filter(outcome => outcome.exitCode === null).length,
    tools,
    events,
    operationType,
    sources: digestChatArchiveSources(validated),
  };
}

export function reconstructChatArchiveContext(archive: ReturnType<typeof readChatHistoryArchive>) {
  let messages: ChatMessage[] = [];
  let messageTurns: number[] = [];
  let compactions = 0;
  let pendingCompaction: number | null = null;
  let contextTurn = 0;
  let lastResponse: z.infer<typeof ResponseSchema> | null = null;
  for (const entry of archive.events) {
    if (entry.kind === 'turn_preflight_compaction_applied') {
      const compaction = z.object({ turn: z.number().int().positive(), droppedMessageCount: z.number().int().nonnegative() }).parse(entry.event);
      if (pendingCompaction !== null || compaction.turn !== contextTurn + 1) {
        throw new Error(`Archive line ${entry.lineNumber} has an unordered compaction boundary.`);
      }
      pendingCompaction = compaction.turn;
    }
    if (entry.kind === 'turn_new_messages') {
      const context = ContextSchema.parse(entry.event);
      if (pendingCompaction !== null) {
        if (context.turn !== pendingCompaction) throw new Error(`Archive line ${entry.lineNumber} does not follow its compaction.`);
        // Historical TranscriptManager resets its logging cursor after replacement: this is the
        // entire retained history, including system instructions, summary, and the retained tail.
        messages = context.messages;
        messageTurns = context.messages.map(() => 0);
        compactions++;
        pendingCompaction = null;
      } else {
        messages.push(...context.messages);
        messageTurns.push(...context.messages.map(() => Math.max(0, context.turn - 1)));
      }
      const violation = findPlannerContextViolation(messages);
      if (violation !== null) throw new Error(`Archive line ${entry.lineNumber} has invalid native tool pairing.`);
      contextTurn = context.turn;
    }
    if (entry.kind === 'turn_model_response') lastResponse = ResponseSchema.parse(entry.event);
  }
  if (pendingCompaction !== null) throw new Error('Archive has no native snapshot after its compaction boundary.');
  const gaps: string[] = [];
  if (lastResponse?.turn === contextTurn) {
    if (lastResponse.text || lastResponse.thinkingText) {
      messages.push({ role: 'assistant', content: lastResponse.text,
        ...(lastResponse.thinkingText ? { reasoning_content: lastResponse.thinkingText } : {}) });
      messageTurns.push(lastResponse.turn);
    }
    if (archive.tools.outcomes.some(outcome => outcome.turn === contextTurn)
      || archive.events.some(entry => entry.kind === 'turn_command_start' && entry.event.turn === contextTurn)) {
      gaps.push('The final tool batch has no subsequent native context record; its native arguments cannot be inferred from rendered commands.');
    }
  }
  return { messages, messageTurns, compactions, sourceEventCount: archive.events.length, gaps, continuationReady: gaps.length === 0 };
}
