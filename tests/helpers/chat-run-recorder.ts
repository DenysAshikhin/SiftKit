import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SiftConfig } from '../../src/config/types.js';
import { saveChatSession, type ChatSession } from '../../src/state/chat-sessions.js';
import { buildChatRunSettings, ChatRunRecorder } from '../../src/status-server/chat-run-recorder.js';

export function createTestChatRunRecorder(runtimeRoot: string, session: ChatSession, config: SiftConfig): ChatRunRecorder {
  saveChatSession(runtimeRoot, session);
  return ChatRunRecorder.begin(join(runtimeRoot, 'runtime.sqlite'), {
    operationId: randomUUID(), sessionId: session.id, ownerEpoch: 'test-owner', operationKind: 'repo-search',
    userMessageId: randomUUID(), content: 'find target', images: [], imageMeta: [], retainedHistoryRevision: 0,
    startedAtUtc: new Date().toISOString(),
    settings: buildChatRunSettings({ session, config, operationKind: 'repo-search', repoRoot: process.cwd(), approval: null, maxTurns: null }),
  });
}
