import { buildChatMessageId } from '@siftkit/contracts';
import { z } from '../lib/zod.js';
import { RepoAgentRunRequestSchema, RepoAgentRunStateSchema } from '../repo-agent/run-schemas.js';
import { ChatArchiveSourceSchema, digestChatArchiveSources, readChatHistoryArchive, readChatHistoryArchiveSources } from './chat-history-archive.js';
import { ChatRunTerminalCauseSchema, ChatStreamQueuedUserMessageSchema, PersistedChatTranscriptMessageSchema, buildChatRunMessageIdPrefix, reduceChatTranscript } from '@siftkit/contracts';
import { createHash } from 'node:crypto';
import { stableStringify } from '../lib/json.js';
import { PlannerChatMessagesSchema, type ChatMessage } from '../repo-search/planner-chat-message.js';
import { buildUserContent } from '../llm-protocol/image-attachments.js';
import { buildTaskInitialUserPrompt } from '../repo-search/prompts.js';
import { linkChatArchiveContext, projectChatHistoryArchive } from './chat-history-archive-projection.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import type { ChatRuntimeOwner } from '../state/chat-runtime-owner.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import { readChatSessionFromDatabase } from '../state/chat-sessions.js';
import { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import { recordImportedChatBaseline } from './chat-history-import.js';
import { reconcileChatRun } from './chat-run-projection.js';

export const ChatHistoryRepairInputSchema = z.strictObject({
  sessionId: z.string().min(1), requestId: z.string().min(1),
  sources: z.array(ChatArchiveSourceSchema).min(1),
  request: RepoAgentRunRequestSchema, state: RepoAgentRunStateSchema,
  savedMessages: z.array(PersistedChatTranscriptMessageSchema),
  includeThinking: z.boolean(), maxTurns: z.number().int().positive(),
});

export const ChatHistoryRepairReportSchema = z.strictObject({
  importerVersion: z.literal(1), sessionId: z.string(), requestId: z.string(), repoAgentSessionId: z.string().uuid(),
  sourceDigest: z.string().length(64), targetDigest: z.string().length(64), expectedDigest: z.string().length(64),
  sources: z.array(ChatArchiveSourceSchema.omit({ text: true }).extend({ digest: z.string().length(64), bytes: z.number().int().nonnegative() })),
  requestDigest: z.string().length(64), stateDigest: z.string().length(64),
  modelTurns: z.number().int().nonnegative(), completedToolResults: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  executedToolResults: z.number().int().nonnegative(), rejectedToolResults: z.number().int().nonnegative(),
  pendingProposals: z.number().int().nonnegative(), approvalVerdicts: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(), retainedNativeMessages: z.number().int().nonnegative(),
  savedMessages: z.number().int().nonnegative(), plannedMessages: z.number().int().nonnegative(),
  insertedMessages: z.number().int().nonnegative(), terminalCause: ChatRunTerminalCauseSchema,
  continuationReady: z.boolean(), knownGaps: z.array(z.string()), executedToolsDuringImport: z.literal(0),
});

export function prepareChatHistoryRepair(input: z.input<typeof ChatHistoryRepairInputSchema>) {
  const validated = ChatHistoryRepairInputSchema.parse(input);
  const { request, state, requestId, sessionId } = validated;
  if (request.runId !== state.runId) throw new Error('Repo-agent request and state identity do not match.');
  const archive = readChatHistoryArchive(requestId, validated.sources);
  if (archive.operationType !== 'repo-agent') throw new Error('Archive operation identity does not match repo-agent state.');
  const header = z.object({ repoRoot: z.string() }).parse(archive.events[0]?.event);
  if (header.repoRoot !== request.repoRoot) throw new Error('Archive repository identity does not match its request.');
  const initial = z.object({ messages: PlannerChatMessagesSchema }).parse(archive.events.find(entry => entry.kind === 'turn_new_messages')?.event);
  const submission = initial.messages.find(message => message.role === 'user');
  if (!submission || stableStringify(submission.content ?? '') !== stableStringify(buildUserContent(buildTaskInitialUserPrompt(request.task), request.images))) {
    throw new Error('Archive original submission does not match the repo-agent request.');
  }
  const lastEventAt = z.string().datetime().parse(archive.events.at(-1)?.event.at);
  if (state.updatedAtUtc < lastEventAt) throw new Error('Repo-agent state predates the archived evidence.');
  const projected = projectChatHistoryArchive(archive, validated);
  const linked = linkChatArchiveContext(archive, validated);
  const messageIdPrefix = buildChatRunMessageIdPrefix(requestId);
  let archivedMessages = projected.messages.map(message => message.id === buildChatMessageId(messageIdPrefix, { kind: 'user' })
    ? { ...message, content: request.task } : message);
  const retainedContext: ChatMessage[] = linked.messages.filter(message => message.role !== 'system');
  const knownGaps = [...linked.gaps];
  let terminalCause: z.infer<typeof ChatRunTerminalCauseSchema>;
  switch (state.status) {
    case 'completed': terminalCause = 'completed'; break;
    case 'approval_timeout': terminalCause = 'approval_timeout'; break;
    case 'aborted': terminalCause = 'user_stop'; break;
    case 'failed': terminalCause = 'execution_failure'; break;
    case 'starting': case 'running': case 'approval_required': terminalCause = 'server_restart'; break;
  }
  const pending = state.status === 'approval_timeout' || state.status === 'approval_required' ? state.approval : null;
  if (pending) {
    const metadata = { messageIdPrefix, sourceRunId: null, createdAtUtc: state.updatedAtUtc };
    const toolCallId = `pending-${pending.approvalId}`;
    archivedMessages = reduceChatTranscript(archivedMessages, { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId, turn: Math.max(1, archive.modelTurns), maxTurns: validated.maxTurns,
      activityKind: 'command', activitySubject: { kind: 'none' }, command: pending.command, promptTokenCount: 0,
    } }, metadata);
    archivedMessages = reduceChatTranscript(archivedMessages, { kind: 'tool_outcome', outcome: {
      toolCallId, executionState: 'not_started', exitCode: null, output: null, outputTokens: 0, outputTokensEstimated: false,
    } }, metadata);
    retainedContext.push({ role: 'user', content: `[Recovery notice: the previous run ended with ${terminalCause}. The following proposal was not executed: ${pending.command}. No old approval remains actionable.]` });
    knownGaps.push('The final pending proposal is preserved as rendered state evidence; its native call arguments were not archived and are not fabricated.');
  }
  knownGaps.push('Historical archives record completed model responses, not the timing or content of every streamed fragment.');
  const archivedIds = new Map(archivedMessages.map(message => [message.id, message]));
  const laterMessages = [];
  for (const saved of validated.savedMessages) {
    const recovered = archivedIds.get(saved.id);
    if (recovered) {
      if (saved.kind !== recovered.kind || saved.content !== recovered.content
        || stableStringify(saved.images ?? []) !== stableStringify(recovered.images ?? [])) {
        throw new Error(`Saved message ${saved.id} conflicts with archive evidence.`);
      }
      archivedMessages = archivedMessages.map(message => message.id === saved.id ? saved : message);
      continue;
    }
    if (saved.createdAtUtc < state.updatedAtUtc || (saved.kind !== 'user_text' && saved.kind !== 'assistant_answer')) {
      throw new Error(`Saved message ${saved.id} has unresolved placement or requires its own native archive.`);
    }
    laterMessages.push(saved);
  }
  const retainedIds = new Set(retainedContext.flatMap(message => [message.chatMessageId, message.thinkingMessageId].filter(id => id !== undefined)));
  if (linked.compactions > 0) {
    const summaryIndex = archivedMessages.map(message => message.kind).lastIndexOf('compaction_summary');
    archivedMessages = archivedMessages.map((message, index) => index < summaryIndex && !retainedIds.has(message.id)
      ? { ...message, compressedIntoSummary: true } : message);
  }
  const laterContext = [...retainedContext, ...laterMessages.map(message => ({
    role: message.role, content: buildUserContent(message.content, message.images ?? []), chatMessageId: message.id,
  }))];
  const requestDigest = createHash('sha256').update(stableStringify(request)).digest('hex');
  const stateDigest = createHash('sha256').update(stableStringify(state)).digest('hex');
  const sourceDigest = createHash('sha256').update(stableStringify({ sessionId, requestId, sources: archive.sources, requestDigest, stateDigest,
    includeThinking: validated.includeThinking, maxTurns: validated.maxTurns })).digest('hex');
  const targetDigest = createHash('sha256').update(stableStringify(validated.savedMessages)).digest('hex');
  const expectedDigest = createHash('sha256').update(`${sourceDigest}:${targetDigest}`).digest('hex');
  const messages = [...archivedMessages, ...laterMessages];
  const queueMessages = archive.events.filter(entry => entry.kind === 'queued_user_message').map(entry => ChatStreamQueuedUserMessageSchema.parse({
    id: entry.event.id, turn: entry.event.turn, boundary: entry.event.boundary, content: entry.event.content, images: entry.event.images, imageMeta: [],
  }));
  const report = ChatHistoryRepairReportSchema.parse({
    importerVersion: 1, sessionId, requestId, repoAgentSessionId: state.runId, sourceDigest, targetDigest, expectedDigest,
    sources: archive.sources, requestDigest, stateDigest, modelTurns: archive.modelTurns, maxTurns: validated.maxTurns, completedToolResults: archive.completedToolResults,
    executedToolResults: archive.executedToolResults, rejectedToolResults: archive.rejectedToolResults,
    pendingProposals: pending ? 1 : 0, approvalVerdicts: archive.events.filter(entry => entry.kind === 'approval_verdict').length,
    compactions: linked.compactions, retainedNativeMessages: retainedContext.length, savedMessages: validated.savedMessages.length,
    plannedMessages: messages.length, insertedMessages: messages.length - validated.savedMessages.length,
    terminalCause, continuationReady: linked.continuationReady, knownGaps, executedToolsDuringImport: 0,
  });
  return { report, messages, archivedMessages, laterMessages, retainedContext, laterContext, queueMessages,
    createdAtUtc: z.string().datetime().parse(archive.events[0]?.event.at), finishedAtUtc: state.updatedAtUtc };
}

export function applyChatHistoryRepair(database: RuntimeDatabase, prepared: ReturnType<typeof prepareChatHistoryRepair>,
  expectedDigest: string, owner: ChatRuntimeOwner) {
  const { report } = prepared;
  if (expectedDigest !== report.expectedDigest) throw new Error('Repair digest differs from the reviewed report.');
  if (!report.continuationReady) throw new Error('Repair has unresolved native context evidence.');
  if (database !== owner.database) throw new Error('Repair lease belongs to a different database.');
  owner.assertOwned();
  return database.transaction(() => {
    const sourceDigests = digestChatArchiveSources(readChatHistoryArchiveSources(database, report.requestId));
    if (stableStringify(sourceDigests) !== stableStringify(report.sources)) throw new Error('Repair source digest changed after review.');
    const store = new ChatJournalStore(database);
    const runs = store.listSessionRuns(report.sessionId);
    const previous = runs.find(run => run.provenance?.sourceKind === 'run_archive' && run.provenance.sourceId === report.requestId);
    if (previous) {
      if (previous.provenance?.sourceDigest !== report.sourceDigest) throw new Error('Imported source digest conflicts with current evidence.');
      for (const run of runs) {
        const reconciliation = reconcileChatRun(database, run.operationId);
        if (reconciliation.status === 'recovery_failed') throw new Error('Previously imported history requires projection recovery.');
      }
      return { changed: false, report };
    }
    if (runs.length > 0) throw new Error('Chat already has journal history; archive placement requires explicit reconciliation.');
    const current = readChatSessionFromDatabase(database, report.sessionId);
    if (!current) throw new Error('Repair target session no longer exists.');
    const targetDigest = createHash('sha256').update(stableStringify(current.messages ?? [])).digest('hex');
    if (targetDigest !== report.targetDigest) throw new Error('Repair target digest changed after the report was prepared.');
    const queue = new ChatMessageQueueStore(database);
    const delivered = queue.listDelivered(report.sessionId, report.requestId);
    for (const message of delivered) {
      const source = prepared.queueMessages.find(candidate => candidate.id === message.id);
      if (!source || source.turn !== message.deliveredTurn) throw new Error(`Queue delivery ${message.id} has conflicting turn provenance.`);
      const recovered = prepared.archivedMessages.find(row => row.id === message.id && row.kind === 'user_text');
      if (!recovered || recovered.content !== message.content || stableStringify(recovered.images ?? []) !== stableStringify(message.images)) {
        throw new Error(`Delivered message ${message.id} has no matching imported source.`);
      }
    }
    // Replacing the projection and recording its source share the same outer transaction. A CHECK
    // failure, stale target, or lost owner rolls back both; no partial baseline can claim success.
    database.prepare('DELETE FROM chat_messages WHERE session_id=?').run(report.sessionId);
    const archiveId = recordImportedChatBaseline(database, {
      sessionId: report.sessionId, ownerEpoch: owner.ownerEpoch,
      createdAtUtc: prepared.createdAtUtc, updatedAtUtc: prepared.finishedAtUtc, terminalCause: report.terminalCause,
      binding: { requestId: report.requestId, repoAgentSessionId: report.repoAgentSessionId },
      event: { kind: 'baseline_imported', messages: prepared.archivedMessages, retainedContext: prepared.retainedContext,
        provenance: { importerVersion: 1, sourceKind: 'run_archive', sourceId: report.requestId, sourceDigest: report.sourceDigest, repairDigest: report.expectedDigest } },
    });
    if (reconcileChatRun(database, archiveId).status === 'recovery_failed') throw new Error('Archive projection failed; repair rolled back.');
    const firstLater = prepared.laterMessages[0];
    if (firstLater) {
      const laterId = recordImportedChatBaseline(database, {
        sessionId: report.sessionId, ownerEpoch: owner.ownerEpoch,
        createdAtUtc: firstLater.createdAtUtc, updatedAtUtc: prepared.laterMessages.at(-1)?.createdAtUtc ?? firstLater.createdAtUtc,
        terminalCause: 'completed', binding: null,
        event: { kind: 'baseline_imported', messages: prepared.laterMessages, retainedContext: prepared.laterContext,
          provenance: { importerVersion: 1, sourceKind: 'saved_chat', sourceId: report.sessionId,
            sourceDigest: createHash('sha256').update(stableStringify(prepared.laterMessages)).digest('hex') } },
      });
      if (reconcileChatRun(database, laterId).status === 'recovery_failed') throw new Error('Saved tail projection failed; repair rolled back.');
    }
    queue.deleteIncorporated(report.sessionId, report.requestId);
    owner.assertOwned();
    return { changed: true, report };
  })();
}
