import type {
  AssistantDeletionPreview,
  AssistantEvidenceDeletionPreview,
  AssistantTopicForgetPreview,
} from '@siftkit/contracts';
import type { JsonObject } from '../../lib/json-types.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { AssistantNotFoundError } from '../errors.js';
import type {
  AssertionWriteOutcome,
} from '../graph/assertion-service.js';
import type { AssertionObjectRef } from '../domain/keys.js';
import type { ProjectionCompiler } from '../projections/projection-compiler.js';
import type { AssertionRow } from '../storage/rows.js';
import { topicAssertionIds, type DeletionPreviewService } from './deletion-preview.js';

interface MemoryMutationServiceOptions {
  readonly graph: AssistantGraph;
  readonly projectionPriority: number;
  readonly projections: ProjectionCompiler;
  /** Shared with the factory reset so one signing secret governs every deletion token. */
  readonly deletionPreviews: DeletionPreviewService;
}

interface AssertionMutationRequest {
  readonly ownerId: string;
  readonly assertionId: string;
  readonly reason: string;
}

interface PinMutationRequest extends AssertionMutationRequest {
  readonly pinned: boolean;
}

interface CorrectionMutationRequest extends AssertionMutationRequest {
  readonly object: AssertionObjectRef;
  readonly objectText: string;
}

function mutationSnapshot(assertion: AssertionRow): JsonObject {
  return {
    status: assertion.status,
    basis: assertion.basis,
    confidence: assertion.confidence,
    pinned: assertion.pinned,
    userDemoted: assertion.user_demoted,
  };
}

export class MemoryMutationService {
  private readonly graph: AssistantGraph;
  private projectionPriority: number;
  private readonly projections: ProjectionCompiler;
  private readonly deletionPreviews: DeletionPreviewService;

  constructor(options: MemoryMutationServiceOptions) {
    this.graph = options.graph;
    this.projectionPriority = options.projectionPriority;
    this.projections = options.projections;
    this.deletionPreviews = options.deletionPreviews;
  }

  refreshProjectionPriority(priority: number): void {
    if (!Number.isInteger(priority)) throw new Error('Projection priority must be an integer.');
    this.projectionPriority = priority;
  }

  confirm(request: AssertionMutationRequest): AssertionRow {
    const assertion = this.requireOwnedAssertion(request.ownerId, request.assertionId);
    const evidence = this.graph.evidence.recordTextEvidence({
      ownerId: request.ownerId,
      deviceId: null,
      parentEvidenceId: null,
      sourceType: 'question_answer',
      sourceEventId: `assistant:confirmation:${assertion.id}:${this.graph.graphVersion}`,
      sourceRef: assertion.id,
      capturedAtUtc: this.graph.nowUtc(),
      sourceTimezone: null,
      sensitivity: assertion.sensitivity,
      retentionUntilUtc: null,
      metadata: { assertionId: assertion.id },
      text: request.reason,
    });
    const result = this.graph.assertionService.confirm({
      ...request,
      evidenceId: evidence.id,
    });
    this.enqueueProjectionMaintenance(request.ownerId);
    return result;
  }

  setPinned(request: PinMutationRequest): AssertionRow {
    return this.setUserPriority(
      request,
      request.pinned,
      request.pinned ? false : undefined,
    );
  }

  demote(request: AssertionMutationRequest): AssertionRow {
    return this.setUserPriority(request, false, true);
  }

  correct(request: CorrectionMutationRequest): AssertionWriteOutcome {
    const assertion = this.requireOwnedAssertion(request.ownerId, request.assertionId);
    const evidence = this.graph.evidence.recordTextEvidence({
      ownerId: request.ownerId,
      deviceId: null,
      parentEvidenceId: null,
      sourceType: 'manual_correction',
      sourceEventId: `assistant:correction:${assertion.id}:${this.graph.graphVersion}`,
      sourceRef: assertion.id,
      capturedAtUtc: this.graph.nowUtc(),
      sourceTimezone: null,
      sensitivity: assertion.sensitivity,
      retentionUntilUtc: null,
      metadata: { assertionId: assertion.id },
      text: request.reason,
    });
    const subject = this.graph.nodes.requireNode(assertion.subject_node_id);
    const scope = assertion.scope_node_id === null
      ? null
      : this.graph.nodes.requireNode(assertion.scope_node_id);
    const result = this.graph.assertionService.correct({
      ownerId: request.ownerId,
      assertionId: request.assertionId,
      object: request.object,
      reason: request.reason,
      observedAtUtc: this.graph.nowUtc(),
      evidenceId: evidence.id,
      searchText: {
        subject: subject.display_name,
        predicate: assertion.predicate,
        object: request.objectText,
        scope: scope?.display_name ?? '',
      },
    });
    this.enqueueProjectionMaintenance(request.ownerId);
    return result;
  }

  previewForgetAssertion(ownerId: string, assertionId: string): AssistantDeletionPreview {
    return this.deletionPreviews.previewForgetAssertion(ownerId, assertionId);
  }

  confirmForgetAssertion(
    ownerId: string,
    assertionId: string,
    previewToken: string,
  ): AssertionRow {
    this.deletionPreviews.validateForgetAssertion(ownerId, assertionId, previewToken);
    const transaction = this.graph.transactions.begin();
    try {
      this.deletionPreviews.validateForgetAssertion(ownerId, assertionId, previewToken);
      const result = this.graph.assertionService.forget({
        ownerId,
        assertionId,
        reason: 'User confirmed signed deletion preview.',
      });
      transaction.commit();
      this.enqueueProjectionMaintenance(ownerId);
      return result;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  previewDeleteEvidence(ownerId: string, evidenceId: string): AssistantEvidenceDeletionPreview {
    return this.deletionPreviews.previewDeleteEvidence(ownerId, evidenceId);
  }

  /**
   * §16.1 delete source evidence: the record is tombstoned, its bytes purged, every link
   * dropped, and each assertion that leaned on it re-derives its confidence from what is left.
   */
  confirmDeleteEvidence(ownerId: string, evidenceId: string, previewToken: string): void {
    this.deletionPreviews.validateDeleteEvidence(ownerId, evidenceId, previewToken);
    const transaction = this.graph.transactions.begin();
    try {
      const dependents = this.graph.assertions.unlinkAllForEvidence(evidenceId);
      this.graph.evidence.deleteEvidence(evidenceId);
      for (const assertionId of dependents) {
        this.graph.assertionService.recalculateConfidence({
          ownerId, assertionId, reason: 'source evidence deleted by the user',
        });
      }
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'evidence_deleted',
        targetType: 'evidence',
        targetId: evidenceId,
        summary: 'Source evidence deleted by the user; dependent confidence recalculated.',
        details: { dependentAssertionIds: dependents },
      });
      this.graph.audit.incrementGraphVersion();
      transaction.commit();
      this.enqueueProjectionMaintenance(ownerId);
    } catch (error) {
      transaction.rollbackAfter(error);
    }
  }

  previewForgetTopic(ownerId: string, topicKey: string): AssistantTopicForgetPreview {
    return this.deletionPreviews.previewForgetTopic(ownerId, topicKey);
  }

  /**
   * §16.1 forget a topic: every live assertion routed to it is retired, its projections are
   * dropped, and — when the user asks — a `never_infer_topic` policy keeps it from coming back.
   */
  confirmForgetTopic(
    ownerId: string,
    request: { topicKey: string; addPolicy: boolean; previewToken: string },
  ): void {
    this.deletionPreviews.validateForgetTopic(ownerId, request.topicKey, request.previewToken);
    const transaction = this.graph.transactions.begin();
    try {
      const assertionIds = topicAssertionIds(this.graph, ownerId, request.topicKey);
      for (const assertionId of assertionIds) {
        this.graph.assertionService.forget({
          ownerId, assertionId, reason: `User forgot topic ${request.topicKey}.`,
        });
      }
      for (const row of this.graph.projections.listAllRows(ownerId)) {
        if (row.topic_key === request.topicKey) {
          this.graph.projections.deleteProjection(row.id);
        }
      }
      if (request.addPolicy) {
        this.graph.policies.upsertPolicy({
          ownerId,
          policyType: 'never_infer_topic',
          key: request.topicKey,
          value: { reason: 'forget-topic workflow' },
          enabled: true,
          source: 'user',
        });
      }
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'topic_forgotten',
        targetType: 'topic',
        targetId: request.topicKey,
        summary: `Topic ${request.topicKey} forgotten (${assertionIds.length} assertions retired).`,
        details: { assertionIds, policyAdded: request.addPolicy },
      });
      transaction.commit();
      this.enqueueProjectionMaintenance(ownerId);
    } catch (error) {
      transaction.rollbackAfter(error);
    }
  }

  async rebuildProjections(ownerId: string, abortSignal: AbortSignal): Promise<void> {
    await this.projections.compileAll(ownerId, abortSignal);
  }

  private requireOwnedAssertion(ownerId: string, assertionId: string): AssertionRow {
    const assertion = this.graph.assertions.getAssertion(assertionId);
    if (assertion === null || assertion.owner_id !== ownerId) {
      throw new AssistantNotFoundError(`Unknown assertion for owner: ${assertionId}`);
    }
    return assertion;
  }

  private setUserPriority(
    request: AssertionMutationRequest,
    pinned: boolean,
    userDemoted: boolean | undefined,
  ): AssertionRow {
    const transaction = this.graph.transactions.begin();
    try {
      const before = this.requireOwnedAssertion(request.ownerId, request.assertionId);
      const after = this.graph.assertions.setUserPriority(
        request.assertionId,
        pinned,
        userDemoted ?? before.user_demoted,
      );
      this.graph.audit.recordMutation({
        ownerId: request.ownerId,
        actorType: 'user',
        actorRef: request.ownerId,
        operation: 'update_assertion',
        targetType: 'graph_assertions',
        targetId: request.assertionId,
        before: mutationSnapshot(before),
        after: mutationSnapshot(after),
        reason: request.reason,
      });
      this.graph.audit.incrementGraphVersion();
      transaction.commit();
      this.enqueueProjectionMaintenance(request.ownerId);
      return after;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  private enqueueProjectionMaintenance(ownerId: string): void {
    this.graph.enqueueProjectionMaintenance(ownerId, this.projectionPriority);
  }
}
