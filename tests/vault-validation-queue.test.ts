import test from 'node:test';
import assert from 'node:assert/strict';

import { factPointKey, stampValidated, touchAccess } from '../src/vault/fact-points.ts';
import { VaultValidationQueue } from '../src/vault/validation-queue.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

function seed(context: VaultTestContext, count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => context.store.create(
    entityInput(`Tool ${offset + index}`, `Tool ${offset + index}.\n\n**Uses** x${offset + index}`), TEST_META).id);
}

test('batch is 10% of entity notes, at least 1 and at most 25; other kinds never queue', () => {
  withVault((context) => {
    const queue = new VaultValidationQueue(context.database);
    const now = context.clock.nowUtc();
    assert.deepEqual(queue.nextBatch(now), []);
    context.store.create(entityInput('2026-10-24', 'Daily.', { kind: 'daily', folder: 'Daily', types: [] }), TEST_META);
    assert.deepEqual(queue.nextBatch(now), []);
    seed(context, 3);
    assert.equal(queue.nextBatch(now).length, 1);
    seed(context, 37, 3);
    assert.equal(queue.nextBatch(now).length, 4);
    seed(context, 300, 40);
    assert.equal(queue.nextBatch(now).length, 25);
  });
});

test('never-accessed notes come first, then the oldest access; ties go to the oldest validation', () => {
  withVault((context) => {
    const [a, b, c, d] = seed(context, 4);
    touchAccess(context.database, a ?? '', [], '2026-10-01T00:00:00.000Z');
    touchAccess(context.database, b ?? '', [], '2026-10-01T00:00:00.000Z');
    touchAccess(context.database, c ?? '', [], '2026-09-01T00:00:00.000Z');
    stampValidated(context.database, a ?? '', [], '2026-08-01T00:00:00.000Z');
    stampValidated(context.database, b ?? '', [], '2026-09-01T00:00:00.000Z');
    assert.deepEqual(new VaultValidationQueue(context.database).order(context.clock.nowUtc()), [d, c, a, b]);
  });
});

test('notes validated in the last 30 days are not queued, and the depth counts the rest', () => {
  withVault((context) => {
    const [fresh, stale, never] = seed(context, 3);
    const queue = new VaultValidationQueue(context.database);
    stampValidated(context.database, fresh ?? '', [], context.clock.nowUtc());
    stampValidated(context.database, stale ?? '', [], '2026-08-01T00:00:00.000Z');
    assert.deepEqual(queue.order(context.clock.nowUtc()), [never, stale], 'never validated before validated long ago');
    assert.deepEqual(queue.depth(context.clock.nowUtc()), { queueDepth: 2, oldestValidatedAtUtc: '2026-08-01T00:00:00.000Z' });
  });
});

test('staleFacts lists never-accessed values first, then the oldest access', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub · GitLab · Gitea'), TEST_META);
    touchAccess(context.database, note.id, [factPointKey('Hosts', 'GitHub')], '2026-10-01T00:00:00.000Z');
    touchAccess(context.database, note.id, [factPointKey('Hosts', 'Gitea')], '2026-09-01T00:00:00.000Z');
    assert.deepEqual(new VaultValidationQueue(context.database).staleFacts(note.id).map((row) => row.value), ['GitLab', 'Gitea', 'GitHub']);
  });
});
