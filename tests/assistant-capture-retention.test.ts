import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { CaptureSubmissionDto } from '@siftkit/contracts';
import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import type { AssistantConfig } from '../src/config/types.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { CaptureQueueStore } from '../src/assistant/images/capture-queue-store.js';
import { CaptureRetentionService } from '../src/assistant/images/capture-retention.js';
import type { CaptureQueueState } from '../src/assistant/domain/enums.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import {
  MemoryAssistantConfigWriter, withAssistantContext, type AssistantTestContext,
} from './helpers/assistant-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { ALWAYS_IDLE, ALWAYS_RESIDENT } from './helpers/assistant-gates.js';

const BYTES_PER_GB = 1024 ** 3;

/** 100-byte cap, so three 60-byte captures force two oldest-first evictions. */
const HUNDRED_BYTE_LIMIT_GB = 100 / BYTES_PER_GB;

function observationConfig(
  overrides: Partial<AssistantConfig['Observation']> = {},
): AssistantConfig['Observation'] {
  return { ...DEFAULT_ASSISTANT_CONFIG.Observation, ScreenshotsEnabled: true, ...overrides };
}

interface RetentionFixture {
  readonly queue: CaptureQueueStore;
  readonly retention: CaptureRetentionService;
}

function buildFixture(
  context: AssistantTestContext,
  observation: AssistantConfig['Observation'],
): RetentionFixture {
  const queue = new CaptureQueueStore(context.database, context.clock);
  const retention = new CaptureRetentionService({
    clock: context.clock,
    graph: context.graph,
    queue,
    observation,
  });
  return { queue, retention };
}

/** Distinct bytes per label so no two captures share an evidence blob. */
function recordCapture(
  context: AssistantTestContext,
  queue: CaptureQueueStore,
  label: number,
  state: CaptureQueueState,
  byteLength = 60,
): string {
  const bytes = Buffer.alloc(byteLength, label);
  const evidence = context.graph.evidence.recordBlobEvidence({
    ownerId: context.ownerId,
    deviceId: null,
    sourceEventId: `capture:${context.clock.nowUtc()}:${label}`,
    parentEvidenceId: null,
    sourceType: 'screenshot',
    sourceRef: 'app:code',
    capturedAtUtc: context.clock.nowUtc(),
    sourceTimezone: null,
    sensitivity: 'sensitive',
    retentionUntilUtc: null,
    metadata: { foregroundContextKey: 'app:code' },
    mimeType: 'image/png',
    bytes,
  });
  queue.enqueue({
    ownerId: context.ownerId,
    evidenceId: evidence.id,
    state,
    foregroundContextKey: 'app:code',
    pixelSha256: String(label).repeat(64).slice(0, 64),
    perceptualHash: `${String(label)}0e1d2c3b4a59687`.slice(0, 16),
    byteLength,
  });
  return evidence.id;
}

function auditEventCount(context: AssistantTestContext, eventType: string): number {
  return auditDetails(context, eventType).length;
}

/** Raw `details_json` of every audit event of the given type. */
function auditDetails(context: AssistantTestContext, eventType: string): string[] {
  return context.graph.audit.listAuditEvents(context.ownerId, 100)
    .filter((event) => event.event_type === eventType)
    .map((event) => event.details_json);
}

test('countInStates sums exactly the requested states in one query', () => {
  withAssistantContext((context) => {
    const { queue } = buildFixture(context, observationConfig());
    recordCapture(context, queue, 1, 'queued');
    recordCapture(context, queue, 2, 'awaiting_image_capability');
    recordCapture(context, queue, 3, 'awaiting_image_capability');
    recordCapture(context, queue, 4, 'processed');

    assert.equal(queue.countInStates(context.ownerId, ['queued', 'awaiting_image_capability']), 3);
    assert.equal(queue.countInStates(context.ownerId, ['processed']), 1);
    assert.equal(queue.countInStates(context.ownerId, ['expired']), 0);
    assert.equal(queue.countInStates('someone-else', ['queued']), 0, 'scoped to the owner');
  });
});

test('captures older than RawRetentionHours expire: blob gone, evidence and queue expired, audited', () => {
  withAssistantContext((context) => {
    const { queue, retention } = buildFixture(context, observationConfig());
    context.graph.audit.recordAuditEvent({
      ownerId: context.ownerId,
      eventType: 'capture_suppressed',
      targetType: 'desktop_capture',
      targetId: 'rule-1',
      summary: 'Capture suppressed by the desktop privacy preflight.',
      details: { ruleId: 'rule-1' },
    });
    const processedId = recordCapture(context, queue, 1, 'processed');
    context.clock.advanceSeconds(60);
    const queuedId = recordCapture(context, queue, 2, 'queued');
    context.clock.advanceDays(4);

    const summary = retention.run(context.ownerId, 'schedule');

    assert.equal(summary.expired, 2);
    assert.equal(summary.evicted, 0);
    for (const evidenceId of [processedId, queuedId]) {
      assert.equal(queue.require(evidenceId).state, 'expired');
      const evidence = context.graph.evidence.requireEvidence(evidenceId);
      assert.equal(evidence.status, 'expired');
      const blobId = evidence.blob_id ?? '';
      const blob = context.graph.evidence.requireBlob(blobId);
      assert.notEqual(blob.deleted_at_utc, null);
      assert.equal(
        fs.existsSync(context.graph.evidence.resolveBlobPath(blob.storage_uri)), false,
      );
    }
    const expiredDetails = auditDetails(context, 'capture_expired');
    assert.equal(expiredDetails.length, 2);
    for (const details of expiredDetails) {
      assert.match(details, /"reason":"schedule"/u, 'the audit records which pass removed it');
    }
    assert.equal(auditEventCount(context, 'capture_suppressed'), 1, 'suppression audits are untouched');

    const secondRun = retention.run(context.ownerId, 'schedule');
    assert.equal(secondRun.expired, 0, 'a retired row is never re-expired');
    assert.equal(auditEventCount(context, 'capture_expired'), 2);
  });
});

test('expiring the only supporting capture recalculates the dependent assertion to zero', () => {
  withAssistantContext((context) => {
    const { queue, retention } = buildFixture(context, observationConfig());
    const evidenceId = recordCapture(context, queue, 3, 'processed');
    const person = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'person', canonicalKey: 'person:self',
      displayName: 'Denys', description: null, sensitivity: 'personal', properties: {},
    });
    const editor = context.graph.nodes.createNode({
      ownerId: context.ownerId, type: 'software', canonicalKey: 'software:vscode',
      displayName: 'VS Code', description: null, sensitivity: 'low', properties: {},
    });
    const created = context.graph.assertionService.assert({
      ownerId: context.ownerId, actorType: 'system', actorRef: null,
      subjectNodeId: person.id, predicate: 'USES',
      object: { kind: 'node', nodeId: editor.id }, scopeNodeId: null,
      basis: 'passive_observation', sensitivity: 'personal',
      validFromUtc: null, validToUtc: null, observedAtUtc: context.clock.nowUtc(),
      topics: [], attributes: {},
      searchText: { subject: 'Denys', predicate: 'uses', object: 'VS Code', scope: '' },
      evidence: [{ evidenceId, stance: 'supports', weight: 0.6 }],
    });
    assert.equal(created.kind, 'created');
    if (created.kind !== 'created') return;
    assert.ok(context.graph.assertions.requireAssertion(created.assertionId).confidence > 0);

    context.clock.advanceDays(4);
    retention.run(context.ownerId, 'schedule');

    assert.equal(
      context.graph.assertions.requireAssertion(created.assertionId).confidence, 0,
      'an assertion whose only support expired holds no confidence',
    );
  });
});

test('capacity pressure evicts oldest first, including awaiting items, until under the cap', () => {
  withAssistantContext((context) => {
    const { queue, retention } = buildFixture(
      context, observationConfig({ RawStorageLimitGb: HUNDRED_BYTE_LIMIT_GB }),
    );
    const first = recordCapture(context, queue, 4, 'processed');
    context.clock.advanceSeconds(60);
    const second = recordCapture(context, queue, 5, 'awaiting_image_capability');
    context.clock.advanceSeconds(60);
    const third = recordCapture(context, queue, 6, 'queued');

    const summary = retention.run(context.ownerId, 'capacity');

    assert.equal(summary.expired, 0);
    assert.equal(summary.evicted, 2);
    assert.equal(queue.require(first).state, 'evicted');
    assert.equal(queue.require(second).state, 'evicted');
    assert.equal(queue.require(third).state, 'queued');
    assert.equal(context.graph.evidence.requireEvidence(first).status, 'expired');
    assert.equal(context.graph.evidence.requireEvidence(second).status, 'expired');
    assert.equal(context.graph.evidence.requireEvidence(third).status, 'active');
    const evictedDetails = auditDetails(context, 'capture_evicted');
    assert.equal(evictedDetails.length, 2, 'one audit event per eviction');
    for (const details of evictedDetails) {
      assert.match(details, /"reason":"capacity"/u, 'the audit records which pass removed it');
    }
  });
});

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
    imageDataUrl: `data:image/png;base64,${Buffer.alloc(64, 7).toString('base64')}`,
  };
}

function buildService(runtimeRoot: string, clock: FixedClock, observation: AssistantConfig['Observation']): AssistantService {
  const config = { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true, Observation: observation };
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock,
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference: new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: ALWAYS_IDLE,
    residencyGate: ALWAYS_RESIDENT,
    config,
  });
}

test('a drain enqueues a scheduled retention run that expires stale captures', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-capture-retention-');
  const clock = new FixedClock('2026-08-10T09:00:00.000Z');
  const service = buildService(runtimeRoot, clock, observationConfig());
  try {
    const outcome = service.ingestCapture(captureDto(clock.nowUtc(), '1'.repeat(64)));
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;
    assert.equal(outcome.state, 'awaiting_image_capability');

    clock.advanceDays(4);
    await service.drainJobs();

    const queue = new CaptureQueueStore(
      getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')), clock,
    );
    assert.equal(queue.require(outcome.evidenceId).state, 'expired');
    assert.equal(service.graph.evidence.requireEvidence(outcome.evidenceId).status, 'expired');
    const expired = service.graph.audit.listAuditEvents(service.ownerId, 100)
      .filter((event) => event.event_type === 'capture_expired');
    assert.equal(expired.length, 1);
    assert.match(
      expired[0]?.details_json ?? '', /"reason":"schedule"/u,
      'the drain-scheduled pass records its provenance',
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('an intake that pushes stored bytes over the cap enqueues a capacity retention run', async () => {
  const runtimeRoot = createManagedTempDir('siftkit-capture-capacity-');
  const clock = new FixedClock('2026-08-10T09:00:00.000Z');
  const service = buildService(
    runtimeRoot, clock,
    observationConfig({ RawStorageLimitGb: HUNDRED_BYTE_LIMIT_GB }),
  );
  try {
    const first = service.ingestCapture(captureDto(clock.nowUtc(), '1'.repeat(64)));
    assert.equal(first.kind, 'accepted');
    clock.advanceSeconds(60);
    const second = service.ingestCapture(
      captureDto(clock.nowUtc(), '2'.repeat(64), '0f1e2d3c4b5a6978'),
    );
    assert.equal(second.kind, 'accepted');
    if (first.kind !== 'accepted' || second.kind !== 'accepted') return;

    const queued = service.graph.jobs.listByStatus(service.ownerId, 'queued');
    const capacityJob = queued.find((job) => job.job_type === 'capture_retention');
    assert.notEqual(capacityJob, undefined, 'the over-cap intake enqueued a retention job');
    if (capacityJob === undefined) return;
    assert.deepEqual(
      service.graph.jobs.readCaptureRetentionPayload(capacityJob), { reason: 'capacity' },
    );

    await service.drainJobs();
    const queue = new CaptureQueueStore(
      getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')), clock,
    );
    assert.equal(queue.require(first.evidenceId).state, 'evicted');
    assert.equal(
      queue.require(second.evidenceId).state, 'awaiting_image_capability',
      'the newest capture survives',
    );
    const evicted = service.graph.audit.listAuditEvents(service.ownerId, 100)
      .filter((event) => event.event_type === 'capture_evicted');
    assert.equal(evicted.length, 1);
    assert.match(
      evicted[0]?.details_json ?? '', /"reason":"capacity"/u,
      'the capacity-triggered pass records its provenance',
    );
  } finally {
    closeRuntimeDatabase();
  }
});
