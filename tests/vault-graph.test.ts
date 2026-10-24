import test from 'node:test';
import assert from 'node:assert/strict';

import { VaultNotFoundError } from '../src/vault/errors.ts';
import type { VaultNoteStore } from '../src/vault/note-store.ts';
import { VaultGraphQueries } from '../src/vault/vault-graph.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

function seedChain(store: VaultNoteStore) {
  // a — b — c — d, plus a capture linking to b, plus an isolated note
  store.create(entityInput('A', '**Uses** [[B]]'), TEST_META);
  store.create(entityInput('B', '**Uses** [[C]] · [[A]]'), TEST_META);
  store.create(entityInput('C', '**Uses** [[D]]'), TEST_META);
  store.create(entityInput('D', 'End.'), TEST_META);
  store.create(entityInput('Cap', '[[B]]', { kind: 'capture', folder: 'Captures/2026-10-24', types: [] }), TEST_META);
  store.create(entityInput('Lonely', 'Alone.', { folder: 'Topics' }), TEST_META);
}

test('global graph filters by hidden top folders and minimum links, with deduplicated edges', () => withVault(({ store, database }) => {
  seedChain(store);
  const graph = new VaultGraphQueries(database).global({ minLinks: 1, hiddenTopFolders: ['Captures'] });
  assert.deepEqual(graph.nodes.map((node) => [node.title, node.topFolder, node.degree]), [
    ['A', 'Software', 1], ['B', 'Software', 3], ['C', 'Software', 2], ['D', 'Software', 1],
  ]);
  assert.equal(graph.edges.length, 3);
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  assert.deepEqual(graph.edges.map((edge) => [titles.get(edge.source), titles.get(edge.target)].sort().join('-')).sort(), ['A-B', 'B-C', 'C-D']);
  assert.equal(new VaultGraphQueries(database).global({ minLinks: 0, hiddenTopFolders: [] }).nodes.length, 6);
}));

test('local graph walks one or two hops and caps the node count', () => withVault(({ store, database }) => {
  seedChain(store);
  const queries = new VaultGraphQueries(database);
  const a = store.resolve('A');
  assert.ok(a);
  assert.deepEqual(queries.local(a.id, 1, 160).nodes.map((node) => node.title).sort(), ['A', 'B']);
  assert.deepEqual(queries.local(a.id, 2, 160).nodes.map((node) => node.title).sort(), ['A', 'B', 'C', 'Cap']);
  assert.equal(queries.local(a.id, 2, 2).nodes.length, 2);
}));

test('local graph for an unknown note throws not-found', () => withVault(({ database }) => {
  assert.throws(() => new VaultGraphQueries(database).local('vnote_404', 1, 160), VaultNotFoundError);
}));
