import test from 'node:test';
import assert from 'node:assert/strict';

import { VaultNotFoundError } from '../src/vault/errors.ts';
import { degreeOf, loadAdjacency } from '../src/vault/link-graph.ts';
import { VaultNoteQueries } from '../src/vault/note-queries.ts';
import type { VaultNoteStore } from '../src/vault/note-store.ts';
import { TEST_META, VAULT_FIXTURE_START, entityInput, withVault } from './helpers/vault-fixture.ts';

const NOW = VAULT_FIXTURE_START;

function seed(store: VaultNoteStore) {
  const me = store.create(entityInput('Denys', 'This is you.\n\n**Uses** [[VS Code]] · [[Git]]\n\n> [!unverified]- 1 unverified fact\n> - **Owns** [[PC]] #unverified', { folder: '', types: ['person'], tags: ['me'] }), TEST_META);
  const vscode = store.create(entityInput('Visual Studio Code', 'Editor.\n\n**Depends on** [[Git]] · [[Nowhere]]', { aliases: ['VS Code'] }), TEST_META);
  const git = store.create(entityInput('Git', 'Git is a tool.'), TEST_META);
  const day = store.create(entityInput('2026-10-24', 'Mostly in [[VS Code]].', { kind: 'daily', folder: 'Daily', types: [] }), TEST_META);
  const capture = store.create(entityInput('2026-10-24 16.42 Visual Studio Code', 'x', { kind: 'capture', folder: 'Captures/2026-10-24', types: [] }), TEST_META);
  return { me, vscode, git, day, capture };
}

test('links resolve through aliases into undirected adjacency without self links', () => withVault(({ store, database }) => {
  const { me, vscode, git } = seed(store);
  const adjacency = loadAdjacency(database);
  assert.equal(store.resolve('vs code')?.id, vscode.id);
  assert.equal(store.resolve('nowhere'), null);
  assert.equal(degreeOf(adjacency, git.id), 2);
  assert.equal(degreeOf(adjacency, vscode.id), 3);
  assert.deepEqual([...(adjacency.get(me.id) ?? [])].sort(), [git.id, vscode.id].sort());
}));

test('folders lists every folder path with cumulative counts, optionally hiding stubs', () => withVault(({ store, database }) => {
  seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.folders({ includeStubs: true }), [
    { path: 'Captures', name: 'Captures', depth: 0, count: 1 },
    { path: 'Captures/2026-10-24', name: '2026-10-24', depth: 1, count: 1 },
    { path: 'Daily', name: 'Daily', depth: 0, count: 1 },
    { path: 'Software', name: 'Software', depth: 0, count: 2 },
  ]);
  assert.equal(queries.folders({ includeStubs: false }).find((folder) => folder.path === 'Software')?.count, 1);
}));

test('folderNotes returns direct children ordered by degree, dated folders newest first', () => withVault(({ store, database }) => {
  const { vscode, git } = seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.folderNotes('Software', { includeStubs: true, limit: 50 }).map((note) => note.id), [vscode.id, git.id]);
  assert.deepEqual(queries.folderNotes('Software', { includeStubs: false, limit: 50 }).map((note) => note.id), [vscode.id]);
  assert.deepEqual(queries.folderNotes('', { includeStubs: true, limit: 50 }).map((note) => note.title), ['Denys']);
}));

test('backlinks group by source note with row labels; outgoing splits resolved and unresolved', () => withVault(({ store, database }) => {
  const { me, vscode, day } = seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.backlinks(vscode.id).map((link) => [link.note.id, link.labels]), [[me.id, ['Uses']], [day.id, []]]);
  const outgoing = queries.outgoing(vscode.id);
  assert.deepEqual(outgoing.resolved.map((note) => note.title), ['Git']);
  assert.deepEqual(outgoing.unresolved, ['nowhere']);
}));

test('review lists unverified facts; stats counts notes, links, tags and stubs', () => withVault(({ store, database }) => {
  const { me } = seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.review(100), { total: 1, items: [{ note: { id: me.id, title: 'Denys', folder: '', kind: 'entity', isStub: false, updatedAtUtc: me.updatedAtUtc }, line: 5, label: 'Owns', value: '[[PC]]', flag: null }] });
  assert.deepEqual(queries.stats(NOW), {
    notes: 5, links: 6, tags: 2, stubs: 1, notesWithUnverified: 1, byKind: { entity: 3, capture: 1, daily: 1, chat: 0, note: 0 },
    validation: { queueDepth: 3, oldestValidatedAtUtc: null },
  });
}));

test('backlinks and outgoing for an unknown note throw not-found', () => withVault(({ database }) => {
  const queries = new VaultNoteQueries(database);
  assert.throws(() => queries.backlinks('vnote_404'), VaultNotFoundError);
  assert.throws(() => queries.outgoing('vnote_404'), VaultNotFoundError);
}));

test('a tag that merely starts with unverified does not count as an unverified fact', () => withVault(({ store, database }) => {
  store.create(entityInput('Lookalike', 'Mentions #unverifiedish things.'), TEST_META);
  const queries = new VaultNoteQueries(database);
  assert.equal(queries.stats(NOW).notesWithUnverified, 0);
  assert.equal(queries.review(10).total, 0);
}));

test('a folder of daily or capture notes lists newest first whatever its name', () => withVault(({ store, database }) => {
  store.create(entityInput('2026-10-23', 'a', { kind: 'daily', folder: 'Journal', types: [] }), TEST_META);
  store.create(entityInput('2026-10-24', 'b', { kind: 'daily', folder: 'Journal', types: [] }), TEST_META);
  const titles = new VaultNoteQueries(database).folderNotes('Journal', { includeStubs: true, limit: 10 }).map((note) => note.title);
  assert.deepEqual(titles, ['2026-10-24', '2026-10-23']);
}));

test('detail bundles the note with its backlinks and outgoing links', () => withVault(({ store, database }) => {
  const { me, vscode } = seed(store);
  const detail = new VaultNoteQueries(database).detail(vscode.id);
  assert.equal(detail.note.id, vscode.id);
  assert.deepEqual(detail.backlinks.map((link) => link.note.id)[0], me.id);
  assert.deepEqual(detail.outgoing.unresolved, ['nowhere']);
}));
