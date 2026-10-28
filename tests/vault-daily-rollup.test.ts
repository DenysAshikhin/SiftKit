import test from 'node:test';
import assert from 'node:assert/strict';

import { removeCallouts, replaceSection } from '@siftkit/contracts';
import { SecretScanner } from '../src/assistant/domain/secrets.ts';
import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { VaultAttachments } from '../src/vault/attachments.ts';
import { VaultCaptureIntake } from '../src/vault/capture-intake.ts';
import { requireVaultNote } from '../src/vault/note-rows.ts';
import { VaultNoteWriter } from '../src/vault/note-writer/agent/note-writer.ts';
import { VaultDailyRollup } from '../src/vault/note-writer/daily-rollup.ts';
import { VaultEditApplier } from '../src/vault/note-writer/edit-applier.ts';
import type { JsonObject } from '../src/lib/json-types.ts';
import { VaultValidationQueue } from '../src/vault/validation-queue.ts';
import { ScriptedAgentInference, submitTurn } from './helpers/assistant-inference-fake.ts';
import { DISTINCT_HASH, NEAR_HASH, SCREENSHOTS_ENABLED, StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';
import { TEST_META, entityInput, withVaultAsync, type VaultTestContext } from './helpers/vault-fixture.ts';

process.env.TZ = 'UTC';

function setup(context: VaultTestContext) {
  const ids = new SequentialIdGenerator();
  const audit = new AuditStore(context.database, context.clock, ids);
  const attachments = new VaultAttachments(context.database, context.clock, ids, context.runtimeRoot);
  const intake = new VaultCaptureIntake({
    database: context.database, store: context.store, attachments, audit, clock: context.clock, capability: new StubImageCapability(true),
  });
  const capture = (capturedAtUtc: string, seed: string, perceptualHash: string) => {
    const outcome = intake.submit(LOCAL_OWNER_ID, vaultCaptureDto({ capturedAtUtc, pixelSha256: seed.padStart(64, '0'), perceptualHash, foregroundContextKey: seed }), SCREENSHOTS_ENABLED);
    if (outcome.kind !== 'accepted') throw new Error('fixture capture was not accepted');
    return outcome;
  };
  const learn = (noteId: string, lines: readonly string[]) => {
    const note = requireVaultNote(context.database, noteId);
    context.store.update(noteId, { body: replaceSection(removeCallouts(note.body, 'pending'), 'Learned', lines) }, note.revision, TEST_META);
  };
  const chat = async (operations: readonly JsonObject[]) => {
    const writer = new VaultNoteWriter({
      database: context.database, store: context.store, attachments, audit, scanner: new SecretScanner(), clock: context.clock,
      capability: new StubImageCapability(true), queue: new VaultValidationQueue(context.database), inference: new ScriptedAgentInference([submitTurn(operations)]),
      applier: new VaultEditApplier({ store: context.store, database: context.database, audit, scanner: new SecretScanner(), ownerDisplayName: 'Denys' }),
    });
    return writer.run(LOCAL_OWNER_ID, { source: 'chat', turn: {
      sessionId: 'chat_1', sessionTitle: 'Tools', userMessageId: 'msg_1', capturedAtUtc: '2026-10-24T08:45:00.000Z', userText: 'I use Telescope in Neovim.', assistantText: 'Nice.',
    } }, new AbortController().signal);
  };
  return { capture, learn, chat, rollup: new VaultDailyRollup({ database: context.database, store: context.store }) };
}

test('the daily note gathers the day\'s screenshots, the union of ## Learned and its chats', async () => {
  await withVaultAsync(async (context) => {
    context.store.create(entityInput('Git', 'Version control.'), TEST_META);
    context.store.create(entityInput('Neovim', 'Editor.'), TEST_META);
    const { capture, learn, chat, rollup } = setup(context);
    const first = capture('2026-10-24T08:00:00.000Z', '1', NEAR_HASH);
    const second = capture('2026-10-24T08:30:00.000Z', '2', DISTINCT_HASH);
    capture('2026-10-23T20:00:00.000Z', '3', NEAR_HASH);
    learn(first.noteId, ['- [[Git]]: **Uses** rebase']);
    await chat([
      { op: 'learned', note: 'Git', label: 'Uses', value: 'rebase' },
      { op: 'learned', note: 'Neovim', label: 'Plugin', value: 'Telescope' },
    ]);

    const outcome = rollup.run('2026-10-24');
    assert.equal(outcome.kind, 'written');
    if (outcome.kind !== 'written') return;
    const note = requireVaultNote(context.database, outcome.noteId);
    assert.deepEqual([note.title, note.folder, note.kind], ['2026-10-24', 'Daily', 'daily']);
    assert.equal(note.body, [
      '2 screenshots · 1 chat · 2 learned',
      '',
      `![[attachments/captures/${first.attachmentId}.png]]`,
      `![[attachments/captures/${second.attachmentId}.png]]`,
      '',
      '## Learned',
      '- [[Git]]: **Uses** rebase',
      '- [[Neovim]]: **Plugin** Telescope',
      '',
      '## Chats',
      '- [[Chat 2026-10-24 · Tools]]',
    ].join('\n'));
    assert.equal(context.store.listRevisions(note.id)[0]?.actor, 'note-writer · daily');
  });
});

test('a rerun with nothing new writes no revision; a new screenshot updates the same note', async () => {
  await withVaultAsync(async (context) => {
    const { capture, rollup } = setup(context);
    capture('2026-10-24T08:00:00.000Z', '1', NEAR_HASH);
    const first = rollup.run('2026-10-24');
    const again = rollup.run('2026-10-24');
    assert.deepEqual(again, first);
    capture('2026-10-24T08:30:00.000Z', '2', DISTINCT_HASH);
    const updated = rollup.run('2026-10-24');
    assert.equal(updated.kind === 'written' ? updated.noteId : null, first.kind === 'written' ? first.noteId : 'missing');
    const note = updated.kind === 'written' ? requireVaultNote(context.database, updated.noteId) : null;
    assert.equal(note?.revision, 2);
    assert.match(note?.body ?? '', /^2 screenshots · 0 chats · 0 learned\n/);
    assert.match(note?.body ?? '', /## Learned\n\n## Chats$/);
  });
});

test('a day with no screenshots or chats writes nothing', async () => {
  await withVaultAsync(async (context) => {
    const { rollup } = setup(context);
    assert.deepEqual(rollup.run('2026-10-24'), { kind: 'empty' });
    assert.equal(context.store.resolve('2026-10-24'), null);
  });
});

test('a user note that answers to the day by alias is never overwritten by the rollup', async () => {
  await withVaultAsync(async (context) => {
    const user = context.store.create(entityInput('Launch day', 'My own notes.', { aliases: ['2026-10-24'] }), TEST_META);
    const { capture, rollup } = setup(context);
    capture('2026-10-24T08:00:00.000Z', '1', NEAR_HASH);
    const outcome = rollup.run('2026-10-24');
    assert.equal(requireVaultNote(context.database, user.id).body, 'My own notes.');
    assert.notEqual(outcome.kind === 'written' ? outcome.noteId : user.id, user.id);
  });
});
