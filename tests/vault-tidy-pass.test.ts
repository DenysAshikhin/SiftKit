import test from 'node:test';
import assert from 'node:assert/strict';

import { addRowValues } from '@siftkit/contracts';
import { SecretScanner } from '../src/assistant/domain/secrets.ts';
import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import type { AssistantInferenceClient, AssistantInferenceResult } from '../src/assistant/inference/client.ts';
import { StructuredOutputRunner } from '../src/assistant/inference/structured-runner.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { requireVaultNote } from '../src/vault/note-rows.ts';
import { VaultTidyPass } from '../src/vault/note-writer/tidy-pass.ts';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.ts';
import { TEST_META, entityInput, withVaultAsync, type VaultTestContext } from './helpers/vault-fixture.ts';

const BODY = 'Editor.\n\n**Uses** [[TypeScript]] · Vim keys\n\n## Plans\n- [ ] Try Zed';

/** Answers like the fake, but first adds a fact row, as a writer would while the model is busy. */
class ConcurrentEditInference implements AssistantInferenceClient {
  private readonly context: VaultTestContext;
  private readonly noteId: string;

  constructor(context: VaultTestContext, noteId: string) {
    this.context = context;
    this.noteId = noteId;
  }

  async complete(): Promise<AssistantInferenceResult> {
    const note = requireVaultNote(this.context.database, this.noteId);
    this.context.store.update(note.id, { body: addRowValues(note.body, 'Runs on', ['Windows']) }, note.revision, TEST_META);
    return { text: JSON.stringify({ lead: 'The editor you use.' }), backendId: 'fake', modelId: 'fake-model' };
  }
}

function tidy(context: VaultTestContext, client: AssistantInferenceClient) {
  const audit = new AuditStore(context.database, context.clock, new SequentialIdGenerator());
  const pass = new VaultTidyPass({ database: context.database, store: context.store, audit, scanner: new SecretScanner(), runner: new StructuredOutputRunner(client) });
  return { audit, run: (noteId: string) => pass.run(LOCAL_OWNER_ID, noteId, null) };
}

test('the tidy pass rewrites only the lead from the fact rows', async () => {
  await withVaultAsync(async (context) => {
    const note = context.store.create(entityInput('Visual Studio Code', BODY), TEST_META);
    const inference = new FakeAssistantInference([JSON.stringify({ lead: '  Visual Studio Code is your editor, set up for [[TypeScript]] with Vim keys.  ' })]);
    const outcome = await tidy(context, inference).run(note.id);
    assert.deepEqual(outcome, { kind: 'tidied' });
    const request = inference.requests[0];
    assert.equal(request?.role, 'vault_tidy');
    assert.equal(request?.userText, 'Title: Visual Studio Code\nTypes: software\nCurrent lead: Editor.\nFacts:\n**Uses** [[TypeScript]] · Vim keys\nPlans:\n- Try Zed');
    const tidied = requireVaultNote(context.database, note.id);
    assert.equal(tidied.body, BODY.replace('Editor.', 'Visual Studio Code is your editor, set up for [[TypeScript]] with Vim keys.'));
    assert.equal(context.store.listRevisions(note.id)[0]?.actor, 'note-writer · tidy');
  });
});

test('the lead lands on the latest revision when the note changed during the model call', async () => {
  await withVaultAsync(async (context) => {
    const note = context.store.create(entityInput('Visual Studio Code', BODY), TEST_META);
    assert.deepEqual(await tidy(context, new ConcurrentEditInference(context, note.id)).run(note.id), { kind: 'tidied' });
    const body = requireVaultNote(context.database, note.id).body;
    assert.match(body, /^The editor you use\.\n/);
    assert.match(body, /\*\*Runs on\*\* Windows/);
  });
});

test('non-entity notes and notes without facts are skipped without a model call', async () => {
  await withVaultAsync(async (context) => {
    const chat = context.store.create(entityInput('Chat 2026-10-24 · x', '**Uses** a', { kind: 'chat', folder: 'Chats', types: [] }), TEST_META);
    const bare = context.store.create(entityInput('Bare', 'Just a lead.'), TEST_META);
    const inference = new FakeAssistantInference([]);
    const { run } = tidy(context, inference);
    assert.deepEqual(await run(chat.id), { kind: 'skipped', reason: 'not_entity' });
    assert.deepEqual(await run(bare.id), { kind: 'skipped', reason: 'no_facts' });
    assert.equal(inference.requests.length, 0);
  });
});

test('a note whose latest revision is already a tidy is skipped without a model call', async () => {
  await withVaultAsync(async (context) => {
    const note = context.store.create(entityInput('Visual Studio Code', BODY), TEST_META);
    const inference = new FakeAssistantInference([JSON.stringify({ lead: 'Your editor.' })]);
    const { run } = tidy(context, inference);
    assert.deepEqual(await run(note.id), { kind: 'tidied' });
    assert.deepEqual(await run(note.id), { kind: 'skipped', reason: 'unchanged' });
    assert.equal(inference.requests.length, 1);
  });
});

test('unusable output, a lead that is not a plain paragraph and a secret are rejected and audited', async () => {
  await withVaultAsync(async (context) => {
    const note = context.store.create(entityInput('Visual Studio Code', BODY), TEST_META);
    const { run, audit } = tidy(context, new FakeAssistantInference([
      'nope', 'nope',
      JSON.stringify({ lead: '## A heading' }),
      JSON.stringify({ lead: 'Your token is ghp_abcdefghijklmnopqrstuvwxyz0123.' }),
    ]));
    assert.deepEqual(await run(note.id), { kind: 'rejected', reason: 'invalid_output' });
    assert.deepEqual(await run(note.id), { kind: 'rejected', reason: 'invalid_lead' });
    assert.deepEqual(await run(note.id), { kind: 'rejected', reason: 'secret' });
    assert.equal(requireVaultNote(context.database, note.id).revision, note.revision);
    const events = audit.listAuditEvents(LOCAL_OWNER_ID, 5);
    assert.deepEqual(events.map((event) => event.event_type), ['vault_writer_rejected', 'vault_writer_rejected', 'vault_writer_rejected']);
    assert.doesNotMatch(JSON.stringify(events), /ghp_/, 'the secret itself is never audited');
  });
});
