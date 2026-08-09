import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import {
  TEMP_DIR_LEAK_HEADER,
  TempDirRegistry,
  createManagedTempDir,
  formatTempDirLeakReport,
  removeDirectorySync,
  removeDirectoryWithRetries,
  sweepManagedTempDirs,
} from './helpers/temp-dirs.js';

/**
 * Returns a directory that cannot be removed, and the kill switch that frees it. A live child
 * process whose cwd is the directory is the only thing that reliably makes fs.rmSync throw
 * EPERM on Windows — an open file handle does not.
 */
async function lockDirectory(): Promise<{ directory: string; release: () => Promise<void> }> {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-lock-'));
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setTimeout(() => {}, 30_000)"], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error('Directory lock child has no stdout pipe.');
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onData = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Directory lock child exited before ready with code ${code}.`));
    };
    stdout.once('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return {
    directory,
    release: async (): Promise<void> => {
      if (child.exitCode !== null) {
        return;
      }
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    },
  };
}

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

test('TempDirRegistry.removeAll returns the directories it could not delete', async () => {
  const locked = await lockDirectory();
  const registry = new TempDirRegistry();
  const removable = registry.create('siftkit-registry-test-');
  registry.adopt(locked.directory);

  const survivors = registry.removeAll(2, 10);

  assert.deepEqual(survivors, [locked.directory]);
  assert.equal(fs.existsSync(removable), false);
  assert.equal(registry.pendingCount, 0);

  await locked.release();
  fs.rmSync(locked.directory, { recursive: true, force: true });
});

test('removeDirectorySync reports success and failure', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-sync-'));
  assert.equal(removeDirectorySync(directory, 2, 10), true);
  assert.equal(fs.existsSync(directory), false);

  const locked = await lockDirectory();
  assert.equal(removeDirectorySync(locked.directory, 2, 10), false);
  await locked.release();
  fs.rmSync(locked.directory, { recursive: true, force: true });
});

test('removeDirectoryWithRetries reports success and failure', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-async-'));
  assert.equal(await removeDirectoryWithRetries(directory, 2, 10), true);
  assert.equal(fs.existsSync(directory), false);

  const missing = path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-async-absent-does-not-exist');
  assert.equal(await removeDirectoryWithRetries(missing, 2, 10), true);

  const locked = await lockDirectory();
  assert.equal(await removeDirectoryWithRetries(locked.directory, 2, 10), false);
  await locked.release();
  fs.rmSync(locked.directory, { recursive: true, force: true });
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
// is what keeps every test file from needing its own `after(() => closeRuntimeDatabase())`.
test('sweepManagedTempDirs releases the cached runtime database before removing', () => {
  const directory = createManagedTempDir('siftkit-registry-db-');
  const databasePath = path.join(directory, 'runtime.sqlite');
  getRuntimeDatabase(databasePath);
  assert.equal(fs.existsSync(databasePath), true);

  assert.deepEqual(sweepManagedTempDirs(), []);

  assert.equal(fs.existsSync(directory), false);
});
