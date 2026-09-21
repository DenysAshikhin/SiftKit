import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdleSummarySnapshot } from '../src/status-server/idle-summary.js';
import { normalizeIdleSummarySnapshotRow } from '../src/status-server/dashboard-runs.js';
import { emptyInferenceThroughput, readTabbyThroughput, mergeInferenceThroughput } from '../src/lib/inference-throughput.js';
import { auditIdleSummarySnapshot } from '../src/status-server/server-ops.js';
import { OutputCapture } from './helpers/stdout-capture.js';
import type { InferenceThroughput } from '@siftkit/contracts';
import type { JsonObject } from '../src/lib/json-types.js';

const EMITTED_AT = new Date('2026-06-17T00:00:00.000Z');

/** One backend observation, read the way the inference client reads it. */
function tabbyFold(input: {
  promptTokens: number;
  cachedTokens: number;
  promptTimeS: number;
  promptRate: number;
  completionTokens: number;
  completionTimeS: number;
  completionRate: number;
}): InferenceThroughput {
  return readTabbyThroughput({
    usage: {
      prompt_tokens: input.promptTokens,
      prompt_tokens_details: { cached_tokens: input.cachedTokens },
      prompt_time: input.promptTimeS,
      prompt_tokens_per_sec: input.promptRate,
      completion_tokens: input.completionTokens,
      completion_time: input.completionTimeS,
      completion_tokens_per_sec: input.completionRate,
    },
  });
}

test('buildIdleSummarySnapshot zeroes totals and NaNs ratios for empty metrics', () => {
  const snapshot = buildIdleSummarySnapshot({ throughput: emptyInferenceThroughput() }, EMITTED_AT);
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
    throughput: emptyInferenceThroughput(),
  };
  const snapshot = buildIdleSummarySnapshot(metrics, EMITTED_AT);
  assert.equal(snapshot.inputOutputRatio, 5);
  assert.equal(snapshot.compressionRatio, 5);
  assert.equal(snapshot.savedTokens, 800);
  assert.equal(snapshot.savedPercent, 0.8);
  assert.equal(snapshot.avgOutputTokensPerRequest, 50);
  assert.equal(snapshot.avgRequestMs, 500);
  // Generation speed is canonical decode throughput, never `outputTokensTotal / requestDurationMsTotal`.
  // These metrics carry no backend fold, so the authoritative rate is unavailable rather than derived.
  assert.ok(Number.isNaN(snapshot.avgTokensPerSecond));
  assert.equal(snapshot.inputCharactersPerContextToken, 12);
  assert.equal(snapshot.chunkThresholdCharacters, 5_000);
});

test('buildIdleSummarySnapshot derives generation speed from the canonical decode fold', () => {
  const first = tabbyFold({
    promptTokens: 2_000, cachedTokens: 500, promptTimeS: 2, promptRate: 750,
    completionTokens: 10, completionTimeS: 1, completionRate: 10,
  });
  const second = tabbyFold({
    promptTokens: 1_000, cachedTokens: 0, promptTimeS: 1, promptRate: 1_000,
    completionTokens: 90, completionTimeS: 3, completionRate: 30,
  });
  const snapshot = buildIdleSummarySnapshot({
    outputTokensTotal: 200,
    completedRequestCount: 4,
    requestDurationMsTotal: 2_000,
    throughput: mergeInferenceThroughput([first, second]),
  }, EMITTED_AT);
  // (10 + 90) tokens over (1 + 3) seconds, duration-weighted; the wall-time formula would say 100.
  assert.equal(snapshot.avgTokensPerSecond, 25);
  assert.equal(snapshot.avgRequestMs, 500);
  assert.equal(snapshot.throughput.decode.tokenCount, 100);
});

test('buildIdleSummarySnapshot rejects live metrics that carry no fold', () => {
  // Metrics.throughput is required; only historical rows may lack one.
  assert.throws(() => buildIdleSummarySnapshot({ outputTokensTotal: 200 }, EMITTED_AT), /throughput/u);
  assert.throws(() => buildIdleSummarySnapshot({ outputTokensTotal: 200, throughput: null }, EMITTED_AT), /throughput/u);
});

test('normalizeIdleSummarySnapshotRow reads generation speed from the stored fold, not the legacy column', () => {
  const throughput = mergeInferenceThroughput([tabbyFold({
    promptTokens: 600, cachedTokens: 100, promptTimeS: 0.5, promptRate: 1_000,
    completionTokens: 30, completionTimeS: 2, completionRate: 15,
  })]);
  const row = normalizeIdleSummarySnapshotRow({
    emitted_at_utc: '2026-06-17T00:00:00.000Z',
    completed_request_count: 2,
    output_tokens_total: 500,
    request_duration_ms_total: 1_000,
    avg_tokens_per_second: 500,
    throughput_json: JSON.stringify(throughput),
  });
  assert.ok(row);
  assert.equal(row.avgTokensPerSecond, 15);
  assert.deepEqual(row.throughput, throughput);
});

test('normalizeIdleSummarySnapshotRow reports NaN for a historical snapshot without a fold', () => {
  const row = normalizeIdleSummarySnapshotRow({
    emitted_at_utc: '2026-06-17T00:00:00.000Z',
    avg_tokens_per_second: 16.5198,
    throughput_json: null,
  });
  assert.ok(row);
  assert.equal(row.throughput, null);
  assert.ok(Number.isNaN(row.avgTokensPerSecond));
});

/** One backend observation of 100 tokens in 5 seconds at a reported 20 tokens/second. */
function comparableFold(): InferenceThroughput {
  return mergeInferenceThroughput([tabbyFold({
    promptTokens: 1_000, cachedTokens: 0, promptTimeS: 2, promptRate: 500,
    completionTokens: 100, completionTimeS: 5, completionRate: 20,
  })]);
}

function auditSnapshot(snapshot: ReturnType<typeof buildIdleSummarySnapshot>): string[] {
  const capture = OutputCapture.start(process.stdout);
  try {
    auditIdleSummarySnapshot(snapshot);
  } finally {
    capture.restore();
  }
  return capture.lines.filter((line) => /throughput_/u.test(line));
}

test('an idle snapshot whose published rate matches the backend logs nothing', () => {
  const lines = auditSnapshot(buildIdleSummarySnapshot({ throughput: comparableFold() }, EMITTED_AT));
  assert.deepEqual(lines, []);
});

test('a drifted idle summary generation speed emits one published decode mismatch', () => {
  const snapshot = buildIdleSummarySnapshot({ throughput: comparableFold() }, EMITTED_AT);
  const lines = auditSnapshot({ ...snapshot, avgTokensPerSecond: 16.5198 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /throughput_mismatch/u);
  assert.match(lines[0], /operation=mixed/u);
  assert.match(lines[0], /operation_id=runtime_metrics/u);
  assert.match(lines[0], /stage=idle_summary/u);
  assert.match(lines[0], /scope=published/u);
  assert.match(lines[0], /metric=decode/u);
  // Idle summaries publish no PP rate, so PP is never audited under this scope.
  assert.equal(lines.some((line) => /metric=pp/u.test(line)), false);
});

test('an idle snapshot without backend telemetry publishes no rate and audits nothing', () => {
  const lines = auditSnapshot(buildIdleSummarySnapshot({
    outputTokensTotal: 200,
    requestDurationMsTotal: 2_000,
    completedRequestCount: 4,
    throughput: emptyInferenceThroughput(),
  }, EMITTED_AT));
  assert.deepEqual(lines, []);
});

test('buildIdleSummarySnapshot rejects non-positive context-token and chunk-threshold values', () => {
  const snapshot = buildIdleSummarySnapshot(
    { inputCharactersPerContextToken: 0, chunkThresholdCharacters: -1, throughput: emptyInferenceThroughput() },
    EMITTED_AT,
  );
  assert.equal(snapshot.inputCharactersPerContextToken, null);
  assert.equal(snapshot.chunkThresholdCharacters, null);
});
