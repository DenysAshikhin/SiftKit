import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantConflictError, AssistantNotFoundError } from '../src/assistant/errors.ts';
import { VaultConflictError, VaultNotFoundError, VaultTitleTakenError } from '../src/vault/errors.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

test('update bumps the revision, snapshots it and reindexes', () => withVault(({ store, clock }) => {
  const note = store.create(entityInput('Git', 'Lead.'), TEST_META);
  clock.advanceSeconds(60);
  const next = store.update(note.id, { body: 'Lead.\n\n**Runs on** [[Linux]]', tags: ['cli'] }, 1, { actor: 'note-writer · screenshot', summary: 'Learned 1 new fact', sourceRef: 'att_1' });
  assert.equal(next.revision, 2);
  assert.equal(next.isStub, false);
  assert.deepEqual(next.tags, ['cli']);
  assert.equal(next.updatedAtUtc, '2026-10-24T09:01:00.000Z');
  assert.deepEqual(store.listRevisions(note.id).map((revision) => [revision.revision, revision.actor, revision.sourceRef]),
    [[2, 'note-writer · screenshot', 'att_1'], [1, 'you', null]]);
  assert.equal(store.getRevision(note.id, 1).body, 'Lead.');
  assert.equal(store.resolve('git')?.revision, 2);
}));

test('update with a stale revision throws a conflict carrying the current revision', () => withVault(({ store }) => {
  const note = store.create(entityInput('Git', 'Lead.'), TEST_META);
  store.update(note.id, { body: 'Two.' }, 1, TEST_META);
  assert.throws(() => store.update(note.id, { body: 'Three.' }, 1, TEST_META),
    (error: Error) => error instanceof VaultConflictError && error.code === 'conflict' && error.details.currentRevision === 2);
}));

test('an update that changes nothing creates no revision', () => withVault(({ store }) => {
  const note = store.create(entityInput('Git', 'Lead.'), TEST_META);
  assert.equal(store.update(note.id, { body: 'Lead.' }, 1, TEST_META).revision, 1);
  assert.equal(store.listRevisions(note.id).length, 1);
}));

test('restore writes the old snapshot as a new revision and keeps history', () => withVault(({ store }) => {
  const note = store.create(entityInput('Git', 'One.', { aliases: ['git-scm'] }), TEST_META);
  store.update(note.id, { body: 'Two.', aliases: [] }, 1, TEST_META);
  const restored = store.restore(note.id, 1, 2, { actor: 'you', summary: 'Restored r1', sourceRef: null });
  assert.equal(restored.revision, 3);
  assert.equal(restored.body, 'One.');
  assert.deepEqual(restored.aliases, ['git-scm']);
  assert.equal(store.listRevisions(note.id).length, 3);
}));

test('missing notes and revisions throw not-found', () => withVault(({ store }) => {
  assert.throws(() => store.update('vnote_404', { body: 'x' }, 1, TEST_META), VaultNotFoundError);
  const note = store.create(entityInput('Git', 'One.'), TEST_META);
  assert.throws(() => store.getRevision(note.id, 9), VaultNotFoundError);
}));

test('vault errors carry the assistant wire classes', () => {
  assert.ok(new VaultNotFoundError('x') instanceof AssistantNotFoundError);
  const taken = new VaultTitleTakenError('Git');
  assert.ok(taken instanceof AssistantConflictError);
  assert.equal(taken.code, 'title_taken');
});
