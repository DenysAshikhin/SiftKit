import type { RelationType } from '../domain/relation-types.js';
import { LIVE_ASSERTION_STATUSES, type AssertionStore } from '../storage/assertion-store.js';
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
    const visitedNodes = new Set<string>([request.rootNodeId]);
    const collectedAssertions = new Set<string>();
    const truncatedBy = new Set<TruncationReason>();

    let frontier: string[] = [request.rootNodeId];

    for (let hop = 0; hop < request.maxHops; hop += 1) {
      if (frontier.length === 0) break;
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        const byPredicate = this.groupByPredicate(request.ownerId, nodeId, allowed);

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

    if (frontier.length > 0 && this.hasRemainingEdges(request.ownerId, frontier, allowed, collectedAssertions)) {
      truncatedBy.add('max_hops');
    }

    return {
      rootNodeId: request.rootNodeId,
      nodeIds: [...visitedNodes],
      assertionIds: [...collectedAssertions],
      truncatedBy: [...truncatedBy],
    };
  }

  /** Returns true when any frontier node has at least one live edge not yet collected. */
  private hasRemainingEdges(
    ownerId: string, frontier: readonly string[], allowed: ReadonlySet<RelationType>,
    collectedAssertions: ReadonlySet<string>,
  ): boolean {
    return frontier.some((nodeId) => this.liveEdges(ownerId, nodeId, allowed).some(
      (row) => !collectedAssertions.has(row.id),
    ));
  }

  /**
   * The traversable edges of `nodeId`: live node-to-node assertions in either direction whose
   * predicate is allowlisted, deduplicated because a self-edge is returned by both lookups. Both
   * the traversal and the truncation detector read this, so they can never disagree about which
   * edges exist.
   */
  private liveEdges(
    ownerId: string, nodeId: string, allowed: ReadonlySet<RelationType>,
  ): AssertionRow[] {
    const byId = new Map<string, AssertionRow>();
    const edges = [
      ...this.assertions.listBySubject(ownerId, nodeId, LIVE_ASSERTION_STATUSES),
      ...this.assertions.listByObjectNode(ownerId, nodeId, LIVE_ASSERTION_STATUSES),
    ];
    for (const edge of edges) {
      if (edge.object_kind === 'node' && allowed.has(edge.predicate)) {
        byId.set(edge.id, edge);
      }
    }
    return [...byId.values()];
  }

  /** Traversable edges grouped by predicate, so the fanout cap applies per node and predicate. */
  private groupByPredicate(
    ownerId: string, nodeId: string, allowed: ReadonlySet<RelationType>,
  ): Map<RelationType, AssertionRow[]> {
    const grouped = new Map<RelationType, AssertionRow[]>();
    for (const edge of this.liveEdges(ownerId, nodeId, allowed)) {
      const bucket = grouped.get(edge.predicate);
      if (bucket === undefined) {
        grouped.set(edge.predicate, [edge]);
      } else {
        bucket.push(edge);
      }
    }
    return grouped;
  }
}