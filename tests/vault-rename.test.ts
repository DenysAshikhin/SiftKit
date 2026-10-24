import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { VaultConflictError, VaultNotFoundError, VaultTitleTakenError } from '../src/vault/errors.ts';
import { readVaultNote, requireVaultNote } from '../src/vault/note-rows.ts';
import { TEST_META, TEST_SOURCE, entityInput, withVault } from './helpers/vault-fixture.ts';

const CountSchema = z.object({ count: z.number() });

test('rename rewrites every inbound link as its own revision and keeps the old title as an alias', () => withVault(({ store, database }) => {
  const target = store.create(entityInput('VS Code', 'Editor.'), TEST_META);
  const a = store.create(entityInput('SiftKit', '**Uses** [[VS Code]] · [[vs code|editor]]'), TEST_META);
  const b = store.create(entityInput('Me', 'I live in [[VS Code#Settings]].'), TEST_META);
  const result = store.rename(target.id, 'Visual Studio Code', 1, TEST_SOURCE);
  assert.equal(result.note.title, 'Visual Studio Code');
  assert.deepEqual(result.note.aliases, ['VS Code']);
  assert.deepEqual([result.rewrittenNotes, result.rewrittenLinks], [2, 3]);
  assert.equal(requireVaultNote(database, a.id).body, '**Uses** [[Visual Studio Code]] · [[Visual Studio Code|editor]]');
  assert.equal(requireVaultNote(database, a.id).revision, 2);
  assert.equal(store.listRevisions(a.id)[0]?.summary, 'Link updated: VS Code → Visual Studio Code');
  assert.equal(store.listRevisions(target.id)[0]?.summary, 'Renamed from VS Code');
  assert.equal(requireVaultNote(database, b.id).body, 'I live in [[Visual Studio Code#Settings]].');
  assert.equal(store.resolve('vs code')?.id, target.id);
}));

test('rename to a title owned by another note fails; case-only rename succeeds', () => withVault(({ store }) => {
  const git = store.create(entityInput('git', 'x'), TEST_META);
  store.create(entityInput('Linux', 'y'), TEST_META);
  assert.throws(() => store.rename(git.id, 'LINUX', 1, TEST_SOURCE), VaultTitleTakenError);
  assert.equal(store.rename(git.id, 'Git', 1, TEST_SOURCE).note.title, 'Git');
  assert.throws(() => store.rename(git.id, 'Git2', 1, TEST_SOURCE), VaultConflictError);
}));

test('delete removes the note, its revisions and derived rows; links to it become unresolved', () => withVault(({ store, database }) => {
  const git = store.create(entityInput('Git', '**Uses** [[Linux]]', { aliases: ['git-scm'], tags: ['cli'] }), TEST_META);
  store.create(entityInput('SiftKit', '**Uses** [[Git]]'), TEST_META);
  store.delete(git.id, 1);
  assert.equal(readVaultNote(database, git.id), null);
  assert.equal(store.resolve('git-scm'), null);
  for (const [table, column] of [['vault_note_revisions', 'note_id'], ['vault_links', 'from_note_id'], ['vault_aliases', 'note_id'], ['vault_tags', 'note_id']]) {
    assert.equal(CountSchema.parse(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(git.id)).count, 0, table);
  }
  assert.throws(() => store.delete(git.id, 1), VaultNotFoundError);
}));
