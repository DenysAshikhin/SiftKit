import test from 'node:test';
import assert from 'node:assert/strict';

import type { IdGenerator, IdPrefix } from '../src/assistant/ids.ts';
import { z } from '../src/lib/zod.ts';
import { VaultTitleTakenError, VaultValidationError } from '../src/vault/errors.ts';
import { readVaultNote } from '../src/vault/note-rows.ts';
import { VaultNoteStore } from '../src/vault/note-store.ts';
import { TEST_META, VAULT_FIXTURE_START, entityInput, withVault } from './helpers/vault-fixture.ts';

const LinkRowsSchema = z.array(z.object({ target_key: z.string(), row_label: z.string().nullable(), line: z.number() }));
const TagRowsSchema = z.array(z.object({ tag: z.string() }));

test('create stores a note at revision 1 with a revision snapshot', () => withVault(({ store, database }) => {
  const note = store.create(entityInput('Visual Studio Code', 'A tool.\n\n**Uses** [[Git]]', { aliases: ['VS Code', 'vs code', 'Visual Studio Code'] }), TEST_META);
  assert.deepEqual(note, {
    id: 'vnote_0001', title: 'Visual Studio Code', folder: 'Software', kind: 'entity', types: ['software'],
    aliases: ['VS Code'], tags: [], body: 'A tool.\n\n**Uses** [[Git]]', revision: 1, isStub: false,
    createdAtUtc: VAULT_FIXTURE_START, updatedAtUtc: VAULT_FIXTURE_START,
  });
  assert.deepEqual(readVaultNote(database, note.id), note);
  assert.deepEqual(store.listRevisions(note.id), [{ revision: 1, actor: 'you', summary: 'test write', sourceRef: null, createdAtUtc: VAULT_FIXTURE_START }]);
}));

test('create rebuilds links and tags from the body', () => withVault(({ store, database }) => {
  const note = store.create(entityInput('SiftKit', 'Lead with [[Node.js]] #tooling.\n\n**Uses** [[Git]] · ![[attachments/x.png]]', { tags: ['Project'] }), TEST_META);
  assert.deepEqual(LinkRowsSchema.parse(database.prepare('SELECT target_key, row_label, line FROM vault_links WHERE from_note_id = ? ORDER BY line, target_key').all(note.id)),
    [{ target_key: 'node.js', row_label: null, line: 0 }, { target_key: 'git', row_label: 'Uses', line: 2 }]);
  assert.deepEqual(TagRowsSchema.parse(database.prepare('SELECT tag FROM vault_tags WHERE note_id = ? ORDER BY tag').all(note.id)).map((row) => row.tag), ['project', 'tooling']);
}));

test('resolve finds a note by title or alias, case-insensitively, title first', () => withVault(({ store }) => {
  const vscode = store.create(entityInput('Visual Studio Code', 'x', { aliases: ['VS Code', 'Code'] }), TEST_META);
  const code = store.create(entityInput('Code', 'y'), TEST_META);
  assert.equal(store.resolve('vs code')?.id, vscode.id);
  assert.equal(store.resolve('code')?.id, code.id);
  assert.equal(store.resolve('missing'), null);
}));

test('create rejects duplicate titles and invalid titles', () => withVault(({ store }) => {
  store.create(entityInput('Git', 'x'), TEST_META);
  assert.throws(() => store.create(entityInput('git', 'y'), TEST_META), VaultTitleTakenError);
  for (const title of ['', '   ', 'a[b', 'a|b', 'a#b', 'x'.repeat(201)]) {
    assert.throws(() => store.create(entityInput(title, 'y'), TEST_META), VaultValidationError);
  }
}));

test('isStub is true only for entity notes with no rows, tasks or unverified facts', () => withVault(({ store }) => {
  assert.equal(store.create(entityInput('Prettier', 'Prettier is a tool.'), TEST_META).isStub, true);
  assert.equal(store.create(entityInput('Git', '**Uses** [[Linux]]'), TEST_META).isStub, false);
  assert.equal(store.create(entityInput('2026-10-24', 'Mostly in Chrome.', { kind: 'daily', folder: 'Daily' }), TEST_META).isStub, false);
}));

test('folder paths are normalized', () => withVault(({ store }) => {
  assert.equal(store.create(entityInput('A', 'x', { folder: '/Captures//2026-10-24/' }), TEST_META).folder, 'Captures/2026-10-24');
}));

class DescendingIds implements IdGenerator {
  private counter = 100;

  next(prefix: IdPrefix): string {
    this.counter -= 1;
    return `${prefix}_${this.counter}`;
  }
}

test('an alias shared by two notes resolves to the older note whatever the id order', () => withVault(({ database, clock }) => {
  const store = new VaultNoteStore(database, clock, new DescendingIds());
  const older = store.create(entityInput('Visual Studio Code', 'x', { aliases: ['Code'] }), TEST_META);
  clock.advanceSeconds(1);
  store.create(entityInput('Code Editor', 'y', { aliases: ['Code'] }), TEST_META);
  assert.equal(store.resolve('code')?.id, older.id);
}));
