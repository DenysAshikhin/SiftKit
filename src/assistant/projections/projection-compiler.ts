import type { AssistantGraph } from '../assistant-graph.js';
import { hashTextContent } from '../domain/keys.js';
import { RELATION_DEFINITIONS } from '../domain/relation-types.js';
import { stalenessFactor } from '../domain/staleness.js';
import { routeTier, tierUtility } from '../domain/tier-utility.js';
import type { TokenCounter } from '../domain/tokens.js';
import { LIVE_ASSERTION_STATUSES } from '../storage/assertion-store.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';
import { AssertionViewBuilder } from './assertion-view-builder.js';
import {
  TIER_DOCUMENT_LIMIT, isProjectableInPlaintext,
  type AssertionView, type CompiledDocument,
} from './assertion-view.js';
import { DossierCompiler } from './dossier-compiler.js';
import { renderFrontmatter } from './frontmatter.js';
import { ProfileCompiler } from './profile-compiler.js';

export interface CompileSummary {
  readonly written: number;
  readonly unchanged: number;
  readonly demotedTopicKeys: readonly string[];
  readonly omittedAssertionCount: number;
}

interface TopicBundle {
  readonly topicKey: string;
  readonly title: string;
  readonly views: readonly AssertionView[];
  readonly utility: number;
  readonly tier: 2 | 3;
}

/** Recency saturates after a season; a fact seen today scores 1, one seen 180 days ago ~0. */
const RECENCY_HALF_LIFE_DAYS = 60;

export class ProjectionCompiler {
  private readonly views: AssertionViewBuilder;
  private readonly profiles: ProfileCompiler;
  private readonly dossiers: DossierCompiler;

  constructor(
    private readonly graph: AssistantGraph,
    tokens: TokenCounter,
  ) {
    this.views = new AssertionViewBuilder(graph);
    this.profiles = new ProfileCompiler(tokens);
    this.dossiers = new DossierCompiler(tokens);
  }

  async compileAll(ownerId: string): Promise<CompileSummary> {
    const graphVersion = this.graph.graphVersion;
    const all = this.collectViews(ownerId);
    const profileViews = all.filter(
      (view) => RELATION_DEFINITIONS[view.predicate].projectionBehavior === 'core',
    );
    const bundles = this.buildBundles(all);

    let written = 0;
    let unchanged = 0;
    let omittedAssertionCount = 0;
    const demotedTopicKeys: string[] = [];

    const tier2 = bundles.filter((bundle) => bundle.tier === 2)
      .sort((left, right) => right.utility - left.utility);
    const keptTier2 = tier2.slice(0, TIER_DOCUMENT_LIMIT[2]);
    for (const demoted of tier2.slice(TIER_DOCUMENT_LIMIT[2])) {
      demotedTopicKeys.push(demoted.topicKey);
    }
    const tier3 = [
      ...bundles.filter((bundle) => bundle.tier === 3),
      ...tier2.slice(TIER_DOCUMENT_LIMIT[2]).map((bundle) => ({ ...bundle, tier: 3 as const })),
    ].sort((left, right) => right.utility - left.utility).slice(0, TIER_DOCUMENT_LIMIT[3]);

    // An owner with nothing to say gets no profile row at all, rather than an empty document.
    if (profileViews.length > 0 || keptTier2.length > 0) {
      const profile = await this.profiles.compile({
        views: profileViews,
        tier2TopicKeys: keptTier2.map((bundle) => bundle.topicKey),
      });
      const profileResult = this.persist(ownerId, profile, graphVersion);
      written += profileResult.written;
      unchanged += profileResult.unchanged;
      omittedAssertionCount += profile.omittedAssertionCount;
    }

    for (const bundle of [...keptTier2, ...tier3]) {
      const document = await this.dossiers.compile({
        tier: bundle.tier,
        topicKey: bundle.topicKey,
        title: bundle.title,
        views: bundle.views,
        relatedTopicKeys: keptTier2
          .filter((other) => other.topicKey !== bundle.topicKey)
          .slice(0, 5)
          .map((other) => other.topicKey),
      });
      const result = this.persist(ownerId, document, graphVersion);
      written += result.written;
      unchanged += result.unchanged;
      omittedAssertionCount += document.omittedAssertionCount;
    }

    return { written, unchanged, demotedTopicKeys, omittedAssertionCount };
  }

  private collectViews(ownerId: string): AssertionView[] {
    const owner = this.graph.nodes.findByCanonicalKey(
      ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
    );
    if (owner === null) {
      return [];
    }
    return this.graph.assertions
      .listBySubject(ownerId, owner.id, LIVE_ASSERTION_STATUSES)
      .filter((row) => RELATION_DEFINITIONS[row.predicate].projectionBehavior !== 'never_project')
      .map((row) => this.views.build(row))
      .filter(isProjectableInPlaintext);
  }

  private buildBundles(views: readonly AssertionView[]): TopicBundle[] {
    const byTopic = new Map<string, AssertionView[]>();
    for (const view of views) {
      if (RELATION_DEFINITIONS[view.predicate].projectionBehavior === 'core') continue;
      const bucket = byTopic.get(view.topicKey) ?? [];
      bucket.push(view);
      byTopic.set(view.topicKey, bucket);
    }

    const bundles: TopicBundle[] = [];
    for (const [topicKey, topicViews] of [...byTopic.entries()].sort(
      (left, right) => left[0].localeCompare(right[0]),
    )) {
      const behavior = RELATION_DEFINITIONS[topicViews[0]?.predicate ?? 'RELATED_TO']
        .projectionBehavior;
      const utility = this.scoreTopic(topicViews);
      const tier = routeTier(behavior, utility);
      if (tier === null || tier === 1) continue;
      bundles.push({
        topicKey,
        title: topicViews[0]?.objectText ?? topicKey,
        views: topicViews,
        utility,
        tier,
      });
    }
    return bundles;
  }

  private scoreTopic(views: readonly AssertionView[]): number {
    const explicitCount = views.filter(
      (view) => view.basis === 'explicit_user_statement' || view.basis === 'explicit_question_answer',
    ).length;
    const newest = views.reduce(
      (latest, view) => Math.max(latest, Date.parse(view.lastObservedAtUtc)),
      0,
    );
    const ageDays = Math.max(0, (Date.parse(this.graph.nowUtc()) - newest) / 86_400_000);
    const worstStaleness = views.reduce((worst, view) => Math.max(
      worst,
      1 - stalenessFactor(
        RELATION_DEFINITIONS[view.predicate].stalenessClass,
        Math.max(0, (Date.parse(this.graph.nowUtc()) - Date.parse(view.lastObservedAtUtc)) / 86_400_000),
      ),
    ), 0);

    return tierUtility({
      explicitness: views.length === 0 ? 0 : explicitCount / views.length,
      crossDomainUsefulness: Math.min(1, views.length / 10),
      retrievalFrequency: 0,
      recency: 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS),
      activeGoalRelevance: views.some((view) => view.predicate === 'HAS_GOAL' || view.predicate === 'WORKS_ON') ? 1 : 0,
      uniqueness: 1 / Math.max(1, views.length),
      userPin: views.some((view) => view.pinned) ? 1 : 0,
      redundancy: 0,
      staleness: worstStaleness,
      sensitivityCost: views.some((view) => view.sensitivity !== 'low' && view.sensitivity !== 'personal') ? 1 : 0,
    });
  }

  /** Writes only when the rendered bytes changed — §10.5's single-row update. */
  private persist(
    ownerId: string,
    document: CompiledDocument,
    graphVersion: number,
  ): { written: number; unchanged: number } {
    const existing = this.graph.projections.findByTopic(
      ownerId, document.tier, document.topicKey,
    );
    const provisionalId = existing?.id ?? 'memproj_pending';
    const content = `${renderFrontmatter({
      projectionId: provisionalId,
      tier: document.tier,
      topicKey: document.topicKey,
      generatedAtUtc: this.graph.nowUtc(),
      graphVersion,
      tokenizerId: document.tokenizerId,
      tokenCount: document.tokenCount,
      sensitivity: document.sensitivity,
      includedAssertionIds: document.includedAssertionIds,
    })}\n\n${document.body}`;

    const bodyHash = hashTextContent(document.body);
    if (existing !== null && existing.content_hash === bodyHash) {
      return { written: 0, unchanged: 1 };
    }
    this.graph.projections.upsert({
      ownerId,
      tier: document.tier,
      topicKey: document.topicKey,
      title: document.title,
      content,
      contentHash: bodyHash,
      tokenCount: document.tokenCount,
      tokenizerId: document.tokenizerId,
      graphVersion,
      includedAssertionIds: document.includedAssertionIds,
      sensitivity: document.sensitivity,
    });
    return { written: 1, unchanged: 0 };
  }
}