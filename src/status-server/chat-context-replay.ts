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

type Anchor = { eventId: string | null; sequence: number | null };
type QueuedMessage = Extract<ChatJournalEvent, { kind: 'queue_delivered' }>['message'];
type SpliceEvent = Extract<ChatJournalEvent, { kind: 'context_spliced' }>;

function issue(operationId: string, code: ChatRecoveryIssueCode, detail: string, anchor: Anchor): ChatRecoveryIssue {
  return ChatRecoveryIssueSchema.parse({
    code,
    operationId,
    eventId: anchor.eventId,
    sequence: anchor.sequence,
    detail: detail.slice(0, CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS),
  });
}

function failure(recoveryIssue: ChatRecoveryIssue): ChatRecoveredContext {
  return {
    status: 'recovery_failed',
    messages: [],
    contextRevision: 0,
    turnBoundary: 0,
    toolExecutions: [],
    issues: [recoveryIssue],
  };
}

/** Where a proposed call got to, from the evidence alone. Payloads are dropped once history answers the call. */
class ToolCallRecord {
  started = false;
  completed = false;
  rejected = false;
  represented = false;
  private recoveryArguments: JsonObject | null;
  private output: string | null = null;
  private finalizedText: string | null = null;

  constructor(readonly call: ChatToolCallIdentity, readonly toolName: string, commandArguments: JsonObject) {
    this.recoveryArguments = commandArguments;
  }

  get toolCallId(): string { return this.call.toolCallId; }

  get executionState(): ChatToolExecutionState {
    if (this.rejected) return 'rejected';
    if (this.completed) return 'completed';
    return this.started ? 'uncertain' : 'not_started';
  }

  get retainsPayload(): boolean {
    return this.recoveryArguments !== null || this.output !== null || this.finalizedText !== null;
  }

  get commandArguments(): JsonObject {
    if (this.recoveryArguments === null) throw new Error(`Tool call ${this.call.displayToolCallId} no longer retains its arguments.`);
    return this.recoveryArguments;
  }

  recordOutput(output: string, rejected: boolean): void {
    this.completed = true;
    this.rejected = rejected;
    if (!this.represented) this.output = output;
  }

  recordFinalized(modelVisibleText: string): void {
    if (!this.represented) this.finalizedText = modelVisibleText;
  }

  markRepresented(): void {
    this.represented = true;
    this.recoveryArguments = null;
    this.output = null;
    this.finalizedText = null;
  }

  /** The exact text the model should read: the finalized replacement wins over the raw result. */
  get modelVisibleText(): string {
    if (this.finalizedText !== null) return this.finalizedText;
    if (this.output !== null) return this.output;
    return this.started
      ? `[interrupted] ${this.toolName} started but the server stopped before its result was recorded.`
        + ' Outcome uncertain: verify the repository state before retrying.'
      : `[interrupted] ${this.toolName} was never started. No work was performed; it is safe to retry.`;
  }
}

/**
 * Folds one run's events, in order and once, into the planner history it was working from. A gap,
 * a splice against another revision, or a mutation past the context it amends fails the replay:
 * the caller gets a named integrity failure rather than a plausible-looking prefix.
 */
export class ChatContextReplay {
  private operationId: string | null = null;
  private firstAnchor: Anchor = { eventId: null, sequence: null };
  private expectedSequence = 1;
  private failed: ChatRecoveryIssue | null = null;
  private messages: ChatMessage[] | null = null;
  private contextRevision = 0;
  private turnBoundary = 0;
  private contextLength = 0;
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly batches = new Map<string, string[]>();
  /** Every call ever written into history, including ones a later splice removed. */
  private readonly declaredCallIds = new Set<string>();
  private readonly pendingQueue = new Map<string, QueuedMessage>();
  private displayed: ChatTranscriptMessage[] = [];
  private readonly declaredMessageIds = new Set<string>();

  /** Messages the recorded context holds before interruption closure or queued deliveries. */
  get rawContextLength(): number { return this.contextLength; }

  /** Committed narration the run never wrote into context, tagged so the user keeps what they saw. */
  get partialAssistantMessages(): readonly ChatMessage[] {
    return this.displayed.filter(message => !this.declaredMessageIds.has(message.id) && message.content.trim() !== '')
      .map(message => ({ role: 'assistant', content: `[interrupted] ${message.content}`, chatMessageId: message.id }));
  }

  /** Display IDs whose full result text is still held because history has not answered them. */
  retainedToolPayloadIds(): string[] {
    return [...this.toolCalls.values()].filter(record => record.retainsPayload).map(record => record.call.displayToolCallId);
  }

  apply(envelope: ChatJournalEnvelope): void {
    if (this.failed !== null) return;
    const anchor = { eventId: envelope.eventId, sequence: envelope.sequence };
    if (this.operationId === null) {
      this.operationId = envelope.operationId;
      this.firstAnchor = anchor;
    }
    const operationId = this.operationId;
    if (envelope.operationId !== operationId) {
      this.failed = issue(operationId, 'context_gap', 'journal events name different operations', anchor);
      return;
    }
    if (envelope.sequence !== this.expectedSequence) {
      this.failed = issue(operationId, 'sequence_gap', `expected sequence ${String(this.expectedSequence)} but read ${String(envelope.sequence)}`, anchor);
      return;
    }
    this.expectedSequence += 1;
    const event = envelope.event;
    if (event.kind === 'queue_delivered') this.pendingQueue.set(event.message.id, event.message);
    if (event.kind === 'context_initialized' || event.kind === 'context_spliced') {
      for (const id of event.queueMessageIds ?? []) this.pendingQueue.delete(id);
      const inserted = event.kind === 'context_initialized' ? event.messages : event.inserted;
      for (const message of inserted) {
        if (message.chatMessageId !== undefined) this.declaredMessageIds.add(message.chatMessageId);
      }
      if (event.kind === 'context_spliced' && event.reason === 'compacted') this.displayed = [];
    }
    if (event.kind === 'context_initialized') {
      if (this.messages !== null) {
        this.failed = issue(operationId, 'context_gap', 'context initialized twice', anchor);
        return;
      }
      if (event.contextRevision !== 0 || event.turnBoundary > event.messages.length) {
        this.failed = issue(operationId, 'context_gap', 'invalid initial context revision or turn boundary', anchor);
        return;
      }
      this.messages = [...event.messages];
      this.contextLength = event.messages.length;
      this.collectDeclaredCallIds(event.messages.slice(event.turnBoundary));
      this.contextRevision = event.contextRevision;
      this.turnBoundary = event.turnBoundary;
      return;
    }
    if (event.kind === 'context_spliced') {
      this.failed = this.applySplice(operationId, event, anchor);
      return;
    }
    if (event.kind === 'display' && (event.event.kind === 'narration' || event.event.kind === 'answer')) {
      this.displayed = reduceChatTranscript(this.displayed, event.event, {
        messageIdPrefix: buildChatRunMessageIdPrefix(operationId), sourceRunId: operationId, createdAtUtc: envelope.recordedAtUtc,
      });
      return;
    }
    this.failed = this.recordToolEvidence(envelope);
  }

  finish(): ChatRecoveredContext {
    if (this.failed !== null) return failure(this.failed);
    const operationId = this.operationId;
    if (operationId === null) {
      return { status: 'ok', messages: [], contextRevision: 0, turnBoundary: 0, toolExecutions: [], issues: [] };
    }
    const messages = this.messages;
    if (messages === null) return failure(issue(operationId, 'context_gap', 'no initial context was recorded', this.firstAnchor));
    const closed = this.closeInterruptedBatches(messages, operationId);
    for (const queued of this.pendingQueue.values()) {
      messages.push({ role: 'user', content: buildUserContent(queued.content, queued.images), chatMessageId: queued.id });
    }
    const violation = findPlannerContextViolation(messages);
    if (violation !== null) return failure(issue(operationId, 'context_gap', violation, { eventId: null, sequence: null }));
    return {
      status: closed || this.pendingQueue.size > 0 ? 'recovery_needed' : 'ok',
      messages,
      contextRevision: this.contextRevision,
      turnBoundary: this.turnBoundary,
      toolExecutions: [...this.toolCalls.values()].map((record) => ({
        toolCallId: record.toolCallId,
        executionState: record.executionState,
      })),
      issues: [],
    };
  }

  private applySplice(operationId: string, event: SpliceEvent, anchor: Anchor): ChatRecoveryIssue | null {
    const messages = this.messages;
    if (messages === null) return issue(operationId, 'context_gap', 'splice before any initial context', anchor);
    if (event.expectedRevision !== this.contextRevision) {
      return issue(operationId, 'context_gap',
        `splice expected revision ${String(event.expectedRevision)} but replay is at ${String(this.contextRevision)}`, anchor);
    }
    if (event.contextRevision !== this.contextRevision + 1 || event.turnBoundary > messages.length - event.deleteCount + event.inserted.length) {
      return issue(operationId, 'context_gap', 'invalid next context revision or turn boundary', anchor);
    }
    if (event.startIndex + event.deleteCount > messages.length) {
      return issue(operationId, 'context_gap',
        `splice at ${String(event.startIndex)}+${String(event.deleteCount)} exceeds ${String(messages.length)} messages`, anchor);
    }
    const coalescing = this.validateCoalescedCalls(event, messages);
    if (coalescing !== null) return issue(operationId, 'conflicting_event', coalescing, anchor);
    messages.splice(event.startIndex, event.deleteCount, ...event.inserted);
    this.contextLength += event.inserted.length - event.deleteCount;
    this.collectDeclaredCallIds(event.inserted.slice(Math.max(0, event.turnBoundary - event.startIndex)));
    for (const id of event.coalescedToolCallIds) {
      this.declaredCallIds.add(id);
      this.toolCalls.get(id)?.markRepresented();
    }
    this.contextRevision = event.contextRevision;
    this.turnBoundary = event.turnBoundary;
    return null;
  }

  private recordToolEvidence(envelope: ChatJournalEnvelope): ChatRecoveryIssue | null {
    const event = envelope.event;
    const anchor = { eventId: envelope.eventId, sequence: envelope.sequence };
    if (event.kind === 'tool_proposed') {
      const batch = this.batches.get(event.call.batchId) ?? [];
      if (this.toolCalls.has(event.call.displayToolCallId) || event.call.indexInBatch !== batch.length) {
        return issue(envelope.operationId, 'conflicting_event', 'tool proposal duplicates an identity or leaves a batch gap', anchor);
      }
      this.toolCalls.set(event.call.displayToolCallId, new ToolCallRecord(event.call, event.toolName, event.arguments));
      batch[event.call.indexInBatch] = event.call.displayToolCallId;
      this.batches.set(event.call.batchId, batch);
      return null;
    }
    if (event.kind !== 'tool_started' && event.kind !== 'tool_result' && event.kind !== 'tool_result_finalized') return null;
    const record = this.toolCalls.get(event.call.displayToolCallId);
    if (!record) return issue(envelope.operationId, 'context_gap', 'tool evidence has no proposal', anchor);
    if (record.call.toolCallId !== event.call.toolCallId || record.call.batchId !== event.call.batchId
      || record.call.turn !== event.call.turn || record.call.indexInBatch !== event.call.indexInBatch) {
      return issue(envelope.operationId, 'conflicting_event', 'tool evidence disagrees with its proposed identity', anchor);
    }
    if (event.kind === 'tool_started') {
      if (record.started || record.completed) return issue(envelope.operationId, 'conflicting_event', 'tool start follows prior execution evidence', anchor);
      record.started = true;
      return null;
    }
    if (event.kind === 'tool_result') {
      if (record.completed) return issue(envelope.operationId, 'conflicting_event', 'tool has more than one committed result', anchor);
      record.recordOutput(event.output, event.executionState === 'rejected');
      return null;
    }
    if (!record.completed) return issue(envelope.operationId, 'context_gap', 'tool finalization has no full result', anchor);
    record.recordFinalized(event.modelVisibleText);
    return null;
  }

  /**
   * A splice may declare rejected current calls as represented by the result it replaces. Every ID
   * must name a proposal with a committed rejection, once, on a replacement of one existing result.
   */
  private validateCoalescedCalls(event: SpliceEvent, messages: readonly ChatMessage[]): string | null {
    if (event.coalescedToolCallIds.length === 0) return null;
    const replaced = messages[event.startIndex];
    const inserted = event.inserted[0];
    if (event.reason !== 'tool_result_replaced' || event.deleteCount !== 1 || event.inserted.length !== 1
      || replaced?.role !== 'tool' || inserted?.role !== 'tool' || replaced.tool_call_id !== inserted.tool_call_id) {
      return 'coalesced tool calls require replacing exactly one existing tool result';
    }
    const seen = new Set<string>();
    for (const id of event.coalescedToolCallIds) {
      const record = this.toolCalls.get(id);
      if (!record || !record.rejected) return `coalesced tool call ${id} has no committed rejected result`;
      if (this.declaredCallIds.has(id) || seen.has(id)) return `coalesced tool call ${id} is already represented`;
      seen.add(id);
    }
    return null;
  }

  /** A call declared by the current turn's history is answered there; its payload is no longer needed. */
  private collectDeclaredCallIds(messages: readonly ChatMessage[]): void {
    const latest = new Map([...this.toolCalls.values()].map(record => [record.toolCallId, record]));
    for (const message of messages) {
      for (const toolCall of message.tool_calls ?? []) {
        const record = latest.get(toolCall.id);
        if (!record) continue;
        this.declaredCallIds.add(record.call.displayToolCallId);
        record.markRepresented();
      }
    }
  }

  /**
   * Closes any batch whose assistant message never reached history: completed calls keep their exact
   * result, the rest get an interruption answer. A compacted batch is finished, so it is not reopened.
   */
  private closeInterruptedBatches(messages: ChatMessage[], operationId: string): boolean {
    let closed = false;
    for (const batch of this.batches.values()) {
      const records = batch
        .map((toolCallId) => this.toolCalls.get(toolCallId))
        .filter((record): record is ToolCallRecord => record !== undefined && !this.declaredCallIds.has(record.call.displayToolCallId));
      if (records.length === 0) continue;
      messages.push(buildAssistantToolCallMessage(records.map((record) => ({
        action: { toolName: record.toolName, args: record.commandArguments },
        toolCallId: record.toolCallId,
        toolContent: record.modelVisibleText,
      }))));
      for (const record of records) {
        messages.push({ ...buildToolResultMessage(record.toolCallId, record.modelVisibleText),
          chatMessageId: buildChatMessageId(buildChatRunMessageIdPrefix(operationId), { kind: 'tool', toolCallId: record.call.displayToolCallId }) });
      }
      closed = true;
    }
    return closed;
  }
}

/** Rebuilds the planner history a run was working from, out of the events it committed. */
export function replayChatContext(events: Iterable<ChatJournalEnvelope>): ChatRecoveredContext {
  const replay = new ChatContextReplay();
  for (const envelope of events) replay.apply(envelope);
  return replay.finish();
}

/** The compact facts one pass over a run's events yields besides its replayed context. */
type RunScan = {
  eventCount: number;
  cancelled: boolean;
  initialized: boolean;
  sawTool: boolean;
  submission: Extract<ChatJournalEvent, { kind: 'run_started' }> | null;
  baseline: Extract<ChatJournalEvent, { kind: 'baseline_imported' }> | null;
  queued: QueuedMessage[];
  revisions: ChatHistoryRevision[];
};

function scanRun(events: Iterable<ChatJournalEnvelope>, replay: ChatContextReplay | null): RunScan {
  const scan: RunScan = { eventCount: 0, cancelled: false, initialized: false, sawTool: false, submission: null, baseline: null, queued: [], revisions: [] };
  for (const envelope of events) {
    scan.eventCount += 1;
    replay?.apply(envelope);
    const event = envelope.event;
    if (event.kind === 'submission_cancelled') scan.cancelled = true;
    else if (event.kind === 'context_initialized') scan.initialized = true;
    else if (event.kind === 'run_started') scan.submission = event;
    else if (event.kind === 'baseline_imported') scan.baseline = event;
    else if (event.kind === 'queue_delivered') scan.queued.push(event.message);
    else if (event.kind === 'history_revised') scan.revisions.push(event.revision);
    else if (event.kind.startsWith('tool_')) scan.sawTool = true;
  }
  return scan;
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
    const replay = run.recordKind === 'history_revision' ? null : new ChatContextReplay();
    const scan = scanRun(store.readAll(run.operationId), replay);
    if (scan.eventCount === 0 || scan.cancelled) continue;
    if (replay === null) {
      revisions.push(...scan.revisions);
      history = { ...history, messages: applyChatContextRevisions(history.messages, revisions) };
      continue;
    }
    if (scan.baseline !== null) {
      history = { ...history, operationId: run.operationId, messages: scan.baseline.retainedContext };
      continue;
    }
    if (!scan.initialized) {
      const submission = scan.submission;
      if (submission?.operationKind === 'condense') continue;
      if (submission !== null && !scan.sawTool) {
        history = { ...history, operationId: run.operationId, messages: [
          ...history.messages, { role: 'user', content: buildUserContent(submission.content, submission.images), chatMessageId: submission.userMessageId },
          ...scan.queued.filter(message => message.id !== submission.userMessageId)
            .map(message => ({ role: 'user' as const, content: buildUserContent(message.content, message.images), chatMessageId: message.id })),
        ] };
        continue;
      }
    }
    history = buildHistoryFromRun(sessionId, run.operationId, replay);
    if (history.status === 'recovery_failed') return history;
    history = { ...history, messages: applyChatContextRevisions(history.messages, revisions) };
  }
  return history;
}

function buildHistoryFromRun(sessionId: string, operationId: string, replay: ChatContextReplay): ChatRecoveredHistory {
  const replayed = replay.finish();
  if (replayed.status === 'recovery_failed') {
    return { sessionId, operationId, status: 'recovery_failed', messages: [], interruptionNotices: [], issues: replayed.issues };
  }
  const messages = replayed.messages.filter((message) => message.role !== 'system');
  const interruptionNotices = replayed.status === 'recovery_needed' ? [INTERRUPTED_BATCH_NOTICE] : [];
  const partialMessages = replay.partialAssistantMessages;
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
