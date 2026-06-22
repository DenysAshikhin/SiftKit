import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleSummaryResponseSchema } from '@siftkit/contracts';
import { normalizeIdleSummarySnapshotRow } from '../src/status-server/dashboard-runs.js';

test('IdleSummaryResponseSchema accepts an empty payload', () => {
  const payload = { latest: null, snapshots: [] };
  assert.deepEqual(IdleSummaryResponseSchema.parse(payload), payload);
});

test('normalizeIdleSummarySnapshotRow output conforms over the wire', () => {
  const normalized = normalizeIdleSummarySnapshotRow({});
  // The producer holds NaN in-memory for unfilled derived fields; sendJson
  // serializes those to JSON null. Validate the actual wire bytes.
  const wire = JSON.parse(JSON.stringify({
    latest: normalized,
    snapshots: normalized ? [normalized] : [],
  }));
  assert.doesNotThrow(() => IdleSummaryResponseSchema.parse(wire));
});
