import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import type { MobileEnvelope } from '@siftkit/contracts';
import { z } from '../src/lib/zod.js';
import { AssistantService } from '../src/assistant/assistant-service.js';
import { FixedClock } from '../src/assistant/clock.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { EnvelopeVerifier, signingPayload } from '../src/assistant/mobile/envelope-verifier.js';
import type { DeviceStore } from '../src/assistant/storage/device-store.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import {
  FIXTURE_START_INSTANT, MemoryAssistantConfigWriter, withAssistantContext,
  type AssistantTestContext,
} from './helpers/assistant-fixture.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const DEVICE_ID = 'dev_test';

class AlwaysIdle {
  isIdle(): boolean {
    return true;
  }
}

type UnsignedEnvelope = Omit<MobileEnvelope, 'signature'>;

const keys = generateKeyPairSync('ed25519');

function publicKeyBase64(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64');
}

function unsigned(overrides: Partial<UnsignedEnvelope> = {}): UnsignedEnvelope {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    monotonicTimestamp: 1_000,
    nonce: 'nonce-0001',
    consent: { memory: true, sensitive: false },
    sensitivity: 'personal',
    payload: { kind: 'text', text: 'the user prefers dark mode' },
    ...overrides,
  };
}

function signed(envelope: UnsignedEnvelope, privateKey: KeyObject = keys.privateKey): MobileEnvelope {
  const signature = cryptoSign(null, Buffer.from(signingPayload(envelope), 'utf8'), privateKey);
  return { ...envelope, signature: signature.toString('base64') };
}

/** Inserts the device the envelopes are signed for, in whatever state the case needs. */
function seedDevice(
  devices: DeviceStore,
  ownerId: string,
  overrides: { publicKeyBase64?: string | null; status?: 'active' | 'revoked' } = {},
): void {
  devices.insertDevice({
    id: DEVICE_ID,
    ownerId,
    platform: 'android',
    displayName: 'Test Phone',
    publicKeyBase64: overrides.publicKeyBase64 === undefined
      ? publicKeyBase64(keys.publicKey)
      : overrides.publicKeyBase64,
    status: overrides.status ?? 'active',
  });
}

function verifierFor(context: AssistantTestContext): EnvelopeVerifier {
  return new EnvelopeVerifier(context.graph.devices);
}

test('an envelope from a device the graph has never seen is rejected', () => {
  withAssistantContext((context) => {
    assert.deepEqual(
      verifierFor(context).verify(signed(unsigned())),
      { kind: 'rejected', reason: 'unknown_device' },
    );
  });
});

test('a revoked device is rejected before its signature is even considered', () => {
  withAssistantContext((context) => {
    seedDevice(context.graph.devices, context.ownerId, { status: 'revoked' });
    assert.deepEqual(
      verifierFor(context).verify(signed(unsigned())),
      { kind: 'rejected', reason: 'revoked_device' },
    );
  });
});

test('a device with no enrolled public key cannot be verified', () => {
  withAssistantContext((context) => {
    seedDevice(context.graph.devices, context.ownerId, { publicKeyBase64: null });
    assert.deepEqual(
      verifierFor(context).verify(signed(unsigned())),
      { kind: 'rejected', reason: 'missing_public_key' },
    );
  });
});

test('mutating the payload after signing invalidates the envelope', () => {
  withAssistantContext((context) => {
    seedDevice(context.graph.devices, context.ownerId);
    const envelope = signed(unsigned());
    const tampered: MobileEnvelope = {
      ...envelope,
      payload: { kind: 'text', text: 'the user prefers light mode' },
    };
    assert.deepEqual(
      verifierFor(context).verify(tampered),
      { kind: 'rejected', reason: 'bad_signature' },
    );
  });
});

test('a timestamp that does not advance past the last accepted one is stale', () => {
  withAssistantContext((context) => {
    seedDevice(context.graph.devices, context.ownerId);
    const verifier = verifierFor(context);
    assert.deepEqual(verifier.verify(signed(unsigned())), { kind: 'accepted' });
    // Same instant, different nonce: replay protection must not depend on the nonce alone.
    assert.deepEqual(
      verifier.verify(signed(unsigned({ nonce: 'nonce-0002' }))),
      { kind: 'rejected', reason: 'stale_timestamp' },
    );
  });
});

test('a nonce is single-use even when the timestamp advances', () => {
  withAssistantContext((context) => {
    seedDevice(context.graph.devices, context.ownerId);
    const verifier = verifierFor(context);
    assert.deepEqual(verifier.verify(signed(unsigned())), { kind: 'accepted' });
    assert.deepEqual(
      verifier.verify(signed(unsigned({ monotonicTimestamp: 2_000 }))),
      { kind: 'rejected', reason: 'replayed_nonce' },
    );
  });
});

test('an accepted envelope records its nonce and advances the device high-water mark', () => {
  withAssistantContext((context) => {
    seedDevice(context.graph.devices, context.ownerId);
    assert.equal(context.graph.devices.maxMonotonicTimestamp(DEVICE_ID), 0);

    assert.deepEqual(verifierFor(context).verify(signed(unsigned())), { kind: 'accepted' });

    assert.equal(context.graph.devices.maxMonotonicTimestamp(DEVICE_ID), 1_000);
    const rows = z.array(z.object({ nonce: z.string(), monotonic_ts: z.number() })).parse(
      context.database
        .prepare('SELECT nonce, monotonic_ts FROM assistant_device_nonces WHERE device_id = ?')
        .all(DEVICE_ID),
    );
    assert.deepEqual(rows, [{ nonce: 'nonce-0001', monotonic_ts: 1_000 }]);
  });
});

/** A full service, for the two cases that need the ingestion pipeline behind the verifier. */
function buildService(): AssistantService {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-mobile-');
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock: new FixedClock(FIXTURE_START_INSTANT),
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(),
    inference: new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
    config: { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true },
  });
}

test('a rejection is audited by reason alone, never by payload', () => {
  try {
    const service = buildService();
    assert.deepEqual(
      service.ingestMobileEnvelope(signed(unsigned())),
      { kind: 'rejected', reason: 'unknown_device' },
    );

    const events = service.graph.audit.listAuditEvents(service.ownerId, 10)
      .filter((event) => event.event_type === 'mobile_envelope_rejected');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.target_id, DEVICE_ID);
    const details = z.object({ reason: z.string(), deviceId: z.string() })
      .parse(JSON.parse(events[0]?.details_json ?? ''));
    assert.deepEqual(details, { reason: 'unknown_device', deviceId: DEVICE_ID });
    // The audit trail must not leak what the phone said.
    assert.ok(!(events[0]?.details_json ?? '').includes('dark mode'));
  } finally {
    closeRuntimeDatabase();
  }
});

test('an accepted envelope becomes ordinary mobile_event evidence at its declared sensitivity', () => {
  try {
    const service = buildService();
    seedDevice(service.graph.devices, service.ownerId);
    assert.deepEqual(
      service.ingestMobileEnvelope(signed(unsigned({ sensitivity: 'highly_sensitive' }))),
      { kind: 'accepted' },
    );

    const evidence = service.graph.evidence.findBySourceEventId(
      service.ownerId, `mobile:${DEVICE_ID}:nonce-0001`,
    );
    assert.ok(evidence !== null);
    assert.equal(evidence.source_type, 'mobile_event');
    assert.equal(evidence.device_id, DEVICE_ID);
    // The phone's own classification is a floor; the pipeline may raise it but never lowers it.
    assert.equal(evidence.sensitivity, 'highly_sensitive');
  } finally {
    closeRuntimeDatabase();
  }
});
