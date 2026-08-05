import type { Sensitivity } from '../domain/enums.js';
import { normalizeAliasText } from '../domain/keys.js';
import type { NodeType } from '../domain/node-types.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { NodeStore } from '../storage/node-store.js';
import type { NodeRow } from '../storage/rows.js';

export type ResolutionStep =
  | 'canonical_key' | 'user_alias' | 'normalized_alias' | 'model_suggested' | 'context_match';

/** §9.1 step 5: a model match is only trusted above this deterministic score. */
export const MODEL_MATCH_SCORE_THRESHOLD = 0.85;

export interface ModelSuggestedMatch {
  readonly nodeId: string;
  readonly score: number;
}

export type ResolutionOutcome =
  | { readonly kind: 'resolved'; readonly nodeId: string; readonly step: ResolutionStep }
  | { readonly kind: 'created'; readonly nodeId: string }
  | { readonly kind: 'needs_confirmation'; readonly candidateNodeIds: readonly string[] };

export interface ResolveRequest {
  readonly ownerId: string;
  readonly nodeType: NodeType;
  readonly displayName: string;
  readonly canonicalKey: string | null;
  /** Nodes already established in the surrounding statement, used for step 4 disambiguation. */
  readonly contextNodeIds: readonly string[];
  readonly createIfMissing: boolean;
  /** Optional proposal from `candidate_consolidator`. Deterministic steps always win. */
  readonly modelSuggestion?: ModelSuggestedMatch;
}

/** How many merge hops to follow before treating the chain as corrupt. */
const MAX_MERGE_HOPS = 16;

/**
 * Resolution never knows how sensitive a newly seen entity is, so a created node starts here and
 * is reclassified by an explicit `updateNode`. Never below `personal`: an unclassified entity is
 * treated as private until something says otherwise.
 */
const RESOLVED_NODE_SENSITIVITY: Sensitivity = 'personal';

/**
 * Deterministic entity resolution, §9.1. Name similarity alone never merges entities: the
 * resolver either matches an exact normalized alias, creates a node, or asks for confirmation.
 */
export class EntityResolver {
  constructor(
    private readonly nodes: NodeStore,
    private readonly audit: AuditStore,
  ) {}

  resolve(request: ResolveRequest): ResolutionOutcome {
    if (request.canonicalKey !== null) {
      const byKey = this.nodes.findByCanonicalKey(
        request.ownerId, request.nodeType, request.canonicalKey,
      );
      if (byKey !== null) {
        return { kind: 'resolved', nodeId: this.followMerges(byKey).id, step: 'canonical_key' };
      }
    }

    const matches = this.nodes.findByAlias(request.ownerId, request.displayName, request.nodeType);

    const userSupplied = matches.filter((node) => this.hasUserAlias(node.id, request.displayName));
    if (userSupplied.length === 1) {
      return { kind: 'resolved', nodeId: this.followMerges(userSupplied[0]).id, step: 'user_alias' };
    }

    if (matches.length === 1) {
      return {
        kind: 'resolved', nodeId: this.followMerges(matches[0]).id, step: 'normalized_alias',
      };
    }

    if (matches.length > 1) {
      const contextual = matches.filter(
        (node) => request.contextNodeIds.includes(node.id),
      );
      if (contextual.length === 1) {
        return {
          kind: 'resolved', nodeId: this.followMerges(contextual[0]).id, step: 'context_match',
        };
      }
      return {
        kind: 'needs_confirmation',
        candidateNodeIds: matches.map((node) => node.id),
      };
    }

    const suggestion = request.modelSuggestion;
    if (suggestion !== undefined && suggestion.score >= MODEL_MATCH_SCORE_THRESHOLD) {
      const node = this.nodes.getNode(suggestion.nodeId);
      if (node !== null && node.status === 'active' && node.type === request.nodeType) {
        this.audit.recordAuditEvent({
          ownerId: request.ownerId,
          eventType: 'entity_resolved_by_model_suggestion',
          targetType: 'graph_node',
          targetId: node.id,
          summary: `Model-suggested match accepted for "${request.displayName}".`,
          details: { score: suggestion.score },
        });
        return { kind: 'resolved', nodeId: node.id, step: 'model_suggested' };
      }
    }

    if (!request.createIfMissing) {
      return { kind: 'needs_confirmation', candidateNodeIds: [] };
    }
    return { kind: 'created', nodeId: this.createNode(request) };
  }

  private createNode(request: ResolveRequest): string {
    const created = this.nodes.createNode({
      ownerId: request.ownerId,
      type: request.nodeType,
      canonicalKey: request.canonicalKey,
      displayName: request.displayName,
      description: null,
      sensitivity: RESOLVED_NODE_SENSITIVITY,
      properties: {},
    });
    this.nodes.addAlias({
      ownerId: request.ownerId,
      nodeId: created.id,
      alias: request.displayName,
      aliasType: 'name',
      sourceEvidenceId: null,
    });
    this.audit.recordMutation({
      ownerId: request.ownerId, actorType: 'system', actorRef: null,
      operation: 'create_node', targetType: 'graph_nodes', targetId: created.id,
      before: null,
      after: { type: created.type, displayName: created.display_name },
      reason: 'entity resolution created a new node for an unmatched name',
    });
    this.audit.incrementGraphVersion();
    return created.id;
  }

  private hasUserAlias(nodeId: string, displayName: string): boolean {
    const normalized = normalizeAliasText(displayName);
    return this.nodes.listAliases(nodeId).some(
      (alias) => alias.normalized_alias === normalized && alias.alias_type === 'user_supplied',
    );
  }

  /** A merged node is never returned; callers always get the surviving target. */
  private followMerges(node: NodeRow): NodeRow {
    let current = node;
    for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
      if (current.status !== 'merged' || current.merged_into_node_id === null) {
        return current;
      }
      current = this.nodes.requireNode(current.merged_into_node_id);
    }
    throw new Error(`Merge chain for node ${node.id} exceeds ${MAX_MERGE_HOPS} hops.`);
  }
}