import type {
  AssistantAssertionDto,
  AssistantAssertionExplanation,
  AssistantEvidenceDto,
  AssistantNodeDetail,
  AssistantNodeSummary,
  AssistantProjectionDto,
  AssistantMemoryHistoryEntryDto,
} from '@siftkit/contracts';
import { JsonObjectSchema } from '../../lib/json-types.js';
import { parseJsonText } from '../../lib/json.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { RELATION_TYPES } from '../domain/relation-types.js';
import { AssertionViewBuilder } from '../projections/assertion-view-builder.js';
import type { AssertionRow, EvidenceRow, NodeRow, ProjectionRow } from '../storage/rows.js';

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

export type QueryResult<T> =
  | { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'not_found' };

export interface MemorySearchResult {
  readonly nodes: readonly AssistantNodeSummary[];
  readonly assertions: readonly AssistantAssertionDto[];
  readonly projections: readonly AssistantProjectionDto[];
}

export class MemoryQueryService {
  private readonly views: AssertionViewBuilder;

  constructor(private readonly graph: AssistantGraph) {
    this.views = new AssertionViewBuilder(graph);
  }

  search(ownerId: string, query: string, limit: number): MemorySearchResult {
    this.validateLimit(limit);
    const trimmed = query.trim();
    if (!trimmed) return { nodes: [], assertions: [], projections: [] };
    return {
      nodes: this.graph.nodes.searchNodes(ownerId, trimmed, limit)
        .map((id) => this.graph.nodes.getNode(id))
        .filter((row): row is NodeRow => row !== null && row.owner_id === ownerId)
        .map((row) => this.toNodeSummary(row)),
      assertions: this.graph.assertions.searchAssertions(ownerId, trimmed, limit)
        .map((id) => this.graph.assertions.getAssertion(id))
        .filter((row): row is AssertionRow => row !== null && row.owner_id === ownerId)
        .map((row) => this.toAssertion(row)),
      projections: this.graph.projections.search(ownerId, trimmed, limit)
        .map((id) => this.graph.projections.getProjection(id))
        .filter((row): row is ProjectionRow => row !== null && row.owner_id === ownerId)
        .map((row) => this.toProjection(row)),
    };
  }

  getNode(ownerId: string, nodeId: string): QueryResult<AssistantNodeDetail> {
    const row = this.graph.nodes.getNode(nodeId);
    if (row === null || row.owner_id !== ownerId) return { kind: 'not_found' };
    const sensitive = this.isSensitive(row.sensitivity);
    return {
      kind: 'found',
      value: {
        ...this.toNodeSummary(row),
        canonicalKey: row.canonical_key,
        description: sensitive ? null : row.description,
        properties: sensitive ? { redacted: true } : parseJsonText(row.properties_json, JsonObjectSchema),
        aliases: sensitive ? [] : this.graph.nodes.listAliases(row.id).map((alias) => alias.alias),
      },
    };
  }

  listNodes(ownerId: string, page: PageRequest): AssistantNodeSummary[] {
    this.validatePage(page);
    return this.graph.nodes.list(ownerId, page.limit, page.offset)
      .map((row) => this.toNodeSummary(row));
  }

  getNeighborhood(ownerId: string, nodeId: string, maxHops: number) {
    const node = this.graph.nodes.getNode(nodeId);
    if (node === null || node.owner_id !== ownerId) return { kind: 'not_found' } as const;
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 3) {
      throw new Error('Neighborhood maxHops must be between 1 and 3.');
    }
    return {
      kind: 'found' as const,
      value: this.graph.neighborhoods.read({
        ownerId,
        rootNodeId: nodeId,
        predicates: RELATION_TYPES,
        maxHops,
        maxNodes: 80,
        maxAssertions: 160,
        maxFanoutPerNodePredicate: 20,
      }),
    };
  }

  listAssertions(ownerId: string, page: PageRequest): AssistantAssertionDto[] {
    this.validatePage(page);
    return this.graph.assertions.list(ownerId, page.limit, page.offset)
      .map((row) => this.toAssertion(row));
  }

  getAssertion(ownerId: string, assertionId: string): QueryResult<AssistantAssertionDto> {
    const row = this.graph.assertions.getAssertion(assertionId);
    return row === null || row.owner_id !== ownerId
      ? { kind: 'not_found' }
      : { kind: 'found', value: this.toAssertion(row) };
  }

  explainAssertion(ownerId: string, assertionId: string): QueryResult<AssistantAssertionExplanation> {
    const assertion = this.graph.assertions.getAssertion(assertionId);
    if (assertion === null || assertion.owner_id !== ownerId) return { kind: 'not_found' };
    return {
      kind: 'found',
      value: {
        assertion: this.toAssertion(assertion),
        evidenceIds: this.graph.assertions.listEvidence(assertionId).map((row) => row.evidence_id),
        mutationIds: this.graph.audit.listMutations(ownerId, 'graph_assertions', assertionId)
          .map((row) => row.id),
      },
    };
  }

  listEvidence(ownerId: string, page: PageRequest): AssistantEvidenceDto[] {
    this.validatePage(page);
    return this.graph.evidence.list(ownerId, page.limit, page.offset)
      .map((row) => this.toEvidence(row));
  }

  getEvidenceMetadata(ownerId: string, evidenceId: string): QueryResult<AssistantEvidenceDto> {
    const row = this.graph.evidence.getEvidence(evidenceId);
    return row === null || row.owner_id !== ownerId
      ? { kind: 'not_found' }
      : { kind: 'found', value: this.toEvidence(row) };
  }

  listProjections(ownerId: string): AssistantProjectionDto[] {
    return this.graph.projections.listAll(ownerId).map((row) => this.toProjection(row));
  }

  listMemoryHistory(ownerId: string): AssistantMemoryHistoryEntryDto[] {
    return this.graph.audit.listAllMutations(ownerId).map((mutation) => {
      const assertion = mutation.target_type === 'graph_assertions'
        ? this.graph.assertions.getAssertion(mutation.target_id)
        : null;
      const assertionText = assertion === null
        ? mutation.target_id
        : this.views.build(assertion).objectText;
      const action = mutation.operation.startsWith('create')
        ? 'Added'
        : mutation.operation.startsWith('delete') ? 'Deleted' : 'Changed';
      const proofs = assertion === null
        ? []
        : this.graph.assertions.listEvidence(assertion.id).map((link) => {
          const evidence = this.graph.evidence.requireEvidence(link.evidence_id);
          return {
            evidenceId: evidence.id,
            sourceType: evidence.source_type,
            sourceRef: evidence.source_ref,
          };
        });
      return {
        id: mutation.id,
        operation: mutation.operation,
        targetType: mutation.target_type,
        targetId: mutation.target_id,
        summary: `${action} ${assertionText}`,
        reason: mutation.reason,
        proofs,
        createdAtUtc: mutation.created_at_utc,
      };
    });
  }

  private toNodeSummary(row: NodeRow): AssistantNodeSummary {
    return {
      id: row.id,
      type: row.type,
      displayName: this.isSensitive(row.sensitivity) ? '[redacted]' : row.display_name,
      sensitivity: row.sensitivity,
    };
  }

  private toAssertion(row: AssertionRow): AssistantAssertionDto {
    const view = this.views.build(row);
    const sensitive = this.isSensitive(row.sensitivity);
    return {
      id: row.id,
      subjectNodeId: row.subject_node_id,
      predicate: row.predicate,
      objectText: sensitive ? '[redacted]' : view.objectText,
      scopeText: sensitive ? '' : view.scopeText,
      status: row.status,
      basis: row.basis,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      pinned: row.pinned,
      userDemoted: row.user_demoted,
      validFromUtc: row.valid_from_utc,
      validToUtc: row.valid_to_utc,
      lastObservedAtUtc: row.last_observed_at_utc,
    };
  }

  private toEvidence(row: EvidenceRow): AssistantEvidenceDto {
    return {
      id: row.id,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      capturedAtUtc: row.captured_at_utc,
      sensitivity: row.sensitivity,
      status: row.status,
      metadata: this.isSensitive(row.sensitivity)
        ? { redacted: true }
        : parseJsonText(row.metadata_json, JsonObjectSchema),
      contentAvailable: row.blob_id !== null && row.status !== 'deleted',
      contentRevealed: false,
    };
  }

  private toProjection(row: ProjectionRow): AssistantProjectionDto {
    return {
      id: row.id,
      tier: row.tier,
      topicKey: row.topic_key,
      title: row.title,
      tokenCount: row.token_count,
      sensitivity: row.sensitivity,
      graphVersion: row.graph_version,
      content: row.content,
    };
  }

  private validatePage(page: PageRequest): void {
    this.validateLimit(page.limit);
    if (!Number.isInteger(page.offset) || page.offset < 0) {
      throw new Error('Pagination offset must be a non-negative integer.');
    }
  }

  private validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Pagination limit must be an integer between 1 and 100.');
    }
  }

  private isSensitive(sensitivity: string): boolean {
    return sensitivity !== 'low' && sensitivity !== 'personal';
  }
}
