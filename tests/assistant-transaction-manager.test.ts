import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from 'zod';
import { AssistantTransactionManager } from '../src/assistant/transactions/assistant-transaction-manager.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

const ValueRowSchema = z.object({ value: z.string() });

test('an outer commit persists writes', () => {
  withAssistantContext((ctx) => {
    const manager = new AssistantTransactionManager(ctx.database);
    const tx = manager.begin();
    ctx.database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)').run('tx_test_outer', 'persisted', '2026-08-05T09:00:00.000Z');
    tx.commit();
    const row = ValueRowSchema.parse(ctx.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get('tx_test_outer'));
    assert.equal(row.value, 'persisted');
  });
});

test('an outer rollback discards writes', () => {
  withAssistantContext((ctx) => {
    const manager = new AssistantTransactionManager(ctx.database);
    const tx = manager.begin();
    ctx.database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)').run('tx_test_rollback', 'discarded', '2026-08-05T09:00:00.000Z');
    tx.rollback();
    const row = ctx.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get('tx_test_rollback');
    assert.equal(row, undefined);
  });
});

test('nested commits persist with the outer commit', () => {
  withAssistantContext((ctx) => {
    const manager = new AssistantTransactionManager(ctx.database);
    const outer = manager.begin();
    ctx.database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)').run('tx_test_nested_a', 'A', '2026-08-05T09:00:00.000Z');
    const inner = manager.begin();
    ctx.database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)').run('tx_test_nested_b', 'B', '2026-08-05T09:00:00.000Z');
    inner.commit();
    outer.commit();
    const a = ValueRowSchema.parse(ctx.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get('tx_test_nested_a'));
    const b = ValueRowSchema.parse(ctx.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get('tx_test_nested_b'));
    assert.equal(a.value, 'A');
    assert.equal(b.value, 'B');
  });
});

test('a handled nested rollback preserves outer writes', () => {
  withAssistantContext((ctx) => {
    const manager = new AssistantTransactionManager(ctx.database);
    const outer = manager.begin();
    ctx.database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)').run('tx_test_preserve_a', 'A', '2026-08-05T09:00:00.000Z');
    const inner = manager.begin();
    ctx.database.prepare('INSERT INTO runtime_metadata (key, value, updated_at_utc) VALUES (?, ?, ?)').run('tx_test_preserve_b', 'B', '2026-08-05T09:00:00.000Z');
    inner.rollback();
    outer.commit();
    const a = ValueRowSchema.parse(ctx.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get('tx_test_preserve_a'));
    const b = ctx.database.prepare('SELECT value FROM runtime_metadata WHERE key = ?').get('tx_test_preserve_b');
    assert.equal(a.value, 'A');
    assert.equal(b, undefined);
  });
});

test('scopes close once and in last-in-first-out order', () => {
  withAssistantContext((ctx) => {
    const manager = new AssistantTransactionManager(ctx.database);
    const outer = manager.begin();
    const inner = manager.begin();

    assert.throws(() => outer.commit(), { message: 'Cannot close outer scope while inner scope is open.' });
    assert.throws(() => outer.rollback(), { message: 'Cannot close outer scope while inner scope is open.' });

    inner.commit();
    outer.commit();

    assert.throws(() => inner.commit(), { message: 'Scope already closed.' });
    assert.throws(() => inner.rollback(), { message: 'Scope already closed.' });
    assert.throws(() => outer.commit(), { message: 'Scope already closed.' });
    assert.throws(() => outer.rollback(), { message: 'Scope already closed.' });
  });
});

test('a failed commit closes stale scope state before rethrowing', () => {
  withAssistantContext((ctx) => {
    const manager = new AssistantTransactionManager(ctx.database);
    const transaction = manager.begin();
    ctx.database.exec('ROLLBACK;');

    assert.throws(() => transaction.commit());
    assert.throws(() => transaction.rollback(), { message: 'Scope already closed.' });

    const recovered = manager.begin();
    recovered.rollback();
  });
});

test('rollbackAfter preserves the application error when rollback fails', () => {
  withAssistantContext((ctx) => {
    const manager = new AssistantTransactionManager(ctx.database);
    const transaction = manager.begin();
    const applicationError = new Error('application write failed');
    ctx.database.exec('COMMIT;');

    assert.throws(
      () => transaction.rollbackAfter(applicationError),
      (error) => error === applicationError,
    );
    assert.throws(() => transaction.commit(), { message: 'Scope already closed.' });
  });
});
