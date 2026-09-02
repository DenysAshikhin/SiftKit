import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { requestRepoSearchPlannerProtocolAction } from '../src/repo-search/planner-protocol.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import type { JsonObject } from '../src/lib/json-types.js';

type FakeInferenceServer = { baseUrl: string; lastBody: () => string; close: () => Promise<void> };

// Fake OpenAI-compatible SSE server shaped like TabbyAPI: chunks carry deltas only, never a
// llama.cpp `timings` object, so generation duration must come from the client's own clock.
function startFakeInferenceServer(): Promise<FakeInferenceServer> {
  return new Promise((resolve) => {
    let lastBody = '';
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        lastBody = raw;
        const writeChunk = (delta: JsonObject): void => {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }], object: 'chat.completion.chunk' })}\n\n`);
        };
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        writeChunk({ reasoning_content: 'inspect evidence' });
        writeChunk({ content: 'final answer' });
        res.write(`data: ${JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
          object: 'chat.completion.chunk',
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        lastBody: () => lastBody,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

async function runStreamingPlanner(baseUrl: string): Promise<Awaited<ReturnType<typeof requestRepoSearchPlannerProtocolAction>>> {
  return requestRepoSearchPlannerProtocolAction({
    config: mockOfflineSiftConfig(),
    baseUrl,
    model: 'mock',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    maxTokens: 64,
    thinkingEnabled: true,
    reasoningContentEnabled: false,
    preserveThinking: false,
    stage: 'planner_action',
    tools: [],
    responseSchema: null,
    onThinkingDelta: () => {},
  });
}

test('streaming planner turn measures generation duration on the client clock', async () => {
  const fake = await startFakeInferenceServer();
  try {
    const response = await runStreamingPlanner(fake.baseUrl);
    assert.equal(typeof response.generationDurationMs, 'number');
    assert.ok(Number(response.generationDurationMs) >= 0);
  } finally {
    await fake.close();
  }
});

test('streaming planner request body sets stream and carries no llama.cpp timing flag', async () => {
  const fake = await startFakeInferenceServer();
  try {
    await runStreamingPlanner(fake.baseUrl);
    const parsed = asObject(parseJsonValueText(fake.lastBody()));
    assert.equal(parsed.stream, true);
    assert.equal('timings_per_token' in parsed, false);
  } finally {
    await fake.close();
  }
});
