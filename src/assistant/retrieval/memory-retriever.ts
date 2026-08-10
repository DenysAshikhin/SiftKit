import type { AssistantGraph } from '../assistant-graph.js';
import { isExplicitBasis } from '../domain/enums.js';
import { rankAssertion } from '../domain/ranking.js';
import { RELATION_DEFINITIONS, type RelationType } from '../domain/relation-types.js';
import { stalenessFactor } from '../domain/staleness.js';
import type { TokenCounter } from '../domain/tokens.js';
import { renderAssertionSentence } from '../projections/assertion-sentence.js';
import { AssertionViewBuilder } from '../projections/assertion-view-builder.js';
import { isProjectableInPlaintext, type AssertionView } from '../projections/assertion-view.js';
import type { AssertionRow } from '../storage/rows.js';
import { QueryIntentExtractor } from './query-intent.js';

export interface RetrieveRequest {
  readonly ownerId: string;
  readonly userMessage: string;
}

export interface RetrieveResult {
  /** Markdown block to inject, or `''` when nothing relevant was found. */
  readonly renderedBlock: string;
  readonly assertionIds: readonly string[];
  readonly projectionIds: readonly string[];
  readonly tokenCount: number;
}

/** Â§11.4 default traversal bounds. */
const MAX_SEED_NODES = 12;
const MAX_HOPS = 2;
const MAX_NODES = 80;
const MAX_ASSERTIONS = 160;
const MAX_FANOUT = 20;

const RENDER_HEADING = '## Relevant personal context';

/**
 * The task-relevant predicate allowlist for expansion. `RELATED_TO` is deliberately absent:
 * Â§11.4 forbids expanding it without an explicit allowlist and it produces unbounded fanout.
 */
const RETRIEVAL_PREDICATES = [
  'OWNS', 'USES', 'PREFERS', 'WORKS_ON', 'HAS_SETTING', 'HAS_CONSTRAINT', 'HAS_GOAL',
  'RUNS_ON', 'DEPENDS_ON', 'PART_OF',
] as const satisfies readonly RelationType[];

export class MemoryRetriever {
  private readonly intents = new QueryIntentExtractor();
  private readonly views: AssertionViewBuilder;

  constructor(
    private readonly graph: AssistantGraph,
    private readonly tokens: TokenCounter,
    private readonly tokenBudget: number,
  ) {
    this.views = new AssertionViewBuilder(graph);
  }

  async retrieve(request: RetrieveRequest): Promise<RetrieveResult> {
    const intent = this.intents.extract(request.userMessage);
    if (intent.terms.length === 0) {
      return { renderedBlock: '', assertionIds: [], projectionIds: [], tokenCount: 0 };
    }
    const query = intent.terms.map((term) => `"${term}"`).join(' OR ');

    const seedNodeIds = this.graph.nodes.searchNodes(request.ownerId, query, MAX_SEED_NODES);
    const assertionIds = new Set(
      this.graph.assertions.searchAssertions(request.ownerId, query, MAX_ASSERTIONS),
    );
    for (const nodeId of seedNodeIds) {
      const neighborhood = this.graph.neighborhoods.read({
        ownerId: request.ownerId,
        rootNodeId: nodeId,
        predicates: RETRIEVAL_PREDICATES,
        maxHops: MAX_HOPS,
        maxNodes: MAX_NODES,
        maxAssertions: MAX_ASSERTIONS,
        maxFanoutPerNodePredicate: MAX_FANOUT,
      });
      for (const assertionId of neighborhood.assertionIds) {
        assertionIds.add(assertionId);
      }
    }

    const ranked = [...assertionIds]
      .map((assertionId) => this.graph.assertions.getAssertion(assertionId))
      .filter((row): row is AssertionRow => (
        row !== null && (row.status === 'active' || row.status === 'disputed')
      ))
      .map((row) => this.views.build(row))
      .filter(isProjectableInPlaintext)
      .map((view) => ({ view, score: this.score(view, intent.terms) }))
      .sort(
        (left, right) => right.score - left.score
          || left.view.assertionId.localeCompare(right.view.assertionId),
      );

    const projectionIds = this.graph.projections.search(request.ownerId, query, 3);
    for (const projectionId of projectionIds) {
      this.graph.projections.recordRetrieval(projectionId);
    }
    if (ranked.length === 0) {
      return { renderedBlock: '', assertionIds: [], projectionIds, tokenCount: 0 };
    }

    const lines: string[] = [RENDER_HEADING, ''];
    const includedAssertionIds: string[] = [];
    let tokenCount = (await this.tokens.count(lines.join('\n'))).tokenCount;

    for (const entry of ranked) {
      const line = renderAssertionSentence(entry.view);
      const nextCount = (await this.tokens.count([...lines, line].join('\n'))).tokenCount;
      if (nextCount > this.tokenBudget) break;
      lines.push(line);
      includedAssertionIds.push(entry.view.assertionId);
      tokenCount = nextCount;
    }

    if (includedAssertionIds.length === 0) {
      return { renderedBlock: '', assertionIds: [], projectionIds, tokenCount: 0 };
    }
    return {
      renderedBlock: lines.join('\n'),
      assertionIds: includedAssertionIds,
      projectionIds,
      tokenCount,
    };
  }

  private score(view: AssertionView, terms: readonly string[]): number {
    const haystack = `${view.objectText} ${view.scopeText}`.toLowerCase();
    const matched = terms.filter((term) => haystack.includes(term)).length;
    const ageDays = Math.max(
      0,
      (Date.parse(this.graph.nowUtc()) - Date.parse(view.lastObservedAtUtc)) / 86_400_000,
    );
    return rankAssertion({
      relationRelevance: RELATION_DEFINITIONS[view.predicate].projectionBehavior === 'core' ? 1 : 0.5,
      entityMatch: terms.length === 0 ? 0 : Math.min(1, matched / terms.length),
      confidence: view.confidence,
      explicitness: isExplicitBasis(view.basis) ? 1 : 0,
      currentValidity: view.validToUtc === null ? 1 : 0,
      userPin: view.pinned ? 1 : 0,
      projectionUtility: 0,
      staleness: 1 - stalenessFactor(
        RELATION_DEFINITIONS[view.predicate].stalenessClass, ageDays,
      ),
      redundancy: 0,
      sensitivityCost: view.sensitivity === 'personal' ? 0.25 : 0,
      contradictionPenalty: view.status === 'disputed' ? 1 : 0,
    });
  }
}
