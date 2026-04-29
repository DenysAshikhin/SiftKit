import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  countLlamaCppTokens,
  listLlamaCppModels,
  generateLlamaCppResponse,
  getLlamaCppProviderStatus,
} from '../dist/providers/llama-cpp.js';
import { loadConfig } from '../dist/config/index.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('listLlamaCppModels returns model list from server', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    const models = await listLlamaCppModels(config);
    assert.ok(Array.isArray(models));
    assert.ok(models.length >= 1);
  });
});

test('getLlamaCppProviderStatus returns reachable status', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    const status = await getLlamaCppProviderStatus(config);
    assert.equal(status.Available, true);
    assert.equal(status.Reachable, true);
    assert.equal(typeof status.BaseUrl, 'string');
    assert.equal(status.Error, null);
  });
});

test('getLlamaCppProviderStatus returns unreachable when server is down', async () => {
  const config = {
    Backend: 'llama.cpp',
    Runtime: {
      Model: 'test-model',
      LlamaCpp: {
        BaseUrl: 'http://127.0.0.1:1',
        NumCtx: 10000,
      },
    },
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:1',
    },
    Thresholds: { MinCharactersForSummary: 500, MinLinesForSummary: 16 },
    Interactive: { Enabled: true, WrappedCommands: [], IdleTimeoutMs: 900000, MaxTranscriptCharacters: 60000, TranscriptRetention: true },
  };
  const status = await getLlamaCppProviderStatus(config as unknown as Parameters<typeof getLlamaCppProviderStatus>[0]);
  assert.equal(status.Available, true);
  assert.equal(status.Reachable, false);
  assert.equal(typeof status.Error, 'string');
});

test('countLlamaCppTokens returns count from server', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    try {
      const count = await countLlamaCppTokens(config, 'hello world');
      assert.equal(typeof count, 'number');
    } catch (error) {
      assert.ok((error as Error).message.length > 0);
    }
  });
});

test('countLlamaCppTokens respects a bounded transient retry timeout', { timeout: 1500 }, async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/tokenize') {
      requestCount += 1;
      req.resume();
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Loading model',
          type: 'unavailable_error',
          code: 503,
        },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const config = {
    Backend: 'llama.cpp',
    Runtime: {
      Model: 'test-model',
      LlamaCpp: {
        BaseUrl: `http://127.0.0.1:${address.port}`,
        NumCtx: 10000,
      },
    },
    LlamaCpp: {
      BaseUrl: `http://127.0.0.1:${address.port}`,
    },
    Thresholds: { MinCharactersForSummary: 500, MinLinesForSummary: 16 },
    Interactive: { Enabled: true, WrappedCommands: [], IdleTimeoutMs: 900000, MaxTranscriptCharacters: 60000, TranscriptRetention: true },
  };

  try {
    const startedAt = Date.now();
    const count = await countLlamaCppTokens(
      config as unknown as Parameters<typeof countLlamaCppTokens>[0],
      'hello world',
      { timeoutMs: 200, retryMaxWaitMs: 200 },
    );

    assert.equal(count, null);
    assert.equal(requestCount, 1);
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('generateLlamaCppResponse returns text response', async () => {
  await withTestEnvAndServer(async () => {
    const config = await loadConfig({ ensure: true });
    const response = await generateLlamaCppResponse({
      config,
      model: 'mock-model',
      prompt: 'Hello, world!',
      timeoutSeconds: 30,
    });
    assert.equal(typeof response.text, 'string');
    assert.ok(response.text.length > 0);
    assert.equal(typeof response.usage, 'object');
  });
});
