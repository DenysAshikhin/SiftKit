import Database from 'better-sqlite3';

export type RuntimeDatabase = InstanceType<typeof Database>;

/**
 * SQLite result codes that mean the database itself could not take the write: contention, space,
 * I/O, corruption or an unusable file. A constraint or a conflicting row is the schema refusing
 * the write as designed, which is a different failure for the caller to interpret.
 */
const STORAGE_FAILURE_CODES = [
  'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_NOTADB',
  'SQLITE_READONLY', 'SQLITE_NOMEM', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL', 'SQLITE_PERM',
] as const;

export function isStorageFailure(error: Error): boolean {
  if (!(error instanceof Database.SqliteError)) return false;
  return STORAGE_FAILURE_CODES.some((code) => error.code === code || error.code.startsWith(`${code}_`));
}
