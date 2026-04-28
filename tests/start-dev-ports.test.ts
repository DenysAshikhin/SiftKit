import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildStartupPortChecks } from '../scripts/start-dev-ports.ts';

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
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
