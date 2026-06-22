import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBenchmarkStartRequest } from '../dashboard/src/hooks/useBenchmarkController.js';

test('builds a start request from selection', () => {
  assert.deepEqual(
    buildBenchmarkStartRequest({ questionPresetIds: ['q1'], managedPresetIds: ['m1'], repetitions: 3, specOverrides: [{ a: 1 }] }),
    { questionPresetIds: ['q1'], managedPresetIds: ['m1'], repetitions: 3, specOverrides: [{ a: 1 }] });
});
