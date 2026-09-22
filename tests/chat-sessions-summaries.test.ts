import assert from 'node:assert/strict';
import test from 'node:test';
import { readChatSessionSummaries, readChatSessions, saveChatSession } from '../src/state/chat-sessions.js';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

test('readChatSessionSummaries returns metadata plus the last tool exit code, without messages', () => {
  const runtimeRoot = createManagedTempDir('siftkit-chat-summaries-');
  try {
    const preset = mockModelPreset();
    const base = {
      modelPresetId: preset.id, modelPreset: preset, thinkingEnabled: true, webSearchEnabled: false,
      presetId: 'chat', mode: 'chat' as const, planRepoRoot: 'C:/repo',
      createdAtUtc: '2026-09-01T00:00:00.000Z', updatedAtUtc: '2026-09-01T00:00:00.000Z',
    };
    const message = (id: string, exit: number | null) => ({
      id, role: 'assistant' as const, kind: 'assistant_tool_call' as const, content: 'ran', createdAtUtc: '2026-09-01T00:00:01.000Z',
      inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0, sourceRunId: null,
      toolCallCommand: 'ls', toolCallActivityKind: 'command' as const, toolCallActivitySubject: { kind: 'none' } as const,
      toolCallTurn: 1, toolCallMaxTurns: 5,
      toolCallExecutionState: 'completed' as const, toolCallStatus: 'done' as const, toolCallExitCode: exit,
    });
    saveChatSession(runtimeRoot, { ...base, id: 'failed', title: 'Failed', updatedAtUtc: '2026-09-02T00:00:00.000Z',
      messages: [message('m1', 0), message('m2', 1)] });
    saveChatSession(runtimeRoot, { ...base, id: 'empty', title: 'Empty', messages: [] });

    const summaries = readChatSessionSummaries(runtimeRoot);
    assert.deepEqual(summaries.map(summary => summary.id), ['failed', 'empty']); // newest first
    assert.equal(summaries[0]?.lastToolCallExitCode, 1);
    assert.equal(summaries[1]?.lastToolCallExitCode, null);
    assert.equal('messages' in (summaries[0] ?? {}), false);
    assert.equal(summaries[0]?.title, 'Failed');
    assert.equal(summaries[0]?.modelPreset.id, preset.id);
    // Same ordering and identity as the full reader.
    assert.deepEqual(readChatSessions(runtimeRoot).map(session => session.id), ['failed', 'empty']);
  } finally {
    closeAllRuntimeDatabases();
  }
});