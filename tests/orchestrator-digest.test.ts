import assert from 'node:assert/strict';
import test from 'node:test';

import { renderRunDigest, type RunDigestInput } from '../src/orchestrator/digest.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';

const plan = makeOrchestratorPlan([
  makeOrchestratorTask({ id: 'survey', title: 'Survey the store' }),
  makeOrchestratorTask({ id: 'store', title: 'Add the store', dependsOn: ['survey'], workerPresetId: 'repo-agent',
    writePaths: ['src/store.ts', 'tests/store.test.ts'] }),
]);

function input(overrides: Partial<RunDigestInput> = {}): RunDigestInput {
  return {
    plan, planPath: '.siftkit/orchestrator/r/plan.md', ledger: 'Task ledger:\n- survey: completed\n- store: reviewing',
    tasks: [{ taskId: 'survey', status: 'completed', review: null }, { taskId: 'store', status: 'reviewing', review: {
      attempt: 1, purpose: 'implementation', verdict: 'fail', criteria: [],
      findings: [{ path: 'src/store.ts', line: 12, issue: 'save() ignores the revision.' }],
    } }],
    pendingReports: [], pendingApprovals: [], finishAttempts: 0, ...overrides,
  };
}

test('the digest says the conversation was dropped and outlines the plan, the ledger and failed reviews', () => {
  const digest = renderRunDigest(input());
  assert.match(digest, /earlier conversation was dropped/u);
  assert.match(digest, /re-read/iu);
  assert.match(digest, /Plan: \.siftkit\/orchestrator\/r\/plan\.md/u);
  assert.match(digest, /Goal: Exercise the orchestrator\./u);
  assert.match(digest, /- survey: Survey the store \(repo-search; writes nothing\)/u);
  assert.match(digest, /- store: Add the store \(repo-agent; writes src\/store\.ts, tests\/store\.test\.ts; after survey\)/u);
  assert.match(digest, /Task ledger:\n- survey: completed\n- store: reviewing/u);
  assert.match(digest, /store \(implementation attempt 1\) failed review:\n- src\/store\.ts:12 save\(\) ignores the revision\./u);
  assert.match(digest, /0 of 3 finish attempts used/u);
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
