import { ChatRecoveryReportSchema, type ChatRecoveryReport } from '@siftkit/contracts';
import type { RuntimeDatabase } from '../state/database-handle.js';
import { z } from '../lib/zod.js';
import { ChatRuntimeOwnerSchema } from '../state/chat-runtime-owner.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import type { ChatJournalEnvelope } from '../state/chat-journal-schema.js';
import { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import { ChatRunRecorder } from './chat-run-recorder.js';
import { buildRecoveredChatHistory, replayChatContext } from './chat-context-replay.js';
import { reconcileChatRun, rebuildChatRun } from './chat-run-projection.js';
import { buildUserContent } from '../llm-protocol/image-attachments.js';

function assertRecoveryOwner(database: RuntimeDatabase, ownerEpoch: string): void {
  const owner = ChatRuntimeOwnerSchema.parse(database.prepare('SELECT * FROM chat_runtime_owner WHERE id=1').get());
  if (`${owner.owner_id}:${owner.epoch}` !== ownerEpoch || Date.parse(owner.lease_expires_at_utc) <= Date.now()) {
    throw new Error('Chat recovery requires the current runtime owner lease.');
  }
}

function readEvents(store: ChatJournalStore, operationId: string): ChatJournalEnvelope[] {
  const events: ChatJournalEnvelope[] = [];
  let sequence = 0;
  for (;;) {
    const page = store.readAfter(operationId, sequence, 500);
    if (page.length === 0) return events;
    events.push(...page);
    sequence = page[page.length - 1].sequence;
  }
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
    database.transaction(() => {
      assertRecoveryOwner(database, ownerEpoch);
      database.prepare('UPDATE chat_runs SET owner_epoch=? WHERE operation_id=? AND terminal_cause IS NULL').run(ownerEpoch, orphan.operation_id);
      const recorder = ChatRunRecorder.resume(database.name, orphan.operation_id, ownerEpoch);
      let events = readEvents(store, orphan.operation_id);
      const resolved = new Set(events.flatMap(envelope => envelope.event.kind === 'approval_resolved' ? [envelope.event.approvalId] : []));
      for (const envelope of events) {
        if (envelope.event.kind === 'approval_requested' && !resolved.has(envelope.event.approvalId)) {
          recorder.recordApprovalResolved({ approvalId: envelope.event.approvalId, outcome: 'interrupted', decision: null,
            reason: 'The owning server stopped.', decidedAtUtc: new Date().toISOString() });
        }
      }
      if (!events.some(envelope => envelope.event.kind === 'context_initialized')) {
        const prior = buildRecoveredChatHistory(database, orphan.session_id, orphan.operation_id);
        const started = events.find(envelope => envelope.event.kind === 'run_started')?.event;
        if (prior.status === 'recovery_failed' || started?.kind !== 'run_started' || events.some(envelope => envelope.event.kind.startsWith('tool_'))) {
          throw new Error('Orphaned run has incomplete context evidence; continuation requires repair.');
        }
        const delivered = events.flatMap(envelope => envelope.event.kind === 'queue_delivered' ? [envelope.event.message] : []);
        recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: prior.messages.length,
          queueMessageIds: delivered.map(message => message.id),
          messages: [...prior.messages, { role: 'user', content: buildUserContent(started.content, started.images) },
            ...delivered.filter(message => message.id !== started.userMessageId).map(message => ({ role: 'user' as const, content: buildUserContent(message.content, message.images) }))],
        });
      }
      events = readEvents(store, orphan.operation_id);
      const replayed = replayChatContext(events);
      if (replayed.status === 'recovery_failed') throw new Error('Orphaned run has corrupt context evidence.');
      let contextLength = 0;
      for (const envelope of events) {
        if (envelope.event.kind === 'context_initialized') contextLength = envelope.event.messages.length;
        if (envelope.event.kind === 'context_spliced') contextLength += envelope.event.inserted.length - envelope.event.deleteCount;
      }
      if (replayed.messages.length > contextLength) recorder.recordContextSpliced({
        expectedRevision: replayed.contextRevision, contextRevision: replayed.contextRevision + 1,
        startIndex: contextLength, deleteCount: 0, inserted: replayed.messages.slice(contextLength),
        turnBoundary: replayed.turnBoundary, reason: 'interruption_closed',
        queueMessageIds: events.flatMap(envelope => envelope.event.kind === 'queue_delivered' ? [envelope.event.message.id] : []),
      });
      recorder.finish({ terminalCause: 'server_restart', detail: 'The owning server stopped.', usage: null, recoveryStatus: 'recovery_needed' });
      new ChatMessageQueueStore(database).setPaused(orphan.session_id, true);
    })();
    reports.push(reconcileChatRun(database, orphan.operation_id));
  }
  return reports;
}

export function reconcileChatSession(database: RuntimeDatabase, sessionId: string): ChatRecoveryReport[] {
  const reports: ChatRecoveryReport[] = [];
  const store = new ChatJournalStore(database);
  for (const run of store.listSessionRuns(sessionId)) {
    // A missing display projection is recoverable even when its checkpoint survived.
    const row = z.object({ count: z.number() }).parse(database.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id=? AND source_run_id=?').get(sessionId, run.operationId));
    const report = row.count === 0 ? rebuildChatRun(database, run.operationId) : reconcileChatRun(database, run.operationId);
    reports.push(ChatRecoveryReportSchema.parse(report));
    if (report.status === 'recovery_failed') break;
  }
  return reports;
}
