declare module 'better-sqlite3' {
  export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export interface Database {
    readonly name: string;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    close(): void;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
    /** Native online backup: a consistent copy without blocking writers. */
    backup(destinationFile: string): Promise<{ totalPages: number; remainingPages: number }>;
  }

  /** Every native failure; `code` is the SQLite result code name such as `SQLITE_BUSY`. */
  export class SqliteError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
  }

  export interface DatabaseConstructor {
    new(filename: string, options?: Record<string, unknown>): Database;
    (filename: string, options?: Record<string, unknown>): Database;
    readonly SqliteError: typeof SqliteError;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
