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
  providerOverheadTokens: 5,
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

test('resolveContextBarVisual returns ordered reserve and usage sections', () => {
  const result = resolveContextBarVisual({
    ...USAGE,
    contextWindowTokens: 100,
    chatUsedTokens: 20,
    totalUsedTokens: 20,
    remainingTokens: 80,
    providerOverheadTokens: 5,
    warnThresholdTokens: 10,
  }, 999, null, false);

  assert.deepEqual(result?.sections.map((section) => section.kind), [
    'provider-overhead',
    'used',
    'free',
    'warn',
  ]);
  assert.equal(result?.sections[0]?.percent, 5);
  assert.equal(result?.sections[1]?.percent, 20);
  assert.equal(result?.sections[3]?.percent, 10);
});

test('resolveContextBarVisual lets used context take precedence over the warn band when crowded', () => {
  const result = resolveContextBarVisual({
    ...USAGE,
    contextWindowTokens: 100,
    chatUsedTokens: 90,
    totalUsedTokens: 90,
    remainingTokens: 10,
    providerOverheadTokens: 20,
    warnThresholdTokens: 30,
  }, 999, null, false);

  const totalPercent = result?.sections.reduce((sum, section) => sum + section.percent, 0);
  assert.equal(totalPercent, 100);
  assert.equal(result?.sections.find((section) => section.kind === 'used')?.percent, 80);
  assert.equal(result?.sections.find((section) => section.kind === 'warn'), undefined);
  assert.equal(result?.sections.find((section) => section.kind === 'free'), undefined);
});

test('resolveContextBarVisual omits zero-token reserve sections', () => {
  const result = resolveContextBarVisual({
    ...USAGE,
    providerOverheadTokens: 0,
    warnThresholdTokens: 0,
  }, 999, null, false);

  assert.deepEqual(result?.sections.map((section) => section.kind), ['used', 'free']);
});

test('resolveContextBarVisual omits reserve sections during a fresh live stream before usage exists', () => {
  const result = resolveContextBarVisual(null, 1000, 250, true);

  assert.deepEqual(result?.sections.map((section) => section.kind), ['used', 'free']);
  assert.equal(result?.sections.find((section) => section.kind === 'used')?.percent, 25);
});
