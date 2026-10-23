import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore } from '../../src/state/chat-journal.ts';
import type { ChatJournalEnvelope } from '../../src/state/chat-journal-schema.ts';
import { getRuntimeDatabase } from '../../src/state/runtime-db.ts';
import { saveChatSession } from '../../src/state/chat-sessions.ts';
import { ChatRunRecorder } from '../../src/status-server/chat-run-recorder.ts';
import type { RuntimeDatabase } from '../../src/state/database-handle.ts';
import { createManagedTempDir } from './temp-dirs.ts';
import { mockModelPreset } from './mock-config.ts';

export const SESSION_ID = 'recorder-session';

export const OWNER_EPOCH = 'owner-a:1';

export const SETTINGS = {
  operationKind: 'repo-agent',
  mode: 'repo-search',
  presetId: 'repo-agent',
  modelPresetOverrideId: null, modelPresetId: 'preset-a',
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
    modelPresetOverrideId: null, modelPresetId: 'preset-a',
    modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent',
    mode: 'repo-search',
    planRepoRoot: 'C:/repo',
    orchestratorRunId: null,
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

