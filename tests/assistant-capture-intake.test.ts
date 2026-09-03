import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  CaptureSubmissionDtoSchema, type CaptureSubmissionDto, type SuppressionAuditDto,
} from '@siftkit/contracts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import type { AssistantConfig } from '../src/config/types.js';
import { CaptureIntake } from '../src/assistant/observation/capture-intake.js';
import { CaptureQueueStore } from '../src/assistant/images/capture-queue-store.js';
import { CandidateGate } from '../src/assistant/ingestion/candidate-gate.js';
import { CandidatePromoter } from '../src/assistant/ingestion/candidate-promoter.js';
import { SecretScanner } from '../src/assistant/domain/secrets.js';
import { AssertionViewBuilder } from '../src/assistant/projections/assertion-view-builder.js';
import { isProjectableInPlaintext } from '../src/assistant/projections/assertion-view.js';
import type {
  AssistantImageCapability, AssistantImageCapabilityProvider,
} from '../src/assistant/images/image-capability.js';
import type { EvidenceRow } from '../src/assistant/storage/rows.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.js';
import { startStatusServer } from '../src/status-server/index.js';
import { withAssistantContext, type AssistantTestContext } from './helpers/assistant-fixture.js';
import { closeHttpServer, getAddressInfo, requestJson } from './helpers/dashboard-http.js';
import {
  configureDashboardTestEnv, enterDashboardTestRepo, restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

const CAPTURED_AT = '2026-08-10T14:03:11.000Z';
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf'
  + 'FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BASE_HASH = 'f0e1d2c3b4a59687';
/** 4 flipped bits — 93.75 %, above the 92 % default threshold. */
const NEAR_HASH = 'f0e1d2c3b4a59688';
/** 5 flipped bits — 92.1875 %, exactly on the threshold boundary. */
const BOUNDARY_HASH = 'f0e1d2c3b4a59788';
/** 6 flipped bits — 90.625 %, below the threshold. */
const DISTINCT_HASH = 'f0e1d2c3b4a59798';

const ENABLED: AssistantConfig = {
  ...DEFAULT_ASSISTANT_CONFIG,
  Enabled: true,
  Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, ScreenshotsEnabled: true },
};

function sha(seed: number): string {
  return String(seed).padStart(64, '0');
}

function captureDto(overrides: {
  pixelSha256?: string;
  perceptualHash?: string;
  foregroundContextKey?: string;
  capturedAtUtc?: string;
} = {}): CaptureSubmissionDto {
  return {
    schemaVersion: 1,
    capturedAtUtc: overrides.capturedAtUtc ?? CAPTURED_AT,
    reason: 'fixed_cadence',
    display: {
      id: '\\\\.\\DISPLAY1',
      name: 'Generic PnP Monitor',
      primary: true,
      pixelWidth: 3840,
      pixelHeight: 2160,
      logicalWidth: 2560,
      logicalHeight: 1440,
      scaleFactor: 1.5,
    },
    foregroundContextKey: overrides.foregroundContextKey ?? 'app:code|siftkit',
    foreground: {
      processName: 'Code.exe',
      executablePath: 'C:/Program Files/Microsoft VS Code/Code.exe',
      applicationId: 'app:code',
      normalizedTitle: 'SiftKit - Visual Studio Code',
      fullscreen: false,
    },
    pixelSha256: overrides.pixelSha256 ?? sha(1),
    perceptualHash: overrides.perceptualHash ?? BASE_HASH,
    imageDataUrl: PNG_DATA_URL,
  };
}

function suppressionDto(): SuppressionAuditDto {
  return { schemaVersion: 1, occurredAtUtc: CAPTURED_AT, ruleId: 'title_deny_pattern' };
}

class StubImageCapability implements AssistantImageCapabilityProvider {
  constructor(private readonly capable: boolean) {}

  read(): AssistantImageCapability {
    return {
      instanceId: this.capable ? 'llama:1' : null,
      visionCapable: this.capable,
      healthy: this.capable,
    };
  }
}

interface IntakeFixture {
  readonly intake: CaptureIntake;
  readonly queue: CaptureQueueStore;
}

function buildIntake(context: AssistantTestContext, capable = false): IntakeFixture {
  const queue = new CaptureQueueStore(context.database, context.clock);
  return {
    queue,
    intake: new CaptureIntake({
      clock: context.clock,
      evidence: context.graph.evidence,
      audit: context.graph.audit,
      queue,
      capability: new StubImageCapability(capable),
      jobs: context.graph.jobs,
    }),
  };
}

function screenshotEvidence(context: AssistantTestContext): EvidenceRow[] {
  return context.graph.evidence.list(context.ownerId, 50, 0)
    .filter((row) => row.source_type === 'screenshot');
}

function auditTypes(context: AssistantTestContext): string[] {
  return context.graph.audit.listAuditEvents(context.ownerId, 50).map((row) => row.event_type);
}

test('a novel capture becomes encrypted screenshot evidence and an awaiting queue row', () => {
  withAssistantContext((context) => {
    const { intake, queue } = buildIntake(context);
    const outcome = intake.submit(context.ownerId, captureDto(), ENABLED);

    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;

    const evidence = screenshotEvidence(context);
    assert.equal(evidence.length, 1);
    const record = evidence[0];
    if (record === undefined) throw new Error('capture recorded no evidence');
    assert.equal(record.id, outcome.evidenceId);
    assert.equal(record.mime_type, 'image/png');
    assert.equal(record.sensitivity, 'personal');
    assert.equal(record.captured_at_utc, CAPTURED_AT);
    if (record.blob_id === null) throw new Error('capture evidence has no blob');
    assert.equal(context.graph.evidence.requireBlob(record.blob_id).encrypted, true);
    assert.ok(context.graph.evidence.readBlobBytes(record.blob_id).byteLength > 0);

    const row = queue.get(outcome.evidenceId);
    assert.equal(row?.state, 'awaiting_image_capability');
    assert.equal(row?.foreground_context_key, 'app:code|siftkit');
    assert.equal(row?.pixel_sha256, sha(1));
    assert.equal(row?.perceptual_hash, BASE_HASH);
    assert.equal(row?.processed_at_utc, null);
    assert.equal(outcome.state, 'awaiting_image_capability');
  });
});

test('a capable runtime queues the capture immediately', () => {
  withAssistantContext((context) => {
    const { intake, queue } = buildIntake(context, true);
    const outcome = intake.submit(context.ownerId, captureDto(), ENABLED);
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;
    assert.equal(queue.get(outcome.evidenceId)?.state, 'queued');
  });
});

test('the capture contract rejects a perceptual hash that is not 16 lowercase hex characters', () => {
  for (const perceptualHash of ['F0E1D2C3B4A59687', 'f0e1d2c3b4a5968', 'f0e1d2c3b4a5968z']) {
    assert.equal(
      CaptureSubmissionDtoSchema.safeParse({ ...captureDto(), perceptualHash }).success,
      false,
      `${perceptualHash} must not parse as a dHash`,
    );
  }
  assert.equal(CaptureSubmissionDtoSchema.safeParse(captureDto()).success, true);
});

test('an exact pixel hash match is discarded regardless of context', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    intake.submit(context.ownerId, captureDto(), ENABLED);
    const duplicate = intake.submit(context.ownerId, captureDto({
      perceptualHash: DISTINCT_HASH, foregroundContextKey: 'app:firefox|news',
    }), ENABLED);

    assert.equal(duplicate.kind, 'duplicate_discarded');
    assert.equal(screenshotEvidence(context).length, 1);
    assert.deepEqual(auditTypes(context), ['duplicate_discarded']);
  });
});

test('perceptual similarity at or above the threshold in the same context is skipped', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    intake.submit(context.ownerId, captureDto(), ENABLED);

    const near = intake.submit(
      context.ownerId, captureDto({ pixelSha256: sha(2), perceptualHash: NEAR_HASH }), ENABLED,
    );
    const boundary = intake.submit(
      context.ownerId, captureDto({ pixelSha256: sha(3), perceptualHash: BOUNDARY_HASH }), ENABLED,
    );

    assert.equal(near.kind, 'skipped_duplicate');
    assert.equal(boundary.kind, 'skipped_duplicate');
    assert.equal(screenshotEvidence(context).length, 1);
    assert.deepEqual(auditTypes(context), ['skipped_duplicate', 'skipped_duplicate']);
  });
});

test('the same perceptual hash in a different context is not a duplicate', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    intake.submit(context.ownerId, captureDto(), ENABLED);
    const other = intake.submit(context.ownerId, captureDto({
      pixelSha256: sha(2), foregroundContextKey: 'app:firefox|news',
    }), ENABLED);

    assert.equal(other.kind, 'accepted');
    assert.equal(screenshotEvidence(context).length, 2);
    assert.deepEqual(auditTypes(context), []);
  });
});

test('similarity below the threshold is accepted in the same context', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    intake.submit(context.ownerId, captureDto(), ENABLED);
    const distinct = intake.submit(
      context.ownerId, captureDto({ pixelSha256: sha(2), perceptualHash: DISTINCT_HASH }), ENABLED,
    );

    assert.equal(distinct.kind, 'accepted');
    assert.equal(screenshotEvidence(context).length, 2);
  });
});

test('captures outside the retention window no longer dedupe', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    intake.submit(context.ownerId, captureDto(), ENABLED);
    context.clock.advanceSeconds(ENABLED.Observation.RawRetentionHours * 3600 + 1);

    const later = intake.submit(context.ownerId, captureDto({
      perceptualHash: NEAR_HASH, capturedAtUtc: context.clock.nowUtc(),
    }), ENABLED);
    assert.equal(later.kind, 'accepted');
    assert.equal(screenshotEvidence(context).length, 2);
  });
});

test('capture is rejected while disabled, in private mode, or with screenshots off', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    const dto = captureDto();
    assert.throws(
      () => intake.submit(context.ownerId, dto, { ...ENABLED, Enabled: false }),
      /assistant is disabled/i,
    );
    assert.throws(
      () => intake.submit(context.ownerId, dto, {
        ...ENABLED, PrivateMode: { Active: true, ExpiresAtUtc: null },
      }),
      /private mode/i,
    );
    assert.throws(
      () => intake.submit(context.ownerId, dto, {
        ...ENABLED, Observation: { ...ENABLED.Observation, ScreenshotsEnabled: false },
      }),
      /screenshot capture is disabled/i,
    );

    assert.equal(screenshotEvidence(context).length, 0);
  });
});

test('a suppression report writes one non-content audit event and nothing else', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    intake.recordSuppression(context.ownerId, suppressionDto());

    const events = context.graph.audit.listAuditEvents(context.ownerId, 50);
    assert.equal(events.length, 1);
    const event = events[0];
    if (event === undefined) throw new Error('suppression recorded no audit event');
    assert.equal(event.event_type, 'capture_suppressed');
    assert.equal(event.target_id, 'title_deny_pattern');
    assert.deepEqual(parseJsonValueText(event.details_json), {
      ruleId: 'title_deny_pattern',
      occurredAtUtc: CAPTURED_AT,
    });
    assert.equal(screenshotEvidence(context).length, 0);
  });
});

test('the capture routes require the bearer, fail closed on version, and reject while disabled', async () => {
  const tempRoot = createManagedTempDir('siftkit-assistant-capture-route-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const initial = getDefaultConfig();
  const enabled = {
    ...initial.Assistant,
    Enabled: true,
    Observation: { ...initial.Assistant.Observation, ScreenshotsEnabled: true },
  };
  writeConfig(getConfigPath(), { ...initial, Assistant: enabled });
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;

  try {
    const body = JSON.stringify(captureDto());
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', body,
    })).statusCode, 401);

    const bootstrap = await requestJson(`${baseUrl}/assistant/auth/bootstrap`);
    const token = typeof bootstrap.body.token === 'string' ? bootstrap.body.token : '';
    const headers = { Authorization: `Bearer ${token}` };

    const accepted = await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', headers, body,
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.body.outcome, 'accepted');

    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', headers, body: JSON.stringify({ ...captureDto(), schemaVersion: 2 }),
    })).statusCode, 400);

    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/suppression`, {
      method: 'POST', headers, body: JSON.stringify(suppressionDto()),
    })).statusCode, 200);

    assert.equal((await requestJson(`${baseUrl}/assistant/config`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ assistant: { ...enabled, Enabled: false } }),
    })).statusCode, 200);
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/capture`, {
      method: 'POST', headers, body,
    })).statusCode, 409);
    assert.equal((await requestJson(`${baseUrl}/assistant/ingest/suppression`, {
      method: 'POST', headers, body: JSON.stringify(suppressionDto()),
    })).statusCode, 409);
  } finally {
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});

/**
 * Drives one screenshot statement all the way to an assertion, so the classification the intake
 * chose is the classification retrieval and the projections actually see.
 */
function promoteScreenshotStatement(
  context: AssistantTestContext, evidenceId: string, objectName: string, rationale: string,
): string {
  const { graph, ownerId } = context;
  const evidence = graph.evidence.requireEvidence(evidenceId);
  const observation = graph.observations.record({
    ownerId, evidenceId, observationType: 'screenshot_extraction',
    payload: {}, confidence: 0.7, sensitivity: evidence.sensitivity,
    extractorName: 'image_extraction', extractorVersion: '1',
  });
  const candidate = graph.candidates.propose({
    ownerId, observationId: observation.id,
    subject: { nodeType: 'person', displayName: 'the user' },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: objectName },
    scope: null, basis: 'passive_observation', confidence: 0.7,
    sensitivity: evidence.sensitivity, validFromUtc: null, validToUtc: null, rationale,
  });
  if (candidate === null) throw new Error('Screenshot statement was deduplicated unexpectedly.');
  const outcome = new CandidatePromoter(
    graph, new CandidateGate(graph.policies, new SecretScanner()),
  ).promote({ ownerId, candidateId: candidate.id });
  if (outcome.kind !== 'promoted') {
    throw new Error(`Screenshot statement was not promoted: ${JSON.stringify(outcome)}`);
  }
  return outcome.assertionId;
}

test('screenshot evidence is classified personal', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context);
    const outcome = intake.submit(context.ownerId, captureDto(), ENABLED);
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;

    assert.equal(
      context.graph.evidence.requireEvidence(outcome.evidenceId).sensitivity, 'personal',
    );
  });
});

test('a screenshot-derived assertion survives the plaintext projection filter', () => {
  withAssistantContext((context) => {
    const { intake } = buildIntake(context, true);
    const outcome = intake.submit(context.ownerId, captureDto(), ENABLED);
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;

    const assertionId = promoteScreenshotStatement(
      context, outcome.evidenceId, 'PowerShell', 'The screenshot shows a PowerShell window.',
    );
    const view = new AssertionViewBuilder(context.graph)
      .build(context.graph.assertions.requireAssertion(assertionId));

    assert.equal(view.sensitivity, 'personal');
    assert.equal(isProjectableInPlaintext(view), true);
  });
});

test('a screenshot statement containing secret material is still held back', () => {
  withAssistantContext((context) => {
    const { intake, queue } = buildIntake(context, true);
    const outcome = intake.submit(context.ownerId, captureDto(), ENABLED);
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;
    assert.equal(queue.get(outcome.evidenceId)?.state, 'queued');

    const { graph, ownerId } = context;
    const observation = graph.observations.record({
      ownerId, evidenceId: outcome.evidenceId, observationType: 'screenshot_extraction',
      payload: {}, confidence: 0.7, sensitivity: 'personal',
      extractorName: 'image_extraction', extractorVersion: '1',
    });
    const candidate = graph.candidates.propose({
      ownerId, observationId: observation.id,
      subject: { nodeType: 'person', displayName: 'the user' },
      predicate: 'USES',
      object: { kind: 'unresolved', nodeType: 'software', displayName: 'Medication Tracker' },
      scope: null, basis: 'passive_observation', confidence: 0.7, sensitivity: 'personal',
      validFromUtc: null, validToUtc: null,
      rationale: 'The screenshot showed a medication tracking app.',
    });
    if (candidate === null) throw new Error('Screenshot statement was deduplicated unexpectedly.');
    const promotion = new CandidatePromoter(
      graph, new CandidateGate(graph.policies, new SecretScanner()),
    ).promote({ ownerId, candidateId: candidate.id });

    assert.equal(promotion.kind === 'needs_confirmation' ? promotion.hold.kind : null, 'topic');
    assert.equal(graph.candidates.requireCandidate(candidate.id).status, 'needs_confirmation');
    assert.equal(graph.assertions.list(ownerId, 100, 0).length, 0);
  });
});
