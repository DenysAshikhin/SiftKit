import {
  buildChatRunMessageIdPrefix,
  ChatRecoveryIssueSchema,
  ChatRecoveryReportSchema,
  ChatTranscriptMessageSchema,
  CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS,
  toolCallStatusForExecutionState,
  PersistedChatTranscriptMessageSchema,
  reduceChatTranscript,
  type ChatRecoveryIssue,
  type ChatRecoveryIssueCode,
  type ChatRecoveryReport,
  type ChatRecoveryStatus,
  type ChatRunTerminalCause,
  type ChatToolExecutionState,
  type ChatTranscriptMessage,
  type ChatTranscriptMetadata,
  type PersistedChatTranscriptMessage,
} from '@siftkit/contracts';
import { stableStringify } from '../lib/json.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import type { ChatJournalEnvelope, ChatJournalEvent, ChatRun } from '../state/chat-journal-schema.js';
import {
  insertChatMessages,
  nextChatMessagePosition,
  readChatRunMessages,
} from '../state/chat-sessions.js';
import type { RuntimeDatabase } from '../state/database-handle.js';

const EVENT_PAGE_SIZE = 500;

/** What one run's evidence projects to, before any of it is written down. */
type ProjectedRun = {
  messages: PersistedChatTranscriptMessage[];
  toolCount: number;
  status: ChatRecoveryStatus;
  terminalCause: ChatRunTerminalCause | null;
};

function issue(
  operationId: string,
  code: ChatRecoveryIssueCode,
  detail: string,
): ChatRecoveryIssue {
  return ChatRecoveryIssueSchema.parse({
    code,
    operationId,
    eventId: null,
    sequence: null,
    detail: detail.slice(0, CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS),
  });
}

/**
 * How an unfinished call reads once its run is over. A call that never started is safe to retry;
 * one that started and never reported is not, and the two must not be flattened together.
 */
function settleInterruptedState(state: ChatToolExecutionState): ChatToolExecutionState {
  if (state === 'proposed' || state === 'pending_approval') return 'not_started';
  return state === 'executing' ? 'uncertain' : state;
}

/**
 * Folds one run's committed events into display rows. Live frames supply the shape of a tool row;
 * the journal's own tool events supply the execution state and the complete result.
 */
export function projectChatRunEvents(
  events: readonly ChatJournalEnvelope[],
  metadata: ChatTranscriptMetadata,
): ProjectedRun {
  let messages: ChatTranscriptMessage[] = [];
  let terminalCause: ChatRunTerminalCause | null = null;
  const toolCallIds = new Set<string>();

  for (const envelope of events) {
    messages = applyEvent(messages, envelope.event, metadata, toolCallIds);
    if (envelope.event.kind === 'run_finished') terminalCause = envelope.event.terminalCause;
  }

  const settled = terminalCause !== null
    ? messages.map((message) => (
      message.kind === 'assistant_tool_call'
        ? withExecutionState(message, settleInterruptedState(message.toolCallExecutionState))
        : message
    ))
    : messages;
  const interrupted = settled.some((message) => (
    message.kind === 'assistant_tool_call'
    && (message.toolCallExecutionState === 'not_started' || message.toolCallExecutionState === 'uncertain')
  ));

  return {
    messages: settled.map((message) => PersistedChatTranscriptMessageSchema.parse(message)),
    toolCount: toolCallIds.size,
    status: interrupted ? 'recovery_needed' : 'ok',
    terminalCause,
  };
}

function withExecutionState(
  message: Extract<ChatTranscriptMessage, { kind: 'assistant_tool_call' }>,
  executionState: ChatToolExecutionState,
): ChatTranscriptMessage {
  if (message.toolCallExecutionState === executionState) return message;
  return ChatTranscriptMessageSchema.parse({
    ...message,
    toolCallExecutionState: executionState,
    toolCallStatus: toolCallStatusForExecutionState(executionState),
  });
}

function applyEvent(
  messages: readonly ChatTranscriptMessage[],
  event: ChatJournalEvent,
  metadata: ChatTranscriptMetadata,
  toolCallIds: Set<string>,
): ChatTranscriptMessage[] {
  if (event.kind === 'run_started') {
    return reduceChatTranscript(messages, {
      kind: 'submission',
      message: { id: event.userMessageId, content: event.content, images: event.images },
    }, metadata);
  }
  if (event.kind === 'display') {
    return reduceChatTranscript(messages, event.event, metadata);
  }
  if (event.kind === 'queue_delivered') {
    return reduceChatTranscript(messages, { kind: 'user_message', message: event.message }, metadata);
  }
  if (event.kind === 'tool_proposed') {
    toolCallIds.add(event.call.displayToolCallId);
    const started = reduceChatTranscript(messages, {
      kind: 'tool',
      tool: {
        kind: 'tool_start',
        toolCallId: event.call.displayToolCallId,
        turn: event.call.turn,
        maxTurns: event.maxTurns,
        activityKind: event.activityKind,
        activitySubject: event.activitySubject,
        command: event.command,
        promptTokenCount: event.promptTokenCount,
      },
    }, metadata);
    return applyOutcome(started, metadata, {
      toolCallId: event.call.displayToolCallId,
      executionState: event.executionState,
      exitCode: null,
      output: null,
      outputTokens: 0,
      outputTokensEstimated: false,
    });
  }
  if (event.kind === 'tool_started') {
    return applyOutcome(messages, metadata, {
      toolCallId: event.call.displayToolCallId,
      executionState: 'executing',
      exitCode: null,
      output: null,
      outputTokens: 0,
      outputTokensEstimated: false,
    });
  }
  if (event.kind === 'tool_result') {
    return applyOutcome(messages, metadata, {
      toolCallId: event.call.displayToolCallId,
      executionState: event.executionState,
      exitCode: event.exitCode,
      output: event.output,
      outputTokens: event.outputTokens,
      outputTokensEstimated: event.outputTokensEstimated,
    });
  }
  if (event.kind === 'tool_result_finalized') {
    return applyOutcome(messages, metadata, {
      toolCallId: event.call.displayToolCallId,
      executionState: 'completed',
      exitCode: null,
      output: event.modelVisibleText,
      outputTokens: 0,
      outputTokensEstimated: false,
    });
  }
  return [...messages];
}

function applyOutcome(
  messages: readonly ChatTranscriptMessage[],
  metadata: ChatTranscriptMetadata,
  outcome: {
    toolCallId: string;
    executionState: ChatToolExecutionState;
    exitCode: number | null;
    output: string | null;
    outputTokens: number;
    outputTokensEstimated: boolean;
  },
): ChatTranscriptMessage[] {
  return reduceChatTranscript(messages, { kind: 'tool_outcome', outcome }, metadata);
}

function report(
  run: ChatRun,
  projected: ProjectedRun,
  changed: boolean,
  issues: readonly ChatRecoveryIssue[],
): ChatRecoveryReport {
  return ChatRecoveryReportSchema.parse({
    sessionId: run.sessionId,
    operationId: run.operationId,
    status: issues.length > 0 ? 'recovery_failed' : projected.status,
    terminalCause: projected.terminalCause ?? run.terminalCause,
    appliedSequence: run.latestSequence,
    eventCount: run.latestSequence,
    messageCount: projected.messages.length,
    toolCount: projected.toolCount,
    changed,
    issues,
  });
}

function readEvents(store: ChatJournalStore, operationId: string): ChatJournalEnvelope[] {
  const events: ChatJournalEnvelope[] = [];
  let cursor = 0;
  for (;;) {
    const page = store.readAfter(operationId, cursor, EVENT_PAGE_SIZE);
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page[page.length - 1].sequence;
  }
}

function missingRunReport(operationId: string): ChatRecoveryReport {
  return ChatRecoveryReportSchema.parse({
    sessionId: 'unknown',
    operationId,
    status: 'recovery_failed',
    terminalCause: null,
    appliedSequence: 0,
    eventCount: 0,
    messageCount: 0,
    toolCount: 0,
    changed: false,
    issues: [issue(operationId, 'missing_run', 'the run is unknown to the chat journal')],
  });
}

/**
 * Projects one run's evidence onto its display rows, replacing exactly the rows that run owns.
 * The journal is never touched: a projection that throws leaves the evidence to be retried.
 */
function projectRun(database: RuntimeDatabase, operationId: string, force: boolean): ChatRecoveryReport {
  const store = new ChatJournalStore(database);
  const run = store.readRun(operationId);
  if (run === null) return missingRunReport(operationId);
  if (!force && run.projectedSequence === run.latestSequence) {
    return report(run, { messages: [], toolCount: 0, status: 'ok', terminalCause: run.terminalCause }, false, []);
  }

  const events = readEvents(store, operationId);
  const projected = projectChatRunEvents(events, {
    messageIdPrefix: buildChatRunMessageIdPrefix(operationId),
    sourceRunId: operationId,
    createdAtUtc: run.createdAtUtc,
  });

  // Compared as stored on both sides, so "the rows already say this" is an exact answer rather
  // than a guess about which absent fields read back as NULL.
  const before = readChatRunMessages(database, run.sessionId, operationId);
  try {
    database.transaction(() => {
      database.prepare('DELETE FROM chat_messages WHERE session_id = ? AND source_run_id = ?')
        .run(run.sessionId, operationId);
      insertChatMessages(
        database,
        run.sessionId,
        projected.messages,
        nextChatMessagePosition(database, run.sessionId),
        run.createdAtUtc,
      );
      store.advanceProjection({ operationId, projectedSequence: run.latestSequence });
    })();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return report(run, projected, false, [issue(operationId, 'projection_failed', detail)]);
  }
  const after = readChatRunMessages(database, run.sessionId, operationId);
  return report(run, projected, stableStringify(before) !== stableStringify(after), []);
}


/** Brings a run's display rows up to its committed evidence, doing nothing when they agree. */
export function reconcileChatRun(database: RuntimeDatabase, operationId: string): ChatRecoveryReport {
  return projectRun(database, operationId, false);
}

/** Re-derives a run's display rows from event one, for when the projection itself was lost. */
export function rebuildChatRun(database: RuntimeDatabase, operationId: string): ChatRecoveryReport {
  return projectRun(database, operationId, true);
}
