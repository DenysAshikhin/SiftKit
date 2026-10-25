import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext } from './helpers/assistant-fixture.ts';

test('enqueue is idempotent while a job with the same key is live', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const first = graph.jobs.enqueue({
      ownerId, jobType: 'capture_note',
      payload: { attachmentId: 'vatt_1' }, idempotencyKey: 'ev_1',
    }, 800);
    assert.notEqual(first, null);
    const duplicate = graph.jobs.enqueue({
      ownerId, jobType: 'capture_note',
      payload: { attachmentId: 'vatt_1' }, idempotencyKey: 'ev_1',
    }, 800);
    assert.equal(duplicate, null, 'a replayed enqueue must be a no-op');
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
  });
});

test('enqueueSuperseding cancels older queued jobs of the same type but not running ones', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const first = graph.jobs.enqueue({
      ownerId, jobType: 'daily_rollup',
      payload: { day: '2026-10-24' }, idempotencyKey: 'daily_rollup:1',
    }, 0);
    assert.ok(first);
    const second = graph.jobs.enqueueSuperseding({
      ownerId, jobType: 'daily_rollup',
      payload: { day: '2026-10-24' }, idempotencyKey: 'daily_rollup:2',
    }, 0);
    assert.ok(second);
    assert.equal(graph.jobs.getJob(first.id)?.status, 'cancelled');
    assert.equal(graph.jobs.getJob(second.id)?.status, 'queued');

    graph.jobs.claimNext({
      ownerId, leaseOwner: 'test', leaseSeconds: 60, modelWorkAllowed: true,
    });
    const third = graph.jobs.enqueueSuperseding({
      ownerId, jobType: 'daily_rollup',
      payload: { day: '2026-10-24' }, idempotencyKey: 'daily_rollup:3',
    }, 0);
    assert.ok(third);
    assert.equal(graph.jobs.getJob(second.id)?.status, 'running');
    assert.equal(graph.jobs.getJob(third.id)?.status, 'queued');
  });
});

test('claimNext takes the highest priority available job and leases it', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'daily_rollup',
      payload: { day: '2026-10-24' }, idempotencyKey: 'proj_1',
    }, 900);
    graph.jobs.enqueue({
      ownerId, jobType: 'capture_note',
      payload: { attachmentId: 'vatt_1' }, idempotencyKey: 'ev_1',
    }, 100);
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120, modelWorkAllowed: true });
    assert.equal(claimed?.job_type, 'daily_rollup');
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.lease_owner, 'runner_a');
    assert.equal(
      claimed?.lease_expires_at_utc,
      new Date(clock.nowEpochMs() + 120_000).toISOString(),
    );

    const second = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120, modelWorkAllowed: true });
    assert.equal(second?.job_type, 'capture_note');
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120, modelWorkAllowed: true }), null);
  });
});

test('completing a job frees the idempotency key', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const enqueued = graph.jobs.enqueue({
      ownerId, jobType: 'capture_note',
      payload: { attachmentId: 'vatt_1' }, idempotencyKey: 'ev_1',
    }, 800);
    assert.notEqual(enqueued, null);
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true });
    assert.notEqual(claimed, null);
    graph.jobs.complete(claimed?.id ?? '');
    assert.equal(graph.jobs.countByStatus(ownerId, 'completed'), 1);
    assert.notEqual(graph.jobs.enqueue({
      ownerId, jobType: 'capture_note',
      payload: { attachmentId: 'vatt_1' }, idempotencyKey: 'ev_1',
    }, 800), null);
  });
});

test('failure re-queues with backoff until max attempts, then dead-letters', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'note_tidy',
      payload: { noteId: 'vnote_1' }, idempotencyKey: 'tidy_1',
    }, 400);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true });
      assert.notEqual(claimed, null, `attempt ${attempt} should claim`);
      const failed = graph.jobs.fail(claimed?.id ?? '', `boom ${attempt}`);
      if (attempt < 3) {
        assert.equal(failed.status, 'queued');
        assert.equal(failed.last_error, `boom ${attempt}`);
        clock.advanceSeconds(300);
      } else {
        assert.equal(failed.status, 'dead_letter');
      }
    }
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true }), null);
  });
});

test('a backed-off job is not claimable until its available time', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'daily_rollup',
      payload: { day: '2026-10-24' }, idempotencyKey: 'proj_1',
    }, 300);
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true });
    graph.jobs.fail(claimed?.id ?? '', 'boom');
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true }), null);
    clock.advanceSeconds(31);
    assert.notEqual(
      graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true }),
      null,
    );
  });
});

test('preemption re-queues immediately and does not consume an attempt', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'capture_note',
      payload: { attachmentId: 'vatt_1' }, idempotencyKey: 'ev_1',
    }, 800);
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true });
    assert.equal(claimed?.attempts, 1);
    const requeued = graph.jobs.requeuePreempted(claimed?.id ?? '');
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.attempts, 0);
    assert.equal(requeued.lease_owner, null);
    assert.notEqual(
      graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_b', leaseSeconds: 60, modelWorkAllowed: true }),
      null,
    );
  });
});

test('expired leases return to the queue on recovery', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'capture_note',
      payload: { attachmentId: 'vatt_1' }, idempotencyKey: 'ev_1',
    }, 800);
    graph.jobs.claimNext({ ownerId, leaseOwner: 'dead_runner', leaseSeconds: 60, modelWorkAllowed: true });
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 0, 'lease is still valid');
    clock.advanceSeconds(61);
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 1);
    const reclaimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true });
    assert.equal(reclaimed?.attempts, 2, 'the crashed attempt still counts');
  });
});

test('every payload round-trips through its own schema and is read only as its own type', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const turn = {
      sessionId: 'chat_1', sessionTitle: 'Tools', userMessageId: 'msg_1', capturedAtUtc: '2026-10-24T09:00:00.000Z',
      userText: 'I use Neovim.', assistantText: 'Nice.',
    };
    const enqueue = (jobType: 'capture_note' | 'chat_note' | 'daily_rollup' | 'note_tidy' | 'capture_retention', payload: { [key: string]: string }) => (
      graph.jobs.requireJob(graph.jobs.enqueue({ ownerId, jobType, payload, idempotencyKey: jobType }, 1)?.id ?? '')
    );
    assert.deepEqual(graph.jobs.readCaptureNotePayload(enqueue('capture_note', { attachmentId: 'vatt_9' })), { attachmentId: 'vatt_9' });
    assert.deepEqual(graph.jobs.readChatNotePayload(enqueue('chat_note', turn)), turn);
    assert.deepEqual(graph.jobs.readDailyRollupPayload(enqueue('daily_rollup', { day: '2026-10-24' })), { day: '2026-10-24' });
    assert.deepEqual(graph.jobs.readNoteTidyPayload(enqueue('note_tidy', { noteId: 'vnote_1' })), { noteId: 'vnote_1' });
    assert.deepEqual(graph.jobs.readCaptureRetentionPayload(enqueue('capture_retention', { reason: 'capacity' })), { reason: 'capacity' });
    assert.throws(() => graph.jobs.readNoteTidyPayload(graph.jobs.listByStatus(ownerId, 'queued').find((job) => job.job_type === 'capture_note') ?? enqueue('capture_note', {})), /not note_tidy/);
  });
});

test('malformed payloads are rejected when read', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const job = (jobType: 'daily_rollup' | 'chat_note', payload: { [key: string]: string }, key: string) => (
      graph.jobs.requireJob(graph.jobs.enqueue({ ownerId, jobType, payload, idempotencyKey: key }, 1)?.id ?? '')
    );
    assert.throws(() => graph.jobs.readDailyRollupPayload(job('daily_rollup', { day: 'yesterday' }, 'bad-day')));
    assert.throws(() => graph.jobs.readChatNotePayload(job('chat_note', { sessionId: 'chat_1' }, 'bad-turn')));
  });
});

test('pruneTerminal deletes old terminal jobs and keeps live and recent ones', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const oldJob = graph.jobs.enqueue({
      ownerId, jobType: 'capture_retention',
      payload: { reason: 'schedule' }, idempotencyKey: 'k1',
    }, 0);
    assert.ok(oldJob);
    graph.jobs.claimNext({
      ownerId, leaseOwner: 'test', leaseSeconds: 60, modelWorkAllowed: true,
    });
    graph.jobs.complete(oldJob.id);

    clock.advanceSeconds(1);
    const recentJob = graph.jobs.enqueue({
      ownerId, jobType: 'capture_retention',
      payload: { reason: 'schedule' }, idempotencyKey: 'k2',
    }, 0);
    assert.ok(recentJob);
    graph.jobs.claimNext({
      ownerId, leaseOwner: 'test', leaseSeconds: 60, modelWorkAllowed: true,
    });
    graph.jobs.complete(recentJob.id);
    const liveJob = graph.jobs.enqueue({
      ownerId, jobType: 'capture_retention',
      payload: { reason: 'schedule' }, idempotencyKey: 'k3',
    }, 0);
    assert.ok(liveJob);

    assert.equal(graph.jobs.pruneTerminal(ownerId, clock.nowUtc()), 1);
    assert.equal(graph.jobs.getJob(oldJob.id), null);
    assert.equal(graph.jobs.getJob(recentJob.id)?.status, 'completed');
    assert.equal(graph.jobs.getJob(liveJob.id)?.status, 'queued');
  });
});

test('resource-blocked claims skip every model-backed job but still take the deterministic ones', () => {
  withAssistantContext(({ graph, ownerId }) => {
    for (const [jobType, payload] of [
      ['capture_note', { attachmentId: 'vatt_1' }],
      ['chat_note', { sessionId: 'chat_1' }],
      ['note_tidy', { noteId: 'vnote_1' }],
    ] as const) {
      graph.jobs.enqueue({ ownerId, jobType, payload, idempotencyKey: jobType }, 600);
    }
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner', leaseSeconds: 60, modelWorkAllowed: false }), null);
    graph.jobs.enqueue({ ownerId, jobType: 'daily_rollup', payload: { day: '2026-10-24' }, idempotencyKey: 'daily' }, 1);
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner', leaseSeconds: 60, modelWorkAllowed: false })?.job_type, 'daily_rollup');
  });
});
