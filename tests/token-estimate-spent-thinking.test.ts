import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpentThinkingTokens } from '../src/lib/token-estimate.js';
import { mockSiftConfig } from './helpers/mock-config.js';

// An unpinned mock config carries the shipped 2.5 chars/token estimate, so a
// default change fails loudly here instead of going silently untested.
const config = mockSiftConfig({});

test('a positive reported thinking count is used verbatim', () => {
  assert.equal(resolveSpentThinkingTokens(config, 6_200, 'x'.repeat(40_000)), 6_200);
});

test('a null reported count falls back to the character estimate', () => {
  // 40 characters at the 2.5 chars/token default estimate.
  assert.equal(resolveSpentThinkingTokens(config, null, 'x'.repeat(40)), 16);
});

test('a zero reported count falls back to the character estimate', () => {
  // Backends that stream reasoning_tokens: 0 until the final usage payload must
  // not read as "nothing spent", or the gate would never fire.
  assert.equal(resolveSpentThinkingTokens(config, 0, 'x'.repeat(40)), 16);
});

test('empty reasoning text with no reported count resolves to zero', () => {
  assert.equal(resolveSpentThinkingTokens(config, null, ''), 0);
});