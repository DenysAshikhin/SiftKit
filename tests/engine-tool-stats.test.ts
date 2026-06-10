import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolStatsRecorder } from '../src/repo-search/engine/tool-stats.js';

test('recordFinishRejection increments loop.finishRejections from empty stats', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordFinishRejection();
  recorder.recordFinishRejection();
  assert.equal(recorder.snapshot().loop.finishRejections, 2);
});

test('recordToolCall merges counters exactly like the inline engine block', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordToolCall({
    toolType: 'rg',
    resultTextLength: 120,
    resultTokenCount: 30.4,
    resultTokenCountEstimated: true,
    rawResultTokenCount: 99.1,
    lineReadStats: { lineReadCalls: 1, lineReadLinesTotal: 50, lineReadTokensTotal: 400 },
  });
  const stats = recorder.snapshot().rg;
  assert.equal(stats.calls, 1);
  assert.equal(stats.outputCharsTotal, 120);
  assert.equal(stats.outputTokensTotal, 31);
  assert.equal(stats.outputTokensEstimatedCount, 1);
  assert.equal(stats.lineReadCalls, 1);
  assert.equal(stats.lineReadLinesTotal, 50);
  assert.equal(stats.lineReadTokensTotal, 400);
  assert.equal(stats.promptInsertedTokens, 31);
  assert.equal(stats.rawToolResultTokens, 100);
});

test('recordToolCall tolerates null lineReadStats', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordToolCall({
    toolType: 'rg', resultTextLength: 1, resultTokenCount: 1,
    resultTokenCountEstimated: false, rawResultTokenCount: 1, lineReadStats: null,
  });
  assert.equal(recorder.snapshot().rg.lineReadCalls, 0);
  assert.equal(recorder.snapshot().rg.outputTokensEstimatedCount, 0);
});

test('recordToolCall floors negative token counters and get returns existing stats', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordToolCall({
    toolType: 'rg',
    resultTextLength: 5,
    resultTokenCount: -2,
    resultTokenCountEstimated: false,
    rawResultTokenCount: -3,
    lineReadStats: {},
  });
  const stats = recorder.get('rg');
  assert.ok(stats !== null);
  assert.equal(stats.outputTokensTotal, 0);
  assert.equal(stats.promptInsertedTokens, 0);
  assert.equal(stats.rawToolResultTokens, 0);
});

test('recordNovelty splits new vs no-new evidence calls', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordNovelty('rg', true);
  recorder.recordNovelty('rg', false);
  recorder.recordNovelty('rg', false);
  assert.equal(recorder.snapshot().rg.newEvidenceCalls, 1);
  assert.equal(recorder.snapshot().rg.noNewEvidenceCalls, 2);
});

test('semantic repeat and forced-finish counters accumulate per tool type', () => {
  const recorder = new ToolStatsRecorder();
  recorder.recordSemanticRepeatReject('rg');
  recorder.recordForcedFinishFromStagnation('rg');
  recorder.recordForcedFinishFromStagnation('rg');
  assert.equal(recorder.snapshot().rg.semanticRepeatRejects, 1);
  assert.equal(recorder.snapshot().rg.forcedFinishFromStagnation, 2);
});

test('get returns null for unknown tool types and snapshot is a copy', () => {
  const recorder = new ToolStatsRecorder();
  assert.equal(recorder.get('nope'), null);
  const first = recorder.snapshot();
  recorder.recordFinishRejection();
  assert.equal(Object.keys(first).length, 0);
});
