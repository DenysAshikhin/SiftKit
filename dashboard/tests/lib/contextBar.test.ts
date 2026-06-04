import test from 'node:test';
import assert from 'node:assert/strict';

import { computeContextBarVisual } from '../../src/lib/contextBar';

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
