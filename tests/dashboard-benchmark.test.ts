import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.js';
import {
  auditBenchmarkAttemptThroughput,
  auditBenchmarkSessionThroughput,
  buildBenchmarkAttemptMetrics,
} from '../src/status-server/dashboard-benchmark-runner.js';
import {
  appendBenchmarkLogChunk,
  createBenchmarkQuestionPreset,
  createBenchmarkSessionPlan,
  deleteBenchmarkQuestionPreset,
  listBenchmarkQuestionPresets,
  readBenchmarkLogTextByStream,
  readBenchmarkSessionDetail,
  seedBenchmarkQuestionPresets,
  toDashboardBenchmarkSessionDetail,
  updateBenchmarkAttemptGrade,
  updateBenchmarkQuestionPreset,
  updateBenchmarkAttempt,
  readBenchmarkAttempt,
} from '../src/state/dashboard-benchmark.js';
import type { RunRecord } from '../src/status-server/dashboard-runs.js';
import { OutputCapture } from './helpers/stdout-capture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { readTabbyThroughput } from '../src/lib/inference-throughput.js';

const BENCHMARK_FOLD = readTabbyThroughput({ usage: {
  prompt_tokens: 210, prompt_tokens_details: { cached_tokens: 10 },
  prompt_time: 4, prompt_tokens_per_sec: 50,
  completion_tokens: 100, completion_time: 5, completion_tokens_per_sec: 20,
} });

/**
 * The run behind the original bug: the backend emitted 28,036 tokens in 1,189.48 s, while the
 * attributed visible/thinking counts and the whole-request duration imply a much slower decode.
 */
const DRIFT_FOLD = readTabbyThroughput({ usage: {
  prompt_tokens: 210, prompt_tokens_details: { cached_tokens: 10 },
  prompt_time: 2, prompt_tokens_per_sec: 100,
  completion_tokens: 28_036, completion_time: 1_189.48, completion_tokens_per_sec: 23.57,
} });

function runRecord(overrides: Partial<RunRecord>): { run: RunRecord } {
  const base: RunRecord = {
    id: 'run-1',
    kind: 'repo-search',
    status: 'completed',
    operationType: null,
    operationPresetId: null,
    modelPresetId: 'fast',
    operationPresetJson: null,
    modelPresetJson: null,
    startedAtUtc: '2026-05-13T00:00:00.000Z',
    finishedAtUtc: '2026-05-13T00:00:10.000Z',
    title: 'Benchmark run',
    model: 'model',
    backend: 'exl3',
    inputTokens: 100,
    outputTokens: 80,
    thinkingTokens: 20,
    toolTokens: 0,
    promptCacheTokens: 10,
    promptEvalTokens: 200,
    promptEvalDurationMs: 4_000,
    generationDurationMs: 5_000,
    speculativeAcceptedTokens: 30,
    speculativeGeneratedTokens: 60,
    throughput: BENCHMARK_FOLD,
    durationMs: 10_000,
    providerDurationMs: 9_500,
    wallDurationMs: 10_050,
    rawPaths: {},
  };
  return { run: { ...base, ...overrides } };
}

/** Run the audited publication boundary with the shared server logger captured as text lines. */
function auditLines(audit: () => void): string[] {
  const capture = OutputCapture.start(process.stdout);
  try {
    audit();
  } finally {
    capture.restore();
  }
  return capture.lines.filter((line) => /throughput_/u.test(line));
}


function createTempDatabasePath(): string {
  const tempRoot = createManagedTempDir('siftkit-dashboard-benchmark-');
  return path.join(tempRoot, 'runtime.sqlite');
}

test('dashboard benchmark preset store seeds built-in prompts and supports CRUD', () => {
  const databasePath = createTempDatabasePath();
  try {
    const seeded = seedBenchmarkQuestionPresets({ databasePath });
    assert.equal(seeded.length >= 9, true);
    assert.equal(seeded.every((entry) => entry.taskKind === 'repo-search'), true);
    assert.equal(seedBenchmarkQuestionPresets({ databasePath }).length, 0);

    const created = createBenchmarkQuestionPreset({
      databasePath,
      title: 'Summarize queue behavior',
      taskKind: 'summary',
      prompt: 'Summarize the queue behavior.',
      enabled: true,
    });
    assert.equal(created.title, 'Summarize queue behavior');
    assert.equal(created.taskKind, 'summary');

    const updated = updateBenchmarkQuestionPreset({
      databasePath,
      id: created.id,
      title: 'Summarize request queue',
      enabled: false,
    });
    assert.equal(updated?.title, 'Summarize request queue');
    assert.equal(updated?.enabled, false);

    assert.equal(deleteBenchmarkQuestionPreset(created.id, databasePath), true);
    assert.equal(listBenchmarkQuestionPresets({ databasePath }).some((entry) => entry.id === created.id), false);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('dashboard benchmark runner derives attempt metrics from dashboard run records', () => {
  const metrics = buildBenchmarkAttemptMetrics('run-1', runRecord({}), 'repo-search');

  assert.deepEqual(metrics, {
    durationMs: 10000,
    promptTokensPerSecond: 50,
    generationTokensPerSecond: 20,
    acceptanceRate: 0.5,
    outputTokens: 80,
    thinkingTokens: 20,
    speculativeAcceptedTokens: 30,
    speculativeGeneratedTokens: 60,
    throughput: BENCHMARK_FOLD,
  });
});

test('benchmark attempt rates come from the canonical fold, not the attributed-token formulas', () => {
  const metrics = buildBenchmarkAttemptMetrics('run-drift', runRecord({ throughput: DRIFT_FOLD }), 'summary');

  // The legacy formulas would report 200/4 = 50 PP and (80 + 20)/5 = 20 decode from the same record.
  assert.equal(metrics.promptTokensPerSecond, 100);
  assert.equal(metrics.generationTokensPerSecond, 28_036 / 1_189.48);
  assert.deepEqual(metrics.throughput, DRIFT_FOLD);
});

test('benchmark attempt metrics fail loudly when a fresh run recorded no backend throughput', () => {
  assert.throws(
    () => buildBenchmarkAttemptMetrics('run-1', runRecord({ throughput: null }), 'repo-search'),
    /no backend throughput for run-1/u,
  );
});

test('a benchmark attempt publishes its canonical rates without an audit line', () => {
  const lines = auditLines(() => {
    buildBenchmarkAttemptMetrics('run-1', runRecord({}), 'repo-search');
  });
  assert.deepEqual(lines, []);
});

test('a tampered benchmark attempt rate emits one published mismatch per drifting metric', () => {
  const lines = auditLines(() => {
    auditBenchmarkAttemptThroughput(
      { taskKind: 'repo-search', runId: 'run-1', model: 'model', presetId: 'fast' },
      DRIFT_FOLD,
      { promptTokensPerSecond: 50, generationTokensPerSecond: 16.5198 },
    );
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /operation=repo-search/u);
  assert.match(lines[0], /stage=benchmark_attempt/u);
  assert.match(lines[0], /scope=published/u);
  assert.match(lines[0], /metric=pp/u);
  assert.match(lines[1], /metric=decode/u);
  assert.match(lines[1], /generated_tokens=28036/u);
  assert.match(lines[1], /preset=fast/u);
});

test('benchmark session detail publishes duration-weighted rates over the attempts that were measured', () => {
  const databasePath = createTempDatabasePath();
  try {
    getRuntimeDatabase(databasePath);
    const prompt = createBenchmarkQuestionPreset({
      databasePath, title: 'Trace repo-search', taskKind: 'repo-search', prompt: 'Trace it.', enabled: true,
    });
    const plan = createBenchmarkSessionPlan({
      databasePath,
      questionPresetIds: [prompt.id],
      repetitions: 3,
      managedPresets: [{ id: 'fast', label: 'Fast preset' }],
      specOverrides: [{ label: 'n24-m64', SpeculativeEnabled: false }],
      originalConfigJson: JSON.stringify({ Server: { ModelPresets: { ActivePresetId: 'fast' } } }),
    });
    updateBenchmarkAttempt({
      databasePath, attemptId: plan.attempts[0].id, status: 'completed', throughput: BENCHMARK_FOLD,
    });
    updateBenchmarkAttempt({
      databasePath, attemptId: plan.attempts[1].id, status: 'completed', throughput: DRIFT_FOLD,
    });

    const detail = readBenchmarkSessionDetail(plan.session.id, databasePath);
    assert.ok(detail);
    // (100 + 28,036) tokens over (5 + 1,189.48) seconds, not the mean of 20 and 23.57.
    assert.equal(detail.throughput.rates.generationTokensPerSecond, 28_136 / 1_194.48);
    assert.equal(detail.throughput.rates.promptTokensPerSecond, 400 / 6);
    // The published rates are the fold's own rates; the wire shape carries only the rates.
    assert.equal(detail.throughput.fold.decode.tokenCount, 28_136);
    assert.deepEqual(toDashboardBenchmarkSessionDetail(detail).throughput, detail.throughput.rates);

    // An unmeasured attempt is excluded rather than silently dragging the cohort to a partial label.
    const third = updateBenchmarkAttempt({ databasePath, attemptId: plan.attempts[2].id, status: 'completed' });
    assert.equal(third?.throughput, null);
    assert.equal(
      readBenchmarkSessionDetail(plan.session.id, databasePath)?.throughput.rates.generationTokensPerSecond,
      28_136 / 1_194.48,
    );
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('the benchmark session aggregate is audited once with a mixed identity when presets span attempts', () => {
  const databasePath = createTempDatabasePath();
  try {
    getRuntimeDatabase(databasePath);
    const prompt = createBenchmarkQuestionPreset({
      databasePath, title: 'Trace repo-search', taskKind: 'repo-search', prompt: 'Trace it.', enabled: true,
    });
    const plan = createBenchmarkSessionPlan({
      databasePath,
      questionPresetIds: [prompt.id],
      repetitions: 1,
      managedPresets: [{ id: 'fast', label: 'Fast preset' }, { id: 'safe', label: 'Safe preset' }],
      specOverrides: [{ label: 'n24-m64', SpeculativeEnabled: false }],
      originalConfigJson: JSON.stringify({ Server: { ModelPresets: { ActivePresetId: 'fast' } } }),
    });
    updateBenchmarkAttempt({
      databasePath, attemptId: plan.attempts[0].id, status: 'completed', throughput: BENCHMARK_FOLD,
    });
    updateBenchmarkAttempt({
      databasePath, attemptId: plan.attempts[1].id, status: 'completed', throughput: DRIFT_FOLD,
    });

    const detail = readBenchmarkSessionDetail(plan.session.id, databasePath);
    assert.ok(detail);
    assert.deepEqual(auditLines(() => auditBenchmarkSessionThroughput(detail)), []);

    // The same aggregate with a tampered published rate is reported against the mixed identity.
    const tampered = {
      ...detail,
      throughput: { ...detail.throughput, rates: { ...detail.throughput.rates, generationTokensPerSecond: 16.5198 } },
    };
    const lines = auditLines(() => auditBenchmarkSessionThroughput(tampered));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /operation=repo-search/u);
    assert.match(lines[0], /stage=benchmark_session/u);
    assert.match(lines[0], /scope=published/u);
    assert.match(lines[0], /metric=decode/u);
    assert.match(lines[0], /model=mixed/u);
    assert.match(lines[0], /preset=mixed/u);
    assert.match(lines[0], /requests=2/u);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('a single-preset benchmark session is audited under that preset', () => {
  const databasePath = createTempDatabasePath();
  try {
    getRuntimeDatabase(databasePath);
    const prompt = createBenchmarkQuestionPreset({
      databasePath, title: 'Summarize', taskKind: 'summary', prompt: 'Summarize it.', enabled: true,
    });
    const plan = createBenchmarkSessionPlan({
      databasePath,
      questionPresetIds: [prompt.id],
      repetitions: 1,
      managedPresets: [{ id: 'fast', label: 'Fast preset' }],
      specOverrides: [{ label: 'n24-m64', SpeculativeEnabled: false }],
      originalConfigJson: JSON.stringify({ Server: { ModelPresets: { ActivePresetId: 'fast' } } }),
    });
    updateBenchmarkAttempt({
      databasePath, attemptId: plan.attempts[0].id, status: 'completed', throughput: DRIFT_FOLD,
    });
    const detail = readBenchmarkSessionDetail(plan.session.id, databasePath);
    assert.ok(detail);
    const lines = auditLines(() => auditBenchmarkSessionThroughput({
      ...detail,
      throughput: { ...detail.throughput, rates: { ...detail.throughput.rates, promptTokensPerSecond: 1 } },
    }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /operation=summary/u);
    assert.match(lines[0], /metric=pp/u);
    assert.match(lines[0], /preset=fast/u);
    assert.match(lines[0], /model=Fast preset/u);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('dashboard benchmark metrics fail loudly instead of reporting an attempt with no run record', () => {
  assert.throws(
    () => buildBenchmarkAttemptMetrics('run-missing', null, 'repo-search'),
    /no run record for run-missing/u,
  );
});

test('dashboard benchmark session plan creates case-prompt-repeat attempts in order and stores grades/logs', () => {
  const databasePath = createTempDatabasePath();
  try {
    getRuntimeDatabase(databasePath);
    const prompt = createBenchmarkQuestionPreset({
      databasePath,
      title: 'Trace repo-search',
      taskKind: 'repo-search',
      prompt: 'Trace repo-search execution.',
      enabled: true,
    });
    const session = createBenchmarkSessionPlan({
      databasePath,
      questionPresetIds: [prompt.id],
      repetitions: 2,
      managedPresets: [
        { id: 'fast', label: 'Fast preset' },
        { id: 'safe', label: 'Safe preset' },
      ],
      specOverrides: [
        {
          label: 'n24-m64',
          SpeculativeEnabled: true,
          SpeculativeType: 'ngram-mod',
          SpeculativeNgramSizeN: 24,
          SpeculativeNgramSizeM: 64,
          SpeculativeNgramMinHits: 2,
          SpeculativeDraftMax: 48,
          SpeculativeDraftMin: 4,
        },
      ],
      originalConfigJson: JSON.stringify({ Server: { ModelPresets: { ActivePresetId: 'fast' } } }),
    });

    assert.equal(session.session.questionPresetCount, 1);
    assert.equal(session.session.caseCount, 2);
    assert.equal(session.session.repetitions, 2);
    assert.deepEqual(
      session.attempts.map((attempt) => `${attempt.caseIndex}:${attempt.promptIndex}:${attempt.repeatIndex}`),
      ['0:0:0', '0:0:1', '1:0:0', '1:0:1'],
    );

    const graded = updateBenchmarkAttemptGrade({
      databasePath,
      attemptId: session.attempts[0].id,
      outputQualityScore: 8,
      toolUseQualityScore: 7,
      reviewNotes: 'Correct and efficient.',
      reviewedBy: 'codex',
    });
    assert.equal(graded?.outputQualityScore, 8);
    assert.equal(graded?.toolUseQualityScore, 7);
    assert.equal(graded?.reviewedBy, 'codex');

    // The fold persists as JSON on the attempt; an attempt never measured stays null.
    const measured = updateBenchmarkAttempt({ databasePath, attemptId: session.attempts[0].id, throughput: BENCHMARK_FOLD });
    assert.deepEqual(measured?.throughput, BENCHMARK_FOLD);
    assert.equal(readBenchmarkAttempt(session.attempts[1].id, databasePath)?.throughput, null);

    assert.throws(() => updateBenchmarkAttemptGrade({
      databasePath,
      attemptId: session.attempts[1].id,
      outputQualityScore: 11,
      toolUseQualityScore: null,
      reviewNotes: '',
      reviewedBy: 'codex',
    }), /0-10/u);

    appendBenchmarkLogChunk({
      databasePath,
      sessionId: session.session.id,
      attemptId: session.attempts[0].id,
      streamKind: 'attempt_stdout',
      chunkText: 'starting attempt\n',
    });
    appendBenchmarkLogChunk({
      databasePath,
      sessionId: session.session.id,
      attemptId: session.attempts[0].id,
      streamKind: 'attempt_stdout',
      chunkText: 'finished attempt\n',
    });
    assert.equal(
      readBenchmarkLogTextByStream({ databasePath, sessionId: session.session.id, attemptId: session.attempts[0].id }).attempt_stdout,
      'starting attempt\nfinished attempt\n',
    );
  } finally {
    closeAllRuntimeDatabases();
  }
});
