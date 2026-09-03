import type { AssistantGraphCleanupPreview } from '@siftkit/contracts';
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import type { DeletionPreviewService, GraphCleanupCounts } from './deletion-preview.js';
import { isSensitivityAtLeast } from '../domain/enums.js';
import { RELATION_DEFINITIONS } from '../domain/relation-types.js';
import type { CaptureQueueStore } from '../images/capture-queue-store.js';
import type { ImageExtractor } from '../images/image-extractor.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';

const IdRowSchema = z.object({ id: z.string() });

interface GraphCleanupPlan {
  /** `person` nodes no assertion references, created by proposals the validator later refused. */
  readonly orphanNodeIds: readonly string[];
  readonly resumableCaptureIds: readonly string[];
  readonly discardableCaptureIds: readonly string[];
  readonly reclassifiableEvidenceIds: readonly string[];
  readonly reclassifiableAssertionIds: readonly string[];
}

function countsOf(plan: GraphCleanupPlan): GraphCleanupCounts {
  return {
    orphanNodes: plan.orphanNodeIds.length,
    resumableCaptures: plan.resumableCaptureIds.length,
    discardableCaptures: plan.discardableCaptureIds.length,
    reclassifiableEvidence: plan.reclassifiableEvidenceIds.length,
    reclassifiableAssertions: plan.reclassifiableAssertionIds.length,
  };
}

interface GraphCleanupResult {
  readonly nodesDeleted: number;
  readonly capturesRequeued: number;
  readonly capturesDiscarded: number;
  readonly evidenceReclassified: number;
  readonly assertionsReclassified: number;
}

export interface GraphCleanupOptions {
  /**
   * Rewrites rows the owner already has, so it is opt-in and reported by `preview` first. The
   * other three steps only remove state that was never valid.
   */
  readonly reclassifyScreenshots: boolean;
}

export interface GraphCleanupServiceOptions {
  readonly graph: AssistantGraph;
  readonly database: RuntimeDatabase;
  readonly queue: CaptureQueueStore;
  readonly extractor: ImageExtractor;
  readonly previews: DeletionPreviewService;
  readonly projectionPriority: number;
}

/**
 * One-shot repair for the state the pipeline defects produced before they were fixed. Every step
 * is idempotent: a second run over a repaired graph finds nothing and changes nothing.
 */
export class GraphCleanupService {
  private readonly graph: AssistantGraph;
  private readonly database: RuntimeDatabase;
  private readonly queue: CaptureQueueStore;
  private readonly extractor: ImageExtractor;
  private readonly previews: DeletionPreviewService;
  private readonly projectionPriority: number;

  constructor(options: GraphCleanupServiceOptions) {
    this.graph = options.graph;
    this.database = options.database;
    this.queue = options.queue;
    this.extractor = options.extractor;
    this.previews = options.previews;
    this.projectionPriority = options.projectionPriority;
  }

  preview(ownerId: string): AssistantGraphCleanupPreview {
    const plan = this.plan(ownerId);
    return {
      previewToken: this.previews.previewGraphCleanup(ownerId, countsOf(plan)),
      graphVersion: this.graph.graphVersion,
      orphanNodeIds: [...plan.orphanNodeIds],
      resumableCaptureIds: [...plan.resumableCaptureIds],
      discardableCaptureIds: [...plan.discardableCaptureIds],
      reclassifiableEvidenceCount: plan.reclassifiableEvidenceIds.length,
      reclassifiableAssertionCount: plan.reclassifiableAssertionIds.length,
    };
  }

  private plan(ownerId: string): GraphCleanupPlan {
    const live = this.graph.jobs.listLiveImageExtractionEvidenceIds(ownerId);
    const stranded = this.queue.listStrandedProcessing(ownerId, live);
    const readable = (evidenceId: string): boolean => this.graph.evidence.hasReadableBlob(
      this.graph.evidence.requireEvidence(evidenceId),
    );
    return {
      orphanNodeIds: this.orphanPersonNodeIds(ownerId),
      resumableCaptureIds: stranded.filter((row) => readable(row.evidence_id))
        .map((row) => row.evidence_id),
      discardableCaptureIds: stranded.filter((row) => !readable(row.evidence_id))
        .map((row) => row.evidence_id),
      reclassifiableEvidenceIds: this.reclassifiableEvidenceIds(ownerId),
      reclassifiableAssertionIds: this.reclassifiableAssertionIds(ownerId),
    };
  }

  run(ownerId: string, previewToken: string, options: GraphCleanupOptions): GraphCleanupResult {
    const plan = this.plan(ownerId);
    this.previews.validateGraphCleanup(ownerId, previewToken, countsOf(plan));
    const transaction = this.graph.transactions.begin();
    try {
      for (const nodeId of plan.orphanNodeIds) {
        const before = this.graph.nodes.requireNode(nodeId);
        this.graph.nodes.setNodeStatus(nodeId, 'deleted');
        this.graph.audit.recordMutation({
          ownerId, actorType: 'user', actorRef: ownerId,
          operation: 'update_node', targetType: 'graph_nodes', targetId: nodeId,
          before: { status: before.status }, after: { status: 'deleted' },
          reason: 'cleanup: no assertion references this person node',
        });
      }
      // Discard the unreadable ones first: `recoverStrandedProcessing` would otherwise send them
      // back round the queue only for the extractor to reject them for a blob that cannot return.
      for (const evidenceId of plan.discardableCaptureIds) {
        this.extractor.discardDeletedBlob(ownerId, evidenceId);
      }
      const capturesRequeued = this.queue.recoverStrandedProcessing(
        ownerId, this.graph.jobs.listLiveImageExtractionEvidenceIds(ownerId),
      );

      const reclassify = options.reclassifyScreenshots;
      if (reclassify) {
        for (const evidenceId of plan.reclassifiableEvidenceIds) {
          const before = this.graph.evidence.requireEvidence(evidenceId);
          this.graph.evidence.setSensitivity(evidenceId, 'personal');
          this.graph.audit.recordAuditEvent({
            ownerId, eventType: 'evidence_reclassified', targetType: 'evidence',
            targetId: evidenceId,
            summary: 'Screenshot evidence reclassified to match the intake rule.',
            details: { before: before.sensitivity, after: 'personal' },
          });
        }
        for (const assertionId of plan.reclassifiableAssertionIds) {
          const before = this.graph.assertions.requireAssertion(assertionId);
          this.graph.assertions.setSensitivity(assertionId, 'personal');
          this.graph.audit.recordMutation({
            ownerId, actorType: 'user', actorRef: ownerId,
            operation: 'update_assertion', targetType: 'graph_assertions', targetId: assertionId,
            before: { sensitivity: before.sensitivity }, after: { sensitivity: 'personal' },
            reason: 'cleanup: screenshot-derived fact reclassified with its evidence',
          });
        }
      }
      const result = {
        nodesDeleted: plan.orphanNodeIds.length,
        capturesRequeued,
        capturesDiscarded: plan.discardableCaptureIds.length,
        evidenceReclassified: reclassify ? plan.reclassifiableEvidenceIds.length : 0,
        assertionsReclassified: reclassify ? plan.reclassifiableAssertionIds.length : 0,
      };
      // Deleting a node or admitting a reclassified fact changes what the documents should say.
      if (Object.values(result).some((count) => count > 0)) {
        this.graph.audit.incrementGraphVersion();
        this.graph.enqueueProjectionMaintenance(ownerId, this.projectionPriority);
      }
      transaction.commit();
      return result;
    } catch (error) {
      return transaction.rollbackAfter(error);
    }
  }

  /**
   * Any assertion reference keeps the node, not just a live one: a superseded or retired
   * assertion still has to render, and `AssertionViewBuilder` throws on a node it cannot read.
   * A node the owner named by hand (a `user_supplied` alias) is an answer, not an orphan.
   */
  private orphanPersonNodeIds(ownerId: string): string[] {
    return z.array(IdRowSchema).parse(this.database.prepare(`
      SELECT n.id FROM graph_nodes n
      WHERE n.owner_id = ? AND n.type = 'person' AND n.status = 'active'
        AND (n.canonical_key IS NULL OR n.canonical_key <> ?)
        AND NOT EXISTS (
          SELECT 1 FROM graph_assertions a
          WHERE a.subject_node_id = n.id OR a.object_node_id = n.id OR a.scope_node_id = n.id
        )
        AND NOT EXISTS (SELECT 1 FROM graph_nodes m WHERE m.merged_into_node_id = n.id)
        AND NOT EXISTS (
          SELECT 1 FROM graph_node_aliases al
          WHERE al.node_id = n.id AND al.alias_type = 'user_supplied'
        )
      ORDER BY n.id ASC
    `).all(ownerId, OWNER_PERSON_CANONICAL_KEY)).map((row) => row.id);
  }

  private reclassifiableEvidenceIds(ownerId: string): string[] {
    return z.array(IdRowSchema).parse(this.database.prepare(`
      SELECT id FROM evidence_records
      WHERE owner_id = ? AND source_type = 'screenshot' AND sensitivity = 'sensitive'
      ORDER BY id ASC
    `).all(ownerId)).map((row) => row.id);
  }

  /**
   * Only the assertions that are `sensitive` *because* a screenshot was. A predicate whose own
   * default sits at or above `sensitive` — health, finance — keeps its classification whatever
   * the evidence said.
   */
  private reclassifiableAssertionIds(ownerId: string): string[] {
    const ids = z.array(IdRowSchema).parse(this.database.prepare(`
      SELECT DISTINCT a.id FROM graph_assertions a
      JOIN assertion_evidence ae ON ae.assertion_id = a.id
      JOIN evidence_records e ON e.id = ae.evidence_id
      WHERE a.owner_id = ? AND a.sensitivity = 'sensitive' AND e.source_type = 'screenshot'
      ORDER BY a.id ASC
    `).all(ownerId)).map((row) => row.id);
    return ids.filter((id) => !isSensitivityAtLeast(
      RELATION_DEFINITIONS[this.graph.assertions.requireAssertion(id).predicate]
        .defaultSensitivity,
      'sensitive',
    ));
  }
}
