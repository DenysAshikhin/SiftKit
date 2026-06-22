import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardBenchmarkSessionDetailSchema, DashboardBenchmarkStartRequestSchema } from '@siftkit/contracts';

test('start request requires repetitions', () => {
  assert.throws(() => DashboardBenchmarkStartRequestSchema.parse({ questionPresetIds: [], managedPresetIds: [], specOverrides: [] }));
});

test('session detail accepts empty cases/attempts', () => {
  const detail = {
    session: {
      id: 's', status: 'completed', questionPresetCount: 0, caseCount: 0, repetitions: 1,
      currentCaseIndex: null, currentPromptIndex: null, currentRepeatIndex: null,
      restoreStatus: 'completed', restoreError: null, originalConfigJson: '{}',
      startedAtUtc: 'a', completedAtUtc: null, updatedAtUtc: 'b',
    }, cases: [], attempts: [],
  };
  assert.deepEqual(DashboardBenchmarkSessionDetailSchema.parse(detail), detail);
});
