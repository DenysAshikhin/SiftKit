import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore } from '../../src/state/chat-journal.js';
import type { ChatJournalEnvelope } from '../../src/state/chat-journal-schema.js';
import { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { saveChatSession } from '../../src/state/chat-sessions.js';
import { ChatRunRecorder } from '../../src/status-server/chat-run-recorder.js';
import type { RuntimeDatabase } from '../../src/state/database-handle.js';
import { createManagedTempDir } from './temp-dirs.js';
import { mockModelPreset } from './mock-config.js';

export const SESSION_ID = 'recorder-session';

export const OWNER_EPOCH = 'owner-a:1';

export const SETTINGS = {
  operationKind: 'repo-agent',
  mode: 'repo-search',
  presetId: 'repo-agent',
  modelPresetId: 'preset-a',
  model: 'model-a',
  repoRoot: 'C:/repo',
  approval: 'interactive',
  maxTurns: 120,
  thinkingEnabled: true,
  webSearchEnabled: false,
  contextWindowTokens: 4096,
} as const;

export function openSessionDatabase(prefix: string): { database: RuntimeDatabase; databasePath: string } {
  const runtimeRoot = createManagedTempDir(prefix);
  saveChatSession(runtimeRoot, {
    id: SESSION_ID,
    title: 'Recorder session',
    modelPresetId: 'preset-a',
    modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent',
    mode: 'repo-search',
    planRepoRoot: 'C:/repo',
    createdAtUtc: AT,
    updatedAtUtc: AT,
    messages: [],
  });
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  return { database: getRuntimeDatabase(databasePath), databasePath };
}

export function beginRecorder(databasePath: string, operationId = randomUUID()): ChatRunRecorder {
  return ChatRunRecorder.begin(getRuntimeDatabase(databasePath), {
    operationId,
    sessionId: SESSION_ID,
    ownerEpoch: OWNER_EPOCH,
    operationKind: 'repo-agent',
    userMessageId: 'user-1',
    content: 'delete the dead physics module',
    images: [],
    imageMeta: [],
    settings: SETTINGS,
    retainedHistoryRevision: 0,
    startedAtUtc: AT,
  });
}

export function readAll(database: RuntimeDatabase, operationId: string): ChatJournalEnvelope[] {
  return new ChatJournalStore(database).readAfter(operationId, 0, 500);
}

export const AT = '2026-09-10T11:04:54.755Z';

