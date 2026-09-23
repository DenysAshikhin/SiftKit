import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDashboardLaunch } from '../scripts/start-dev-dashboard.js';
import { readPackageJson } from './helpers/package-json.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

test('dev mode launches the hot-reloading dashboard', () => {
  assert.deepEqual(resolveDashboardLaunch(false, createManagedTempDir('siftkit-dash-dev-')), { kind: 'script', script: 'start:dashboard' });
});

test('stable mode serves the built dashboard when a build exists', () => {
  const root = createManagedTempDir('siftkit-dash-stable-');
  fs.mkdirSync(path.join(root, 'dashboard', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'dist', 'index.html'), '<html></html>', 'utf8');
  assert.deepEqual(resolveDashboardLaunch(true, root), { kind: 'script', script: 'start:dashboard:stable' });
});

test('stable mode refuses to start without a dashboard build', () => {
  const root = createManagedTempDir('siftkit-dash-missing-');
  assert.deepEqual(resolveDashboardLaunch(true, root), {
    kind: 'missing_build', indexPath: path.join(root, 'dashboard', 'dist', 'index.html'),
  });
});

test('stable dashboard script previews the build instead of running the dev server', () => {
  assert.equal(readPackageJson().scripts?.['start:dashboard:stable'], 'npm --prefix .\\dashboard run preview');
});
