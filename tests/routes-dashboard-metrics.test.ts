import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdleSummarySnapshot } from '../src/status-server/idle-summary.js';
import type { JsonObject } from '../src/lib/json-types.js';

const EMITTED_AT = new Date('2026-06-17T00:00:00.000Z');

test('buildIdleSummarySnapshot zeroes totals and NaNs ratios for empty metrics', () => {
  const snapshot = buildIdleSummarySnapshot({}, EMITTED_AT);
  assert.equal(snapshot.emittedAtUtc, '2026-06-17T00:00:00.000Z');
  assert.equal(snapshot.inputTokensTotal, 0);
  assert.equal(snapshot.outputTokensTotal, 0);
  assert.equal(snapshot.completedRequestCount, 0);
  assert.equal(snapshot.savedTokens, 0);
  assert.ok(Number.isNaN(snapshot.inputOutputRatio));
  assert.ok(Number.isNaN(snapshot.savedPercent));
  assert.ok(Number.isNaN(snapshot.avgOutputTokensPerRequest));
  assert.ok(Number.isNaN(snapshot.avgRequestMs));
  assert.ok(Number.isNaN(snapshot.avgTokensPerSecond));
  assert.equal(snapshot.inputCharactersPerContextToken, null);
  assert.equal(snapshot.chunkThresholdCharacters, null);
});

test('buildIdleSummarySnapshot computes ratios and averages for populated metrics', () => {
  const metrics: JsonObject = {
    inputTokensTotal: 1_000,
    outputTokensTotal: 200,
    completedRequestCount: 4,
    requestDurationMsTotal: 2_000,
    inputCharactersPerContextToken: 12,
    chunkThresholdCharacters: 5_000,
  };
  const snapshot = buildIdleSummarySnapshot(metrics, EMITTED_AT);
  assert.equal(snapshot.inputOutputRatio, 5);
  assert.equal(snapshot.compressionRatio, 5);
  assert.equal(snapshot.savedTokens, 800);
  assert.equal(snapshot.savedPercent, 0.8);
  assert.equal(snapshot.avgOutputTokensPerRequest, 50);
  assert.equal(snapshot.avgRequestMs, 500);
  assert.equal(snapshot.avgTokensPerSecond, 100);
  assert.equal(snapshot.inputCharactersPerContextToken, 12);
  assert.equal(snapshot.chunkThresholdCharacters, 5_000);
});

test('buildIdleSummarySnapshot rejects non-positive context-token and chunk-threshold values', () => {
  const snapshot = buildIdleSummarySnapshot(
    { inputCharactersPerContextToken: 0, chunkThresholdCharacters: -1 },
    EMITTED_AT,
  );
  assert.equal(snapshot.inputCharactersPerContextToken, null);
  assert.equal(snapshot.chunkThresholdCharacters, null);
});
