import test from 'node:test';
import assert from 'node:assert/strict';

import { TemporaryTimingRecorder } from '../src/lib/temporary-timing-recorder.js';
import { FAILED_COMMAND_TAIL_CAP_TOKENS, ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.js';
import { estimateTokenCount } from '../src/lib/token-estimate.js';

function makeBudgeter(): ToolResultBudgeter {
  // config undefined + useEstimatedTokensOnly -> pure char-based estimates, no HTTP.
  return new ToolResultBudgeter({ config: undefined, useEstimatedTokensOnly: true, timingRecorder: null });
}

test('result under both caps passes through unchanged', async () => {
  const budgeter = makeBudgeter();
  const resultText = 'line one\nline two';
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText, rawResultText: resultText,
    perToolCapTokens: 10_000, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head',
  });
  assert.equal(fitted.resultText, resultText);
  assert.equal(fitted.resultTokenCount, estimateTokenCount(undefined, resultText));
  assert.equal(fitted.resultTokenCountEstimated, true);
  assert.equal(fitted.fittedReturnedSegmentCount, null);
  assert.equal(fitted.rawResultTokenCount, estimateTokenCount(undefined, resultText));
});

test('oversized successful output is fitted down to the cap with a truncation marker', async () => {
  const budgeter = makeBudgeter();
  const lines = Array.from({ length: 200 }, (unused, index) => `match-line-${index}: some matched content`);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: lines.join('\n'), rawResultText: lines.join('\n'),
    perToolCapTokens: 50, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head',
  });
  assert.ok(fitted.fittedReturnedSegmentCount !== null);
  assert.ok(fitted.fittedReturnedSegmentCount < 200);
  assert.ok(fitted.resultTokenCount <= 50 + 25); // visible text + marker stays near cap
  assert.ok(fitted.resultText.length < lines.join('\n').length);
});

test('timing spans are recorded for raw/prompt/fit tokenization paths', async () => {
  // config undefined + useEstimatedTokensOnly:false -> countTokensWithFallback estimate path, no HTTP.
  const timingRecorder = new TemporaryTimingRecorder('repo-search', 'test-run', 'unused.json');
  const budgeter = new ToolResultBudgeter({ config: undefined, useEstimatedTokensOnly: false, timingRecorder });
  const lines = Array.from({ length: 200 }, (unused, index) => `match-line-${index}: some matched content`);
  const fittedOk = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: lines.join('\n'), rawResultText: lines.join('\n'),
    perToolCapTokens: 50, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head',
  });
  assert.equal(fittedOk.resultTokenCountEstimated, true);
  assert.ok(fittedOk.fittedReturnedSegmentCount !== null);
  const fittedFailed = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: 'x'.repeat(5_000), rawResultText: 'x'.repeat(5_000),
    perToolCapTokens: 10, remainingTokenAllowance: 20,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head',
  });
  // A single 5000-char segment cannot fit a 10-token budget, so only the notice survives.
  assert.match(fittedFailed.resultText, /^1 lines truncated due to per-tool context limit\./u);
  assert.equal(fittedFailed.resultTokenCountEstimated, true);
});

test('oversized failed output keeps a tail within the failed-command cap', async () => {
  const budgeter = makeBudgeter();
  const lines = Array.from({ length: 400 }, (unused, index) => `fail-line-${index}: assertion detail text`);
  const resultText = lines.join('\n');
  assert.ok(estimateTokenCount(undefined, resultText) > FAILED_COMMAND_TAIL_CAP_TOKENS);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText, rawResultText: resultText,
    perToolCapTokens: 100_000, remainingTokenAllowance: 100_000,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head',
  });
  // Failing output over the failed-command cap is trimmed even though it is far
  // under the per-tool cap, and the tail is kept regardless of the head keep hint.
  assert.ok(fitted.fittedReturnedSegmentCount !== null);
  assert.ok(fitted.fittedReturnedSegmentCount < 400);
  assert.ok(fitted.resultTokenCount <= FAILED_COMMAND_TAIL_CAP_TOKENS);
  assert.match(fitted.resultText, /^\d+ lines truncated due to per-tool context limit\./u);
  assert.ok(fitted.resultText.includes('fail-line-399'));
  assert.ok(!fitted.resultText.includes('fail-line-0:'));
});

test('failed output under the failed-command cap passes through unchanged', async () => {
  const budgeter = makeBudgeter();
  const resultText = 'boom: assertion failed\nexit status 1';
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText, rawResultText: resultText,
    perToolCapTokens: 10_000, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail',
  });
  assert.equal(fitted.resultText, resultText);
  assert.equal(fitted.fittedReturnedSegmentCount, null);
});

test('failed output tail is clamped by the remaining allowance when it is smaller', async () => {
  const budgeter = makeBudgeter();
  const lines = Array.from({ length: 200 }, (unused, index) => `fail-line-${index}`);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText: lines.join('\n'), rawResultText: lines.join('\n'),
    perToolCapTokens: 100_000, remainingTokenAllowance: 20,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail',
  });
  assert.ok(fitted.resultTokenCount <= 20);
  assert.match(fitted.resultText, /lines truncated due to per-tool context limit\./u);
});
