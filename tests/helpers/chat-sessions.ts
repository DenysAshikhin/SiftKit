import type { ChatSession } from '../../src/state/chat-sessions.js';
import { mockModelPreset } from './mock-config.js';

export function createTestChatSession(runtimeRoot: string): ChatSession {
  const timestamp = '2026-08-08T00:00:00.000Z';
  return {
    id: 'image-persist-session',
    title: 'Image persistence test',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default', Model: 'managed.gguf', NumCtx: 8192 }),
    thinkingEnabled: true,
    presetId: 'chat',
    mode: 'chat',
    planRepoRoot: runtimeRoot,
    condensedSummary: '',
    createdAtUtc: timestamp,
    updatedAtUtc: timestamp,
    messages: [],
  };
}
