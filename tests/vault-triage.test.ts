import test from 'node:test';
import assert from 'node:assert/strict';

import { addUnverified } from '@siftkit/contracts';
import { z } from '../src/lib/zod.ts';
import { VaultConflictError, VaultValidationError } from '../src/vault/errors.ts';
import { triageUnverified } from '../src/vault/triage.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

const BODY = 'Denys builds tools.\n\n**Hobby** flying by flapping hands · chess';

function seedDoubt(context: VaultTestContext) {
  const created = context.store.create(entityInput('Denys', BODY), TEST_META);
  const flagged = context.store.update(created.id, {
    body: addUnverified(BODY, [{ label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible' } }]),
  }, created.revision, TEST_META);
  return { note: flagged, line: flagged.body.split('\n').findIndex((candidate) => candidate.includes('#unverified')) };
}

test('Keep on a doubt removes the flag and stamps that fact value validated', () => {
  withVault((context) => {
    const { note, line } = seedDoubt(context);
    context.clock.advanceDays(1);
    const kept = triageUnverified(context.store, context.database, note.id, { line, action: 'confirm', expectedRevision: note.revision }, context.clock.nowUtc());
    assert.equal(kept.body, BODY);
    assert.equal(context.store.listRevisions(note.id)[0]?.actor, 'you');
    const validated = z.array(z.object({ value: z.string(), validated_at_utc: z.string().nullable() })).parse(
      context.database.prepare('SELECT value, validated_at_utc FROM vault_fact_points WHERE note_id = ? ORDER BY value_key').all(note.id));
    assert.deepEqual(validated, [{ value: 'chess', validated_at_utc: null }, { value: 'flying by flapping hands', validated_at_utc: context.clock.nowUtc() }]);
  });
});

test('Drop on a doubt removes the value; a line that is not a Review item is a validation error', () => {
  withVault((context) => {
    const { note, line } = seedDoubt(context);
    const dropped = triageUnverified(context.store, context.database, note.id, { line, action: 'drop', expectedRevision: note.revision }, context.clock.nowUtc());
    assert.equal(dropped.body, 'Denys builds tools.\n\n**Hobby** chess');
    assert.throws(
      () => triageUnverified(context.store, context.database, note.id, { line: 0, action: 'drop', expectedRevision: dropped.revision }, context.clock.nowUtc()),
      VaultValidationError,
    );
  });
});

test('a stale revision is a conflict and changes nothing', () => {
  withVault((context) => {
    const { note, line } = seedDoubt(context);
    assert.throws(
      () => triageUnverified(context.store, context.database, note.id, { line, action: 'drop', expectedRevision: note.revision - 1 }, context.clock.nowUtc()),
      VaultConflictError,
    );
    assert.equal(context.store.resolve('Denys')?.revision, note.revision);
  });
});
