import assert from 'node:assert/strict';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import { AssistantBackgroundDecisionHistoryResponseSchema } from '@siftkit/contracts';
import { FixedClock } from '../src/assistant/clock.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { BackgroundWorkDecisionStore } from '../src/assistant/storage/background-work-decision-store.js';
import { JobStore } from '../src/assistant/storage/job-store.js';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.js';
import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const START = '2026-08-31T12:00:00.000Z';

afterEach(() => closeRuntimeDatabase());

function enqueuePendingJob(jobs: JobStore): void {
  jobs.enqueue(
    {
      ownerId: LOCAL_OWNER_ID,
      jobType: 'capture_retention',
      payload: { reason: 'schedule' },
      idempotencyKey: 'capture_retention:schedule',
    },
    900,
  );
}

test('background-work decisions persist across a database reopen', () => {
  const runtimeRoot = createManagedTempDir(
    'siftkit-background-decisions-persist-',
  );
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  const clock = new FixedClock(START);
  const database = getRuntimeDatabase(databasePath);
  enqueuePendingJob(new JobStore(database, clock, new SequentialIdGenerator()));
  new BackgroundWorkDecisionStore(database, clock).record(LOCAL_OWNER_ID, {
    reason: 'mouse_idle_below_threshold',
    details: { mouseIdleSeconds: 12, requiredIdleSeconds: 180 },
  });
  closeRuntimeDatabase();

  const reopened = getRuntimeDatabase(databasePath);
  const items = new BackgroundWorkDecisionStore(reopened, clock).list(
    LOCAL_OWNER_ID,
  );
  assert.deepEqual(items, [
    {
      recordedAtUtc: START,
      reason: 'mouse_idle_below_threshold',
      queuedJobCount: 1,
      pendingCaptureCount: 0,
      details: { mouseIdleSeconds: 12, requiredIdleSeconds: 180 },
    },
  ]);
});

test('background-work decision history retains only the newest 100 entries', () => {
  const runtimeRoot = createManagedTempDir('siftkit-background-decisions-cap-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  const clock = new FixedClock(START);
  enqueuePendingJob(new JobStore(database, clock, new SequentialIdGenerator()));
  const store = new BackgroundWorkDecisionStore(database, clock);

  for (let index = 0; index < 101; index += 1) {
    store.record(LOCAL_OWNER_ID, {
      reason: 'mouse_idle_below_threshold',
      details: { mouseIdleSeconds: index, requiredIdleSeconds: 180 },
    });
    clock.advanceSeconds(1);
  }

  const items = store.list(LOCAL_OWNER_ID);
  assert.equal(items.length, 100);
  const newest = items[0];
  const oldest = items.at(-1);
  assert.ok(newest?.reason === 'mouse_idle_below_threshold');
  assert.ok(oldest?.reason === 'mouse_idle_below_threshold');
  assert.equal(newest.details.mouseIdleSeconds, 100);
  assert.equal(oldest.details.mouseIdleSeconds, 1);
});

test('background-work decisions are not written when nothing is pending', () => {
  const runtimeRoot = createManagedTempDir(
    'siftkit-background-decisions-empty-',
  );
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  const clock = new FixedClock(START);
  const store = new BackgroundWorkDecisionStore(database, clock);

  store.record(LOCAL_OWNER_ID, { reason: 'server_busy', details: {} });

  assert.deepEqual(store.list(LOCAL_OWNER_ID), []);
});

test('malformed persisted background-work decisions fail loudly', () => {
  const runtimeRoot = createManagedTempDir(
    'siftkit-background-decisions-invalid-',
  );
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  const clock = new FixedClock(START);
  database
    .prepare(
      `
    INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)
  `,
    )
    .run('assistant.background_work_decisions.v1', '{', clock.nowUtc());

  assert.throws(() =>
    new BackgroundWorkDecisionStore(database, clock).list(LOCAL_OWNER_ID),
  );
});

test('background-work decision responses reject unknown fields', () => {
  assert.throws(() =>
    AssistantBackgroundDecisionHistoryResponseSchema.parse({
      items: [],
      unexpected: true,
    }),
  );
});
