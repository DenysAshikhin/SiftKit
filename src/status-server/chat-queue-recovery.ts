import { join } from 'node:path';
import { getRuntimeDatabase } from '../state/runtime-db.js';
import { ChatMessageQueueStore } from '../state/chat-message-queue.js';
import { getChatSessionPath, readChatSessionFromPath, saveChatSession } from '../state/chat-sessions.js';
import { buildChatUserMessage, buildQueuedChatUserMessage } from './chat.js';

/** Startup only: preserve submitted steering without pretending interrupted tool evidence survived. */
export function recoverInterruptedChatQueue(runtimeRoot: string): void {
  const database = getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite'));
  const store = new ChatMessageQueueStore(database);
  database.transaction(() => {
    for (const sessionId of store.interruptedSessionIds()) {
      const session = readChatSessionFromPath(getChatSessionPath(runtimeRoot, sessionId));
      if (!session) throw new Error(`Missing session for interrupted queue ${sessionId}.`);
      const messages = [...(session.messages ?? [])];
      const delivered = store.list(sessionId).filter((row) => row.state === 'delivered');
      const missing = delivered.filter((row) => !messages.some((message) => message.id === row.id));
      const now = new Date().toISOString();
      for (const row of missing) messages.push(buildQueuedChatUserMessage(session, row, row.createdAtUtc));
      if (missing.length > 0) messages.push({
        ...buildChatUserMessage('The server restarted during queued delivery. Active execution evidence is unavailable; queued user messages were recovered, but interrupted tools have not been replayed.', [], [], now),
        role: 'assistant', kind: 'assistant_answer',
      });
      saveChatSession(runtimeRoot, { ...session, messages, updatedAtUtc: now });
      for (const requestId of new Set(delivered.map((row) => row.deliveredRequestId))) {
        if (requestId === null) throw new Error('Delivered queue entry has no request identity.');
        store.deleteIncorporated(sessionId, requestId);
      }
      const force = store.state(sessionId).force;
      if (force) store.failForce(sessionId, force, 'Server restarted before queued delivery settled. Review the saved conversation before continuing.');
      store.setPaused(sessionId, true);
    }
  })();
}
