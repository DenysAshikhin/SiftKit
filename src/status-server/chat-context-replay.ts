import { buildChatRunMessageIdPrefix, buildChatMessageId, reduceChatTranscript, type ChatTranscriptMessage, ChatRecoveryIssueSchema, CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS, type ChatRecoveryIssue, type ChatRecoveryIssueCode, type ChatRecoveryStatus, type ChatToolExecutionState } from '@siftkit/contracts';
import { buildAssistantToolCallMessage, buildToolResultMessage } from '../tool-call-messages.js';
import {
  findPlannerContextViolation,
  type ChatMessage,
} from '../repo-search/planner-chat-message.js';
import type { JsonObject } from '../lib/json-types.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import type { ChatHistoryRevision, ChatJournalEnvelope, ChatJournalEvent, ChatToolCallIdentity } from '../state/chat-journal-schema.js';
import { applyChatContextRevisions } from '../state/chat-history-revisions.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { buildUserContent } from '../llm-protocol/image-attachments.js';

/** One journal page; the whole run is read in pages so memory follows the page, not the chat. */

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

  constructor(readonly call: ChatToolCallIdentity, readonly toolName: string, readonly commandArguments: JsonObject) {}

  get toolCallId(): string { return this.call.toolCallId; }

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

  let expectedSequence = 1;
  for (const envelope of events) {
    if (envelope.operationId !== operationId) {
      return failure(operationId, issue(operationId, 'context_gap', 'journal events name different operations', { eventId: envelope.eventId, sequence: envelope.sequence }));
    }
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
  const pendingQueue = new Map<string, Extract<ChatJournalEvent, { kind: 'queue_delivered' }>['message']>();

  for (const envelope of events) {
    const anchor = { eventId: envelope.eventId, sequence: envelope.sequence };
    const event = envelope.event;
    if (event.kind === 'queue_delivered') pendingQueue.set(event.message.id, event.message);
    if (event.kind === 'context_initialized' || event.kind === 'context_spliced') {
      for (const id of event.queueMessageIds ?? []) pendingQueue.delete(id);
    }
    if (event.kind === 'context_initialized') {
      if (messages !== null) {
        return failure(operationId, issue(operationId, 'context_gap', 'context initialized twice', anchor));
      }
      if (event.contextRevision !== 0 || event.turnBoundary > event.messages.length) {
        return failure(operationId, issue(operationId, 'context_gap', 'invalid initial context revision or turn boundary', anchor));
      }
      messages = [...event.messages];
      collectDeclaredCallIds(event.messages.slice(event.turnBoundary), toolCalls, declaredCallIds);
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
      if (event.contextRevision !== contextRevision + 1 || event.turnBoundary > messages.length - event.deleteCount + event.inserted.length) {
        return failure(operationId, issue(operationId, 'context_gap', 'invalid next context revision or turn boundary', anchor));
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
      collectDeclaredCallIds(event.inserted.slice(Math.max(0, event.turnBoundary - event.startIndex)), toolCalls, declaredCallIds);
      contextRevision = event.contextRevision;
      turnBoundary = event.turnBoundary;
      continue;
    }
    const invalidToolEvidence = recordToolEvidence(envelope, toolCalls, batches);
    if (invalidToolEvidence) return failure(operationId, invalidToolEvidence);
  }

  if (messages === null) {
    return failure(operationId, issue(operationId, 'context_gap', 'no initial context was recorded', {
      eventId: first.eventId,
      sequence: first.sequence,
    }));
  }

  const closed = closeInterruptedBatches(messages, toolCalls, batches, declaredCallIds, operationId);
  for (const queued of pendingQueue.values()) messages.push({ role: 'user', content: buildUserContent(queued.content, queued.images), chatMessageId: queued.id });
  const violation = findPlannerContextViolation(messages);
  if (violation !== null) {
    return failure(operationId, issue(operationId, 'context_gap', violation, {
      eventId: null,
      sequence: null,
    }));
  }

  return {
    status: closed || pendingQueue.size > 0 ? 'recovery_needed' : 'ok',
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
  envelope: ChatJournalEnvelope,
  toolCalls: Map<string, ToolCallRecord>,
  batches: Map<string, string[]>,
): ChatRecoveryIssue | null {
  const event = envelope.event;
  const anchor = { eventId: envelope.eventId, sequence: envelope.sequence };
  if (event.kind === 'tool_proposed') {
    const batch = batches.get(event.call.batchId) ?? [];
    if (toolCalls.has(event.call.displayToolCallId) || event.call.indexInBatch !== batch.length) {
      return issue(envelope.operationId, 'conflicting_event', 'tool proposal duplicates an identity or leaves a batch gap', anchor);
    }
    const record = new ToolCallRecord(event.call, event.toolName, event.arguments);
    toolCalls.set(event.call.displayToolCallId, record);
    batch[event.call.indexInBatch] = event.call.displayToolCallId;
    batches.set(event.call.batchId, batch);
    return null;
  }
  if (event.kind !== 'tool_started' && event.kind !== 'tool_result' && event.kind !== 'tool_result_finalized') return null;
  const record = toolCalls.get(event.call.displayToolCallId);
  if (!record) return issue(envelope.operationId, 'context_gap', 'tool evidence has no proposal', anchor);
  if (record.call.toolCallId !== event.call.toolCallId || record.call.batchId !== event.call.batchId
    || record.call.turn !== event.call.turn || record.call.indexInBatch !== event.call.indexInBatch) {
    return issue(envelope.operationId, 'conflicting_event', 'tool evidence disagrees with its proposed identity', anchor);
  }
  if (event.kind === 'tool_started') {
    if (record.startedAt !== null || record.output !== null) return issue(envelope.operationId, 'conflicting_event', 'tool start follows prior execution evidence', anchor);
    record.startedAt = event.startedAtUtc;
    return null;
  }
  if (event.kind === 'tool_result') {
    if (record.output !== null) return issue(envelope.operationId, 'conflicting_event', 'tool has more than one committed result', anchor);
    record.output = event.output;
    record.rejected = event.executionState === 'rejected';
    return null;
  }
  if (record.output === null) return issue(envelope.operationId, 'context_gap', 'tool finalization has no full result', anchor);
  record.finalizedText = event.modelVisibleText;
  return null;
}

function collectDeclaredCallIds(messages: readonly ChatMessage[], records: ReadonlyMap<string, ToolCallRecord>, declared: Set<string>): void {
  const latest = new Map([...records.values()].map(record => [record.toolCallId, record.call.displayToolCallId]));
  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      const id = latest.get(toolCall.id);
      if (id) declared.add(id);
    }
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
  operationId: string,
): boolean {
  let closed = false;
  for (const batch of batches.values()) {
    const records = batch
      .map((toolCallId) => toolCalls.get(toolCallId))
      .filter((record): record is ToolCallRecord => (
        record !== undefined && !declaredCallIds.has(record.call.displayToolCallId)
      ));
    if (records.length === 0) continue;
    const outcomes = records.map((record) => ({
      action: { toolName: record.toolName, args: record.commandArguments },
      toolCallId: record.toolCallId,
      toolContent: record.modelVisibleText,
    }));
    messages.push(buildAssistantToolCallMessage(outcomes));
    for (const record of records) {
      messages.push({ ...buildToolResultMessage(record.toolCallId, record.modelVisibleText),
        chatMessageId: buildChatMessageId(buildChatRunMessageIdPrefix(operationId), { kind: 'tool', toolCallId: record.call.displayToolCallId }) });
    }
    closed = true;
  }
  return closed;
}

/**
 * The conversation a continuation starts from. The system prompt and retention policy are rebuilt
 * by the run that is about to start; what is recovered here is only what was actually said.
 */
export function buildRecoveredChatHistory(database: RuntimeDatabase, sessionId: string, beforeOperationId?: string): ChatRecoveredHistory {
  const store = new ChatJournalStore(database);
  const runs = store.listSessionRuns(sessionId);
  const revisions: ChatHistoryRevision[] = [];
  let history: ChatRecoveredHistory = { sessionId, operationId: null, status: 'ok', messages: [], interruptionNotices: [], issues: [] };
  for (const run of runs) {
    if (run.operationId === beforeOperationId) break;
    const events = [...store.readAll(run.operationId)];
    if (events.length === 0) continue;
    if (events.some(envelope => envelope.event.kind === 'submission_cancelled')) continue;
    if (run.recordKind === 'history_revision') {
      for (const envelope of events) {
        if (envelope.event.kind === 'history_revised') revisions.push(envelope.event.revision);
      }
      history = { ...history, messages: applyChatContextRevisions(history.messages, revisions) };
      continue;
    }
    const baseline = events.find(envelope => envelope.event.kind === 'baseline_imported')?.event;
    if (baseline?.kind === 'baseline_imported') {
      history = { ...history, operationId: run.operationId, messages: baseline.retainedContext };
      continue;
    }
    if (!events.some(envelope => envelope.event.kind === 'context_initialized')) {
      const submission = events.find(envelope => envelope.event.kind === 'run_started')?.event;
      if (submission?.kind === 'run_started' && submission.operationKind === 'condense') continue;
      if (submission?.kind === 'run_started' && !events.some(envelope => envelope.event.kind.startsWith('tool_'))) {
        history = { ...history, operationId: run.operationId, messages: [
          ...history.messages, { role: 'user', content: buildUserContent(submission.content, submission.images), chatMessageId: submission.userMessageId },
          ...events.flatMap(envelope => envelope.event.kind === 'queue_delivered' && envelope.event.message.id !== submission.userMessageId
            ? [{ role: 'user' as const, content: buildUserContent(envelope.event.message.content, envelope.event.message.images), chatMessageId: envelope.event.message.id }] : []),
        ] };
        continue;
      }
    }
    history = buildHistoryFromRun(sessionId, run.operationId, events);
    if (history.status === 'recovery_failed') return history;
    history = { ...history, messages: applyChatContextRevisions(history.messages, revisions) };
  }
  return history;
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
  const partialMessages = collectPartialAssistantMessages(events);
  if (partialMessages.length > 0) {
    messages.push(...partialMessages);
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

/**
 * The narration and answer text the run had already committed for display, folded back together.
 * It is included once, tagged, because a user who watched the model say something and then lose
 * the server should not see that sentence vanish from the conversation it continues.
 */
function collectPartialAssistantMessages(events: readonly ChatJournalEnvelope[]): ChatMessage[] {
  let displayed: ChatTranscriptMessage[] = [];
  const declared = new Set<string>();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.kind === 'context_initialized' || event.kind === 'context_spliced') {
      const inserted = event.kind === 'context_initialized' ? event.messages : event.inserted;
      for (const message of inserted) {
        if (message.chatMessageId !== undefined) declared.add(message.chatMessageId);
      }
      if (event.kind === 'context_spliced' && event.reason === 'compacted') displayed = [];
    }
    if (event.kind !== 'display') continue;
    if (event.event.kind !== 'narration' && event.event.kind !== 'answer') continue;
    displayed = reduceChatTranscript(displayed, event.event, {
      messageIdPrefix: buildChatRunMessageIdPrefix(envelope.operationId),
      sourceRunId: envelope.operationId, createdAtUtc: envelope.recordedAtUtc,
    });
  }
  return displayed.filter(message => !declared.has(message.id) && message.content.trim() !== '')
    .map(message => ({ role: 'assistant', content: `[interrupted] ${message.content}`, chatMessageId: message.id }));
}

