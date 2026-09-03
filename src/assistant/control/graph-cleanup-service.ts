import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { isSensitivityAtLeast } from '../domain/enums.js';
import { RELATION_DEFINITIONS } from '../domain/relation-types.js';
import type { CaptureQueueStore } from '../images/capture-queue-store.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';

/** The exact message `EvidenceStore.readBlobBytes` throws once retention removed the pixels. */
const BLOB_DELETED_MARKER = 'has been deleted.';

const IdRowSchema = z.object({ id: z.string() });

export interface GraphCleanupPlan {
  /** `person` nodes no assertion references, created by proposals the validator later refused. */
  readonly orphanNodeIds: readonly string[];
  /** `image_extraction` jobs that burned their retry budget on pixels retention had removed. */
  readonly deletedBlobJobIds: readonly string[];
  readonly resumableCaptureIds: readonly string[];
  readonly discardableCaptureIds: readonly string[];
  readonly reclassifiableEvidenceIds: readonly string[];
  readonly reclassifiableAssertionIds: readonly string[];
}

export interface GraphCleanupResult {
  readonly nodesDeleted: number;
  readonly jobsCleared: number;
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
  private readonly projectionPriority: number;

  constructor(options: GraphCleanupServiceOptions) {
    this.graph = options.graph;
    this.database = options.database;
    this.queue = options.queue;
    this.projectionPriority = options.projectionPriority;
  }

  preview(ownerId: string): GraphCleanupPlan {
    const stranded = this.queue.listStrandedProcessing(ownerId);
    const readable = (evidenceId: string): boolean => this.graph.evidence.hasReadableBlob(
      this.graph.evidence.requireEvidence(evidenceId),
    );
    return {
      orphanNodeIds: this.orphanPersonNodeIds(ownerId),
      deletedBlobJobIds: this.deletedBlobJobIds(ownerId),
      resumableCaptureIds: stranded.filter((row) => readable(row.evidence_id))
        .map((row) => row.evidence_id),
      discardableCaptureIds: stranded.filter((row) => !readable(row.evidence_id))
        .map((row) => row.evidence_id),
      reclassifiableEvidenceIds: this.reclassifiableEvidenceIds(ownerId),
      reclassifiableAssertionIds: this.reclassifiableAssertionIds(ownerId),
    };
  }

  run(ownerId: string, options: GraphCleanupOptions): GraphCleanupResult {
    const plan = this.preview(ownerId);
    const transaction = this.graph.transactions.begin();
    try {
      for (const nodeId of plan.orphanNodeIds) {
        this.graph.nodes.setNodeStatus(nodeId, 'deleted');
      }
      // Discard the unreadable ones first: `recoverStrandedProcessing` would otherwise send them
      // back round the queue only for the extractor to reject them for a blob that cannot return.
      for (const evidenceId of plan.discardableCaptureIds) {
        this.graph.audit.recordAuditEvent({
          ownerId,
          eventType: 'extraction_rejected',
          targetType: 'evidence',
          targetId: evidenceId,
          summary: 'Stranded capture discarded: its pixels were already deleted.',
          details: { code: 'blob_deleted' },
        });
        this.queue.markProcessed(evidenceId);
      }
      const capturesRequeued = this.queue.recoverStrandedProcessing(ownerId);
      const jobsCleared = this.graph.jobs.deleteTerminal(plan.deletedBlobJobIds);

      const reclassify = options.reclassifyScreenshots;
      if (reclassify) {
        for (const evidenceId of plan.reclassifiableEvidenceIds) {
          this.graph.evidence.reclassify(evidenceId, 'personal');
        }
        for (const assertionId of plan.reclassifiableAssertionIds) {
          this.graph.assertions.setSensitivity(assertionId, 'personal');
        }
      }
      const result = {
        nodesDeleted: plan.orphanNodeIds.length,
        jobsCleared,
        capturesRequeued,
        capturesDiscarded: plan.discardableCaptureIds.length,
        evidenceReclassified: reclassify ? plan.reclassifiableEvidenceIds.length : 0,
        assertionsReclassified: reclassify ? plan.reclassifiableAssertionIds.length : 0,
      };
      // Deleting a node or admitting a reclassified fact changes what the documents should say,
      // and nothing else will notice: the compiled projections are only rebuilt on request.
      if (Object.values(result).some((count) => count > 0)) {
        this.graph.jobs.enqueueSuperseding({
          ownerId,
          jobType: 'projection_maintenance',
          payload: { reason: 'graph_changed' },
          idempotencyKey: `projection_maintenance:${this.graph.graphVersion}`,
        }, this.projectionPriority);
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
      ORDER BY n.id ASC
    `).all(ownerId, OWNER_PERSON_CANONICAL_KEY)).map((row) => row.id);
  }

  private deletedBlobJobIds(ownerId: string): string[] {
    return this.graph.jobs.listByStatus(ownerId, 'dead_letter')
      .filter((job) => job.job_type === 'image_extraction'
        && job.last_error !== null && job.last_error.includes(BLOB_DELETED_MARKER))
      .map((job) => job.id);
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
