import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { VaultAttachments, vaultAttachmentsDir } from '../src/vault/attachments.ts';
import { VaultCaptureIntake } from '../src/vault/capture-intake.ts';
import { VaultCaptureRetention } from '../src/vault/capture-retention.ts';
import { requireCapture } from '../src/vault/captures.ts';
import { readVaultNote } from '../src/vault/note-rows.ts';
import { DISTINCT_HASH, NEAR_HASH, SCREENSHOTS_ENABLED, StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';
import { withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

function setup(context: VaultTestContext) {
  const ids = new SequentialIdGenerator();
  const audit = new AuditStore(context.database, context.clock, ids);
  const attachments = new VaultAttachments(context.database, context.clock, ids, context.runtimeRoot);
  const intake = new VaultCaptureIntake({ database: context.database, store: context.store, attachments, audit, clock: context.clock, capability: new StubImageCapability(true) });
  const captures = ['2026-10-20T09:00:00.000Z', '2026-10-22T09:00:00.000Z', '2026-10-24T08:00:00.000Z'].map((capturedAtUtc, index) => {
    const outcome = intake.submit(LOCAL_OWNER_ID, vaultCaptureDto({
      capturedAtUtc, pixelSha256: String(index + 1).padStart(64, '0'), perceptualHash: index % 2 === 0 ? NEAR_HASH : DISTINCT_HASH, foregroundContextKey: `ctx${index}`,
    }), { ...SCREENSHOTS_ENABLED, Observation: { ...SCREENSHOTS_ENABLED.Observation, RawRetentionHours: 1 } });
    if (outcome.kind !== 'accepted') throw new Error('fixture capture was not accepted');
    return outcome;
  });
  const fileExists = (attachmentId: string) => fs.existsSync(path.join(vaultAttachmentsDir(context.runtimeRoot), attachments.require(attachmentId).relativePath));
  const retention = new VaultCaptureRetention({ database: context.database, attachments, audit, clock: context.clock });
  const byteLength = attachments.require(captures[0]?.attachmentId ?? '').byteLength;
  return { captures, fileExists, retention, audit, byteLength };
}

test('the size cap evicts the oldest PNGs and keeps their notes and rows', () => {
  withVault((context) => {
    const { captures, fileExists, retention, audit, byteLength } = setup(context);
    assert.deepEqual(retention.run(LOCAL_OWNER_ID, { limitBytes: byteLength * 2, maxAgeDays: null }), { expired: 0, evicted: 1 });
    assert.deepEqual(captures.map((capture) => fileExists(capture.attachmentId)), [false, true, true]);
    assert.deepEqual(captures.map((capture) => requireCapture(context.database, capture.attachmentId).state), ['image_removed', 'queued', 'queued']);
    assert.ok(captures.every((capture) => readVaultNote(context.database, capture.noteId) !== null), 'notes stay');
    const events = audit.listAuditEvents(LOCAL_OWNER_ID, 5);
    assert.deepEqual(events.map((event) => [event.event_type, event.target_id]), [['capture_evicted', captures[0]?.attachmentId]]);

    assert.deepEqual(retention.run(LOCAL_OWNER_ID, { limitBytes: byteLength * 2, maxAgeDays: null }), { expired: 0, evicted: 0 }, 'removed images no longer count');
  });
});

test('the age limit expires PNGs older than maxAgeDays; null means no age limit', () => {
  withVault((context) => {
    const { captures, fileExists, retention, audit } = setup(context);
    assert.deepEqual(retention.run(LOCAL_OWNER_ID, { limitBytes: Number.MAX_SAFE_INTEGER, maxAgeDays: null }), { expired: 0, evicted: 0 });
    assert.deepEqual(retention.run(LOCAL_OWNER_ID, { limitBytes: Number.MAX_SAFE_INTEGER, maxAgeDays: 3 }), { expired: 1, evicted: 0 });
    assert.deepEqual(captures.map((capture) => fileExists(capture.attachmentId)), [false, true, true]);
    assert.deepEqual(audit.listAuditEvents(LOCAL_OWNER_ID, 5).map((event) => event.event_type), ['capture_expired']);
  });
});

test('expiry runs before eviction and both count separately', () => {
  withVault((context) => {
    const { captures, fileExists, retention, byteLength } = setup(context);
    assert.deepEqual(retention.run(LOCAL_OWNER_ID, { limitBytes: byteLength, maxAgeDays: 3 }), { expired: 1, evicted: 1 });
    assert.deepEqual(captures.map((capture) => fileExists(capture.attachmentId)), [false, false, true]);
  });
});
