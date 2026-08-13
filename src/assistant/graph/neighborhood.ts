import type { RelationType } from '../domain/relation-types.js';
import type { AssertionStore } from '../storage/assertion-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { AssertionRow } from '../storage/rows.js';

export type TruncationReason = 'max_hops' | 'max_nodes' | 'max_assertions' | 'max_fanout';

export interface Neighborhood {
  readonly rootNodeId: string;
  readonly nodeIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly truncatedBy: readonly TruncationReason[];
}

export interface NeighborhoodRequest {
  readonly ownerId: string;
  readonly rootNodeId: string;
  /** Explicit allowlist. RELATED_TO is only followed when it appears here. */
  readonly predicates: readonly RelationType[];
  readonly maxHops: number;
  readonly maxNodes: number;
  readonly maxAssertions: number;
  readonly maxFanoutPerNodePredicate: number;
}

/**
 * Breadth-first traversal with hard bounds. Every bound that bites is reported, so a caller can
 * never mistake a truncated neighborhood for a complete one (§11.4).
 */
export class NeighborhoodReader {
  constructor(
    private readonly nodes: NodeStore,
    private readonly assertions: AssertionStore,
  ) {}

  read(request: NeighborhoodRequest): Neighborhood {
    this.nodes.requireNode(request.rootNodeId);
    const allowed = new Set<RelationType>(request.predicates);
    const fetchLimit = request.maxFanoutPerNodePredicate + 1;
    const visitedNodes = new Set<string>([request.rootNodeId]);
    const collectedAssertions = new Set<string>();
    const truncatedBy = new Set<TruncationReason>();

    let frontier: string[] = [request.rootNodeId];

    for (let hop = 0; hop < request.maxHops; hop += 1) {
      if (frontier.length === 0) break;
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const byPredicate = this.groupByPredicate(request.ownerId, nodeId, allowed, fetchLimit);

        for (const edges of byPredicate.values()) {
          const taken = edges.slice(0, request.maxFanoutPerNodePredicate);
          if (taken.length < edges.length) truncatedBy.add('max_fanout');

          for (const edge of taken) {
            if (collectedAssertions.size >= request.maxAssertions) {
              truncatedBy.add('max_assertions');
              break;
            }
            const neighbourId = edge.subject_node_id === nodeId
              ? edge.object_node_id
              : edge.subject_node_id;
            if (neighbourId === null) continue;

            if (!visitedNodes.has(neighbourId)) {
              if (visitedNodes.size >= request.maxNodes) {
                truncatedBy.add('max_nodes');
                continue;
              }
              visitedNodes.add(neighbourId);
              nextFrontier.push(neighbourId);
            }
            collectedAssertions.add(edge.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    if (frontier.length > 0
      && this.hasRemainingEdges(request.ownerId, frontier, allowed, collectedAssertions)) {
      truncatedBy.add('max_hops');
    }

    return {
      rootNodeId: request.rootNodeId,
      nodeIds: [...visitedNodes],
      assertionIds: [...collectedAssertions],
      truncatedBy: [...truncatedBy],
    };
  }

  /**
   * Whether any frontier node still has a live edge the traversal did not collect. Fetching
   * `collected + 1` edge ids per node and direction is exact by pigeonhole: a node with more
   * live edges than the whole traversal collected must yield an uncollected id, and a node
   * that yields only collected ids was fetched completely.
   */
  private hasRemainingEdges(
    ownerId: string, frontier: readonly string[], allowed: ReadonlySet<RelationType>,
    collectedAssertions: ReadonlySet<string>,
  ): boolean {
    const predicates = [...allowed];
    const limit = collectedAssertions.size + 1;
    return frontier.some((nodeId) => (
      [
        ...this.assertions.listLiveNodeEdgeIds(ownerId, nodeId, 'subject', predicates, limit),
        ...this.assertions.listLiveNodeEdgeIds(ownerId, nodeId, 'object', predicates, limit),
      ].some((id) => !collectedAssertions.has(id))
    ));
  }

  /**
   * The most recent traversable edges of `nodeId`, grouped by predicate: subject-side edges
   * first, then object-side, each side already recency-ordered by the store, self-edges
   * deduplicated onto their subject position. Fetching `fetchLimit` (fanout + 1) rows per side
   * bounds supernode expansion at O(fanout) while keeping the `max_fanout` length check exact.
   * Buckets iterate in allowlist order.
   */
  private groupByPredicate(
    ownerId: string, nodeId: string, allowed: ReadonlySet<RelationType>, fetchLimit: number,
  ): Map<RelationType, AssertionRow[]> {
    const grouped = new Map<RelationType, AssertionRow[]>();
    for (const predicate of allowed) {
      const byId = new Map<string, AssertionRow>();
      for (const edge of [
        ...this.assertions.listTopLiveNodeEdges(ownerId, nodeId, 'subject', predicate, fetchLimit),
        ...this.assertions.listTopLiveNodeEdges(ownerId, nodeId, 'object', predicate, fetchLimit),
      ]) {
        if (!byId.has(edge.id)) byId.set(edge.id, edge);
      }
      if (byId.size > 0) grouped.set(predicate, [...byId.values()]);
    }
    return grouped;
  }
}