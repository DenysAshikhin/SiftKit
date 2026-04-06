import test from 'node:test';
import assert from 'node:assert/strict';

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
