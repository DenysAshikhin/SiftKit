import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildStartupPortChecks } from '../scripts/start-dev-ports.ts';
import { stopChildProcessTree } from '../scripts/start-dev-process.ts';

test('start-dev preflights both status and dashboard ports before spawning services', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-start-dev-'));
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

    assert.deepEqual(
      checks.map((check) => `${check.name}:${check.host}:${check.port}`),
      [
        'status server:127.0.0.1:4765',
        'dashboard:127.0.0.1:6876',
      ],
    );
    assert.deepEqual(
      checks.map((check) => `${check.service}:${check.fatalIfInUse}`),
      [
        'status:true',
        'dashboard:false',
      ],
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.['start:status:stable'], 'tsx .\\scripts\\start-dev.ts --stable');
  assert.equal(packageJson.scripts?.['start:status:stable:server'], 'node .\\dist\\status-server\\index.js');
});
