import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASIS_CONFIDENCE_CEILING,
  SINGLE_SCREENSHOT_TEXT_CEILING,
  aggregateSupport,
  resolveConfidence,
} from '../src/assistant/domain/confidence.js';

test('every basis has a ceiling and explicit bases outrank passive ones', () => {
  assert.equal(BASIS_CONFIDENCE_CEILING.explicit_user_statement, 0.99);
  assert.equal(BASIS_CONFIDENCE_CEILING.explicit_question_answer, 0.98);
  assert.equal(BASIS_CONFIDENCE_CEILING.manual_import, 0.95);
  assert.equal(BASIS_CONFIDENCE_CEILING.passive_observation, 0.85);
  assert.equal(BASIS_CONFIDENCE_CEILING.derived_aggregation, 0.8);
  assert.equal(BASIS_CONFIDENCE_CEILING.assistant_inference, 0.75);
  assert.equal(SINGLE_SCREENSHOT_TEXT_CEILING, 0.55);
});

test('aggregateSupport is the noisy-or of independent evidence weights', () => {
  assert.equal(aggregateSupport([]), 0);
  assert.equal(aggregateSupport([0.5]), 0.5);
  assert.ok(Math.abs(aggregateSupport([0.5, 0.5]) - 0.75) < 1e-9);
  assert.ok(Math.abs(aggregateSupport([0.9, 0.9, 0.9]) - 0.999) < 1e-9);
  assert.ok(aggregateSupport([0.99, 0.99, 0.99]) < 1);
});

test('aggregateSupport rejects a weight outside [0, 1]', () => {
  assert.throws(() => aggregateSupport([1.5]), /weight/i);
  assert.throws(() => aggregateSupport([-0.1]), /weight/i);
});

test('resolveConfidence clamps to the basis ceiling', () => {
  const resolved = resolveConfidence({
    basis: 'passive_observation',
    supportWeights: [0.99, 0.99, 0.99],
    contradictionCount: 0,
    singleScreenshotTextObservation: false,
    userCorrected: false,
  });
  assert.equal(resolved, 0.85);
});

test('a single screenshot-text observation is clamped to 0.55 regardless of basis', () => {
  const resolved = resolveConfidence({
    basis: 'passive_observation',
    supportWeights: [0.95],
    contradictionCount: 0,
    singleScreenshotTextObservation: true,
    userCorrected: false,
  });
  assert.equal(resolved, 0.55);
});

test('contradictions reduce confidence monotonically', () => {
  const none = resolveConfidence({
    basis: 'explicit_user_statement', supportWeights: [0.9],
    contradictionCount: 0, singleScreenshotTextObservation: false, userCorrected: false,
  });
  const one = resolveConfidence({
    basis: 'explicit_user_statement', supportWeights: [0.9],
    contradictionCount: 1, singleScreenshotTextObservation: false, userCorrected: false,
  });
  const two = resolveConfidence({
    basis: 'explicit_user_statement', supportWeights: [0.9],
    contradictionCount: 2, singleScreenshotTextObservation: false, userCorrected: false,
  });
  assert.ok(none > one);
  assert.ok(one > two);
  assert.ok(two >= 0);
});

test('an explicit user correction pins confidence at 1.00 and ignores contradictions', () => {
  const resolved = resolveConfidence({
    basis: 'explicit_user_statement',
    supportWeights: [0.1],
    contradictionCount: 5,
    singleScreenshotTextObservation: false,
    userCorrected: true,
  });
  assert.equal(resolved, 1);
});

test('a user correction is only honoured for an explicit basis', () => {
  assert.throws(
    () => resolveConfidence({
      basis: 'passive_observation', supportWeights: [0.9],
      contradictionCount: 0, singleScreenshotTextObservation: false, userCorrected: true,
    }),
    /explicit basis/i,
  );
});

test('resolved confidence always lands inside [0, 1]', () => {
  for (const weights of [[], [0], [1], [1, 1, 1], [0.3, 0.7]]) {
    for (const contradictions of [0, 1, 10]) {
      const resolved = resolveConfidence({
        basis: 'derived_aggregation',
        supportWeights: weights,
        contradictionCount: contradictions,
        singleScreenshotTextObservation: false,
        userCorrected: false,
      });
      assert.ok(resolved >= 0 && resolved <= 1, `out of range: ${resolved}`);
    }
  }
});