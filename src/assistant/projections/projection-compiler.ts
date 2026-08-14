import type { AssistantGraph } from '../assistant-graph.js';
import { hashTextContent } from '../domain/keys.js';
import { RELATION_DEFINITIONS } from '../domain/relation-types.js';
import { stalenessFactor } from '../domain/staleness.js';
import { routeTier, tierUtility } from '../domain/tier-utility.js';
import type { TokenCounter } from '../domain/tokens.js';
import { LIVE_ASSERTION_STATUSES } from '../storage/assertion-store.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../storage/schema.js';
import { planTier3Archives } from './archive-planner.js';
import { AssertionViewBuilder } from './assertion-view-builder.js';
import {
  TIER_DOCUMENT_LIMIT, isProjectableInPlaintext,
  type AssertionView, type CompiledDocument,
} from './assertion-view.js';
import { DossierCompiler } from './dossier-compiler.js';
import { renderFrontmatter } from './frontmatter.js';
import { ProfileCompiler } from './profile-compiler.js';
import { TokenLimitEnforcer } from './token-limit-enforcer.js';
import type { ProjectionSummaryService } from './projection-summarizer.js';

export interface CompileSummary {
  readonly written: number;
  readonly unchanged: number;
  readonly demotedTopicKeys: readonly string[];
  readonly omittedAssertionCount: number;
  /** Rows the sweep removed because this compile did not produce them (§10.3). */
  readonly deletedProjectionCount: number;
  /** Tier 3 topics merged into an `archive/<segment>` document, sorted (§10.3). */
  readonly archivedTopicKeys: readonly string[];
}

/** §10.3 per-tier document counts. Overridable so tests can exercise overflow cheaply. */
export interface TierDocumentLimits {
  readonly 1: number;
  readonly 2: number;
  readonly 3: number;
}

/** What `persistWithSummary` did, plus the desired-set key it claimed. */
interface PersistOutcome {
  readonly written: number;
  readonly unchanged: number;
  readonly desiredKey: string;
}

export interface ProjectionTargetTokens {
  readonly 1: number;
  readonly 2: number;
  readonly 3: number;
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
    private readonly tokens: TokenCounter,
    private readonly summarizer: ProjectionSummaryService,
    private readonly targetTokens: ProjectionTargetTokens,
    private readonly tierLimits: TierDocumentLimits = TIER_DOCUMENT_LIMIT,
  ) {
    this.views = new AssertionViewBuilder(graph);
    const enforcer = new TokenLimitEnforcer(tokens);
    this.profiles = new ProfileCompiler(tokens, enforcer);
    this.dossiers = new DossierCompiler(tokens, enforcer);
  }

  async compileAll(ownerId: string, abortSignal: AbortSignal): Promise<CompileSummary> {
    const graphVersion = this.graph.graphVersion;
    const all = this.collectViews(ownerId);
    const profileViews = all.filter(
      (view) => RELATION_DEFINITIONS[view.predicate].projectionBehavior === 'core'
        && !view.userDemoted,
    );
    const bundles = this.buildBundles(all);

    let written = 0;
    let unchanged = 0;
    let omittedAssertionCount = 0;
    const demotedTopicKeys: string[] = [];
    const desired = new Set<string>();

    const tier2 = bundles.filter((bundle) => bundle.tier === 2)
      .sort((left, right) => right.utility - left.utility);
    const keptTier2 = tier2.slice(0, this.tierLimits[2]);
    for (const demoted of tier2.slice(this.tierLimits[2])) {
      demotedTopicKeys.push(demoted.topicKey);
    }
    const tier3Sorted = [
      ...bundles.filter((bundle) => bundle.tier === 3),
      ...tier2.slice(this.tierLimits[2]).map((bundle) => ({ ...bundle, tier: 3 as const })),
    ].sort((left, right) => right.utility - left.utility);
    const plan = planTier3Archives(tier3Sorted, this.tierLimits[3]);
    const archivedTopicKeys = [...plan.archives.values()].flat()
      .map((bundle) => bundle.topicKey).sort();

    // An owner with nothing to say gets no profile row at all, rather than an empty document.
    if (profileViews.length > 0 || keptTier2.length > 0) {
      const profile = await this.profiles.compile({
        views: profileViews,
        tier2TopicKeys: keptTier2.map((bundle) => bundle.topicKey),
      });
      const profileResult = await this.persistWithSummary(
        ownerId, profile, graphVersion, abortSignal,
      );
      written += profileResult.written;
      unchanged += profileResult.unchanged;
      desired.add(profileResult.desiredKey);
      omittedAssertionCount += profile.omittedAssertionCount;
    }

    for (const bundle of [...keptTier2, ...plan.kept]) {
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
      const result = await this.persistWithSummary(
        ownerId, document, graphVersion, abortSignal,
      );
      written += result.written;
      unchanged += result.unchanged;
      desired.add(result.desiredKey);
      omittedAssertionCount += document.omittedAssertionCount;
    }

    // Archive groups compile last, in key order, so the written bytes are order-independent.
    for (const [archiveKey, group] of [...plan.archives.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))) {
      const document = await this.dossiers.compile({
        tier: 3,
        topicKey: archiveKey,
        title: `Archive — ${archiveKey.slice('archive/'.length)}`,
        views: group.flatMap((bundle) => bundle.views),
        relatedTopicKeys: [],
      });
      const result = await this.persistWithSummary(ownerId, document, graphVersion, abortSignal);
      written += result.written;
      unchanged += result.unchanged;
      desired.add(result.desiredKey);
      omittedAssertionCount += document.omittedAssertionCount;
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'projection_archived',
        targetType: 'memory_projections',
        targetId: archiveKey,
        summary: `Tier 3 overflow merged into ${archiveKey}.`,
        details: { mergedTopicKeys: group.map((bundle) => bundle.topicKey).sort() },
      });
    }

    const deletedProjectionCount = this.sweepOrphans(ownerId, desired);
    return {
      written,
      unchanged,
      demotedTopicKeys,
      omittedAssertionCount,
      deletedProjectionCount,
      archivedTopicKeys,
    };
  }

  /** Deletes every row this compile did not produce. Runs unconditionally (§10.3). */
  private sweepOrphans(ownerId: string, desired: ReadonlySet<string>): number {
    let deleted = 0;
    for (const row of this.graph.projections.listAllRows(ownerId)) {
      if (desired.has(`${row.tier}:${row.topic_key}`)) continue;
      this.graph.projections.deleteProjection(row.id);
      this.graph.audit.recordAuditEvent({
        ownerId,
        eventType: 'projection_deleted',
        targetType: 'memory_projections',
        targetId: row.id,
        summary: 'Projection removed: no longer in the compiled desired set.',
        details: { tier: row.tier, topicKey: row.topic_key },
      });
      deleted += 1;
    }
    return deleted;
  }

  private collectViews(ownerId: string): AssertionView[] {
    const owner = this.graph.nodes.findByCanonicalKey(
      ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
    );
    if (owner === null) {
      return [];
    }
    const rows = this.graph.assertions
      .listBySubject(ownerId, owner.id, LIVE_ASSERTION_STATUSES)
      .filter((row) => RELATION_DEFINITIONS[row.predicate].projectionBehavior !== 'never_project');
    return this.views.buildMany(rows).filter(isProjectableInPlaintext);
  }

  private buildBundles(views: readonly AssertionView[]): TopicBundle[] {
    const byTopic = new Map<string, AssertionView[]>();
    for (const view of views) {
      if (
        RELATION_DEFINITIONS[view.predicate].projectionBehavior === 'core'
        && !view.userDemoted
      ) continue;
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
      userDemotion: views.some((view) => view.userDemoted) ? 1 : 0,
      redundancy: 0,
      staleness: worstStaleness,
      sensitivityCost: views.some((view) => view.sensitivity !== 'low' && view.sensitivity !== 'personal') ? 1 : 0,
    });
  }

  /** Writes only when the rendered bytes changed — §10.5's single-row update. */
  private async persistWithSummary(
    ownerId: string,
    document: CompiledDocument,
    graphVersion: number,
    abortSignal: AbortSignal,
  ): Promise<PersistOutcome> {
    const desiredKey = `${document.tier}:${document.topicKey}`;
    const existing = this.graph.projections.findByTopic(
      ownerId, document.tier, document.topicKey,
    );
    if (existing !== null && existing.graph_version === graphVersion) {
      return { written: 0, unchanged: 1, desiredKey };
    }
    const provisionalId = existing?.id ?? 'memproj_pending';
    this.writeDocument(ownerId, document, graphVersion, provisionalId);
    if (document.tokenCount <= this.targetTokens[document.tier]) {
      return { written: 1, unchanged: 0, desiredKey };
    }

    const summarized = await this.summarizer.summarize({
      body: document.body,
      assertions: document.includedAssertionIds.map((assertionId) => ({
        assertionId,
        sensitivity: document.sensitivity,
      })),
      targetTokens: this.targetTokens[document.tier],
    }, abortSignal);
    if (summarized.kind === 'unchanged') {
      return { written: 1, unchanged: 0, desiredKey };
    }
    const count = await this.tokens.count(summarized.body);
    this.writeDocument(ownerId, {
      ...document,
      body: summarized.body,
      includedAssertionIds: summarized.assertionIds,
      tokenCount: count.tokenCount,
      tokenizerId: count.tokenizerId,
    }, graphVersion, provisionalId);
    return { written: 1, unchanged: 0, desiredKey };
  }

  private writeDocument(
    ownerId: string,
    document: CompiledDocument,
    graphVersion: number,
    provisionalId: string,
  ): void {
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

    this.graph.projections.upsert({
      ownerId,
      tier: document.tier,
      topicKey: document.topicKey,
      title: document.title,
      content,
      contentHash: hashTextContent(document.body),
      tokenCount: document.tokenCount,
      tokenizerId: document.tokenizerId,
      graphVersion,
      includedAssertionIds: document.includedAssertionIds,
      sensitivity: document.sensitivity,
    });
  }
}
