import assert from 'node:assert/strict';
import test from 'node:test';

import { closeAllRuntimeDatabases } from '../../src/state/runtime-db.js';
import { archiveEntries, archiveBytes, archiveUploadPath } from '../helpers/archive-bytes.js';
import { seedOwnerAssertion } from '../helpers/gate-e-seed.js';
import { buildService, PROJECTION_SIGNAL, assertProjectionIntegrity } from '../helpers/assistant-gate-e-e2e-fixtures.js';

test('gate E scenario 12: export survives factory reset and restore byte for byte', async () => {
  const { service, context } = buildService('siftkit-gate-e-scenario-12-', []);
  try {
    seedOwnerAssertion(context, { objectName: 'Upsilon Tool' });
    seedOwnerAssertion(context, { objectName: 'Phi Tool' });
    await service.drainJobs();
    await service.memoryMutations.rebuildProjections(context.ownerId, PROJECTION_SIGNAL);

    const before = await archiveEntries(service.exports.export({ includeDecryptedBlobs: false }));
    const backupBytes = await archiveBytes(service.backups.createBackup());

    await service.factoryReset(service.previewFactoryReset().previewToken);
    assert.equal(context.graph.projections.listAllRows(context.ownerId).length, 0);
    assert.equal(service.ownerPersonNodeId, null);

    const preview = await service.previewRestore(archiveUploadPath(backupBytes));
    const result = await service.restore(preview.uploadId, preview.confirmToken);
    assert.deepEqual(result, { ok: true, blobsReadable: true, warning: null });

    const after = await archiveEntries(service.exports.export({ includeDecryptedBlobs: false }));
    assert.deepEqual(
      [...after.entries()].map(([name, data]) => [name, data.toString('base64')]).sort(),
      [...before.entries()].map(([name, data]) => [name, data.toString('base64')]).sort(),
    );

    // The owner is resolved again, so the desktop surfaces answer from the restored graph.
    assert.notEqual(service.ownerPersonNodeId, null);
    const status = service.status();
    assert.equal(status.enabled, true);
    assert.equal(status.available, true);
    const desktop = service.desktopState();
    assert.equal(desktop.assistantEnabled, true);
    assert.equal(desktop.custody.custody, 'file');
    assertProjectionIntegrity(context);
  } finally {
    closeAllRuntimeDatabases();
  }
});
