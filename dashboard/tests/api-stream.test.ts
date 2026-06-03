import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSessionResponse } from '../src/types';

const SAMPLE_DONE: ChatSessionResponse = {
  session: {
    id: 's',
    title: 't',
    model: null,
    contextWindowTokens: 0,
    condensedSummary: '',
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
    totalUsedTokens: 0,
    remainingTokens: 0,
    warnThresholdTokens: 0,
    shouldCondense: false,
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

test('streamPlanMessage forwards toolCallId from SSE payload to onToolEvent', async () => {
  const { streamPlanMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([
    'event: tool_start\ndata: {"toolCallId":"tc_0","turn":1,"maxTurns":1,"command":"x"}\n\n',
    `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`,
  ]);
  try {
    const captured: Array<{ toolCallId: string; command: string }> = [];
    const result = await streamPlanMessage(
      'sess',
      { content: 'go' },
      () => {},
      (event) => captured.push({ toolCallId: event.toolCallId, command: event.command }),
    );
    assert.deepEqual(captured, [{ toolCallId: 'tc_0', command: 'x' }]);
    assert.equal(result.session.id, 's');
  } finally {
    restoreFetch();
  }
});

test('streamRepoSearchMessage forwards toolCallId from SSE payload to onToolEvent', async () => {
  const { streamRepoSearchMessage } = await import('../src/api');
  const restoreFetch = mockFetchOnce([
    'event: tool_result\ndata: {"toolCallId":"tc_1","turn":1,"maxTurns":1,"command":"y","exitCode":0,"outputSnippet":"ok"}\n\n',
    `event: done\ndata: ${JSON.stringify(SAMPLE_DONE)}\n\n`,
  ]);
  try {
    const captured: Array<{ toolCallId: string; kind: string }> = [];
    const result = await streamRepoSearchMessage(
      'sess',
      { content: 'go' },
      () => {},
      (event) => captured.push({ toolCallId: event.toolCallId, kind: event.kind }),
    );
    assert.deepEqual(captured, [{ toolCallId: 'tc_1', kind: 'tool_result' }]);
    assert.equal(result.session.id, 's');
  } finally {
    restoreFetch();
  }
});
