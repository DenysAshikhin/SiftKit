import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  generateChatAssistantMessage,
  streamChatAssistantMessage,
} from '../src/status-server/chat.js';

type JsonObject = Record<string, unknown>;

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  try {
    const address = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function buildConfig(baseUrl: string): JsonObject {
  return {
    Runtime: {
      Model: 'mock-model',
      LlamaCpp: {
        BaseUrl: baseUrl,
      },
    },
    Server: {
      LlamaCpp: {
        BaseUrl: baseUrl,
        ReasoningContent: true,
        PreserveThinking: true,
      },
    },
    LlamaCpp: {},
  };
}

function buildSession(): JsonObject {
  const now = new Date().toISOString();
  return {
    id: 'session-1',
    title: 'Session',
    model: 'mock-model',
    contextWindowTokens: 4096,
    condensedSummary: '',
    createdAtUtc: now,
    updatedAtUtc: now,
    messages: [],
    hiddenToolContexts: [],
  };
}

test('generateChatAssistantMessage uses llama timings for direct chat telemetry', async () => {
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'ok',
          },
        },
      ],
      timings: {
        cache_n: 7,
        prompt_n: 14,
        prompt_ms: 111.5,
        prompt_per_second: 125.56,
        predicted_n: 3,
        predicted_ms: 22.25,
        predicted_per_second: 134.83,
      },
    }));
  }, async (baseUrl) => {
    const result = await generateChatAssistantMessage(
      buildConfig(baseUrl) as never,
      buildSession() as never,
      'say ok',
    );

    assert.equal(result.assistantContent, 'ok');
    assert.equal(result.usage.promptCacheTokens, 7);
    assert.equal(result.usage.promptEvalTokens, 14);
    assert.equal(result.usage.completionTokens, 3);
    assert.equal(result.usage.promptEvalDurationMs, 111.5);
    assert.equal(result.usage.generationDurationMs, 22.25);
    assert.equal(result.usage.promptTokensPerSecond, 125.56);
    assert.equal(result.usage.outputTokensPerSecond, 134.83);
  });
});

test('streamChatAssistantMessage uses llama timings from the final SSE chunk when usage is absent', async () => {
  await withServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: {"choices":[{"finish_reason":"stop","delta":{}}],"timings":{"cache_n":5,"prompt_n":11,"prompt_ms":91.25,"prompt_per_second":120.55,"predicted_n":2,"predicted_ms":18.5,"predicted_per_second":108.1},"__verbose":{"tokens_predicted":2,"timings":{"cache_n":5,"prompt_n":11,"prompt_ms":91.25,"prompt_per_second":120.55,"predicted_n":2,"predicted_ms":18.5,"predicted_per_second":108.1}}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }, async (baseUrl) => {
    const result = await streamChatAssistantMessage(
      buildConfig(baseUrl) as never,
      buildSession() as never,
      'say ok',
      null,
    );

    assert.equal(result.assistantContent, 'ok');
    assert.equal(result.usage.promptCacheTokens, 5);
    assert.equal(result.usage.promptEvalTokens, 11);
    assert.equal(result.usage.completionTokens, 2);
    assert.equal(result.usage.promptEvalDurationMs, 91.25);
    assert.equal(result.usage.generationDurationMs, 18.5);
    assert.equal(result.usage.promptTokensPerSecond, 120.55);
    assert.equal(result.usage.outputTokensPerSecond, 108.1);
  });
});
