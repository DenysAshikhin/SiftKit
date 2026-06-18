import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectCoveredBranchKeys,
  extractTestNames,
  escapeForNamePattern,
  type CoverageFinal,
} from './coverage-attribution-core.js';

test('collectCoveredBranchKeys keeps only taken edges of src files, normalized to posix relpaths', () => {
  const repoRoot = process.cwd();
  const srcPath = `${repoRoot}\\src\\foo\\bar.ts`.replace(/\\/g, '/');
  const nodeModulesPath = `${repoRoot}/node_modules/x/y.ts`;
  const coverage: CoverageFinal = {
    [srcPath]: {
      path: srcPath,
      branchMap: { '0': { line: 1, type: 'if' }, '1': { line: 2, type: 'if' } },
      b: { '0': [3, 0], '1': [0, 0] },
      statementMap: {},
      s: {},
    },
    [nodeModulesPath]: {
      path: nodeModulesPath,
      branchMap: { '0': { line: 9, type: 'if' } },
      b: { '0': [5, 5] },
      statementMap: {},
      s: {},
    },
  };

  const keys = collectCoveredBranchKeys(coverage, repoRoot);

  assert.deepEqual(
    [...keys].sort(),
    ['src/foo/bar.ts|0|0'],
    'only the taken edge (count>0) of the src file survives; node_modules excluded',
  );
});

test('extractTestNames pulls literal names from test()/it() with options arg and mixed quotes', () => {
  const source = [
    `test('plain name', async () => {});`,
    `test("double quoted", () => {});`,
    `test('with "inner" double quotes', () => {});`,
    `test('with timeout opts', { timeout: 5000 }, async () => {});`,
    `  it('indented it block', () => {});`,
    `notTest('should be ignored');`,
  ].join('\n');

  assert.deepEqual(extractTestNames(source), [
    'plain name',
    'double quoted',
    'with "inner" double quotes',
    'with timeout opts',
    'indented it block',
  ]);
});

test('escapeForNamePattern anchors and escapes regex metacharacters', () => {
  assert.equal(
    escapeForNamePattern('finish (a) needs 90% of remaining + 1'),
    '^finish \\(a\\) needs 90% of remaining \\+ 1$',
  );
});
