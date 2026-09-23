import assert from 'node:assert/strict';
import test from 'node:test';

import type { CaptureSubmissionDto } from '@siftkit/contracts';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { ProjectionCompiler } from '../src/assistant/projections/projection-compiler.js';
import type {
  ProjectionSummaryService, SummarizeProjectionResult,
} from '../src/assistant/projections/projection-summarizer.js';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.js';
import {
  FIXTURE_START_INSTANT,
  withAssistantContextAsync,
  type AssistantTestContext,
} from './helpers/assistant-fixture.js';
import { seedOwnerAssertion } from './helpers/gate-e-seed.js';
import { buildService, PROJECTION_SIGNAL, assertProjectionIntegrity } from './helpers/assistant-gate-e-e2e-fixtures.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

class PassthroughSummarizer implements ProjectionSummaryService {
  async summarize(): Promise<SummarizeProjectionResult> {
    return { kind: 'unchanged', reason: 'passthrough' };
  }
}

function extraction(objectName: string): string {
  return JSON.stringify({
    statements: [{
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'USES',
      object: { kind: 'unresolved', nodeType: 'software', displayName: objectName },
      scope: null,
      rationale: `The screenshot shows ${objectName} in the foreground.`,
      suggestedConfidence: 0.9,
    }],
  });
}

function captureDto(): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: FIXTURE_START_INSTANT,
    reason: 'fixed_cadence',
    display: {
      id: 'DISPLAY1', name: 'Monitor', primary: true,
      pixelWidth: 1920, pixelHeight: 1080, logicalWidth: 1920, logicalHeight: 1080,
      scaleFactor: 1,
    },
    foregroundContextKey: 'app:code|siftkit',
    foreground: {
      processName: 'Code.exe',
      executablePath: 'C:/Code.exe',
      applicationId: 'app:code',
      normalizedTitle: 'SiftKit',
      fullscreen: false,
    },
    pixelSha256: '1'.repeat(64),
    perceptualHash: 'f0e1d2c3b4a59687',
    imageDataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  };
}

function compilerFor(
  context: AssistantTestContext,
  tierLimits?: { readonly 1: number; readonly 2: number; readonly 3: number },
): ProjectionCompiler {
  return new ProjectionCompiler(
    context.graph,
    new EstimateTokenCounter(4),
    new PassthroughSummarizer(),
    { 1: 10_000, 2: 50_000, 3: 10_000 },
    tierLimits,
  );
}

function projectionHashes(context: AssistantTestContext): Map<string, string> {
  return new Map(context.graph.projections.listAllRows(context.ownerId)
    .map((row) => [`${row.tier}:${row.topic_key}`, row.content_hash]));
}

test('gate E scenario 5: deleting capture evidence purges the blob and queues the recompile', async () => {
  const { service, context } = buildService(
    'siftkit-gate-e-scenario-5-', [extraction('Visual Studio Code')],
  );
  try {
    assert.equal(service.ingestCapture(captureDto()).kind, 'accepted');
    await service.drainJobs();

    const evidence = context.graph.evidence.list(context.ownerId, 50, 0)
      .find((row) => row.source_type === 'screenshot');
    assert.ok(evidence !== undefined, 'the capture became a screenshot evidence record');
    const blobId = evidence.blob_id;
    assert.ok(blobId !== null, 'the capture kept its encrypted pixels');
    assert.deepEqual(context.graph.evidence.readBlobBytes(blobId), PNG_BYTES);

    const dependents = context.graph.assertions.listAssertionIdsForEvidence(evidence.id);
    assert.equal(dependents.length, 1, 'the extraction produced exactly one dependent assertion');
    const assertionId = dependents[0] ?? '';
    const before = context.graph.assertions.requireAssertion(assertionId);
    assert.ok(before.confidence > 0);

    // A screenshot-derived belief is `personal`, so it competes for the plaintext projections on
    // the same terms as any other source. The deletion below therefore has to reach a compiled
    // document, not just the graph.
    assert.equal(before.sensitivity, 'personal');
    await service.memoryMutations.rebuildProjections(context.ownerId, PROJECTION_SIGNAL);
    assert.ok(
      context.graph.projections.listAllRows(context.ownerId).flatMap(
        (row) => context.graph.projections.readIncludedAssertionIds(row),
      ).includes(assertionId),
      'capture content reaches a plaintext projection',
    );

    const preview = service.memoryMutations.previewDeleteEvidence(context.ownerId, evidence.id);
    assert.deepEqual(preview.dependentAssertionIds, [assertionId]);
    service.memoryMutations.confirmDeleteEvidence(
      context.ownerId, evidence.id, preview.previewToken,
    );

    assert.equal(context.graph.evidence.requireEvidence(evidence.id).status, 'deleted');
    assert.throws(() => context.graph.evidence.readBlobBytes(blobId), /blob/iu);
    const after = context.graph.assertions.requireAssertion(assertionId);
    assert.ok(
      after.confidence < before.confidence,
      `confidence stayed at ${after.confidence} after its only support was deleted`,
    );
    assert.deepEqual(context.graph.assertions.listAssertionIdsForEvidence(evidence.id), []);

    // The deletion must reach the compiled documents, not just the graph: the mutation queues the
    // recompile itself rather than leaving stale projections behind for the next unrelated drain.
    assert.ok(
      context.graph.jobs.listByStatus(context.ownerId, 'queued')
        .some((job) => job.job_type === 'projection_maintenance'),
      'evidence deletion queues a projection recompile',
    );
    await service.memoryMutations.rebuildProjections(context.ownerId, PROJECTION_SIGNAL);
    assertProjectionIntegrity(context);
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('gate E scenario 7: the 26th tier 2 topic is demoted and leaves no orphan tier 2 row', async () => {
  await withAssistantContextAsync(async (context) => {
    const compiler = compilerFor(context);
    const topicKeys: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const objectName = `Project ${String(index).padStart(2, '0')}`;
      for (const variant of ['alpha', 'beta', 'gamma']) {
        topicKeys.push(seedOwnerAssertion(context, { objectName, variant }).topicKey);
      }
    }
    const first = await compiler.compileAll(context.ownerId, PROJECTION_SIGNAL);
    assert.equal(first.demotedTopicKeys.length, 0, '25 topics fit tier 2 exactly');
    assert.equal(context.graph.projections.listByTier(context.ownerId, 2).length, 25);

    for (const variant of ['alpha', 'beta', 'gamma']) {
      topicKeys.push(seedOwnerAssertion(context, { objectName: 'Project 25', variant }).topicKey);
    }
    const second = await compiler.compileAll(context.ownerId, PROJECTION_SIGNAL);

    const tier2 = context.graph.projections.listByTier(context.ownerId, 2);
    assert.equal(tier2.length, 25, 'tier 2 never exceeds its document limit');
    assert.equal(second.demotedTopicKeys.length, 1);
    const demoted = second.demotedTopicKeys[0] ?? '';
    assert.ok(
      new Set(topicKeys).has(demoted), `${demoted} is not one of the seeded topics`,
    );
    assert.equal(
      tier2.some((row) => row.topic_key === demoted), false,
      'the demoted topic must not keep an orphan tier 2 row',
    );
    assert.ok(
      context.graph.projections.listByTier(context.ownerId, 3)
        .some((row) => row.topic_key === demoted),
      'the demoted topic reappears in tier 3',
    );

    const owner = context.graph.nodes.findByCanonicalKey(context.ownerId, 'person', 'person:owner');
    assert.ok(owner !== null);
    assert.equal(
      context.graph.assertions.listBySubject(context.ownerId, owner.id, ['active']).length,
      78,
      'no graph fact is lost to a tier limit',
    );
    assertProjectionIntegrity(context);
  });
});

test('gate E scenario 8: tier 3 overflow merges into archive documents and recompiles identically', async () => {
  await withAssistantContextAsync(async (context) => {
    const compiler = compilerFor(context, { 1: 1, 2: 3, 3: 5 });
    for (let index = 0; index < 12; index += 1) {
      seedOwnerAssertion(context, { objectName: `Topic ${String(index).padStart(2, '0')}` });
    }

    const summary = await compiler.compileAll(context.ownerId, PROJECTION_SIGNAL);
    assert.ok(summary.archivedTopicKeys.length > 0, 'the overflow must be named, never silent');
    const archives = context.graph.projections.listAllRows(context.ownerId)
      .filter((row) => row.topic_key.startsWith('archive/'));
    assert.ok(archives.length > 0, 'an archive document exists');
    for (const key of summary.archivedTopicKeys) {
      assert.equal(
        context.graph.projections.listAllRows(context.ownerId)
          .some((row) => row.topic_key === key),
        false,
        `${key} kept a standalone row after being archived`,
      );
    }

    const owner = context.graph.nodes.findByCanonicalKey(context.ownerId, 'person', 'person:owner');
    assert.ok(owner !== null);
    assert.equal(
      context.graph.assertions.listBySubject(context.ownerId, owner.id, ['active']).length,
      12,
      'archiving is a projection concern; the graph keeps every fact',
    );

    const hashes = projectionHashes(context);
    const again = await compiler.compileAll(context.ownerId, PROJECTION_SIGNAL);
    assert.equal(again.written, 0, 'an unchanged graph rewrites nothing');
    assert.deepEqual(projectionHashes(context), hashes);
    assertProjectionIntegrity(context);
  });
});
