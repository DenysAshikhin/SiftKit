import test from 'node:test';
import assert from 'node:assert/strict';

import { DUPLICATE_FORCE_THRESHOLD, DuplicateTracker } from '../src/repo-search/engine/duplicate-tracker.js';

test('classify flags exact duplicates of the last successful normalized key', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('rg -n foo', 'fp-1');
  const result = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'rg -n foo', fingerprint: 'fp-2', rejected: false });
  assert.equal(result.isExactDuplicate, true);
  assert.equal(result.isSemanticDuplicate, false);
});

test('classify flags semantic duplicates by fingerprint, not for rejected commands', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('rg -n foo', 'fp-1');
  const semantic = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'rg -n foo --glob "!x"', fingerprint: 'fp-1', rejected: false });
  assert.equal(semantic.isSemanticDuplicate, true);
  const rejected = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'rg -n foo --glob "!x"', fingerprint: 'fp-1', rejected: true });
  assert.equal(rejected.isSemanticDuplicate, false);
});

test('classify falls back to toolName|normalizedKey when fingerprint is empty', () => {
  const tracker = new DuplicateTracker();
  const result = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'bad cmd', fingerprint: '', rejected: true });
  assert.equal(result.duplicateFingerprint, 'run_repo_cmd|bad cmd');
});

test('classify returns no duplicate before a success and when the prior success has no fingerprint', () => {
  const tracker = new DuplicateTracker();
  const fresh = tracker.classify({ toolName: 'run_repo_cmd', normalizedKey: 'rg -n foo', fingerprint: 'fp-1', rejected: false });
  assert.equal(fresh.isExactDuplicate, false);
  assert.equal(fresh.isSemanticDuplicate, false);

  tracker.recordSuccess('rg -n foo', null);
  const semanticWithoutPriorFingerprint = tracker.classify({
    toolName: 'run_repo_cmd',
    normalizedKey: 'rg -n foo --glob "!x"',
    fingerprint: 'fp-1',
    rejected: false,
  });
  assert.equal(semanticWithoutPriorFingerprint.isExactDuplicate, false);
  assert.equal(semanticWithoutPriorFingerprint.isSemanticDuplicate, false);
});

test('registerDuplicate starts at 2 and increments only while the replay message is live', () => {
  const tracker = new DuplicateTracker();
  const first = tracker.registerDuplicate('fp-1', 10);
  assert.equal(first.count, 2);
  assert.equal(first.activeReplayMessageIndex, null);
  tracker.setReplayToolMessageIndex(4);
  const second = tracker.registerDuplicate('fp-1', 10);
  assert.equal(second.count, 3);
  assert.equal(second.activeReplayMessageIndex, 4);
  // index beyond message count -> treated as fresh
  const stale = tracker.registerDuplicate('fp-1', 3);
  assert.equal(stale.count, 2);
  assert.equal(stale.activeReplayMessageIndex, null);
});

test('shouldForceFinish fires at DUPLICATE_FORCE_THRESHOLD and recordSuccess resets everything', () => {
  const tracker = new DuplicateTracker();
  tracker.setReplayToolMessageIndex(1);
  for (let i = 0; i < DUPLICATE_FORCE_THRESHOLD - 1; i += 1) {
    tracker.registerDuplicate('fp-1', 10);
    tracker.setReplayToolMessageIndex(1);
  }
  assert.equal(tracker.shouldForceFinish(), true);
  tracker.recordSuccess('new key', 'fp-9');
  assert.equal(tracker.shouldForceFinish(), false);
  assert.equal(tracker.registerDuplicate('fp-1', 10).count, 2);
});
