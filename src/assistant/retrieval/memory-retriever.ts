import type { AssistantConfig } from '../../config/types.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { isExplicitBasis } from '../domain/enums.js';
import { rankAssertion } from '../domain/ranking.js';
import { RELATION_DEFINITIONS, type RelationType } from '../domain/relation-types.js';
import { stalenessFactor } from '../domain/staleness.js';
import type { TokenCounter } from '../domain/tokens.js';
import { hashTextContent } from '../domain/keys.js';
import { renderAssertionSentence } from '../projections/assertion-sentence.js';
import { AssertionViewBuilder } from '../projections/assertion-view-builder.js';
import { isProjectableInPlaintext, type AssertionView } from '../projections/assertion-view.js';
import type { RetrievalUsageStore } from '../storage/retrieval-usage-store.js';
import { QueryIntentExtractor } from './query-intent.js';

export interface RetrieveRequest {
  readonly ownerId: string;
  readonly userMessage: string;
  readonly conversationId: string | null;
  readonly recordUsage: boolean;
}

export interface RetrieveResult {
  /** Markdown block to inject, or `''` when nothing relevant was found. */
  readonly renderedBlock: string;
  readonly assertionIds: readonly string[];
  readonly projectionIds: readonly string[];
  readonly tokenCount: number;
}

/** §11.4 default traversal bounds. */
const RENDER_HEADING = '## Relevant personal context';

/**
 * The task-relevant predicate allowlist for expansion. `RELATED_TO` is deliberately absent:
 * §11.4 forbids expanding it without an explicit allowlist and it produces unbounded fanout.
 */
const RETRIEVAL_PREDICATES = [
  'OWNS', 'USES', 'PREFERS', 'WORKS_ON', 'HAS_SETTING', 'HAS_CONSTRAINT', 'HAS_GOAL',
  'RUNS_ON', 'DEPENDS_ON', 'PART_OF',
] as const satisfies readonly RelationType[];

export class MemoryRetriever {
  private readonly intents = new QueryIntentExtractor();
  private readonly views: AssertionViewBuilder;
  private limits: AssistantConfig['Retrieval'];

  constructor(
    private readonly graph: AssistantGraph,
    private readonly tokens: TokenCounter,
    limits: AssistantConfig['Retrieval'],
    private readonly usage: RetrievalUsageStore,
  ) {
    this.views = new AssertionViewBuilder(graph);
    this.limits = limits;
  }

  refreshLimits(limits: AssistantConfig['Retrieval']): void {
    this.limits = limits;
  }

  async retrieve(request: RetrieveRequest): Promise<RetrieveResult> {
    const intent = this.intents.extract(request.userMessage);
    if (intent.terms.length === 0) {
      return { renderedBlock: '', assertionIds: [], projectionIds: [], tokenCount: 0 };
    }
    const query = intent.terms.map((term) => `"${term}"`).join(' OR ');

    const seedNodeIds = this.graph.nodes.searchNodes(
      request.ownerId, query, this.limits.MaxSeedNodes,
    );
    const assertionIds = new Set(
      this.graph.assertions.searchAssertions(request.ownerId, query, this.limits.MaxAssertions),
    );
    for (const nodeId of seedNodeIds) {
      const neighborhood = this.graph.neighborhoods.read({
        ownerId: request.ownerId,
        rootNodeId: nodeId,
        predicates: RETRIEVAL_PREDICATES,
        maxHops: this.limits.MaxHops,
        maxNodes: this.limits.MaxNodes,
        maxAssertions: this.limits.MaxAssertions,
        maxFanoutPerNodePredicate: this.limits.MaxFanoutPerNodePredicate,
      });
      for (const assertionId of neighborhood.assertionIds) {
        assertionIds.add(assertionId);
      }
    }

    const rankedRows = [...this.graph.assertions.getAssertions([...assertionIds]).values()]
      .filter((row) => row.status === 'active' || row.status === 'disputed');
    const ranked = this.views.buildMany(rankedRows)
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

    // Token count is monotone in the number of included sentences, so the largest prefix that
    // fits is found by binary search: O(log n) tokenizer calls instead of one per line, and
    // each call in production is an HTTP round trip to the backend tokenizer.
    const sentences = ranked.map((entry) => renderAssertionSentence(entry.view));
    const measured = new Map<number, number>();
    const countPrefix = async (included: number): Promise<number> => {
      const cached = measured.get(included);
      if (cached !== undefined) return cached;
      const text = [RENDER_HEADING, '', ...sentences.slice(0, included)].join('\n');
      const value = (await this.tokens.count(text)).tokenCount;
      measured.set(included, value);
      return value;
    };

    let low = 0;
    let high = sentences.length;
    if (await countPrefix(0) > this.limits.MaxContextTokens) high = 0;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (await countPrefix(mid) <= this.limits.MaxContextTokens) low = mid;
      else high = mid - 1;
    }

    const includedAssertionIds = ranked.slice(0, low).map((entry) => entry.view.assertionId);

    if (includedAssertionIds.length === 0) {
      return { renderedBlock: '', assertionIds: [], projectionIds, tokenCount: 0 };
    }
    const lines = [RENDER_HEADING, '', ...sentences.slice(0, low)];
    const tokenCount = measured.get(low);
    if (tokenCount === undefined) {
      throw new Error(`Retrieval prefix of ${low} sentences was selected but never measured.`);
    }
    const result = {
      renderedBlock: lines.join('\n'),
      assertionIds: includedAssertionIds,
      projectionIds,
      tokenCount,
    };
    if (request.recordUsage) {
      this.usage.record({
        ownerId: request.ownerId,
        conversationId: request.conversationId,
        queryHash: hashTextContent(request.userMessage),
        assertionIds: result.assertionIds,
        projectionIds: result.projectionIds,
        renderedTokenCount: result.tokenCount,
      });
    }
    return result;
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
      userDemotion: view.userDemoted ? 1 : 0,
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
