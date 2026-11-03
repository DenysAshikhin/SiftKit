import test from 'node:test';
import assert from 'node:assert/strict';

import { TemporaryTimingRecorder } from '../src/lib/temporary-timing-recorder.ts';
import { ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.ts';
import { FAILED_COMMAND_TAIL_CAP_TOKENS } from '../src/repo-search/engine/turn-budget.ts';
import { estimateTokenCount } from '../src/lib/token-estimate.ts';
import { digestToolOutput, renderDigests } from '../src/output-digest/digest.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';

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
    capacity: { kind: 'available', perToolCapTokens: 10_000, remainingTokenAllowance: 10_000 },
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head', digest: null,
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
    capacity: { kind: 'available', perToolCapTokens: 50, remainingTokenAllowance: 10_000 },
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head', digest: null,
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
    capacity: { kind: 'available', perToolCapTokens: 50, remainingTokenAllowance: 10_000 },
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head', digest: null,
  });
  assert.equal(fittedOk.resultTokenCountEstimated, true);
  assert.ok(fittedOk.fittedReturnedSegmentCount !== null);
  const fittedFailed = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: 'x'.repeat(5_000), rawResultText: 'x'.repeat(5_000),
    capacity: { kind: 'available', perToolCapTokens: 10, remainingTokenAllowance: 20 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head', digest: null,
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
    capacity: { kind: 'available', perToolCapTokens: 100_000, remainingTokenAllowance: 100_000 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head', digest: null,
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
    capacity: { kind: 'available', perToolCapTokens: 10_000, remainingTokenAllowance: 10_000 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest: null,
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
    capacity: { kind: 'available', perToolCapTokens: 100_000, remainingTokenAllowance: 20 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest: null,
  });
  assert.ok(fitted.resultTokenCount <= 20);
  assert.match(fitted.resultText, /lines truncated due to per-tool context limit\./u);
});

const ROOMY = { kind: 'available', perToolCapTokens: 100_000, remainingTokenAllowance: 100_000 } as const;

test('a result that fits leads with its digest, then the whole output', async () => {
  const resultText = 'exit_code=0\nℹ tests 1\nℹ pass 1';
  const digest = 'Digest of the whole output:\nnode:test: passed (1 tests, 1 pass)';
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: ROOMY,
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'tail', digest,
  });
  assert.equal(fitted.resultText, `${digest}\n${resultText}`);
  assert.equal(fitted.fittedReturnedSegmentCount, null);
});

test('an oversized failed run is its whole digest, the truncation notice, then the tail, within the failed-command cap', async () => {
  const output = readDigestFixture('node-test/noisy-e2e-fail.txt');
  const resultText = `exit_code=1\n${output}`;
  const digest = renderDigests(digestToolOutput(output));
  assert.ok(digest !== null);
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: ROOMY,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest,
  });
  assert.ok(fitted.resultTokenCount <= FAILED_COMMAND_TAIL_CAP_TOKENS);
  assert.ok(fitted.resultText.startsWith(`${digest}\n`), fitted.resultText);
  assert.match(fitted.resultText.slice(digest.length), /^\n\d+ lines truncated due to per-tool context limit\.\n/u);
  assert.ok(fitted.resultText.endsWith(output.trimEnd().split(/\r?\n/u).at(-1) ?? ''), 'the tail still ends the result');
});

test('a digest longer than half the failed-command cap is cut from its end, ahead of the tail', async () => {
  const digest = ['Digest of the whole output:', 'node:test: FAILED (300 tests, 0 pass, 300 fail)',
    ...Array.from({ length: 300 }, (unused, index) => `✖ broken test number ${index} — tests/x.test.ts:${index + 1}:1`)].join('\n');
  const resultText = Array.from({ length: 400 }, (unused, index) => `fail-line-${index}`).join('\n');
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: ROOMY,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest,
  });
  assert.ok(fitted.resultTokenCount <= FAILED_COMMAND_TAIL_CAP_TOKENS);
  assert.ok(fitted.resultText.startsWith('Digest of the whole output:\nnode:test: FAILED (300 tests, 0 pass, 300 fail)\n'
    + '✖ broken test number 0 — tests/x.test.ts:1:1\n'), fitted.resultText);
  assert.doesNotMatch(fitted.resultText, /broken test number 299 /u);
  assert.ok(fitted.resultText.endsWith('fail-line-399'));
});
