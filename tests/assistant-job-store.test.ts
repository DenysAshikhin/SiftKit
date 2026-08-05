import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext } from './helpers/assistant-fixture.js';

test('enqueue is idempotent while a job with the same key is live', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const first = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    });
    assert.notEqual(first, null);
    const duplicate = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    });
    assert.equal(duplicate, null, 'a replayed enqueue must be a no-op');
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
  });
});

test('claimNext takes the highest priority available job and leases it', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' }, idempotencyKey: 'proj_1',
    });
    graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    });
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120 });
    assert.equal(claimed?.job_type, 'conversation_ingestion');
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.lease_owner, 'runner_a');
    assert.equal(
      claimed?.lease_expires_at_utc,
      new Date(clock.nowEpochMs() + 120_000).toISOString(),
    );

    const second = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120 });
    assert.equal(second?.job_type, 'projection_maintenance');
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120 }), null);
  });
});

test('completing a job frees the idempotency key', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const enqueued = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    });
    assert.notEqual(enqueued, null);
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 });
    assert.notEqual(claimed, null);
    graph.jobs.complete(claimed?.id ?? '');
    assert.equal(graph.jobs.countByStatus(ownerId, 'completed'), 1);
    assert.notEqual(graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    }), null);
  });
});

test('failure re-queues with backoff until max attempts, then dead-letters', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'candidate_consolidation',
      payload: { candidateIds: ['cand_1'] }, idempotencyKey: 'cons_1',
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 });
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
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 }), null);
  });
});

test('a backed-off job is not claimable until its available time', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' }, idempotencyKey: 'proj_1',
    });
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 });
    graph.jobs.fail(claimed?.id ?? '', 'boom');
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 }), null);
    clock.advanceSeconds(31);
    assert.notEqual(
      graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 }),
      null,
    );
  });
});

test('preemption re-queues immediately and does not consume an attempt', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    });
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 });
    assert.equal(claimed?.attempts, 1);
    const requeued = graph.jobs.requeuePreempted(claimed?.id ?? '');
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.attempts, 0);
    assert.equal(requeued.lease_owner, null);
    assert.notEqual(
      graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_b', leaseSeconds: 60 }),
      null,
    );
  });
});

test('expired leases return to the queue on recovery', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    });
    graph.jobs.claimNext({ ownerId, leaseOwner: 'dead_runner', leaseSeconds: 60 });
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 0, 'lease is still valid');
    clock.advanceSeconds(61);
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 1);
    const reclaimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60 });
    assert.equal(reclaimed?.attempts, 2, 'the crashed attempt still counts');
  });
});

test('payload round-trips through its schema', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const job = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_9', sessionId: 'chat_2' }, idempotencyKey: 'ev_9',
    });
    assert.deepEqual(
      graph.jobs.readConversationPayload(graph.jobs.requireJob(job?.id ?? '')),
      { evidenceId: 'ev_9', sessionId: 'chat_2' },
    );
  });
});