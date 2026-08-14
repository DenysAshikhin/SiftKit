import type { AssistantGraph } from '../assistant-graph.js';
import { normalizeAliasText } from '../domain/keys.js';
import { renderAssertionLiteral } from '../storage/assertion-search-text.js';
import type { AssertionRow, NodeRow } from '../storage/rows.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';
import type { AssertionView } from './assertion-view.js';

/** Slug used as a projection `topic_key`: stable, lowercase, filesystem-safe. */
export function toTopicKey(displayName: string): string {
  const slug = normalizeAliasText(displayName).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug.length === 0 ? 'general' : slug;
}

/**
 * Resolves assertion rows into readable views. The one place node ids become display text, so
 * projections and retrieval cannot disagree about how a fact reads.
 */
export class AssertionViewBuilder {
  constructor(private readonly graph: AssistantGraph) {}

  build(row: AssertionRow): AssertionView {
    const [view] = this.buildMany([row]);
    if (view === undefined) {
      throw new Error(`Assertion ${row.id} produced no view.`);
    }
    return view;
  }

  /** Resolves every referenced node in one batch, then builds each view from the map. */
  buildMany(rows: readonly AssertionRow[]): AssertionView[] {
    const nodeIds = new Set<string>();
    for (const row of rows) {
      nodeIds.add(row.subject_node_id);
      if (row.object_node_id !== null) nodeIds.add(row.object_node_id);
      if (row.scope_node_id !== null) nodeIds.add(row.scope_node_id);
    }
    const nodes = this.graph.nodes.getNodes([...nodeIds]);
    return rows.map((row) => this.buildWithNodes(row, nodes));
  }

  private buildWithNodes(row: AssertionRow, nodes: ReadonlyMap<string, NodeRow>): AssertionView {
    const subject = this.requireFrom(nodes, row.subject_node_id);
    const objectNode = row.object_node_id === null
      ? null
      : this.requireFrom(nodes, row.object_node_id);
    const scopeNode = row.scope_node_id === null
      ? null
      : this.requireFrom(nodes, row.scope_node_id);

    const objectText = objectNode !== null
      ? objectNode.display_name
      : renderAssertionLiteral(row);

    return {
      assertionId: row.id,
      subjectText: subject.display_name,
      subjectIsOwner: subject.canonical_key === OWNER_PERSON_CANONICAL_KEY,
      predicate: row.predicate,
      objectText,
      scopeText: scopeNode === null ? '' : scopeNode.display_name,
      status: row.status,
      basis: row.basis,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      pinned: row.pinned,
      userDemoted: row.user_demoted,
      lastObservedAtUtc: row.last_observed_at_utc,
      validFromUtc: row.valid_from_utc,
      validToUtc: row.valid_to_utc,
      topicKey: toTopicKey(
        objectNode?.display_name ?? scopeNode?.display_name ?? 'general',
      ),
    };
  }

  private requireFrom(nodes: ReadonlyMap<string, NodeRow>, nodeId: string): NodeRow {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      throw new Error(`Unknown graph node: ${nodeId}`);
    }
    return node;
  }
}
