import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionIndicator, isSessionBusy } from '../src/lib/chat-session-state';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import type { ChatSessionRuntime } from '../src/lib/chat-session-runtime-store';
import type { ChatSessionSummary } from '../src/types';
import { applyLiveTranscript } from './live-transcript-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

function session(lastToolCallExitCode: number | null = null): ChatSessionSummary {
  return {
    id: 's1', title: 'S', modelPresetId: 'default', model: null, contextWindowTokens: 32000, planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-07-19T00:00:00Z', updatedAtUtc: '2026-07-19T00:00:00Z',
    lastToolCallExitCode,
  };
}

test('active session with a running tool live message returns tool', () => {
  const runtime = applyLiveTranscript(new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID }), 's1', [{ kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2,
      activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg x', promptTokenCount: 0,
    } }], { operationKind: 'message', controlOperationId: OPERATION_ID })
    .get('s1');
  assert.equal(deriveSessionIndicator(session(), runtime), 'tool');
});

test('active streaming assistant with no running tool returns streaming', () => {
  const runtime = applyLiveTranscript(new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID }), 's1',
  [{ kind: 'answer', delta: { turn: 1, offset: 0, text: 'partial' } }], { operationKind: 'message', controlOperationId: OPERATION_ID })
    .get('s1');
  assert.equal(deriveSessionIndicator(session(), runtime), 'streaming');
});

test('last turn with a non-zero tool exit returns failed', () => {
  const runtime = new ChatSessionRuntimeStore().ensureSession('s1', '').get('s1');
  assert.equal(deriveSessionIndicator(session(1), runtime), 'failed');
});

test('completed answer returns completed', () => {
  const runtime = new ChatSessionRuntimeStore().ensureSession('s1', '').get('s1');
  assert.equal(deriveSessionIndicator(session(0), runtime), 'completed');
});

test('a running tool in live messages outranks the persisted exit code', () => {
  const runtime = applyLiveTranscript(new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message', operationId: OPERATION_ID }), 's1',
  [{ kind: 'tool', tool: {
    kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2,
    activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg x', promptTokenCount: 0,
  } }], { operationKind: 'message', controlOperationId: OPERATION_ID })
    .get('s1');
  assert.equal(deriveSessionIndicator(session(1), runtime), 'tool');
});

test('runtime failure overrides completed persisted messages', () => {
  const runtime = new ChatSessionRuntimeStore()
    .ensureSession('s1', '')
    .apply({ kind: 'failure', sessionId: 's1', message: 'backend failed' })
    .get('s1');
  assert.equal(deriveSessionIndicator(session(), runtime), 'failed');
});

test('isSessionBusy covers local operations, foreign conflicts, and recovered approvals', () => {
  const idle: ChatSessionRuntime = new ChatSessionRuntimeStore()
    .ensureSession('s', '')
    .get('s');
  assert.equal(isSessionBusy(null), false);
  assert.equal(isSessionBusy(idle), false);
  const active = new ChatSessionRuntimeStore()
    .ensureSession('s', '')
    .apply({ kind: 'begin', sessionId: 's', operationKind: 'message', operationId: OPERATION_ID })
    .get('s');
  assert.equal(isSessionBusy(active), true);
  const foreignBusy = new ChatSessionRuntimeStore()
    .ensureSession('s', '')
    .apply({ kind: 'remote-begin', sessionId: 's', operationKind: 'repo-search' })
    .get('s');
  assert.equal(isSessionBusy(foreignBusy), true);
  const recoveredApproval = new ChatSessionRuntimeStore()
    .ensureSession('s', '')
    .apply({ kind: 'snapshot', sessionId: 's', snapshot: chatSnapshot({ sessionId: 's', controlOperationId: null, approval: {
      runId: '4f9c1f9a-0000-4000-8000-000000000000',
      approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
      toolName: 'bash',
      command: 'npm test',
      reviewPayload: null,
      toolCallId: 'call', mode: 'interactive', requestedAtUtc: '2026-09-08T12:00:00.000Z', expiresAtUtc: '2026-09-08T12:10:00.000Z',
      outcome: null, decidedAtUtc: null, actionable: true,
    } }) })
    .get('s');
  assert.equal(isSessionBusy(recoveredApproval), true);
});
