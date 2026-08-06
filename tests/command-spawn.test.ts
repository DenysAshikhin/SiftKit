import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnDirectCommand } from '../src/lib/command-spawn.js';
import {
  MARKER_DELAY_MS,
  PROCESS_LIFETIME_MS,
  createProcessTreeFixture,
} from './helpers/process-tree-fixture.js';

// Windows child processes need SystemRoot for some node internals; pass it through
// explicitly since a provided env is a full replacement.
function baseEnv(): Record<string, string> {
  const systemRoot = process.env.SystemRoot;
  return systemRoot === undefined ? {} : { SystemRoot: systemRoot };
}

test('spawnDirectCommand with env provides the entire child environment', async () => {
  process.env.SIFT_SPAWN_LEAK_PROBE = 'leaked';
  try {
    const result = await spawnDirectCommand(process.execPath, [
      '-e',
      'process.stdout.write(String(process.env.SIFT_SPAWN_MARKER || "") + "|" + String(process.env.SIFT_SPAWN_LEAK_PROBE || ""))',
    ], { env: { ...baseEnv(), SIFT_SPAWN_MARKER: 'yes' } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'yes|');
  } finally {
    delete process.env.SIFT_SPAWN_LEAK_PROBE;
  }
});

test('spawnDirectCommand without env inherits the parent environment', async () => {
  process.env.SIFT_SPAWN_INHERIT_PROBE = 'inherited';
  try {
    const result = await spawnDirectCommand(process.execPath, [
      '-e',
      'process.stdout.write(String(process.env.SIFT_SPAWN_INHERIT_PROBE || ""))',
    ], {});
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'inherited');
  } finally {
    delete process.env.SIFT_SPAWN_INHERIT_PROBE;
  }
});
test('spawnDirectCommand times out and resolves promptly even when a descendant holds the output pipes', async () => {
  const { parentScript } = createProcessTreeFixture('siftkit-spawn-tree-');
  const startedAt = Date.now();
  const result = await spawnDirectCommand(process.execPath, [parentScript], { timeoutMs: 1_000 });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.exitCode, 124);
  assert.ok(
    elapsedMs < PROCESS_LIFETIME_MS / 2,
    `expected the timeout to settle the promise, but it took ${elapsedMs}ms`,
  );
});

test('spawnDirectCommand timeout terminates descendants, not just the direct child', async () => {
  const { parentScript, markerPath } = createProcessTreeFixture('siftkit-spawn-tree-');
  const result = await spawnDirectCommand(process.execPath, [parentScript], { timeoutMs: 1_000 });
  assert.equal(result.exitCode, 124);
  // Outlive the grandchild's write delay: if the tree kill missed it, the marker appears.
  await delay(MARKER_DELAY_MS + 2_000);
  assert.equal(fs.existsSync(markerPath), false, 'grandchild survived the timeout kill');
});
