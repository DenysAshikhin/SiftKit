import { createHash, randomUUID } from 'node:crypto';
import { PersistedChatTranscriptMessageSchema, type ChatRunTerminalCause } from '@siftkit/contracts';
import type { SiftConfig } from '../config/types.js';
import { stableStringify } from '../lib/json.js';
import { ChatJournalStore } from '../state/chat-journal.js';
import type { RuntimeDatabase } from '../state/database-handle.js';
import type { ChatSession } from '../state/chat-sessions.js';
import { buildChatHistoryMessages } from './chat.js';
import { reconcileChatRun } from './chat-run-projection.js';
import type { ChatEngineBinding, ChatJournalEvent, ChatRunStart } from '../state/chat-journal-schema.js';

/** One baseline record, shared by admission migration and explicit archive repair. */
export function recordImportedChatBaseline(database: RuntimeDatabase, options:
  Pick<ChatRunStart, 'sessionId' | 'ownerEpoch' | 'createdAtUtc'> & {
    event: Extract<ChatJournalEvent, { kind: 'baseline_imported' }>;
    terminalCause: ChatRunTerminalCause;
    updatedAtUtc: string;
    binding: Pick<ChatEngineBinding, 'requestId' | 'repoAgentSessionId'> | null;
  }): string {
  const store = new ChatJournalStore(database);
  const operationId = randomUUID();
  database.transaction(() => {
    store.begin({ operationId, sessionId: options.sessionId, recordKind: 'baseline', operationKind: null,
      ownerEpoch: options.ownerEpoch, settings: null, provenance: options.event.provenance, createdAtUtc: options.createdAtUtc });
    if (options.binding) store.bindEngine({ operationId, ownerEpoch: options.ownerEpoch, ...options.binding });
    store.append({ operationId, ownerEpoch: options.ownerEpoch, expectedSequence: 0, eventId: 'baseline',
      occurredAtUtc: options.createdAtUtc, event: options.event });
    store.finish({ operationId, ownerEpoch: options.ownerEpoch, terminalCause: options.terminalCause, updatedAtUtc: options.updatedAtUtc });
  })();
  return operationId;
}

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
  const now = new Date().toISOString();
  const operationId = recordImportedChatBaseline(database, {
    sessionId: session.id, ownerEpoch: 'baseline-import', createdAtUtc: now, updatedAtUtc: now,
    terminalCause: 'completed', binding: null, event: { kind: 'baseline_imported', messages, retainedContext, provenance },
  });
  const report = reconcileChatRun(database, operationId);
  if (report.status === 'recovery_failed') throw new Error('Imported chat baseline requires projection recovery.');
}
