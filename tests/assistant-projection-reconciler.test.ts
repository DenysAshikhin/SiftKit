import assert from 'node:assert/strict';
import test from 'node:test';

import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService,
  SummarizeProjectionResult,
} from '../src/assistant/projections/projection-summarizer.js';
import { withAssistantContextAsync, type AssistantTestContext } from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';

/** A summarizer that never rewrites: compile stays deterministic and model-free. */
class PassthroughSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'passthrough' };
  }
}

const TARGETS = { 1: 10_000, 2: 50_000, 3: 10_000 };

function compilerFor(context: AssistantTestContext): ProjectionCompiler {
  return new ProjectionCompiler(
    context.graph, new EstimateTokenCounter(4), new PassthroughSummarizer(), TARGETS,
  );
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
