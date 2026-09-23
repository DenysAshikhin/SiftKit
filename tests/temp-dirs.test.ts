import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getRuntimeDatabase, isRuntimeDatabaseOpen } from '../src/state/runtime-db.js';
import {
  TEMP_DIR_LEAK_HEADER,
  TempDirRegistry,
  createManagedTempDir,
  formatTempDirLeakReport,
  sweepManagedTempDirs,
} from './helpers/temp-dirs.js';

test('TempDirRegistry creates a directory under the OS temp dir', () => {
  const registry = new TempDirRegistry();
  try {
    const directory = registry.create('siftkit-registry-test-');
    assert.equal(fs.existsSync(directory), true);
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(directory), /^siftkit-registry-test-/u);
    assert.equal(registry.pendingCount, 1);
  } finally {
    registry.removeAll();
  }
});

test('TempDirRegistry rejects a temp root inside the application checkout', () => {
  const registry = new TempDirRegistry();
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  try {
    process.env.TEMP = process.cwd();
    process.env.TMP = process.cwd();
    process.env.TMPDIR = process.cwd();
    assert.throws(() => registry.create('siftkit-rejected-root-'), /outside.*checkout/u);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    registry.removeAll();
  }
});

test('TempDirRegistry.removeAll deletes every directory it handed out', () => {
  const registry = new TempDirRegistry();
  const first = registry.create('siftkit-registry-test-');
  const second = registry.create('siftkit-registry-test-');
  fs.writeFileSync(path.join(first, 'nested.txt'), 'content', 'utf8');
  fs.mkdirSync(path.join(second, 'sub'));

  assert.deepEqual(registry.removeAll(), []);

  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
});

test('TempDirRegistry.removeAll forgets directories so a second call is a no-op', () => {
  const registry = new TempDirRegistry();
  const directory = registry.create('siftkit-registry-test-');
  registry.removeAll();
  assert.equal(registry.pendingCount, 0);
  assert.deepEqual(registry.removeAll(), []);
  assert.equal(fs.existsSync(directory), false);
});

test('TempDirRegistry.removeAll tolerates a directory deleted out from under it', () => {
  const registry = new TempDirRegistry();
  const directory = registry.create('siftkit-registry-test-');
  fs.rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(registry.removeAll(), []);
});

test('formatTempDirLeakReport names every survivor under one header', () => {
  assert.equal(formatTempDirLeakReport([]), '');

  const report = formatTempDirLeakReport(['/tmp/first', '/tmp/second']);

  assert.equal(report.includes(TEMP_DIR_LEAK_HEADER), true, report);
  assert.equal(report.includes(process.argv[1] ?? ''), true, report);
  assert.equal(report.includes('  - /tmp/first\n'), true, report);
  assert.equal(report.includes('  - /tmp/second\n'), true, report);
});

// The cached runtime DB handle is the one holder the sweep can release itself. Owning it here
// is what keeps every test file from needing its own `after(() => closeAllRuntimeDatabases())`.
test('sweepManagedTempDirs releases the cached runtime database before removing', () => {
  const directory = createManagedTempDir('siftkit-registry-db-');
  const databasePath = path.join(directory, 'runtime.sqlite');
  getRuntimeDatabase(databasePath);
  assert.equal(isRuntimeDatabaseOpen(databasePath), true);

  assert.deepEqual(sweepManagedTempDirs(), []);

  assert.equal(isRuntimeDatabaseOpen(databasePath), false);
  assert.equal(fs.existsSync(directory), false);
});
