import './react-test-environment.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSessionResponseSchema, DurableChatApprovalSchema, OrchestratorRunStateSchema, DurableChatQuestionSchema, buildChatRunMessageIdPrefix, buildChatMessageId } from '@siftkit/contracts';
import { fireEvent, notifyResize, render as renderComponent, screen, waitFor } from './react-test-environment.js';
import { countRenders } from './render-tracker.js';
import { ChatRuntimeHub } from '../src/lib/chat-runtime-hub';
import { MessageImages } from '../src/components/MessageImages';
import { ChatSessionRuntimeStore, type ChatSessionRuntimeTransition } from '../src/lib/chat-session-runtime-store';
import { toRuntimeTransitions } from '../src/lib/chat-stream-transitions';
import { groupMessagesIntoTurns } from '../src/lib/chatTurns';
import { GatedChatBackend } from '../../tests/helpers/gated-chat-backend.js';
import { ChatMessageQueueResponseSchema } from '@siftkit/contracts';
import { ChatTab } from '../src/tabs/ChatTab';
import { MarkdownContent } from '../src/components/MarkdownContent';
import { summarizeChatSession } from '../src/hooks/useChatSessions';
import { consumeChatStream } from '../src/api';
import type { ChatSession, ChatSessionOperationKind, ContextUsage, DashboardPreset } from '../src/types';
import type { PendingImage } from '../src/lib/downscale-image';
import { buildUsageFrame } from './usage-frame';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { applyLiveTranscript, liveTranscriptSnapshot, type LiveTranscriptStep } from './live-transcript-fixture.js';
import { ORCHESTRATOR_RUN_ID, PRESET, REPO_AGENT_PRESET, SESSION_A, SESSION_B, buildDefaultStore, buildProps, msg, orchestratorProps, type ChatTabProps } from './chat-tab-fixture.js';
import { createLiveMessage } from '../src/lib/chat-live-messages';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';
const SUBMISSION_ID = '4f9c1f9a-0000-4000-8000-000000000001';

for (const grouped of [false, true]) test(`Stop outcome is visible once outside generated text (grouped=${grouped})`, () => {
  const answer = { ...createLiveMessage('partial', 'assistant_answer', 'assistant', 'Original partial answer'), runTerminalCause: 'user_stop' as const };
  const messages = grouped ? [createLiveMessage('thinking', 'assistant_thinking', 'assistant', 'Reasoning'), answer] : [answer];
  const snapshot = chatSnapshot({ sessionId: 'session-b', operationKind: 'message', terminalCause: 'user_stop', messages });
  const store = buildDefaultStore('session-b').apply({ kind: 'snapshot', sessionId: 'session-b', snapshot });
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', runtimeHub: new ChatRuntimeHub(store) })} />);
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
  const hub = new ChatRuntimeHub(buildDefaultStore('session-b').apply({ kind: 'draft', sessionId: 'session-b', draft: 'continue' })
    .apply({ kind: 'snapshot', sessionId: 'session-b', snapshot }));
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', runtimeHub: hub })} />);
  try {
    assert.match(view.container.textContent ?? '', /Readable partial answer/u);
    assert.match(view.container.textContent ?? '', /repair/u);
    assert.ok(view.container.querySelector('button.send:not(.stop)')?.hasAttribute('disabled'));
    act(() => hub.apply({ kind: 'snapshot', sessionId: 'session-b', snapshot: { ...snapshot, status: 'recovery_needed' } }));
    assert.equal(view.container.querySelector('button.send:not(.stop)')?.hasAttribute('disabled'), false);
  } finally { view.unmount(); }
});

test('active token badges grow before usage and settle without losing late text accounting', () => {
  const live = { operationKind: 'message', controlOperationId: OPERATION_ID } as const;
  const prompt: LiveTranscriptStep = { kind: 'prompt', prompt: { turn: 1, maxTurns: 20, promptTokens: 50, charsPerToken: 4 } };
  const hub = new ChatRuntimeHub(buildDefaultStore('session-b').apply({ kind: 'begin', sessionId: 'session-b', operationKind: 'message', operationId: OPERATION_ID }));
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', runtimeHub: hub })} />);
  try {
    for (const length of [400, 800]) {
      act(() => hub.apply(liveFrame('session-b', [prompt, { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'x'.repeat(length) } }], live)));
      assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, `~${length / 4} tokens`);
      assert.equal(hub.getStore().getLive('session-b').liveMessages[0]?.thinkingTokens, 0);
    }
    const settled: LiveTranscriptStep[] = [
      prompt, { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'x'.repeat(800) } },
      { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 187 } }) },
      { kind: 'thinking', delta: { turn: 1, offset: 800, text: 'tail' } },
    ];
    act(() => hub.apply(liveFrame('session-b', settled, live)));
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, '187 tokens');
    assert.equal(view.container.querySelector('.msg.turn > .who .msg-tokens')?.textContent, '187 run tokens');
    act(() => hub.apply(liveFrame('session-b', [...settled,
      { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 187, thinkingTokensEstimated: true } }) }], live)));
    assert.equal(view.container.querySelector('.msg.turn > .who .msg-tokens')?.textContent, '~187 run tokens');
    act(() => hub.apply({ kind: 'attach', sessionId: 'session-b', operationKind: 'message', operationId: OPERATION_ID },
      liveFrame('session-b', [{ kind: 'thinking', delta: { turn: 1, offset: 0, text: 'truncated replay' } }], live)));
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, 'tokens unavailable');
    assert.equal(view.container.querySelector('.msg.turn > .who .msg-tokens')?.textContent, 'tokens unavailable');
  } finally { view.unmount(); }
});

import { DashboardTestServer } from '../../tests/helpers/dashboard-server-fixture.js';
import { requestJson, requestSse } from '../../tests/helpers/dashboard-http.js';
import { getDefaultConfig } from '../../src/status-server/config-store.js';
import { getActiveModelPreset } from '../../src/config/getters.js';
import { getRuntimeRoot } from '../../src/config/paths.js';
import { saveChatSession } from '../../src/state/chat-sessions.js';
import { CONTEXT_USAGE as BASE_CONTEXT_USAGE } from './fixtures.js';

/** Every rendered token badge, in DOM order, so an assertion names the badges and not the markup. */
function readTokenBadges(html: string): string[] {
  return [...html.matchAll(/<span class="msg-tokens"[^>]*>([^<]*)<\/span>/gu)].map((match) => match[1] ?? '');
}

/** The real client's stream path, so a rejected route surfaces exactly as the dashboard sees it. */
function readHttpChat(url: string, signal: AbortSignal, body?: Record<string, string | number | boolean>) {
  return consumeChatStream(url, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  } : { signal }, 'error');
}

/** A committed live view built from run evidence, as the stream would deliver it. */
function liveFrame(sessionId: string, steps: readonly LiveTranscriptStep[], overrides: Parameters<typeof liveTranscriptSnapshot>[2] = {}) {
  return { kind: 'snapshot' as const, sessionId, snapshot: liveTranscriptSnapshot(sessionId, steps, overrides) };
}

/** Feeds stream transitions into the hub the rendered tab subscribes to, until `kind` arrives. */
async function readThrough(
  stream: AsyncGenerator<ChatSessionRuntimeTransition>,
  hub: ChatRuntimeHub,
  kind: 'prompt' | 'thinking' | 'terminal',
  thinkingTurn?: number,
): Promise<ChatSessionRuntimeTransition> {
  const before = hub.getStore();
  for (;;) {
    const next = await stream.next();
    assert.equal(next.done, false, `stream ended before ${kind}`);
    assert.ok(next.value);
    const transition = next.value;
    act(() => hub.apply(transition));
    if (transition.kind === 'failure') throw new Error(transition.message);
    if (kind === 'terminal' && transition.kind === 'terminal') return transition;
    if (transition.kind !== 'snapshot') continue;
    const prior = before.getLive(transition.sessionId);
    const snapshot = transition.snapshot;
    if (kind === 'prompt' && snapshot.tokenTurns.some(turn => turn.prompt !== null && turn.turn > Math.max(0, ...prior.tokenTurns.keys()))) {
      return transition;
    }
    if (kind === 'thinking' && snapshot.messages.some(message => message.kind === 'assistant_thinking'
      && (thinkingTurn === undefined || message.id === buildChatMessageId(buildChatRunMessageIdPrefix(snapshot.operationId), { kind: 'thinking', turn: thinkingTurn }))
      && message.content !== prior.liveMessages.find(previous => previous.id === message.id)?.content)) {
      return transition;
    }
  }
}

test('a rejected chat route fails promptly even when no provider request arrives', async (t) => {
  const backend = new GatedChatBackend();
  t.after(() => backend.close());
  const baseUrl = await backend.start();
  const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession('s', ''));
  const stream = toRuntimeTransitions('s', { kind: 'owned', operationKind: 'plan', operationId: OPERATION_ID }, readHttpChat(`${baseUrl}/missing-chat-route`, t.signal), true);
  t.after(async () => { await stream.return(); });
  await assert.rejects(Promise.all([readThrough(stream, hub, 'prompt'), backend.nextRequest()]), /404/u);
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
    const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession(sessionId, '')
      .apply({ kind: 'submit', sessionId, content: 'inspect', images: [] }));
    let session = created.session;
    const props = (runtimeHub = hub) => buildProps({ selectedSessionId: sessionId, selectedSession: session, sessions: [summarizeChatSession(session)], runtimeHub });
    const view = renderComponent(<ChatTab {...props()} />);
    const stream = toRuntimeTransitions(sessionId, { kind: 'owned', operationKind: 'plan', operationId: OPERATION_ID, submissionId: SUBMISSION_ID }, readHttpChat(`${url}/plan/stream`, t.signal, { content: 'inspect', repoRoot: server.tempRoot, operationId: OPERATION_ID, submissionId: SUBMISSION_ID, maxTurns: 3 }), true);
    t.after(async () => { await stream.return(); });
    try {
      const firstPrompt = readThrough(stream, hub, 'prompt');
      const [first] = await Promise.all([backend.nextRequest(), firstPrompt]);
      for (const [expectedLength, expectedBadge] of [[400, '~100 tokens'], [800, '~200 tokens']] as const) {
        backend.write(first, { reasoning_content: 'x'.repeat(400) });
        await readThrough(stream, hub, 'thinking');
        const count = hub.getStore().getLive(sessionId).liveMessages.find((message) => message.kind === 'assistant_thinking')?.content.length;
        assert.equal(count, expectedLength);
        assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, expectedBadge);
        assert.equal(hub.getStore().getLive(sessionId).tokenTurns.get(1)?.usage, null);
        if (queued && expectedLength === 400) {
          for (const [index, id] of [QUEUE_ONE_ID, '4f9c1f9a-0000-4000-8000-000000000002'].entries()) {
            const response = await requestJson(`${url}/queue`, { method: 'POST', body: JSON.stringify({ id, content: `queued ${index}`, images: [], options: { operationKind: 'plan', repoRoot: server.tempRoot } }) });
            assert.equal(response.statusCode, 200);
            const tokenTurns = hub.getStore().getLive(sessionId).tokenTurns;
            act(() => hub.apply({ kind: 'queue', sessionId, queue: ChatMessageQueueResponseSchema.parse(response.body).queue },
              { kind: 'queued-submit', sessionId, content: `queued ${index}`, images: [] }));
            assert.equal(hub.getStore().getLive(sessionId).tokenTurns, tokenTurns);
          }
        }
      }
      let terminalCause: string | null = null;
      if (queued) {
        backend.write(first, { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }] });
        backend.finish(first);
        const nextPrompt = readThrough(stream, hub, 'prompt');
        const [second] = await Promise.all([backend.nextRequest(), nextPrompt]);
        assert.deepEqual(hub.getStore().getLive(sessionId).liveMessages.filter((message) => message.role === 'user').map((message) => message.content), ['inspect', 'queued 0', 'queued 1']);
        assert.equal(hub.getStore().getLive(sessionId).liveMessages.find((message) => message.kind === 'assistant_thinking')?.thinkingTokens, 10);
        backend.write(second, { reasoning_content: 'y'.repeat(400) });
        await readThrough(stream, hub, 'thinking');
        assert.equal(view.container.querySelectorAll('.msg.turn').length, 2);
        const beforeReplay = readTokenBadges(view.container.innerHTML);
        const replay = toRuntimeTransitions(sessionId, { kind: 'attached' }, readHttpChat(`${url}/operation/stream`, t.signal), true);
        t.after(async () => { await replay.return(); });
        // A second client's view of the same run: its own hub, rendered in place of this one.
        const replayHub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession(sessionId, ''));
        await readThrough(replay, replayHub, 'thinking', 2);
        view.rerender(<ChatTab {...props(replayHub)} />);
        assert.deepEqual(readTokenBadges(view.container.innerHTML), beforeReplay);
        view.rerender(<ChatTab {...props()} />);
        backend.write(second, { content: 'finished' });
        backend.finish(second);
        const replayDone = readThrough(replay, replayHub, 'terminal');
        const completed = await readThrough(stream, hub, 'terminal');
        await replayDone;
        if (completed.kind !== 'terminal') throw new Error('Expected completion terminal.');
        terminalCause = completed.terminal.terminalCause;
      } else {
        backend.write(first, { content: 'finished' });
        backend.finish(first);
        const completed = await readThrough(stream, hub, 'terminal');
        if (completed.kind !== 'terminal') throw new Error('Expected completion terminal.');
        terminalCause = completed.terminal.terminalCause;
      }
      const persisted = ChatSessionResponseSchema.parse((await requestJson(url)).body);
      session = persisted.session;
      view.rerender(<ChatTab {...props()} />);
      assert.equal(terminalCause, 'completed');
      assert.equal(hub.getStore().getLive(sessionId).tokenTurns.size, 0);
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
    const hub = new ChatRuntimeHub(new ChatSessionRuntimeStore().ensureSession(sessionId, ''));
    const stream = toRuntimeTransitions(sessionId, { kind: 'owned', operationKind: 'plan', operationId: OPERATION_ID, submissionId: SUBMISSION_ID }, readHttpChat(`${url}/plan/stream`, t.signal, { content: 'original', repoRoot: server.tempRoot, operationId: OPERATION_ID, submissionId: SUBMISSION_ID, maxTurns: 3 }), true);
    t.after(async () => { await stream.return(); });
    const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: sessionId, selectedSession: created.session, runtimeHub: hub })} />);
    try {
      const prompt = readThrough(stream, hub, 'prompt');
      const [firstProvider] = await Promise.all([backend.nextRequest(), prompt]);
      let provider = firstProvider;
      backend.write(provider, { reasoning_content: 'x'.repeat(400) });
      await readThrough(stream, hub, 'thinking');
      if (force) {
        backend.write(provider, { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }] });
        backend.finish(provider);
        const secondPrompt = readThrough(stream, hub, 'prompt');
        const [secondProvider] = await Promise.all([backend.nextRequest(), secondPrompt]);
        provider = secondProvider;
        backend.write(provider, { reasoning_content: 'y'.repeat(400) });
        await readThrough(stream, hub, 'thinking');
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
      const done = await readThrough(stream, hub, 'terminal');
      assert.equal(hub.getStore().getLive(sessionId).tokenTurns.size, 0);
      assert.equal(done.kind, 'terminal');
      const saved = ChatSessionResponseSchema.parse((await requestJson(url)).body).session;
      assert.equal(saved.messages.find((message) => message.kind === 'assistant_thinking')?.thinkingTokens, 10);
      if (force) {
        if (done.kind !== 'terminal') throw new Error('Expected stop terminal.');
        assert.equal(done.terminal.terminalCause, 'user_stop');
      }
      const successorProvider = await backend.nextRequest();
      const successor = toRuntimeTransitions(sessionId, { kind: 'attached' }, readHttpChat(`${url}/operation/stream`, t.signal), true);
      t.after(async () => { await successor.return(); });
      await readThrough(successor, hub, 'prompt');
      assert.equal(hub.getStore().getLive(sessionId).tokenTurns.size, 1);
      assert.equal(hub.getStore().getLive(sessionId).tokenTurns.get(1)?.usage, null);
      backend.write(successorProvider, { reasoning_content: 'z'.repeat(400) });
      await readThrough(successor, hub, 'thinking');
      view.rerender(<ChatTab {...buildProps({ selectedSessionId: sessionId, selectedSession: saved, runtimeHub: hub })} />);
      assert.equal([...view.container.querySelectorAll('.assistant_thinking .msg-tokens')].at(-1)?.textContent, '~100 tokens');
      backend.write(successorProvider, { content: 'successor finished' });
      backend.finish(successorProvider);
      await readThrough(successor, hub, 'terminal');
      assert.equal(hub.getStore().getLive(sessionId).tokenTurns.size, 0);
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

const CONTEXT_USAGE = {
  ...BASE_CONTEXT_USAGE, chatUsedTokens: 90, totalUsedTokens: 90, remainingTokens: 10, warnThresholdTokens: 50,
  providerOverheadTokens: 5, effectiveImagePixelCeiling: 1_000_000,
} satisfies ContextUsage;

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
  renderComponent(<ChatTab {...buildProps({ runtimeHub: new ChatRuntimeHub(store) })} />);
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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
  })} />);
  assert.equal(screen.getByRole('button', { name: 'Turns: 100' }).hasAttribute('disabled'), true);
  assert.ok(screen.getByRole('button', { name: 'Stop' }));
});

test('switching sessions closes the turns editor and selects that session value', async () => {
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'plan-inputs', sessionId: SESSION_A.id, planRepoRootInput: '', planMaxTurnsInput: '1000' })
    .apply({ kind: 'plan-inputs', sessionId: SESSION_B.id, planRepoRootInput: '', planMaxTurnsInput: '2000' }));
  const view = renderComponent(<ChatTab {...buildProps({
    selectedSessionId: SESSION_A.id,
    runtimeHub: hub,
    chatMode: 'repo-agent',
    isRepoToolMode: true,
  })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Turns: 1000' }));
  assert.ok(screen.getByLabelText('Maximum turns'));

  await act(async () => {
    view.rerender(<ChatTab {...buildProps({
      selectedSessionId: SESSION_B.id,
      runtimeHub: hub,
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
    runtimeHub: new ChatRuntimeHub(store),
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

test('orchestrator mode starts a run for the saved repository and shows its live panel', async () => {
  const bodies: Array<[string, string]> = [];
  const originalFetch = globalThis.fetch;
  const drafts: string[] = [];
  const running = OrchestratorRunStateSchema.parse({
    runId: ORCHESTRATOR_RUN_ID,
    request: { submissionId: ORCHESTRATOR_RUN_ID, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive', task: 'hi', planPath: null },
    revision: 1, phase: 'preparing_plan', planPath: null, planHash: null, plan: null, tasks: [], attempts: [], phaseRunIds: [],
    approval: null, failure: null, createdAtUtc: '2026-09-23T12:00:00.000Z', updatedAtUtc: '2026-09-23T12:00:00.000Z',
  });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    bodies.push([url, typeof init?.body === 'string' ? init.body : '']);
    if (url.startsWith('/orchestrator/runs')) return new Response(JSON.stringify({ runs: [] }));
    if (url === '/orchestrator') return new Response(JSON.stringify(running), { status: 202 });
    if (url === '/orchestrator/events') return new Response(`event: result
data: ${JSON.stringify({ ...running, phase: 'interrupted' })}

`);
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    renderComponent(<ChatTab {...orchestratorProps({ onChangeDraft: (value) => { drafts.push(value); } })} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run orchestrator' })); });
    await screen.findByText('interrupted');
    const start = bodies.find(([url]) => url === '/orchestrator');
    const request = JSON.parse(start?.[1] ?? '{}');
    assert.deepEqual({ ...request, submissionId: null },
      { submissionId: null, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'interactive', task: 'hi', planPath: null });
    assert.deepEqual(drafts, ['']);
  } finally { globalThis.fetch = originalFetch; }
});

test('orchestrator mode cannot start without a saved repository folder', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { throw new Error(`Unexpected fetch ${String(input)}`); };
  try {
    renderComponent(<ChatTab {...orchestratorProps({ selectedSession: { ...SESSION_A, planRepoRoot: '' } })} />);
    assert.equal(screen.getByRole('button', { name: 'Run orchestrator' }).hasAttribute('disabled'), true);
  } finally { globalThis.fetch = originalFetch; }
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
    runtimeHub: new ChatRuntimeHub(store),
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

/** Sizes the log and leaves it resting at its bottom, where a freshly opened transcript is pinned. */
function configureChatScroll(element: HTMLElement): { setScrollHeight(value: number): void } {
  let scrollHeight = 1_000;
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  element.scrollTop = 800;
  fireEvent.scroll(element);
  return { setScrollHeight: (value) => { scrollHeight = value; } };
}

test('a pinned log follows growth that arrives without a new stream frame', async () => {
  const view = renderComponent(<ChatTab {...buildProps()} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  scroll.setScrollHeight(1_300);
  await act(async () => notifyResize());
  assert.equal(chatLog.scrollTop, 1_300);
});

test('a scroll event caused by growth below the viewport keeps the log pinned', async () => {
  const view = renderComponent(<ChatTab {...buildProps()} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  scroll.setScrollHeight(1_300);
  fireEvent.scroll(chatLog);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);
  await act(async () => notifyResize());
  assert.equal(chatLog.scrollTop, 1_300);
});

test('scrolling up unpins, and growth then leaves the reading position alone', async () => {
  const view = renderComponent(<ChatTab {...buildProps()} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  chatLog.scrollTop = 300;
  fireEvent.scroll(chatLog);
  assert.ok(screen.getByRole('button', { name: 'Jump to bottom' }));
  scroll.setScrollHeight(1_300);
  await act(async () => notifyResize());
  assert.equal(chatLog.scrollTop, 300);
});

test('streaming follows only while the user is pinned to the bottom', async () => {
  const streamed = (text: string) => liveFrame(SESSION_A.id, [{ kind: 'answer', delta: { turn: 1, offset: 0, text } }]);
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'repo-agent', operationId: OPERATION_ID })
    .apply(streamed('first')));
  const view = renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent',
    isRepoToolMode: true,
    runtimeHub: hub,
  })} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);

  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);
  await act(async () => {
    hub.apply(streamed('first update'));
    notifyResize();
  });

  assert.equal(chatLog.scrollTop, 200);
  chatLog.scrollTop = 800;
  fireEvent.scroll(chatLog);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);
  scroll.setScrollHeight(1_200);
  await act(async () => {
    hub.apply(streamed('first update again'));
    notifyResize();
  });
  assert.equal(chatLog.scrollTop, 1_200);

  chatLog.scrollTop = 700;
  fireEvent.scroll(chatLog);
  const jump = screen.getByRole('button', { name: 'Jump to bottom' });
  fireEvent.click(jump);
  assert.equal(chatLog.scrollTop, 1_200);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);

  scroll.setScrollHeight(1_400);
  await act(async () => {
    hub.apply(streamed('first update again final'));
    notifyResize();
  });
  assert.equal(chatLog.scrollTop, 1_400);
});

test('switching sessions resets pinned scrolling and hides the jump control', async () => {
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id));
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: SESSION_A.id, runtimeHub: hub })} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  configureChatScroll(chatLog);
  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);
  assert.ok(screen.getByRole('button', { name: 'Jump to bottom' }));

  await act(async () => {
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: SESSION_B.id, runtimeHub: hub })} />);
    notifyResize();
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
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id));
  const props = buildProps({ chatMode: 'repo-agent', isRepoToolMode: true, runtimeHub: hub });
  const view = renderComponent(<ChatTab {...props} />);
  const chatLog = view.container.querySelector('.msgs');
  assert.ok(chatLog instanceof HTMLElement);
  const scroll = configureChatScroll(chatLog);
  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);

  await act(async () => {
    hub.apply(liveFrame(SESSION_A.id, [], { approval }));
    notifyResize();
  });
  assert.equal(chatLog.scrollTop, 1_000);
  assert.equal(screen.queryByRole('button', { name: 'Jump to bottom' }), null);

  scroll.setScrollHeight(1_200);
  await act(async () => {
    hub.apply(liveFrame(SESSION_A.id, [{ kind: 'answer', delta: { turn: 1, offset: 0, text: 'working' } }], { approval }));
    notifyResize();
  });
  assert.equal(chatLog.scrollTop, 1_200);

  chatLog.scrollTop = 200;
  fireEvent.scroll(chatLog);
  await act(async () => {
    view.rerender(<ChatTab {...props} />);
    notifyResize();
  });
  assert.equal(chatLog.scrollTop, 200);

  await act(async () => {
    hub.apply({ kind: 'approval-clear', sessionId: SESSION_A.id });
    notifyResize();
  });
  assert.equal(chatLog.scrollTop, 200);

  await act(async () => {
    hub.apply(liveFrame(SESSION_A.id, [{ kind: 'answer', delta: { turn: 1, offset: 0, text: 'working' } }],
      { approval: { ...approval, approvalId: '4f9c1f9a-0000-4000-8000-000000000011' } }));
    notifyResize();
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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
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
      runtimeHub: new ChatRuntimeHub(store),
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
      runtimeHub: new ChatRuntimeHub(store),
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
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: CONTEXT_USAGE })
    .apply({ kind: 'context-usage', sessionId: SESSION_B.id, contextUsage: CONTEXT_USAGE }));
  try {
    const rendered = renderComponent(<ChatTab {...buildProps({
      runtimeHub: hub,
      onPendingImagesAppend: (sessionId) => appended.push(sessionId),
    })} />);
    fireEvent.change(screen.getByLabelText('Attach'), {
      target: { files: [new File([new Uint8Array([1])], 'first.png')] },
    });
    await act(async () => {
      rendered.rerender(<ChatTab {...buildProps({
        selectedSessionId: SESSION_B.id,
        selectedSession: SESSION_B,
        runtimeHub: hub,
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
    runtimeHub: new ChatRuntimeHub(store),
  });
  assert.match(markup, /Session A[\s\S]*streaming/u);
  assert.doesNotMatch(markup, /class="send"[^>]*disabled/u);
  assert.doesNotMatch(markup, /class="ghost-btn acc new"[^>]*disabled/u);
  assert.doesNotMatch(markup, /class="ghost-btn"[^>]*disabled[^>]*>Delete/u);
});

test('a streaming session shows a static live dot in the rail, with no typing animation', () => {
  const store = buildDefaultStore('session-a').apply({
    kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID,
  });
  const markup = render({ runtimeHub: new ChatRuntimeHub(store) });
  assert.match(markup, /class="live-dot"/u);
  assert.doesNotMatch(markup, /class="typing"/u);
});

test('selected busy A disables mutable controls except Stop', () => {
  const store = buildDefaultStore('session-a').apply({
    kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID,
  });
  const markup = render({ runtimeHub: new ChatRuntimeHub(store) });
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
    runtimeHub: new ChatRuntimeHub(store),
  });
  assert.doesNotMatch(selectedB, /warning-a|error-a/u);
  const selectedA = render({
    runtimeHub: new ChatRuntimeHub(store),
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
  const hub = new ChatRuntimeHub(applyLiveTranscript(buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'message', operationId: OPERATION_ID })
    .apply({ kind: 'queue', sessionId: SESSION_A.id, queue }), SESSION_A.id, steps, { operationKind: 'message' }));
  const view = renderComponent(<ChatTab {...buildProps({ runtimeHub: hub })} />);
  try {
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, '~100 tokens');
    view.rerender(<ChatTab {...buildProps({ selectedSessionId: SESSION_B.id, runtimeHub: hub })} />);
    assert.equal(view.container.querySelector('.assistant_thinking'), null);
    assert.doesNotMatch(view.container.textContent ?? '', /queued for A/u);
    act(() => hub.apply(liveFrame(SESSION_A.id, [...steps, { kind: 'thinking', delta: { turn: 1, offset: 400, text: 'A'.repeat(400) } }], { operationKind: 'message' })));
    view.rerender(<ChatTab {...buildProps({ runtimeHub: hub })} />);
    assert.equal(view.container.querySelector('.assistant_thinking .msg-tokens')?.textContent, '~200 tokens');
    assert.equal(hub.getStore().get(SESSION_A.id).queue, queue);
    assert.equal(hub.getStore().getLive(SESSION_B.id).tokenTurns.size, 0);
    assert.equal(hub.getStore().get(SESSION_B.id).queue, null);
  } finally { view.unmount(); }
});

test('a running tool message renders a neutral friendly activity row', () => {
  const store = applyLiveTranscript(buildDefaultStore('session-a')
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID }), 'session-a', [{ kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 'tool', turn: 1, maxTurns: 2,
      activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg x', promptTokenCount: 0,
    } }], { operationKind: 'message' });
  const markup = render({ runtimeHub: new ChatRuntimeHub(store) });
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
    runtimeHub: new ChatRuntimeHub(store),
  });
  assert.match(markup, /Recent activity/u);
  assert.match(markup, />4\/45</u);
  assert.equal(markup.match(/class="tool-activity-row tool-activity-neutral"/gu)?.length, 3);
  assert.doesNotMatch(markup, /rg marker-/u);
  assert.doesNotMatch(markup, /assistant tool/u, 'recent activity must use compact rows, not nested message bubbles');
});

test('selected context usage renders the warning context bar', () => {
  const responseStore = buildDefaultStore('session-a').apply({ kind: 'context-usage', sessionId: 'session-a', contextUsage: CONTEXT_USAGE });
  const markup = render({ runtimeHub: new ChatRuntimeHub(responseStore) });
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
      runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
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
    sessions: [summarizeChatSession(COMPACTED_SESSION)],
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

test('repeated compaction renders one closed fold per summary, in order, then live messages', () => {
  const markup = render({
    sessions: [summarizeChatSession(TWICE_COMPACTED_SESSION)],
    selectedSessionId: TWICE_COMPACTED_SESSION.id,
    selectedSession: TWICE_COMPACTED_SESSION,
  });
  const folds = [...markup.matchAll(/<details class="compaction-history">/gu)].map((match) => match.index ?? -1);
  const firstSummary = markup.indexOf('FIRST SUMMARY');
  const latestSummary = markup.indexOf('LATEST SUMMARY');
  const liveQuestion = markup.indexOf('live question');

  assert.equal(folds.length, 2);
  assert.match(markup, /Context compacted \(2 messages summarized\)/u);
  assert.ok((folds[0] ?? -1) < firstSummary && firstSummary < (folds[1] ?? -1));
  assert.ok((folds[1] ?? -1) < latestSummary && latestSummary < liveQuestion);
  assert.doesNotMatch(markup, /compaction-originals/u);
  assert.doesNotMatch(markup, /middle answer/u);
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
    // Saved through the config route, which moves the applied model the next run is admitted on.
    const saved = await requestJson(`${server.baseUrl}/config?skip_ready=1`, { method: 'PUT', body: JSON.stringify(config) });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));

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
          submissionId: SUBMISSION_ID,
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
      sessions: [summarizeChatSession(terminal.session)],
      selectedSessionId: terminal.session.id,
      selectedSession: terminal.session,
      runtimeHub: new ChatRuntimeHub(responseStore),
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

  const markup = render({ sessions: [summarizeChatSession(session)], selectedSessionId: session.id, selectedSession: session });

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

  const markup = render({ sessions: [summarizeChatSession(session)], selectedSessionId: session.id, selectedSession: session });

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
    runtimeHub: new ChatRuntimeHub(store),
  });
  assert.ok(html.includes('THINK_MARKER_ONE'), 'streamed thinking must be in the DOM before the answer arrives');
});

test('a live turn that has only streamed thinking renders no empty Internal Logic disclosure', () => {
  const store = buildThinkingStore({ content: 'hello', images: [], operationKind: 'message', marker: 'THINK_MARKER_ONE' });
  const html = render({
    selectedSessionId: SESSION_B.id,
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
  });
  assert.ok(html.includes('ANSWER_MARKER'), 'the streamed answer must render');
  assert.ok(!html.includes('THINK_MARKER_ONE'), 'closed thinking must leave the DOM');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, runtimeHub: new ChatRuntimeHub(store) }), /THINK_MARKER_ONE/u);
});

test('the outer turn badge sums the live bubble counters once and labels them run tokens', () => {
  // Live rows hold no self-derived estimate; the usage frame is what gives them their counts.
  const store = buildThinkingStore({ content: '12345678', images: [], operationKind: 'repo-agent', marker: '12345678' }, [
    { kind: 'answer', delta: { turn: 1, offset: 0, text: '12345678' } },
    { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { promptTokens: 100, thinkingTokens: 2, outputTokens: 2, generatedChars: 16 } }) },
  ]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    runtimeHub: new ChatRuntimeHub(store),
    chatMode: 'repo-agent',
    isRepoToolMode: true,
  });

  // Every token badge on the page, in DOM order: the submitted user row, then the run total and
  // the two bubbles it sums. Asserting the whole list is what proves no badge claims an estimate
  // and no bubble is counted twice.
  assert.deepEqual(readTokenBadges(html), ['0 tokens', '4 run tokens', '2 tokens']);
  assert.deepEqual(readTokenBadges(renderExpanded({ selectedSessionId: SESSION_B.id, runtimeHub: new ChatRuntimeHub(store) })), ['0 tokens', '4 run tokens', '2 tokens', '2 tokens']);
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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
  });
  const logicStart = html.indexOf('<details class="internal-logic">');
  const logicEnd = html.indexOf('</details>', logicStart);
  const logic = html.slice(logicStart, logicEnd);
  assert.ok(logicStart >= 0, 'Internal Logic must contain the completed live activity');
  assert.doesNotMatch(logic, /Running command\u2026/u, 'closed Internal Logic does not mount tool cards');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, runtimeHub: new ChatRuntimeHub(store) }), /Running command\u2026/u);
  assert.ok(!html.includes('Recent activity'), 'the visible activity ring ends when answer streaming begins');
  assert.ok(html.includes('FINAL_ANSWER_MARKER'), 'the final answer remains visible');
});

test('raw streamed model progress renders only inside closed Internal Logic', () => {
  const store = buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_PROGRESS' }, [
    { kind: 'progress', delta: { turn: 1, offset: 0, text: 'PROGRESS_MARKER_ONE' } },
    { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4,
      activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER', promptTokenCount: 0,
    } },
    { kind: 'progress', delta: { turn: 2, offset: 0, text: 'PROGRESS_MARKER_TWO' } },
  ]);
  const html = render({
    selectedSessionId: SESSION_B.id,
    runtimeHub: new ChatRuntimeHub(store),
  });
  assert.ok(!html.includes('PROGRESS_MARKER_ONE'), 'a newer progress event must replace the previous row text');
  assert.ok(!html.includes('PROGRESS_MARKER_TWO'), 'closed progress must leave the DOM');
  assert.ok(!html.includes('turn-progress-bar'), 'raw model progress must not render as an exposed block');
  const logicStart = html.indexOf('<details class="internal-logic">');
  const logicEnd = html.indexOf('</details>', logicStart);
  const logic = html.slice(logicStart, logicEnd);
  assert.ok(logicStart >= 0, 'Internal Logic must render');
  assert.ok(!logic.includes('PROGRESS_MARKER_TWO'), 'closed Internal Logic stays unmounted');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, runtimeHub: new ChatRuntimeHub(store) }), /PROGRESS_MARKER_TWO/u);
  assert.ok(html.includes('Recent activity'), 'the friendly activity ring remains visible before the answer');
});

test('the latest status update stays visible until a newer one or the answer replaces it', () => {
  const storeFor = (steps: LiveTranscriptStep[]) => (
    buildThinkingStore({ content: 'find it', images: [], operationKind: 'repo-search', marker: 'THINK_MARKER_STATUS' }, steps)
  );
  const renderSteps = (steps: LiveTranscriptStep[]) => {
    const store = storeFor(steps);
    return render({ selectedSessionId: SESSION_B.id, runtimeHub: new ChatRuntimeHub(store) });
  };
  const first: LiveTranscriptStep[] = [
    { kind: 'narration', delta: { turn: 1, offset: 0, text: 'STATUS_ONE' } },
    { kind: 'tool', tool: {
      kind: 'tool_start', toolCallId: 't1', turn: 1, maxTurns: 4,
      activityKind: 'command', activitySubject: { kind: 'none' }, command: 'TOOL_MARKER', promptTokenCount: 0,
    } },
  ];
  const second: LiveTranscriptStep[] = [...first, { kind: 'narration', delta: { turn: 2, offset: 0, text: 'STATUS_TWO' } }];

  const whileTool = renderSteps(first);
  assert.match(whileTool, /STATUS_ONE/u, 'the status stays visible while its tool runs');
  assert.match(whileTool, /Recent activity/u, 'the activity ring stays visible beside the status');

  const replaced = renderSteps(second);
  assert.match(replaced, /STATUS_TWO/u, 'a newer status takes the visible slot');
  assert.doesNotMatch(replaced, /STATUS_ONE/u, 'the older status moves into closed Internal Logic');
  assert.match(renderExpanded({ selectedSessionId: SESSION_B.id, runtimeHub: new ChatRuntimeHub(storeFor(second)) }), /STATUS_ONE/u);

  const answered = renderSteps([...second, { kind: 'answer', delta: { turn: 3, offset: 0, text: 'FINAL_MARKER' } }]);
  assert.match(answered, /FINAL_MARKER/u, 'the answer replaces the status');
  assert.doesNotMatch(answered, /STATUS_TWO/u, 'the replaced status moves into closed Internal Logic');
});

const QUEUE_ONE_ID = '4f9c1f9a-0000-4000-8000-000000000001';
const SEGMENT_TWO_THINKING = 'SEGMENT_TWO_THINKING';

/** A live run whose four thinking turns are interrupted by one delivered queued message. */
function buildSplitSegmentStore(sessionId: string, steps: readonly LiveTranscriptStep[] = []): ChatSessionRuntimeStore {
  return buildDefaultStore(sessionId)
    .apply({ kind: 'begin', sessionId, operationKind: 'repo-agent', operationId: OPERATION_ID })
    .apply(splitSegmentFrame(sessionId, steps));
}

function splitSegmentFrame(sessionId: string, steps: readonly LiveTranscriptStep[]) {
  return liveFrame(sessionId, [
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
  const hub = new ChatRuntimeHub(buildSplitSegmentStore(SESSION_B.id));
  const view = renderComponent(<ChatTab {...buildProps({
    selectedSessionId: SESSION_B.id,
    runtimeHub: hub,
    chatMode: 'repo-agent',
    isRepoToolMode: true,
  })} />);
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

    await act(async () => {
      hub.apply(splitSegmentFrame(SESSION_B.id, [{ kind: 'thinking', delta: { turn: 5, offset: SEGMENT_TWO_THINKING.length, text: ' keeps streaming' } }]));
    });

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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
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
    runtimeHub: new ChatRuntimeHub(store),
  })} />);
  for (const name of ['Manual', 'Auto', 'Approve all']) {
    assert.equal(screen.getByRole('button', { name }).hasAttribute('disabled'), false);
  }
});

test('the context bar and label grow with the calibrated streaming tail while a turn streams', () => {
  const usage = { ...CONTEXT_USAGE, totalUsedTokens: 40, chatUsedTokens: 40, remainingTokens: 60 };
  const idle = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, '')
    .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage: usage });
  const idleView = renderComponent(<ChatTab {...buildProps({
    runtimeHub: new ChatRuntimeHub(idle),
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
    runtimeHub: new ChatRuntimeHub(streaming),
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
    runtimeHub: new ChatRuntimeHub(streaming),
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
    runtimeHub: new ChatRuntimeHub(store),
  })} />);
  for (const name of ['Manual', 'Auto', 'Approve all']) {
    assert.equal(screen.getByRole('button', { name }).hasAttribute('disabled'), true);
  }
});

test('shows the loading spinner instead of the transcript while the selected session loads', () => {
  const html = renderToStaticMarkup(<ChatTab {...buildProps({ selectedSessionLoading: true })} />);
  assert.match(html, /session-loading/u);
  assert.match(html, /Loading session…/u);
});

function renderUsagePopover(contextUsage: ContextUsage): string {
  const store = new ChatSessionRuntimeStore()
    .ensureSession(SESSION_A.id, '')
    .apply({ kind: 'context-usage', sessionId: SESSION_A.id, contextUsage });
  const view = renderComponent(<ChatTab {...buildProps({
    showSettings: true, runtimeHub: new ChatRuntimeHub(store),
  })} />);
  const text = view.container.querySelector('.composer-settings-popover')?.textContent ?? '';
  view.unmount();
  return text;
}

test('the usage popover headlines the measured next prompt instead of the row sums', () => {
  const text = renderUsagePopover({
    ...CONTEXT_USAGE, totalUsedTokens: 70, chatUsedTokens: 40, remainingTokens: 30, estimatedTokenFallbackTokens: 12,
  });
  assert.match(text, /Context: 70 \/ 100 tokens \(measured\)/u);
  assert.doesNotMatch(text, /with tools|unavailable/u);
});

test('the usage popover keeps the row estimate breakdown for an unmeasured session', () => {
  const text = renderUsagePopover({
    ...CONTEXT_USAGE, usedTokensMeasured: false, totalUsedTokens: 70, chatUsedTokens: 40, remainingTokens: 30,
  });
  assert.match(text, /Context: 40 \/ 100 tokens/u);
  assert.match(text, /40 \(70 with tools\)/u);
});

test('the chat head offers Compact while idle and runs the condense operation', async () => {
  let condensed = 0;
  const view = renderComponent(<ChatTab {...buildProps({ onCondense: async () => { condensed += 1; } })} />);
  try {
    const button = screen.getByRole('button', { name: 'Compact' });
    assert.equal(button.hasAttribute('disabled'), false);
    await act(async () => { fireEvent.click(button); });
    assert.equal(condensed, 1);
  } finally { view.unmount(); }
});

test('Compact is disabled while a run is active or there is nothing to compact', () => {
  const busy = buildDefaultStore('session-a').apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message', operationId: OPERATION_ID });
  const busyView = renderComponent(<ChatTab {...buildProps({ runtimeHub: new ChatRuntimeHub(busy) })} />);
  try { assert.equal(screen.getByRole('button', { name: 'Compact' }).hasAttribute('disabled'), true); } finally { busyView.unmount(); }
  const emptyView = renderComponent(<ChatTab {...buildProps({ selectedSession: { ...SESSION_A, messages: [] } })} />);
  try { assert.equal(screen.getByRole('button', { name: 'Compact' }).hasAttribute('disabled'), true); } finally { emptyView.unmount(); }
});

test('an image the assistant showed renders in its bubble outside Internal Logic', () => {
  const session = { ...SESSION_A, messages: [
    msg({ id: 'q', role: 'user', kind: 'user_text', content: 'show me' }),
    msg({ id: 'img', kind: 'assistant_tool_call', toolCallCommand: 'show_image path="shot.png"', toolCallActivityKind: 'image',
      toolCallActivitySubject: { kind: 'file', value: 'shot.png' }, toolCallTurn: 1, toolCallMaxTurns: 5, toolCallExitCode: 0,
      toolCallStatus: 'done', toolCallExecutionState: 'completed', images: [IMAGE], imageMeta: [IMAGE_META], sourceRunId: 'run-1' }),
    msg({ id: 'a', kind: 'assistant_answer', content: 'Here it is.', sourceRunId: 'run-1' }),
  ] } satisfies ChatSession;
  const markup = render({ selectedSession: session });
  const turnStart = markup.indexOf('class="msg ai turn');
  const logicStart = markup.indexOf('Internal Logic');
  const imageAt = markup.indexOf('class="shown-images"');
  assert.ok(turnStart >= 0 && imageAt > turnStart);
  assert.ok(logicStart === -1 || imageAt > logicStart);
  assert.ok(imageAt < markup.indexOf('Here it is.'));
});

test('an actionable question renders the card and Cancel stops the run', async () => {
  let stopped = 0;
  const question = DurableChatQuestionSchema.parse({
    questionId: '4f9c1f9a-0000-4000-8000-00000000000e', toolCallId: 'call', question: 'Proceed?', choices: ['Yes'],
    requestedAtUtc: '2026-09-22T00:00:00.000Z', expiresAtUtc: '2999-01-01T00:00:00.000Z', outcome: null, decidedAtUtc: null, actionable: true,
  });
  const store = buildDefaultStore('session-b').apply({ kind: 'snapshot', sessionId: 'session-b',
    snapshot: chatSnapshot({ sessionId: 'session-b', operationKind: 'message', question }) });
  const view = renderComponent(<ChatTab {...buildProps({ selectedSessionId: 'session-b', runtimeHub: new ChatRuntimeHub(store),
    onStopOperation: async () => { stopped += 1; } })} />);
  try {
    assert.ok(screen.getByRole('region', { name: 'Question from the assistant' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    assert.equal(stopped, 1);
  } finally { view.unmount(); }
});

test('chat answers render through markdown blocks with whole-document output', () => {
  const content = '# Plan\n\nRun this:\n\n```bash\nnpm test\n\nnpm run lint\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone **now**.';
  // Blocks drop only the insignificant newline text nodes the whole-document render puts between block elements.
  const whole = renderToStaticMarkup(<MarkdownContent content={content} />).replaceAll('>\n<', '><');
  const markup = render({ selectedSession: { ...SESSION_A, messages: [msg({ id: 'a1', kind: 'assistant_answer', content })] } }).replaceAll('>\n<', '><');
  assert.ok(markup.includes(whole), 'block rendering diverged from whole-document rendering');
});

test('streamed tokens re-render the live transcript but never the ChatTab shell', async () => {
  const history = Array.from({ length: 30 }, (_, index) => msg({ id: `h${index}`, kind: 'assistant_answer', content: `**answer ${index}**` }));
  const session = { ...SESSION_A, messages: history };
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id));
  const frame = (text: string, sequence: number) => ({ kind: 'snapshot' as const, sessionId: SESSION_A.id,
    snapshot: chatSnapshot({ sessionId: SESSION_A.id, operationId: OPERATION_ID, cursor: { operationId: OPERATION_ID, sequence },
      messages: [createLiveMessage('live-answer', 'assistant_answer', 'assistant', text)] }) });
  await act(async () => hub.apply(frame('Hel', 1)));
  const view = renderComponent(<ChatTab {...buildProps({ selectedSession: session, runtimeHub: hub })} />);
  try {
    const shellRenders = await countRenders(ChatTab, async () => {
      for (let sequence = 2; sequence <= 6; sequence += 1) {
        await act(async () => hub.apply(frame(`Hel${'lo'.repeat(sequence)}`, sequence)));
      }
    });
    assert.equal(shellRenders, 0);
    await waitFor(() => assert.match(view.container.textContent ?? '', /Hellolololololo/u));
  } finally { view.unmount(); }
});

test('a composer edit re-renders the shell but neither transcript', async () => {
  const history = [msg({ id: 'u1', role: 'user', kind: 'user_text', content: 'question' }), msg({ id: 'a1', kind: 'assistant_answer', content: 'answer' })];
  const hub = new ChatRuntimeHub(buildDefaultStore(SESSION_A.id));
  const view = renderComponent(<ChatTab {...buildProps({ selectedSession: { ...SESSION_A, messages: history }, runtimeHub: hub })} />);
  try {
    const shellRenders = await countRenders(ChatTab, async () => {
      await act(async () => hub.apply({ kind: 'draft', sessionId: SESSION_A.id, draft: 't' }));
    });
    const historyRenders = await countRenders(MessageImages, async () => {
      await act(async () => hub.apply({ kind: 'draft', sessionId: SESSION_A.id, draft: 'ty' }));
    });
    assert.equal(shellRenders, 1);
    assert.equal(historyRenders, 0);
  } finally { view.unmount(); }
});

test('new handler identities from a controller re-render leave the stored history alone and still reach it', async () => {
  const history = [msg({ id: 'u1', role: 'user', kind: 'user_text', content: 'question' }), msg({ id: 'a1', kind: 'assistant_answer', content: 'answer' })];
  const props = buildProps({ selectedSession: { ...SESSION_A, messages: history }, runtimeHub: new ChatRuntimeHub(buildDefaultStore(SESSION_A.id)) });
  const view = renderComponent(<ChatTab {...props} />);
  const deleted: string[] = [];
  try {
    const historyRenders = await countRenders(MessageImages, async () => {
      await act(async () => {
        view.rerender(<ChatTab {...props} onDeleteMessage={async (id) => { deleted.push(id); }}
          onDeleteMessageImage={async () => {}} onDeleteTurn={async () => {}} />);
      });
    });
    assert.equal(historyRenders, 0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete message' })[0] ?? view.container);
    assert.deepEqual(deleted, ['u1']);
  } finally { view.unmount(); }
});
