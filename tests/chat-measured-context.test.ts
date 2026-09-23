import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatStreamUsageEvent } from '@siftkit/contracts';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { deleteChatMessage, readChatMeasuredContext, type ChatSession } from '../src/state/chat-sessions.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { buildChatRunSettings, ChatRunRecorder } from '../src/status-server/chat-run-recorder.js';
import { buildChatSessionResponse } from '../src/status-server/chat-session-response.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { mockSiftConfig } from './helpers/mock-config.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function usageFrame(turn: number, promptTokens: number, outputTokens: number, thinkingTokens: number): ChatStreamUsageEvent {
  return {
    turn, maxTurns: 10, charsPerToken: 4,
    record: {
      turn, promptTokens, thinkingTokens, outputTokens, toolTokens: 0, generatedChars: 0,
      thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens, thinkingTokens, outputTokens, toolTokens: 0,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
  };
}

/** A run that measured two turns; the second is the one the next request re-sends. */
function measuredRun(prefix: string) {
  const root = createManagedTempDir(prefix);
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  recorder.recordDisplay({ kind: 'usage', usage: usageFrame(1, 1_000, 50, 300) });
  recorder.recordDisplay({ kind: 'usage', usage: usageFrame(2, 9_000, 120, 400) });
  return { root, session, recorder };
}

function beginNextRun(root: string, session: ChatSession, operationKind: 'repo-search' | 'condense'): ChatRunRecorder {
  const config = getDefaultConfigObject();
  return ChatRunRecorder.begin(getRuntimeDatabase(join(root, 'runtime.sqlite')), {
    operationId: randomUUID(), sessionId: session.id, ownerEpoch: 'test-owner', operationKind,
    content: 'next', images: [], imageMeta: [], userMessageId: randomUUID(), retainedHistoryRevision: 0,
    startedAtUtc: new Date().toISOString(),
    settings: buildChatRunSettings({
      session, config, operationKind, repoRoot: session.planRepoRoot,
      presetId: session.presetId ?? operationKind, approval: null, maxTurns: null, webSearchEnabled: false,
    }),
  });
}

test('a completed run is measured by its final turn', () => {
  const { root, session, recorder } = measuredRun('chat-measured-completed-');
  recorder.completeAnswer({ content: 'done' });
  const measured = readChatMeasuredContext(root, session.id);
  assert.ok(measured);
  assert.equal(measured.turn, 2);
  assert.equal(measured.promptTokens, 9_000);
  assert.equal(measured.outputTokens, 120);
  assert.equal(measured.thinkingTokens, 400);
});

test('a completed run that never measured a turn has no measured context', () => {
  const root = createManagedTempDir('chat-measured-unmeasured-');
  const session = createTestChatSession(root);
  const recorder = createTestChatRunRecorder(root, session, getDefaultConfigObject());
  recorder.recordContextInitialized({ contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'find target' }] });
  recorder.completeAnswer({ content: 'done' });
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('a stopped run has no measured context', () => {
  const { root, session, recorder } = measuredRun('chat-measured-stopped-');
  recorder.stop('user_stop', null);
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('a history edit after the run voids the measurement', () => {
  const { root, session, recorder } = measuredRun('chat-measured-edited-');
  recorder.completeAnswer({ content: 'done' });
  assert.ok(deleteChatMessage(root, session.id, recorder.userMessageId));
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('a condense run voids the measurement even when it measured a turn', () => {
  const { root, session, recorder } = measuredRun('chat-measured-condensed-');
  recorder.completeAnswer({ content: 'done' });
  const condense = beginNextRun(root, session, 'condense');
  condense.recordDisplay({ kind: 'usage', usage: usageFrame(1, 500, 80, 0) });
  condense.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  assert.equal(readChatMeasuredContext(root, session.id), null);
});

test('an in-flight run keeps the previous measurement', () => {
  const { root, session, recorder } = measuredRun('chat-measured-inflight-');
  recorder.completeAnswer({ content: 'done' });
  beginNextRun(root, session, 'repo-search');
  assert.equal(readChatMeasuredContext(root, session.id)?.promptTokens, 9_000);
});

test('the session response reports the measured context of the latest completed run', () => {
  const { root, recorder } = measuredRun('chat-measured-response-');
  const saved = recorder.completeAnswer({ content: 'done' });
  // Reasoning content is not replayed, so the final reasoning is not re-sent.
  const config = mockSiftConfig({ Server: { ModelPresets: { Presets: [{ ReasoningContent: false }] } } });
  const response = buildChatSessionResponse(config, root, saved);
  assert.equal(response.contextUsage.usedTokensMeasured, true);
  assert.equal(response.contextUsage.totalUsedTokens, 9_120);
});
