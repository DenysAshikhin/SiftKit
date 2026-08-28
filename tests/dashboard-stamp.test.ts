import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { computeDashboardStamp } from '../scripts/dashboard-stamp.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function writeFixtureRepo(root: string): void {
  fs.mkdirSync(path.join(root, 'dashboard', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'contracts', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'App.tsx'), 'export const App = 1;');
  fs.writeFileSync(path.join(root, 'packages', 'contracts', 'src', 'index.ts'), 'export const c = 1;');
  fs.writeFileSync(path.join(root, 'dashboard', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'dashboard', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'dashboard', 'vite.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(root, 'dashboard', 'tsconfig.json'), '{}');
}

test('computeDashboardStamp is deterministic for identical inputs', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);

  assert.equal(computeDashboardStamp(root), computeDashboardStamp(root));
});

test('computeDashboardStamp changes when a source file content changes', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);
  const before = computeDashboardStamp(root);

  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'App.tsx'), 'export const App = 2;');

  assert.notEqual(computeDashboardStamp(root), before);
});

test('computeDashboardStamp changes when a new source file appears', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);
  const before = computeDashboardStamp(root);

  fs.writeFileSync(path.join(root, 'dashboard', 'src', 'New.tsx'), 'export const n = 1;');

  assert.notEqual(computeDashboardStamp(root), before);
});

test('computeDashboardStamp fails loudly when a pinned input file is missing', () => {
  const root = createManagedTempDir('dashboard-stamp-');
  writeFixtureRepo(root);
  fs.rmSync(path.join(root, 'dashboard', 'index.html'));

  assert.throws(() => computeDashboardStamp(root), /Expected dashboard stamp input/u);
});
