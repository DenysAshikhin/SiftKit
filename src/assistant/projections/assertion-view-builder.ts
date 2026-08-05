import { parseJsonValueText } from '../../lib/json.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { normalizeAliasText, normalizeLiteralValue } from '../domain/keys.js';
import type { AssertionRow } from '../storage/rows.js';
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
    const subject = this.graph.nodes.requireNode(row.subject_node_id);
    const objectNode = row.object_node_id === null
      ? null
      : this.graph.nodes.requireNode(row.object_node_id);
    const scopeNode = row.scope_node_id === null
      ? null
      : this.graph.nodes.requireNode(row.scope_node_id);

    const objectText = objectNode !== null
      ? objectNode.display_name
      : this.renderLiteral(row);

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
      lastObservedAtUtc: row.last_observed_at_utc,
      validFromUtc: row.valid_from_utc,
      validToUtc: row.valid_to_utc,
      topicKey: toTopicKey(
        objectNode?.display_name ?? scopeNode?.display_name ?? 'general',
      ),
    };
  }

  private renderLiteral(row: AssertionRow): string {
    if (row.object_value_type === null || row.object_value_json === null) {
      throw new Error(`Assertion ${row.id} has a literal object with no value.`);
    }
    return normalizeLiteralValue(
      row.object_value_type,
      parseJsonValueText(row.object_value_json),
    );
  }
}