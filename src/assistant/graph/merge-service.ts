import { parseJsonText, parseJsonValueText } from '../../lib/json.js';
import { z } from '../../lib/zod.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import { isExplicitBasis } from '../domain/enums.js';
import { buildAssertionKey, type AssertionObjectRef } from '../domain/keys.js';
import type { AssertionStore } from '../storage/assertion-store.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { PolicyStore } from '../storage/policy-store.js';
import type { AssertionRow } from '../storage/rows.js';

export type MergeBlockCode =
  | 'unknown_node'
  | 'node_not_active'
  | 'same_node'
  | 'type_mismatch'
  | 'canonical_key_conflict'
  | 'incompatible_explicit_assertions'
  | 'merge_cycle'
  | 'do_not_merge_policy'
  | 'owner_identity_collapse';

export type MergeOutcome =
  | { readonly kind: 'merged'; readonly mergeId: string; readonly targetNodeId: string }
  | { readonly kind: 'blocked'; readonly code: MergeBlockCode; readonly message: string };

export interface MergeRequest {
  readonly ownerId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly basis: string;
  readonly reason: string;
}

export interface UnmergeRequest {
  readonly ownerId: string;
  readonly mergeId: string;
  readonly reason: string;
}

/** The canonical key of the assistant owner. Never merged with a third party. */
const OWNER_CANONICAL_KEY = 'person:self';

const MergePayloadSchema = z.object({
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  movedAliasIds: z.array(z.string()),
  movedAssertions: z.array(z.object({
    assertionId: z.string(),
    column: z.enum(['subject_node_id', 'object_node_id', 'scope_node_id']),
    previousNodeId: z.string(),
    previousAssertionKey: z.string(),
  })),
  retiredAssertionIds: z.array(z.string()),
});
type MergePayload = z.infer<typeof MergePayloadSchema>;

type NodeReferenceColumn = 'subject_node_id' | 'object_node_id' | 'scope_node_id';

function block(code: MergeBlockCode, message: string): MergeOutcome {
  return { kind: 'blocked', code, message };
}

/**
 * Rebuilds the object reference of a stored assertion. `replacementNodeId` substitutes the object
 * node, for the case where the merge repoints it. The schema's object-kind CHECK guarantees the
 * columns below are populated, so a NULL here is a corrupt row and must fail loudly rather than
 * silently produce a key for a different fact.
 */
function objectRefOf(assertion: AssertionRow, replacementNodeId: string | null): AssertionObjectRef {
  if (assertion.object_kind === 'node') {
    const nodeId = replacementNodeId ?? assertion.object_node_id;
    if (nodeId === null) {
      throw new Error(`Assertion ${assertion.id} has a node object with no object_node_id.`);
    }
    return { kind: 'node', nodeId };
  }
  if (assertion.object_value_type === null || assertion.object_value_json === null) {
    throw new Error(`Assertion ${assertion.id} has a literal object with no value.`);
  }
  return {
    kind: 'literal',
    valueType: assertion.object_value_type,
    value: parseJsonValueText(assertion.object_value_json),
  };
}

/**
 * Merges one node into another, reversibly. The reversal payload is stored in the `merge_node`
 * mutation-log row so `graph_entity_merges` keeps its designed columns.
 */
export class NodeMergeService {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly nodes: NodeStore,
    private readonly assertions: AssertionStore,
    private readonly audit: AuditStore,
    private readonly policies: PolicyStore,
  ) {}

  merge(request: MergeRequest): MergeOutcome {
    return this.database.transaction((): MergeOutcome => {
      const guard = this.checkMergeSafety(request);
      if (guard !== null) return guard;

      const payload: MergePayload = {
        sourceNodeId: request.sourceNodeId,
        targetNodeId: request.targetNodeId,
        movedAliasIds: [],
        movedAssertions: [],
        retiredAssertionIds: [],
      };

      for (const column of ['subject_node_id', 'object_node_id', 'scope_node_id'] as const) {
        for (const assertion of this.listReferencing(request.ownerId, request.sourceNodeId, column)) {
          // Detect collision BEFORE repointing to avoid UNIQUE constraint violation.
          const prospectiveKey = this.prospectiveKeyAfterRepoint(assertion, column, request.targetNodeId);
          const collision = this.assertions.findLiveByKey(assertion.owner_id, prospectiveKey);
          if (collision !== null) {
            const loser = this.weaker(assertion, collision);
            this.assertions.retireAssertion(loser.id, 'superseded');
            payload.retiredAssertionIds.push(loser.id);
            if (loser.id === assertion.id) continue;
          }

          payload.movedAssertions.push({
            assertionId: assertion.id,
            column,
            previousNodeId: request.sourceNodeId,
            previousAssertionKey: assertion.assertion_key,
          });
          this.assertions.repointNodeReference(
            assertion.id, column, request.targetNodeId,
          );
        }
      }

      payload.movedAliasIds.push(
        ...this.nodes.reassignAliases(request.sourceNodeId, request.targetNodeId),
      );
      this.nodes.setNodeStatus(request.sourceNodeId, 'merged', request.targetNodeId);

      const mergeRow = this.nodes.recordMerge({
        ownerId: request.ownerId,
        sourceNodeId: request.sourceNodeId,
        targetNodeId: request.targetNodeId,
        basis: request.basis,
        reversible: true,
      });
      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'merge_node', targetType: 'graph_nodes', targetId: request.sourceNodeId,
        before: payload, after: { mergeId: mergeRow.id, targetNodeId: request.targetNodeId },
        reason: request.reason,
      });
      this.audit.incrementGraphVersion();
      return { kind: 'merged', mergeId: mergeRow.id, targetNodeId: request.targetNodeId };
    })();
  }

  unmerge(request: UnmergeRequest): void {
    this.database.transaction((): void => {
      const mergeRow = this.nodes.requireMerge(request.mergeId);
      if (mergeRow.reversed_at_utc !== null) {
        throw new Error(`Merge ${request.mergeId} has already been reversed.`);
      }
      if (!mergeRow.reversible) {
        throw new Error(`Merge ${request.mergeId} is not reversible.`);
      }

      const entry = this.audit
        .listMutations(request.ownerId, 'graph_nodes', mergeRow.source_node_id)
        .filter((row) => row.operation === 'merge_node')
        .at(-1);
      if (entry === undefined || entry.before_json === null) {
        throw new Error(`Merge ${request.mergeId} has no reversal payload.`);
      }
      const payload = parseJsonText(entry.before_json, MergePayloadSchema);

      for (const retiredId of payload.retiredAssertionIds) {
        this.assertions.setStatus(retiredId, 'active');
      }
      for (const moved of payload.movedAssertions) {
        this.assertions.repointNodeReference(moved.assertionId, moved.column, moved.previousNodeId);
      }
      this.nodes.reassignAliases(payload.targetNodeId, payload.sourceNodeId);
      this.nodes.setNodeStatus(payload.sourceNodeId, 'active', null);
      this.nodes.markMergeReversed(request.mergeId);

      this.audit.recordMutation({
        ownerId: request.ownerId, actorType: 'user', actorRef: request.ownerId,
        operation: 'unmerge_node', targetType: 'graph_nodes', targetId: payload.sourceNodeId,
        before: { mergeId: request.mergeId }, after: payload, reason: request.reason,
      });
      this.audit.incrementGraphVersion();
    })();
  }

  private checkMergeSafety(request: MergeRequest): MergeOutcome | null {
    if (request.sourceNodeId === request.targetNodeId) {
      return block('same_node', 'A node cannot merge into itself.');
    }
    const source = this.nodes.getNode(request.sourceNodeId);
    const target = this.nodes.getNode(request.targetNodeId);
    if (source === null || target === null) {
      return block('unknown_node', 'Both nodes must exist.');
    }
    // Cycle check before node_not_active so that merging into an already-merged node
    // reports the cycle rather than the inactive status.
    if (this.wouldFormCycle(request.sourceNodeId, request.targetNodeId)) {
      return block('merge_cycle', 'This merge would form a cycle.');
    }
    if (source.status !== 'active' || target.status !== 'active') {
      return block('node_not_active', 'Both nodes must be active.');
    }
    if (source.type !== target.type) {
      return block('type_mismatch', `Cannot merge a ${source.type} into a ${target.type}.`);
    }
    if (this.policies.isMergeBlocked(request.ownerId, source.id, target.id)) {
      return block('do_not_merge_policy', 'A do_not_merge_node policy covers this pair.');
    }
    if (
      source.canonical_key === OWNER_CANONICAL_KEY || target.canonical_key === OWNER_CANONICAL_KEY
    ) {
      return block(
        'owner_identity_collapse',
        'The assistant owner is never merged with another person.',
      );
    }
    if (
      source.canonical_key !== null && target.canonical_key !== null
      && source.canonical_key !== target.canonical_key
    ) {
      return block(
        'canonical_key_conflict',
        `Stable identifiers differ: ${source.canonical_key} vs ${target.canonical_key}.`,
      );
    }
    if (this.hasIncompatibleExplicitAssertions(request)) {
      return block(
        'incompatible_explicit_assertions',
        'The two nodes hold conflicting explicit assertions.',
      );
    }
    return null;
  }

  /** Walks the target's merge chain; if it reaches the source, merging would close a loop. */
  private wouldFormCycle(sourceNodeId: string, targetNodeId: string): boolean {
    const seen = new Set<string>([sourceNodeId]);
    let current = this.nodes.getNode(targetNodeId);
    while (current !== null) {
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      if (current.merged_into_node_id === null) {
        return this.nodes
          .listMerges(current.owner_id)
          .some((row) => row.reversed_at_utc === null
            && row.source_node_id === targetNodeId && row.target_node_id === sourceNodeId);
      }
      current = this.nodes.getNode(current.merged_into_node_id);
    }
    return false;
  }

  /**
   * Two nodes are incompatible when both hold an explicit, live assertion for the same predicate
   * and scope but a different object.
   */
  private hasIncompatibleExplicitAssertions(request: MergeRequest): boolean {
    const explicitOf = (nodeId: string) => this.assertions
      .listBySubject(request.ownerId, nodeId, ['active', 'disputed'])
      .filter((row) => isExplicitBasis(row.basis));
    const sourceAssertions = explicitOf(request.sourceNodeId);
    const targetAssertions = explicitOf(request.targetNodeId);

    return sourceAssertions.some((left) => targetAssertions.some((right) =>
      left.predicate === right.predicate
      && left.scope_node_id === right.scope_node_id
      && (left.object_node_id !== right.object_node_id
        || left.object_normalized_text !== right.object_normalized_text)));
  }

  private listReferencing(
    ownerId: string, nodeId: string, column: NodeReferenceColumn,
  ): AssertionRow[] {
    const statuses = ['active', 'disputed', 'superseded', 'expired'] as const;
    if (column === 'subject_node_id') return this.assertions.listBySubject(ownerId, nodeId, statuses);
    if (column === 'object_node_id') return this.assertions.listByObjectNode(ownerId, nodeId, statuses);
    return this.assertions.listByScope(ownerId, nodeId, statuses);
  }

  /** Compute the assertion key that would result from repointing a node reference. */
  private prospectiveKeyAfterRepoint(
    assertion: AssertionRow,
    column: NodeReferenceColumn,
    targetNodeId: string,
  ): string {
    const subjectNodeId = column === 'subject_node_id' ? targetNodeId : assertion.subject_node_id;
    const scopeNodeId = column === 'scope_node_id' ? targetNodeId : assertion.scope_node_id;

    return buildAssertionKey({
      ownerId: assertion.owner_id,
      subjectNodeId,
      predicate: assertion.predicate,
      object: objectRefOf(assertion, column === 'object_node_id' ? targetNodeId : null),
      scopeNodeId,
    });
  }

  /** Explicit outranks passive; then higher confidence; then older row wins; then lower id wins. */
  private weaker(left: AssertionRow, right: AssertionRow): AssertionRow {
    const leftExplicit = isExplicitBasis(left.basis);
    const rightExplicit = isExplicitBasis(right.basis);
    if (leftExplicit !== rightExplicit) return leftExplicit ? right : left;
    if (left.confidence !== right.confidence) {
      return left.confidence < right.confidence ? left : right;
    }
    if (left.created_at_utc !== right.created_at_utc) {
      return left.created_at_utc > right.created_at_utc ? left : right;
    }
    // Same timestamp: higher id = newer = weaker
    return left.id > right.id ? left : right;
  }
}