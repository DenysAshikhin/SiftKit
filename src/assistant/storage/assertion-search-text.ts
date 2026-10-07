import { parseJsonValueText } from '../../lib/json.ts';
import { normalizeLiteralValue } from '../domain/keys.ts';
import type { AssertionSearchText } from './assertion-store.ts';
import type { NodeStore } from './node-store.ts';
import type { AssertionRow } from './rows.ts';

/**
 * Renders a literal-object assertion's object text from its stored value. The single derivation
 * shared by views and FTS search text, so the two can never disagree about how a fact reads.
 */
export function renderAssertionLiteral(row: AssertionRow): string {
  if (row.object_value_type === null || row.object_value_json === null) {
    throw new Error(`Assertion ${row.id} has a literal object with no value.`);
  }
  return normalizeLiteralValue(row.object_value_type, parseJsonValueText(row.object_value_json));
}

/** Rebuilds an assertion's FTS search text from canonical graph state (e.g. on reactivation). */
export function searchTextForAssertion(nodes: NodeStore, row: AssertionRow): AssertionSearchText {
  const object = row.object_node_id !== null
    ? nodes.requireNode(row.object_node_id).display_name
    : renderAssertionLiteral(row);
  return {
    subject: nodes.requireNode(row.subject_node_id).display_name,
    predicate: row.predicate,
    object,
    scope: row.scope_node_id === null ? '' : nodes.requireNode(row.scope_node_id).display_name,
  };
}
