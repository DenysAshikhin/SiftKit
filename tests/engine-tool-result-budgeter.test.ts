import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TemporaryTimingRecorder } from '../src/lib/temporary-timing-recorder.ts';
import { ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.ts';
import { OUTPUT_TAIL_CAP_TOKENS } from '../src/repo-search/engine/turn-budget.ts';
import { estimateTokenCount } from '../src/lib/token-estimate.ts';
import { digestOutput, digestToolOutput } from '../src/output-digest/digest.ts';
import { parseJsonText } from '../src/lib/json.ts';
import { z } from '../src/lib/zod.ts';
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
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head', digest: null, fullOutputRequested: false,
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
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head', digest: null, fullOutputRequested: false,
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
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head', digest: null, fullOutputRequested: false,
  });
  assert.equal(fittedOk.resultTokenCountEstimated, true);
  assert.ok(fittedOk.fittedReturnedSegmentCount !== null);
  const fittedFailed = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'rg',
    resultText: 'x'.repeat(5_000), rawResultText: 'x'.repeat(5_000),
    capacity: { kind: 'available', perToolCapTokens: 10, remainingTokenAllowance: 20 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head', digest: null, fullOutputRequested: false,
  });
  // A single 5000-char segment cannot fit a 10-token budget, so only the notice survives.
  assert.match(fittedFailed.resultText, /^1 lines truncated due to per-tool context limit\./u);
  assert.equal(fittedFailed.resultTokenCountEstimated, true);
});

test('oversized failed output keeps a tail within the output tail cap', async () => {
  const budgeter = makeBudgeter();
  const lines = Array.from({ length: 400 }, (unused, index) => `fail-line-${index}: assertion detail text`);
  const resultText = lines.join('\n');
  assert.ok(estimateTokenCount(undefined, resultText) > OUTPUT_TAIL_CAP_TOKENS);
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText, rawResultText: resultText,
    capacity: { kind: 'available', perToolCapTokens: 100_000, remainingTokenAllowance: 100_000 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head', digest: null, fullOutputRequested: false,
  });
  // Failing output over the output tail cap is trimmed even though it is far
  // under the per-tool cap, and the tail is kept regardless of the head keep hint.
  assert.ok(fitted.fittedReturnedSegmentCount !== null);
  assert.ok(fitted.fittedReturnedSegmentCount < 400);
  assert.ok(fitted.resultTokenCount <= OUTPUT_TAIL_CAP_TOKENS);
  assert.match(fitted.resultText, /^\d+ lines truncated due to per-tool context limit\./u);
  assert.ok(fitted.resultText.includes('fail-line-399'));
  assert.ok(!fitted.resultText.includes('fail-line-0:'));
});

test('failed output under the output tail cap passes through unchanged', async () => {
  const budgeter = makeBudgeter();
  const resultText = 'boom: assertion failed\nexit status 1';
  const fitted = await budgeter.fit({
    taskId: 't1', turn: 1, toolName: 'run',
    resultText, rawResultText: resultText,
    capacity: { kind: 'available', perToolCapTokens: 10_000, remainingTokenAllowance: 10_000 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest: null, fullOutputRequested: false,
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
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest: null, fullOutputRequested: false,
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
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'tail', digest, fullOutputRequested: false,
  });
  assert.equal(fitted.resultText, `${digest}\n${resultText}`);
  assert.equal(fitted.fittedReturnedSegmentCount, null);
});

// The capacity a worker had when its passing suite came back as 60,000 tokens (run 774d7a22, turn 44).
const REAL_CAPACITY = { kind: 'available', perToolCapTokens: 60_000, remainingTokenAllowance: 80_000 } as const;
const CORPUS_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'output-digest-runs', '67e089d0');
const CorpusIndexSchema = z.array(z.object({ file: z.string().min(1), exitCode: z.number().int().nullable() }));

async function fitRun(output: string, exitCode: number | null) {
  const resultText = `exit_code=${String(exitCode)}\n${output}`;
  const digest = digestOutput(output)?.text ?? null;
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: REAL_CAPACITY,
    commandSucceededForFitting: exitCode === 0, outputUnit: 'lines', keep: 'tail', digest, fullOutputRequested: false,
  });
  return { digest, fitted };
}

test('every real recognised output leads with its whole digest, and the raw output behind it keeps only a capped tail', async () => {
  const index = parseJsonText(fs.readFileSync(path.join(CORPUS_ROOT, 'index.json'), 'utf8'), CorpusIndexSchema);
  let recognised = 0;
  for (const entry of index) {
    const { digest, fitted } = await fitRun(fs.readFileSync(path.join(CORPUS_ROOT, entry.file), 'utf8'), entry.exitCode);
    if (digest === null) continue;
    recognised += 1;
    assert.ok(fitted.resultText.startsWith(`${digest}\n`), `${entry.file}: the whole digest leads`);
    assert.ok(estimateTokenCount(undefined, fitted.resultText.slice(digest.length + 1)) <= OUTPUT_TAIL_CAP_TOKENS, `${entry.file}: capped tail`);
  }
  assert.ok(recognised > 100, String(recognised));
});

test('a real 153,000-character passing suite becomes its verdict and a capped tail that still ends with the summary', async () => {
  const output = readDigestFixture('node-test/real-run-pass.txt');
  const { digest, fitted } = await fitRun(output, 0);
  assert.equal(digest, 'Digest of the whole output:\nnode:test: passed (263 tests, 263 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo)');
  assert.ok(fitted.resultText.startsWith(`${digest}\n`));
  assert.ok(estimateTokenCount(undefined, fitted.resultText.slice(digest.length + 1)) <= OUTPUT_TAIL_CAP_TOKENS, fitted.resultText);
  assert.ok(fitted.resultText.endsWith('ℹ duration_ms 40987.0442'));
});

test('a real failing run shows every failure whole, ahead of a capped tail', async () => {
  const output = readDigestFixture('node-test/noisy-e2e-fail.txt');
  const { digest, fitted } = await fitRun(output, 1);
  assert.ok(digest !== null);
  assert.doesNotMatch(digest, /more lines|more digest lines/u);
  for (const failure of digestToolOutput(output).flatMap((entry) => entry.failures)) {
    for (const line of failure.message) assert.ok(fitted.resultText.includes(line), line);
  }
  assert.match(fitted.resultText.slice(digest.length), /^\n\d+ lines truncated due to per-tool context limit\.\n/u);
});

test('only a digest that alone overflows the result budget is cut, from its end', async () => {
  const digest = ['Digest of the whole output:', 'node:test: FAILED (300 tests, 0 pass, 300 fail)',
    ...Array.from({ length: 300 }, (unused, index) => `✖ broken test number ${index} — tests/x.test.ts:${index + 1}:1`)].join('\n');
  const resultText = Array.from({ length: 400 }, (unused, index) => `fail-line-${index}`).join('\n');
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText,
    capacity: { kind: 'available', perToolCapTokens: 3_000, remainingTokenAllowance: 3_000 },
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest, fullOutputRequested: false,
  });
  assert.ok(fitted.resultTokenCount <= 3_000, String(fitted.resultTokenCount));
  assert.ok(fitted.resultText.startsWith('Digest of the whole output:\nnode:test: FAILED (300 tests, 0 pass, 300 fail)\n'
    + '✖ broken test number 0 — tests/x.test.ts:1:1\n'), fitted.resultText);
  assert.doesNotMatch(fitted.resultText, /broken test number 299 /u);
  assert.ok(fitted.resultText.endsWith('fail-line-399'));
});

test('a succeeded run that asked for its full output keeps it under the per-tool cap, behind its digest', async () => {
  const output = readDigestFixture('node-test/real-run-pass.txt');
  const resultText = `exit_code=0\n${output}`;
  const digest = digestOutput(output)?.text ?? null;
  assert.ok(digest !== null);
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: ROOMY,
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'tail', digest, fullOutputRequested: true,
  });
  assert.equal(fitted.resultText, `${digest}\n${resultText}`);
});
