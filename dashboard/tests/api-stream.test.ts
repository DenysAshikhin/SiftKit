import test from 'node:test';
import assert from 'node:assert/strict';
import { chatProjectionCapture, chatSnapshotFrames, errorRecord, projectionPackets, singleRecordFrames, terminalRecord } from './chat-snapshot-fixture.js';

const OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000000';

test('queue status reconnects after EOF and abort cancels further connections', async () => {
  const { streamChatQueue } = await import('../src/api');
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const controller = new AbortController();
  globalThis.fetch = async () => {
    requests++;
    return new Response(`event: queue\ndata: ${JSON.stringify({ sessionId: 's1', revision: requests, paused: false, force: null, messages: [] })}\n\n`);
  };
  try {
    const stream = streamChatQueue('s1', controller.signal);
    assert.deepEqual((await stream.next()).value, { kind: 'queue', queue: { sessionId: 's1', revision: 1, paused: false, force: null, messages: [] } });
    assert.deepEqual((await stream.next()).value, { kind: 'error', error: 'Queue connection ended; reconnecting.' });
    const second = await stream.next();
    assert.equal(second.done, false);
    assert.deepEqual(second.value, { kind: 'queue', queue: { sessionId: 's1', revision: 2, paused: false, force: null, messages: [] } });
    controller.abort();
    assert.equal((await stream.next()).done, true);
    assert.equal(requests, 2);
  } finally { controller.abort(); globalThis.fetch = originalFetch; }
});

test('queue transport failures are visible before reconnect and a later queue snapshot still arrives', async () => {
  const { streamChatQueue } = await import('../src/api');
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return requests === 1 ? new Response('unavailable', { status: 500 })
      : new Response(`event: queue\ndata: ${JSON.stringify({ sessionId: 's1', revision: 2, paused: false, force: null, messages: [] })}\n\n`);
  };
  try {
    const stream = streamChatQueue('s1', controller.signal);
    assert.deepEqual((await stream.next()).value, { kind: 'error', error: 'Queue connection failed (500).' });
    assert.deepEqual((await stream.next()).value, { kind: 'queue', queue: { sessionId: 's1', revision: 2, paused: false, force: null, messages: [] } });
    controller.abort();
    assert.equal((await stream.next()).done, true);
  } finally { controller.abort(); globalThis.fetch = originalFetch; }
});

const CAPTURE = chatProjectionCapture({ operationId: OPERATION_ID });
/** A complete operation stream body: one snapshot transfer followed by its terminal record. */
const SETTLED_BODY = projectionPackets(chatSnapshotFrames(CAPTURE)) + projectionPackets(singleRecordFrames(terminalRecord(CAPTURE.cursor)));

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

test('operation streams yield every projection frame in order, terminal included', async () => {
  const { streamPlanMessage, streamChatMessage, streamRepoSearchMessage } = await import('../src/api');
  for (const open of [streamPlanMessage, streamChatMessage, streamRepoSearchMessage]) {
    const restoreFetch = mockFetchOnce([SETTLED_BODY]);
    try {
      const indices: number[] = [];
      for await (const event of open('sess', { content: 'go', operationId: OPERATION_ID })) {
        assert.equal(event.kind, 'projection');
        if (event.kind === 'projection') indices.push(event.frame.recordIndex);
      }
      assert.deepEqual(indices, [...chatSnapshotFrames(CAPTURE).map((frame) => frame.recordIndex), 0],
        'every snapshot frame in order, then the terminal record as its own single-record transfer');
    } finally {
      restoreFetch();
    }
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
    return new Response(SETTLED_BODY, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    for await (const _event of streamPlanMessage('sess', { content: 'go', images: [image], operationId: OPERATION_ID })) {
      void _event;
    }
    for await (const _event of streamRepoSearchMessage('sess', { content: 'go', images: [image], operationId: OPERATION_ID })) {
      void _event;
    }
    assert.equal(bodies.length, 2);
    assert.equal(bodies.every((body) => body.includes('"images":["data:image/png;base64,AAAA"]')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an error record and a body that ends mid-transfer both surface as projection events for the assembler to judge', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([projectionPackets(singleRecordFrames(errorRecord({ error: 'boom' })))]);
  try {
    const kinds: string[] = [];
    for await (const event of streamPlanMessage('sess', { content: 'go', operationId: OPERATION_ID })) kinds.push(event.kind);
    assert.deepEqual(kinds, ['projection']);
  } finally {
    restoreFetch();
  }
  const truncated = mockFetchOnce([projectionPackets(chatSnapshotFrames(CAPTURE).slice(0, 2))]);
  try {
    let count = 0;
    for await (const event of streamPlanMessage('sess', { content: 'go', operationId: OPERATION_ID })) { void event; count += 1; }
    assert.equal(count, 2);
  } finally {
    truncated();
  }
});

test('streamPlanMessage throws on empty response body', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    let threw = false;
    try {
      for await (const _event of streamPlanMessage('sess', { content: 'go', operationId: OPERATION_ID })) {
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
      for await (const _event of streamPlanMessage('sess', { content: 'go', operationId: OPERATION_ID })) {
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
      for await (const _event of streamPlanMessage('sess', { content: 'go', operationId: OPERATION_ID })) {
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

test('stopChatOperation posts to the session stop endpoint and validates the response', async () => {
  const { stopChatOperation } = await import('../src/api');
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedMethod = '';
  let requestedBody = '';
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedMethod = init?.method ?? '';
    requestedBody = typeof init?.body === 'string' ? init.body : '';
    return new Response(JSON.stringify({ ok: true, operationKind: 'repo-agent' }), { status: 200 });
  };
  try {
    assert.deepEqual(
      await stopChatOperation('session one', '4f9c1f9a-0000-4000-8000-000000000000'),
      { ok: true, operationKind: 'repo-agent' },
    );
    assert.equal(requestedUrl, '/dashboard/chat/sessions/session%20one/stop');
    assert.equal(requestedMethod, 'POST');
    assert.deepEqual(JSON.parse(requestedBody), {
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('attachChatOperationStream reads the operation stream with GET and yields its frames', async () => {
  const { attachChatOperationStream } = await import('../src/api');
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requestedUrls.push(String(input));
    assert.equal(init?.method, 'GET');
    return new Response(SETTLED_BODY, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    let frames = 0;
    for await (const event of attachChatOperationStream('s1', new AbortController().signal)) {
      assert.equal(event.kind, 'projection');
      frames += 1;
    }
    assert.equal(frames, chatSnapshotFrames(CAPTURE).length + 1);
    assert.deepEqual(requestedUrls, ['/dashboard/chat/sessions/s1/operation/stream']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('attaching to an idle session raises ChatOperationIdleError', async () => {
  const { attachChatOperationStream, ChatOperationIdleError } = await import('../src/api');
  const restoreFetch = mockFetchStatus(404, JSON.stringify({ error: 'No active operation for this session.' }));
  try {
    await assert.rejects(
      (async () => {
        for await (const _event of attachChatOperationStream('s1', new AbortController().signal)) { void _event; }
      })(),
      (error: Error) => error instanceof ChatOperationIdleError,
    );
  } finally {
    restoreFetch();
  }
});

test('listActiveChatOperations parses the active operation listing', async () => {
  const { listActiveChatOperations } = await import('../src/api');
  const restoreFetch = mockFetchStatus(200, JSON.stringify({
    operations: [{
      sessionId: 's1',
      operationKind: 'repo-agent',
      operationId: '4f9c1f9a-0000-4000-8000-000000000000',
      startedAtUtc: '2026-09-08T12:00:00.000Z',
    }],
  }));
  try {
    const listed = await listActiveChatOperations();
    assert.equal(listed.operations[0]?.operationKind, 'repo-agent');
  } finally {
    restoreFetch();
  }
});
