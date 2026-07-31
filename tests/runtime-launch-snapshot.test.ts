import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  writeRuntimeLaunchSnapshot,
  readRuntimeLaunchSnapshot,
  type RuntimeLaunchSnapshot,
} from '../src/status-server/runtime-launch-snapshot.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

// The cached runtime DB handle keeps a file inside the temp dir open on Windows, which
// blocks the exit-time registry sweep. Root after() runs before the exit handler.
after(() => closeRuntimeDatabase());

function tempDbPath(): string {
  const dbPath = path.join(createManagedTempDir('sk-snap-'), 'runtime.sqlite');
  getRuntimeDatabase(dbPath);
  return dbPath;
}

test('returns null when no snapshot has been written', () => {
  const dbPath = tempDbPath();
  assert.equal(readRuntimeLaunchSnapshot(dbPath), null);
});

test('round-trips a written snapshot', () => {
  const dbPath = tempDbPath();
  const snapshot: RuntimeLaunchSnapshot = {
    Model: 'qwen.gguf',
    LlamaCpp: { BaseUrl: 'http://127.0.0.1:8097', NumCtx: 85000, Reasoning: 'off' },
  };
  writeRuntimeLaunchSnapshot(dbPath, snapshot);
  assert.deepEqual(readRuntimeLaunchSnapshot(dbPath), snapshot);
});

test('overwrites a previous snapshot', () => {
  const dbPath = tempDbPath();
  writeRuntimeLaunchSnapshot(dbPath, { Model: 'a', LlamaCpp: { NumCtx: 1 } });
  writeRuntimeLaunchSnapshot(dbPath, { Model: 'b', LlamaCpp: { NumCtx: 2 } });
  assert.deepEqual(readRuntimeLaunchSnapshot(dbPath), { Model: 'b', LlamaCpp: { NumCtx: 2 } });
});
