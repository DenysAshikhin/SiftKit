import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SYNC_ATTEMPTS = 20;
const SYNC_DELAY_MS = 25;
const ASYNC_ATTEMPTS = 40;
const ASYNC_DELAY_MS = 100;

/** One removal attempt. The only place `fs.rmSync` is called, so both wrappers agree. */
function tryRemoveDirectory(directory: string): boolean {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Blocking removal, for `process.on('exit')` where nothing async can run. Returns whether the
 * path is gone. The window is deliberately short — by exit time every teardown has already
 * run, so a directory that is still locked is a live process, and no retry budget fixes that.
 */
export function removeDirectorySync(
  directory: string,
  attempts: number = SYNC_ATTEMPTS,
  delayMs: number = SYNC_DELAY_MS,
): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (tryRemoveDirectory(directory)) {
      return true;
    }
    if (attempt < attempts - 1) {
      waitSync(delayMs);
    }
  }
  return false;
}

/**
 * Removal from async test code, yielding between attempts so whatever holds the directory can
 * finish closing. Returns whether the path is gone; callers that leak temp directories depend
 * on the answer, so it is never swallowed.
 */
export async function removeDirectoryWithRetries(
  directory: string,
  attempts: number = ASYNC_ATTEMPTS,
  delayMs: number = ASYNC_DELAY_MS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (tryRemoveDirectory(directory)) {
      return true;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/** Owns every temp directory a test file creates so none can be forgotten. */
export class TempDirRegistry {
  private readonly directories: string[] = [];

  get pendingCount(): number {
    return this.directories.length;
  }

  create(prefix: string): string {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    this.directories.push(directory);
    return directory;
  }

  /** Takes ownership of a directory made elsewhere. Used by the registry's own tests. */
  adopt(directory: string): void {
    this.directories.push(directory);
  }

  /** Removes every registered directory and forgets them all. Returns the ones that survived. */
  removeAll(attempts: number = SYNC_ATTEMPTS, delayMs: number = SYNC_DELAY_MS): string[] {
    const survivors: string[] = [];
    for (const directory of this.directories) {
      if (!removeDirectorySync(directory, attempts, delayMs)) {
        survivors.push(directory);
      }
    }
    this.directories.length = 0;
    return survivors;
  }
}

const fileRegistry = new TempDirRegistry();

// Not a node:test `after()` hook. Root after() hooks run in registration order, so one
// registered when this module is imported would run BEFORE the test file's own teardown —
// before the server is closed or the child is killed — and race the very thing holding the
// directory. `exit` runs after every hook. Cost: it must be synchronous.
process.on('exit', () => {
  const survivors = fileRegistry.removeAll();
  if (survivors.length === 0) {
    return;
  }
  let report = `\nTEMP DIRECTORIES LEFT BEHIND (${process.argv[1]}):\n`;
  for (const directory of survivors) {
    report += `  - ${directory}\n`;
  }
  // Loud, not fatal: failing here would hide whatever the test itself proved. A survivor is
  // almost always a spawned process that outlived its test — fix that, do not retry harder.
  process.stderr.write(report);
});

/**
 * Creates a temp directory removed automatically once this test file's process exits. Every
 * test that needs a scratch directory must use this instead of `fs.mkdtempSync`, which
 * `tests/test-hygiene-gate.test.ts` enforces.
 */
export function createManagedTempDir(prefix: string): string {
  return fileRegistry.create(prefix);
}