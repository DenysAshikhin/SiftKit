import { toError } from '../lib/errors.js';
import { finalizeChatRunTranscript, buildChatRunMessageIdPrefix, buildChatMessageId, ChatRepoAgentApprovalMessageSchema, ChatRecoveryIssueSchema, ChatRecoveryReportSchema, CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS, PersistedChatTranscriptMessageSchema, reduceChatTranscript, type ChatRecoveryIssue, type ChatRecoveryIssueCode, type ChatRecoveryReport, type ChatRecoveryStatus, type ChatRunTerminalCause, type ChatToolOutcome, type ChatTranscriptMessage, type ChatTranscriptMetadata, type PersistedChatTranscriptMessage } from '@siftkit/contracts';
import { stableStringify, writeStableJson } from '../lib/json.js';
import { z } from '../lib/zod.js';
import { ChatJournalStore, ChatRecoveryInvariantError } from '../state/chat-journal.js';
import type { ChatJournalEnvelope, ChatJournalEvent, ChatRun } from '../state/chat-journal-schema.js';
import {
  insertChatMessages,
  nextChatMessagePosition,
  readChatRunMessages,
} from '../state/chat-sessions.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { COMPACTION_SUMMARY_MARKER } from '../repo-search/engine/transcript-compactor.js';
import { buildCompactionSummaryRow } from './chat.js';
import { applyChatDisplayRevisions, readChatCompactionRevisions, readChatHistoryRevisions } from '../state/chat-history-revisions.js';
import { createHash } from 'node:crypto';

/** Digest of the rows as stored, streamed so a large transcript never becomes one string. */
function projectionDigest(messages: readonly PersistedChatTranscriptMessage[]): string {
  const hash = createHash('sha256');
  writeStableJson([...messages], chunk => { hash.update(chunk); });
  return hash.digest('hex');
}


/** What one run's evidence projects to, before any of it is written down. */
export type ProjectedRun = {
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
 * Folds one run's committed events into display rows, one event at a time. Live frames supply the
 * shape of a tool row; the journal's own tool events supply the execution state and the full result.
 */
export class ChatRunProjection {
  private messages: ChatTranscriptMessage[];
  private terminalCause: ChatRunTerminalCause | null = null;
  private terminalDetail: string | null = null;
  private cancelled = false;
  private compactedValue = false;
  private readonly toolCallIds = new Set<string>();
  private readonly approvals = new Map<string, Extract<ChatJournalEvent, { kind: 'approval_requested' }>>();
  private readonly retained: ReadonlySet<ChatTranscriptMessage>;

  /** Requests seen before this fold started seed the map an incremental pass resolves against. */
  constructor(
    private readonly metadata: ChatTranscriptMetadata,
    initialMessages: readonly ChatTranscriptMessage[] = [],
    approvalEvidence: readonly ChatJournalEnvelope[] = [],
  ) {
    this.messages = [...initialMessages];
    this.retained = new Set(initialMessages);
    for (const envelope of approvalEvidence) {
      if (envelope.event.kind === 'approval_requested') this.approvals.set(envelope.event.approvalId, envelope.event);
    }
  }

  /** Whether a compaction splice was folded; earlier rows then belong to the summary. */
  get compacted(): boolean { return this.compactedValue; }

  apply(envelope: ChatJournalEnvelope): void {
    const event = envelope.event;
    if (event.kind === 'approval_requested') this.approvals.set(event.approvalId, event);
    if (event.kind === 'submission_cancelled') this.cancelled = true;
    if (event.kind === 'context_spliced' && event.reason === 'compacted') this.compactedValue = true;
    this.messages = applyEvent(this.messages, event, this.metadata, this.toolCallIds, this.approvals);
    if (event.kind === 'run_finished') {
      this.terminalCause = event.terminalCause;
      this.terminalDetail = event.detail;
    }
  }

  finish(): ProjectedRun {
    const settled = this.terminalCause === null || this.cancelled
      ? this.messages : finalizeChatRunTranscript(this.messages, this.terminalCause, this.metadata, this.terminalDetail);
    return {
      messages: settled.map((message) => this.retained.has(message) ? message : PersistedChatTranscriptMessageSchema.parse(message)),
      toolCount: this.toolCallIds.size,
      status: recoveryStatus(settled),
      terminalCause: this.terminalCause,
    };
  }
}

/** A tool the run never proved finished (or started) is what makes projected rows need recovery. */
function recoveryStatus(messages: readonly ChatTranscriptMessage[]): ChatRecoveryStatus {
  const interrupted = messages.some((message) => (
    message.kind === 'assistant_tool_call'
    && (message.toolCallExecutionState === 'not_started' || message.toolCallExecutionState === 'uncertain')
  ));
  return interrupted ? 'recovery_needed' : 'ok';
}



function applyEvent(
  messages: readonly ChatTranscriptMessage[],
  event: ChatJournalEvent,
  metadata: ChatTranscriptMetadata,
  toolCallIds: Set<string>,
  approvals: ReadonlyMap<string, Extract<ChatJournalEvent, { kind: 'approval_requested' }>>,
): ChatTranscriptMessage[] {
  if (event.kind === 'run_finished' && event.terminalCause === 'completed') return reduceChatTranscript(messages, { kind: 'completed' }, metadata);
  if (event.kind === 'submission_cancelled') return messages.filter(message => message.id !== event.userMessageId);
  if (event.kind === 'baseline_imported') {
    return event.messages.map(message => ({ ...message, sourceRunId: metadata.sourceRunId }));
  }
  if (event.kind === 'approval_resolved' && event.decision !== null) {
    const approval = approvals.get(event.approvalId);
    if (!approval) throw new Error(`Approval ${event.approvalId} resolved without its proposal.`);
    const reason = event.decision.decision === 'deny' ? event.decision.reason : null;
    const content = `${event.decision.decision} ${approval.toolName}: ${approval.command}${reason ? ` — ${reason}` : ''}`;
    return [...messages, ChatRepoAgentApprovalMessageSchema.parse({
      id: buildChatMessageId(metadata.messageIdPrefix, { kind: 'approval', approvalId: event.approvalId }), role: 'user', kind: 'repo_agent_approval', content,
      inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
      inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
      createdAtUtc: event.decidedAtUtc, sourceRunId: metadata.sourceRunId,
      approvalDecision: event.decision.decision, approvalToolName: approval.toolName, approvalCommand: approval.command, approvalReason: reason,
    })];
  }
  if (event.kind === 'run_started') {
    if (event.operationKind === 'condense') return [...messages];
    return reduceChatTranscript(messages, {
      kind: 'submission',
      message: { id: event.userMessageId, content: event.content, images: event.images, imageMeta: event.imageMeta },
    }, metadata);
  }
  if (event.kind === 'context_spliced' && event.reason === 'compacted') {
    const summary = event.inserted.find(message => message.role === 'assistant' && typeof message.content === 'string'
      && message.content.startsWith(COMPACTION_SUMMARY_MARKER));
    if (!summary || typeof summary.content !== 'string') throw new Error('Compacted context has no typed compaction summary.');
    const row = { ...buildCompactionSummaryRow(summary.content.slice(COMPACTION_SUMMARY_MARKER.length).trim(), metadata.createdAtUtc),
      id: buildChatMessageId(metadata.messageIdPrefix, { kind: 'summary', revision: event.contextRevision }), sourceRunId: metadata.sourceRunId };
    const compressed = new Set(event.compressedMessageIds ?? []);
    const previous = messages.map(message => message.kind === 'compaction_summary' ? { ...message, compressedIntoSummary: true } : message);
    const insertionIndex = previous.reduce((last, message, index) => compressed.has(message.id) ? index + 1 : last, 0);
    return [...previous.slice(0, insertionIndex), row, ...previous.slice(insertionIndex)];
  }
  if (event.kind === 'display') {
    if (event.event.kind === 'tool' && event.event.tool.kind === 'tool_result') {
      const id = buildChatMessageId(metadata.messageIdPrefix, { kind: 'tool', toolCallId: event.event.tool.toolCallId });
      const recorded = messages.find(message => message.id === id);
      if (recorded?.kind !== 'assistant_tool_call' || recorded.toolCallOutput === null || recorded.toolCallOutput === undefined) {
        throw new Error(`Tool ${event.event.tool.toolCallId} has no committed full result.`);
      }
    }
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
    const messageId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'tool', toolCallId: event.call.displayToolCallId });
    return applyOutcome(messages, metadata, {
      toolCallId: event.call.displayToolCallId,
      executionState: event.executionState,
      exitCode: event.exitCode,
      output: event.output,
      outputTokens: event.outputTokens,
      outputTokensEstimated: event.outputTokensEstimated,
    }).map(message => message.id === messageId ? { ...message, images: event.images, imageMeta: event.imageMeta } : message);
  }
  if (event.kind === 'tool_result_finalized') {
    const finalizedId = buildChatMessageId(metadata.messageIdPrefix, { kind: 'tool', toolCallId: event.call.displayToolCallId });
    const previous = messages.find(message => message.id === finalizedId);
    return applyOutcome(messages, metadata, {
      toolCallId: event.call.displayToolCallId,
      executionState: previous?.kind === 'assistant_tool_call' ? previous.toolCallExecutionState : 'completed',
      exitCode: previous?.toolCallExitCode ?? null,
      output: event.modelVisibleText,
      outputTokens: previous?.outputTokensEstimate ?? 0,
      outputTokensEstimated: previous?.outputTokensEstimated ?? false,
    });
  }
  return [...messages];
}

function applyOutcome(
  messages: readonly ChatTranscriptMessage[],
  metadata: ChatTranscriptMetadata,
  outcome: ChatToolOutcome,
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





/**
 * Projects one run's evidence onto its display rows, replacing exactly the rows that run owns.
 * The journal is never touched: a projection that throws leaves the evidence to be retried.
 */
function projectRun(database: RuntimeDatabase, operationId: string, force: boolean): ChatRecoveryReport {
  const store = new ChatJournalStore(database);
  const run = store.readRun(operationId);
  if (run === null) throw new ChatRecoveryInvariantError('missing_run', operationId, 'Chat projection run does not exist.');
  const before = readChatRunMessages(database, run.sessionId, operationId);
  const compactions = readChatCompactionRevisions(database, run.sessionId);
  const earlierRun = compactions.some(compaction => compaction.runOrder > run.runOrder);
  const compressedIds = new Set(compactions.filter(compaction => compaction.operationId === operationId).flatMap(compaction => compaction.compressedMessageIds));
  if (before.some(message => !message.compressedIntoSummary && (earlierRun || compressedIds.has(message.id)))) force = true;
  const beforeDigest = projectionDigest(before);
  if (run.projectedDigest !== beforeDigest) force = true;
  // Rows checkpointed at this revision count already carry every revision; a newer edit rebuilds.
  const revisions = readChatHistoryRevisions(database, run.sessionId);
  if (revisions.length !== run.projectedHistoryRevision) force = true;
  if (!force && run.projectedSequence === run.latestSequence) {
    return report(run, { messages: before, toolCount: before.filter(message => message.kind === 'assistant_tool_call').length, status: recoveryStatus(before), terminalCause: run.terminalCause }, false, []);
  }

  const projection = new ChatRunProjection({
    messageIdPrefix: buildChatRunMessageIdPrefix(operationId),
    sourceRunId: operationId,
    createdAtUtc: run.createdAtUtc,
  }, force ? [] : before, store.readApprovalRequests(operationId));
  for (const envelope of store.readAll(operationId, force ? 0 : run.projectedSequence)) projection.apply(envelope);
  const projected = projection.finish();
  // A revision names rows that existed when it was committed, so an incremental pass has nothing
  // new for it to touch and must not re-apply it to rows that already reflect it.
  if (force) projected.messages = applyChatDisplayRevisions(projected.messages, revisions).map(message => PersistedChatTranscriptMessageSchema.parse(message));
  projected.messages = projected.messages.map(message => earlierRun || compressedIds.has(message.id) ? { ...message, compressedIntoSummary: true } : message);

  // Compared as stored on both sides, so "the rows already say this" is an exact answer rather
  // than a guess about which absent fields read back as NULL.
  let afterDigest = beforeDigest;
  try {
    database.transaction(() => {
      const positionRow = z.object({ position: z.number().nullable() });
      const ownPosition = positionRow.parse(database.prepare(
        'SELECT MIN(position) AS position FROM chat_messages WHERE session_id = ? AND source_run_id = ?',
      ).get(run.sessionId, operationId)).position;
      const laterPosition = positionRow.parse(database.prepare(`
        SELECT MIN(m.position) AS position FROM chat_messages m
        JOIN chat_runs r ON r.operation_id = m.source_run_id
        WHERE m.session_id = ? AND r.run_order > ?
      `).get(run.sessionId, run.runOrder)).position;
      const start = ownPosition ?? laterPosition ?? nextChatMessagePosition(database, run.sessionId);
      const growth = projected.messages.length - before.length;
      if (growth !== 0) database.prepare(`
        UPDATE chat_messages SET position = position + ?
        WHERE session_id = ? AND position >= ? AND (source_run_id IS NULL OR source_run_id != ?)
      `).run(growth, run.sessionId, start, operationId);
      const retainedIds = new Set(projected.messages.map(message => message.id));
      for (const message of before) {
        if (!retainedIds.has(message.id)) database.prepare('DELETE FROM chat_messages WHERE session_id = ? AND id = ?')
          .run(run.sessionId, message.id);
      }
      const previous = new Map(before.map(message => [message.id, message]));
      if (projection.compacted) {
        database.prepare('UPDATE chat_messages SET compressed_into_summary = 1 WHERE session_id = ? AND position < ?')
          .run(run.sessionId, start);
      }
      for (const [index, message] of projected.messages.entries()) {
        const old = previous.get(message.id);
        if (old && stableStringify(old) === stableStringify({ ...old, ...message }) && before[index]?.id === message.id) continue;
        insertChatMessages(database, run.sessionId, [message], start + index, run.createdAtUtc);
      }
      afterDigest = projectionDigest(readChatRunMessages(database, run.sessionId, operationId));
      store.advanceProjection({ operationId, projectedSequence: run.latestSequence, projectedHistoryRevision: revisions.length, projectedDigest: afterDigest });
    })();
  } catch (error) {
    const detail = toError(error).message;
    return report(run, projected, false, [issue(operationId, 'projection_failed', detail)]);
  }
  return report(run, projected, beforeDigest !== afterDigest, []);
}


/** Brings a run's display rows up to its committed evidence, doing nothing when they agree. */
export function reconcileChatRun(database: RuntimeDatabase, operationId: string): ChatRecoveryReport {
  return projectRun(database, operationId, false);
}

/** Re-derives a run's display rows from event one, for when the projection itself was lost. */
export function rebuildChatRun(database: RuntimeDatabase, operationId: string): ChatRecoveryReport {
  return projectRun(database, operationId, true);
}
