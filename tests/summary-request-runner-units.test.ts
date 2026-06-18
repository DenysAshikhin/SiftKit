import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOversizedNonLlamaInput } from '../src/summary/request-runner.js';

test('isOversizedNonLlamaInput exempts the llama.cpp backend regardless of size', () => {
  assert.equal(isOversizedNonLlamaInput('llama.cpp', 10_000, 1_000), false);
});

test('isOversizedNonLlamaInput rejects a non-llama backend over the maximum', () => {
  assert.equal(isOversizedNonLlamaInput('openai', 1_001, 1_000), true);
});

test('isOversizedNonLlamaInput allows a non-llama backend at exactly the maximum', () => {
  assert.equal(isOversizedNonLlamaInput('openai', 1_000, 1_000), false);
});

test('isOversizedNonLlamaInput allows a non-llama backend under the maximum', () => {
  assert.equal(isOversizedNonLlamaInput('openai', 999, 1_000), false);
});
