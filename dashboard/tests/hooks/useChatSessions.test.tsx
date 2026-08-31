import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActiveChatRepoAgentResponse } from '@siftkit/contracts';
import { renderHook, waitFor } from '../react-test-environment.js';

import {
  findSessionByIdStrict,
  pickFirstSessionId,
  upsertSession,
  useChatSessions,
} from '../../src/hooks/useChatSessions';
import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import { MANAGED_PRESET } from '../fixtures.js';
import type { ChatMessage, ChatSession } from '../../src/types';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

const SESSION: ChatSession = {
  id: 's1',
  title: 'Session',
  modelPresetId: 'vision',
  modelPreset: {
    ...MANAGED_PRESET,
    id: 'vision',
    Backend: 'exl3',
    VisionEnabled: true,
    VisionMaxImagePixels: 2_097_152,
  },
  model: null,
  contextWindowTokens: 100,
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
};

function chatMessage(
  overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>,
): ChatMessage {
  return {
    id: overrides.id,
    role: overrides.role,
    kind: overrides.kind ?? (overrides.role === 'user' ? 'user_text' : 'assistant_answer'),
    content: overrides.content,
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: '2026-06-03T12:00:00.000Z',
    sourceRunId: null,
    ...overrides,
  };
}

test('pickFirstSessionId returns the first id or empty string', () => {
  assert.equal(pickFirstSessionId([]), '');
  assert.equal(pickFirstSessionId([SESSION, { ...SESSION, id: 's2' }]), 's1');
});

test('findSessionByIdStrict returns the matching session', () => {
  const other = { ...SESSION, id: 's2' };
  assert.equal(findSessionByIdStrict([SESSION, other], 's2'), other);
});

test('findSessionByIdStrict throws when the id is unknown', () => {
  assert.throws(
    () => findSessionByIdStrict([SESSION], 'ghost'),
    /unknown session id "ghost"/,
  );
});

test('upsertSession updates A without replacing selected B', () => {
  const sessionA = { ...SESSION, id: 'session-a' };
  const sessionB = { ...SESSION, id: 'session-b' };
  const updated = upsertSession([sessionA, sessionB], { ...sessionA, title: 'A updated' });
  assert.equal(findSessionByIdStrict(updated, 'session-a').title, 'A updated');
  assert.equal(findSessionByIdStrict(updated, 'session-b'), sessionB);
});

test('adding a new session leaves another session streaming', () => {
  const runtimeStore = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID });
  const sessions = upsertSession(
    [{ ...SESSION, id: 'session-a' }],
    { ...SESSION, id: 'session-b' },
  );
  assert.equal(sessions[0]?.id, 'session-b');
  assert.deepEqual(runtimeStore.get('session-a').activity, {
    kind: 'local', operationKind: 'message', operationId: OPERATION_ID,
  });
});

test('useChatSessions surfaces the initial selected session id without an immediate fetch result', () => {
  function Probe(): React.JSX.Element {
    const result = useChatSessions({
      initialSelectedSessionId: 's-preselected',
      refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }),
      confirmDeleteSession: () => true,
      enqueueToast: () => {},
    });
    return React.createElement('output', {
      dangerouslySetInnerHTML: {
        __html: JSON.stringify({
          selectedSessionId: result.selectedSessionId,
          sessions: result.sessions,
          selectedSession: result.selectedSession,
        }),
      },
    });
  }
  const markup = renderToStaticMarkup(React.createElement(Probe));
  assert.match(markup, /"selectedSessionId":"s-preselected"/);
  assert.match(markup, /"sessions":\[\]/);
  assert.match(markup, /"selectedSession":null/);
});

const CONTEXT_USAGE = {
  contextWindowTokens: 100,
  usedTokens: 0,
  chatUsedTokens: 0,
  thinkingUsedTokens: 0,
  toolUsedTokens: 0,
  imageUsedTokens: 0,
  totalUsedTokens: 0,
  remainingTokens: 100,
  warnThresholdTokens: 50,
  shouldCondense: false,
  estimatedTokenFallbackTokens: 0,
  providerOverheadTokens: 0,
};

const RUNTIME_STATUS = {
  activePresetId: 'vision',
  activePresetLabel: 'Vision',
  backend: 'exl3',
  idleAction: 'unload',
  freezeSupported: true,
  processState: 'ready',
  modelState: 'ready',
  model: 'vision',
  idleDeadlineUtc: null,
  errorPhase: null,
  error: null,
  rollback: null,
  imageTokenBudget: {
    maxPixels: 2_097_152,
    maxImageTokens: 2048,
    pixelsPerToken: 1024,
    encoder: { hiddenSize: 1152, intermediateSize: 4304, patchesPerToken: 4 },
    source: 'preprocessor_config',
  },
  gpuFreeBytes: 100 * 1_048_576,
};

const LOW_CAP_SESSION: ChatSession = {
  ...SESSION,
  modelPreset: { ...SESSION.modelPreset, VisionMaxImagePixels: 409_600 },
};

type ChatFixtureResponse = {
  session: ChatSession;
  contextUsage: typeof CONTEXT_USAGE;
};

class ChatFetchFixture {
  readonly requestedUrls: string[] = [];
  readonly sentBodies: string[] = [];
  detailRequestCount = 0;
  streamRequestCount = 0;
  stopRequestCount = 0;
  operationStatusRequestCount = 0;
  private streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly originalFetch = globalThis.fetch;
  private restored = false;

  constructor(private readonly options: {
    session: ChatSession;
    detailResponse: ChatFixtureResponse;
    streamResponse: ChatFixtureResponse;
    runtimeStatus?: typeof RUNTIME_STATUS;
    activeRun?: ActiveChatRepoAgentResponse;
    operationStatuses?: Array<'active' | 'missing'>;
    holdStream?: boolean;
    stopStatus?: number;
  }) {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      this.requestedUrls.push(url);
      if (typeof init?.body === 'string') {
        this.sentBodies.push(init.body);
      }
      if (url === '/dashboard/chat/sessions') {
        return new Response(JSON.stringify({ sessions: [this.options.session] }), { status: 200 });
      }
      if (url === `/dashboard/chat/sessions/${this.options.session.id}`) {
        this.detailRequestCount += 1;
        return new Response(JSON.stringify(this.options.detailResponse), { status: 200 });
      }
      if (url === `/dashboard/chat/sessions/${this.options.session.id}/repo-agent/active`) {
        return this.options.activeRun
          ? new Response(JSON.stringify(this.options.activeRun), { status: 200 })
          : new Response(JSON.stringify({ error: 'No active run' }), { status: 404 });
      }
      if (url === `/dashboard/chat/sessions/${this.options.session.id}/operation`) {
        const sequence = this.options.operationStatuses ?? ['missing'];
        const index = Math.min(this.operationStatusRequestCount, sequence.length - 1);
        const status = sequence[index];
        this.operationStatusRequestCount += 1;
        return status === 'active'
          ? new Response(JSON.stringify({
              operationKind: 'repo-agent',
              startedAtUtc: '2026-08-31T12:00:00.000Z',
            }), { status: 200 })
          : new Response(JSON.stringify({ error: 'No active operation' }), { status: 404 });
      }
      if (url === `/dashboard/chat/sessions/${this.options.session.id}/messages/stream`) {
        this.streamRequestCount += 1;
        if (this.options.holdStream) {
          return new Response(new ReadableStream<Uint8Array>({
            start: (controller) => { this.streamController = controller; },
          }), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response(`event: done\ndata: ${JSON.stringify(this.options.streamResponse)}\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url === `/dashboard/chat/sessions/${this.options.session.id}/stop`) {
        this.stopRequestCount += 1;
        const status = this.options.stopStatus ?? 200;
        return new Response(
          JSON.stringify(status === 200
            ? { ok: true, operationKind: 'message' }
            : { error: 'Stop transport failed.' }),
          { status },
        );
      }
      if (url === '/runtime/inference' && this.options.runtimeStatus) {
        return new Response(JSON.stringify(this.options.runtimeStatus), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
  }

  finishHeldStream(): void {
    const controller = this.streamController;
    if (!controller) {
      throw new Error('No held stream is active.');
    }
    const event = `event: done\ndata: ${JSON.stringify(this.options.streamResponse)}\n\n`;
    controller.enqueue(new TextEncoder().encode(event));
    controller.close();
    this.streamController = null;
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    globalThis.fetch = this.originalFetch;
  }
}

test('selecting a session restores a parked repo-agent approval', async () => {
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    streamResponse: { session: SESSION, contextUsage: CONTEXT_USAGE },
    activeRun: {
      runId: '4f9c1f9a-0000-4000-8000-000000000000',
      status: 'approval_required',
      approval: {
        approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
        toolName: 'bash',
        command: 'npm test',
        reviewPayload: null,
      },
    },
    operationStatuses: ['active'],
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => {
      assert.equal(hook.result.current.runtimeStore.get('s1').pendingApproval?.command, 'npm test');
      assert.equal(hook.result.current.runtimeStore.get('s1').activity.kind, 'remote');
    });
  } finally {
    fixture.restore();
  }
});

test('a recovered remote operation unlocks only after status disappears and the session refreshes', async () => {
  const response = { session: SESSION, contextUsage: CONTEXT_USAGE };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: response,
    streamResponse: response,
    operationStatuses: ['active', 'missing'],
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => {
      assert.equal(hook.result.current.runtimeStore.get('s1').activity.kind, 'remote');
    });
    await waitFor(() => {
      assert.equal(hook.result.current.runtimeStore.get('s1').activity.kind, 'idle');
      assert.ok(fixture.detailRequestCount >= 2);
      assert.ok(fixture.operationStatusRequestCount >= 2);
    }, { timeout: 2_000 });
  } finally {
    fixture.restore();
  }
});

test('a compacting stream completion installs the boundary and corrected usage without refetching', async () => {
  const compactedSession: ChatSession = {
    ...SESSION,
    messages: [
      chatMessage({ id: 'old-user', role: 'user', kind: 'user_text', content: 'old question', compressedIntoSummary: true }),
      chatMessage({ id: 'old-answer', role: 'assistant', kind: 'assistant_answer', content: 'old answer', compressedIntoSummary: true }),
      chatMessage({ id: 'summary', role: 'assistant', kind: 'compaction_summary', content: 'compact summary' }),
      chatMessage({ id: 'live-user', role: 'user', kind: 'user_text', content: 'trigger question' }),
      chatMessage({ id: 'live-answer', role: 'assistant', kind: 'assistant_answer', content: 'fresh answer' }),
    ],
  };
  const correctedUsage = {
    ...CONTEXT_USAGE,
    usedTokens: 12,
    chatUsedTokens: 12,
    totalUsedTokens: 12,
    remainingTokens: 88,
    shouldCondense: false,
  };
  const initialResponse = { session: SESSION, contextUsage: CONTEXT_USAGE };
  const doneResponse = { session: compactedSession, contextUsage: correctedUsage };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: initialResponse,
    streamResponse: doneResponse,
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1',
      refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }),
      confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => { assert.notEqual(hook.result.current.selectedSession, null); });
    act(() => { hook.result.current.setSessionDraft('s1', 'trigger question'); });
    await waitFor(() => { assert.equal(hook.result.current.runtimeStore.get('s1').draft, 'trigger question'); });
    await act(async () => { await hook.result.current.sendMessage(); });

    const selectedSession = hook.result.current.selectedSession;
    assert.ok(selectedSession);
    assert.equal(fixture.streamRequestCount, 1, fixture.requestedUrls.join(', '));
    assert.equal(
      selectedSession.messages.some(
        (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
      ),
      true,
    );
    assert.equal(selectedSession.messages.some((message) => message.compressedIntoSummary === true), true);
    const runtime = hook.result.current.runtimeStore.get('s1');
    assert.equal(runtime.contextUsage?.totalUsedTokens, 12);
    assert.equal(runtime.contextUsage?.shouldCondense, false);
    assert.equal(fixture.detailRequestCount, 1);
  } finally {
    fixture.restore();
  }
});

test('stopOperation posts for the selected session', async () => {
  const response = { session: SESSION, contextUsage: CONTEXT_USAGE };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: response,
    streamResponse: response,
    holdStream: true,
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1',
      refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }),
      confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => { assert.notEqual(hook.result.current.selectedSession, null); });
    act(() => { hook.result.current.setSessionDraft('s1', 'stop this'); });
    let sendPromise: Promise<void> | null = null;
    act(() => { sendPromise = hook.result.current.sendMessage(); });
    await waitFor(() => { assert.equal(hook.result.current.runtimeStore.get('s1').activity.kind, 'local'); });
    await act(async () => { await hook.result.current.stopOperation(); });
    assert.equal(fixture.stopRequestCount, 1);
    fixture.finishHeldStream();
    if (!sendPromise) {
      throw new Error('Expected send promise.');
    }
    await act(async () => { await sendPromise; });
  } finally {
    fixture.restore();
  }
});

test('a failed Stop request preserves the locally active stream state', async () => {
  const response = { session: SESSION, contextUsage: CONTEXT_USAGE };
  const fixture = new ChatFetchFixture({
    session: SESSION,
    detailResponse: response,
    streamResponse: response,
    holdStream: true,
    stopStatus: 503,
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1', refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }), confirmDeleteSession: () => true,
      enqueueToast: () => {},
    }));
    await waitFor(() => { assert.notEqual(hook.result.current.selectedSession, null); });
    act(() => { hook.result.current.setSessionDraft('s1', 'keep running'); });
    let sendPromise: Promise<void> | null = null;
    act(() => { sendPromise = hook.result.current.sendMessage(); });
    await waitFor(() => { assert.equal(hook.result.current.runtimeStore.get('s1').activity.kind, 'local'); });

    await act(async () => { await hook.result.current.stopOperation(); });
    const afterStopFailure = hook.result.current.runtimeStore.get('s1');
    assert.equal(afterStopFailure.activity.kind, 'local');
    assert.equal(afterStopFailure.error, 'Request failed (503): {"error":"Stop transport failed."}');
    assert.equal(afterStopFailure.submittedInput?.content, 'keep running');

    fixture.finishHeldStream();
    if (!sendPromise) {
      throw new Error('Expected send promise.');
    }
    await act(async () => { await sendPromise; });
  } finally {
    fixture.restore();
  }
});

async function sendImageForHeadroom(
  session: ChatSession,
  runtimeStatus: typeof RUNTIME_STATUS,
): Promise<{ toasts: Array<[string, string]>; sentBodies: string[] }> {
  const toasts: Array<[string, string]> = [];
  const doneResponse = { session, contextUsage: CONTEXT_USAGE };
  const fixture = new ChatFetchFixture({
    session,
    detailResponse: doneResponse,
    streamResponse: doneResponse,
    runtimeStatus,
  });
  try {
    const hook = renderHook(() => useChatSessions({
      initialSelectedSessionId: 's1',
      refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }),
      confirmDeleteSession: () => true,
      enqueueToast: (level, text) => toasts.push([level, text]),
    }));
    await waitFor(() => { assert.notEqual(hook.result.current.selectedSession, null); });
    act(() => {
      hook.result.current.setSessionImages('s1', [{ dataUrl: 'data:image/png;base64,AAAA', note: null }]);
    });
    await act(async () => { await hook.result.current.sendMessage(); });
    return { toasts, sentBodies: fixture.sentBodies };
  } finally {
    fixture.restore();
  }
}

test('sending images with a low selected-session cap uses that cap for the advisory grade', async () => {
  const result = await sendImageForHeadroom(LOW_CAP_SESSION, RUNTIME_STATUS);
  assert.deepEqual(result.toasts, []);
  assert.equal(result.sentBodies.some((body) => body.includes('"images":["data:image/png;base64,AAAA"]')), true);
});

test('sending images with insufficient headroom enqueues an error toast and still sends', async () => {
  const result = await sendImageForHeadroom(SESSION, RUNTIME_STATUS);
  assert.equal(result.toasts[0]?.[0], 'error');
  assert.match(result.toasts[0]?.[1] ?? '', /likely to fail/u);
  assert.equal(result.sentBodies.some((body) => body.includes('"images":["data:image/png;base64,AAAA"]')), true);
});

test('sending images with comfortable headroom enqueues no toast', async () => {
  const result = await sendImageForHeadroom(SESSION, { ...RUNTIME_STATUS, gpuFreeBytes: 8 * 1_073_741_824 });
  assert.deepEqual(result.toasts, []);
});
