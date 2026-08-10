import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { CaptureSubmissionDto } from '@siftkit/contracts';
import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { CaptureQueueStore } from '../src/assistant/images/capture-queue-store.js';
import { ImageExtractor } from '../src/assistant/images/image-extractor.js';
import type {
  AssistantImageCapability, AssistantImageCapabilityProvider,
} from '../src/assistant/images/image-capability.js';
import { SINGLE_SCREENSHOT_TEXT_CEILING } from '../src/assistant/domain/confidence.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { withAssistantContextAsync, type AssistantTestContext } from './helpers/assistant-fixture.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function extraction(objectName: string, suggestedConfidence = 0.9): string {
  return JSON.stringify({
    statements: [{
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'PREFERS',
      object: { kind: 'unresolved', nodeType: 'software', displayName: objectName },
      scope: null,
      rationale: `The screenshot shows ${objectName} in the foreground.`,
      suggestedConfidence,
    }],
  });
}

/** Reports a new `instanceId` on every read after the first, simulating a runtime swap. */
class StubImageCapability implements AssistantImageCapabilityProvider {
  reads = 0;

  constructor(
    private readonly capable: boolean,
    private readonly changesInstanceAfterFirstRead = false,
  ) {}

  read(): AssistantImageCapability {
    this.reads += 1;
    const generation = this.changesInstanceAfterFirstRead ? this.reads : 1;
    return {
      instanceId: this.capable ? `exl3:${generation}` : null,
      visionCapable: this.capable,
      healthy: this.capable,
    };
  }
}

interface ExtractorFixture {
  readonly queue: CaptureQueueStore;
  readonly extractor: ImageExtractor;
  readonly inference: FakeAssistantInference;
  readonly capability: StubImageCapability;
  readonly evidenceId: string;
}

function buildFixture(
  context: AssistantTestContext,
  responses: readonly string[],
  capability: StubImageCapability,
): ExtractorFixture {
  const queue = new CaptureQueueStore(context.database, context.clock);
  const evidence = context.graph.evidence.recordBlobEvidence({
    ownerId: context.ownerId,
    deviceId: null,
    sourceEventId: `capture:${context.clock.nowUtc()}`,
    parentEvidenceId: null,
    sourceType: 'screenshot',
    sourceRef: 'app:code',
    capturedAtUtc: context.clock.nowUtc(),
    sourceTimezone: null,
    sensitivity: 'sensitive',
    retentionUntilUtc: null,
    metadata: { foregroundContextKey: 'app:code' },
    mimeType: 'image/png',
    bytes: PNG_BYTES,
  });
  queue.enqueue({
    ownerId: context.ownerId,
    evidenceId: evidence.id,
    state: 'awaiting_image_capability',
    foregroundContextKey: 'app:code',
    pixelSha256: 'a'.repeat(64),
    perceptualHash: 'f0e1d2c3b4a59687',
    byteLength: PNG_BYTES.byteLength,
  });
  const inference = new FakeAssistantInference(responses);
  return {
    queue,
    inference,
    capability,
    evidenceId: evidence.id,
    extractor: new ImageExtractor({
      graph: context.graph,
      queue,
      runner: new StructuredOutputRunner(inference),
      capability,
    }),
  };
}

class AlwaysIdle {
  isIdle(): boolean {
    return true;
  }
}

function captureDto(
  capturedAtUtc: string, pixelSha256: string, perceptualHash = 'f0e1d2c3b4a59687',
): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc,
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
    pixelSha256,
    perceptualHash,
    imageDataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
  };
}

test('a drain with a capable runtime extracts every unprocessed capture oldest-first', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-image-drain-');
  const clock = new FixedClock('2026-08-10T09:00:00.000Z');
  const inference = new FakeAssistantInference([
    extraction('Visual Studio Code'), extraction('Firefox'),
  ]);
  const service = AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock,
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(),
    inference,
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
    imageCapability: new StubImageCapability(true),
    config: {
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, ScreenshotsEnabled: true },
    },
  });
  try {
    const queue = new CaptureQueueStore(
      getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')), clock,
    );
    const first = service.ingestCapture(captureDto('2026-08-10T09:00:00.000Z', '1'.repeat(64)));
    clock.advanceSeconds(60);
    const second = service.ingestCapture(
      captureDto('2026-08-10T09:01:00.000Z', '2'.repeat(64), '0f1e2d3c4b5a6978'),
    );
    assert.equal(first.kind, 'accepted');
    assert.equal(second.kind, 'accepted');
    if (first.kind !== 'accepted' || second.kind !== 'accepted') return;

    await service.drainJobs();

    assert.equal(queue.require(first.evidenceId).state, 'processed');
    assert.equal(queue.require(second.evidenceId).state, 'processed');
    assert.equal(inference.requests.length, 2);

    await service.drainJobs();
    assert.equal(inference.requests.length, 2, 'a processed capture is never extracted twice');
  } finally {
    closeRuntimeDatabase();
  }
});

test('an incapable runtime leaves the item awaiting without calling the model', async () => {
  await withAssistantContextAsync(async (context) => {
    const fixture = buildFixture(context, [], new StubImageCapability(false));
    const outcome = await fixture.extractor.run(context.ownerId, fixture.evidenceId, null);

    assert.equal(outcome.kind, 'awaiting_capability');
    assert.equal(fixture.queue.require(fixture.evidenceId).state, 'awaiting_image_capability');
    assert.equal(fixture.inference.requests.length, 0);
  });
});

test('a capable runtime records screenshot observations and passive candidates', async () => {
  await withAssistantContextAsync(async (context) => {
    const fixture = buildFixture(context, [extraction('Visual Studio Code')], new StubImageCapability(true));
    const outcome = await fixture.extractor.run(context.ownerId, fixture.evidenceId, null);

    assert.equal(outcome.kind, 'processed');
    if (outcome.kind !== 'processed') return;
    assert.equal(outcome.observationIds.length, 1);
    assert.equal(outcome.candidateIds.length, 1);

    const observations = context.graph.observations.listByEvidence(fixture.evidenceId);
    assert.equal(observations[0]?.observation_type, 'screenshot_extraction');
    const candidateId = outcome.candidateIds[0] ?? '';
    assert.equal(context.graph.candidates.requireCandidate(candidateId).basis, 'passive_observation');

    const row = fixture.queue.require(fixture.evidenceId);
    assert.equal(row.state, 'processed');
    assert.notEqual(row.processed_at_utc, null);

    const request = fixture.inference.requests[0];
    assert.equal(request?.kind, 'image');
    assert.equal(request?.kind === 'image' ? request.images.length : 0, 1);
  });
});

test('an already processed item is a no-op, so a replayed job cannot extract twice', async () => {
  await withAssistantContextAsync(async (context) => {
    const fixture = buildFixture(context, [extraction('Visual Studio Code')], new StubImageCapability(true));
    await fixture.extractor.run(context.ownerId, fixture.evidenceId, null);
    const second = await fixture.extractor.run(context.ownerId, fixture.evidenceId, null);

    assert.equal(second.kind, 'already_processed');
    assert.equal(fixture.inference.requests.length, 1);
    assert.equal(context.graph.observations.listByEvidence(fixture.evidenceId).length, 1);
  });
});

test('an instance change between admission and dispatch returns the item to awaiting', async () => {
  await withAssistantContextAsync(async (context) => {
    const fixture = buildFixture(
      context, [extraction('Visual Studio Code')], new StubImageCapability(true, true),
    );
    const outcome = await fixture.extractor.run(context.ownerId, fixture.evidenceId, null);

    assert.equal(outcome.kind, 'awaiting_capability');
    assert.equal(fixture.queue.require(fixture.evidenceId).state, 'awaiting_image_capability');
    assert.equal(fixture.inference.requests.length, 0);
    assert.equal(context.graph.candidates.listValidationQueue(context.ownerId).length, 0);
  });
});

test('unusable model output is audited and never becomes a candidate', async () => {
  await withAssistantContextAsync(async (context) => {
    const fixture = buildFixture(context, ['not json', 'still not json'], new StubImageCapability(true));
    const outcome = await fixture.extractor.run(context.ownerId, fixture.evidenceId, null);

    assert.equal(outcome.kind, 'rejected');
    assert.equal(fixture.queue.require(fixture.evidenceId).state, 'processed');
    assert.equal(context.graph.observations.listByEvidence(fixture.evidenceId).length, 0);
    assert.ok(context.graph.audit.listAuditEvents(context.ownerId, 10)
      .some((event) => event.event_type === 'extraction_rejected'));
  });
});

test('a candidate supported only by one screenshot is capped below stable promotion', async () => {
  await withAssistantContextAsync(async (context) => {
    const fixture = buildFixture(context, [extraction('Visual Studio Code')], new StubImageCapability(true));
    const outcome = await fixture.extractor.run(context.ownerId, fixture.evidenceId, null);
    assert.equal(outcome.kind, 'processed');
    if (outcome.kind !== 'processed') return;

    const promoter = new CandidatePromoter(
      context.graph, new CandidateGate(context.graph.policies, new SecretScanner()),
    );
    const promotion = promoter.promote({
      ownerId: context.ownerId, candidateId: outcome.candidateIds[0] ?? '',
    });
    assert.equal(promotion.kind, 'promoted');
    if (promotion.kind !== 'promoted') return;
    const assertionRow = context.graph.assertions.requireAssertion(promotion.assertionId);
    assert.ok(
      assertionRow.confidence <= SINGLE_SCREENSHOT_TEXT_CEILING,
      `single-screenshot confidence must stay at or below ${SINGLE_SCREENSHOT_TEXT_CEILING}`,
    );
  });
});
