import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { isBackendReadyStatusCode } from '../scripts/start-dev-health.ts';
import { buildStartupPortChecks, getStatusServerPort, waitForPortListening } from '../scripts/start-dev-ports.ts';
import { stopChildProcessTree } from '../scripts/start-dev-process.ts';
import { readPackageJson } from './helpers/package-json.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

test('start-dev preflights both status and dashboard ports before spawning services', () => {
  const tempRoot = createManagedTempDir('siftkit-start-dev-');
  const dashboardPackagePath = path.join(tempRoot, 'dashboard-package.json');
  fs.writeFileSync(
    dashboardPackagePath,
    JSON.stringify({
      scripts: {
        dev: 'vite --host 127.0.0.1 --port 6876 --strictPort --force',
      },
    }),
    'utf8',
  );

  try {
    const checks = buildStartupPortChecks(
      {
        SIFTKIT_STATUS_HOST: '127.0.0.1',
        SIFTKIT_STATUS_PORT: '4765',
      },
      dashboardPackagePath,
    );

    assert.deepEqual(checks, {
      status: { name: 'status server', host: '127.0.0.1', port: 4765, fatalIfInUse: true },
      dashboard: { name: 'dashboard', host: '127.0.0.1', port: 6876, fatalIfInUse: false },
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('start-dev waits for successful backend health, not degraded startup health', () => {
  assert.equal(isBackendReadyStatusCode(200), true);
  assert.equal(isBackendReadyStatusCode(204), true);
  assert.equal(isBackendReadyStatusCode(302), false);
  assert.equal(isBackendReadyStatusCode(503), false);
});

test('start-dev shutdown kills child process trees on Windows', () => {
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  let fallbackKillCalled = false;
  const stopped = stopChildProcessTree(
    {
      pid: 1234,
      killed: false,
      kill() {
        fallbackKillCalled = true;
        return true;
      },
    },
    {
      platform: 'win32',
      spawnSync(command: string, args: string[]) {
        spawnCalls.push({ command, args });
        return { status: 0 };
      },
    },
  );

  assert.equal(stopped, true);
  assert.deepEqual(spawnCalls, [{
    command: 'taskkill',
    args: ['/PID', '1234', '/T', '/F'],
  }]);
  assert.equal(fallbackKillCalled, false);
});

test('stable status script starts the full stable dev stack', () => {
  const packageJson = readPackageJson();

  assert.equal(packageJson.scripts?.['start:status:stable'], 'node .\\scripts\\start-dev.ts --stable');
  assert.equal(packageJson.scripts?.['start:status:stable:server'], 'node .\\src\\status-server\\main.ts');
});

test('status server port derives from one exported helper', () => {
  assert.equal(getStatusServerPort({}), 4765);
  assert.equal(getStatusServerPort({ SIFTKIT_STATUS_PORT: '5123' }), 5123);
});

/** Binds a free loopback port, then frees it so nothing listens there. */
async function reserveFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The probe server has no TCP address.');
  await new Promise((resolve) => { server.close(resolve); });
  return address.port;
}

test('start-dev waits for a port that starts listening later', async (t) => {
  const port = await reserveFreePort();
  const server = net.createServer();
  t.after(() => { server.close(); });
  setTimeout(() => { server.listen(port, '127.0.0.1'); }, 300);
  assert.equal(await waitForPortListening('127.0.0.1', port, 5_000), true);
});

test('start-dev stops waiting for a port that never listens', async () => {
  const port = await reserveFreePort();
  const startedAt = Date.now();
  assert.equal(await waitForPortListening('127.0.0.1', port, 600), false);
  // One refused probe on Windows can take up to its 1 s socket timeout
  assert.ok(Date.now() - startedAt < 5_000, 'the wait ends near its timeout');
});
