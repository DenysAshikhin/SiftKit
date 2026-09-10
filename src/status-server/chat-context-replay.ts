import {
  applyChatStreamTextDelta,
  ChatRecoveryIssueSchema,
  CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS,
  type ChatRecoveryIssue,
  type ChatRecoveryIssueCode,
  type ChatRecoveryStatus,
  type ChatToolExecutionState,
} from '@siftkit/contracts';
import { buildAssistantToolCallMessage, buildToolResultMessage } from '../tool-call-messages.js';
import {
  findPlannerContextViolation,
  type ChatMessage,
} from '../repo-search/planner-chat-message.js';
import type { JsonObject } from '../lib/json-types.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import type { ChatJournalEnvelope, ChatJournalEvent } from '../state/chat-journal-schema.js';
import type { RuntimeDatabase } from '../state/database-handle.js';

/** One journal page; the whole run is read in pages so memory follows the page, not the chat. */
const EVENT_PAGE_SIZE = 500;

/**
 * What a recovered run knows about one of its tool calls. `not_started` and `uncertain` are the
 * two interruption outcomes, and they stay apart: only the second one obliges the next model to
 * verify the repository before retrying.
 */
export type ChatRecoveredToolExecution = {
  toolCallId: string;
  executionState: ChatToolExecutionState;
};

export type ChatRecoveredContext = {
  status: ChatRecoveryStatus;
  messages: ChatMessage[];
  contextRevision: number;
  turnBoundary: number;
  toolExecutions: ChatRecoveredToolExecution[];
  issues: ChatRecoveryIssue[];
};

export type ChatRecoveredHistory = {
  sessionId: string;
  operationId: string | null;
  status: ChatRecoveryStatus;
  /** Protocol-valid planner history without the system prompt: the next run builds its own. */
  messages: ChatMessage[];
  interruptionNotices: string[];
  issues: ChatRecoveryIssue[];
};

const PARTIAL_ANSWER_NOTICE =
  'The previous run stopped before it finished its answer; its partial narration is included above.';
const INTERRUPTED_BATCH_NOTICE =
  'The previous run was interrupted mid tool batch; unanswered calls were closed with explicit interruption results.';

function issue(
  operationId: string,
  code: ChatRecoveryIssueCode,
  detail: string,
  anchor: { eventId: string | null; sequence: number | null },
): ChatRecoveryIssue {
  return ChatRecoveryIssueSchema.parse({
    code,
    operationId,
    eventId: anchor.eventId,
    sequence: anchor.sequence,
    detail: detail.slice(0, CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS),
  });
}

function failure(operationId: string, recoveryIssue: ChatRecoveryIssue): ChatRecoveredContext {
  return {
    status: 'recovery_failed',
    messages: [],
    contextRevision: 0,
    turnBoundary: 0,
    toolExecutions: [],
    issues: [recoveryIssue],
  };
}

/** Where a proposed call got to, from the evidence alone. */
class ToolCallRecord {
  startedAt: string | null = null;
  output: string | null = null;
  finalizedText: string | null = null;
  rejected = false;

  constructor(readonly toolCallId: string, readonly toolName: string, readonly commandArguments: JsonObject) {}

  get executionState(): ChatToolExecutionState {
    if (this.rejected) return 'rejected';
    if (this.output !== null) return 'completed';
    return this.startedAt === null ? 'not_started' : 'uncertain';
  }

  /** The exact text the model should read: the finalized replacement wins over the raw result. */
  get modelVisibleText(): string {
    if (this.finalizedText !== null) return this.finalizedText;
    if (this.output !== null) return this.output;
    return this.startedAt === null
      ? `[interrupted] ${this.toolName} was never started. No work was performed; it is safe to retry.`
      : `[interrupted] ${this.toolName} started but the server stopped before its result was recorded.`
        + ' Outcome uncertain: verify the repository state before retrying.';
  }
}

/**
 * Rebuilds the planner history a run was working from, out of the events it committed. A gap, a
 * splice recorded against another revision, or a mutation that reaches past the context it amends
 * ends the replay: a caller gets a named integrity failure rather than a plausible-looking prefix.
 */
export function replayChatContext(events: readonly ChatJournalEnvelope[]): ChatRecoveredContext {
  const first = events[0];
  if (first === undefined) {
    return { status: 'ok', messages: [], contextRevision: 0, turnBoundary: 0, toolExecutions: [], issues: [] };
  }
  const operationId = first.operationId;

  let expectedSequence = first.sequence;
  for (const envelope of events) {
    if (envelope.sequence !== expectedSequence) {
      return failure(operationId, issue(
        operationId,
        'sequence_gap',
        `expected sequence ${String(expectedSequence)} but read ${String(envelope.sequence)}`,
        { eventId: envelope.eventId, sequence: envelope.sequence },
      ));
    }
    expectedSequence += 1;
  }

  let messages: ChatMessage[] | null = null;
  let contextRevision = 0;
  let turnBoundary = 0;
  const toolCalls = new Map<string, ToolCallRecord>();
  const batches = new Map<string, string[]>();
  /** Every call ever written into history, including ones a later splice removed. */
  const declaredCallIds = new Set<string>();

  for (const envelope of events) {
    const anchor = { eventId: envelope.eventId, sequence: envelope.sequence };
    const event = envelope.event;
    if (event.kind === 'context_initialized') {
      if (messages !== null) {
        return failure(operationId, issue(operationId, 'context_gap', 'context initialized twice', anchor));
      }
      messages = [...event.messages];
      collectDeclaredCallIds(event.messages, declaredCallIds);
      contextRevision = event.contextRevision;
      turnBoundary = event.turnBoundary;
      continue;
    }
    if (event.kind === 'context_spliced') {
      if (messages === null) {
        return failure(operationId, issue(operationId, 'context_gap', 'splice before any initial context', anchor));
      }
      if (event.expectedRevision !== contextRevision) {
        return failure(operationId, issue(
          operationId,
          'context_gap',
          `splice expected revision ${String(event.expectedRevision)} but replay is at ${String(contextRevision)}`,
          anchor,
        ));
      }
      if (event.startIndex + event.deleteCount > messages.length) {
        return failure(operationId, issue(
          operationId,
          'context_gap',
          `splice at ${String(event.startIndex)}+${String(event.deleteCount)} exceeds ${String(messages.length)} messages`,
          anchor,
        ));
      }
      messages.splice(event.startIndex, event.deleteCount, ...event.inserted);
      collectDeclaredCallIds(event.inserted, declaredCallIds);
      contextRevision = event.contextRevision;
      turnBoundary = event.turnBoundary;
      continue;
    }
    recordToolEvidence(event, toolCalls, batches);
  }

  if (messages === null) {
    return failure(operationId, issue(operationId, 'context_gap', 'no initial context was recorded', {
      eventId: first.eventId,
      sequence: first.sequence,
    }));
  }

  const closed = closeInterruptedBatches(messages, toolCalls, batches, declaredCallIds);
  const violation = findPlannerContextViolation(messages);
  if (violation !== null) {
    return failure(operationId, issue(operationId, 'context_gap', violation, {
      eventId: null,
      sequence: null,
    }));
  }

  return {
    status: closed ? 'recovery_needed' : 'ok',
    messages,
    contextRevision,
    turnBoundary,
    toolExecutions: [...toolCalls.values()].map((record) => ({
      toolCallId: record.toolCallId,
      executionState: record.executionState,
    })),
    issues: [],
  };
}

function recordToolEvidence(
  event: ChatJournalEvent,
  toolCalls: Map<string, ToolCallRecord>,
  batches: Map<string, string[]>,
): void {
  if (event.kind === 'tool_proposed') {
    const record = new ToolCallRecord(event.call.toolCallId, event.toolName, event.arguments);
    toolCalls.set(record.toolCallId, record);
    const batch = batches.get(event.call.batchId) ?? [];
    batch[event.call.indexInBatch] = record.toolCallId;
    batches.set(event.call.batchId, batch);
    return;
  }
  if (event.kind === 'tool_started') {
    const record = toolCalls.get(event.call.toolCallId);
    if (record) record.startedAt = event.startedAtUtc;
    return;
  }
  if (event.kind === 'tool_result') {
    const record = toolCalls.get(event.call.toolCallId);
    if (record) {
      record.output = event.output;
      record.rejected = event.executionState === 'rejected';
    }
    return;
  }
  if (event.kind === 'tool_result_finalized') {
    const record = toolCalls.get(event.call.toolCallId);
    if (record) record.finalizedText = event.modelVisibleText;
  }
}

function collectDeclaredCallIds(messages: readonly ChatMessage[], declared: Set<string>): void {
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) declared.add(toolCall.id);
  }
}

/**
 * Closes any batch whose assistant message never reached history: completed calls keep their exact
 * result, the rest get an interruption answer. A compacted batch is finished, so it is not reopened.
 */
function closeInterruptedBatches(
  messages: ChatMessage[],
  toolCalls: Map<string, ToolCallRecord>,
  batches: ReadonlyMap<string, string[]>,
  declaredCallIds: ReadonlySet<string>,
): boolean {
  let closed = false;
  for (const batch of batches.values()) {
    const records = batch
      .map((toolCallId) => toolCalls.get(toolCallId))
      .filter((record): record is ToolCallRecord => (
        record !== undefined && !declaredCallIds.has(record.toolCallId)
      ));
    if (records.length === 0) continue;
    const outcomes = records.map((record) => ({
      action: { toolName: record.toolName, args: record.commandArguments },
      toolCallId: record.toolCallId,
      toolContent: record.modelVisibleText,
    }));
    messages.push(buildAssistantToolCallMessage(outcomes));
    for (const record of records) {
      messages.push(buildToolResultMessage(record.toolCallId, record.modelVisibleText));
    }
    closed = true;
  }
  return closed;
}

/**
 * The conversation a continuation starts from. The system prompt and retention policy are rebuilt
 * by the run that is about to start; what is recovered here is only what was actually said.
 */
export function buildRecoveredChatHistory(database: RuntimeDatabase, sessionId: string): ChatRecoveredHistory {
  const store = new ChatJournalStore(database);
  const runs = store.listSessionRuns(sessionId);
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const events = readAllEvents(store, run.operationId);
    if (events.length === 0) continue;
    return buildHistoryFromRun(sessionId, run.operationId, events);
  }
  return { sessionId, operationId: null, status: 'ok', messages: [], interruptionNotices: [], issues: [] };
}

function buildHistoryFromRun(
  sessionId: string,
  operationId: string,
  events: readonly ChatJournalEnvelope[],
): ChatRecoveredHistory {
  const replayed = replayChatContext(events);
  if (replayed.status === 'recovery_failed') {
    return {
      sessionId,
      operationId,
      status: 'recovery_failed',
      messages: [],
      interruptionNotices: [],
      issues: replayed.issues,
    };
  }

  const messages = replayed.messages.filter((message) => message.role !== 'system');
  const interruptionNotices = replayed.status === 'recovery_needed' ? [INTERRUPTED_BATCH_NOTICE] : [];
  const partialAnswer = collectPartialAssistantText(events);
  if (partialAnswer !== null && !messages.some((message) => contains(message, partialAnswer))) {
    messages.push({ role: 'assistant', content: `[interrupted] ${partialAnswer}` });
    interruptionNotices.push(PARTIAL_ANSWER_NOTICE);
  }

  return {
    sessionId,
    operationId,
    status: interruptionNotices.length === 0 ? 'ok' : 'recovery_needed',
    messages,
    interruptionNotices,
    issues: [],
  };
}

function contains(message: ChatMessage, text: string): boolean {
  return typeof message.content === 'string' && message.content.includes(text);
}

/**
 * The narration and answer text the run had already committed for display, folded back together.
 * It is included once, tagged, because a user who watched the model say something and then lose
 * the server should not see that sentence vanish from the conversation it continues.
 */
function collectPartialAssistantText(events: readonly ChatJournalEnvelope[]): string | null {
  const byTurn = new Map<string, string>();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.kind !== 'display') continue;
    if (event.event.kind !== 'narration' && event.event.kind !== 'answer') continue;
    const key = `${event.event.kind}:${String(event.event.delta.turn)}`;
    byTurn.set(key, applyChatStreamTextDelta(byTurn.get(key) ?? '', event.event.delta));
  }
  const text = [...byTurn.values()].map((value) => value.trim()).filter((value) => value !== '').join('\n\n');
  return text === '' ? null : text;
}

function readAllEvents(store: ChatJournalStore, operationId: string): ChatJournalEnvelope[] {
  const events: ChatJournalEnvelope[] = [];
  let cursor = 0;
  for (;;) {
    const page = store.readAfter(operationId, cursor, EVENT_PAGE_SIZE);
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page[page.length - 1].sequence;
  }
}
