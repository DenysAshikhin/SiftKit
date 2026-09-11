import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SiftConfig } from '../../src/config/types.js';
import { saveChatSession, type ChatSession } from '../../src/state/chat-sessions.js';
import { buildChatRunSettings, ChatRunRecorder, type ChatRunRecorderStart } from '../../src/status-server/chat-run-recorder.js';
import { importChatSessionBaseline } from '../../src/status-server/chat-history-import.js';
import { getRuntimeDatabase } from '../../src/state/runtime-db.js';

export function createTestChatRunRecorder(runtimeRoot: string, session: ChatSession, config: SiftConfig,
  submission: Pick<ChatRunRecorderStart, 'operationKind' | 'content' | 'images' | 'imageMeta'> = {
    operationKind: 'repo-search', content: 'find target', images: [], imageMeta: [],
  }): ChatRunRecorder {
  saveChatSession(runtimeRoot, session);
  importChatSessionBaseline(getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite')), session, config);
  return ChatRunRecorder.begin(join(runtimeRoot, 'runtime.sqlite'), {
    operationId: randomUUID(), sessionId: session.id, ownerEpoch: 'test-owner', ...submission,
    userMessageId: randomUUID(), retainedHistoryRevision: 0,
    startedAtUtc: new Date().toISOString(),
    settings: buildChatRunSettings({ session, config, operationKind: submission.operationKind, repoRoot: session.planRepoRoot, approval: null, maxTurns: null }),
  });
}
