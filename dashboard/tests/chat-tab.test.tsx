import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSessionResponseSchema, DurableChatApprovalSchema, buildChatRunMessageIdPrefix, buildChatMessageId } from '@siftkit/contracts';
import { fireEvent, render as renderComponent, screen } from './react-test-environment.js';
import { ChatSessionRuntimeStore, type ChatSessionRuntimeTransition } from '../src/lib/chat-session-runtime-store';
import { ChatStreamReader } from '../src/lib/chat-stream-parser';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import { groupMessagesIntoTurns } from '../src/lib/chatTurns';
import { GatedChatBackend } from '../../tests/helpers/gated-chat-backend.js';
import { ChatMessageQueueResponseSchema } from '@siftkit/contracts';
import { ChatTab } from '../src/tabs/ChatTab';
import type { ChatMessage, ChatSession, ChatSessionOperationKind, ContextUsage, DashboardPreset } from '../src/types';
import type { PendingImage } from '../src/lib/downscale-image';
import { buildUsageFrame } from './usage-frame';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { applyLiveTranscript, type LiveTranscriptStep } from './live-transcript-fixture.js';
import { createLiveMessage } from '../src/lib/chat-live-messages';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

for (const grouped of [false, true]) test(`Stop outcome is visible once outside generated text (grouped=${grouped})`, () => {
  const answer = { ...createLiveMessage('partial', 'assistant_answer', 'assistant', 'Original partial answer'), runTerminalCause: 'user_stop' as const };
  const messages = grouped ? [createLiveMessage('thinking', 'assistant_thinking', 'assistant', 'Reasoning'), answer] : [answer];
  const snapshot = chatSnapshot({ sessionId: 'session-b', operationKind: 'message', terminalCause: 'user_stop', messages });
  const store = buildDefaultStore('session-b').apply({ kind: 'snapshot', sessionId: 'session-b', snapshot });
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
  try {
    assert.match(view.container.textContent ?? '', /Original partial answer/u);
    assert.equal(view.container.querySelectorAll('[aria-label="Run outcome"]').length, 1);
    assert.equal(view.container.querySelector('[aria-label="Run outcome"]')?.textContent, 'Stopped by user.');
    assert.equal(answer.content, 'Original partial answer');
  } finally { view.unmount(); }
});

test('recovery failure keeps the conversation readable and disables only continuation', () => {
  const snapshot = chatSnapshot({ sessionId: 'session-b', operationKind: 'message', status: 'recovery_failed', terminalCause: 'provider_failure',
    messages: [createLiveMessage('retained', 'assistant_answer', 'assistant', 'Readable partial answer')] });
  let store = buildDefaultStore('session-b').apply({ kind: 'draft', sessionId: 'session-b', draft: 'continue' })
    .apply({ kind: 'snapshot', sessionId: 'session-b', snapshot });
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
  try {
    assert.match(view.container.textContent ?? '', /Readable partial answer/u);
    assert.match(view.container.textContent ?? '', /repair/u);
    assert.ok(view.container.querySelector('button.send:not(.stop)')?.hasAttribute('disabled'));
    store = store.apply({ kind: 'snapshot', sessionId: 'session-b', snapshot: { ...snapshot, status: 'recovery_needed' } });
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
    assert.equal(view.container.querySelector('button.send:not(.stop)')?.hasAttribute('disabled'), false);
  } finally { view.unmount(); }
});

test('active token badges grow before usage and settle without losing late text accounting', () => {
  const live = { operationKind: 'message', controlOperationId: OPERATION_ID } as const;
  const prompt: LiveTranscriptStep = { kind: 'prompt', prompt: { turn: 1, maxTurns: 20, promptTokens: 50, charsPerToken: 4 } };
  let store = buildDefaultStore('session-b').apply({ kind: 'begin', sessionId: 'session-b', operationKind: 'message', operationId: OPERATION_ID });
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
  try {
    for (const length of [400, 800]) {
      store = applyLiveTranscript(store, 'session-b', [prompt, { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'x'.repeat(length) } }], live);
      view.rerender(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
      assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, `~${length / 4} tokens`);
      assert.equal(store.get('session-b').liveMessages[0]?.thinkingTokens, 0);
    }
    const settled: LiveTranscriptStep[] = [
      prompt, { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'x'.repeat(800) } },
      { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 187 } }) },
      { kind: 'thinking', delta: { turn: 1, offset: 800, text: 'tail' } },
    ];
    store = applyLiveTranscript(store, 'session-b', settled, live);
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, '187 tokens');
    assert.equal(view.container.querySelector('.msg.turn > .who .msg-tokens')?.textContent, '187 run tokens');
    store = applyLiveTranscript(store, 'session-b', [...settled,
      { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 187, thinkingTokensEstimated: true } }) }], live);
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
    assert.equal(view.container.querySelector('.msg.turn > .who .msg-tokens')?.textContent, '~187 run tokens');
    store = applyLiveTranscript(store.apply({ kind: 'attach', sessionId: 'session-b', operationKind: 'message', operationId: OPERATION_ID }),
      'session-b', [{ kind: 'thinking', delta: { turn: 1, offset: 0, text: 'truncated replay' } }], live);
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: 'session-b', selectedRuntime: store.get('session-b') })} />);
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, 'tokens unavailable');
    assert.equal(view.container.querySelector('.msg.turn > .who .msg-tokens')?.textContent, 'tokens unavailable');
  } finally { view.unmount(); }
});

import { DashboardTestServer } from '../../tests/helpers/dashboard-server-fixture.js';
import { requestJson, requestSse } from '../../tests/helpers/dashboard-http.js';
import { getDefaultConfig, writeConfig } from '../../src/status-server/config-store.js';
import { getActiveModelPreset } from '../../src/config/getters.js';
import { getRuntimeDatabasePath } from '../../src/state/runtime-db.js';
import { getRuntimeRoot } from '../../src/config/paths.js';
import { saveChatSession } from '../../src/state/chat-sessions.js';

/** Every rendered token badge, in DOM order, so an assertion names the badges and not the markup. */
function readTokenBadges(html: string): string[] {
  return [...html.matchAll(/<span class="msg-tokens"[^>]*>([^<]*)<\/span>/gu)].map((match) => match[1] ?? '');
}

async function* readHttpChat(url: string, signal: AbortSignal, body?: Record<string, string | number | boolean>) {
  const response = await fetch(url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  } : { signal });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  yield* new ChatStreamReader(response.body.getReader()).events();
}

async function readThrough(
  stream: AsyncGenerator<ChatSessionRuntimeTransition>,
  store: ChatSessionRuntimeStore,
  kind: 'prompt' | 'thinking' | 'terminal',
  thinkingTurn?: number,
) {
  const before = store;
  for (;;) {
    const next = await stream.next();
    assert.equal(next.done, false, `stream ended before ${kind}`);
    assert.ok(next.value);
    store = store.apply(next.value);
    if (next.value.kind === 'failure') throw new Error(next.value.message);
    if (kind === 'terminal' && next.value.kind === 'terminal') return { store, transition: next.value };
    if (next.value.kind !== 'snapshot') continue;
    const prior = before.get(next.value.sessionId);
    const snapshot = next.value.snapshot;
    if (kind === 'prompt' && snapshot.tokenTurns.some(turn => turn.prompt !== null && turn.turn > Math.max(0, ...prior.tokenTurns.keys()))) {
      return { store, transition: next.value };
    }
    if (kind === 'thinking' && snapshot.messages.some(message => message.kind === 'assistant_thinking'
      && (thinkingTurn === undefined || message.id === buildChatMessageId(buildChatRunMessageIdPrefix(snapshot.operationId), { kind: 'thinking', turn: thinkingTurn }))
      && message.content !== prior.liveMessages.find(previous => previous.id === message.id)?.content)) {
      return { store, transition: next.value };
    }
  }
}

test('a rejected chat route fails promptly even when no provider request arrives', async (t) => {
  const backend = new GatedChatBackend();
  t.after(() => backend.close());
  const baseUrl = await backend.start();
  const store = new ChatSessionRuntimeStore().ensureSession('s', '');
  const stream = toRuntimeTransitions('s', { kind: 'owned', operationKind: 'plan', operationId: OPERATION_ID }, readHttpChat(`${baseUrl}/missing-chat-route`, t.signal), true);
  t.after(async () => { await stream.return(); });
  await assert.rejects(Promise.all([readThrough(stream, store, 'prompt'), backend.nextRequest()]), /404/u);
});

for (const queued of [false, true]) {
  test(`gated HTTP thinking grows before completion${queued ? ' across FIFO delivery and replay' : ''} and settles to persisted totals`, { timeout: 20000 }, async (t) => {
    const backend = new GatedChatBackend();
    t.after(() => backend.close());
    const server = await DashboardTestServer.start('chat-token-e2e-', { baseUrl: await backend.start(), model: 'mock' });
    t.after(() => server.close());
    const created = ChatSessionResponseSchema.parse((await requestJson(`${server.baseUrl}/dashboard/chat/sessions`, {
      method: 'POST', body: JSON.stringify({ title: 'tokens', thinkingEnabled: true }),
    })).body);
    const sessionId = created.session.id;
    const url = `${server.baseUrl}/dashboard/chat/sessions/${sessionId}`;
    let store = new ChatSessionRuntimeStore().ensureSession(sessionId, '')
      .apply({ kind: 'submit', sessionId, content: 'inspect', images: [] });
    let session = created.session;
    const props = () => buildProps({ selectedSessionId: sessionId, selectedSession: session, sessions: [session], selectedRuntime: store.get(sessionId), sessionRuntimes: store.getAll() });
    const view = renderComponent(<ChatTab {...props()} />);
    const stream = toRuntimeTransitions(sessionId, { kind: 'owned', operationKind: 'plan', operationId: OPERATION_ID }, readHttpChat(`${url}/plan/stream`, t.signal, { content: 'inspect', repoRoot: server.tempRoot, operationId: OPERATION_ID, maxTurns: 3 }), true);
    t.after(async () => { await stream.return(); });
    try {
      const firstPrompt = readThrough(stream, store, 'prompt');
      const [first, initial] = await Promise.all([backend.nextRequest(), firstPrompt]);
      store = initial.store;
      for (const [expectedLength, expectedBadge] of [[400, '~100 tokens'], [800, '~200 tokens']] as const) {
        backend.write(first, { reasoning_content: 'x'.repeat(400) });
        store = (await readThrough(stream, store, 'thinking')).store;
        view.rerender(<ChatTab {...props()} />);
        const count = store.get(sessionId).liveMessages.find((message) => message.kind === 'assistant_thinking')?.content.length;
        assert.equal(count, expectedLength);
        assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, expectedBadge);
        assert.equal(store.get(sessionId).tokenTurns.get(1)?.usage, null);
        if (queued && expectedLength === 400) {
          for (const [index, id] of [QUEUE_ONE_ID, '4f9c1f9a-0000-4000-8000-000000000002'].entries()) {
            const response = await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id, content: `queued ${index}`, images: [], options: { operationKind: 'plan', repoRoot: server.tempRoot } }) });
            assert.equal(response.statusCode, 200);
            const tokenTurns = store.get(sessionId).tokenTurns;
            store = store.apply({ kind: 'queue', sessionId, queue: ChatMessageQueueResponseSchema.parse(response.body).queue })
              .apply({ kind: 'queued-submit', sessionId, content: `queued ${index}`, images: [] });
            assert.equal(store.get(sessionId).tokenTurns, tokenTurns);
          }
        }
      }
      let terminalCause: string | null = null;
      if (queued) {
        backend.write(first, { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }] });
        backend.finish(first);
        const nextPrompt = readThrough(stream, store, 'prompt');
        const [second, next] = await Promise.all([backend.nextRequest(), nextPrompt]);
        store = next.store;
        assert.deepEqual(store.get(sessionId).liveMessages.filter((message) => message.role === 'user').map((message) => message.content), ['inspect', 'queued 0', 'queued 1']);
        assert.equal(store.get(sessionId).liveMessages.find((message) => message.kind === 'assistant_thinking')?.thinkingTokens, 10);
        backend.write(second, { reasoning_content: 'y'.repeat(400) });
        store = (await readThrough(stream, store, 'thinking')).store;
        view.rerender(<ChatTab {...props()} />);
        assert.equal(view.container.querySelectorAll('.msg.turn').length, 2);
        const beforeReplay = readTokenBadges(view.container.innerHTML);
        const replay = toRuntimeTransitions(sessionId, { kind: 'attached' }, readHttpChat(`${url}/operation/stream`, t.signal), true);
        t.after(async () => { await replay.return(); });
        const replayNext = await readThrough(replay, new ChatSessionRuntimeStore().ensureSession(sessionId, ''), 'thinking', 2);
        const originalStore = store;
        store = replayNext.store;
        view.rerender(<ChatTab {...props()} />);
        assert.deepEqual(readTokenBadges(view.container.innerHTML), beforeReplay);
        store = originalStore;
        backend.write(second, { content: 'finished' });
        backend.finish(second);
        const replayDone = readThrough(replay, replayNext.store, 'terminal');
        const completed = await readThrough(stream, store, 'terminal');
        await replayDone;
        store = completed.store;
        if (completed.transition.kind !== 'terminal') throw new Error('Expected completion terminal.');
        terminalCause = completed.transition.terminal.terminalCause;
      } else {
        backend.write(first, { content: 'finished' });
        backend.finish(first);
        const completed = await readThrough(stream, store, 'terminal');
        store = completed.store;
        if (completed.transition.kind !== 'terminal') throw new Error('Expected completion terminal.');
        terminalCause = completed.transition.terminal.terminalCause;
      }
      const persisted = ChatSessionResponseSchema.parse((await requestJson(url)).body);
      session = persisted.session;
      view.rerender(<ChatTab {...props()} />);
      assert.equal(terminalCause, 'completed');
      assert.equal(store.get(sessionId).tokenTurns.size, 0);
      const expectedLabels = groupMessagesIntoTurns(persisted.session.messages, new Set())
        .filter((turn) => turn.messages.some((message) => message.role === 'assistant'))
        .map((turn) => {
          const count = turn.messages.reduce((sum, message) => sum + message.thinkingTokens + message.outputTokensEstimate + message.inputTokensEstimate, 0);
          const estimated = turn.messages.some((message) => message.thinkingTokensEstimated || message.outputTokensEstimated || message.inputTokensEstimated);
          return `${estimated ? '~' : ''}${count.toLocaleString()} run tokens`;
        });
      assert.deepEqual([...view.container.querySelectorAll('.msg.turn > .who .msg-tokens')].map((badge) => badge.textContent), expectedLabels);
    } finally {
      view.unmount();
    }
  });
}

for (const force of [false, true]) {
  test(`a ${force ? 'forced' : 'pending'} HTTP successor starts with its own token metadata`, { timeout: 20000 }, async (t) => {
    const backend = new GatedChatBackend();
    t.after(() => backend.close());
    const server = await DashboardTestServer.start('chat-token-successor-', { baseUrl: await backend.start(), model: 'mock' });
    t.after(() => server.close());
    const created = ChatSessionResponseSchema.parse((await requestJson(`${server.baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title: 'successor' }) })).body);
    const sessionId = created.session.id;
    const url = `${server.baseUrl}/dashboard/chat/sessions/${sessionId}`;
    let store = new ChatSessionRuntimeStore().ensureSession(sessionId, '');
    const stream = toRuntimeTransitions(sessionId, { kind: 'owned', operationKind: 'plan', operationId: OPERATION_ID }, readHttpChat(`${url}/plan/stream`, t.signal, { content: 'original', repoRoot: server.tempRoot, operationId: OPERATION_ID, maxTurns: 3 }), true);
    t.after(async () => { await stream.return(); });
    const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: sessionId, selectedSession: created.session, selectedRuntime: store.get(sessionId) })} />);
    try {
      const prompt = readThrough(stream, store, 'prompt');
      const [firstProvider, initial] = await Promise.all([backend.nextRequest(), prompt]);
      let provider = firstProvider;
      store = initial.store;
      backend.write(provider, { reasoning_content: 'x'.repeat(400) });
      store = (await readThrough(stream, store, 'thinking')).store;
      if (force) {
        backend.write(provider, { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }] });
        backend.finish(provider);
        const secondPrompt = readThrough(stream, store, 'prompt');
        const [secondProvider, next] = await Promise.all([backend.nextRequest(), secondPrompt]);
        provider = secondProvider;
        store = next.store;
        backend.write(provider, { reasoning_content: 'y'.repeat(400) });
        store = (await readThrough(stream, store, 'thinking')).store;
      }
      const queued = await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id: QUEUE_ONE_ID, content: 'successor', images: [], options: { operationKind: 'plan', repoRoot: server.tempRoot } }) });
      assert.equal(queued.statusCode, 200);
      if (force) {
        const stopped = await requestJson(`${url}/queue/force`, { method: 'POST', body: JSON.stringify({ id: '4f9c1f9a-0000-4000-8000-000000000003', operationId: OPERATION_ID }) });
        assert.equal(stopped.statusCode, 200);
      } else {
        backend.write(provider, { content: 'first finished' });
        backend.finish(provider);
      }
      const done = await readThrough(stream, store, 'terminal');
      store = done.store;
      assert.equal(store.get(sessionId).tokenTurns.size, 0);
      assert.equal(done.transition.kind, 'terminal');
      const saved = ChatSessionResponseSchema.parse((await requestJson(url)).body).session;
      assert.equal(saved.messages.find((message) => message.kind === 'assistant_thinking')?.thinkingTokens, 10);
      if (force) {
        if (done.transition.kind !== 'terminal') throw new Error('Expected stop terminal.');
        assert.equal(done.transition.terminal.terminalCause, 'user_stop');
      }
      const successorProvider = await backend.nextRequest();
      const successor = toRuntimeTransitions(sessionId, { kind: 'attached' }, readHttpChat(`${url}/operation/stream`, t.signal), true);
      t.after(async () => { await successor.return(); });
      store = (await readThrough(successor, store, 'prompt')).store;
      assert.equal(store.get(sessionId).tokenTurns.size, 1);
      assert.equal(store.get(sessionId).tokenTurns.get(1)?.usage, null);
      backend.write(successorProvider, { reasoning_content: 'z'.repeat(400) });
      store = (await readThrough(successor, store, 'thinking')).store;
      view.rerender(<ChatTab {...buildProps({ selectedSessionId: sessionId, selectedSession: saved, selectedRuntime: store.get(sessionId) })} />);
      assert.equal([...view.container.querySelectorAll('.assistant_thinking .msg-tokens')].at(-1)?.textContent, '~100 tokens');
      backend.write(successorProvider, { content: 'successor finished' });
      backend.finish(successorProvider);
      store = (await readThrough(successor, store, 'terminal')).store;
      assert.equal(store.get(sessionId).tokenTurns.size, 0);
    } finally {
      view.unmount();
    }
  });
}

const IMAGE = 'data:image/png;base64,AA==';
const IMAGE_META = {
  width: 320,
  height: 200,
  originalWidth: 320,
  originalHeight: 200,
  mime: 'image/png',
  byteLength: 1024,
  tokenEstimate: 64,
  resized: false,
  caption: null,
};

const PRESET = {
  id: 'chat-default', label: 'Chat', description: '', presetKind: 'chat', operationMode: 'full',
  promptPrefix: '', allowedTools: [], surfaces: ['cli', 'web'],
  useForSummary: false, builtin: true, deletable: false, includeAgentsMd: false,
  includeRepoFileListing: false, assistantMemory: false,
  autoloadFiles: [], repoRootRequired: false, maxTurns: null,
} satisfies DashboardPreset;

const REPO_AGENT_PRESET = {
  ...PRESET,
  id: 'repo-agent',
  label: 'Repo Agent',
  presetKind: 'repo-agent',
  operationMode: 'full',
  repoRootRequired: true,
} satisfies DashboardPreset;

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1', role: 'assistant', content: '',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
    createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: null,
    ...overrides,
  };
}

const SESSION_A = {
  id: 'session-a', title: 'Session A', model: 'test-model', contextWindowTokens: 100,
  thinkingEnabled: true, presetId: PRESET.id, mode: 'chat',  createdAtUtc: '2026-04-16T11:00:00.000Z', updatedAtUtc: '2026-04-16T12:00:00.000Z',
  messages: [msg({ id: 'a1', kind: 'assistant_answer', content: 'Hello from the assistant.' })],
} satisfies ChatSession;

const SESSION_B = {
  ...SESSION_A,
  id: 'session-b',
  title: 'Session B',
  messages: [],
} satisfies ChatSession;

const CONTEXT_USAGE = {
  shouldCondense: false, chatUsedTokens: 90, thinkingUsedTokens: 0, toolUsedTokens: 0, imageUsedTokens: 0,
  totalUsedTokens: 90, remainingTokens: 10, warnThresholdTokens: 50, contextWindowTokens: 100,
  usedTokens: 90, estimatedTokenFallbackTokens: 0, providerOverheadTokens: 5,
  effectiveImagePixelCeiling: 1_000_000,
} satisfies ContextUsage;

type ChatTabProps = React.ComponentProps<typeof ChatTab>;

function buildDefaultStore(sessionId: string): ChatSessionRuntimeStore {
  return new ChatSessionRuntimeStore()
    .ensureSession('session-a', '')
    .ensureSession('session-b', '')
    .ensureSession(sessionId, '')
    .apply({ kind: 'draft', sessionId, draft: 'hi' });
}

function buildProps(overrides: Partial<ChatTabProps> = {}): ChatTabProps {
  const selectedSessionId = overrides.selectedSessionId ?? SESSION_A.id;
  const defaultStore = buildDefaultStore(selectedSessionId);
  const props: ChatTabProps = {
    sessions: [SESSION_A, SESSION_B],
    selectedSessionId,
    selectedSession: selectedSessionId === SESSION_B.id ? SESSION_B : SESSION_A,
    selectedRuntime: defaultStore.get(selectedSessionId),
    sessionRuntimes: defaultStore.getAll(),
    sessionPromptCacheStats: { cacheHitRate: 0, promptCacheTokens: 0, promptEvalTokens: 0, acceptanceRate: null, speculativeAcceptedTokens: 0, speculativeGeneratedTokens: 0, promptTokensPerSecond: null, generationTokensPerSecond: null },
    lastTurnTelemetry: { promptTokensPerSecond: null, generationTokensPerSecond: null, ttftMs: null },
    webPresets: [PRESET],
    selectedChatPreset: PRESET,
    chatMode: 'chat',
    isDirectChatMode: true,
    isRepoToolMode: false,
    isThinkingEnabledForCurrentSession: true,
    webSearchEnabled: true,
    showSettings: false,
    onSelectSession: () => {}, onToggleSettings: () => {}, onChangePlanRepoRoot: () => {}, onChangePlanMaxTurns: () => {},
    onChangeDraft: () => {}, onCreateSession: async () => {}, onDeleteSession: async () => {},
    onUpdateSessionPreset: async () => {}, onToggleThinking: async () => {}, onToggleWebSearchEnabled: async () => {},
    onSavePlanRepoRoot: async () => {}, onDeleteMessage: async () => {}, onDeleteTurn: async () => {},
    onDeleteMessageImage: async () => {}, onCondense: async () => {},
    onSendPlan: async () => {}, onSendRepoSearch: async () => {}, onSendMessage: async () => {},
    onSendRepoAgent: async () => {}, onSubmitRepoAgentDecision: async () => {},
    onChangeRepoAgentApprovalMode: async () => {},
    onStopOperation: async () => {},
    onForceQueue: async () => {},
    onLoadQueueMessage: async (id) => ({ message: { id, content: '', revision: 1, imageCount: 0 } }),
    onEditQueueMessage: async () => {}, onRemoveQueueMessage: async () => {},
    onPendingImagesChange: () => {},
    onPendingImagesAppend: () => {},
    onPendingImageError: () => {},
    ...overrides,
  };
  return props;
}

function render(overrides: Partial<ChatTabProps> = {}): string {
  return renderToStaticMarkup(React.createElement(ChatTab, buildProps(overrides)));
}

function toggleDisclosure(element: Element, open: boolean): void {
  if (open) element.setAttribute('open', '');
  else element.removeAttribute('open');
  fireEvent(element, new window.Event('toggle'));
}

function renderExpanded(overrides: Partial<ChatTabProps>): string {
  const view = renderComponent(<ChatTab {...buildProps(overrides)} />);
  for (const element of view.container.querySelectorAll('details')) toggleDisclosure(element, true);
  const html = view.container.innerHTML;
  view.unmount();
  return html;
}

test('repo-agent composer uses the Run Agent label', () => {
  assert.match(render({ chatMode: 'repo-agent', isRepoToolMode: true }), />Run Agent<\/button>/u);
});

test('busy composer stays editable and offers Queue alongside Stop', () => {
  const store = buildDefaultStore('session-a').apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID });
  renderComponent(<ChatTab {...buildProps({ selectedRuntime: store.get('session-a') })} />);
  assert.equal(screen.getByRole('textbox').hasAttribute('disabled'), false);
  assert.ok(screen.getByRole('button', { name: 'Queue', exact: true }));
  assert.ok(screen.getByRole('button', { name: 'Stop', exact: true }));
});

test('closed thinking disclosures mount their body only while expanded', () => {
  const selectedSession = { ...SESSION_A, messages: [msg({ id: 'answer', kind: 'assistant_answer', content: 'answer', thinkingContent: 'HIDDEN_REASONING_SENTINEL' })] };
  const view = renderComponent(<ChatTab {...buildProps({ selectedSession })} />);
  const disclosure = view.container.querySelector('details.thinking-box');
  assert.ok(disclosure);
  assert.equal(view.container.textContent?.includes('HIDDEN_REASONING_SENTINEL'), false);
  toggleDisclosure(disclosure, true);
  assert.equal(view.container.textContent?.includes('HIDDEN_REASONING_SENTINEL'), true);
  toggleDisclosure(disclosure, false);
  assert.equal(view.container.textContent?.includes('HIDDEN_REASONING_SENTINEL'), false);
});

test('repo-agent turns control is visible only in repo-agent mode', () => {
  assert.equal(screen.queryByRole('button', { name: /Turns:/u }), null);
  renderComponent(<ChatTab {...buildProps({ chatMode: 'repo-agent', isRepoToolMode: true })} />);
  assert.ok(screen.getByRole('button', { name: 'Turns: 100' }));
});

test('repo-agent turns control shows the selected preset default', () => {
  const preset = { ...REPO_AGENT_PRESET, maxTurns: 250 } satisfies DashboardPreset;
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    selectedChatPreset: preset,
  })} />);
  assert.ok(screen.getByRole('button', { name: 'Turns: 250' }));
});

test('repo-agent turns control forwards changed values to its session callback', () => {
  const changes: string[] = [];
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    onChangePlanMaxTurns: (value) => { changes.push(value); },
  })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Turns: 100' }));
  fireEvent.change(screen.getByLabelText('Maximum turns'), { target: { value: '1000' } });
  assert.deepEqual(changes, ['1000']);
});

test('invalid repo-agent turns disable Run Agent and Retry', () => {
  let sendCount = 0;
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'plan-inputs', sessionId: SESSION_A.id, planRepoRootInput: '', planMaxTurnsInput: '1k' })
    .apply({ kind: 'control-error', sessionId: SESSION_A.id, message: 'Previous run failed.' });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
    onSendRepoAgent: async () => { sendCount += 1; },
  })} />);
  assert.equal(screen.getByRole('button', { name: 'Run Agent' }).hasAttribute('disabled'), true);
  assert.equal(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled'), true);
  fireEvent.click(screen.getByRole('button', { name: 'Run Agent' }));
  assert.equal(sendCount, 0);
  assert.equal(screen.getByRole('alert').textContent, 'Enter a whole number from 1 to 9007199254740991.');
});

test('busy repo-agent sessions disable turns editing while keeping Stop available', () => {
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'repo-agent', operationId: OPERATION_ID });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  })} />);
  assert.equal(screen.getByRole('button', { name: 'Turns: 100' }).hasAttribute('disabled'), true);
  assert.ok(screen.getByRole('button', { name: 'Stop' }));
});

test('switching sessions closes the turns editor and selects that session value', async () => {
  const storeA = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'plan-inputs', sessionId: SESSION_A.id, planRepoRootInput: '', planMaxTurnsInput: '1000' });
  const storeB = buildDefaultStore(SESSION_B.id)
    .apply({ kind: 'plan-inputs', sessionId: SESSION_B.id, planRepoRootInput: '', planMaxTurnsInput: '2000' });
  const view = renderComponent(<ChatTab {...buildProps({
    selectedSessionId: SESSION_A.id,
    selectedRuntime: storeA.get(SESSION_A.id),
    sessionRuntimes: storeA.getAll(),
    chatMode: 'repo-agent',
    isRepoToolMode: true,
  })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Turns: 1000' }));
  assert.ok(screen.getByLabelText('Maximum turns'));

  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      selectedSessionId: SESSION_B.id,
      selectedRuntime: storeB.get(SESSION_B.id),
      sessionRuntimes: storeB.getAll(),
      chatMode: 'repo-agent',
      isRepoToolMode: true,
    })} />);
  });
  assert.equal(screen.queryByLabelText('Maximum turns'), null);
  assert.ok(screen.getByRole('button', { name: 'Turns: 2000' }));
});

test('the repo folder field shows the seeded server default', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, 'C:/srv/siftkit')
    .apply({ kind: 'draft', sessionId: SESSION_A.id, draft: 'hi' });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  })} />);
  const field = screen.getByPlaceholderText('Repo folder path…');
  assert.equal(field.getAttribute('value'), 'C:/srv/siftkit');
});

test('changing presets warns about context invalidation and updates only after confirmation', async () => {
  const originalConfirm = window.confirm;
  const warnings: string[] = [];
  const updates: string[] = [];
  let confirmed = false;
  window.confirm = (message) => {
    warnings.push(message ?? '');
    return confirmed;
  };
  try {
    renderComponent(<ChatTab {...buildProps({
      webPresets: [PRESET, REPO_AGENT_PRESET],
      onUpdateSessionPreset: async (presetId) => { updates.push(presetId); },
    })} />);
    const selector = screen.getByRole('combobox');

    fireEvent.change(selector, { target: { value: REPO_AGENT_PRESET.id } });
    assert.deepEqual(updates, []);
    assert.deepEqual(warnings, [
      'Switching from “Chat” to “Repo Agent” keeps the conversation history, but invalidates the current model context/prompt cache. Continue?',
    ]);

    confirmed = true;
    await act(async () => { fireEvent.change(selector, { target: { value: REPO_AGENT_PRESET.id } }); });
    assert.deepEqual(updates, [REPO_AGENT_PRESET.id]);
  } finally {
    window.confirm = originalConfirm;
  }
});

test('changing only preset metadata does not claim the model context is invalidated', async () => {
  const originalConfirm = window.confirm;
  const updates: string[] = [];
  let warningCount = 0;
  window.confirm = () => {
    warningCount += 1;
    return false;
  };
  const equivalentPreset = {
    ...PRESET,
    id: 'chat-renamed',
    label: 'Renamed Chat',
    description: 'Presentation-only changes.',
  } satisfies DashboardPreset;
  try {
    renderComponent(<ChatTab {...buildProps({
      webPresets: [PRESET, equivalentPreset],
      onUpdateSessionPreset: async (presetId) => { updates.push(presetId); },
    })} />);

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: equivalentPreset.id } });
    });

    assert.equal(warningCount, 0);
    assert.deepEqual(updates, [equivalentPreset.id]);
  } finally {
    window.confirm = originalConfirm;
  }
});

test('repo-agent pending approval renders actions and reject requires a reason', async () => {
  const decisions: Array<{ decision: string; reason?: string }> = [];
  const approval = DurableChatApprovalSchema.parse({
    runId: '4f9c1f9a-0000-4000-8000-000000000000',
    approvalId: '4f9c1f9a-0000-4000-8000-000000000001',
    toolName: 'bash',
    command: 'npm test',
    reviewPayload: 'Run focused tests first.',
    toolCallId: 'native-call', mode: 'interactive', requestedAtUtc: new Date().toISOString(),
    expiresAtUtc: new Date(Date.now() + 600_000).toISOString(), outcome: null, decidedAtUtc: null, actionable: true,
  });
  const store = buildDefaultStore(SESSION_A.id).apply({ kind: 'snapshot', sessionId: SESSION_A.id,
    snapshot: chatSnapshot({ sessionId: SESSION_A.id, approval }) });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
    onSubmitRepoAgentDecision: async (decision) => { decisions.push(decision); },
  })} />);
  assert.equal(screen.getByText('npm test').textContent, 'npm test');
  assert.equal(screen.getByRole('button', { name: 'Queue' }).hasAttribute('disabled'), false);
  assert.ok(screen.getByRole('button', { name: 'Stop' }));
  assert.ok(screen.getByRole('button', { name: 'Approve' }));
  assert.ok(screen.getByRole('button', { name: 'Abort' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reject…' }));
  const submit = screen.getByRole('button', { name: 'Submit rejection' });
  assert.equal(submit.hasAttribute('disabled'), true);
  fireEvent.change(screen.getByLabelText('Rejection reason'), { target: { value: 'wrong file' } });
  assert.equal(submit.hasAttribute('disabled'), false);
  await act(async () => { fireEvent.click(submit); });
  assert.deepEqual(decisions, [{ decision: 'deny', reason: 'wrong file' }]);
});

function configureChatScroll(element: HTMLElement): { setScrollHeight(value: number): void } {
  let scrollHeight = 1_000;
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  return { setScrollHeight: (value) => { scrollHeight = value; } };
}

test('streaming follows only while the user is pinned to the bottom', async () => {
  const streamed = (base: ChatSessionRuntimeStore, text: string): ChatSessionRuntimeStore =>
    applyLiveTranscript(base, SESSION_A.id, [{ kind: 'answer', delta: { turn: 1, offset: 0, text } }]);
  const initialStore = streamed(buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'repo-agent', operationId: OPERATION_ID }), 'first');
  const view = renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    selectedRuntime: initialStore.get(SESSION_A.id),
    sessionRuntimes: initialStore.getAll(),
  })} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);

  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);
  const secondStore = streamed(initialStore, 'first update');
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: secondStore.get(SESSION_A.id),
      sessionRuntimes: secondStore.getAll(),
    })} />);
  });

  assert.equal(chatLog.scrollTop, 200);
  chatLog.scrollTop = 800;
  fireEvent.scroll(chatLog);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);
  scroll.setScrollHeight(1_200);
  const thirdStore = streamed(secondStore, 'first update again');
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: thirdStore.get(SESSION_A.id),
      sessionRuntimes: thirdStore.getAll(),
    })} />);
  });
  assert.equal(chatLog.scrollTop, 1_200);

  chatLog.scrollTop = 700;
  fireEvent.scroll(chatLog);
  const jump = screen.getByRole('button', { name: 'Jump to bottom' });
  fireEvent.click(jump);
  assert.equal(chatLog.scrollTop, 1_200);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);

  scroll.setScrollHeight(1_400);
  const fourthStore = streamed(thirdStore, 'first update again final');
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: fourthStore.get(SESSION_A.id),
      sessionRuntimes: fourthStore.getAll(),
    })} />);
  });
  assert.equal(chatLog.scrollTop, 1_400);
});

test('switching sessions resets pinned scrolling and hides the jump control', async () => {
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: SESSION_A.id })} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  configureChatScroll(chatLog);
  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);
  assert.ok(screen.getByRole('button', { name: 'Jump to bottom' }));

  await act(async () => {
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: SESSION_B.id })} />);
  });

  assert.equal(chatLog.scrollTop, 1_000);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);
});

test('each distinct repo-agent approval forces one scroll to the bottom', async () => {
  const approval = DurableChatApprovalSchema.parse({
    runId: OPERATION_ID,
    approvalId: '4f9c1f9a-0000-4000-8000-000000000010',
    toolName: 'bash',
    command: 'npm test',
    reviewPayload: null,
    toolCallId: 'native-call', mode: 'interactive', requestedAtUtc: '2026-09-08T12:00:00.000Z',
    expiresAtUtc: '2026-09-08T12:10:00.000Z', outcome: null, decidedAtUtc: null, actionable: true,
  });
  const baseStore = buildDefaultStore(SESSION_A.id);
  const view = renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    selectedRuntime: baseStore.get(SESSION_A.id),
    sessionRuntimes: baseStore.getAll(),
  })} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);

  const firstApprovalStore = applyLiveTranscript(baseStore, SESSION_A.id, [], { approval });
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: firstApprovalStore.get(SESSION_A.id),
      sessionRuntimes: firstApprovalStore.getAll(),
    })} />);
  });
  assert.equal(chatLog.scrollTop, 1_000);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);

  scroll.setScrollHeight(1_200);
  const streamedApprovalStore = applyLiveTranscript(firstApprovalStore, SESSION_A.id,
    [{ kind: 'answer', delta: { turn: 1, offset: 0, text: 'working' } }], { approval });
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: streamedApprovalStore.get(SESSION_A.id),
      sessionRuntimes: streamedApprovalStore.getAll(),
    })} />);
  });
  assert.equal(chatLog.scrollTop, 1_200);

  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: streamedApprovalStore.get(SESSION_A.id),
      sessionRuntimes: streamedApprovalStore.getAll(),
    })} />);
  });
  assert.equal(chatLog.scrollTop, 200);

  const clearedStore = streamedApprovalStore.apply({ kind: 'approval-clear', sessionId: SESSION_A.id });
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: clearedStore.get(SESSION_A.id),
      sessionRuntimes: clearedStore.getAll(),
    })} />);
  });
  assert.equal(chatLog.scrollTop, 200);

  const secondApprovalStore = applyLiveTranscript(clearedStore, SESSION_A.id,
    [{ kind: 'answer', delta: { turn: 1, offset: 0, text: 'working' } }],
    { approval: { ...approval, approvalId: '4f9c1f9a-0000-4000-8000-000000000011' } });
  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      chatMode: 'repo-agent',
      isRepoToolMode: true,
      selectedRuntime: secondApprovalStore.get(SESSION_A.id),
      sessionRuntimes: secondApprovalStore.getAll(),
    })} />);
  });
  assert.equal(chatLog.scrollTop, 1_200);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);
});

test('persisted repo-agent approvals render compact audit rows', () => {
  const store = buildDefaultStore(SESSION_A.id);
  const persistedSession: ChatSession = {
    ...SESSION_A,
    messages: [{
      id: 'approval-row', role: 'user', kind: 'repo_agent_approval', content: 'approve bash: npm test',
      inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
      createdAtUtc: '2026-07-19T00:00:00Z', sourceRunId: OPERATION_ID,
      approvalDecision: 'approve', approvalToolName: 'bash', approvalCommand: 'npm test', approvalReason: null,
    }, {
      id: 'denied-row', role: 'user', kind: 'repo_agent_approval', content: 'deny bash: npm test',
      inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 0,
      createdAtUtc: '2026-07-19T00:00:01Z', sourceRunId: OPERATION_ID,
      approvalDecision: 'deny', approvalToolName: 'bash', approvalCommand: 'npm test', approvalReason: 'wrong file',
    }],
  };
  const markup = render({
    selectedSession: persistedSession,
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  });
  assert.match(markup, /✓ Approved/u);
  assert.match(markup, /✕ Rejected/u);
  assert.match(markup, />User</u);
  assert.doesNotMatch(markup, />You</u);
  assert.match(markup, /wrong file/u);
  assert.doesNotMatch(markup, /class="approval-card"/u);
});

test('a locally active operation offers Queue and an enabled Stop button', async () => {
  let stops = 0;
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'repo-agent', operationId: OPERATION_ID });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
    onStopOperation: async () => { stops += 1; },
  })} />);
  const stop = screen.getByRole('button', { name: 'Stop' });
  assert.equal(stop.hasAttribute('disabled'), false);
  assert.match(stop.className, /stop/u);
  await act(async () => { fireEvent.click(stop); });
  assert.equal(stops, 1);
  assert.equal(screen.getByRole('textbox').hasAttribute('disabled'), false);
});

test('an operation owned by another client allows Queue before attachment supplies its Stop identity', () => {
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'remote-begin',
    sessionId: SESSION_A.id,
    operationKind: 'repo-agent',
  });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  })} />);
  assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);
  assert.equal(screen.getByRole('button', { name: 'Queue' }).hasAttribute('disabled'), false);
});

function installImageReadControls(): {
  complete(index: number, dataUrl: string): void;
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const originalFileReader = globalThis.FileReader;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const completions: Array<(dataUrl: string) => void> = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
  });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ width: 1, height: 1, close: () => undefined }),
  });
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        completions.push((dataUrl) => {
          this.result = dataUrl;
          this.onload?.();
        });
      }
    },
  });
  return {
    complete(index, dataUrl) {
      const complete = completions[index];
      if (!complete) throw new Error(`missing image-read completion ${index}`);
      complete(dataUrl);
    },
    restore() {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
      Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader });
      Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: originalCreateImageBitmap });
    },
  };
}

test('attachment read failures are reported to the owning session', async () => {
  const originalFileReader = globalThis.FileReader;
  const errors: Array<{ sessionId: string; message: string }> = [];
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        this.onerror?.();
      }
    },
  });
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'context-usage',
    sessionId: SESSION_A.id,
    contextUsage: CONTEXT_USAGE,
  });

  try {
    renderComponent(<ChatTab {...buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImageError: (sessionId, message) => errors.push({ sessionId, message }),
    })} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Attach'), {
        target: { files: [new File([new Uint8Array([1])], 'broken.png', { type: 'image/png' })] },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(errors, [{ sessionId: SESSION_A.id, message: 'cannot read broken.png' }]);
  } finally {
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: originalFileReader });
  }
});

test('overlapping attachment reads append in selection order', async () => {
  const controls = installImageReadControls();
  const appended: Array<{ sessionId: string; images: string[] }> = [];
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'context-usage',
    sessionId: SESSION_A.id,
    contextUsage: CONTEXT_USAGE,
  });
  try {
    renderComponent(<ChatTab {...buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImagesAppend: (sessionId, images) => appended.push({
        sessionId,
        images: images.map((image) => image.dataUrl),
      }),
    })} />);
    const input = screen.getByLabelText('Attach');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'first.png')] } });
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([2])], 'second.png')] } });

    await act(async () => {
      controls.complete(1, 'data:image/png;base64,AQ==');
      await Promise.resolve();
    });
    assert.deepEqual(appended, []);

    await act(async () => {
      controls.complete(0, 'data:image/png;base64,AA==');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(appended, [
      { sessionId: SESSION_A.id, images: ['data:image/png;base64,AA=='] },
      { sessionId: SESSION_A.id, images: ['data:image/png;base64,AQ=='] },
    ]);
  } finally {
    controls.restore();
  }
});

test('switching sessions discards an unresolved attachment batch', async () => {
  const controls = installImageReadControls();
  const appended: string[] = [];
  const store = buildDefaultStore(SESSION_A.id).apply({
    kind: 'context-usage',
    sessionId: SESSION_A.id,
    contextUsage: CONTEXT_USAGE,
  });
  try {
    const rendered = renderComponent(<ChatTab {...buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImagesAppend: (sessionId) => appended.push(sessionId),
    })} />);
    fireEvent.change(screen.getByLabelText('Attach'), {
      target: { files: [new File([new Uint8Array([1])], 'first.png')] },
    });
    const sessionBStore = buildDefaultStore(SESSION_B.id).apply({
      kind: 'context-usage',
      sessionId: SESSION_B.id,
      contextUsage: CONTEXT_USAGE,
    });
    await act(async () => {
      rendered.rerender(<ChatTab {...buildProps({
        selectedSessionId: SESSION_B.id,
        selectedSession: SESSION_B,
        selectedRuntime: sessionBStore.get(SESSION_B.id),
        sessionRuntimes: sessionBStore.getAll(),
        onPendingImagesAppend: (sessionId) => appended.push(sessionId),
      })} />);
      await Promise.resolve();
    });
    await act(async () => {
      controls.complete(0, 'data:image/png;base64,AA==');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual(appended, []);
  } finally {
    controls.restore();
  }
});

test('chat tab renders session lane, controls, messages, and composer', () => {
  const markup = render();
  assert.match(markup, /class="chat-lane"/);
  assert.match(markup, /New session/);
  assert.match(markup, /class="chat-head"/);
  assert.match(markup, /class="hchip on"[^>]*>web search/);
  assert.match(markup, /class="hchip on"[^>]*>per-step thinking/);
  assert.match(markup, /class="msgs"/);
  assert.match(markup, /class="composer"/);
});

test('busy A stays visible while selected B remains interactive', () => {
  const store = buildDefaultStore('session-b').apply({
    kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID,
  });
  const markup = render({
    selectedSessionId: 'session-b',
    selectedSession: SESSION_B,
    selectedRuntime: store.get('session-b'),
    sessionRuntimes: store.getAll(),
  });
  assert.match(markup, /Session A[\s\S]*streaming/u);
  assert.doesNotMatch(markup, /class="send"[^>]*disabled/u);
  assert.doesNotMatch(markup, /class="ghost-btn acc new"[^>]*disabled/u);
  assert.doesNotMatch(markup, /class="ghost-btn"[^>]*disabled[^>]*>Delete/u);
});

test('selected busy A disables mutable controls except Stop', () => {
  const store = buildDefaultStore('session-a').apply({
    kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID,
  });
  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });
  assert.match(markup, /class="send stop"[^>]*>Stop/u);
  assert.match(markup, /class="ghost-btn"[^>]*disabled[^>]*>Delete/u);
  assert.doesNotMatch(markup, /class="ghost-btn acc new"[^>]*disabled/u);
});

test('selected session alone supplies errors and warnings', () => {
  const store = buildDefaultStore('session-b')
    .apply({ kind: 'snapshot', sessionId: 'session-a', snapshot: chatSnapshot({ sessionId: 'session-a', warnings: ['warning-a'] }) })
    .apply({ kind: 'failure', sessionId: 'session-a', message: 'error-a' });
  const selectedB = render({
    selectedSessionId: 'session-b',
    selectedSession: SESSION_B,
    selectedRuntime: store.get('session-b'),
    sessionRuntimes: store.getAll(),
  });
  assert.doesNotMatch(selectedB, /warning-a|error-a/u);
  const selectedA = render({
    selectedRuntime: store.get('session-a'),
    sessionRuntimes: store.getAll(),
  });
  assert.match(selectedA, /warning-a/u);
  assert.match(selectedA, /error-a/u);
});

test('switching away from queued work keeps token badges and queue state in their owning session', () => {
  const queue = ChatMessageQueueResponseSchema.parse({ queue: {
    sessionId: SESSION_A.id, revision: 1, paused: false, force: null, activeOperationId: OPERATION_ID,
    messages: [{ id: QUEUE_ONE_ID, position: 0, preview: 'queued for A', contentChars: 12, imageCount: 0, revision: 1, state: 'pending', createdAtUtc: '2026-09-10T00:00:00.000Z' }],
  } }).queue;
  const steps: LiveTranscriptStep[] = [
    { kind: 'prompt', prompt: { turn: 1, maxTurns: 20, promptTokens: 10, charsPerToken: 4 } },
    { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'A'.repeat(400) } },
  ];
  let store = applyLiveTranscript(buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message', operationId: OPERATION_ID })
    .apply({ kind: 'queue', sessionId: SESSION_A.id, queue }), SESSION_A.id, steps, { operationKind: 'message' });
  const view = renderComponent(<ChatTab {...buildProps({ selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll() })} />);
  try {
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, '~100 tokens');
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: SESSION_B.id, selectedRuntime: store.get(SESSION_B.id), sessionRuntimes: store.getAll() })} />);
    assert.equal(view.container.querySelector('.assistant_thinking'), null);
    assert.doesNotMatch(view.container.textContent ?? '', /queued for A/u);
    store = applyLiveTranscript(store, SESSION_A.id, [...steps, { kind: 'thinking', delta: { turn: 1, offset: 400, text: 'A'.repeat(400) } }], { operationKind: 'message' });
    view.rerender(<ChatTab {...buildProps({ selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll() })} />);
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, '~200 tokens');
    assert.equal(store.get(SESSION_A.id).queue, queue);
    assert.equal(store.get(SESSION_B.id).tokenTurns.size, 0);
    assert.equal(store.get(SESSION_B.id).queue, null);
  } finally { view.unmount(); }
});

test('a running tool message renders a neutral friendly activity row', () => {
  const store = applyLiveTranscript(buildDefaultStore('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID }), 'session-a', [{ kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2,
      activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg x', promptTokenCount: 0,
    } }], { operationKind: 'message' });
  const markup = render({ selectedRuntime: store.get('session-a'), sessionRuntimes: store.getAll() });
  const recentActivity = /<section class="recent-activity"[\s\S]*?<\/section>/u.exec(markup)?.[0] ?? '';
  assert.match(markup, /tool-activity-row tool-activity-neutral/u);
  assert.doesNotMatch(recentActivity, /class="sp"/u);
  assert.match(markup, /Searching code…/u);
  assert.doesNotMatch(markup, /rg x/u);
});

test('live recent activity renders only the newest three tools with latest turn progress', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_RING' },
    ['t1', 't2', 't3', 't4'].map((toolCallId, index): LiveTranscriptStep => ({
      kind: 'tool',
      tool: index === 3
        ? {
            kind: 'tool_start', toolCallId, turn: index + 1, maxTurns: 45,
            activityKind: 'search', activitySubject: { kind: 'none' }, command: `rg marker-${index}`, promptTokenCount: 0,
          }
        : {
            kind: 'tool_result', toolCallId, turn: index + 1, maxTurns: 45,
            activityKind: 'search', activitySubject: { kind: 'none' }, command: `rg marker-${index}`, promptTokenCount: 0,
            exitCode: 0, outputSnippet: `result-${index}`, outputTokens: 0, outputTokensEstimated: false,
          },
    })));
  const markup = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.match(markup, /Recent activity/u);
  assert.match(markup, />4\/45</u);
  assert.equal(markup.match(/class="tool-activity-row tool-activity-neutral"/gu)?.length, 3);
  assert.doesNotMatch(markup, /rg marker-/u);
  assert.doesNotMatch(markup, /assistant tool/u, 'recent activity must use compact rows, not nested message bubbles');
});

test('selected context usage renders the warning context bar', () => {
  const responseStore = buildDefaultStore('session-a').apply({ kind: 'context-usage', sessionId: 'session-a', contextUsage: CONTEXT_USAGE });
  const markup = render({ selectedRuntime: responseStore.get('session-a'), sessionRuntimes: responseStore.getAll() });
  assert.match(markup, /class="ctx warn"/);
});

test('chat does not render first-message context toggles', () => {
  const emptySession = { ...SESSION_A, mode: 'repo-search', messages: [] } satisfies ChatSession;
  const markup = render({ selectedSession: emptySession, chatMode: 'repo-search', isDirectChatMode: false, isRepoToolMode: true });
  assert.doesNotMatch(markup, /Repo-search auto-append controls|File scan/u);
});

test('pasting an image attaches it and a text paste is left alone', async () => {
  const controls = installImageReadControls();
  const appended: string[] = [];
  try {
    const store = new ChatSessionRuntimeStore()
      .ensureSession(SESSION_A.id, '')
      .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: CONTEXT_USAGE });
    renderComponent(React.createElement(ChatTab, buildProps({
      selectedRuntime: store.get(SESSION_A.id),
      sessionRuntimes: store.getAll(),
      onPendingImagesAppend: (_sessionId, images) => {
        appended.push(...images.map((image) => image.dataUrl));
      },
    })));
    const textarea = screen.getByPlaceholderText('Message SiftKit…');

    const imagePaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(imagePaste, 'clipboardData', {
      value: {
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => new File([new Uint8Array([1])], 'p.png', { type: 'image/png' }),
        }],
      },
    });
    await act(async () => { textarea.dispatchEvent(imagePaste); });
    assert.equal(imagePaste.defaultPrevented, true);
    await act(async () => { controls.complete(0, IMAGE); });
    assert.deepEqual(appended, [IMAGE]);

    const textPaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    });
    await act(async () => { textarea.dispatchEvent(textPaste); });
    assert.equal(textPaste.defaultPrevented, false);
  } finally {
    controls.restore();
  }
});

test('composer attaches images through a styled label wrapping the file input', () => {
  const markup = render();
  assert.match(markup, /<label class="mini-btn attach"[^>]*>Attach<input type="file"/u);
});

test('renders user and tool-image attachments inline', () => {
  const session = {
    ...SESSION_A,
    messages: [
      msg({ id: 'user-image', role: 'user', kind: 'user_text', content: 'Look at this', images: [IMAGE], imageMeta: [IMAGE_META] }),
      msg({ id: 'tool-image', role: 'assistant', kind: 'tool_image', content: 'read output', images: [IMAGE], imageMeta: [IMAGE_META] }),
    ],
  } satisfies ChatSession;
  const markup = render({ selectedSession: session, selectedSessionId: session.id });

  assert.equal((markup.match(/class="message-images"/gu) ?? []).length, 2);
  assert.equal((markup.match(/<img\b/gu) ?? []).length, 2);
});

test('a submitted message renders as a pending bubble instead of staying in the composer', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, '')
    .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: CONTEXT_USAGE })
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message', operationId: OPERATION_ID })
    .apply({ kind: 'submit', sessionId: SESSION_A.id, content: 'describe this', images: [{ dataUrl: IMAGE, note: null }] });
  const markup = render({
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  });

  assert.match(markup, /class="msg user user_text live pending"/u);
  assert.match(markup, /sending…/u);
  assert.match(markup, /describe this/u);
  assert.match(markup, /Recent activity/u, 'the activity shell starts with the request, before model output');
});

test('the pending bubble survives a control error that arrives before the stream', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, '')
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message', operationId: OPERATION_ID })
    .apply({ kind: 'submit', sessionId: SESSION_A.id, content: 'describe this', images: [] })
    .apply({ kind: 'control-error', sessionId: SESSION_A.id, message: 'repo root is dirty' });
  const markup = render({
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  });

  assert.match(markup, /sending…/u);
  assert.match(markup, /repo root is dirty/u);
});

test('the pending bubble clears once the assistant starts streaming', () => {
  const pending = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, '')
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message', operationId: OPERATION_ID })
    .apply({ kind: 'submit', sessionId: SESSION_A.id, content: 'describe this', images: [] });
  const store = applyLiveTranscript(pending, SESSION_A.id, [{ kind: 'answer', delta: { turn: 1, offset: 0, text: 'here it is' } }], { operationKind: 'message' });
  const markup = render({
    selectedRuntime: store.get(SESSION_A.id),
    sessionRuntimes: store.getAll(),
  });

  assert.doesNotMatch(markup, /sending…/u);
});

test('a bubble token chip separates text tokens from image tokens', () => {
  const session = {
    ...SESSION_A,
    messages: [msg({
      id: 'u1',
      role: 'user',
      kind: 'user_text',
      content: 'look',
      inputTokensEstimate: 12,
      inputTokensEstimated: false,
      images: [IMAGE],
      imageMeta: [{ ...IMAGE_META, tokenEstimate: 1024 }],
    })],
  };
  const markup = render({ selectedSession: session });

  assert.match(markup, /12 tokens \(\+1,024 img\)/u);
});

test('an image-only bubble surfaces its known image token count', () => {
  const session = {
    ...SESSION_A,
    messages: [msg({
      id: 'u1',
      role: 'user',
      kind: 'user_text',
      content: '',
      inputTokensEstimate: 0,
      inputTokensEstimated: false,
      images: [IMAGE],
      imageMeta: [{ ...IMAGE_META, tokenEstimate: 2048 }],
    })],
  };

  const markup = render({ selectedSession: session });

  assert.match(markup, /2,048 image tokens/u);
  assert.doesNotMatch(markup, /tokens unavailable/u);
});

const COMPACTED_SESSION = {
  ...SESSION_A,
  id: 'session-compacted',
  messages: [
    msg({ id: 'c1', role: 'user', kind: 'user_text', content: 'old question', compressedIntoSummary: true }),
    msg({ id: 'c2', kind: 'assistant_answer', content: 'old answer', compressedIntoSummary: true }),
    msg({ id: 'c3', kind: 'compaction_summary', content: 'SUMMARY OF THE OLD EXCHANGE' }),
    msg({ id: 'c4', role: 'user', kind: 'user_text', content: 'new question' }),
    msg({ id: 'c5', kind: 'assistant_answer', content: 'new answer' }),
  ],
} satisfies ChatSession;

const TWICE_COMPACTED_SESSION = {
  ...COMPACTED_SESSION,
  id: 'session-twice-compacted',
  messages: [
    msg({ id: 'o1', role: 'user', kind: 'user_text', content: 'original question', compressedIntoSummary: true }),
    msg({ id: 'o2', kind: 'assistant_answer', content: 'original answer', compressedIntoSummary: true }),
    msg({ id: 's1', kind: 'compaction_summary', content: 'FIRST SUMMARY', compressedIntoSummary: true }),
    msg({ id: 'm1', role: 'user', kind: 'user_text', content: 'middle question', compressedIntoSummary: true }),
    msg({ id: 'm2', kind: 'assistant_answer', content: 'middle answer', compressedIntoSummary: true }),
    msg({ id: 's2', kind: 'compaction_summary', content: 'LATEST SUMMARY' }),
    msg({ id: 'n1', role: 'user', kind: 'user_text', content: 'live question' }),
    msg({ id: 'n2', kind: 'assistant_answer', content: 'live answer' }),
  ],
} satisfies ChatSession;

test('a compacted session renders the divider, the collapsed originals and the summary card', () => {
  const markup = render({
    sessions: [COMPACTED_SESSION],
    selectedSessionId: COMPACTED_SESSION.id,
    selectedSession: COMPACTED_SESSION,
  });

  assert.match(markup, /Context compacted \(2 messages summarized\)/u);
  assert.doesNotMatch(markup, /compaction-originals/u);
  assert.match(markup, /Compacted summary/u);
  assert.match(markup, /SUMMARY OF THE OLD EXCHANGE/u);
  assert.doesNotMatch(markup, /old answer/u);
  assert.match(renderExpanded({ selectedSessionId: COMPACTED_SESSION.id, selectedSession: COMPACTED_SESSION }), /old answer/u);
  assert.match(markup, /new answer/u);
});

test('repeated compaction renders one closed fold, the latest summary, then live messages', () => {
  const markup = render({
    sessions: [TWICE_COMPACTED_SESSION],
    selectedSessionId: TWICE_COMPACTED_SESSION.id,
    selectedSession: TWICE_COMPACTED_SESSION,
  });
  const foldStart = markup.indexOf('<details class="compaction-history">');
  const foldEnd = markup.indexOf('</details>', foldStart);
  const foldedMarkup = markup.slice(foldStart, foldEnd);
  const latestSummaryIndex = markup.indexOf('LATEST SUMMARY');
  const liveQuestionIndex = markup.indexOf('live question');
  const liveAnswerIndex = markup.indexOf('live answer');

  assert.ok(foldStart >= 0);
  assert.ok(foldEnd > foldStart);
  assert.equal((markup.match(/<details class="compaction-history">/gu) ?? []).length, 1);
  assert.equal((foldedMarkup.match(/<article class="msg/gu) ?? []).length, 0);
  assert.match(renderExpanded({ selectedSessionId: TWICE_COMPACTED_SESSION.id, selectedSession: TWICE_COMPACTED_SESSION }), /FIRST SUMMARY/u);
  assert.ok(latestSummaryIndex > foldEnd);
  assert.ok(liveQuestionIndex > latestSummaryIndex);
  assert.ok(liveAnswerIndex > liveQuestionIndex);
});

test('a real compacting stream persists and immediately renders one boundary', async () => {
  const server = await DashboardTestServer.start('siftkit-chat-compaction-ui-e2e-');
  try {
    const config = getDefaultConfig();
    const preset = getActiveModelPreset(config);
    preset.Model = 'mock';
    preset.NumCtx = 9_000;
    // Compaction reserves two thirds of generation for reasoning and guarantees
    // a 512-token summary-output floor, so the fixture needs the full 3x budget.
    writeConfig(getRuntimeDatabasePath(), config);

    const created = ChatSessionResponseSchema.parse((await requestJson(
      `${server.baseUrl}/dashboard/chat/sessions`,
      { method: 'POST', body: JSON.stringify({ title: 'Compaction E2E' }) },
    )).body);
    const seededMessages = [
      msg({
        id: 'prior-user',
        role: 'user',
        kind: 'user_text',
        content: `prior completed question ${'X'.repeat(24_000)}`,
      }),
      msg({
        id: 'prior-answer',
        role: 'assistant',
        kind: 'assistant_answer',
        content: 'prior completed answer',
      }),
    ];
    saveChatSession(getRuntimeRoot(), {
      ...created.session,
      modelPreset: preset,
      messages: seededMessages,
    });

    const triggerQuestion = `trigger question ${'Q'.repeat(12_000)}`;
    const stream = await requestSse(
      `${server.baseUrl}/dashboard/chat/sessions/${encodeURIComponent(created.session.id)}/messages/stream`,
      {
        method: 'POST',
        timeoutMs: 10_000,
        body: JSON.stringify({
          content: triggerQuestion,
          operationId: OPERATION_ID,
          webSearchOverride: 'off',
          maxTurns: 1,
          availableModels: ['mock'],
          mockResponses: [
            { content: 'COMPLETE COMPACTION SUMMARY' },
            { content: '{"action":"finish","output":"fresh answer"}' },
          ],
        }),
      },
    );
    assert.equal(stream.statusCode, 200);
    const lastFrame = stream.events.at(-1)?.payload?.['data'];
    assert.ok(typeof lastFrame === 'string' && lastFrame.includes('"kind":"terminal"'), JSON.stringify(stream.events.at(-1)));
    const terminal = ChatSessionResponseSchema.parse((await requestJson(
      `${server.baseUrl}/dashboard/chat/sessions/${encodeURIComponent(created.session.id)}`,
    )).body);
    const activeSummaries = terminal.session.messages.filter(
      (message) => message.kind === 'compaction_summary' && message.compressedIntoSummary !== true,
    );
    assert.equal(activeSummaries.length, 1);
    const summaryIndex = terminal.session.messages.findIndex((message) => message.id === activeSummaries[0]?.id);
    assert.ok(summaryIndex > 0);
    assert.equal(
      terminal.session.messages.slice(0, summaryIndex).every((message) => message.compressedIntoSummary === true),
      true,
    );
    assert.equal(terminal.contextUsage.shouldCondense, false);
    assert.ok(terminal.contextUsage.remainingTokens > terminal.contextUsage.warnThresholdTokens);

    const responseStore = new ChatSessionRuntimeStore()
      .ensureSession(terminal.session.id, '')
      .apply({ kind: 'context-usage', sessionId: terminal.session.id, contextUsage: terminal.contextUsage });
    const markup = render({
      sessions: [terminal.session],
      selectedSessionId: terminal.session.id,
      selectedSession: terminal.session,
      selectedRuntime: responseStore.get(terminal.session.id),
      sessionRuntimes: responseStore.getAll(),
    });
    const foldStart = markup.indexOf('<details class="compaction-history">');
    const foldEnd = markup.indexOf('</details>', foldStart);
    const visibleSummaryIndex = markup.indexOf('COMPLETE COMPACTION SUMMARY');
    const triggerIndex = markup.indexOf('trigger question');
    const answerIndex = markup.indexOf('fresh answer');
    assert.ok(foldStart >= 0);
    assert.ok(foldEnd > foldStart);
    assert.equal((markup.match(/<details class="compaction-history">/gu) ?? []).length, 1);
    assert.ok(visibleSummaryIndex > foldEnd);
    assert.ok(triggerIndex > visibleSummaryIndex);
    assert.ok(answerIndex > triggerIndex);
  } finally {
    await server.close();
  }
});

test('a flagged message after the summary row stays in compacted history', () => {
  // The boundary is the persisted flag, not row order: the model replays exactly the
  // rows that are not flagged, and the transcript has to show the same split.
  const session = {
    ...COMPACTED_SESSION,
    id: 'session-compacted-out-of-order',
    messages: [
      ...COMPACTED_SESSION.messages,
      msg({ id: 'c6', kind: 'assistant_answer', content: 'stale flagged answer', compressedIntoSummary: true }),
    ],
  } satisfies ChatSession;

  const markup = render({ sessions: [session], selectedSessionId: session.id, selectedSession: session });

  assert.match(markup, /Context compacted \(3 messages summarized\)/u);
  assert.doesNotMatch(markup, /stale flagged answer/u);
  assert.match(renderExpanded({ selectedSessionId: session.id, selectedSession: session }), /compaction-originals[\s\S]*stale flagged answer/u);
});

test('flagged messages stay hidden from the live conversation when the summary row is gone', () => {
  // Nothing may replay a flagged row as live conversation just because no summary row
  // survived next to it — the flag alone decides.
  const session = {
    ...SESSION_A,
    id: 'session-flags-without-summary',
    messages: [
      msg({ id: 'f1', role: 'user', kind: 'user_text', content: 'orphaned question', compressedIntoSummary: true }),
      msg({ id: 'f2', kind: 'assistant_answer', content: 'orphaned answer', compressedIntoSummary: true }),
      msg({ id: 'f3', kind: 'assistant_answer', content: 'live answer' }),
    ],
  } satisfies ChatSession;

  const markup = render({ sessions: [session], selectedSessionId: session.id, selectedSession: session });

  assert.match(markup, /live answer/u);
  assert.doesNotMatch(markup, /orphaned answer/u);
  assert.match(renderExpanded({ selectedSessionId: session.id, selectedSession: session }), /compaction-originals[\s\S]*orphaned answer/u);
  assert.doesNotMatch(markup, /Compacted summary/u);
});

test('a session with no compaction renders no divider', () => {
  const markup = render();

  assert.doesNotMatch(markup, /Context compacted/u);
  assert.doesNotMatch(markup, /Compacted summary/u);
});

test('the condensed summary panel is gone', () => {
  const markup = render();

  assert.doesNotMatch(markup, /Condensed Summary/u);
});

/** A submitted run whose journal has streamed `marker` as thinking, then `steps`. */
function buildThinkingStore(options: {
  content: string;
  images: PendingImage[];
  operationKind: ChatSessionOperationKind;
  marker: string;
}, steps: readonly LiveTranscriptStep[] = []): ChatSessionRuntimeStore {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_B.id, '')
    .apply({ kind: 'submit', sessionId: SESSION_B.id, content: options.content, images: options.images })
    .apply({
      kind: 'begin', sessionId: SESSION_B.id, operationKind: options.operationKind, operationId: OPERATION_ID,
    });
  return applyLiveTranscript(store, SESSION_B.id, [
    { kind: 'submission', message: { id: 'submitted', content: options.content, images: options.images.map((image) => image.dataUrl), imageMeta: [] } },
    { kind: 'thinking', delta: { turn: 1, offset: 0, text: options.marker } }, ...steps,
  ], { operationKind: options.operationKind });
}

test('a live turn that has only streamed thinking renders the thinking text', () => {
  const store = buildThinkingStore({
    content: '',
    images: [{ dataUrl: IMAGE, note: null }],
    operationKind: 'message',
    marker: 'THINK_MARKER_ONE',
  });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('THINK_MARKER_ONE'), 'streamed thinking must be in the DOM before the answer arrives');
});

test('a live turn that has only streamed thinking renders no empty Internal Logic disclosure', () => {
  const store = buildThinkingStore({ content: 'hello', images: [], operationKind: 'message', marker: 'THINK_MARKER_ONE' });
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('THINK_MARKER_ONE'), 'streamed thinking must be in the DOM for a text-only submit too');
  assert.ok(!html.includes('Internal Logic (0)'), 'an empty Internal Logic disclosure must not render');
  assert.ok(html.includes('Recent activity'), 'the activity ring shell must render before the first tool call');
});

test('once the answer streams, thinking moves into a lazy disclosure', () => {
  const store = buildThinkingStore({ content: 'hello', images: [], operationKind: 'message', marker: 'THINK_MARKER_ONE' },
    [{ kind: 'answer', delta: { turn: 1, offset: 0, text: 'ANSWER_MARKER' } }]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('ANSWER_MARKER'), 'the streamed answer must render');
  assert.ok(!html.includes('THINK_MARKER_ONE'), 'closed thinking must leave the DOM');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, selectedRuntime: store.get(SESSION_B.id) }), /THINK_MARKER_ONE/u);
});

test('the outer turn badge sums the live bubble counters once and labels them run tokens', () => {
  // Live rows hold no self-derived estimate; the usage frame is what gives them their counts.
  const store = buildThinkingStore({ content: '12345678', images: [], operationKind: 'repo-agent', marker: '12345678' }, [
    { kind: 'answer', delta: { turn: 1, offset: 0, text: '12345678' } },
    { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { promptTokens: 100, thinkingTokens: 2, outputTokens: 2, generatedChars: 16 } }) },
  ]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
    chatMode: 'repo-agent',
    isRepoToolMode: true,
  });

  // Every token badge on the page, in DOM order: the submitted user row, then the run total and
  // the two bubbles it sums. Asserting the whole list is what proves no badge claims an estimate
  // and no bubble is counted twice.
  assert.deepEqual(readTokenBadges(html), ['0 tokens', '4 run tokens', '2 tokens']);
  assert.deepEqual(readTokenBadges(renderExpanded({ selectedSessionId: SESSION_B.id, selectedRuntime: store.get(SESSION_B.id) })), ['0 tokens', '4 run tokens', '2 tokens', '2 tokens']);
});

test('a live turn with a running tool call renders recent activity and the thinking that led to it', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_TOOL' }, [{
    kind: 'tool',
    tool: {
      kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4,
      activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER', promptTokenCount: 0,
    },
  }]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(html.includes('Recent activity'), 'the running tool call must render in recent activity');
  assert.ok(html.includes('1/4'), 'tool progress must count calls against the enforced tool-call limit');
  assert.ok(html.includes('Running command…'), 'the running tool call must render a friendly label');
  assert.ok(!html.includes('TOOL_MARKER'), 'the running tool call must not expose its raw command');
  assert.ok(html.includes('THINK_MARKER_TOOL'), 'the thinking that led to the tool call must render');
});

test('the activity ring disappears into Internal Logic when final answer streaming begins', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_ANSWER' }, [
    { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4,
      activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER_ANSWER', promptTokenCount: 0,
    } },
    { kind: 'answer', delta: { turn: 2, offset: 0, text: 'FINAL_ANSWER_MARKER' } },
  ]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  const logicStart = html.indexOf('<details class="internal-logic">');
  const logicEnd = html.indexOf('</details>', logicStart);
  const logic = html.slice(logicStart, logicEnd);
  assert.ok(logicStart >= 0, 'Internal Logic must contain the completed live activity');
  assert.doesNotMatch(logic, /Running command\u2026/u, 'closed Internal Logic does not mount tool cards');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, selectedRuntime: store.get(SESSION_B.id) }), /Running command\u2026/u);
  assert.ok(!html.includes('Recent activity'), 'the visible activity ring ends when answer streaming begins');
  assert.ok(html.includes('FINAL_ANSWER_MARKER'), 'the final answer remains visible');
});

test('raw streamed model progress renders only inside closed Internal Logic', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_PROGRESS' }, [
    { kind: 'progress', progress: { turn: 1, text: 'PROGRESS_MARKER_ONE', elapsedMs: 500 } },
    { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4,
      activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER', promptTokenCount: 0,
    } },
    { kind: 'progress', progress: { turn: 2, text: 'PROGRESS_MARKER_TWO', elapsedMs: 900 } },
  ]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
  });
  assert.ok(!html.includes('PROGRESS_MARKER_ONE'), 'a newer progress event must replace the previous bar text');
  assert.ok(!html.includes('PROGRESS_MARKER_TWO'), 'closed progress must leave the DOM');
  assert.ok(!html.includes('turn-progress-bar'), 'raw model progress must not render as an exposed block');
  const logicStart = html.indexOf('<details class="internal-logic">');
  const logicEnd = html.indexOf('</details>', logicStart);
  const logic = html.slice(logicStart, logicEnd);
  assert.ok(logicStart >= 0, 'Internal Logic must render');
  assert.ok(!logic.includes('PROGRESS_MARKER_TWO'), 'closed Internal Logic stays unmounted');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, selectedRuntime: store.get(SESSION_B.id) }), /PROGRESS_MARKER_TWO/u);
  assert.ok(html.includes('Recent activity'), 'the friendly activity ring remains visible before the answer');
});

const QUEUE_ONE_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const SEGMENT_TWO_THINKING = 'SEGMENT_TWO_THINKING';

/** A live run whose four thinking turns are interrupted by one delivered queued message. */
function buildSplitSegmentStore(sessionId: string, steps: readonly LiveTranscriptStep[] = []): ChatSessionRuntimeStore {
  const store = buildDefaultStore(sessionId)
    .apply({ kind: 'begin', sessionId, operationKind: 'repo-agent', operationId: OPERATION_ID });
  return applyLiveTranscript(store, sessionId, [
    ...[1, 2, 3, 4].flatMap((turn): LiveTranscriptStep[] => [
      { kind: 'prompt', prompt: { turn, maxTurns: 20, promptTokens: 40, charsPerToken: 4 } },
      { kind: 'thinking', delta: { turn, offset: 0, text: `SEGMENT_ONE_THINKING_${turn}` } },
    ]),
    { kind: 'user_message', message: { id: QUEUE_ONE_ID, turn: 4, boundary: 'post_tool_batch', content: 'QUEUED_ONE', images: [], imageMeta: [] } },
    { kind: 'prompt', prompt: { turn: 5, maxTurns: 20, promptTokens: 40, charsPerToken: 4 } },
    { kind: 'thinking', delta: { turn: 5, offset: 0, text: SEGMENT_TWO_THINKING } },
    ...steps,
  ]);
}

test('a delivered queued message gives the two assistant segments independent React identities', async (t) => {
  const consoleError = t.mock.method(console, 'error', () => {});
  const propsFor = (store: ChatSessionRuntimeStore): ChatTabProps => buildProps({
    selectedSessionId: SESSION_B.id,
    selectedRuntime: store.get(SESSION_B.id),
    sessionRuntimes: store.getAll(),
    chatMode: 'repo-agent',
    isRepoToolMode: true,
  });
  let store = buildSplitSegmentStore(SESSION_B.id);
  const view = renderComponent(<ChatTab {...propsFor(store)} />);
  const turnBubbles = (): Element[] => [...view.container.querySelectorAll('.msg.turn')];
  try {
    assert.equal(turnBubbles().length, 2, 'the delivered queued bubble splits the live run into two assistant segments');
    const first = turnBubbles()[0];
    const second = turnBubbles()[1];
    assert.ok(first && second);
    assert.ok(view.container.textContent?.includes('QUEUED_ONE'), 'the queued user bubble stays between the segments');
    const firstLogic = first.querySelector('details.internal-logic');
    assert.ok(firstLogic, 'the earlier segment keeps its overflowed thinking in Internal Logic');
    toggleDisclosure(firstLogic, true);
    assert.match(first.textContent ?? '', /SEGMENT_ONE_THINKING_1/u);
    assert.equal(
      second.querySelector('.assistant_thinking .msg-tokens')?.textContent,
      `~${SEGMENT_TWO_THINKING.length / 4} tokens`,
    );

    store = buildSplitSegmentStore(SESSION_B.id, [{ kind: 'thinking', delta: { turn: 5, offset: SEGMENT_TWO_THINKING.length, text: ' keeps streaming' } }]);
    await act(async () => { view.rerender(<ChatTab {...propsFor(store)} />); });

    assert.equal(turnBubbles()[0], first, 'the earlier segment must not remount');
    assert.equal(turnBubbles()[1], second, 'the streaming segment must not remount');
    assert.equal(firstLogic.hasAttribute('open'), true, 'the earlier disclosure must stay expanded');
    assert.match(first.textContent ?? '', /SEGMENT_ONE_THINKING_1/u, 'the earlier disclosure must keep its own steps');
    assert.doesNotMatch(first.textContent ?? '', /SEGMENT_TWO_THINKING/u, 'the streaming segment must not fold into the earlier one');
    assert.equal(
      second.querySelector('.assistant_thinking .msg-tokens')?.textContent,
      `~${Math.ceil((SEGMENT_TWO_THINKING.length + ' keeps streaming'.length) / 4)} tokens`,
      'the streaming segment badge must grow in place',
    );
    const keyWarnings = consoleError.mock.calls
      .map((call) => call.arguments.map((arg) => String(arg)).join(' '))
      .filter((line) => /same key/u.test(line));
    assert.deepEqual(keyWarnings, [], 'assistant segments must not share a React key');
  } finally {
    view.unmount();
  }
});

test('repo-agent composer shows the approval mode control with Auto selected by default', () => {
  renderComponent(<ChatTab {...buildProps({ chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false })} />);
  const group = screen.getByRole('group', { name: 'Approval mode' });
  const buttons = ['Manual', 'Auto', 'Approve all'].map((name) => screen.getByRole('button', { name }));
  assert.equal(buttons.length, 3);
  assert.equal(group.contains(buttons[1] ?? null), true);
  assert.equal(buttons[0]?.getAttribute('aria-pressed'), 'false');
  assert.equal(buttons[1]?.getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[2]?.getAttribute('aria-pressed'), 'false');
});

test('non-repo-agent modes do not render the approval mode control', () => {
  renderComponent(<ChatTab {...buildProps({ chatMode: 'repo-search', isRepoToolMode: true, isDirectChatMode: false })} />);
  assert.equal(screen.queryByRole('group', { name: 'Approval mode' }), null);
});

test('clicking an approval mode reports the wire value and reflects the stored mode', async () => {
  const changes: string[] = [];
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'repo-agent-approval-mode', sessionId: SESSION_A.id, approval: 'off' });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll(),
    onChangeRepoAgentApprovalMode: async (mode) => { changes.push(mode); },
  })} />);
  assert.equal(screen.getByRole('button', { name: 'Approve all' }).getAttribute('aria-pressed'), 'true');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Manual' })); });
  assert.deepEqual(changes, ['interactive']);
});

test('the approval mode control stays enabled while this client owns a running repo-agent', () => {
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'repo-agent', operationId: OPERATION_ID });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll(),
  })} />);
  assert.equal(screen.getByRole('button', { name: 'Auto' }).hasAttribute('disabled'), false);
  assert.equal(screen.getByPlaceholderText('Describe the task for the repo agent…').hasAttribute('disabled'), false);
});

test('the approval mode control stays enabled when another client owns the run', () => {
  // The gate is "a repo-agent run is in flight", not "this client started it": after a reload the
  // run is someone else's from this client's point of view, and the mode must still be changeable.
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'remote-begin', sessionId: SESSION_A.id, operationKind: 'repo-agent' });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll(),
  })} />);
  for (const name of ['Manual', 'Auto', 'Approve all']) {
    assert.equal(screen.getByRole('button', { name }).hasAttribute('disabled'), false);
  }
});

test('the context bar and label grow with the calibrated streaming tail while a turn streams', () => {
  const usage = { ...CONTEXT_USAGE, totalUsedTokens: 40, usedTokens: 40, chatUsedTokens: 40, remainingTokens: 60 };
  const idle = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, '')
    .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: usage });
  const idleView = renderComponent(<ChatTab {...buildProps({
    selectedRuntime: idle.get(SESSION_A.id), sessionRuntimes: idle.getAll(),
  })} />);
  const idleBar = idleView.container.querySelector('.ctx');
  assert.ok(idleBar instanceof HTMLElement);
  assert.equal(idleBar.title, 'context 40 / 100');
  assert.equal(idleBar.querySelector('i')?.style.width, '40%');
  assert.equal(idleView.container.querySelector('.ctx-label')?.textContent, '40 / 100');
  idleView.unmount();

  const streaming = applyLiveTranscript(idle
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message', operationId: OPERATION_ID }), SESSION_A.id, [
    { kind: 'prompt', prompt: { turn: 1, maxTurns: 20, promptTokens: 60, charsPerToken: 4 } },
    { kind: 'answer', delta: { turn: 2, offset: 0, text: 'x'.repeat(40) } },
  ], { operationKind: 'message' });
  const view = renderComponent(<ChatTab {...buildProps({
    selectedRuntime: streaming.get(SESSION_A.id), sessionRuntimes: streaming.getAll(),
  })} />);
  const bar = view.container.querySelector('.ctx');
  assert.ok(bar instanceof HTMLElement);
  assert.equal(bar.title, 'context 70 / 100');
  assert.equal(bar.querySelector('i')?.style.width, '70%');
  assert.equal(view.container.querySelector('.ctx-label')?.textContent, '~70 / 100');
});

test('the context bar follows the measured prompt count of the latest turn while streaming', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, '')
    .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: { ...CONTEXT_USAGE, totalUsedTokens: 40 } })
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'repo-agent', operationId: OPERATION_ID });
  const streaming = applyLiveTranscript(store, SESSION_A.id, [
    { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2,
      activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg x', promptTokenCount: 88,
    } },
    { kind: 'prompt', prompt: { turn: 1, maxTurns: 2, promptTokens: 88, charsPerToken: 4 } },
  ]);
  const view = renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: streaming.get(SESSION_A.id), sessionRuntimes: streaming.getAll(),
  })} />);
  const bar = view.container.querySelector('.ctx');
  assert.ok(bar instanceof HTMLElement);
  assert.equal(bar.title, 'context 88 / 100');
  assert.equal(bar.className, 'ctx warn');
});

test('the approval mode control is disabled during a local non-repo-agent operation', () => {
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message', operationId: OPERATION_ID });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll(),
  })} />);
  for (const name of ['Manual', 'Auto', 'Approve all']) {
    assert.equal(screen.getByRole('button', { name }).hasAttribute('disabled'), true);
  }
});
