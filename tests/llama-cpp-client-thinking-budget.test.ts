import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { LlamaCppClient } from '../src/llm-protocol/llama-cpp-client.js';
import {
  PLANNER_REASONING_BUDGET_MESSAGE,
  requestRepoSearchPlannerProtocolAction,
} from '../src/repo-search/planner-protocol.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { createEmptyPresetSystemContext } from './helpers/empty-preset-system-context.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';
import type { SiftConfig } from '../src/config/types.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';

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
        // Token-count probes (loop preflight) get a plain JSON answer and stay
        // out of the chat body index the assertions rely on.
        if (req.url === '/v1/token/encode' || req.url === '/tokenize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ length: 32 }));
          return;
        }
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

function budgetedConfig(
  backend: 'exl3' | 'llama',
  opts: { baseUrl?: string; stockBudgetMessage?: boolean } = {},
): SiftConfig {
  const preset = mockModelPreset({
    id: 'budget-test',
    label: 'budget test',
    Backend: backend,
    Reasoning: 'on',
    ReasoningBudget: 8,
    // stockBudgetMessage keeps the normalized default so tests can exercise the
    // "user did not customize the message" branch.
    ...(opts.stockBudgetMessage ? {} : { ReasoningBudgetMessage: 'Answer now.' }),
    // exl3 resolves its base URL from the preset, so token-count probes must
    // target the fake server rather than a real runtime port.
    ...(opts.baseUrl ? { BaseUrl: opts.baseUrl } : {}),
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

test('planner reasoningBudgetMessage overrides the preset message in the continuation', async () => {
  const fake = await startFakeStreamServer();
  try {
    const response = await requestRepoSearchPlannerProtocolAction({
      config: budgetedConfig('exl3'),
      baseUrl: fake.baseUrl,
      model: 'mock',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 5000,
      maxTokens: 64,
      thinkingEnabled: true,
      stream: true,
      toolDefinitions: [],
      onThinkingDelta: () => {},
      reasoningBudgetMessage: 'Emit the next action.',
    });

    assert.equal(fake.requestCount(), 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes('Emit the next action.'));
    assert.ok(!prefix.includes('Answer now.'));
    assert.ok(response.thinkingText.includes('Emit the next action.'));
  } finally {
    await fake.close();
  }
});

async function runBudgetedTaskLoop(
  baseUrl: string,
  loopKind: 'repo-search' | 'chat',
  opts: { stockBudgetMessage?: boolean } = {},
): Promise<void> {
  await runTaskLoop(
    { id: loopKind, question: 'hi', signals: [] },
    {
      repoRoot: os.tmpdir(),
      systemContext: createEmptyPresetSystemContext(),
      config: budgetedConfig('exl3', { baseUrl, stockBudgetMessage: opts.stockBudgetMessage }),
      model: 'mock',
      baseUrl,
      maxTurns: 2,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      loopKind,
      ...(loopKind === 'chat' ? { plannerToolDefinitions: [] } : {}),
      mockCommandResults: {},
      progressWriter: new CollectingProgressWriter(),
    },
  );
}

test('repo-search loop continuations use the planner action budget message', async () => {
  const fake = await startFakeStreamServer();
  try {
    await runBudgetedTaskLoop(fake.baseUrl, 'repo-search', { stockBudgetMessage: true });

    assert.ok(fake.requestCount() >= 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes(PLANNER_REASONING_BUDGET_MESSAGE));
    assert.ok(!prefix.includes('You have to provide the answer now.'));
  } finally {
    await fake.close();
  }
});

test('repo-search loop keeps a user-customized preset budget message', async () => {
  const fake = await startFakeStreamServer();
  try {
    await runBudgetedTaskLoop(fake.baseUrl, 'repo-search');

    assert.ok(fake.requestCount() >= 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes('Answer now.'));
    assert.ok(!prefix.includes(PLANNER_REASONING_BUDGET_MESSAGE));
  } finally {
    await fake.close();
  }
});

test('chat loop continuations keep the preset budget message', async () => {
  const fake = await startFakeStreamServer();
  try {
    await runBudgetedTaskLoop(fake.baseUrl, 'chat');

    assert.ok(fake.requestCount() >= 2);
    const prefix = String(fake.bodyAt(1).response_prefix);
    assert.ok(prefix.includes('Answer now.'));
    assert.ok(!prefix.includes(PLANNER_REASONING_BUDGET_MESSAGE));
  } finally {
    await fake.close();
  }
});

test('planner loop on llama backend warns that the planner budget message cannot apply', async () => {
  const runWithLogger = async (loopKind: 'repo-search' | 'chat'): Promise<Record<string, JsonSerializable>[]> => {
    const events: Record<string, JsonSerializable>[] = [];
    await runTaskLoop(
      { id: loopKind, question: 'hi', signals: [] },
      {
        repoRoot: os.tmpdir(),
        systemContext: createEmptyPresetSystemContext(),
        config: budgetedConfig('llama'),
        model: 'mock',
        baseUrl: DEAD_BASE_URL,
        maxTurns: 2,
        maxInvalidResponses: 2,
        minToolCallsBeforeFinish: 0,
        loopKind,
        ...(loopKind === 'chat' ? { plannerToolDefinitions: [] } : {}),
        mockResponses: ['{"action":"finish","output":"done"}'],
        mockCommandResults: {},
        logger: { path: 'memory', write: (event) => { events.push(event); } },
      },
    );
    return events;
  };

  const plannerEvents = await runWithLogger('repo-search');
  assert.ok(plannerEvents.some((event) => event.kind === 'planner_budget_backend_gap'));

  const chatEvents = await runWithLogger('chat');
  assert.ok(!chatEvents.some((event) => event.kind === 'planner_budget_backend_gap'));
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
