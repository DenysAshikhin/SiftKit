import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnDirectCommand } from '../src/lib/command-spawn.js';

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