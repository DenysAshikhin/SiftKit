import type { RuntimeDatabase } from '../../state/runtime-db.js';

interface ScopeRecord {
  readonly name: string | null;
  closed: boolean;
}

/**
 * Manages a strict LIFO stack of explicit SQLite transactions and savepoints.
 * The first `begin()` opens a `BEGIN`; nested calls create savepoints.
 * Only the topmost scope may close; double-close and out-of-order close throw.
 */
export class AssistantTransactionManager {
  private readonly stack: ScopeRecord[] = [];
  private counter = 0;

  constructor(private readonly database: RuntimeDatabase) {}

  begin(): AssistantTransactionScope {
    const top = this.stack.at(-1);
    if (top !== undefined && !top.closed) {
      const name = `assistant_tx_${this.counter++}`;
      this.database.exec(`SAVEPOINT ${name};`);
      const record: ScopeRecord = { name, closed: false };
      this.stack.push(record);
      return new AssistantTransactionScope(this.database, record, this.stack);
    }
    this.database.exec('BEGIN;');
    const record: ScopeRecord = { name: null, closed: false };
    this.stack.push(record);
    return new AssistantTransactionScope(this.database, record, this.stack);
  }
}

/** Single-use transaction scope. Only the current top scope may close. */
export class AssistantTransactionScope {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly record: ScopeRecord,
    private readonly stack: ScopeRecord[],
  ) {}

  commit(): void {
    this.ensureOpenAndTop();
    try {
      if (this.record.name === null) {
        this.database.exec('COMMIT;');
      } else {
        this.database.exec(`RELEASE SAVEPOINT ${this.record.name};`);
      }
    } catch (error) {
      this.rollbackAfterFailedCommit();
      throw error;
    }
    this.close();
  }

  rollback(): void {
    this.ensureOpenAndTop();
    try {
      this.executeRollback();
    } catch (error) {
      this.close();
      throw error;
    }
    this.close();
  }

  rollbackAfter<T>(error: T): never {
    try {
      this.rollback();
    } catch {
      // Preserve the application failure; the failed rollback already closed local scope state.
    }
    throw error;
  }

  private rollbackAfterFailedCommit(): void {
    try {
      this.executeRollback();
    } catch {
      // Preserve the commit failure while still clearing stale local scope state.
    }
    this.close();
  }

  private executeRollback(): void {
    if (this.record.name === null) {
      this.database.exec('ROLLBACK;');
      return;
    }
    this.database.exec(`ROLLBACK TO SAVEPOINT ${this.record.name};`);
    this.database.exec(`RELEASE SAVEPOINT ${this.record.name};`);
  }

  private close(): void {
    this.record.closed = true;
    this.stack.pop();
  }

  private ensureOpenAndTop(): void {
    if (this.record.closed) {
      throw new Error('Scope already closed.');
    }
    const top = this.stack.at(-1);
    if (top !== this.record) {
      throw new Error('Cannot close outer scope while inner scope is open.');
    }
  }
}
