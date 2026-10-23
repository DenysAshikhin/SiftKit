import type { ChatSession } from '../../src/state/chat-sessions.ts';
import { mockModelPreset } from './mock-config.ts';

export function createTestChatSession(runtimeRoot: string): ChatSession {
  const timestamp = '2026-08-08T00:00:00.000Z';
  return {
    id: 'image-persist-session',
    title: 'Image persistence test',
    modelPresetOverrideId: null, modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'managed-exl3', NumCtx: 8192 }),
    thinkingEnabled: true,
    presetId: 'chat',
    mode: 'chat',
    planRepoRoot: runtimeRoot,
    orchestratorRunId: null,
    createdAtUtc: timestamp,
    updatedAtUtc: timestamp,
    messages: [],
  };
}
