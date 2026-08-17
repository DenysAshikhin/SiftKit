import test from 'node:test';
import assert from 'node:assert/strict';

import { withAssistantContext } from './helpers/assistant-fixture.js';

test('enqueue is idempotent while a job with the same key is live', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const first = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    }, 800);
    assert.notEqual(first, null);
    const duplicate = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    }, 800);
    assert.equal(duplicate, null, 'a replayed enqueue must be a no-op');
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 1);
  });
});

test('enqueueSuperseding cancels older queued jobs of the same type but not running ones', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const first = graph.jobs.enqueue({
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' }, idempotencyKey: 'projection_maintenance:1',
    }, 0);
    assert.ok(first);
    const second = graph.jobs.enqueueSuperseding({
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' }, idempotencyKey: 'projection_maintenance:2',
    }, 0);
    assert.ok(second);
    assert.equal(graph.jobs.getJob(first.id)?.status, 'cancelled');
    assert.equal(graph.jobs.getJob(second.id)?.status, 'queued');

    graph.jobs.claimNext({
      ownerId, leaseOwner: 'test', leaseSeconds: 60, modelWorkAllowed: true,
    });
    const third = graph.jobs.enqueueSuperseding({
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' }, idempotencyKey: 'projection_maintenance:3',
    }, 0);
    assert.ok(third);
    assert.equal(graph.jobs.getJob(second.id)?.status, 'running');
    assert.equal(graph.jobs.getJob(third.id)?.status, 'queued');
  });
});

test('claimNext takes the highest priority available job and leases it', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' }, idempotencyKey: 'proj_1',
    }, 900);
    graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    }, 100);
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120, modelWorkAllowed: true });
    assert.equal(claimed?.job_type, 'projection_maintenance');
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.lease_owner, 'runner_a');
    assert.equal(
      claimed?.lease_expires_at_utc,
      new Date(clock.nowEpochMs() + 120_000).toISOString(),
    );

    const second = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120, modelWorkAllowed: true });
    assert.equal(second?.job_type, 'conversation_ingestion');
    assert.equal(graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 120, modelWorkAllowed: true }), null);
  });
});

test('completing a job frees the idempotency key', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const enqueued = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    }, 800);
    assert.notEqual(enqueued, null);
    const claimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true });
    assert.notEqual(claimed, null);
    graph.jobs.complete(claimed?.id ?? '');
    assert.equal(graph.jobs.countByStatus(ownerId, 'completed'), 1);
    assert.notEqual(graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    }, 800), null);
  });
});

test('failure re-queues with backoff until max attempts, then dead-letters', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue({
      ownerId, jobType: 'candidate_consolidation',
      payload: { candidateIds: ['cand_1'] }, idempotencyKey: 'cons_1',
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
      ownerId, jobType: 'projection_maintenance',
      payload: { reason: 'graph_changed' }, idempotencyKey: 'proj_1',
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
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
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
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_1', sessionId: 'chat_1' }, idempotencyKey: 'ev_1',
    }, 800);
    graph.jobs.claimNext({ ownerId, leaseOwner: 'dead_runner', leaseSeconds: 60, modelWorkAllowed: true });
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 0, 'lease is still valid');
    clock.advanceSeconds(61);
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 1);
    const reclaimed = graph.jobs.claimNext({ ownerId, leaseOwner: 'runner_a', leaseSeconds: 60, modelWorkAllowed: true });
    assert.equal(reclaimed?.attempts, 2, 'the crashed attempt still counts');
  });
});

test('payload round-trips through its schema', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const job = graph.jobs.enqueue({
      ownerId, jobType: 'conversation_ingestion',
      payload: { evidenceId: 'ev_9', sessionId: 'chat_2' }, idempotencyKey: 'ev_9',
    }, 800);
    assert.deepEqual(
      graph.jobs.readConversationPayload(graph.jobs.requireJob(job?.id ?? '')),
      { evidenceId: 'ev_9', sessionId: 'chat_2' },
    );
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

test('Gate C job payloads are parsed strictly', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const planning = graph.jobs.enqueue({
      ownerId, jobType: 'question_planning', payload: { reason: 'schedule' },
      idempotencyKey: 'question-planning',
    }, 600);
    const answer = graph.jobs.enqueue({
      ownerId, jobType: 'question_answer_ingestion',
      payload: { questionId: 'question_1', evidenceId: 'evidence_1' },
      idempotencyKey: 'question-answer',
    }, 850);
    const summary = graph.jobs.enqueue({
      ownerId, jobType: 'projection_summarization', payload: { projectionId: 'projection_1' },
      idempotencyKey: 'projection-summary',
    }, 300);
    assert.deepEqual(graph.jobs.readQuestionPlanningPayload(
      graph.jobs.requireJob(planning?.id ?? ''),
    ), { reason: 'schedule' });
    assert.deepEqual(graph.jobs.readQuestionAnswerPayload(
      graph.jobs.requireJob(answer?.id ?? ''),
    ), { questionId: 'question_1', evidenceId: 'evidence_1' });
    assert.deepEqual(graph.jobs.readProjectionSummarizationPayload(
      graph.jobs.requireJob(summary?.id ?? ''),
    ), { projectionId: 'projection_1' });
    const malformed = graph.jobs.enqueue({
      ownerId, jobType: 'question_planning', payload: { reason: 'curiosity' },
      idempotencyKey: 'malformed-question-planning',
    }, 600);
    assert.throws(
      () => graph.jobs.readQuestionPlanningPayload(graph.jobs.requireJob(malformed?.id ?? '')),
    );
  });
});

test('resource-blocked claims skip every Gate C model-backed job', () => {
  withAssistantContext(({ graph, ownerId }) => {
    for (const [jobType, payload] of [
      ['question_planning', { reason: 'schedule' }],
      ['question_answer_ingestion', { questionId: 'q1', evidenceId: 'ev1' }],
      ['projection_summarization', { projectionId: 'p1' }],
    ] as const) {
      graph.jobs.enqueue({ ownerId, jobType, payload, idempotencyKey: jobType }, 600);
    }
    assert.equal(graph.jobs.claimNext({
      ownerId, leaseOwner: 'runner', leaseSeconds: 60, modelWorkAllowed: false,
    }), null);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 3);
  });
});
