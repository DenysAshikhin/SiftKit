import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelRequestCandidateSchema,
  selectNextModelRequest,
  type ModelRequestCandidate,
} from '../src/status-server/model-request-selection.js';

test('a later resident-model request overtakes an older different-model request', () => {
  const candidates = [
    { queueToken: 'b1', residencyKey: 'B' },
    { queueToken: 'a1', residencyKey: 'A' },
    { queueToken: 'c1', residencyKey: 'C' },
    { queueToken: 'a2', residencyKey: 'A' },
  ];
  assert.equal(selectNextModelRequest(candidates, 'A', 0), 'a1');
  assert.equal(selectNextModelRequest(candidates.filter(item => item.queueToken !== 'a1'), 'A', 0), 'a2');
  assert.equal(selectNextModelRequest([{ queueToken: 'b1', residencyKey: 'B' }], 'A', 1), null);
  assert.equal(selectNextModelRequest([{ queueToken: 'b1', residencyKey: 'B' }], 'A', 0), 'b1');
});

test('preserves arrival order within a matching key and returns null without candidates', () => {
  const candidates: ModelRequestCandidate[] = [
    { queueToken: 'a1', residencyKey: 'A' },
    { queueToken: 'a2', residencyKey: 'A' },
    { queueToken: 'a3', residencyKey: 'A' },
  ];
  assert.equal(selectNextModelRequest(candidates, 'A', 0), 'a1');
  assert.equal(selectNextModelRequest(candidates.slice(1), 'A', 2), 'a2');
  assert.equal(selectNextModelRequest([], 'A', 0), null);
});

test('the candidate schema is the selector input contract', () => {
  const parsed = ModelRequestCandidateSchema.parse({ queueToken: 't1', residencyKey: 'K' });
  assert.deepEqual(parsed, { queueToken: 't1', residencyKey: 'K' });
  assert.equal(ModelRequestCandidateSchema.safeParse({ queueToken: 't1' }).success, false);
  assert.equal(ModelRequestCandidateSchema.safeParse({ queueToken: 't1', residencyKey: '' }).success, true);
});