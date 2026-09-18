import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ChatRunEffectiveSettings } from '@siftkit/contracts';
import type { SiftConfig } from '../../src/config/types.js';
import { saveChatSession, type ChatSession } from '../../src/state/chat-sessions.js';
import { buildChatRunSettings, ChatRunRecorder, type ChatRunRecorderStart } from '../../src/status-server/chat-run-recorder.js';
import { importChatSessionBaseline } from '../../src/status-server/chat-history-import.js';
import { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { ChatRuntimeOwner } from '../../src/state/chat-runtime-owner.js';
import { ChatSessionOperationRegistry } from '../../src/status-server/chat-session-operation-registry.js';
import type { ServerContext } from '../../src/status-server/server-types.js';
import { createTestServerContext } from './server-context-fixture.js';
import { createTestChatSession } from './chat-sessions.js';
import { getDefaultConfigObject } from '../../src/config/defaults.js';
import { mockModelPreset } from './mock-config.js';
import { createManagedTempDir } from './temp-dirs.js';

export function createTestChatRunRecorder(runtimeRoot: string, session: ChatSession, config: SiftConfig,
  submission: Pick<ChatRunRecorderStart, 'operationKind' | 'content' | 'images' | 'imageMeta'> = {
    operationKind: 'repo-search', content: 'find target', images: [], imageMeta: [],
  },
  settings: Partial<Pick<ChatRunEffectiveSettings, 'presetId' | 'approval' | 'maxTurns' | 'webSearchEnabled'>> = {}): ChatRunRecorder {
  saveChatSession(runtimeRoot, session);
  importChatSessionBaseline(getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite')), session, config);
  return ChatRunRecorder.begin(getRuntimeDatabase(join(runtimeRoot, 'runtime.sqlite')), {
    operationId: randomUUID(), sessionId: session.id, ownerEpoch: 'test-owner', ...submission,
    userMessageId: randomUUID(), retainedHistoryRevision: 0,
    startedAtUtc: new Date().toISOString(),
    settings: buildChatRunSettings({
      session, config, operationKind: submission.operationKind, repoRoot: session.planRepoRoot,
      presetId: settings.presetId ?? session.presetId ?? submission.operationKind,
      approval: settings.approval ?? null, maxTurns: settings.maxTurns ?? null,
      webSearchEnabled: settings.webSearchEnabled ?? session.webSearchEnabled === true,
    }),
  });
}

/**
 * One admitted, context-initialized run held by a live registry lease on a fresh runtime, with the
 * owner lease and server context a heartbeat would find. Tests that drive the owner lease share it.
 */
export function admittedChatRun(prefix: string) {
  const root = createManagedTempDir(prefix);
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  const operations = new ChatSessionOperationRegistry();
  const acquired = operations.acquire(session.id, 'repo-search', randomUUID(), Date.now());
  if (acquired.kind !== 'acquired') throw new Error('Expected operation lease.');
  acquired.lease.recorder = recorder;
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const chatRuntimeOwner = ChatRuntimeOwner.acquire(database, 'owner');
  const ctx: ServerContext = { ...createTestServerContext(join(root, 'config.json'), root),
    chatRuntimeOwner, chatRunOwnerEpoch: chatRuntimeOwner.ownerEpoch, chatSessionOperations: operations };
  return { root, session, recorder, operations, database, chatRuntimeOwner, ctx };
}

/** A repo-agent run on a fresh temp runtime for tests that drive the recorder directly. */
export function beginRepoAgentTestRun(
  prefix: string,
  overrides: Partial<Pick<ChatRunRecorderStart, 'images' | 'imageMeta' | 'startedAtUtc'>> = {},
) {
  const root = createManagedTempDir(prefix);
  const at = overrides.startedAtUtc ?? new Date().toISOString();
  saveChatSession(root, {
    id: 'session', title: 'Run', modelPresetId: 'model', modelPreset: mockModelPreset(),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', createdAtUtc: at, updatedAtUtc: at, messages: [],
  });
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  const recorder = ChatRunRecorder.begin(database, {
    operationId: randomUUID(), sessionId: 'session', ownerEpoch: 'test-owner', operationKind: 'repo-agent',
    userMessageId: 'accepted-user', content: 'Find the answer', images: overrides.images ?? [], imageMeta: overrides.imageMeta ?? [],
    retainedHistoryRevision: 0, startedAtUtc: at, settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'model', model: 'mock', repoRoot: 'C:/repo',
      approval: 'interactive', maxTurns: 200, thinkingEnabled: true, webSearchEnabled: false, contextWindowTokens: 4096,
    },
  });
  return { root, database, recorder };
}
