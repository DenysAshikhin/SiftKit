import Database from 'better-sqlite3';

import {
  readRuntimeDatabaseImage,
  writeRuntimeDatabaseImage,
  type RuntimeDatabase,
} from '../../src/state/runtime-db.js';

/** A detached raw copy of what is stored at the path, open or closed, with no bootstrap; the caller closes it. */
export function openStoredRuntimeDatabase(databasePath: string): RuntimeDatabase {
  const image = readRuntimeDatabaseImage(databasePath);
  if (image === null) throw new Error(`No runtime database is stored at ${databasePath}.`);
  return new Database(image);
}

/** Edits the stored database raw, with no bootstrap; `empty` starts from a blank database instead. */
export function rewriteStoredRuntimeDatabase<T>(
  databasePath: string,
  edit: (database: RuntimeDatabase) => T,
  start: 'stored' | 'empty' = 'stored',
): T {
  const database = start === 'empty' ? new Database(':memory:') : openStoredRuntimeDatabase(databasePath);
  try {
    const result = edit(database);
    writeRuntimeDatabaseImage(databasePath, database.serialize());
    return result;
  } finally {
    database.close();
  }
}
