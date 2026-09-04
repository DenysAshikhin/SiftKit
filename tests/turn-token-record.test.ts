import assert from 'node:assert/strict';
import test from 'node:test';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import {
  foldTurnTokenRecords,
  resolveCharsPerToken,
  type TurnTokenRecord,
} from '../src/repo-search/engine/turn-token-record.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';

function record(overrides: Partial<TurnTokenRecord> = {}): TurnTokenRecord {
  return {
    turn: 1,
    promptTokens: 100,
    thinkingTokens: 40,
    outputTokens: 20,
    toolTokens: 10,
    generatedChars: 240,
    thinkingTokensEstimated: false,
    outputTokensEstimated: false,
    ...overrides,
  };
}

test('foldTurnTokenRecords sums every component across turns', () => {
  const totals = foldTurnTokenRecords([
    record({ turn: 1 }),
    record({ turn: 2, promptTokens: 300, thinkingTokens: 5, outputTokens: 7, toolTokens: 11 }),
  ]);
  assert.equal(totals.promptTokens, 400);
  assert.equal(totals.thinkingTokens, 45);
  assert.equal(totals.outputTokens, 27);
  assert.equal(totals.toolTokens, 21);
});

test('foldTurnTokenRecords counts estimated turns rather than flattening them to a boolean', () => {
  const totals = foldTurnTokenRecords([
    record({ turn: 1, thinkingTokensEstimated: true }),
    record({ turn: 2, thinkingTokensEstimated: false, outputTokensEstimated: true }),
  ]);
  assert.equal(totals.thinkingTokensEstimatedCount, 1);
  assert.equal(totals.outputTokensEstimatedCount, 1);
});

test('foldTurnTokenRecords returns zeroed totals for an empty run', () => {
  const totals = foldTurnTokenRecords([]);
  assert.equal(totals.promptTokens, 0);
  assert.equal(totals.thinkingTokens, 0);
  assert.equal(totals.outputTokens, 0);
  assert.equal(totals.toolTokens, 0);
  assert.equal(totals.thinkingTokensEstimatedCount, 0);
  assert.equal(totals.outputTokensEstimatedCount, 0);
});

test('resolveCharsPerToken measures the most recent completed turn', () => {
  const ratio = resolveCharsPerToken([
    record({ turn: 1, generatedChars: 1000, thinkingTokens: 100, outputTokens: 100 }),
    record({ turn: 2, generatedChars: 300, thinkingTokens: 50, outputTokens: 50 }),
  ]);
  assert.equal(ratio, 3);
});

test('resolveCharsPerToken falls back to the seed ratio before any turn completes', () => {
  assert.equal(resolveCharsPerToken([]), 4);
});

test('resolveCharsPerToken ignores a turn that generated no tokens', () => {
  const ratio = resolveCharsPerToken([
    record({ turn: 1, generatedChars: 1000, thinkingTokens: 100, outputTokens: 100 }),
    record({ turn: 2, generatedChars: 0, thinkingTokens: 0, outputTokens: 0 }),
  ]);
  assert.equal(ratio, 5);
});

import { RepoSearchProgressEventSchema } from '../src/repo-search/types.js';

test('the usage progress event carries the turn record, totals, and calibration ratio', () => {
  const parsed = RepoSearchProgressEventSchema.parse({
    kind: 'usage',
    turn: 3,
    maxTurns: 20,
    elapsedMs: 1234,
    record: {
      turn: 3,
      promptTokens: 900,
      thinkingTokens: 120,
      outputTokens: 40,
      toolTokens: 60,
      generatedChars: 640,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 2700,
      thinkingTokens: 300,
      outputTokens: 90,
      toolTokens: 180,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  });
  assert.equal(parsed.kind, 'usage');
});

test('the usage progress event rejects a negative token count', () => {
  const result = RepoSearchProgressEventSchema.safeParse({
    kind: 'usage',
    turn: 1,
    maxTurns: 20,
    elapsedMs: 0,
    record: {
      turn: 1,
      promptTokens: -1,
      thinkingTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      generatedChars: 0,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 0,
      thinkingTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  });
  assert.equal(result.success, false);
});
function collectingReporter(): {
  events: RepoSearchProgressEvent[];
  reporter: ProgressReporter;
} {
  const writer = new CollectingProgressWriter<RepoSearchProgressEvent>();
  const reporter = new ProgressReporter({
    progressWriter: writer,
    taskId: 't1',
    maxTurns: 45,
    taskStartedAt: Date.now(),
  });
  return { events: writer.events, reporter };
}

test('usageForTurn emits the turn record with the folded totals and measured ratio', () => {
  const records = [
    record({ turn: 1 }),
    record({ turn: 2, promptTokens: 300, thinkingTokens: 5, outputTokens: 7, toolTokens: 11 }),
  ];
  const { events, reporter } = collectingReporter();
  reporter.usageForTurn(2, records);

  const usage = events.find((event) => event.kind === 'usage');
  assert.ok(usage);
  assert.equal(usage.kind, 'usage');
  assert.equal(usage.turn, 2);
  assert.deepEqual(usage.record, records[1]);
  assert.deepEqual(usage.totals, foldTurnTokenRecords(records));
  assert.equal(usage.charsPerToken, resolveCharsPerToken(records));
});

test('usageForTurn throws when the requested turn has no record', () => {
  const { reporter } = collectingReporter();
  assert.throws(
    () => reporter.usageForTurn(7, [record({ turn: 1 })]),
    /Token usage record missing for turn 7/u,
  );
});
