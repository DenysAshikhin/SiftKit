import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { OrchestratorActivity, OrchestratorSchedule } from '@siftkit/contracts';
import { OrchestratorLiveActivity } from '../src/orchestrator/live-activity.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import type { OperationProgressEvent } from '../src/repo-search/types.ts';
import { OrchestratorRunRegistry } from '../src/status-server/orchestrator-runs.ts';
import type { RepoAgentSessionSubscriber } from '../src/status-server/repo-agent-sessions.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';

function openRegistry(t: TestContext): { registry: OrchestratorRunRegistry; published: OrchestratorActivity[] } {
  const dbPath = path.join(createManagedTempDir('siftkit-live-activity-'), 'runtime.sqlite');
  t.after(() => closeAllRuntimeDatabases());
  const registry = new OrchestratorRunRegistry(new OrchestratorRunStore(getRuntimeDatabase(dbPath)));
  const published: OrchestratorActivity[] = [];
  registry.subscribeActivity(RUN_ID, (activity) => published.push(activity));
  return { registry, published };
}

class FakeSession {
  subscriber: RepoAgentSessionSubscriber | null = null;
  detached = false;

  attach(subscriber: RepoAgentSessionSubscriber): () => void {
    this.subscriber = subscriber;
    return () => { this.detached = true; };
  }

  emit(event: OperationProgressEvent): void {
    if (this.subscriber === null) throw new Error('No subscriber attached.');
    this.subscriber.writeProgress(event);
  }
}

const SCHEDULE: OrchestratorSchedule = {
  claims: [{ taskId: 'write', modelId: 'exl3-main', mutating: true, contextTokens: 4000 }],
  models: [{ modelId: 'exl3-main', slots: 2, used: 1 }], writerUsed: true, waits: [],
};

test('each scheduler pass is published as it was decided, and a snapshot is a copy the caller cannot change', (t) => {
  const { registry, published } = openRegistry(t);
  const live = new OrchestratorLiveActivity(RUN_ID, registry);
  assert.equal(live.snapshot().schedule, null, 'no schedule before the first pass');
  live.setSchedule(SCHEDULE);
  assert.deepEqual(published.at(-1), { runId: RUN_ID, schedule: SCHEDULE, parent: null, children: [] });
  const snapshot = live.snapshot();
  snapshot.schedule?.claims.pop();
  snapshot.children.push({ childRunId: CHILD_ID, taskId: 'x', waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [] });
  assert.deepEqual(live.snapshot(), { runId: RUN_ID, schedule: SCHEDULE, parent: null, children: [] });
});

test('a tracked child publishes visible progress only; untracking detaches it and drops it from the view', (t) => {
  const { registry, published } = openRegistry(t);
  const live = new OrchestratorLiveActivity(RUN_ID, registry);
  const session = new FakeSession();
  live.track(session, { childRunId: CHILD_ID, taskId: 'write' });
  assert.deepEqual(published.at(-1)?.children.map((child) => [child.childRunId, child.turn, child.maxTurns]), [[CHILD_ID, 0, null]]);
  session.emit({ kind: 'llm_start', turn: 1, maxTurns: 40, promptTokenCount: 800, thinkingTokenCount: 0, elapsedMs: 10 });
  const count = published.length;
  session.emit({ kind: 'thinking', turn: 1, maxTurns: 40, thinkingText: 'hmm' });
  assert.equal(published.length, count, 'thinking text changes nothing visible');
  assert.deepEqual(live.snapshot().children.map((child) => [child.turn, child.maxTurns, child.promptTokens]), [[1, 40, 800]]);
  live.untrack(CHILD_ID);
  assert.equal(session.detached, true);
  assert.deepEqual(published.at(-1)?.children, []);
});

test('the parent conversation opens with its prompt, publishes parking at once, and streams at most every 250 ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { registry, published } = openRegistry(t);
  const live = new OrchestratorLiveActivity(RUN_ID, registry);
  live.applyParent({ kind: 'lock_wait', elapsedMs: 1 });
  assert.equal(published.length, 0, 'nothing streams before the parent starts');
  live.startParent({ system: 'You orchestrate.', user: 'Go.' });
  assert.deepEqual(published.at(-1)?.parent?.prompt, { system: 'You orchestrate.', user: 'Go.' });
  const thinking = (text: string): OperationProgressEvent => ({ kind: 'thinking', turn: 1, maxTurns: 600, thinkingText: text });
  live.applyParent(thinking('a'));
  live.applyParent(thinking('ab'));
  const count = published.length;
  t.mock.timers.tick(249);
  assert.equal(published.length, count, 'token-by-token thinking waits for the interval');
  t.mock.timers.tick(1);
  assert.equal(published.length, count + 1);
  assert.equal(published.at(-1)?.parent?.turns[0]?.thinking, 'ab', 'one frame carries the latest text');
  live.setParentParked(true);
  assert.equal(published.at(-1)?.parent?.parked, true);
  live.applyParent(thinking('abc'));
  live.close();
  t.mock.timers.tick(1_000);
  assert.equal(published.at(-1)?.parent?.turns[0]?.thinking, 'ab', 'a closed view publishes nothing more');
});
