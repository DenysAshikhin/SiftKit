import assert from 'node:assert/strict';
import test from 'node:test';

import { renderRunDigest, type RunDigestInput } from '../src/orchestrator/digest.ts';
import { makeOrchestratorPlan, makeOrchestratorTask, makeTaskState } from './helpers/orchestrator-plan.ts';

const AT = '2026-11-21T10:00:00.000Z';

const plan = makeOrchestratorPlan([
  makeOrchestratorTask({ id: 'locate', title: 'Locate the store', writePaths: ['src/store-index.ts'] }),
  makeOrchestratorTask({ id: 'store', title: 'Add the store', dependsOn: ['locate'], workerPresetId: 'repo-agent',
    writePaths: ['src/store.ts', 'tests/store.test.ts'] }),
]);

function input(overrides: Partial<RunDigestInput> = {}): RunDigestInput {
  return {
    plan, planPath: '.siftkit/orchestrator/r/plan.md', ledger: 'Task ledger:\n- locate: completed\n- store: reviewing',
    tasks: [makeTaskState('locate', 'completed'), makeTaskState('store', 'reviewing', { review: {
      attempt: 1, purpose: 'implementation', verdict: 'fail', criteria: [],
      findings: [{ path: 'src/store.ts', line: 12, issue: 'save() ignores the revision.' }],
    } })],
    approaches: [{ number: 1, title: 'Initial plan', startedAtUtc: AT, outcome: null }], retiredTasks: [],
    pendingReports: [], pendingApprovals: [], lastFailedFinish: null, ...overrides,
  };
}

test('the digest says the conversation was dropped and outlines the plan, the ledger and failed reviews', () => {
  const digest = renderRunDigest(input());
  assert.match(digest, /earlier conversation was dropped/u);
  assert.match(digest, /re-read/iu);
  assert.match(digest, /Plan: \.siftkit\/orchestrator\/r\/plan\.md/u);
  assert.match(digest, /Goal: Exercise the orchestrator\./u);
  assert.match(digest, /- locate: Locate the store \(repo-agent; writes src\/store-index\.ts\)/u);
  assert.match(digest, /- store: Add the store \(repo-agent; writes src\/store\.ts, tests\/store\.test\.ts; after locate\)/u);
  assert.match(digest, /Task ledger:\n- locate: completed\n- store: reviewing/u);
  assert.match(digest, /store \(implementation attempt 1\) failed review:\n- src\/store\.ts:12 save\(\) ignores the revision\./u);
  assert.doesNotMatch(digest, /finish/iu);
  assert.doesNotMatch(digest, /waiting for record_review|waiting for decide/u);
});

test('the digest repeats reports still to review and approvals still to answer', () => {
  const digest = renderRunDigest(input({ pendingReports: ['## Report: store'], pendingApprovals: ['## Approval needed: store'] }));
  assert.match(digest, /Reports waiting for record_review:\n\n## Report: store/u);
  assert.match(digest, /Approvals waiting for decide:\n\n## Approval needed: store/u);
});

test('before a plan exists the digest says planning is unfinished', () => {
  const digest = renderRunDigest(input({ plan: null, planPath: null, tasks: [], ledger: 'No plan saved yet.' }));
  assert.match(digest, /No plan saved yet/u);
  assert.doesNotMatch(digest, /Plan: /u);
});

test('the digest lists every approach with its lesson and every retired task with its reason, and neither while there is nothing to learn from', () => {
  assert.doesNotMatch(renderRunDigest(input()), /Approaches so far|Retired tasks/u);
  const digest = renderRunDigest(input({
    approaches: [
      { number: 1, title: 'Initial plan', startedAtUtc: AT,
        outcome: { kind: 'rolled_back', lesson: 'Response caching cannot see headers.', endedAtUtc: AT } },
      { number: 2, title: 'Cache the index', startedAtUtc: AT, outcome: null }],
    retiredTasks: [{ taskId: 'cache', title: 'Cache responses', approach: 1, status: 'failed', reason: 'Out of attempts.', retiredAtUtc: AT }],
  }));
  assert.match(digest, /Approaches so far \(never repeat one a lesson ruled out\):\n- 1\. Initial plan: rolled back\. Lesson: Response caching cannot see headers\.\n- 2\. Cache the index: active/u);
  assert.match(digest, /Retired tasks \(their ids cannot be reused\):\n- cache: Cache responses \(approach 1, failed\)\. Out of attempts\./u);
});

test('the digest repeats why the last finish failed', () => {
  const digest = renderRunDigest(input({ lastFailedFinish: ['Check `npm test` exited 1; expected 0.'] }));
  assert.match(digest, /The last finish failed final verification:\n- Check `npm test` exited 1; expected 0\./u);
});
