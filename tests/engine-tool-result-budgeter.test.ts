import test from 'node:test';
import assert from 'node:assert/strict';

import { TemporaryTimingRecorder } from '../src/lib/temporary-timing-recorder.js';
import { ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.js';
import { estimateTokenCount } from '../src/repo-search/prompt-budget.js';

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
    commandSucceededForFitting: true, outputUnit: 'lines',
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
    commandSucceededForFitting: true, outputUnit: 'lines',
  });
  assert.ok(fitted.fittedReturnedSegmentCount !== null);
  assert.ok(fitted.fittedReturnedSegmentCount < 200);
  assert.ok(fitted.resultTokenCount <= 50 + 25); // visible text + marker stays near cap
  assert.ok(fitted.resultText.length < lines.join('\n').length);
});

test('timing spans are recorded for raw/prompt/fit/rejection tokenization paths', async () => {
  // config undefined + useEstimatedTokensOnly:false -> countTokensWithFallback estimate path, no HTTP.
  const timingRecorder = new TemporaryTimingRecorder('repo-search', 'test-run', 'unused.json');
  const budgeter = new ToolResultBudgeter({ config: undefined, useEstimatedTokensOnly: false, timingRecorder });
  const lines = Array.from({ length: 200 }, (unused, index) => `match-line-${index}: some matched content`);
  const fittedOk = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: lines.join('\n'), rawResultText: lines.join('\n'),
    perToolCapTokens: 50, remainingTokenAllowance: 10_000,
    commandSucceededForFitting: true, outputUnit: 'lines',
  });
  assert.equal(fittedOk.resultTokenCountEstimated, true);
  assert.ok(fittedOk.fittedReturnedSegmentCount !== null);
  const fittedRejected = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: 'x'.repeat(5_000), rawResultText: 'x'.repeat(5_000),
    perToolCapTokens: 10, remainingTokenAllowance: 20,
    commandSucceededForFitting: false, outputUnit: 'lines',
  });
  assert.ok(/^Error: requested output would consume /u.test(fittedRejected.resultText));
  assert.equal(fittedRejected.resultTokenCountEstimated, true);
});

test('oversized failed output is replaced by the budget-rejection error text', async () => {
  const budgeter = makeBudgeter();
  const bigText = 'x'.repeat(5_000);
  const candidateTokens = estimateTokenCount(undefined, bigText);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: bigText, rawResultText: bigText,
    perToolCapTokens: 10, remainingTokenAllowance: 20,
    commandSucceededForFitting: false, outputUnit: 'lines',
  });
  assert.equal(
    fitted.resultText,
    `Error: requested output would consume ${candidateTokens} tokens, remaining token allowance: 20, per tool call allowance: 10`,
  );
  assert.equal(fitted.fittedReturnedSegmentCount, null);
  assert.equal(fitted.resultTokenCountEstimated, true);
});
