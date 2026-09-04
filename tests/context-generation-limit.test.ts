import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFinalGenerationTokenLimit,
  resolveGenerationTokenLimit,
} from '../src/lib/context-token-budget.js';

test('generation uses the window still free at the current prompt position', () => {
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 0 }), 155_000);
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 285 }), 154_715);
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 100_000 }), 55_000);
});

// The reserve caps how large a prompt may grow, not how much a request may generate,
// so a prompt admitted at the very top of its budget still has the reserve to answer in.
test('a prompt at the top of its budget still generates into the compaction reserve', () => {
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 140_000 }), 15_000);
  assert.equal(resolveGenerationTokenLimit({ totalContextTokens: 32_000, promptTokenCount: 17_000 }), 15_000);
});

test('an explicit operation cap may only lower the context-derived limit', () => {
  assert.equal(
    resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 285, operationMaxTokens: 4_096 }),
    4_096,
  );
  assert.equal(
    resolveGenerationTokenLimit({ totalContextTokens: 8_000, promptTokenCount: 1_000, operationMaxTokens: 10_000 }),
    7_000,
  );
});

test('a prompt that fills the window fails loudly instead of generating one token', () => {
  for (const promptTokenCount of [155_000, 200_000]) {
    assert.throws(
      () => resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount }),
      /fills the 155000-token context window/u,
    );
  }
});

test('invalid prompt counts fail loudly', () => {
  for (const promptTokenCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount }),
      /promptTokenCount must be a non-negative integer/u,
    );
  }
});

test('invalid operation caps fail loudly', () => {
  for (const operationMaxTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveGenerationTokenLimit({
        totalContextTokens: 155_000,
        promptTokenCount: 285,
        operationMaxTokens,
      }),
      /operationMaxTokens must be a positive integer/u,
    );
  }
});

test('a terminal answer is still attempted from an over-full transcript', () => {
  assert.equal(resolveFinalGenerationTokenLimit({ totalContextTokens: 155_000, promptTokenCount: 140_000 }), 15_000);
  assert.equal(resolveFinalGenerationTokenLimit({ totalContextTokens: 7_000, promptTokenCount: 7_589 }), 1);
});
