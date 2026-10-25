import test from 'node:test';
import assert from 'node:assert/strict';

import { VAULT_NOTE_KINDS } from '@siftkit/contracts';
import { z } from '../src/lib/zod.ts';
import { searchNoteIds } from '../src/vault/vault-fts.ts';
import { TEST_META, TEST_SOURCE, entityInput, withVault } from './helpers/vault-fixture.ts';

test('FTS finds notes by title, alias and body words, best match first', () => {
  withVault(({ database, store }) => {
    const code = store.create(entityInput('Visual Studio Code', 'Your editor for TypeScript.', { aliases: ['vscode'] }), TEST_META);
    const git = store.create(entityInput('Git', 'Version control used from Visual Studio Code.'), TEST_META);
    store.create(entityInput('Discord', 'Chat app.'), TEST_META);
    assert.deepEqual(searchNoteIds(database, ['vscode'], VAULT_NOTE_KINDS, 10), [code.id]);
    assert.deepEqual(searchNoteIds(database, ['typescript'], VAULT_NOTE_KINDS, 10), [code.id]);
    assert.deepEqual(new Set(searchNoteIds(database, ['visual', 'studio'], VAULT_NOTE_KINDS, 10)), new Set([code.id, git.id]));
    assert.equal(searchNoteIds(database, ['visual', 'studio'], VAULT_NOTE_KINDS, 10)[0], code.id);
    assert.deepEqual(searchNoteIds(database, ['visual'], VAULT_NOTE_KINDS, 1).length, 1);
  });
});

test('FTS treats terms as literals and returns nothing for no terms', () => {
  withVault(({ database, store }) => {
    store.create(entityInput('C++', 'Language with "quotes" and NEAR operators.'), TEST_META);
    assert.equal(searchNoteIds(database, ['"quotes"', 'NEAR', 'OR'], VAULT_NOTE_KINDS, 10).length, 1);
    assert.deepEqual(searchNoteIds(database, [], VAULT_NOTE_KINDS, 10), []);
    assert.deepEqual(searchNoteIds(database, ['   '], VAULT_NOTE_KINDS, 10), []);
  });
});

test('FTS follows update, rename, restore and delete', () => {
  withVault(({ database, store }) => {
    const note = store.create(entityInput('Alpha', 'first words'), TEST_META);
    const updated = store.update(note.id, { body: 'second words' }, note.revision, TEST_META);
    assert.deepEqual(searchNoteIds(database, ['first'], VAULT_NOTE_KINDS, 10), []);
    assert.deepEqual(searchNoteIds(database, ['second'], VAULT_NOTE_KINDS, 10), [note.id]);
    const renamed = store.rename(note.id, 'Beta', updated.revision, TEST_SOURCE).note;
    assert.deepEqual(searchNoteIds(database, ['beta'], VAULT_NOTE_KINDS, 10), [note.id]);
    assert.deepEqual(searchNoteIds(database, ['alpha'], VAULT_NOTE_KINDS, 10), [note.id], 'the old title survives as an alias');
    const restored = store.restore(note.id, 1, renamed.revision, TEST_SOURCE);
    assert.deepEqual(searchNoteIds(database, ['first'], VAULT_NOTE_KINDS, 10), [note.id]);
    store.delete(note.id, restored.revision);
    assert.deepEqual(searchNoteIds(database, ['first'], VAULT_NOTE_KINDS, 10), []);
    assert.equal(z.object({ n: z.number() }).parse(database.prepare('SELECT COUNT(*) AS n FROM vault_notes_fts').get()).n, 0);
  });
});

test('FTS keeps only the requested note kinds', () => {
  withVault(({ database, store }) => {
    const code = store.create(entityInput('Visual Studio Code', 'Editor.'), TEST_META);
    store.create(entityInput('2026-10-24 09.00.00 · Visual Studio Code', 'Screenshot of Visual Studio Code.', { folder: 'Captures/2026-10-24', kind: 'capture', types: [] }), TEST_META);
    assert.equal(searchNoteIds(database, ['visual'], VAULT_NOTE_KINDS, 10).length, 2);
    assert.deepEqual(searchNoteIds(database, ['visual'], ['entity'], 10), [code.id]);
  });
});
