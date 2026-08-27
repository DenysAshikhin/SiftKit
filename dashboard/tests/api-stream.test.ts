import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSessionResponse } from '../src/types';

const SAMPLE_DONE: ChatSessionResponse = {
  session: {
    id: 's',
    title: 't',
    modelPresetId: 'test-model',
    model: null,
    contextWindowTokens: 0,
    createdAtUtc: '2026-06-03T00:00:00.000Z',
    updatedAtUtc: '2026-06-03T00:00:00.000Z',
    messages: [],
  },
  contextUsage: {
    contextWindowTokens: 0,
    usedTokens: 0,
    chatUsedTokens: 0,
    thinkingUsedTokens: 0,
    toolUsedTokens: 0,
    imageUsedTokens: 0,
    totalUsedTokens: 0,
    remainingTokens: 0,
    warnThresholdTokens: 0,
    shouldCondense: false,
    estimatedTokenFallbackTokens: 0,
    providerOverheadTokens: 0,
  },
};

function mockFetchOnce(frames: string[]): () => void {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  return () => { globalThis.fetch = originalFetch; };
}

function mockFetchStatus(status: number, bodyText: string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bodyText, { status, headers: { 'Content-Type': 'application/json' } });
  return () => { globalThis.fetch = originalFetch; };
}

test('streamPlanMessage yields typed tool and done events in order', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([
    'event: tool_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":1,"toolCallLimit":1,"activityKind":"command","activitySubject":{"kind":"none"},"command":"x","promptTokenCount":0}\n\n',
    `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`,
  ]);
  try {
    const eventKinds: string[] = [];
    for await (const event of streamPlanMessage('sess', { content: 'go' })) {
      eventKinds.push(event.kind);
    }
    assert.deepEqual(eventKinds, ['tool', 'done']);
  } finally {
    restoreFetch();
  }
});

test('streamChatMessage yields thinking, answer, and done events', async () => {
  const { streamChatMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([
    'event: thinking\ndata: {"turn":1,"offset":0,"text":"planning"}\n\n',
    'event: answer\ndata: {"turn":1,"offset":0,"text":"result"}\n\n',
    `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`,
  ]);
  try {
    const eventKinds: string[] = [];
    for await (const event of streamChatMessage('sess', { content: 'hi' })) {
      eventKinds.push(event.kind);
    }
    assert.deepEqual(eventKinds, ['thinking', 'answer', 'done']);
  } finally {
    restoreFetch();
  }
});

test('streamRepoSearchMessage yields warning and done events', async () => {
  const { streamRepoSearchMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([
    'event: warning\ndata: {"warning":"missing file"}\n\n',
    `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`,
  ]);
  try {
    const events: Array<{ kind: string; text?: string }> = [];
    for await (const event of streamRepoSearchMessage('sess', { content: 'go' })) {
      if (event.kind === 'warning') events.push({ kind: 'warning', text: event.text });
      else if (event.kind === 'done') events.push({ kind: 'done' });
    }
    assert.deepEqual(events, [{ kind: 'warning', text: 'missing file' }, { kind: 'done' }]);
  } finally {
    restoreFetch();
  }
});

test('plan and repo-search stream requests include attached images', async () => {
  const { streamPlanMessage, streamRepoSearchMessage } = await import('../src/api');
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  const image = 'data:image/png;base64,AAAA';
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      bodies.push(init.body);
    }
    const body = `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    for await (const _event of streamPlanMessage('sess', { content: 'go', images: [image] })) {
      void _event;
    }
    for await (const _event of streamRepoSearchMessage('sess', { content: 'go', images: [image] })) {
      void _event;
    }
    assert.equal(bodies.length, 2);
    assert.equal(bodies.every((body) => body.includes('"images":["data:image/png;base64,AAAA"]')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamPlanMessage throws on server error event', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([
    'event: error\ndata: {"error":"boom"}\n\n',
  ]);
  try {
    let threw = false;
    try {
      for await (const _event of streamPlanMessage('sess', { content: 'go' })) {
        void _event;
      }
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'boom');
    }
    assert.equal(threw, true);
  } finally {
    restoreFetch();
  }
});

test('streamPlanMessage throws when done event is missing', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([
    'event: thinking\ndata: {"turn":1,"offset":0,"text":"partial"}\n\n',
  ]);
  try {
    let threw = false;
    try {
      for await (const _event of streamPlanMessage('sess', { content: 'go' })) {
        void _event;
      }
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error);
      assert.match(error.message, /Missing final streaming payload/u);
    }
    assert.equal(threw, true);
  } finally {
    restoreFetch();
  }
});

test('streamPlanMessage throws on empty response body', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    let threw = false;
    try {
      for await (const _event of streamPlanMessage('sess', { content: 'go' })) {
        void _event;
      }
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error);
      assert.match(error.message, /Streaming response body was empty/u);
    }
    assert.equal(threw, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamPlanMessage throws ChatSessionBusyError on valid 409', async () => {
  const { streamPlanMessage, ChatSessionBusyError } = await import('../src/api');
  const busyBody = JSON.stringify({
    error: 'Chat session already has an active operation.',
    sessionId: 'sess',
    operationKind: 'message',
  });
  const restoreFetch = mockFetchStatus(409, busyBody);
  try {
    let threw = false;
    try {
      for await (const _event of streamPlanMessage('sess', { content: 'go' })) {
        void _event;
      }
    } catch (error) {
      threw = true;
      assert.ok(error instanceof ChatSessionBusyError);
      assert.equal(error.response.sessionId, 'sess');
      assert.equal(error.response.operationKind, 'message');
    }
    assert.equal(threw, true);
  } finally {
    restoreFetch();
  }
});

test('streamPlanMessage throws generic error on malformed 409', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const restoreFetch = mockFetchStatus(409, '{"bad":true}');
  try {
    let threw = false;
    try {
      for await (const _event of streamPlanMessage('sess', { content: 'go' })) {
        void _event;
      }
    } catch (error) {
      threw = true;
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Request failed (409): {"bad":true}');
    }
    assert.equal(threw, true);
  } finally {
    restoreFetch();
  }
});
