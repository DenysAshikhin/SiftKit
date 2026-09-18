import { CHAT_RECOVERY_ISSUE_DETAIL_MAX_CHARS, ChatRecoveryReportSchema, type ChatRecoveryIssue, type ChatRecoveryReport } from '@siftkit/contracts';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { z } from '../lib/zod.js';
import { randomUUID } from 'node:crypto';
import { ChatRuntimeOwner, ChatRuntimeOwnerSchema } from '../state/chat-runtime-owner.js';
import type { ServerContext } from './server-types.js';
import { ChatJournalIntegrityError, ChatRecoveryInvariantError, ChatJournalStore } from '../state/chat-journal.js';
import type { ChatJournalEvent, ChatRun } from '../state/chat-journal-schema.js';
import { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import { ChatRunRecorder } from './chat-run-recorder.js';
import { buildRecoveredChatHistory, ChatContextReplay } from './chat-context-replay.js';
import { reconcileChatRun, rebuildChatRun } from './chat-run-projection.js';
import { buildUserContent } from '../llm-protocol/image-attachments.js';
import { serverLogger } from './server-logger.js';
import { toError } from '../lib/errors.js';

export type ChatOwnerHeartbeatOutcome = 'renewed' | 'reacquired' | 'fenced';

/**
 * Renew this process's lease. On loss, fence admitted model waiters and engines as before, then take
 * a fresh epoch and report the re-acquire; closing what the loss abandoned happens after the tick has
 * been handed back, because a closure replays whole journals and must never delay the next renewal.
 * A failure in that closure propagates: this process then holds a lease it cannot clean up, and only the
 * caller can say what that costs it.
 */
export async function heartbeatChatRuntimeOwner(ctx: ServerContext): Promise<ChatOwnerHeartbeatOutcome> {
  try {
    ctx.chatRuntimeOwner.renew();
    return 'renewed';
  } catch (error) {
    const failure = toError(error);
    serverLogger.error({ scope: 'chat', id: ctx.chatRuntimeOwner.ownerEpoch, event: 'owner_lease_lost', fields: failure.message });
    for (const operation of ctx.chatSessionOperations.listActive()) {
      operation.recorder?.abortForStorageFailure(failure);
      try { operation.abort?.(); }
      catch (abortError) {
        serverLogger.error({ scope: 'chat', id: operation.operationId, event: 'owner_abort_failed', fields: toError(abortError).message });
      }
    }
  }
  let next: ChatRuntimeOwner;
  try { next = ChatRuntimeOwner.acquire(ctx.runtimeDatabase, randomUUID()); }
  catch (error) {
    serverLogger.error({ scope: 'chat', id: ctx.chatRuntimeOwner.ownerEpoch, event: 'owner_fenced', fields: toError(error).message });
    return 'fenced';
  }
  ctx.chatRuntimeOwner = next;
  ctx.chatRunOwnerEpoch = next.ownerEpoch;
  serverLogger.warning({ scope: 'chat', id: next.ownerEpoch, event: 'owner_lease_reacquired', fields: '' });
  // The aborted runs now belong to a dead epoch, and closing them is the heaviest work in the codebase:
  // full journal replays, with no bound on how long they take. Hand the tick back before starting them,
  // then close them under whatever lease this process holds at that point — recoverInterruptedChatRuns
  // renews it at every orphan boundary, so a long pass cannot fence out the owner doing the work.
  await new Promise<void>(resolve => setImmediate(resolve));
  recoverInterruptedChatRuns(ctx.chatRuntimeOwner, 'lease_lost');
  return 'reacquired';
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

export type ChatOrphanReason = 'server_restart' | 'lease_lost' | 'abandoned';

/** What an orphan is closed as, by why its owner stopped writing. */
const ORPHAN_CLOSURES = {
  server_restart: { terminalCause: 'server_restart', detail: 'The owning server stopped.' },
  lease_lost: { terminalCause: 'storage_failure', detail: 'The owning server lost its database lease.' },
  // The attach path cannot know why nobody finished the run, so it says only what it can see.
  abandoned: { terminalCause: 'storage_failure', detail: 'The run was closed with no owner to finish it.' },
} as const satisfies Record<ChatOrphanReason, Pick<Parameters<ChatRunRecorder['finish']>[0], 'terminalCause' | 'detail'>>;

/** Adopt one run nobody will finish, close it under `ownerEpoch`, and reconcile its projection. */
export function closeOrphanedChatRun(
  database: RuntimeDatabase, orphan: { operationId: string; sessionId: string },
  ownerEpoch: string, reason: ChatOrphanReason,
): ChatRecoveryReport {
  const store = new ChatJournalStore(database);
  const closure = ORPHAN_CLOSURES[reason];
  try {
    database.transaction(() => {
      assertRecoveryOwner(database, ownerEpoch);
      database.prepare('UPDATE chat_runs SET owner_epoch=? WHERE operation_id=? AND terminal_cause IS NULL').run(ownerEpoch, orphan.operationId);
      const recorder = ChatRunRecorder.resume(database, orphan.operationId, ownerEpoch);
      const scan = scanOrphan(store, orphan.operationId);
      const stopped = scan.stopped;
      for (const approvalId of scan.unresolvedApprovalIds) {
        recorder.recordApprovalResolved({ approvalId, outcome: stopped ? 'aborted' : 'interrupted', decision: null,
          reason: stopped ? 'Stopped by user.' : closure.detail, decidedAtUtc: new Date().toISOString() });
      }
      if (!scan.initialized) {
        const prior = buildRecoveredChatHistory(database, orphan.sessionId, orphan.operationId);
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
      for (const envelope of store.readAll(orphan.operationId)) replay.apply(envelope);
      const contextLength = replay.rawContextLength;
      const replayed = replay.finish();
      if (replayed.status === 'recovery_failed') throw new Error('Orphaned run has corrupt context evidence.');
      if (replayed.messages.length > contextLength) recorder.recordContextSpliced({
        expectedRevision: replayed.contextRevision, contextRevision: replayed.contextRevision + 1,
        startIndex: contextLength, deleteCount: 0, inserted: replayed.messages.slice(contextLength),
        turnBoundary: replayed.turnBoundary, reason: 'interruption_closed', coalescedToolCallIds: [],
        queueMessageIds: scan.delivered.map(message => message.id),
      });
      recorder.finish({ terminalCause: stopped ? 'user_stop' : closure.terminalCause,
        detail: stopped ? 'Stopped by user.' : closure.detail, usage: null, recoveryStatus: 'recovery_needed' });
      new ChatMessageQueueStore(database).setPaused(orphan.sessionId, true);
    }).immediate();
    const report = reconcileChatRun(database, orphan.operationId);
    if (report.status !== 'recovery_failed') {
      const run = store.readRun(orphan.operationId);
      if (run?.requestId) new ChatMessageQueueStore(database).deleteIncorporated(orphan.sessionId, run.requestId);
    }
    recordSessionRecovery(database, orphan.sessionId, store.listSessionRuns(orphan.sessionId), [report]);
    return report;
  } catch (error) {
    assertRecoveryOwner(database, ownerEpoch);
    const run = store.readRun(orphan.operationId);
    if (!run) throw error;
    const report = failedRecovery(run, [recoveryIssue(run.operationId, error instanceof Error ? error : new Error('Orphan recovery failed.'))]);
    recordSessionRecovery(database, orphan.sessionId, store.listSessionRuns(orphan.sessionId), [report]);
    return report;
  }
}

/**
 * Close every run this database holds for a dead owner, then settle the queues they left behind.
 * Each closure replays the run's whole journal, so the lease is renewed at every orphan boundary:
 * a long recovery must never run down the lease of the owner that is doing the work.
 */
export function recoverInterruptedChatRuns(owner: ChatRuntimeOwner, reason: ChatOrphanReason): ChatRecoveryReport[] {
  const database = owner.database;
  const ownerEpoch = owner.ownerEpoch;
  assertRecoveryOwner(database, ownerEpoch);
  const store = new ChatJournalStore(database);
  const orphans = z.array(z.object({ operation_id: z.string(), session_id: z.string() })).parse(database.prepare(`
    SELECT operation_id, session_id FROM chat_runs WHERE record_kind='execution' AND terminal_cause IS NULL AND owner_epoch != ?
    ORDER BY session_id, run_order
  `).all(ownerEpoch));
  const reports: ChatRecoveryReport[] = [];
  for (const orphan of orphans) {
    owner.renew();
    reports.push(closeOrphanedChatRun(database, { operationId: orphan.operation_id, sessionId: orphan.session_id }, ownerEpoch, reason));
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
