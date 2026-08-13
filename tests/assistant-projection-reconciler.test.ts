import assert from 'node:assert/strict';
import test from 'node:test';

import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService,
  SummarizeProjectionResult,
} from '../src/assistant/projections/projection-summarizer.js';
import { LIVE_ASSERTION_STATUSES } from '../src/assistant/storage/assertion-store.js';
import { OWNER_PERSON_CANONICAL_KEY } from '../src/assistant/storage/schema.js';
import { withAssistantContextAsync, type AssistantTestContext } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';

/** A summarizer that never rewrites: compile stays deterministic and model-free. */
class PassthroughSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'passthrough' };
  }
}

const TARGETS = { 1: 10_000, 2: 50_000, 3: 10_000 };

function compilerFor(
  context: AssistantTestContext,
  tierLimits?: { 1: number; 2: number; 3: number },
): ProjectionCompiler {
  return new ProjectionCompiler(
    context.graph, new EstimateTokenCounter(4), new PassthroughSummarizer(), TARGETS, tierLimits,
  );
}

function liveOwnerAssertionCount(context: AssistantTestContext): number {
  const owner = context.graph.nodes.findByCanonicalKey(
    context.ownerId, 'person', OWNER_PERSON_CANONICAL_KEY,
  );
  if (owner === null) return 0;
  return context.graph.assertions
    .listBySubject(context.ownerId, owner.id, LIVE_ASSERTION_STATUSES).length;
}

function seedOverflowTopics(context: AssistantTestContext, count: number): void {
  for (let index = 0; index < count; index += 1) {
    seedOwnerAssertion(context, { objectName: `tool${index} extra` });
  }
}

test('a projection row outside the desired set is deleted on recompile', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Neovim' });
    const compiler = compilerFor(context);
    await compiler.compileAll(context.ownerId, new AbortController().signal);

    // A stale row no compile would produce (e.g. left behind by a 2 -> 3 demotion).
    context.graph.projections.upsert({
      ownerId: context.ownerId, tier: 2, topicKey: 'stale-orphan', title: 'Stale',
      content: 'orphan', contentHash: 'x'.repeat(64), tokenCount: 1,
      tokenizerId: 'estimate', graphVersion: 0, includedAssertionIds: [], sensitivity: 'personal',
    });

    const summary = await compiler.compileAll(context.ownerId, new AbortController().signal);
    assert.equal(summary.deletedProjectionCount, 1);
    assert.equal(
      context.graph.projections.findByTopic(context.ownerId, 2, 'stale-orphan'), null,
    );
    assert.deepEqual(
      context.graph.projections.search(context.ownerId, 'orphan', 10), [],
    );
  });
});

test('the sweep leaves every row the compile produced and audits only what it removed', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOwnerAssertion(context, { objectName: 'Neovim' });
    seedOwnerAssertion(context, { objectName: 'Ripgrep' });
    const compiler = compilerFor(context);
    await compiler.compileAll(context.ownerId, new AbortController().signal);
    const before = context.graph.projections.listAllRows(context.ownerId).map((row) => row.id);

    const summary = await compiler.compileAll(context.ownerId, new AbortController().signal);

    assert.equal(summary.deletedProjectionCount, 0);
    assert.deepEqual(
      context.graph.projections.listAllRows(context.ownerId).map((row) => row.id), before,
    );
    assert.equal(
      context.graph.audit.listAuditEvents(context.ownerId, 100)
        .some((event) => event.event_type === 'projection_deleted'),
      false,
    );
  });
});

test('tier 3 overflow archives without losing graph facts and reports it', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOverflowTopics(context, 8);
    const compiler = compilerFor(context, { 1: 1, 2: 2, 3: 3 });
    const summary = await compiler.compileAll(context.ownerId, new AbortController().signal);

    assert.ok(summary.archivedTopicKeys.length > 0);
    const tier3 = context.graph.projections.listByTier(context.ownerId, 3);
    assert.ok(tier3.length <= 3, `tier 3 held ${tier3.length} documents`);
    assert.ok(tier3.some((row) => row.topic_key.startsWith('archive/')));

    // Every archived topic key names a topic that no longer has its own tier 3 row.
    for (const archived of summary.archivedTopicKeys) {
      assert.equal(context.graph.projections.findByTopic(context.ownerId, 3, archived), null);
    }
    // The graph is untouched: archiving is a projection concern only.
    assert.equal(liveOwnerAssertionCount(context), 8);
  });
});

test('the superseded individual tier 3 rows are swept once an archive replaces them', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOverflowTopics(context, 8);
    // A generous limit first, so every topic gets its own tier 3 row...
    const roomy = compilerFor(context, { 1: 1, 2: 2, 3: 50 });
    await roomy.compileAll(context.ownerId, new AbortController().signal);
    const individualRows = context.graph.projections.listByTier(context.ownerId, 3).length;
    assert.ok(individualRows > 3);

    // ...then a tight one, which must archive them and delete the rows they replaced.
    const tight = compilerFor(context, { 1: 1, 2: 2, 3: 3 });
    const summary = await tight.compileAll(context.ownerId, new AbortController().signal);

    assert.ok(summary.deletedProjectionCount > 0);
    const tier3 = context.graph.projections.listByTier(context.ownerId, 3);
    assert.ok(tier3.length <= 3);
    assert.deepEqual(
      tier3.filter((row) => !row.topic_key.startsWith('archive/'))
        .map((row) => row.topic_key)
        .filter((topicKey) => summary.archivedTopicKeys.includes(topicKey)),
      [],
    );
  });
});

test('the same graph compiles to identical bytes twice', async () => {
  await withAssistantContextAsync(async (context) => {
    seedOverflowTopics(context, 8);
    const compiler = compilerFor(context, { 1: 1, 2: 2, 3: 3 });
    await compiler.compileAll(context.ownerId, new AbortController().signal);
    const first = context.graph.projections.listAllRows(context.ownerId)
      .map((row) => [row.tier, row.topic_key, row.content_hash]);
    await compiler.compileAll(context.ownerId, new AbortController().signal);
    const second = context.graph.projections.listAllRows(context.ownerId)
      .map((row) => [row.tier, row.topic_key, row.content_hash]);
    assert.deepEqual(second, first);
  });
});

test('a topic whose assertions are all retired loses its projection row', async () => {
  await withAssistantContextAsync(async (context) => {
    const kept = seedOwnerAssertion(context, { objectName: 'Ripgrep' });
    const dropped = seedOwnerAssertion(context, { objectName: 'Neovim' });
    const compiler = compilerFor(context);
    await compiler.compileAll(context.ownerId, new AbortController().signal);
    assert.notEqual(
      context.graph.projections.findByTopic(context.ownerId, 2, dropped.topicKey), null,
    );

    context.graph.assertionService.forget({
      ownerId: context.ownerId,
      assertionId: dropped.assertion.id,
      reason: 'reconciler regression',
    });

    const summary = await compiler.compileAll(context.ownerId, new AbortController().signal);
    assert.equal(summary.deletedProjectionCount, 1);
    assert.equal(
      context.graph.projections.findByTopic(context.ownerId, 2, dropped.topicKey), null,
    );
    assert.notEqual(
      context.graph.projections.findByTopic(context.ownerId, 2, kept.topicKey), null,
    );
    assert.ok(
      context.graph.audit.listAuditEvents(context.ownerId, 100)
        .some((event) => event.event_type === 'projection_deleted'),
    );
  });
});
