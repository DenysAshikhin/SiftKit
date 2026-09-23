import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelRequestCandidateSchema,
  selectNextModelRequest,
  type ModelRequestCandidate,
} from '../src/status-server/model-request-selection.js';

test('a later resident-model request overtakes an older different-model request', () => {
  const candidates = [
    { queueToken: 'b1', resident: false },
    { queueToken: 'a1', resident: true },
    { queueToken: 'c1', resident: false },
    { queueToken: 'a2', resident: true },
  ];
  assert.equal(selectNextModelRequest(candidates, 0), 'a1');
  assert.equal(selectNextModelRequest(candidates.filter(item => item.queueToken !== 'a1'), 0), 'a2');
  assert.equal(selectNextModelRequest([{ queueToken: 'b1', resident: false }], 1), null);
  assert.equal(selectNextModelRequest([{ queueToken: 'b1', resident: false }], 0), 'b1');
});

test('preserves arrival order within resident requests and returns null without candidates', () => {
  const candidates: ModelRequestCandidate[] = [
    { queueToken: 'a1', resident: true },
    { queueToken: 'a2', resident: true },
    { queueToken: 'a3', resident: true },
  ];
  assert.equal(selectNextModelRequest(candidates, 0), 'a1');
  assert.equal(selectNextModelRequest(candidates.slice(1), 2), 'a2');
  assert.equal(selectNextModelRequest([], 0), null);
});

test('the candidate schema is the selector input contract', () => {
  const parsed = ModelRequestCandidateSchema.parse({ queueToken: 't1', resident: true });
  assert.deepEqual(parsed, { queueToken: 't1', resident: true });
  assert.equal(ModelRequestCandidateSchema.safeParse({ queueToken: 't1' }).success, false);
  assert.equal(ModelRequestCandidateSchema.safeParse({ queueToken: 't1', resident: 'yes' }).success, false);
});
