import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import { requestRepoSearchPlannerProtocolAction } from '../src/repo-search/planner-protocol.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import type { SiftConfig } from '../src/config/types.js';
import type { JsonObject } from '../src/lib/json-types.js';

type FakeStreamServer = {
  baseUrl: string;
  requestCount: () => number;
  bodyAt: (index: number) => JsonObject;
  close: () => Promise<void>;
};

// Fake OpenAI-compatible SSE server. Request 1 streams only reasoning deltas —
// enough to blow a tiny ReasoningBudget — then a content action and [DONE].
// Every later request does the same minus the reasoning, so a continuation
// request completes immediately with the action payload.
function startFakeStreamServer(): Promise<FakeStreamServer> {
  return new Promise((resolve) => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        bodies.push(raw);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const writeDelta = (delta: JsonObject): void => {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }], object: 'chat.completion.chunk' })}\n\n`);
        };
        // Prompt usage rides the first frame of every request, so the first
        // request's stats survive the mid-stream budget abort.
        const promptUsage = bodies.length === 1
          ? { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 } }
          : { prompt_tokens: 110, prompt_tokens_details: { cached_tokens: 100 } };
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], object: 'chat.completion.chunk', usage: promptUsage })}\n\n`);
        if (bodies.length === 1) {
          // 10 chunks x 8 chars = 80 reasoning chars (> 8 tokens x 4 chars/token).
          for (let index = 0; index < 10; index += 1) {
            writeDelta({ reasoning_content: `reason${String(index).padStart(2, '0')}` });
          }
        }
        writeDelta({ content: '{"action":"finish","output":"done"}' });
        res.write('data: [DONE]\n\n');
        res.end();
      });
      // The client may destroy the socket mid-stream (budget early stop).
      res.on('error', () => {});
      req.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requestCount: () => bodies.length,
        bodyAt: (index: number) => asObject(parseJsonValueText(bodies[index] ?? '{}')),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function budgetedConfig(backend: 'exl3' | 'llama'): SiftConfig {
  const preset = mockModelPreset({
    id: 'budget-test',
    label: 'budget test',
    Backend: backend,
    Reasoning: 'on',
    ReasoningBudget: 8,
    ReasoningBudgetMessage: 'Answer now.',
  });
  return mockSiftConfig({
    Server: { ModelPresets: { Presets: [preset], ActivePresetId: 'budget-test' } },
  });
}

async function runStreamingPlanner(baseUrl: string, config: SiftConfig): Promise<Awaited<ReturnType<typeof requestRepoSearchPlannerProtocolAction>>> {
  return requestRepoSearchPlannerProtocolAction({
    config,
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

test('exl3 streaming enforces ReasoningBudget with a response_prefix continuation', async () => {
  const fake = await startFakeStreamServer();
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('exl3'));

    assert.equal(fake.requestCount(), 2);
    assert.ok(!('response_prefix' in fake.bodyAt(0)));
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.startsWith('<think>\n'));
    assert.ok(prefix.includes('reason00'));
    assert.ok(prefix.includes('Answer now.'));
    assert.ok(prefix.trimEnd().endsWith('</think>'));

    assert.match(response.text, /"action"\s*:\s*"finish"/u);
    assert.ok(response.thinkingText.includes('reason00'));
    assert.ok(response.thinkingText.includes('Answer now.'));
    assert.equal(response.thinkingBudgetExhausted, true);

    // Both requests' prefill work is billed: 60 + 100 cached, 40 + 10 evaluated.
    assert.equal(response.promptCacheTokens, 160);
    assert.equal(response.promptEvalTokens, 50);
  } finally {
    await fake.close();
  }
});

test('exl3 budget enforcement applies when reasoning comes from the preset default', async () => {
  const fake = await startFakeStreamServer();
  try {
    const response = await new LlamaCppClient().chat({
      config: budgetedConfig('exl3'),
      baseUrl: fake.baseUrl,
      model: 'mock',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxTokens: 64,
      stream: true,
      allowedToolNames: [],
      retryMaxWaitMs: 0,
    });
    assert.equal(fake.requestCount(), 2);
    assert.equal(response.thinkingBudgetExhausted, true);
  } finally {
    await fake.close();
  }
});

test('llama backend streaming never enforces the budget client-side', async () => {
  const fake = await startFakeStreamServer();
  try {
    const response = await runStreamingPlanner(fake.baseUrl, budgetedConfig('llama'));

    assert.equal(fake.requestCount(), 1);
    assert.ok(!('response_prefix' in fake.bodyAt(0)));
    assert.match(response.text, /"action"\s*:\s*"finish"/u);
    assert.equal(response.thinkingBudgetExhausted, undefined);
  } finally {
    await fake.close();
  }
});
