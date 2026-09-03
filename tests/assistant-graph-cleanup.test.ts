import test from 'node:test';
import assert from 'node:assert/strict';

import { GraphCleanupService } from '../src/assistant/control/graph-cleanup-service.js';
import { CaptureQueueStore } from '../src/assistant/images/capture-queue-store.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

const CAPTURED_AT = '2026-08-10T14:03:11.000Z';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const BLOB_DELETED_ERROR = 'Evidence blob blob_1 has been deleted.';

function buildCleanup(context: AssistantTestContext): {
  cleanup: GraphCleanupService; queue: CaptureQueueStore;
} {
  const queue = new CaptureQueueStore(context.database, context.clock);
  return {
    cleanup: new GraphCleanupService({
      graph: context.graph, database: context.database, queue, projectionPriority: 400,
    }),
    queue,
  };
}

function screenshotEvidence(context: AssistantTestContext, sourceEventId: string): string {
  return context.graph.evidence.recordBlobEvidence({
    ownerId: context.ownerId, deviceId: null, sourceEventId, parentEvidenceId: null,
    sourceType: 'screenshot', sourceRef: 'app:code', capturedAtUtc: CAPTURED_AT,
    sourceTimezone: null, sensitivity: 'sensitive', retentionUntilUtc: null, metadata: {},
    mimeType: 'image/png', bytes: PNG_BYTES,
  }).id;
}

/** Burns a job's whole attempt budget, the only way a row reaches `dead_letter`. */
function deadLetter(context: AssistantTestContext, jobId: string, errorMessage: string): void {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    context.graph.jobs.claimNext({
      ownerId: context.ownerId, leaseOwner: 'test', leaseSeconds: 60, modelWorkAllowed: true,
    });
    context.graph.jobs.fail(jobId, errorMessage);
    context.clock.advanceSeconds(120);
  }
}

function strandCapture(
  context: AssistantTestContext, queue: CaptureQueueStore, evidenceId: string, pixel: string,
): void {
  queue.enqueue({
    ownerId: context.ownerId, evidenceId, state: 'queued', foregroundContextKey: 'app:code',
    pixelSha256: pixel, perceptualHash: 'f0e1d2c3b4a59687', byteLength: PNG_BYTES.byteLength,
  });
  queue.setState(evidenceId, 'processing');
}

test('an orphaned person node is removed', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const orphan = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null,
      displayName: 'League of Legends', description: null, sensitivity: 'personal', properties: {},
    });

    assert.deepEqual(cleanup.preview(context.ownerId).orphanNodeIds, [orphan.id]);
    assert.equal(cleanup.run(context.ownerId, { reclassifyScreenshots: false }).nodesDeleted, 1);
    assert.equal(context.graph.nodes.requireNode(orphan.id).status, 'deleted');
  });
});

test('a person node with a live assertion is kept', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const person = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Alice',
      description: null, sensitivity: 'personal', properties: {},
    });
    const software = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: null, displayName: 'PowerShell',
      description: null, sensitivity: 'personal', properties: {},
    });
    context.graph.assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: person.id, predicate: 'USES',
      object: { kind: 'node', nodeId: software.id }, scopeNodeId: null,
      status: 'active', basis: 'explicit_user_statement', confidence: 0.9,
      sensitivity: 'personal', validFromUtc: null, validToUtc: null,
      observedAtUtc: CAPTURED_AT, supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'Alice', predicate: 'USES', object: 'PowerShell', scope: '' },
    });

    assert.deepEqual(cleanup.preview(context.ownerId).orphanNodeIds, []);
    assert.equal(cleanup.run(context.ownerId, { reclassifyScreenshots: false }).nodesDeleted, 0);
    assert.equal(context.graph.nodes.requireNode(person.id).status, 'active');
  });
});

test('the owner person node is never treated as an orphan', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const owner = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
      displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
    });

    cleanup.run(context.ownerId, { reclassifyScreenshots: false });

    assert.equal(context.graph.nodes.requireNode(owner.id).status, 'active');
  });
});

test('a dead-lettered deleted-blob job is cleared', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const evidenceId = screenshotEvidence(context, 'cap_dead');
    const job = context.graph.jobs.enqueue({
      ownerId: context.ownerId, jobType: 'image_extraction', payload: { evidenceId },
      idempotencyKey: `image_extraction:${evidenceId}`,
    }, 350);
    if (job === null) throw new Error('job was deduplicated unexpectedly');
    deadLetter(context, job.id, BLOB_DELETED_ERROR);
    assert.equal(context.graph.jobs.requireJob(job.id).status, 'dead_letter');

    assert.deepEqual(cleanup.preview(context.ownerId).deletedBlobJobIds, [job.id]);
    assert.equal(cleanup.run(context.ownerId, { reclassifyScreenshots: false }).jobsCleared, 1);
    assert.equal(context.graph.jobs.getJob(job.id), null);
  });
});

test('a dead-lettered job that failed for another reason is left alone', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const evidenceId = screenshotEvidence(context, 'cap_other');
    const job = context.graph.jobs.enqueue({
      ownerId: context.ownerId, jobType: 'image_extraction', payload: { evidenceId },
      idempotencyKey: `image_extraction:${evidenceId}`,
    }, 350);
    if (job === null) throw new Error('job was deduplicated unexpectedly');
    deadLetter(context, job.id, 'the inference backend refused the request');
    assert.equal(context.graph.jobs.requireJob(job.id).status, 'dead_letter');

    assert.deepEqual(cleanup.preview(context.ownerId).deletedBlobJobIds, []);
    cleanup.run(context.ownerId, { reclassifyScreenshots: false });

    assert.equal(context.graph.jobs.requireJob(job.id).status, 'dead_letter');
  });
});

test('a stranded processing capture with an intact blob is reset to queued', () => {
  withAssistantContext((context) => {
    const { cleanup, queue } = buildCleanup(context);
    const evidenceId = screenshotEvidence(context, 'cap_intact');
    strandCapture(context, queue, evidenceId, 'a'.repeat(64));

    assert.deepEqual(cleanup.preview(context.ownerId).resumableCaptureIds, [evidenceId]);
    const result = cleanup.run(context.ownerId, { reclassifyScreenshots: false });

    assert.equal(result.capturesRequeued, 1);
    assert.equal(result.capturesDiscarded, 0);
    assert.equal(queue.require(evidenceId).state, 'queued');
  });
});

test('a stranded capture whose blob is gone is discarded, not queued', () => {
  withAssistantContext((context) => {
    const { cleanup, queue } = buildCleanup(context);
    const evidenceId = screenshotEvidence(context, 'cap_gone');
    strandCapture(context, queue, evidenceId, 'b'.repeat(64));
    context.graph.evidence.expireEvidence(evidenceId);

    assert.deepEqual(cleanup.preview(context.ownerId).discardableCaptureIds, [evidenceId]);
    const result = cleanup.run(context.ownerId, { reclassifyScreenshots: false });

    assert.equal(result.capturesDiscarded, 1);
    assert.equal(result.capturesRequeued, 0);
    assert.equal(queue.require(evidenceId).state, 'processed');
  });
});

test('running the cleanup twice changes nothing the second time', () => {
  withAssistantContext((context) => {
    const { cleanup, queue } = buildCleanup(context);
    context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Discord',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidenceId = screenshotEvidence(context, 'cap_twice');
    strandCapture(context, queue, evidenceId, 'c'.repeat(64));

    cleanup.run(context.ownerId, { reclassifyScreenshots: true });
    const second = cleanup.run(context.ownerId, { reclassifyScreenshots: true });

    assert.deepEqual(second, {
      nodesDeleted: 0, jobsCleared: 0, capturesRequeued: 0, capturesDiscarded: 0,
      evidenceReclassified: 0, assertionsReclassified: 0,
    });
  });
});

test('reclassification is previewed but only runs when it is explicitly requested', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const evidenceId = screenshotEvidence(context, 'cap_reclassify');
    const subject = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY,
      displayName: 'the user', description: null, sensitivity: 'personal', properties: {},
    });
    const software = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: null, displayName: 'PowerShell',
      description: null, sensitivity: 'personal', properties: {},
    });
    const assertion = context.graph.assertions.createAssertion({
      ownerId: context.ownerId, subjectNodeId: subject.id, predicate: 'USES',
      object: { kind: 'node', nodeId: software.id }, scopeNodeId: null,
      status: 'active', basis: 'passive_observation', confidence: 0.7,
      sensitivity: 'sensitive', validFromUtc: null, validToUtc: null,
      observedAtUtc: CAPTURED_AT, supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'the user', predicate: 'USES', object: 'PowerShell', scope: '' },
    });
    context.graph.assertions.linkEvidence(assertion.id, evidenceId, 'supports', 0.7);

    const preview = cleanup.preview(context.ownerId);
    assert.deepEqual(preview.reclassifiableEvidenceIds, [evidenceId]);
    assert.deepEqual(preview.reclassifiableAssertionIds, [assertion.id]);

    const withheld = cleanup.run(context.ownerId, { reclassifyScreenshots: false });
    assert.equal(withheld.evidenceReclassified, 0);
    assert.equal(context.graph.evidence.requireEvidence(evidenceId).sensitivity, 'sensitive');

    const applied = cleanup.run(context.ownerId, { reclassifyScreenshots: true });
    assert.equal(applied.evidenceReclassified, 1);
    assert.equal(applied.assertionsReclassified, 1);
    assert.equal(context.graph.evidence.requireEvidence(evidenceId).sensitivity, 'personal');
    assert.equal(context.graph.assertions.requireAssertion(assertion.id).sensitivity, 'personal');
  });
});

test('a cleanup that changed something queues a projection recompile', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Windows',
      description: null, sensitivity: 'personal', properties: {},
    });

    cleanup.run(context.ownerId, { reclassifyScreenshots: false });
    assert.equal(
      context.graph.jobs.listByStatus(context.ownerId, 'queued')
        .filter((job) => job.job_type === 'projection_maintenance').length,
      1,
    );

    cleanup.run(context.ownerId, { reclassifyScreenshots: false });
    assert.equal(
      context.graph.jobs.listByStatus(context.ownerId, 'queued')
        .filter((job) => job.job_type === 'projection_maintenance').length,
      1,
      'a no-op cleanup queues nothing further',
    );
  });
});
