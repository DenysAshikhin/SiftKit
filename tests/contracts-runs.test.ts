import test from 'node:test';
import assert from 'node:assert/strict';
import { RunRecordSchema, RunsResponseSchema } from '@siftkit/contracts';
import { normalizeRunRecord } from '../src/status-server/dashboard-runs/run-records.js';

test('RunsResponseSchema rejects a missing total', () => {
  assert.throws(() => RunsResponseSchema.parse({ runs: [] }));
});

test('normalizeRunRecord output satisfies RunRecordSchema (conformance)', () => {
  const record = normalizeRunRecord({ id: 'r1', kind: 'summary', status: 'completed', title: 't', rawPaths: {} });
  assert.doesNotThrow(() => RunRecordSchema.parse(record));
});
