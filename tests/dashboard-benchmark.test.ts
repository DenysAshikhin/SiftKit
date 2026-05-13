import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db';
import { buildBenchmarkAttemptMetrics } from '../src/status-server/dashboard-benchmark-runner';
import {
  appendBenchmarkLogChunk,
  createBenchmarkQuestionPreset,
  createBenchmarkSessionPlan,
  deleteBenchmarkQuestionPreset,
  listBenchmarkQuestionPresets,
  readBenchmarkLogTextByStream,
  seedBenchmarkQuestionPresets,
  updateBenchmarkAttemptGrade,
  updateBenchmarkQuestionPreset,
} from '../src/state/dashboard-benchmark';

function createTempDatabasePath(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-benchmark-'));
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
    closeRuntimeDatabase();
  }
});

test('dashboard benchmark runner derives attempt metrics from dashboard run records', () => {
  const metrics = buildBenchmarkAttemptMetrics({
    id: 'run-1',
    kind: 'repo-search',
    status: 'completed',
    startedAtUtc: '2026-05-13T00:00:00.000Z',
    finishedAtUtc: '2026-05-13T00:00:10.000Z',
    title: 'Benchmark run',
    model: 'model',
    backend: 'llama.cpp',
    inputTokens: 100,
    outputTokens: 80,
    thinkingTokens: 20,
    toolTokens: 0,
    promptCacheTokens: 10,
    promptEvalTokens: 200,
    promptEvalDurationMs: 4000,
    generationDurationMs: 5000,
    speculativeAcceptedTokens: 30,
    speculativeGeneratedTokens: 60,
    durationMs: 10000,
    providerDurationMs: 9500,
    wallDurationMs: 10050,
    rawPaths: {},
  });

  assert.deepEqual(metrics, {
    durationMs: 10000,
    promptTokensPerSecond: 50,
    generationTokensPerSecond: 20,
    acceptanceRate: 0.5,
    outputTokens: 80,
    thinkingTokens: 20,
    speculativeAcceptedTokens: 30,
    speculativeGeneratedTokens: 60,
  });
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
      originalConfigJson: JSON.stringify({ Server: { LlamaCpp: { ActivePresetId: 'fast' } } }),
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
    closeRuntimeDatabase();
  }
});
