import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  TempDirRegistry,
  removeDirectorySync,
  removeDirectoryWithRetries,
} from './helpers/temp-dirs.js';

/**
 * Returns a directory that cannot be removed, and the kill switch that frees it. A live child
 * process whose cwd is the directory is the only thing that reliably makes fs.rmSync throw
 * EPERM on Windows — an open file handle does not.
 */
async function lockDirectory(): Promise<{ directory: string; release: () => void }> {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-lock-'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    cwd: directory,
    stdio: 'ignore',
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    directory,
    release: (): void => {
      child.kill();
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

  locked.release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(locked.directory, { recursive: true, force: true });
});

test('removeDirectorySync reports success and failure', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'siftkit-registry-sync-'));
  assert.equal(removeDirectorySync(directory, 2, 10), true);
  assert.equal(fs.existsSync(directory), false);

  const locked = await lockDirectory();
  assert.equal(removeDirectorySync(locked.directory, 2, 10), false);
  locked.release();
  await new Promise((resolve) => setTimeout(resolve, 300));
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
  locked.release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(locked.directory, { recursive: true, force: true });
});