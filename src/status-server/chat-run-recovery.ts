import { CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS, ChatRecoveryReportSchema, type ChatRecoveryIssue, type ChatRecoveryReport } from '@siftkit/contracts';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { z } from '../lib/zod.js';
import { ChatRuntimeOwnerSchema, type ChatRuntimeOwner } from '../state/chat-runtime-owner.js';
import { ChatJournalIntegrityError, ChatRecoveryInvariantError, ChatJournalStore } from '../state/chat-journal.js';
import type { ChatJournalEvent, ChatRun } from '../state/chat-journal-schema.js';
import { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import { ChatRunRecorder } from './chat-run-recorder.js';
import { buildRecoveredChatHistory, ChatContextReplay } from './chat-context-replay.js';
import { reconcileChatRun, rebuildChatRun } from './chat-run-projection.js';
import { buildUserContent } from '../llm-protocol/image-attachments.js';
import type { ChatSessionOperationRegistry } from './chat-session-operation-registry.js';
import { serverLogger } from './server-logger.js';
import { toError } from '../lib/errors.js';

/** Fence admitted model waiters as well as engines when this process loses its database lease. */
export function renewChatRuntimeOwner(owner: ChatRuntimeOwner, operations: ChatSessionOperationRegistry): boolean {
  try {
    owner.renew();
    return true;
  } catch (error) {
    const failure = toError(error);
    serverLogger.error({ scope: 'chat', id: owner.ownerEpoch, event: 'owner_lease_lost', fields: failure.message });
    for (const operation of operations.listActive()) {
      operation.recorder?.abortForStorageFailure(failure);
      try { operation.abort?.(); }
      catch (abortError) {
        serverLogger.error({ scope: 'chat', id: operation.operationId, event: 'owner_abort_failed', fields: toError(abortError).message });
      }
    }
    return false;
  }
}

function assertRecoveryOwner(database: RuntimeDatabase, ownerEpoch: string): void {
  const owner = ChatRuntimeOwnerSchema.parse(database.prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get());
  if (`${owner.owner_id}:${owner.epoch}` !== ownerEpoch || Date.parse(owner.lease_expires_at_utc) <= Date.now()) {
    throw new Error('Chat recovery requires the current runtime owner lease.');
  }
}



type QueuedMessage = Extract<ChatJournalEvent, { kind: 'queue_delivered' }>['message'];
type OrphanScan = {
  stopped: boolean; initialized: boolean; sawTool: boolean;
  started: Extract<ChatJournalEvent, { kind: 'run_started' }> | null;
  unresolvedApprovalIds: string[]; delivered: QueuedMessage[];
};

/** One bounded pass collecting the compact facts orphan closure needs; no event array is retained. */
function scanOrphan(store: ChatJournalStore, operationId: string): OrphanScan {
  const scan: OrphanScan = { stopped: false, initialized: false, sawTool: false, started: null, unresolvedApprovalIds: [], delivered: [] };
  for (const { event } of store.readAll(operationId)) {
    if (event.kind === 'stop_requested') scan.stopped = true;
    else if (event.kind === 'context_initialized') scan.initialized = true;
    else if (event.kind === 'run_started') scan.started = event;
    else if (event.kind === 'queue_delivered') scan.delivered.push(event.message);
    else if (event.kind === 'approval_requested') scan.unresolvedApprovalIds.push(event.approvalId);
    else if (event.kind === 'approval_resolved') scan.unresolvedApprovalIds = scan.unresolvedApprovalIds.filter(id => id !== event.approvalId);
    else if (event.kind.startsWith('tool_')) scan.sawTool = true;
  }
  return scan;
}

export function recoverInterruptedChatRuns(database: RuntimeDatabase, ownerEpoch: string): ChatRecoveryReport[] {
  assertRecoveryOwner(database, ownerEpoch);
  const store = new ChatJournalStore(database);
  const orphans = z.array(z.object({ operation_id: z.string(), session_id: z.string() })).parse(database.prepare(`
    SELECT operation_id, session_id FROM chat_runs WHERE record_kind='execution' AND terminal_cause IS NULL AND owner_epoch != ?
    ORDER BY session_id, run_order
  `).all(ownerEpoch));
  const reports: ChatRecoveryReport[] = [];
  for (const orphan of orphans) {
    try {
    database.transaction(() => {
      assertRecoveryOwner(database, ownerEpoch);
      database.prepare('UPDATE chat_runs SET owner_epoch=? WHERE operation_id=? AND terminal_cause IS NULL').run(ownerEpoch, orphan.operation_id);
      const recorder = ChatRunRecorder.resume(database, orphan.operation_id, ownerEpoch);
      const scan = scanOrphan(store, orphan.operation_id);
      const stopped = scan.stopped;
      for (const approvalId of scan.unresolvedApprovalIds) {
        recorder.recordApprovalResolved({ approvalId, outcome: stopped ? 'aborted' : 'interrupted', decision: null,
          reason: stopped ? 'Stopped by user.' : 'The owning server stopped.', decidedAtUtc: new Date().toISOString() });
      }
      if (!scan.initialized) {
        const prior = buildRecoveredChatHistory(database, orphan.session_id, orphan.operation_id);
        const started = scan.started;
        if (prior.status === 'recovery_failed' || started === null || scan.sawTool) {
          throw new Error('Orphaned run has incomplete context evidence; continuation requires repair.');
        }
        recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: prior.messages.length,
          queueMessageIds: scan.delivered.map(message => message.id),
          messages: [...prior.messages, { role: 'user', content: buildUserContent(started.content, started.images), chatMessageId: started.userMessageId },
            ...scan.delivered.filter(message => message.id !== started.userMessageId).map(message => ({ role: 'user' as const, content: buildUserContent(message.content, message.images), chatMessageId: message.id }))],
        });
      }
      // A fresh bounded replay over the committed head, including the initialization just written.
      const replay = new ChatContextReplay();
      for (const envelope of store.readAll(orphan.operation_id)) replay.apply(envelope);
      const contextLength = replay.rawContextLength;
      const replayed = replay.finish();
      if (replayed.status === 'recovery_failed') throw new Error('Orphaned run has corrupt context evidence.');
      if (replayed.messages.length > contextLength) recorder.recordContextSpliced({
        expectedRevision: replayed.contextRevision, contextRevision: replayed.contextRevision + 1,
        startIndex: contextLength, deleteCount: 0, inserted: replayed.messages.slice(contextLength),
        turnBoundary: replayed.turnBoundary, reason: 'interruption_closed', coalescedToolCallIds: [],
        queueMessageIds: scan.delivered.map(message => message.id),
      });
      recorder.finish({ terminalCause: stopped ? 'user_stop' : 'server_restart',
        detail: stopped ? 'Stopped by user.' : 'The owning server stopped.', usage: null, recoveryStatus: 'recovery_needed' });
      new ChatMessageQueueStore(database).setPaused(orphan.session_id, true);
    })();
    const report = reconcileChatRun(database, orphan.operation_id);
    if (report.status !== 'recovery_failed') {
      const run = store.readRun(orphan.operation_id);
      if (run?.requestId) new ChatMessageQueueStore(database).deleteIncorporated(orphan.session_id, run.requestId);
    }
    recordSessionRecovery(database, orphan.session_id, store.listSessionRuns(orphan.session_id), [report]);
    reports.push(report);
    } catch (error) {
      assertRecoveryOwner(database, ownerEpoch);
      const run = store.readRun(orphan.operation_id);
      if (!run) throw error;
      const report = failedRecovery(run, [recoveryIssue(run.operationId, error instanceof Error ? error : new Error('Orphan recovery failed.'))]);
      reports.push(report);
      recordSessionRecovery(database, orphan.session_id, store.listSessionRuns(orphan.session_id), [report]);
    }
  }
  const queue = new ChatMessageQueueStore(database);
  const terminalDeliveries = z.array(z.object({ session_id: z.string() })).parse(database.prepare(`
    SELECT DISTINCT p.session_id FROM chat_pending_messages p WHERE p.state='delivered'
      AND EXISTS (SELECT 1 FROM chat_runs r WHERE r.session_id=p.session_id
        AND r.request_id=p.delivered_request_id AND r.terminal_cause IS NOT NULL)
  `).all());
  for (const { session_id: sessionId } of terminalDeliveries) {
    if (reports.some(report => report.sessionId === sessionId)) continue;
    const runs = store.listSessionRuns(sessionId);
    if (runs.some(run => run.terminalCause === null && run.ownerEpoch === ownerEpoch)) continue;
    assertRecoveryOwner(database, ownerEpoch);
    const reconciled = reconcileChatSession(database, sessionId);
    reports.push(...reconciled);
    if (reconciled.some(report => report.status === 'recovery_failed')) continue;
    for (const run of runs) {
      if (run.terminalCause !== null && run.requestId !== null && queue.listDelivered(sessionId, run.requestId).length > 0) {
        queue.deleteIncorporated(sessionId, run.requestId);
      }
    }
  }
  for (const sessionId of queue.interruptedSessionIds()) {
    if (store.listSessionRuns(sessionId).some(run => run.terminalCause === null && run.ownerEpoch === ownerEpoch)) continue;
    const state = queue.state(sessionId);
    if (state.force && state.force.phase !== 'failed') {
      queue.failForce(sessionId, state.force, 'Server restarted before queued delivery settled. Review the recovered conversation before continuing.');
    } else if (!state.paused) {
      queue.setPaused(sessionId, true);
    }
  }
  return reports;
}

export function reconcileChatSession(database: RuntimeDatabase, sessionId: string): ChatRecoveryReport[] {
  const reports: ChatRecoveryReport[] = [];
  const store = new ChatJournalStore(database);
  const runs = store.listSessionRuns(sessionId);
  for (const run of runs) {
    try {
    // A missing display projection is recoverable even when its checkpoint survived.
    const row = z.object({ count: z.number() }).parse(database.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id=? AND source_run_id=?').get(sessionId, run.operationId));
    const report = row.count === 0 ? rebuildChatRun(database, run.operationId) : reconcileChatRun(database, run.operationId);
    reports.push(ChatRecoveryReportSchema.parse(report));
    if (report.status === 'recovery_failed') break;
    } catch (error) {
      const failedRun = error instanceof ChatJournalIntegrityError || error instanceof ChatRecoveryInvariantError
        ? requireRecoveryRun(runs, error.operationId) : run;
      reports.push(failedRecovery(failedRun, [recoveryIssue(failedRun.operationId, error instanceof Error ? error : new Error('Recovery failed.'))]));
      break;
    }
  }
  const latestRun = runs.at(-1);
  if (latestRun && !reports.some(report => report.status === 'recovery_failed')) {
    let history: ReturnType<typeof buildRecoveredChatHistory> | null = null;
    try {
      history = buildRecoveredChatHistory(database, sessionId);
    } catch (error) {
      const failedRun = error instanceof ChatJournalIntegrityError || error instanceof ChatRecoveryInvariantError
        ? requireRecoveryRun(runs, error.operationId) : latestRun;
      reports.push(failedRecovery(failedRun, [recoveryIssue(failedRun.operationId, error instanceof Error ? error : new Error('Recovery failed.'))]));
    }
    if (history?.status === 'recovery_failed') {
      const failedRun = requireRecoveryRun(runs, history.operationId);
      reports.push(failedRecovery(failedRun, history.issues));
    }
  }
  recordSessionRecovery(database, sessionId, runs, reports);
  return reports;
}

function recordSessionRecovery(database: RuntimeDatabase, sessionId: string, runs: readonly ChatRun[], reports: readonly ChatRecoveryReport[]): void {
  const status = reports.some(report => report.status === 'recovery_failed') ? 'recovery_failed'
    : reports.some(report => report.status === 'recovery_needed') ? 'recovery_needed' : 'ok';
  const failedOrder = Math.min(Infinity, ...reports.filter(report => report.status === 'recovery_failed')
    .map(report => requireRecoveryRun(runs, report.operationId).runOrder));
  const reconciledOrder = Math.max(0, ...reports.filter(report => report.status !== 'recovery_failed')
    .map(report => requireRecoveryRun(runs, report.operationId).runOrder).filter(order => order < failedOrder));
  database.prepare(`INSERT INTO chat_session_recovery(session_id, baseline_version, last_reconciled_run_order, status, issues_json, owner_epoch, updated_at_utc)
    VALUES(?, 1, ?, ?, ?, NULL, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_reconciled_run_order=excluded.last_reconciled_run_order,
      status=excluded.status, issues_json=excluded.issues_json, updated_at_utc=excluded.updated_at_utc
    WHERE last_reconciled_run_order != excluded.last_reconciled_run_order OR status != excluded.status OR issues_json != excluded.issues_json`)
    .run(sessionId, reconciledOrder, status, JSON.stringify(reports.flatMap(report => report.issues)), new Date().toISOString());
}

function requireRecoveryRun(runs: readonly ChatRun[], operationId: string | null): ChatRun {
  const run = runs.find(candidate => candidate.operationId === operationId);
  if (!run) throw new Error(`Recovery report references an unknown run: ${String(operationId)}.`);
  return run;
}

export function recoveryIssue(operationId: string, error: Error): ChatRecoveryIssue {
  const known = error instanceof ChatJournalIntegrityError || error instanceof ChatRecoveryInvariantError;
  return { operationId: known ? error.operationId : operationId, code: known ? error.code : 'projection_failed',
    eventId: error instanceof ChatJournalIntegrityError ? error.eventId : null,
    sequence: error instanceof ChatJournalIntegrityError ? error.sequence : null,
    detail: known ? error.message.slice(0, CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS) : 'Journal or projection validation failed.' };
}

function failedRecovery(run: ChatRun, issues: ChatRecoveryIssue[]): ChatRecoveryReport {
  return ChatRecoveryReportSchema.parse({ sessionId: run.sessionId, operationId: run.operationId, status: 'recovery_failed',
    terminalCause: run.terminalCause, appliedSequence: run.projectedSequence, eventCount: run.latestSequence,
    messageCount: 0, toolCount: 0, changed: false, issues });
}
