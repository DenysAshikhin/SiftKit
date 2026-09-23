import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  closeAllRuntimeDatabases,
  closeRuntimeDatabase,
  getRuntimeDatabase,
  getRuntimeDatabaseFilePath,
  getRuntimeDatabaseStorage,
  getRuntimeMetadataValue,
  readRuntimeDatabaseImage,
  runtimeDatabaseExists,
  setRuntimeMetadataValue,
  writeRuntimeDatabaseImage,
} from '../src/state/runtime-db.js';
import { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const MarkerRowSchema = z.object({ value: z.string() });

test('the default suite keeps runtime databases in memory and never creates the file', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-memory-db-'), 'runtime.sqlite');
  setRuntimeMetadataValue(getRuntimeDatabase(databasePath), 'marker', 'in-memory');

  assert.equal(getRuntimeDatabaseStorage(), 'memory');
  assert.equal(getRuntimeMetadataValue('marker', databasePath), 'in-memory');
  assert.equal(fs.existsSync(databasePath), false);
  closeRuntimeDatabase(databasePath);
});

test('a closed in-memory database keeps its rows for the next open of the same path', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-memory-reopen-'), 'runtime.sqlite');
  setRuntimeMetadataValue(getRuntimeDatabase(databasePath), 'marker', 'after-close');
  closeRuntimeDatabase(databasePath);
  assert.equal(getRuntimeMetadataValue('marker', databasePath), 'after-close');

  setRuntimeMetadataValue(getRuntimeDatabase(databasePath), 'marker', 'after-close-all');
  closeAllRuntimeDatabases();
  assert.equal(getRuntimeMetadataValue('marker', databasePath), 'after-close-all');
  closeRuntimeDatabase(databasePath);
});

test('distinct paths are distinct in-memory databases', () => {
  const root = createManagedTempDir('siftkit-memory-distinct-');
  const firstPath = path.join(root, 'first', 'runtime.sqlite');
  const secondPath = path.join(root, 'second', 'runtime.sqlite');
  setRuntimeMetadataValue(getRuntimeDatabase(firstPath), 'marker', 'first');

  assert.equal(getRuntimeMetadataValue('marker', secondPath), null);
  closeAllRuntimeDatabases();
});

test('a database file seeded on disk is loaded when its path has no in-memory image', () => {
  const root = createManagedTempDir('siftkit-memory-seeded-');
  const sourcePath = path.join(root, 'source.sqlite');
  const seededPath = path.join(root, 'seeded.sqlite');
  const source = getRuntimeDatabase(sourcePath);
  setRuntimeMetadataValue(source, 'marker', 'seeded');
  fs.writeFileSync(seededPath, source.serialize());

  assert.equal(getRuntimeMetadataValue('marker', seededPath), 'seeded');
  closeAllRuntimeDatabases();
});

test('runtime database existence covers open, closed and never-opened paths', () => {
  const root = createManagedTempDir('siftkit-memory-exists-');
  const databasePath = path.join(root, 'runtime.sqlite');

  assert.equal(runtimeDatabaseExists(databasePath), false);
  getRuntimeDatabase(databasePath);
  assert.equal(runtimeDatabaseExists(databasePath), true);
  closeRuntimeDatabase(databasePath);
  assert.equal(runtimeDatabaseExists(databasePath), true);
});

test('an in-memory connection reports the path it was opened for', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-memory-path-'), 'runtime.sqlite');

  assert.equal(getRuntimeDatabaseFilePath(getRuntimeDatabase(databasePath)), path.resolve(databasePath));
  closeRuntimeDatabase(databasePath);
});

test('a stored database image can be read raw whether its path is open, closed or never opened', () => {
  const root = createManagedTempDir('siftkit-memory-image-read-');
  const databasePath = path.join(root, 'runtime.sqlite');
  assert.equal(readRuntimeDatabaseImage(databasePath), null);

  setRuntimeMetadataValue(getRuntimeDatabase(databasePath), 'marker', 'open');
  assert.equal(readMarker(readRuntimeDatabaseImage(databasePath)), 'open');
  closeRuntimeDatabase(databasePath);
  assert.equal(readMarker(readRuntimeDatabaseImage(databasePath)), 'open');
});

test('a rewritten image is what the next open of a closed path sees', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-memory-image-write-'), 'runtime.sqlite');
  getRuntimeDatabase(databasePath);
  closeRuntimeDatabase(databasePath);
  const raw = new Database(requireImage(databasePath));
  setRuntimeMetadataValue(raw, 'marker', 'rewritten');
  writeRuntimeDatabaseImage(databasePath, raw.serialize());
  raw.close();

  assert.equal(getRuntimeMetadataValue('marker', databasePath), 'rewritten');
  closeRuntimeDatabase(databasePath);
});

test('rewriting the image of an open path fails loudly instead of racing its connection', () => {
  const databasePath = path.join(createManagedTempDir('siftkit-memory-image-open-'), 'runtime.sqlite');
  const image = getRuntimeDatabase(databasePath).serialize();

  assert.throws(() => writeRuntimeDatabaseImage(databasePath, image), /is open/u);
  closeRuntimeDatabase(databasePath);
});

function requireImage(databasePath: string): Buffer {
  const image = readRuntimeDatabaseImage(databasePath);
  if (image === null) throw new Error(`No image stored at ${databasePath}.`);
  return image;
}

function readMarker(image: Buffer | null): string | null {
  if (image === null) return null;
  const raw = new Database(image);
  try {
    return MarkerRowSchema.parse(raw.prepare("SELECT value FROM runtime_metadata WHERE key = 'marker'").get()).value;
  } finally {
    raw.close();
  }
}

test('an in-memory database creates no directory for its path', () => {
  const root = createManagedTempDir('siftkit-memory-no-dir-');
  const databasePath = path.join(root, 'nested', '.siftkit', 'runtime.sqlite');
  getRuntimeDatabase(databasePath);

  assert.equal(fs.existsSync(path.join(root, 'nested')), false);
  closeRuntimeDatabase(databasePath);
});
