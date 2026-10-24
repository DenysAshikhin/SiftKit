import test from 'node:test';
import assert from 'node:assert/strict';

import type { VaultNoteStore } from '../src/vault/note-store.ts';
import { VaultSearch } from '../src/vault/vault-search.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

function seed(store: VaultNoteStore) {
  store.create(entityInput('Visual Studio Code', 'Editor with **dark** theme.\n\n**Uses** [[Git]]', { aliases: ['VS Code'], tags: ['editor'] }), TEST_META);
  store.create(entityInput('Code Review', 'Reviewing pull requests.', { folder: 'Topics', types: ['topic'] }), TEST_META);
  store.create(entityInput('Git', 'Version control. Used from Visual Studio Code daily.'), TEST_META);
  store.create(entityInput('2026-10-24', 'Mostly in [[Visual Studio Code]].', { kind: 'daily', folder: 'Daily', types: [] }), TEST_META);
}

test('search ranks title prefix, then title contains, then body hits, with snippets', () => withVault(({ store, database }) => {
  seed(store);
  const result = new VaultSearch(database).search('code', 50);
  assert.deepEqual(result.hits.map((hit) => [hit.note.title, hit.snippet]), [
    ['Code Review', null],
    ['Visual Studio Code', null],
    ['2026-10-24', 'Mostly in [[Visual Studio Code]].'],
    ['Git', 'Version control. Used from Visual Studio Code daily.'],
  ]);
  assert.equal(result.total, 4);
}));

test('search matches aliases and reports them as the snippet', () => withVault(({ store, database }) => {
  seed(store);
  const hit = new VaultSearch(database).search('vs code', 50).hits[0];
  assert.deepEqual([hit?.note.title, hit?.snippet], ['Visual Studio Code', 'alias: VS Code']);
}));

test('tag:, path: and type: filters narrow results and work without a text query', () => withVault(({ store, database }) => {
  seed(store);
  const search = new VaultSearch(database);
  assert.deepEqual(search.search('tag:#editor', 50).hits.map((hit) => hit.note.title), ['Visual Studio Code']);
  assert.deepEqual(search.search('path:daily', 50).hits.map((hit) => hit.note.title), ['2026-10-24']);
  assert.deepEqual(search.search('type:topic code', 50).hits.map((hit) => hit.note.title), ['Code Review']);
}));

test('search caps hits at the limit but reports the full total; punctuation is safe', () => withVault(({ store, database }) => {
  seed(store);
  const result = new VaultSearch(database).search('code', 2);
  assert.deepEqual([result.total, result.hits.length], [4, 2]);
  assert.deepEqual(new VaultSearch(database).search('"; DROP --', 10), { total: 0, hits: [] });
  assert.deepEqual(new VaultSearch(database).search('   ', 10).total, 4);
}));
