import test from 'node:test';
import assert from 'node:assert/strict';

import { GraphCleanupService } from '../src/assistant/control/graph-cleanup-service.js';
import { DeletionPreviewService } from '../src/assistant/control/deletion-preview.js';
import { CaptureQueueStore } from '../src/assistant/images/capture-queue-store.js';
import { ImageExtractor } from '../src/assistant/images/image-extractor.js';
import { UnavailableImageCapabilityProvider } from '../src/assistant/images/image-capability.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';

const CAPTURED_AT = '2026-08-10T14:03:11.000Z';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function buildCleanup(context: AssistantTestContext): {
  cleanup: GraphCleanupService; queue: CaptureQueueStore;
} {
  const queue = new CaptureQueueStore(context.database, context.clock);
  const extractor = new ImageExtractor({
    graph: context.graph, queue,
    runner: new StructuredOutputRunner(new FakeAssistantInference([])),
    capability: new UnavailableImageCapabilityProvider(),
  });
  return {
    cleanup: new GraphCleanupService({
      graph: context.graph, database: context.database, queue, extractor,
      previews: new DeletionPreviewService(context.graph, context.database),
      projectionPriority: 400,
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
    assert.equal(cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    ).nodesDeleted, 1);
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
    assert.equal(cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    ).nodesDeleted, 0);
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

    cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    );

    assert.equal(context.graph.nodes.requireNode(owner.id).status, 'active');
  });
});

test('a stranded processing capture with an intact blob is reset to queued', () => {
  withAssistantContext((context) => {
    const { cleanup, queue } = buildCleanup(context);
    const evidenceId = screenshotEvidence(context, 'cap_intact');
    strandCapture(context, queue, evidenceId, 'a'.repeat(64));

    assert.deepEqual(cleanup.preview(context.ownerId).resumableCaptureIds, [evidenceId]);
    const result = cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    );

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
    const result = cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    );

    assert.equal(result.capturesDiscarded, 1);
    assert.equal(result.capturesRequeued, 0);
    assert.equal(queue.require(evidenceId).state, 'processed');
    const audited = context.graph.audit.listAuditEvents(context.ownerId, 50)
      .filter((event) => event.event_type === 'extraction_rejected');
    assert.equal(audited.length, 1);
    assert.equal(audited[0]?.details_json.includes('blob_deleted'), true);
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

    cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: true },
    );
    const second = cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: true },
    );

    assert.deepEqual(second, {
      nodesDeleted: 0, capturesRequeued: 0, capturesDiscarded: 0,
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
    assert.equal(preview.reclassifiableEvidenceCount, 1);
    assert.equal(preview.reclassifiableAssertionCount, 1);

    const withheld = cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    );
    assert.equal(withheld.evidenceReclassified, 0);
    assert.equal(context.graph.evidence.requireEvidence(evidenceId).sensitivity, 'sensitive');

    const applied = cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: true },
    );
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

    cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    );
    assert.equal(
      context.graph.jobs.listByStatus(context.ownerId, 'queued')
        .filter((job) => job.job_type === 'projection_maintenance').length,
      1,
    );

    cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    );
    assert.equal(
      context.graph.jobs.listByStatus(context.ownerId, 'queued')
        .filter((job) => job.job_type === 'projection_maintenance').length,
      1,
      'a no-op cleanup queues nothing further',
    );
  });
});

test('a person node the owner named by hand is kept even without facts', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const named = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'denyz',
      description: null, sensitivity: 'personal', properties: {},
    });
    context.graph.nodes.addAlias({
      ownerId: context.ownerId, nodeId: named.id, alias: 'denyz',
      aliasType: 'user_supplied', sourceEvidenceId: null,
    });

    assert.deepEqual(cleanup.preview(context.ownerId).orphanNodeIds, []);
    cleanup.run(
      context.ownerId, cleanup.preview(context.ownerId).previewToken,
      { reclassifyScreenshots: false },
    );

    assert.equal(context.graph.nodes.requireNode(named.id).status, 'active');
  });
});

test('the cleanup records every change it makes', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const { graph, ownerId } = context;
    const orphan = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: null, displayName: 'Windows',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidenceId = screenshotEvidence(context, 'cap_audit');
    const owner = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: OWNER_PERSON_CANONICAL_KEY, displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const software = graph.nodes.createNode({
      ownerId, type: 'software', canonicalKey: null, displayName: 'PowerShell',
      description: null, sensitivity: 'personal', properties: {},
    });
    const assertion = graph.assertions.createAssertion({
      ownerId, subjectNodeId: owner.id, predicate: 'USES',
      object: { kind: 'node', nodeId: software.id }, scopeNodeId: null, status: 'active',
      basis: 'passive_observation', confidence: 0.7, sensitivity: 'sensitive',
      validFromUtc: null, validToUtc: null, observedAtUtc: CAPTURED_AT,
      supersedesAssertionId: null, pinned: false, attributes: {},
      searchText: { subject: 'the user', predicate: 'USES', object: 'PowerShell', scope: '' },
    });
    graph.assertions.linkEvidence(assertion.id, evidenceId, 'supports', 0.7);
    const versionBefore = graph.graphVersion;

    cleanup.run(ownerId, cleanup.preview(ownerId).previewToken, { reclassifyScreenshots: true });

    const nodeLog = graph.audit.listMutations(ownerId, 'graph_nodes', orphan.id)
      .find((row) => row.operation === 'update_node');
    assert.equal(nodeLog?.after_json?.includes('"deleted"'), true);
    const assertionLog = graph.audit.listMutations(ownerId, 'graph_assertions', assertion.id)
      .find((row) => row.operation === 'update_assertion');
    assert.equal(assertionLog?.before_json?.includes('"sensitive"'), true);
    assert.equal(assertionLog?.after_json?.includes('"personal"'), true);
    const evidenceEvents = graph.audit.listAuditEvents(ownerId, 50)
      .filter((event) => event.event_type === 'evidence_reclassified');
    assert.equal(evidenceEvents.length, 1);
    assert.ok(graph.graphVersion > versionBefore);
  });
});

test('a cleanup with a stale preview token is refused', () => {
  withAssistantContext((context) => {
    const { cleanup } = buildCleanup(context);
    const token = cleanup.preview(context.ownerId).previewToken;
    context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: null, displayName: 'Discord',
      description: null, sensitivity: 'personal', properties: {},
    });

    assert.throws(
      () => cleanup.run(context.ownerId, token, { reclassifyScreenshots: false }),
      /stale/u,
    );
  });
});
