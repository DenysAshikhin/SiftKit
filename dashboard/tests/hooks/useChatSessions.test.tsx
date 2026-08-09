import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render } from '../react-test-environment.js';

import {
  findSessionByIdStrict,
  pickFirstSessionId,
  upsertSession,
  useChatSessions,
} from '../../src/hooks/useChatSessions';
import { ChatSessionRuntimeStore } from '../../src/lib/chat-session-runtime-store';
import type { PendingImage } from '../../src/lib/downscale-image';
import { MANAGED_PRESET } from '../fixtures.js';
import type { ChatSession } from '../../src/types';

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
  condensedSummary: '',
  createdAtUtc: '2026-06-03T12:00:00.000Z',
  updatedAtUtc: '2026-06-03T12:00:00.000Z',
  messages: [],
};

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
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'message' });
  const sessions = upsertSession(
    [{ ...SESSION, id: 'session-a' }],
    { ...SESSION, id: 'session-b' },
  );
  assert.equal(sessions[0]?.id, 'session-b');
  assert.deepEqual(runtimeStore.get('session-a').activity, { kind: 'active', operationKind: 'message' });
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

async function sendImageForHeadroom(
  session: ChatSession,
  runtimeStatus: typeof RUNTIME_STATUS,
): Promise<{ toasts: Array<[string, string]>; sentBodies: string[] }> {
  const toasts: Array<[string, string]> = [];
  const originalFetch = globalThis.fetch;
  const sentBodies: string[] = [];
  const doneResponse = { session, contextUsage: CONTEXT_USAGE };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (typeof init?.body === 'string') {
      sentBodies.push(init.body);
    }
    if (url === '/dashboard/chat/sessions') {
      return new Response(JSON.stringify({ sessions: [session] }), { status: 200 });
    }
    if (url === '/dashboard/chat/sessions/s1') {
      return new Response(JSON.stringify(doneResponse), { status: 200 });
    }
    if (url === '/runtime/inference') {
      return new Response(JSON.stringify(runtimeStatus), { status: 200 });
    }
    return new Response(`event: done\ndata: ${JSON.stringify(doneResponse)}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  let sendMessage: (() => Promise<void>) | null = null;
  let setSessionImages: ((sessionId: string, images: PendingImage[]) => void) | null = null;
  function Probe(): React.JSX.Element {
    const result = useChatSessions({
      initialSelectedSessionId: 's1',
      refreshToken: 0,
      buildCreateSessionRequest: () => ({ title: 'x' }),
      confirmDeleteSession: () => true,
      enqueueToast: (level, text) => toasts.push([level, text]),
    });
    sendMessage = result.sendMessage;
    setSessionImages = result.setSessionImages;
    return React.createElement('output');
  }

  try {
    render(React.createElement(Probe));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(setSessionImages);
    act(() => {
      setSessionImages?.('s1', [{ dataUrl: 'data:image/png;base64,AAAA', note: null }]);
    });
    assert.ok(sendMessage);
    await act(async () => { await sendMessage?.(); });
    return { toasts, sentBodies };
  } finally {
    globalThis.fetch = originalFetch;
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
