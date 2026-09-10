import test from 'node:test';
import assert from 'node:assert/strict';

import { DUPLICATE_FORCE_THRESHOLD, DuplicateTracker } from '../src/repo-search/engine/duplicate-tracker.js';

test('classify flags exact duplicates of an earlier successful normalized key', () => {
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

test('registerDuplicate starts at 2 and increments only while the answered call is live', () => {
  const tracker = new DuplicateTracker();
  const first = tracker.registerDuplicate('fp-1', false);
  assert.equal(first.count, 2);
  assert.equal(first.activeReplayToolCallId, null);
  tracker.setReplayToolCallId('t1_c0');
  const second = tracker.registerDuplicate('fp-1', true);
  assert.equal(second.count, 3);
  assert.equal(second.activeReplayToolCallId, 't1_c0');
  // the anchored call is no longer in the transcript -> treated as fresh
  const stale = tracker.registerDuplicate('fp-1', false);
  assert.equal(stale.count, 2);
  assert.equal(stale.activeReplayToolCallId, null);
});

test('shouldForceFinish fires at DUPLICATE_FORCE_THRESHOLD and recordSuccess resets everything', () => {
  const tracker = new DuplicateTracker();
  tracker.setReplayToolCallId('t1_c0');
  for (let i = 0; i < DUPLICATE_FORCE_THRESHOLD - 1; i += 1) {
    tracker.registerDuplicate('fp-1', true);
    tracker.setReplayToolCallId('t1_c0');
  }
  assert.equal(tracker.shouldForceFinish(), true);
  tracker.recordSuccess('new key', 'fp-9');
  assert.equal(tracker.shouldForceFinish(), false);
  assert.equal(tracker.registerDuplicate('fp-1', false).count, 2);
});

test('classify flags an exact duplicate even after other tools succeeded in between', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('find pattern="**/architecture_overview.md"', 'fp-find');
  tracker.recordSuccess('ls path="src"', 'fp-ls');
  const repeat = tracker.classify({
    toolName: 'find',
    normalizedKey: 'find pattern="**/architecture_overview.md"',
    fingerprint: 'fp-find',
    rejected: false,
  });
  assert.equal(repeat.isExactDuplicate, true);
});

test('classify flags a semantic duplicate of any earlier success, not only the last', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('grep pattern="alpha"', 'fp-grep');
  tracker.recordSuccess('ls path="src"', 'fp-ls');
  const repeat = tracker.classify({
    toolName: 'grep',
    normalizedKey: 'grep pattern="alpha" limit=50',
    fingerprint: 'fp-grep',
    rejected: false,
  });
  assert.equal(repeat.isExactDuplicate, false);
  assert.equal(repeat.isSemanticDuplicate, true);
});

test('forgetSuccesses clears the run-wide memory so a post-mutation repeat is allowed', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('grep pattern="alpha"', 'fp-grep');
  tracker.forgetSuccesses();
  const after = tracker.classify({
    toolName: 'grep',
    normalizedKey: 'grep pattern="alpha"',
    fingerprint: 'fp-grep',
    rejected: false,
  });
  assert.equal(after.isExactDuplicate, false);
  assert.equal(after.isSemanticDuplicate, false);
});

test('registerDuplicate ignores an anchor whose tool result a compaction dropped', () => {
  const tracker = new DuplicateTracker();
  tracker.registerDuplicate('fp', false);
  tracker.setReplayToolCallId('t1_c0');
  const stillPresent = tracker.registerDuplicate('fp', true);
  assert.equal(stillPresent.activeReplayToolCallId, 't1_c0');
  tracker.setReplayToolCallId('t1_c0');
  const afterCompaction = tracker.registerDuplicate('fp', false);
  assert.equal(afterCompaction.activeReplayToolCallId, null);
});
