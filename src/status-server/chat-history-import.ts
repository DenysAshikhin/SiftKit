import { createHash, randomUUID } from 'node:crypto';
import { PersistedChatTranscriptMessageSchema } from '@siftkit/contracts';
import type { SiftConfig } from '../config/types.js';
import { stableStringify } from '../lib/json.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { buildChatHistoryMessages } from './chat.js';
import { reconcileChatRun } from './chat-run-projection.js';

/** Explicit one-time import at admission/migration, never a provider-history fallback. */
export function importChatSessionBaseline(database: RuntimeDatabase, session: ChatSession, config: SiftConfig): void {
  const store = new ChatJournalStore(database);
  if (store.listSessionRuns(session.id).length > 0 || !session.messages?.length) return;
  const messages = PersistedChatTranscriptMessageSchema.array().parse(session.messages);
  const retainedContext = buildChatHistoryMessages(config, session);
  const provenance = {
    importerVersion: 1, sourceKind: 'saved_chat' as const, sourceId: session.id,
    sourceDigest: createHash('sha256').update(stableStringify(messages)).digest('hex'),
  };
  const operationId = randomUUID();
  const now = new Date().toISOString();
  database.transaction(() => {
    store.begin({ operationId, sessionId: session.id, recordKind: 'baseline', operationKind: null,
      ownerEpoch: 'baseline-import', settings: null, provenance, createdAtUtc: now });
    store.append({ operationId, ownerEpoch: 'baseline-import', expectedSequence: 0, eventId: 'baseline', occurredAtUtc: now,
      event: { kind: 'baseline_imported', messages, retainedContext, provenance } });
    store.finish({ operationId, ownerEpoch: 'baseline-import', terminalCause: 'completed', updatedAtUtc: now });
  })();
  const report = reconcileChatRun(database, operationId);
  if (report.status === 'recovery_failed') throw new Error('Imported chat baseline requires projection recovery.');
}
