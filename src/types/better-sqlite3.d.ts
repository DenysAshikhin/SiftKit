declare module 'better-sqlite3' {
  export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): this;
    close(): void;
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
  }

  export interface DatabaseConstructor {
    new(filename: string, options?: Record<string, unknown>): Database;
    (filename: string, options?: Record<string, unknown>): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
