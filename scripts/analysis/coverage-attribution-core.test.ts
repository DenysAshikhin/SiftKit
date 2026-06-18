import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCandidates,
  collectCoveredBranchKeys,
  escapeForNamePattern,
  extractTestNames,
  missingBranchKeys,
  type CoverageFinal,
  type TestBranchSet,
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

test('buildCandidates flags A when A\\B is within threshold and reports residual keys', () => {
  const tests: TestBranchSet[] = [
    { index: 0, name: 'broad E2E', branchKeys: ['f|0|0', 'f|1|0', 'f|2|0', 'f|3|0'] },
    { index: 1, name: 'narrow near-dup', branchKeys: ['f|0|0', 'f|1|0', 'f|9|0'] },
    { index: 2, name: 'unrelated', branchKeys: ['g|0|0'] },
  ];

  const candidates = buildCandidates(tests, 1);

  // narrow (index 1) has exactly one branch (f|9|0) not in broad (index 0): residual 1 <= threshold.
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    deleteIndex: 1,
    deleteName: 'narrow near-dup',
    keepIndex: 0,
    keepName: 'broad E2E',
    residualCount: 1,
    residualKeys: ['f|9|0'],
  });
});

test('buildCandidates ignores empty-coverage tests and self-pairs', () => {
  const tests: TestBranchSet[] = [
    { index: 0, name: 'empty', branchKeys: [] },
    { index: 1, name: 'covers', branchKeys: ['f|0|0'] },
  ];
  assert.deepEqual(buildCandidates(tests, 8), []);
});

test('missingBranchKeys returns deleted keys not covered by the union', () => {
  const deleted = ['a|0|0', 'a|1|0', 'a|2|0'];
  const covering = [['a|0|0'], ['a|2|0']];
  assert.deepEqual(missingBranchKeys(deleted, covering), ['a|1|0']);
});
