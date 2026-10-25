import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { z } from '../src/lib/zod.ts';
import { VaultAttachments, vaultAttachmentsDir } from '../src/vault/attachments.ts';
import { VaultCaptureIntake } from '../src/vault/capture-intake.ts';
import { VaultCaptureRowSchema } from '../src/vault/captures.ts';
import { requireVaultNote } from '../src/vault/note-rows.ts';
import {
  DISTINCT_HASH, NEAR_HASH, SCREENSHOTS_ENABLED, StubImageCapability, vaultCaptureDto,
} from './helpers/vault-capture-fixture.ts';
import { withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

// Note titles and folders use local time; a zone west of UTC makes the day differ.
process.env.TZ = 'America/Toronto';

function intake(context: VaultTestContext, capable = true) {
  const ids = new SequentialIdGenerator();
  const audit = new AuditStore(context.database, context.clock, ids);
  const attachments = new VaultAttachments(context.database, context.clock, ids, context.runtimeRoot);
  const capture = new VaultCaptureIntake({
    database: context.database, store: context.store, attachments, audit, clock: context.clock, capability: new StubImageCapability(capable),
  });
  const captureRows = () => z.array(VaultCaptureRowSchema).parse(context.database.prepare('SELECT * FROM vault_captures ORDER BY captured_at_utc').all());
  const title = (outcome: ReturnType<typeof capture.submit>) => (outcome.kind === 'accepted' ? requireVaultNote(context.database, outcome.noteId).title : outcome.kind);
  return { capture, audit, attachments, captureRows, title };
}

test('an accepted capture writes the PNG, a pending capture note in local time and a vault_captures row', () => {
  withVault((context) => {
    const { capture, attachments, captureRows } = intake(context);
    const outcome = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({ capturedAtUtc: '2026-10-24T03:30:05.000Z' }), SCREENSHOTS_ENABLED);
    assert.equal(outcome.kind, 'accepted');
    if (outcome.kind !== 'accepted') return;
    assert.equal(outcome.state, 'queued');
    const attachment = attachments.require(outcome.attachmentId);
    assert.equal(attachment.relativePath, `captures/${outcome.attachmentId}.png`);
    assert.equal(attachment.noteId, outcome.noteId);
    assert.ok(fs.existsSync(path.join(vaultAttachmentsDir(context.runtimeRoot), attachment.relativePath)));

    const note = requireVaultNote(context.database, outcome.noteId);
    assert.deepEqual([note.title, note.folder, note.kind], ['2026-10-23 23.30.05 · Visual Studio Code', 'Captures/2026-10-23', 'capture']);
    assert.equal(note.body, [
      `![[attachments/captures/${outcome.attachmentId}.png]]`,
      '',
      '[[Visual Studio Code]] · `SiftKit - Visual Studio Code` · window change',
      '',
      '> [!pending]- Waiting for the note-writer',
    ].join('\n'));
    const revision = context.store.listRevisions(note.id)[0];
    assert.deepEqual([revision?.actor, revision?.sourceRef], ['capture-intake', outcome.attachmentId]);

    assert.deepEqual(captureRows(), [{
      attachment_id: outcome.attachmentId, note_id: note.id, state: 'queued', foreground_context_key: 'app:code|siftkit',
      pixel_sha256: '1'.padStart(64, '0'), perceptual_hash: 'f0e1d2c3b4a59687',
      app: 'Visual Studio Code', window_title: 'SiftKit - Visual Studio Code', captured_at_utc: '2026-10-24T03:30:05.000Z', processed_at_utc: null,
    }]);
  });
});

test('without a vision runtime the capture waits for image capability', () => {
  withVault((context) => {
    const { capture, captureRows } = intake(context, false);
    const outcome = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto(), SCREENSHOTS_ENABLED);
    assert.deepEqual([outcome.kind, captureRows()[0]?.state], ['accepted', 'awaiting_image_capability']);
  });
});

test('identical pixels are discarded and near-identical frames of the same context are skipped, both audited', () => {
  withVault((context) => {
    const { capture, audit, captureRows } = intake(context);
    capture.submit(LOCAL_OWNER_ID, vaultCaptureDto(), SCREENSHOTS_ENABLED);
    const exact = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({ capturedAtUtc: '2026-10-24T08:59:40.000Z', perceptualHash: DISTINCT_HASH }), SCREENSHOTS_ENABLED);
    const near = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({
      capturedAtUtc: '2026-10-24T08:59:50.000Z', pixelSha256: '2'.padStart(64, '0'), perceptualHash: NEAR_HASH,
    }), SCREENSHOTS_ENABLED);
    const otherContext = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({
      capturedAtUtc: '2026-10-24T08:59:55.000Z', pixelSha256: '3'.padStart(64, '0'), perceptualHash: NEAR_HASH, foregroundContextKey: 'app:chrome|mail',
    }), SCREENSHOTS_ENABLED);
    const distinct = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({
      capturedAtUtc: '2026-10-24T08:59:58.000Z', pixelSha256: '4'.padStart(64, '0'), perceptualHash: DISTINCT_HASH,
    }), SCREENSHOTS_ENABLED);
    assert.deepEqual([exact.kind, near.kind, otherContext.kind, distinct.kind], ['duplicate_discarded', 'skipped_duplicate', 'accepted', 'accepted']);
    assert.equal(captureRows().length, 3);
    assert.deepEqual(audit.listAuditEvents(LOCAL_OWNER_ID, 10).map((event) => event.event_type).sort(), ['duplicate_discarded', 'skipped_duplicate']);
  });
});

test('duplicates only count inside the raw retention window', () => {
  withVault((context) => {
    const { capture } = intake(context);
    capture.submit(LOCAL_OWNER_ID, vaultCaptureDto(), SCREENSHOTS_ENABLED);
    context.clock.advanceSeconds(SCREENSHOTS_ENABLED.Observation.RawRetentionHours * 3600 + 60);
    assert.equal(capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({ capturedAtUtc: context.clock.nowUtc() }), SCREENSHOTS_ENABLED).kind, 'accepted');
  });
});

test('the app falls back to the process name, then Desktop, and unsafe title characters are dropped', () => {
  withVault((context) => {
    const { capture, title } = intake(context);
    const first = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({ title: 'Downloads', processName: 'explorer.exe' }), SCREENSHOTS_ENABLED);
    const second = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({
      title: 'notes `draft` - Editor: Pro', pixelSha256: '2'.padStart(64, '0'), perceptualHash: DISTINCT_HASH, foregroundContextKey: 'app:other',
    }), SCREENSHOTS_ENABLED);
    const third = capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({
      title: null, processName: null, pixelSha256: '3'.padStart(64, '0'), foregroundContextKey: 'app:none', reason: 'manual',
    }), SCREENSHOTS_ENABLED);
    assert.deepEqual([first, second, third].map(title), [
      '2026-10-24 04.59.30 · explorer', '2026-10-24 04.59.30 · Editor Pro', '2026-10-24 04.59.30 · Desktop',
    ]);
    const contextLine = (outcome: typeof first) => (outcome.kind === 'accepted' ? requireVaultNote(context.database, outcome.noteId).body.split('\n')[2] : '');
    assert.deepEqual([second, third].map(contextLine), ["[[Editor Pro]] · `notes 'draft' - Editor: Pro` · window change", '[[Desktop]] · manual']);
  });
});

test('a second capture in the same second and app gets a numbered title', () => {
  withVault((context) => {
    const { capture, title } = intake(context);
    const outcomes = ['1', '2'].map((seed, index) => capture.submit(LOCAL_OWNER_ID, vaultCaptureDto({
      pixelSha256: seed.padStart(64, '0'), perceptualHash: index === 0 ? NEAR_HASH : DISTINCT_HASH, foregroundContextKey: `ctx${seed}`,
    }), SCREENSHOTS_ENABLED));
    assert.deepEqual(outcomes.map(title), ['2026-10-24 04.59.30 · Visual Studio Code', '2026-10-24 04.59.30 · Visual Studio Code 2']);
  });
});

test('screenshots disabled, assistant disabled and private mode all refuse the capture', () => {
  withVault((context) => {
    const { capture, captureRows } = intake(context);
    const disabled = { ...SCREENSHOTS_ENABLED, Observation: { ...SCREENSHOTS_ENABLED.Observation, ScreenshotsEnabled: false } };
    assert.throws(() => capture.submit(LOCAL_OWNER_ID, vaultCaptureDto(), disabled), /Screenshot capture is disabled/);
    assert.throws(() => capture.submit(LOCAL_OWNER_ID, vaultCaptureDto(), { ...SCREENSHOTS_ENABLED, Enabled: false }), /Assistant is disabled/);
    const privateMode = { ...SCREENSHOTS_ENABLED, PrivateMode: { ...SCREENSHOTS_ENABLED.PrivateMode, Active: true } };
    assert.throws(() => capture.submit(LOCAL_OWNER_ID, vaultCaptureDto(), privateMode), /Private mode/);
    assert.equal(captureRows().length, 0);
  });
});

test('a capture whose rows fail to write leaves no orphaned PNG behind', () => {
  withVault((context) => {
    const { capture, captureRows } = intake(context);
    context.database.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON vault_captures BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    assert.throws(() => capture.submit(LOCAL_OWNER_ID, vaultCaptureDto(), SCREENSHOTS_ENABLED), /disk full/);
    assert.equal(captureRows().length, 0);
    const dir = path.join(vaultAttachmentsDir(context.runtimeRoot), 'captures');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });
});
