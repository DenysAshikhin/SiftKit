import assert from 'node:assert/strict';
import test from 'node:test';

import { DeletionPreviewService } from '../src/assistant/control/deletion-preview.js';
import { MemoryMutationService } from '../src/assistant/control/memory-mutation-service.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService,
  SummarizeProjectionResult,
} from '../src/assistant/projections/projection-summarizer.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

class UnusedSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'below_test_target' };
  }
}

test('memory mutations confirm, correct, pin, and demote with explicit history', () => {
  withAssistantContext(({ graph, database, ownerId }) => {
    const person = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'conversation_message',
      sourceEventId: 'chat:m1', sourceRef: 'chat', capturedAtUtc: graph.nowUtc(),
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'I use PowerShell.',
    });
    const created = graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: person.id, predicate: 'HAS_ROLE',
      object: { kind: 'literal', valueType: 'string', value: 'PowerShell' }, scopeNodeId: null,
      basis: 'assistant_inference', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: graph.nowUtc(), topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'HAS_ROLE', object: 'PowerShell', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 0.7 }],
    });
    assert.equal(created.kind, 'created');
    if (created.kind !== 'created') return;
    const service = new MemoryMutationService({
      graph, projectionPriority: 300,
      deletionPreviews: new DeletionPreviewService(graph, database),
      projections: new ProjectionCompiler(
        graph, new EstimateTokenCounter(4), new UnusedSummarizer(),
        { 1: 10_000, 2: 50_000, 3: 10_000 },
      ),
    });
    service.refreshProjectionPriority(777);

    const confirmed = service.confirm({
      ownerId, assertionId: created.assertionId, reason: 'I confirm this.',
    });
    assert.equal(confirmed.basis, 'explicit_question_answer');
    assert.equal(graph.jobs.claimNext({
      ownerId, leaseOwner: 'test', leaseSeconds: 30, modelWorkAllowed: true,
    })?.priority, 777);
    const pinned = service.setPinned({
      ownerId, assertionId: created.assertionId, pinned: true, reason: 'Keep prominent.',
    });
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.user_demoted, false);
    const demoted = service.demote({
      ownerId, assertionId: created.assertionId, reason: 'Less useful now.',
    });
    assert.equal(demoted.pinned, false);
    assert.equal(demoted.user_demoted, true);

    const corrected = service.correct({
      ownerId,
      assertionId: created.assertionId,
      object: { kind: 'literal', valueType: 'string', value: 'PowerShell 7' },
      objectText: 'PowerShell 7',
      reason: 'Version matters.',
    });
    assert.equal(corrected.kind, 'superseded');
    assert.ok(graph.audit.listMutations(ownerId, 'graph_assertions', created.assertionId).length >= 4);
    assert.ok(graph.jobs.countByStatus(ownerId, 'queued') >= 1);
  });
});

test('signed deletion previews reject tampering and staleness before forgetting', () => {
  withAssistantContext(({ graph, database, ownerId }) => {
    const person = graph.nodes.createNode({
      ownerId, type: 'person', canonicalKey: 'person:owner', displayName: 'the user',
      description: null, sensitivity: 'personal', properties: {},
    });
    const evidence = graph.evidence.recordTextEvidence({
      ownerId, deviceId: null, parentEvidenceId: null, sourceType: 'conversation_message',
      sourceEventId: 'chat:m2', sourceRef: 'chat', capturedAtUtc: graph.nowUtc(),
      sourceTimezone: null, sensitivity: 'personal', retentionUntilUtc: null,
      metadata: {}, text: 'I prefer PowerShell.',
    });
    const created = graph.assertionService.assert({
      ownerId, actorType: 'user', actorRef: null, subjectNodeId: person.id, predicate: 'HAS_ROLE',
      object: { kind: 'literal', valueType: 'string', value: 'PowerShell' }, scopeNodeId: null,
      basis: 'explicit_user_statement', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: graph.nowUtc(), topics: [], attributes: {},
      searchText: { subject: 'the user', predicate: 'HAS_ROLE', object: 'PowerShell', scope: '' },
      evidence: [{ evidenceId: evidence.id, stance: 'supports', weight: 1 }],
    });
    assert.equal(created.kind, 'created');
    if (created.kind !== 'created') return;
    graph.projections.upsert({
      ownerId, tier: 1, topicKey: 'profile', title: 'Profile', content: '# Profile',
      contentHash: 'hash', tokenCount: 2, tokenizerId: 'estimate', graphVersion: graph.graphVersion,
      includedAssertionIds: [created.assertionId], sensitivity: 'personal',
    });
    const service = new MemoryMutationService({
      graph, projectionPriority: 300,
      deletionPreviews: new DeletionPreviewService(graph, database),
      projections: new ProjectionCompiler(
        graph, new EstimateTokenCounter(4), new UnusedSummarizer(),
        { 1: 10_000, 2: 50_000, 3: 10_000 },
      ),
    });
    const preview = service.previewForgetAssertion(ownerId, created.assertionId);
    assert.equal(preview.targetAssertionId, created.assertionId);
    assert.equal(preview.affectedProjectionIds.length, 1);
    assert.throws(
      () => service.confirmForgetAssertion(ownerId, created.assertionId, `${preview.previewToken}x`),
      /preview token/i,
    );

    service.setPinned({ ownerId, assertionId: created.assertionId, pinned: true, reason: 'race' });
    assert.throws(
      () => service.confirmForgetAssertion(ownerId, created.assertionId, preview.previewToken),
      /stale/i,
    );
    const fresh = service.previewForgetAssertion(ownerId, created.assertionId);
    service.confirmForgetAssertion(ownerId, created.assertionId, fresh.previewToken);
    assert.equal(graph.assertions.requireAssertion(created.assertionId).status, 'deleted');
  });
});
