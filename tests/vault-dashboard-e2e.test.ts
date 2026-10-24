import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { bootstrapAssistantToken } from '../dashboard/src/api.ts';
import {
  createVaultNote, exportVaultArchive, getVaultGraph, getVaultNote, getVaultStats, resolveVaultTitle, searchVault,
  updateVaultNote, VaultRequestError,
} from '../dashboard/src/vault-api.ts';
import { getConfigPath } from '../src/config/index.ts';
import { getDefaultConfig, writeConfig } from '../src/status-server/config-store.ts';
import { startStatusServer } from '../src/status-server/index.ts';
import { closeHttpServer, getAddressInfo } from './helpers/dashboard-http.ts';
import {
  configureDashboardTestEnv,
  enterDashboardTestRepo,
  restoreDashboardTestRepo,
} from './helpers/dashboard-test-repo.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.ts';

test('dashboard vault client writes, reads and conflicts against a live status server', { concurrency: false }, async () => {
  const tempRoot = createManagedTempDir('siftkit-vault-dashboard-');
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  writeConfig(getConfigPath(), { ...config, Assistant: { ...config.Assistant, Enabled: true } });
  const server = startStatusServer({ disableManagedEngineStartup: true });
  await server.startupPromise;
  const address = getAddressInfo(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hostFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === 'string' && input.startsWith('/')
        ? `${baseUrl}${input}`
        : input;
      return hostFetch(target, init);
    },
  });

  try {
    const token = await bootstrapAssistantToken();
    const git = await createVaultNote(token, 'Git');
    const editor = await createVaultNote(token, 'Visual Studio Code');
    const edited = await updateVaultNote(token, editor.id, { body: 'Your editor.\n\n**Uses** [[Git]] · [[Ghost]]' }, editor.revision);
    assert.equal(edited.revision, 2);

    const detail = await getVaultNote(token, editor.id);
    assert.deepEqual(detail.outgoing.resolved.map((note) => note.id), [git.id]);
    assert.deepEqual(detail.outgoing.unresolved, ['ghost']);
    assert.equal(await resolveVaultTitle(token, 'git'), git.id);
    assert.equal((await searchVault(token, 'visual', 10)).hits[0]?.note.id, editor.id);
    assert.deepEqual((await getVaultGraph(token)).edges, [{ source: [git.id, editor.id].sort()[0], target: [git.id, editor.id].sort()[1] }]);
    assert.equal((await getVaultStats(token)).notes, 2);

    await assert.rejects(updateVaultNote(token, editor.id, { body: 'stale' }, 1), (error: Error) => {
      assert.ok(error instanceof VaultRequestError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'conflict');
      return true;
    });
    const archive = await exportVaultArchive(token);
    assert.ok(archive.size > 0);
    assert.doesNotMatch(JSON.stringify(detail), new RegExp(token, 'u'));
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: hostFetch });
    await closeHttpServer(server);
    restoreDashboardTestRepo(previousCwd);
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeDirectoryWithRetries(tempRoot);
  }
});
