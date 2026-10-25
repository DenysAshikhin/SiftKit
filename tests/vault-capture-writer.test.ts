import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { SecretScanner } from '../src/assistant/domain/secrets.ts';
import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import type { AssistantImageCapability, AssistantImageCapabilityProvider } from '../src/assistant/images/image-capability.ts';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { VaultAttachments, vaultAttachmentsDir } from '../src/vault/attachments.ts';
import { VaultCaptureIntake } from '../src/vault/capture-intake.ts';
import { requireCapture } from '../src/vault/captures.ts';
import { requireVaultNote } from '../src/vault/note-rows.ts';
import { VaultCaptureWriter } from '../src/vault/note-writer/capture-writer.ts';
import { VaultEditApplier } from '../src/vault/note-writer/edit-applier.ts';
import { findOwnerNote } from '../src/vault/owner-identity.ts';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.ts';
import { PNG_DATA_URL, SCREENSHOTS_ENABLED, StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';
import { TEST_META, entityInput, withVaultAsync, type VaultTestContext } from './helpers/vault-fixture.ts';

process.env.TZ = 'UTC';

/** Reports a different runtime instance on every read, as if the model reloaded mid-job. */
class ReloadingCapability implements AssistantImageCapabilityProvider {
  private reads = 0;

  read(): AssistantImageCapability {
    this.reads += 1;
    return { instanceId: `inference:${this.reads}`, visionCapable: true, healthy: true };
  }
}

function setup(context: VaultTestContext, responses: readonly string[], capability: AssistantImageCapabilityProvider = new StubImageCapability(true)) {
  const ids = new SequentialIdGenerator();
  const audit = new AuditStore(context.database, context.clock, ids);
  const attachments = new VaultAttachments(context.database, context.clock, ids, context.runtimeRoot);
  const intake = new VaultCaptureIntake({
    database: context.database, store: context.store, attachments, audit, clock: context.clock, capability: new StubImageCapability(true),
  });
  const outcome = intake.submit(LOCAL_OWNER_ID, vaultCaptureDto(), SCREENSHOTS_ENABLED);
  if (outcome.kind !== 'accepted') throw new Error('fixture capture was not accepted');
  const inference = new FakeAssistantInference(responses);
  const applier = new VaultEditApplier({ store: context.store, database: context.database, audit, scanner: new SecretScanner(), ownerDisplayName: 'Denys' });
  const writer = new VaultCaptureWriter({
    database: context.database, store: context.store, attachments, applier, audit, scanner: new SecretScanner(), clock: context.clock,
    runner: new StructuredOutputRunner(inference), capability,
  });
  const run = () => writer.run(LOCAL_OWNER_ID, outcome.attachmentId, null);
  const note = () => requireVaultNote(context.database, outcome.noteId);
  return { run, note, inference, audit, attachments, attachmentId: outcome.attachmentId };
}

const CAPTURED_AT = vaultCaptureDto().capturedAtUtc;
const EMBED_AND_CONTEXT = (attachmentId: string) => [
  `![[attachments/captures/${attachmentId}.png]]`, '', '[[Visual Studio Code]] · `SiftKit - Visual Studio Code` · window change', '',
];

test('the writer sends the screenshot with entity candidates and replaces the pending callout with ## Learned', async () => {
  await withVaultAsync(async (context) => {
    context.store.create(entityInput('Visual Studio Code', 'Editor.'), TEST_META);
    context.store.create(entityInput('SiftKit', 'A local assistant project.', { folder: 'Projects', types: ['project'] }), TEST_META);
    context.store.create(entityInput('Discord', 'Chat app.'), TEST_META);
    const response = JSON.stringify({ operations: [
      { op: 'add_facts', note: 'the user', label: 'Works on', values: ['SiftKit'] },
      { op: 'learned', note: 'SiftKit', label: 'Open in', value: 'Visual Studio Code' },
    ] });
    const { run, note, inference, attachmentId } = setup(context, [response]);

    const outcome = await run();
    assert.equal(outcome.kind === 'processed' ? outcome.capturedAtUtc : null, CAPTURED_AT, 'the runner keys follow-ups by the capture time');
    const request = inference.requests[0];
    assert.equal(request?.role, 'vault_capture_writer');
    assert.equal(request?.kind, 'image');
    assert.deepEqual(request?.kind === 'image' ? request.images : [], [PNG_DATA_URL]);
    assert.match(request?.userText ?? '', /App: Visual Studio Code\nWindow title: SiftKit - Visual Studio Code\nKnown notes:\n/);
    assert.match(request?.userText ?? '', /- Visual Studio Code\n/);
    assert.match(request?.userText ?? '', /- SiftKit/);
    assert.doesNotMatch(request?.userText ?? '', /Discord|08\.59/, 'only matching entity notes are candidates');

    assert.equal(note().body, [...EMBED_AND_CONTEXT(attachmentId), '## Learned', '- [[SiftKit]]: **Open in** Visual Studio Code'].join('\n'));
    assert.equal(context.store.listRevisions(note().id)[0]?.actor, 'note-writer · screenshot');
    assert.match(findOwnerNote(context.database)?.body ?? '', /\*\*Works on\*\* \[\[SiftKit\]\]/);
    const capture = requireCapture(context.database, attachmentId);
    assert.deepEqual([capture.state, capture.processed_at_utc], ['processed', context.clock.nowUtc()]);

    assert.deepEqual(await run(), { kind: 'already_processed' });
    assert.equal(inference.requests.length, 1);
  });
});

test('without image capability the capture waits and no model is called', async () => {
  await withVaultAsync(async (context) => {
    const { run, inference, attachmentId } = setup(context, [], new StubImageCapability(false));
    assert.deepEqual(await run(), { kind: 'awaiting_capability' });
    assert.equal(requireCapture(context.database, attachmentId).state, 'awaiting_image_capability');
    assert.equal(inference.requests.length, 0);
  });
});

test('a runtime that changed between admission and dispatch sends the capture back to wait', async () => {
  await withVaultAsync(async (context) => {
    const { run, inference, attachmentId } = setup(context, [], new ReloadingCapability());
    assert.deepEqual(await run(), { kind: 'awaiting_capability' });
    assert.equal(requireCapture(context.database, attachmentId).state, 'awaiting_image_capability');
    assert.equal(inference.requests.length, 0);
  });
});

test('unusable model output is audited and still leaves an empty ## Learned', async () => {
  await withVaultAsync(async (context) => {
    const { run, note, inference, audit, attachmentId } = setup(context, ['not json', 'my token is ghp_abcdefghijklmnopqrstuvwxyz0123']);
    assert.deepEqual(await run(), { kind: 'rejected', reason: 'invalid_output', capturedAtUtc: CAPTURED_AT });
    assert.equal(inference.requests.length, 2, 'one repair retry');
    assert.equal(note().body, [...EMBED_AND_CONTEXT(attachmentId), '## Learned'].join('\n'));
    assert.equal(requireCapture(context.database, attachmentId).state, 'processed');
    const events = audit.listAuditEvents(LOCAL_OWNER_ID, 5);
    assert.deepEqual(events.map((event) => [event.event_type, event.target_id]), [['vault_writer_rejected', attachmentId]]);
    assert.doesNotMatch(JSON.stringify(events), /ghp_/, 'a raw sample holding a secret is never audited');
  });
});

test('a screenshot whose file is already gone is terminal: no model call, empty ## Learned, image_removed', async () => {
  await withVaultAsync(async (context) => {
    const { run, note, inference, attachments, attachmentId } = setup(context, []);
    fs.rmSync(path.join(vaultAttachmentsDir(context.runtimeRoot), attachments.require(attachmentId).relativePath));
    assert.deepEqual(await run(), { kind: 'rejected', reason: 'image_missing', capturedAtUtc: CAPTURED_AT });
    assert.equal(inference.requests.length, 0);
    assert.equal(note().body, [...EMBED_AND_CONTEXT(attachmentId), '## Learned'].join('\n'));
    assert.equal(requireCapture(context.database, attachmentId).state, 'image_removed');
  });
});
