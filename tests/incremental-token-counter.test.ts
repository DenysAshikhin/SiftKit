import test from 'node:test';
import assert from 'node:assert/strict';

import { IncrementalTokenCounter } from '../src/repo-search/incremental-token-counter.js';
import type { InferenceBackendId } from '../src/config/types.js';
import type { SiftConfig } from '../src/config/index.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { asRuntimeSiftConfig } from './helpers/mock-config.js';

function activateEngine(config: SiftConfig, engine: InferenceBackendId): SiftConfig {
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Stub config has no model preset to activate.');
  }
  preset.Backend = engine;
  config.Server.ModelPresets.ActivePresetId = preset.id;
  return config;
}

// The stub counts tokens as content.length so full-vs-delta requests are
// distinguishable by both the recorded content and the returned count.
function trackingTokenizer(seen: string[]): (content: string) => number {
  return (content) => {
    seen.push(content);
    return content.length;
  };
}

test('first count tokenizes the full text', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    const result = await counter.count(config, 'alpha beta');
    assert.equal(result.tokenCount, 'alpha beta'.length);
    assert.equal(result.source, 'exl3');
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an appended tail tokenizes only the delta and sums with the cache', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta gamma');
    assert.equal(result.tokenCount, 'alpha beta gamma'.length);
    assert.equal(result.approximate, true);
    assert.deepEqual(seen, ['alpha beta', ' gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an identical text returns the cached count without tokenizing', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta');
    assert.equal(result.tokenCount, 'alpha beta'.length);
    assert.equal(result.llamaTokenCount, null);
    assert.deepEqual(seen, ['alpha beta']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('a changed prefix forces a full re-tokenize', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'ALPHA beta gamma');
    assert.equal(result.tokenCount, 'ALPHA beta gamma'.length);
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta', 'ALPHA beta gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('forceExact re-tokenizes the full text even for a pure append', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta gamma', { forceExact: true });
    assert.equal(result.tokenCount, 'alpha beta gamma'.length);
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta', 'alpha beta gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an estimate fallback never updates the cache', async () => {
  const seen: string[] = [];
  let serverUp = true;
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    serverUp = false;
    const estimated = await counter.count(config, 'alpha beta gamma');
    assert.equal(estimated.source, 'estimate');
    assert.equal(estimated.approximate, true);

    serverUp = true;
    // The cache still holds 'alpha beta', so this is a delta from that prefix.
    const recovered = await counter.count(config, 'alpha beta gamma delta');
    assert.equal(recovered.tokenCount, 'alpha beta gamma delta'.length);
    assert.deepEqual(seen, ['alpha beta', ' gamma delta']);
  }, {
    tokenizeTokenCount: (content) => {
      if (!serverUp) {
        return null;
      }
      seen.push(content);
      return content.length;
    },
  });
});

test('no config uses the estimate without caching', async () => {
  const counter = new IncrementalTokenCounter();
  const result = await counter.count(undefined, 'alpha beta');
  assert.equal(result.source, 'estimate');
  assert.equal(result.approximate, false);
  assert.equal(result.tokenCount > 0, true);
});
