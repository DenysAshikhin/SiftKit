import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { writeManagedEngineLauncher } from '../helpers/managed-engine-fixtures.js';
import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.js';

test('managed engine fixture launches the fake TabbyAPI from the fake venv and exposes lifecycle observation files', async () => {
  const tempRoot = createManagedTempDir('siftkit-managed-launcher-fixture-');
  try {
    const managed = writeManagedEngineLauncher(tempRoot, 12345, 'fixture-model', {
      initialUnloadedModelProbeCount: 2,
      deferredLogLine: 'deferred fixture log',
    });

    assert.equal(managed.engine.PythonPath, managed.pythonPath);
    assert.equal(managed.engine.Entrypoint, managed.scriptPath);
    assert.equal(managed.engine.ModelRoot, path.dirname(managed.modelPath));
    assert.equal(path.basename(managed.modelPath), 'fixture-model');
    assert.equal(fs.existsSync(path.join(managed.modelPath, 'config.json')), true);
    assert.equal(fs.existsSync(managed.probeShimPath), true);
    assert.equal(path.dirname(managed.modelProbeCountPath), tempRoot);
    assert.equal(path.dirname(managed.deferredLogMarkerPath), tempRoot);
    assert.equal(path.dirname(managed.pidFilePath), tempRoot);
  } finally {
    await removeDirectoryWithRetries(tempRoot);
  }
});
