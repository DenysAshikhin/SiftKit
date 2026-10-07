import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildBenchmarkStartRequest } from '../src/hooks/useBenchmarkController.ts';

test('builds a start request from selection', () => {
  assert.deepEqual(
    buildBenchmarkStartRequest({ questionPresetIds: ['q1'], managedPresetIds: ['m1'], repetitions: 3, specOverrides: [{ a: 1 }] }),
    { questionPresetIds: ['q1'], managedPresetIds: ['m1'], repetitions: 3, specOverrides: [{ a: 1 }] });
});
