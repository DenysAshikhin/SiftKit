import assert from 'node:assert/strict';
import test from 'node:test';

import { DeletionPreviewService } from '../src/assistant/control/deletion-preview.js';
import { AssistantConflictError, AssistantNotFoundError } from '../src/assistant/errors.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';

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
