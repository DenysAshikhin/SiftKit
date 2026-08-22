import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluatePromptDrift, PROMPT_DRIFT_WARN_TOKENS } from '../src/repo-search/engine/prompt-drift.js';

test('drift below the threshold reports normal severity', () => {
  const drift = evaluatePromptDrift({ predictedPromptTokens: 100_000, serverPromptTokens: 100_500 });
  assert.equal(drift?.driftTokens, 500);
  assert.equal(drift?.warn, false);
});

test('drift at or above the threshold warns', () => {
  const drift = evaluatePromptDrift({ predictedPromptTokens: 100_000, serverPromptTokens: 100_000 + PROMPT_DRIFT_WARN_TOKENS });
  assert.equal(drift?.warn, true);
});

test('missing server usage yields no drift record', () => {
  assert.equal(evaluatePromptDrift({ predictedPromptTokens: 100_000, serverPromptTokens: null }), null);
});
