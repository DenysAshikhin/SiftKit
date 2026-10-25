import test from 'node:test';
import assert from 'node:assert/strict';

import { VAULT_OWNER_TAG } from '@siftkit/contracts';
import { OwnerIdentity, ensureOwnerNote, findOwnerNote } from '../src/vault/owner-identity.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

const owner = new OwnerIdentity({ title: 'Denys Ashikhin', aliases: ['DenysA', 'dashikhin'] });

test('the owner title, aliases and pronouns match case-insensitively', () => {
  for (const name of ['Denys Ashikhin', 'denysa', ' DASHIKHIN ', 'the user', 'User', 'me', 'Myself', 'current user', 'you']) {
    assert.equal(owner.matches(name), true, name);
  }
});

test('a user prefix is stripped and OCR misreads of the first name match', () => {
  for (const name of ['user denys', 'User: Denys', 'user_denys', 'denyz', 'demys', 'dennys', 'denvs', 'deyns']) {
    assert.equal(owner.matches(name), true, name);
  }
});

test('possessives, paths, other names and short names never match', () => {
  for (const name of ["Denys's laptop", 'C:/Users/denys', 'denys.txt', 'Dan', 'Dennis Ritchie', 'Kenys', 'reddit', '', '  ', 'user Bob']) {
    assert.equal(owner.matches(name), false, name);
  }
});

test('the y rule allows three edits only when the name contains y', () => {
  const kim = new OwnerIdentity({ title: 'Mykola', aliases: [] });
  assert.equal(kim.matches('mikuly'), true, 'three edits with a y');
  const bob = new OwnerIdentity({ title: 'Roberta', aliases: [] });
  assert.equal(bob.matches('rabirta'), true, 'two edits');
  assert.equal(bob.matches('rabirtu'), false, 'three edits without a y');
});

test('ensureOwnerNote creates the #me note once, or tags an existing note with the display name', () => {
  withVault(({ database, store }) => {
    assert.equal(findOwnerNote(database), null);
    const created = ensureOwnerNote(store, database, 'Denys', TEST_META);
    assert.deepEqual([created.title, created.tags, created.folder, created.kind], ['Denys', [VAULT_OWNER_TAG], '', 'entity']);
    assert.equal(ensureOwnerNote(store, database, 'Someone Else', TEST_META).id, created.id);
    assert.equal(findOwnerNote(database)?.id, created.id);
  });
  withVault(({ database, store }) => {
    const existing = store.create(entityInput('Denys', 'A person.', { folder: 'People' }), TEST_META);
    const tagged = ensureOwnerNote(store, database, 'denys', TEST_META);
    assert.equal(tagged.id, existing.id);
    assert.deepEqual(tagged.tags, [VAULT_OWNER_TAG]);
  });
});

test('the owner note history says whether it was created or an existing note was tagged', () => {
  withVault(({ database, store }) => {
    const created = ensureOwnerNote(store, database, 'Denys', TEST_META);
    assert.equal(store.listRevisions(created.id)[0]?.summary, 'Created the owner note');
  });
  withVault(({ database, store }) => {
    const existing = store.create(entityInput('Denys', 'A person.', { folder: 'People' }), TEST_META);
    ensureOwnerNote(store, database, 'Denys', TEST_META);
    assert.equal(store.listRevisions(existing.id)[0]?.summary, 'Tagged as the owner note');
  });
});
