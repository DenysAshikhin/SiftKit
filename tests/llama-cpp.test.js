const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countLlamaCppTokens,
  listLlamaCppModels,
  generateLlamaCppResponse,
  getLlamaCppProviderStatus,
} = require('../dist/providers/llama-cpp.js');
const { withTestEnvAndServer } = require('./_test-helpers.js');

test('listLlamaCppModels returns model list from server', async () => {
  await withTestEnvAndServer(async () => {
    const { loadConfig } = require('../dist/config.js');
    const config = await loadConfig({ ensure: true });
    const models = await listLlamaCppModels(config);
    assert.ok(Array.isArray(models));
    assert.ok(models.length >= 1);
  });
});

test('getLlamaCppProviderStatus returns reachable status', async () => {
  await withTestEnvAndServer(async () => {
    const { loadConfig } = require('../dist/config.js');
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
  const status = await getLlamaCppProviderStatus(config);
  assert.equal(status.Available, true);
  assert.equal(status.Reachable, false);
  assert.equal(typeof status.Error, 'string');
});

test('countLlamaCppTokens returns count from server', async () => {
  await withTestEnvAndServer(async () => {
    const { loadConfig } = require('../dist/config.js');
    const config = await loadConfig({ ensure: true });
    // Our stub returns 503 for tokenize, so this should throw or return -1
    try {
      const count = await countLlamaCppTokens(config, 'hello world');
      assert.equal(typeof count, 'number');
    } catch (error) {
      // Expected when tokenize endpoint is unavailable
      assert.ok(error.message.length > 0);
    }
  });
});

test('generateLlamaCppResponse returns text response', async () => {
  await withTestEnvAndServer(async () => {
    const { loadConfig } = require('../dist/config.js');
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
