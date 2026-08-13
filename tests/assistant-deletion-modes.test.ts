import assert from 'node:assert/strict';
import test from 'node:test';

import { DeletionPreviewService } from '../src/assistant/control/deletion-preview.js';
import { MemoryMutationService } from '../src/assistant/control/memory-mutation-service.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { AssistantConflictError, AssistantNotFoundError } from '../src/assistant/errors.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService,
  SummarizeProjectionResult,
} from '../src/assistant/projections/projection-summarizer.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';

class PassthroughSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'passthrough' };
  }
}

function mutationServiceFor(context: AssistantTestContext): MemoryMutationService {
  return new MemoryMutationService({
    graph: context.graph,
    database: context.database,
    projectionPriority: 5,
    projections: new ProjectionCompiler(
      context.graph, new EstimateTokenCounter(4), new PassthroughSummarizer(),
      { 1: 10_000, 2: 50_000, 3: 10_000 },
    ),
  });
}

test('an evidence preview token does not validate a different evidence id', () => {
  withAssistantContext((context) => {
    const first = seedOwnerAssertion(context, { objectName: 'Alpha' });
    const second = seedOwnerAssertion(context, { objectName: 'Beta' });
    const previews = new DeletionPreviewService(context.graph, context.database);

    const preview = previews.previewDeleteEvidence(context.ownerId, first.evidenceId);
    assert.deepEqual(preview.dependentAssertionIds, [first.assertion.id]);
    assert.throws(
      () => previews.validateDeleteEvidence(
        context.ownerId, second.evidenceId, preview.previewToken,
      ),
      AssistantConflictError,
    );
    previews.validateDeleteEvidence(context.ownerId, first.evidenceId, preview.previewToken);
  });
});

test('previewing unknown or already-deleted evidence is a not-found, not a token', () => {
  withAssistantContext((context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Alpha' });
    const previews = new DeletionPreviewService(context.graph, context.database);

    assert.throws(
      () => previews.previewDeleteEvidence(context.ownerId, 'evid_missing'),
      AssistantNotFoundError,
    );
    context.graph.evidence.deleteEvidence(seeded.evidenceId);
    assert.throws(
      () => previews.previewDeleteEvidence(context.ownerId, seeded.evidenceId),
      AssistantNotFoundError,
    );
  });
});

test('an evidence preview goes stale when the graph version moves', () => {
  withAssistantContext((context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Alpha' });
    const previews = new DeletionPreviewService(context.graph, context.database);
    const preview = previews.previewDeleteEvidence(context.ownerId, seeded.evidenceId);

    seedOwnerAssertion(context, { objectName: 'Beta' }); // bumps the graph version

    assert.throws(
      () => previews.validateDeleteEvidence(
        context.ownerId, seeded.evidenceId, preview.previewToken,
      ),
      AssistantConflictError,
    );
  });
});

test('a topic preview names exactly that topic and goes stale when the graph moves', () => {
  withAssistantContext((context) => {
    const gamma = seedOwnerAssertion(context, { objectName: 'Gamma Tool' });
    seedOwnerAssertion(context, { objectName: 'Delta Tool' });
    const previews = new DeletionPreviewService(context.graph, context.database);

    const preview = previews.previewForgetTopic(context.ownerId, 'gamma-tool');
    assert.equal(preview.topicKey, 'gamma-tool');
    assert.deepEqual(preview.assertionIds, [gamma.assertion.id]);
    previews.validateForgetTopic(context.ownerId, 'gamma-tool', preview.previewToken);

    // The same token must not authorize a different topic.
    assert.throws(
      () => previews.validateForgetTopic(context.ownerId, 'delta-tool', preview.previewToken),
      AssistantConflictError,
    );

    seedOwnerAssertion(context, { objectName: 'Epsilon Tool' }); // bumps the graph version
    assert.throws(
      () => previews.validateForgetTopic(context.ownerId, 'gamma-tool', preview.previewToken),
      AssistantConflictError,
    );
  });
});

test('an unknown topic previews as empty rather than failing', () => {
  withAssistantContext((context) => {
    const previews = new DeletionPreviewService(context.graph, context.database);
    const preview = previews.previewForgetTopic(context.ownerId, 'nothing-here');
    assert.deepEqual(preview.assertionIds, []);
    assert.deepEqual(preview.affectedProjectionIds, []);
    previews.validateForgetTopic(context.ownerId, 'nothing-here', preview.previewToken);
  });
});

test('deleting source evidence purges the blob, unlinks, and zeroes dependent confidence', () => {
  withAssistantContext((context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Epsilon' });
    const evidence = context.graph.evidence.requireEvidence(seeded.evidenceId);
    const blobId = evidence.blob_id;
    assert.ok(blobId !== null);
    context.graph.evidence.readBlobBytes(blobId); // readable before the deletion

    const mutations = mutationServiceFor(context);
    const preview = mutations.previewDeleteEvidence(context.ownerId, evidence.id);
    mutations.confirmDeleteEvidence(context.ownerId, evidence.id, preview.previewToken);

    assert.equal(context.graph.evidence.requireEvidence(evidence.id).status, 'deleted');
    assert.throws(() => context.graph.evidence.readBlobBytes(blobId));
    assert.deepEqual(context.graph.assertions.listAssertionIdsForEvidence(evidence.id), []);
    const after = context.graph.assertions.requireAssertion(seeded.assertion.id);
    assert.ok(
      after.confidence < seeded.assertion.confidence,
      `confidence stayed at ${after.confidence}`,
    );
    assert.ok(
      context.graph.audit.listAuditEvents(context.ownerId, 50)
        .some((event) => event.event_type === 'evidence_deleted'),
    );
  });
});

test('a stale evidence-deletion token is rejected without partial work', () => {
  withAssistantContext((context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Zeta' });
    const mutations = mutationServiceFor(context);
    const preview = mutations.previewDeleteEvidence(context.ownerId, seeded.evidenceId);

    seedOwnerAssertion(context, { objectName: 'Eta' }); // the graph version moves

    assert.throws(
      () => mutations.confirmDeleteEvidence(
        context.ownerId, seeded.evidenceId, preview.previewToken,
      ),
      AssistantConflictError,
    );
    const evidence = context.graph.evidence.requireEvidence(seeded.evidenceId);
    assert.equal(evidence.status, 'active');
    assert.deepEqual(
      context.graph.assertions.listAssertionIdsForEvidence(seeded.evidenceId),
      [seeded.assertion.id],
    );
    assert.equal(
      context.graph.assertions.requireAssertion(seeded.assertion.id).confidence,
      seeded.assertion.confidence,
    );
  });
});

test('a blob shared by another live record survives the deletion of one of them', () => {
  withAssistantContext((context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Theta' });
    const evidence = context.graph.evidence.requireEvidence(seeded.evidenceId);
    const blobId = evidence.blob_id;
    assert.ok(blobId !== null);
    // A second record over the same bytes: content-addressed storage shares the blob.
    const sibling = context.graph.evidence.recordTextEvidence({
      ownerId: context.ownerId, deviceId: null, parentEvidenceId: null,
      sourceType: 'conversation_message', sourceEventId: 'sibling:theta', sourceRef: null,
      capturedAtUtc: context.graph.nowUtc(), sourceTimezone: null, sensitivity: 'personal',
      retentionUntilUtc: null, metadata: {}, text: 'the user USES Theta',
    });
    assert.equal(sibling.blob_id, blobId);

    const mutations = mutationServiceFor(context);
    const preview = mutations.previewDeleteEvidence(context.ownerId, evidence.id);
    mutations.confirmDeleteEvidence(context.ownerId, evidence.id, preview.previewToken);

    assert.equal(context.graph.evidence.requireEvidence(evidence.id).status, 'deleted');
    assert.ok(context.graph.evidence.readBlobBytes(blobId).length > 0);
  });
});

test('a forget-assertion token cannot be replayed as an evidence or topic token', () => {
  withAssistantContext((context) => {
    const seeded = seedOwnerAssertion(context, { objectName: 'Alpha' });
    const previews = new DeletionPreviewService(context.graph, context.database);
    const assertionToken = previews
      .previewForgetAssertion(context.ownerId, seeded.assertion.id).previewToken;

    assert.throws(
      () => previews.validateDeleteEvidence(
        context.ownerId, seeded.evidenceId, assertionToken,
      ),
      AssistantConflictError,
    );
    assert.throws(
      () => previews.validateForgetTopic(context.ownerId, seeded.topicKey, assertionToken),
      AssistantConflictError,
    );
  });
});
