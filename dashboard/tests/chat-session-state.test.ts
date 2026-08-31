import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionIndicator, isSessionBusy } from '../src/lib/chat-session-state';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import type { ChatSessionRuntime } from '../src/lib/chat-session-runtime-store';
import type { ChatMessage, ChatSession } from '../src/types';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1', role: 'assistant', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    ...overrides,
  };
}

function session(messages: ChatMessage[]): ChatSession {
  return {
    id: 's1', title: 'S', model: null, contextWindowTokens: 32000,
    createdAtUtc: '2026-07-19T00:00:00Z', updatedAtUtc: '2026-07-19T00:00:00Z',
    messages,
  };
}

test('active session with a running tool live message returns tool', () => {
  const runtime = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message' })
    .apply({ kind: 'tool', sessionId: 's1', toolEvent: {
      kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2, toolCallLimit: 2,
      activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg x', promptTokenCount: 0,
    } })
    .get('s1');
  assert.equal(deriveSessionIndicator(session([]), runtime), 'tool');
});

test('active streaming assistant with no running tool returns streaming', () => {
  const runtime = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'begin', sessionId: 's1', operationKind: 'message' })
    .apply({ kind: 'answer', sessionId: 's1', delta: { turn: 1, offset: 0, text: 'partial' } })
    .get('s1');
  assert.equal(deriveSessionIndicator(session([]), runtime), 'streaming');
});

test('last turn with a non-zero tool exit returns failed', () => {
  const runtime = new ChatSessionRuntimeStore().ensureSession('s1').get('s1');
  assert.equal(
    deriveSessionIndicator(
      session([msg({ kind: 'assistant_tool_call', toolCallStatus: 'done', toolCallExitCode: 1 })]),
      runtime,
    ),
    'failed',
  );
});

test('completed answer returns completed', () => {
  const runtime = new ChatSessionRuntimeStore().ensureSession('s1').get('s1');
  assert.equal(
    deriveSessionIndicator(session([msg({ kind: 'assistant_answer', content: 'done' })]), runtime),
    'completed',
  );
});

test('runtime failure overrides completed persisted messages', () => {
  const runtime = new ChatSessionRuntimeStore()
    .ensureSession('s1')
    .apply({ kind: 'failure', sessionId: 's1', message: 'backend failed' })
    .get('s1');
  assert.equal(deriveSessionIndicator(session([]), runtime), 'failed');
});

test('isSessionBusy covers local operations, foreign conflicts, and recovered approvals', () => {
  const idle: ChatSessionRuntime = new ChatSessionRuntimeStore()
    .ensureSession('s')
    .get('s');
  assert.equal(isSessionBusy(null), false);
  assert.equal(isSessionBusy(idle), false);
  const active = new ChatSessionRuntimeStore()
    .apply({ kind: 'begin', sessionId: 's', operationKind: 'message' })
    .get('s');
  assert.equal(isSessionBusy(active), true);
  const foreignBusy = new ChatSessionRuntimeStore()
    .apply({ kind: 'failure', sessionId: 's', message: 'busy', remoteBusy: true })
    .get('s');
  assert.equal(isSessionBusy(foreignBusy), true);
  const recoveredApproval = new ChatSessionRuntimeStore()
    .apply({
      kind: 'approval',
      sessionId: 's',
      approval: {
        runId: '4f9c1f9a-0000-4000-8000-000000000000',
        approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
        toolName: 'bash',
        command: 'npm test',
        reviewPayload: null,
      },
    })
    .get('s');
  assert.equal(isSessionBusy(recoveredApproval), true);
});
