import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VAULT_MAINTENANCE_REQUEST, isModelBackedJobType, jobIdempotencyKey, jobPriority, type AssistantJobRequest,
} from '../src/assistant/jobs/job-types.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.ts';
import { withAssistantContext } from './helpers/assistant-fixture.ts';

const PRIORITIES = DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities;
const TURN = {
  sessionId: 'chat_1', sessionTitle: 'Tools', userMessageId: 'msg_1', capturedAtUtc: '2026-10-24T09:00:00.000Z',
  userText: 'I use Neovim.', assistantText: 'Nice.',
};
const capture = (attachmentId: string): AssistantJobRequest => ({ jobType: 'vault_write', payload: { source: 'capture', attachmentId } });
const chat: AssistantJobRequest = { jobType: 'vault_write', payload: { source: 'chat', turn: TURN } };
const review = (noteId = 'vnote_1'): AssistantJobRequest => ({ jobType: 'vault_write', payload: { source: 'review', noteIds: [noteId] } });
const maintenance: AssistantJobRequest = VAULT_MAINTENANCE_REQUEST;
const claim = (leaseOwner = 'runner_a', modelWorkAllowed = true) => ({ leaseOwner, leaseSeconds: 60, modelWorkAllowed });

test('enqueue is idempotent per payload-derived key while a job is live', () => {
  withAssistantContext(({ graph, ownerId }) => {
    const first = graph.jobs.enqueue(ownerId, capture('vatt_1'), PRIORITIES);
    assert.equal(first?.priority, PRIORITIES.CaptureWrite);
    assert.equal(graph.jobs.enqueue(ownerId, capture('vatt_1'), PRIORITIES), null, 'a replayed enqueue must be a no-op');
    assert.notEqual(graph.jobs.enqueue(ownerId, capture('vatt_2'), PRIORITIES), null);
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 2);
  });
});

test('vault_write keys and priorities follow the source; maintenance has one key', () => {
  const priorities = { ChatWrite: 800, CaptureWrite: 400, Review: 100, Maintenance: 900 };
  const requests = [capture('vatt_1'), chat, review(), maintenance];
  const keys = ['vault_write:capture:vatt_1', 'vault_write:chat:chat_1:msg_1', 'vault_write:review', 'vault_maintenance'];
  assert.deepEqual(requests.map(jobIdempotencyKey), keys);
  assert.deepEqual(requests.map((request) => jobPriority(priorities, request)), [400, 800, 100, 900]);
  assert.equal(isModelBackedJobType('vault_write'), true);
  assert.equal(isModelBackedJobType('vault_maintenance'), false);
  withAssistantContext(({ graph, ownerId }) => {
    assert.deepEqual(requests.map((request) => graph.jobs.enqueue(ownerId, request, PRIORITIES)?.idempotency_key), keys);
    assert.equal(graph.jobs.enqueue(ownerId, review('vnote_2'), PRIORITIES), null, 'one live review at a time');
  });
});

test('countQueued counts only queued jobs of the given type', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.jobs.enqueue(ownerId, capture('vatt_1'), PRIORITIES);
    graph.jobs.enqueue(ownerId, chat, PRIORITIES);
    graph.jobs.enqueue(ownerId, maintenance, PRIORITIES);
    assert.equal(graph.jobs.countQueued(ownerId, 'vault_write'), 2);
    assert.equal(graph.jobs.countQueued(ownerId, 'vault_maintenance'), 1);
    assert.equal(graph.jobs.claimNext({ ownerId, ...claim() })?.job_type, 'vault_maintenance', 'maintenance has the top priority');
    assert.equal(graph.jobs.countQueued(ownerId, 'vault_maintenance'), 0, 'a running job is not queued');
  });
});

test('an invalid payload is refused before it is stored', () => {
  withAssistantContext(({ graph, ownerId }) => {
    assert.throws(() => graph.jobs.enqueue(ownerId, { jobType: 'vault_write', payload: { source: 'review', noteIds: [] } }, PRIORITIES));
    assert.throws(() => graph.jobs.enqueue(ownerId, { jobType: 'vault_write', payload: { source: 'chat', turn: { ...TURN, capturedAtUtc: 'not-a-date' } } }, PRIORITIES));
    assert.equal(graph.jobs.countByStatus(ownerId, 'queued'), 0);
  });
});

test('claimNext takes the highest priority available job and leases it', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue(ownerId, maintenance, { ...PRIORITIES, Maintenance: 900 });
    graph.jobs.enqueue(ownerId, capture('vatt_1'), { ...PRIORITIES, CaptureWrite: 100 });
    const claimed = graph.jobs.claimNext({ ownerId, ...claim(), leaseSeconds: 120 });
    assert.equal(claimed?.job_type, 'vault_maintenance');
    assert.equal(claimed?.status, 'running');
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.lease_owner, 'runner_a');
    assert.equal(claimed?.lease_expires_at_utc, new Date(clock.nowEpochMs() + 120_000).toISOString());

    assert.equal(graph.jobs.claimNext({ ownerId, ...claim() })?.job_type, 'vault_write');
    assert.equal(graph.jobs.claimNext({ ownerId, ...claim() }), null);
  });
});

test('completing a job frees the idempotency key', () => {
  withAssistantContext(({ graph, ownerId }) => {
    assert.notEqual(graph.jobs.enqueue(ownerId, capture('vatt_1'), PRIORITIES), null);
    const claimed = graph.jobs.claimNext({ ownerId, ...claim() });
    assert.notEqual(claimed, null);
    graph.jobs.complete(claimed?.id ?? '');
    assert.equal(graph.jobs.countByStatus(ownerId, 'completed'), 1);
    assert.notEqual(graph.jobs.enqueue(ownerId, capture('vatt_1'), PRIORITIES), null);
  });
});

test('failure re-queues with backoff until max attempts, then dead-letters', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue(ownerId, review(), PRIORITIES);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = graph.jobs.claimNext({ ownerId, ...claim() });
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
    assert.equal(graph.jobs.claimNext({ ownerId, ...claim() }), null);
  });
});

test('a backed-off job is not claimable until its available time', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue(ownerId, maintenance, PRIORITIES);
    const claimed = graph.jobs.claimNext({ ownerId, ...claim() });
    graph.jobs.fail(claimed?.id ?? '', 'boom');
    assert.equal(graph.jobs.claimNext({ ownerId, ...claim() }), null);
    clock.advanceSeconds(31);
    assert.notEqual(graph.jobs.claimNext({ ownerId, ...claim() }), null);
  });
});

test('preemption re-queues immediately and does not consume an attempt', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.jobs.enqueue(ownerId, capture('vatt_1'), PRIORITIES);
    const claimed = graph.jobs.claimNext({ ownerId, ...claim() });
    assert.equal(claimed?.attempts, 1);
    const requeued = graph.jobs.requeuePreempted(claimed?.id ?? '');
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.attempts, 0);
    assert.equal(requeued.lease_owner, null);
    assert.notEqual(graph.jobs.claimNext({ ownerId, ...claim('runner_b') }), null);
  });
});

test('expired leases return to the queue on recovery', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    graph.jobs.enqueue(ownerId, capture('vatt_1'), PRIORITIES);
    graph.jobs.claimNext({ ownerId, ...claim('dead_runner') });
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 0, 'lease is still valid');
    clock.advanceSeconds(61);
    assert.equal(graph.jobs.recoverExpiredLeases(ownerId), 1);
    assert.equal(graph.jobs.claimNext({ ownerId, ...claim() })?.attempts, 2, 'the crashed attempt still counts');
  });
});

test('a stored job reads back as the request that enqueued it', () => {
  withAssistantContext(({ graph, ownerId }) => {
    for (const request of [capture('vatt_9'), chat, review(), maintenance]) {
      const job = graph.jobs.requireJob(graph.jobs.enqueue(ownerId, request, PRIORITIES)?.id ?? '');
      assert.deepEqual(graph.jobs.readRequest(job), request);
    }
  });
});

test('a stored payload that no longer matches its type fails loudly when read', () => {
  withAssistantContext(({ graph, ownerId, database }) => {
    const id = graph.jobs.enqueue(ownerId, maintenance, PRIORITIES)?.id ?? '';
    database.prepare('UPDATE assistant_jobs SET payload_json = ? WHERE id = ?').run('{"reason":"schedule"}', id);
    assert.throws(() => graph.jobs.readRequest(graph.jobs.requireJob(id)));
  });
});

test('live capture write attachments are listed from queued and running jobs only', () => {
  withAssistantContext(({ graph, ownerId }) => {
    graph.jobs.enqueue(ownerId, capture('vatt_done'), PRIORITIES);
    graph.jobs.complete(graph.jobs.claimNext({ ownerId, ...claim() })?.id ?? '');
    graph.jobs.enqueue(ownerId, capture('vatt_running'), PRIORITIES);
    graph.jobs.claimNext({ ownerId, ...claim() });
    graph.jobs.enqueue(ownerId, capture('vatt_queued'), PRIORITIES);
    graph.jobs.enqueue(ownerId, chat, PRIORITIES);
    graph.jobs.enqueue(ownerId, review(), PRIORITIES);
    assert.deepEqual(graph.jobs.listLiveCaptureWriteAttachmentIds(ownerId).sort(), ['vatt_queued', 'vatt_running']);
  });
});

test('pruneTerminal deletes old terminal jobs and keeps live and recent ones', () => {
  withAssistantContext(({ graph, ownerId, clock }) => {
    const oldJob = graph.jobs.enqueue(ownerId, maintenance, PRIORITIES);
    assert.ok(oldJob);
    graph.jobs.claimNext({ ownerId, ...claim() });
    graph.jobs.complete(oldJob.id);

    clock.advanceSeconds(1);
    const recentJob = graph.jobs.enqueue(ownerId, maintenance, PRIORITIES);
    assert.ok(recentJob);
    graph.jobs.claimNext({ ownerId, ...claim() });
    graph.jobs.complete(recentJob.id);
    const liveJob = graph.jobs.enqueue(ownerId, maintenance, PRIORITIES);
    assert.ok(liveJob);

    assert.equal(graph.jobs.pruneTerminal(ownerId, clock.nowUtc()), 1);
    assert.equal(graph.jobs.getJob(oldJob.id), null);
    assert.equal(graph.jobs.getJob(recentJob.id)?.status, 'completed');
    assert.equal(graph.jobs.getJob(liveJob.id)?.status, 'queued');
  });
});

test('resource-blocked claims skip every model-backed job but still take maintenance', () => {
  withAssistantContext(({ graph, ownerId }) => {
    for (const request of [capture('vatt_1'), chat, review()]) graph.jobs.enqueue(ownerId, request, PRIORITIES);
    assert.equal(graph.jobs.claimNext({ ownerId, ...claim('runner', false) }), null);
    graph.jobs.enqueue(ownerId, maintenance, PRIORITIES);
    assert.equal(graph.jobs.claimNext({ ownerId, ...claim('runner', false) })?.job_type, 'vault_maintenance');
  });
});
