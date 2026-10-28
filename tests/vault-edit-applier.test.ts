import test from 'node:test';
import assert from 'node:assert/strict';

import { VAULT_OWNER_TAG } from '@siftkit/contracts';
import { SecretScanner } from '../src/assistant/domain/secrets.ts';
import { SequentialIdGenerator } from '../src/assistant/ids.ts';
import { AuditStore } from '../src/assistant/storage/audit-store.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { z } from '../src/lib/zod.ts';
import { VaultEditResponseSchema, type VaultEditOp } from '../src/vault/note-writer/edit-ops.ts';
import { VaultEditApplier } from '../src/vault/note-writer/edit-applier.ts';
import { findOwnerNote } from '../src/vault/owner-identity.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

const OWNER_ID = LOCAL_OWNER_ID;

function applier(context: VaultTestContext) {
  const audit = new AuditStore(context.database, context.clock, new SequentialIdGenerator());
  const edits = new VaultEditApplier({ store: context.store, database: context.database, audit, scanner: new SecretScanner(), ownerDisplayName: 'Denys' });
  const apply = (operations: readonly VaultEditOp[], scopeNoteIds: readonly string[] = []) =>
    edits.apply({ ownerId: OWNER_ID, operations, actor: 'note-writer · screenshot', sourceRef: 'vatt_1', summary: 'Screenshot 09:00', scopeNoteIds });
  return { apply, audit };
}

test('the edit response JSON schema is flat: no $ref anywhere', () => {
  assert.doesNotMatch(JSON.stringify(z.toJSONSchema(VaultEditResponseSchema)), /\$ref/);
  assert.equal(VaultEditResponseSchema.safeParse({ operations: [{ op: 'add_task', note: 'X', text: 't', extra: 1 }] }).success, false);
  assert.equal(VaultEditResponseSchema.safeParse({ operations: [{ op: 'add_facts', note: 'X', label: 'Uses', values: Array(9).fill('v') }] }).success, false);
});

test('create_note makes an entity note in its type folder, and later ops in the batch can target it', () => {
  withVault((context) => {
    const { apply } = applier(context);
    context.store.create(entityInput('Git', 'Version control.'), TEST_META);
    const result = apply([
      { op: 'create_note', title: 'GitLens', type: 'software', lead: 'GitLens is a VS Code extension.' },
      { op: 'add_facts', note: 'gitlens', label: 'Works with', values: ['[[Git]]', 'blame view'] },
      { op: 'learned', note: 'GitLens', label: 'Shows', value: 'inline blame' },
    ]);
    const note = context.store.resolve('GitLens');
    assert.ok(note);
    assert.deepEqual([note.folder, note.kind, note.types], ['Software', 'entity', ['software']]);
    assert.equal(note.body, 'GitLens is a VS Code extension.\n\n**Works with** [[Git]] · blame view');
    assert.equal(note.revision, 2, 'creation plus one batched edit');
    assert.deepEqual(result.learned, ['- [[GitLens]]: **Shows** inline blame']);
    assert.deepEqual(result.touchedNoteIds, [note.id]);
    assert.equal(context.store.listRevisions(note.id)[0]?.actor, 'note-writer · screenshot');
    assert.equal(context.store.listRevisions(note.id)[0]?.sourceRef, 'vatt_1');
  });
});

test('owner references resolve to the #me note, creating it on first use, and values link to known notes', () => {
  withVault((context) => {
    const { apply } = applier(context);
    context.store.create(entityInput('Visual Studio Code', 'Editor.', { aliases: ['vscode'] }), TEST_META);
    apply([
      { op: 'add_facts', note: 'the user', label: 'Uses', values: ['VSCode', 'Dark · theme'] },
      { op: 'add_aliases', note: 'user denyz', aliases: ['DenysA'] },
      { op: 'add_task', note: 'me', text: 'Try Cursor' },
    ]);
    const owner = findOwnerNote(context.database);
    assert.ok(owner);
    assert.deepEqual([owner.title, owner.tags, owner.aliases], ['Denys', [VAULT_OWNER_TAG], ['DenysA']]);
    assert.equal(owner.body, 'This is you.\n\n**Uses** [[Visual Studio Code]] · Dark, theme\n\n## Plans\n- [ ] Try Cursor');
  });
});

test('ops on unknown notes, invalid titles and secrets are dropped and audited without failing the batch', () => {
  withVault((context) => {
    const { apply, audit } = applier(context);
    context.store.create(entityInput('Git', 'Version control.'), TEST_META);
    const result = apply([
      { op: 'add_facts', note: 'Nowhere', label: 'Uses', values: ['x'] },
      { op: 'create_note', title: 'Bad/Title', type: 'software', lead: 'x' },
      { op: 'add_facts', note: 'Git', label: 'Token', values: ['ghp_abcdefghijklmnopqrstuvwxyz0123'] },
      { op: 'learned', note: 'Ghost', label: 'Is', value: 'nothing' },
      { op: 'add_facts', note: 'Git', label: 'Runs on', values: ['Windows'] },
    ]);
    assert.equal(result.dropped, 4);
    assert.deepEqual(result.learned, []);
    assert.equal(context.store.resolve('Git')?.body, 'Version control.\n\n**Runs on** Windows');
    const events = audit.listAuditEvents(OWNER_ID, 10);
    assert.equal(events.length, 4);
    assert.ok(events.every((event) => event.event_type === 'vault_edit_dropped'));
    assert.deepEqual(events.map((event) => z.object({ reason: z.string() }).parse(JSON.parse(event.details_json)).reason).sort(), ['invalid_title', 'secret', 'unknown_note', 'unknown_note']);
    assert.doesNotMatch(JSON.stringify(events), /ghp_/, 'the secret itself is never audited');
  });
});

test('create_note for an existing title or the owner is a no-op, not a drop', () => {
  withVault((context) => {
    const { apply } = applier(context);
    const git = context.store.create(entityInput('Git', 'Version control.'), TEST_META);
    const result = apply([
      { op: 'create_note', title: 'git', type: 'software', lead: 'Other lead.' },
      { op: 'create_note', title: 'the user', type: 'person', lead: 'Me.' },
    ]);
    assert.equal(result.dropped, 0);
    assert.equal(context.store.resolve('Git')?.revision, git.revision);
    assert.equal(findOwnerNote(context.database), null);
  });
});

const reasonOf = (detailsJson: string) => z.object({ reason: z.string() }).parse(JSON.parse(detailsJson)).reason;

test('a near-duplicate create_note becomes an alias of the existing note and is audited as merged_into_existing', () => {
  withVault((context) => {
    const { apply, audit } = applier(context);
    const existing = context.store.create(entityInput('VS Code', 'Editor.'), TEST_META);
    const result = apply([{ op: 'create_note', title: 'vs-code', type: 'software', lead: 'Editor.' }]);
    assert.equal(context.store.resolve('vs-code')?.id, existing.id);
    assert.deepEqual(context.store.resolve('VS Code')?.aliases, ['vs-code']);
    assert.equal(result.dropped, 0);
    assert.deepEqual(result.touchedNoteIds, [existing.id]);
    const merged = audit.listAuditEvents(OWNER_ID, 10).filter((event) => event.event_type === 'vault_edit_merged');
    assert.deepEqual(merged.map((event) => reasonOf(event.details_json)), ['merged_into_existing']);
  });
});

test('a value already in its row is dropped silently', () => {
  withVault((context) => {
    const { apply, audit } = applier(context);
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub'), TEST_META);
    const result = apply([{ op: 'add_facts', note: 'Git', label: 'hosts', values: ['github'] }]);
    assert.equal(context.store.resolve('Git')?.revision, note.revision);
    assert.equal(result.dropped, 0);
    assert.equal(audit.listAuditEvents(OWNER_ID, 10).length, 0);
  });
});

test('flag_conflict lands in Review when the note holds the replaced value; an unknown fact is dropped and audited', () => {
  withVault((context) => {
    const { apply, audit } = applier(context);
    context.store.create(entityInput('Pet Safety', 'A project.\n\n**Editor** [[Neovim]]'), TEST_META);
    const result = apply([
      { op: 'flag_conflict', note: 'Pet Safety', label: 'Editor', value: 'Helix', conflictsWith: 'Neovim' },
      { op: 'flag_conflict', note: 'Pet Safety', label: 'Editor', value: 'Emacs', conflictsWith: 'Notepad' },
    ]);
    const body = context.store.resolve('Pet Safety')?.body ?? '';
    assert.match(body, /^\*\*Editor\*\* \[\[Neovim\]\]$/m, 'the held value is not changed');
    assert.match(body, /^> - \*\*Editor\*\* Helix #unverified \(replaces: Neovim\)$/m);
    assert.doesNotMatch(body, /Emacs/);
    assert.equal(result.dropped, 1);
    assert.deepEqual(audit.listAuditEvents(OWNER_ID, 10).map((event) => reasonOf(event.details_json)), ['unknown_fact']);
  });
});

test('flag_doubt marks a held value and reports it flagged by its stored key', () => {
  withVault((context) => {
    const { apply } = applier(context);
    const note = context.store.create(entityInput('Pet Safety', 'A project.\n\n**Uses** [[Neovim]] · TypeScript'), TEST_META);
    const result = apply([
      { op: 'flag_doubt', note: 'Pet Safety', label: 'Uses', value: 'Neovim', reason: 'bad link: an editor is not part of a pet-safety project' },
      { op: 'flag_doubt', note: 'Pet Safety', label: 'Uses', value: 'Rust', reason: 'stale' },
    ]);
    assert.match(context.store.resolve('Pet Safety')?.body ?? '', /^> - \*\*Uses\*\* Neovim #unverified \(doubt: bad link: an editor/m);
    assert.deepEqual(result.flagged, [{ noteId: note.id, labelKey: 'uses', valueKey: '[[neovim]]' }]);
    assert.equal(result.dropped, 1);
  });
});

test('set_lead applies only to notes the batch touches or the review scope holds', () => {
  withVault((context) => {
    const { apply } = applier(context);
    context.store.create(entityInput('Git', 'Old lead.\n\n**Hosts** GitHub'), TEST_META);
    const excel = context.store.create(entityInput('Excel', 'Old lead.'), TEST_META);
    const result = apply([
      { op: 'set_lead', note: 'Git', lead: 'Git is a version control system.' },
      { op: 'add_facts', note: 'Git', label: 'Hosts', values: ['GitLab'] },
      { op: 'set_lead', note: 'Excel', lead: 'Excel is a spreadsheet.' },
    ]);
    assert.match(context.store.resolve('Git')?.body ?? '', /^Git is a version control system\.\n/);
    assert.equal(context.store.resolve('Excel')?.body, 'Old lead.');
    assert.equal(result.dropped, 1);
    apply([{ op: 'set_lead', note: 'Excel', lead: 'Excel is a spreadsheet.' }], [excel.id]);
    assert.equal(context.store.resolve('Excel')?.body, 'Excel is a spreadsheet.');
  });
});
