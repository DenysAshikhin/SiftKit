import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { resolveTestTargets } from '../scripts/test-targets.ts';

test('resolveTestTargets maps bare test basenames into the tests directory', () => {
  const resolved = resolveTestTargets(process.cwd(), ['mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, [path.join('tests', 'mock-repo-search-loop.test.ts')]);
});

test('resolveTestTargets preserves explicit test paths', () => {
  const resolved = resolveTestTargets(process.cwd(), ['.\\tests\\mock-repo-search-loop.test.ts']);
  assert.deepEqual(resolved, ['.\\tests\\mock-repo-search-loop.test.ts']);
});

test('resolveTestTargets preserves option values while still resolving later positional targets', () => {
  const resolved = resolveTestTargets(process.cwd(), [
    '--test-name-pattern',
    'runTaskLoop auto-accepts non-thinking finish after ten tool calls without follow-up',
    'mock-repo-search-loop.test.ts',
  ]);
  assert.deepEqual(resolved, [
    '--test-name-pattern',
    'runTaskLoop auto-accepts non-thinking finish after ten tool calls without follow-up',
    path.join('tests', 'mock-repo-search-loop.test.ts'),
  ]);
});
