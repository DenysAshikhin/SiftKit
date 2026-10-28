import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { FactPointRowSchema, factAges, factPointKey, stampValidated, touchAccess, validateFactPoint } from '../src/vault/fact-points.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

const points = (context: VaultTestContext, noteId: string) => z.array(FactPointRowSchema).parse(
  context.database.prepare('SELECT * FROM vault_fact_points WHERE note_id = ? ORDER BY label_key, value_key').all(noteId));

const noteTimes = (context: VaultTestContext, noteId: string) => z.object({ last_accessed_at_utc: z.string().nullable(), validated_at_utc: z.string().nullable() })
  .parse(context.database.prepare('SELECT last_accessed_at_utc, validated_at_utc FROM vault_notes WHERE id = ?').get(noteId));

test('every note write keeps fact points in step: new values added, removed ones dropped, unchanged ones keep their times', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Neovim', 'Editor.\n\n**Uses** [[Lua]] · plugins'), TEST_META);
    const addedAt = context.clock.nowUtc();
    assert.deepEqual(points(context, note.id).map((row) => [row.label, row.value, row.added_at_utc, row.edited_at_utc]), [
      ['Uses', '[[Lua]]', addedAt, addedAt], ['Uses', 'plugins', addedAt, addedAt],
    ]);
    context.clock.advanceDays(3);
    context.store.update(note.id, { body: 'Editor.\n\n**Uses** [[Lua]] · LSP' }, note.revision, TEST_META);
    assert.deepEqual(points(context, note.id).map((row) => [row.value, row.added_at_utc, row.edited_at_utc]), [
      ['[[Lua]]', addedAt, addedAt], ['LSP', context.clock.nowUtc(), context.clock.nowUtc()],
    ]);
  });
});

test('deleting a note removes its fact points', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub'), TEST_META);
    context.store.delete(note.id, note.revision);
    assert.equal(points(context, note.id).length, 0);
  });
});

test('access stamps the note and only the listed values; validated skips flagged values', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub · GitLab'), TEST_META);
    assert.deepEqual(noteTimes(context, note.id), { last_accessed_at_utc: null, validated_at_utc: null });
    context.clock.advanceDays(1);
    const now = context.clock.nowUtc();
    touchAccess(context.database, note.id, [factPointKey('Hosts', 'GitHub')], now);
    assert.deepEqual(points(context, note.id).map((row) => row.last_accessed_at_utc), [now, null]);
    stampValidated(context.database, note.id, [factPointKey('Hosts', 'GitLab')], now);
    assert.deepEqual(points(context, note.id).map((row) => row.validated_at_utc), [now, null]);
    validateFactPoint(context.database, note.id, factPointKey('hosts', 'gitlab'), now);
    assert.deepEqual(points(context, note.id).map((row) => row.validated_at_utc), [now, now]);
    assert.deepEqual(noteTimes(context, note.id), { last_accessed_at_utc: now, validated_at_utc: now });
  });
});

test('factAges reads whole days and "never"', () => {
  const row = { added_at_utc: '2026-09-14T09:00:00.000Z', edited_at_utc: '2026-10-12T09:00:00.000Z', validated_at_utc: null };
  assert.equal(factAges(row, '2026-10-24T09:00:00.000Z'), 'added 40d · edited 12d · validated never');
  assert.equal(factAges({ ...row, validated_at_utc: '2026-10-23T09:00:00.000Z' }, '2026-10-24T09:00:00.000Z'), 'added 40d · edited 12d · validated 1d');
});
