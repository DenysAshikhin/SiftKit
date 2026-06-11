import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { requestRepoSearchPlannerProtocolAction } from '../src/repo-search/planner-protocol.js';

const PREDICTED_MS = 4321;
const PREDICTED_N = 7;

type FakeLlamaServer = { baseUrl: string; lastBody: () => string; close: () => Promise<void> };

// Fake llama SSE server. Mirrors real llama.cpp: a cumulative `timings` object
// is attached to non-final chunks ONLY when the request asks for
// timings_per_token. The final chunk always carries timings (as real llama
// does), but the planner stops early and never consumes it. The server records
// the last request body so the body-flag test needs no monkey-patching.
function startFakeLlamaServer(): Promise<FakeLlamaServer> {
  return new Promise((resolve) => {
    let lastBody = '';
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        lastBody = raw;
        const perToken = raw.includes('"timings_per_token":true');
        const timings = {
          cache_n: 0,
          prompt_n: 3,
          prompt_ms: 30,
          predicted_n: PREDICTED_N,
          predicted_ms: PREDICTED_MS,
          predicted_per_second: (PREDICTED_N / PREDICTED_MS) * 1000,
        };
        const writeChunk = (delta: Record<string, unknown>, withTimings: boolean): void => {
          const payload: Record<string, unknown> = {
            choices: [{ index: 0, delta }],
            object: 'chat.completion.chunk',
          };
          if (withTimings) payload.timings = timings;
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // Two reasoning chunks that together form a complete finish action.
        writeChunk({ reasoning_content: '{"action":"finish",' }, perToken);
        writeChunk({ reasoning_content: '"output":"hi"}' }, perToken);
        // Final chunk: real llama always includes timings here. The planner has
        // already stopped, so this must NOT be the source of the captured value.
        res.write(`data: ${JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', delta: {} }],
          object: 'chat.completion.chunk',
          timings: { ...timings, predicted_ms: 999999 },
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
    baseUrl,
    model: 'mock',
    messages: [{ role: 'user', content: 'hi' }],
    timeoutMs: 5000,
    maxTokens: 64,
    thinkingEnabled: true,
    stream: true,
    toolDefinitions: [],
    onThinkingDelta: () => {},
  });
}

test('early-stopped streaming planner turn records real predicted_ms from per-chunk timings', async () => {
  const fake = await startFakeLlamaServer();
  try {
    const response = await runStreamingPlanner(fake.baseUrl);
    assert.equal(response.generationDurationMs, PREDICTED_MS);
    assert.equal(response.completionTokens, PREDICTED_N);
  } finally {
    await fake.close();
  }
});

test('streaming planner request body sets stream and timings_per_token', async () => {
  const fake = await startFakeLlamaServer();
  try {
    await runStreamingPlanner(fake.baseUrl);
    const parsed = JSON.parse(fake.lastBody()) as Record<string, unknown>;
    assert.equal(parsed.stream, true);
    assert.equal(parsed.timings_per_token, true);
  } finally {
    await fake.close();
  }
});
