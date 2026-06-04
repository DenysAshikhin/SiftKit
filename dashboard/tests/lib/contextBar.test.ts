import test from 'node:test';
import assert from 'node:assert/strict';

import { computeContextBarVisual, resolveContextBarVisual } from '../../src/lib/contextBar';
import type { ContextUsage } from '../../src/types';

const USAGE: ContextUsage = {
  contextWindowTokens: 100,
  usedTokens: 0,
  chatUsedTokens: 20,
  thinkingUsedTokens: 0,
  toolUsedTokens: 0,
  totalUsedTokens: 0,
  remainingTokens: 80,
  warnThresholdTokens: 80,
  shouldCondense: false,
};

test('computeContextBarVisual clamps used > total to 100%', () => {
  const result = computeContextBarVisual(150, 100);
  assert.equal(result.ratio, 1);
  assert.equal(result.percent, 100);
  assert.match(result.titleText, /100\.0% used/);
});

test('computeContextBarVisual clamps negative used to 0%', () => {
  const result = computeContextBarVisual(-5, 100);
  assert.equal(result.ratio, 0);
  assert.equal(result.percent, 0);
});

test('computeContextBarVisual returns 0% for zero total', () => {
  const result = computeContextBarVisual(10, 0);
  assert.equal(result.ratio, 0);
  assert.equal(result.percent, 0);
  assert.equal(result.fillColor, 'hsl(120, 70%, 45%)');
});

test('computeContextBarVisual ramps hue from green at 0 to red at 1', () => {
  assert.equal(computeContextBarVisual(0, 100).fillColor, 'hsl(120, 70%, 45%)');
  assert.equal(computeContextBarVisual(50, 100).fillColor, 'hsl(60, 70%, 45%)');
  assert.equal(computeContextBarVisual(100, 100).fillColor, 'hsl(0, 70%, 45%)');
});

test('computeContextBarVisual title text contains used/total and percent with one decimal', () => {
  const result = computeContextBarVisual(2500, 10000);
  assert.match(result.titleText, /2,500/);
  assert.match(result.titleText, /10,000/);
  assert.match(result.titleText, /25\.0% used/);
});

test('resolveContextBarVisual uses persisted chat usage when not busy', () => {
  const result = resolveContextBarVisual(USAGE, 999, 80, false);
  assert.equal(result?.percent, 20);
});

test('resolveContextBarVisual prefers the live prompt token count while busy when it exceeds persisted usage', () => {
  const result = resolveContextBarVisual(USAGE, 999, 70, true);
  assert.equal(result?.percent, 70);
});

test('resolveContextBarVisual keeps persisted usage when the live prompt count is lower', () => {
  const result = resolveContextBarVisual(USAGE, 999, 5, true);
  assert.equal(result?.percent, 20);
});

test('resolveContextBarVisual uses persisted usage while busy when no live prompt count is present', () => {
  const result = resolveContextBarVisual(USAGE, 999, null, true);
  assert.equal(result?.percent, 20);
});

test('resolveContextBarVisual draws from the session window during a fresh-session stream before usage exists', () => {
  const result = resolveContextBarVisual(null, 200, 50, true);
  assert.equal(result?.percent, 25);
});

test('resolveContextBarVisual returns null for a fresh session at rest with no usage', () => {
  assert.equal(resolveContextBarVisual(null, 200, null, false), null);
  assert.equal(resolveContextBarVisual(null, 200, 50, false), null);
});

test('resolveContextBarVisual returns null when busy with no usable live prompt count and no usage', () => {
  assert.equal(resolveContextBarVisual(null, 200, 0, true), null);
  assert.equal(resolveContextBarVisual(null, 200, Number.NaN, true), null);
  assert.equal(resolveContextBarVisual(null, 200, Number.POSITIVE_INFINITY, true), null);
});

test('resolveContextBarVisual returns null when the resolved window is non-positive', () => {
  assert.equal(resolveContextBarVisual({ ...USAGE, contextWindowTokens: 0 }, 0, 10, true), null);
  assert.equal(resolveContextBarVisual(null, 0, 10, true), null);
});
