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
} from '../helpers/temp-dirs.js';

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
