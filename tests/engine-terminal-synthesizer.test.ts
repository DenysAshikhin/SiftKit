import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { TerminalSynthesizer } from '../src/repo-search/engine/terminal-synthesizer.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';

function makeSynthesizer(tokenUsage: TokenUsageTracker): TerminalSynthesizer {
  return new TerminalSynthesizer({
    baseUrl: 'http://127.0.0.1:9', // never contacted in mock mode
    model: 'mock-model',
    timeoutMs: 1_000,
    config: undefined,
    useEstimatedTokensOnly: true,
    totalContextTokens: 32_000,
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    streamFinishAsAnswer: false,
    logger: null,
    progress: new ProgressReporter({ onProgress: null, taskId: 't1', maxTurns: 45, taskStartedAt: Date.now() }),
    tokenUsage,
  });
}

test('synthesize returns the first non-empty mock response', async () => {
  const tokenUsage = new TokenUsageTracker(undefined);
  const synthesizer = makeSynthesizer(tokenUsage);
  const result = await synthesizer.synthesize({
    taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
    mockResponses: ['synthesized answer'], mockResponseIndex: 0,
  });
  assert.equal(result.finalOutput, 'synthesized answer');
  assert.ok(tokenUsage.snapshot().outputTokens > 0);
});

test('synthesize retries past empty responses', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  const result = await synthesizer.synthesize({
    taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
    mockResponses: ['', 'second try answer'], mockResponseIndex: 0,
  });
  assert.equal(result.finalOutput, 'second try answer');
});

test('synthesize hard-fails after three unusable attempts', async () => {
  const synthesizer = makeSynthesizer(new TokenUsageTracker(undefined));
  await assert.rejects(
    synthesizer.synthesize({
      taskId: 't1', question: 'q', reason: 'max_turns', transcript: 'evidence', turnsUsed: 3,
      mockResponses: [], mockResponseIndex: 0,
    }),
    /Terminal synthesis produced no usable output after 3 attempts/u,
  );
});
