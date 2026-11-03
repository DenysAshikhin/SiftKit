import assert from 'node:assert/strict';
import test from 'node:test';

import { cutDigest, digestOutput, digestToolOutput, renderDigests } from '../src/output-digest/digest.ts';
import type { ToolDigest } from '../src/output-digest/types.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';

const PYTEST: ToolDigest = { tool: 'pytest', failed: true, counts: [{ label: 'failed', value: 2 }, { label: 'passed', value: 1 }], failures: [
  { name: 'test_compares_lists', location: 'test_math.py:4', message: ['AssertionError: assert 1 == 2', '  Use -v to get more diff'] },
  { name: 'test_imports', location: null, message: [] },
] };
const ESLINT: ToolDigest = { tool: 'eslint', failed: true, counts: [{ label: 'errors', value: 1 }, { label: 'warnings', value: 0 }], failures: [
  { name: "'x' is not defined (no-undef)", location: 'src/a.js:3:29', message: [] },
] };

test('a passing tool renders as its verdict and counts on one line', () => {
  assert.equal(renderDigests(digestToolOutput(readDigestFixture('node-test/pass.txt'))),
    'Digest of the whole output:\nnode:test: passed (5 tests, 4 pass, 0 fail, 0 cancelled, 1 skipped, 0 todo)');
});

test('every failure of every tool is listed with its location before any details', () => {
  assert.equal(renderDigests([PYTEST, ESLINT]), [
    'Digest of the whole output:',
    'pytest: FAILED (2 failed, 1 passed)',
    '✖ test_compares_lists — test_math.py:4',
    '✖ test_imports',
    'eslint: FAILED (1 errors, 0 warnings)',
    "✖ 'x' is not defined (no-undef) — src/a.js:3:29",
    'Details:',
    '✖ test_compares_lists',
    '  AssertionError: assert 1 == 2',
    '    Use -v to get more diff',
  ].join('\n'));
});

test('a failure message is capped at 12 lines and says how many it left out', () => {
  const message = Array.from({ length: 40 }, (unused, index) => `diff line ${index}`);
  const rendered = renderDigests([{ ...PYTEST, failures: [{ name: 'big diff', location: 'x.py:1', message }] }]) ?? '';
  const details = rendered.split('\nDetails:\n')[1]?.split('\n') ?? [];
  assert.deepEqual(details, ['✖ big diff', ...message.slice(0, 12).map((line) => `  ${line}`), '  … 28 more lines']);
});

test('output no parser recognises has no digest', () => {
  assert.deepEqual(digestToolOutput('Compiling 3 files...\nerror: something odd happened\nDone in 2.1s.'), []);
  assert.equal(renderDigests([]), null);
  assert.equal(digestOutput('Done in 2.1s.'), null);
});

test('digesting output gives its rendered digest and whether any recognised tool failed', () => {
  assert.deepEqual(digestOutput(readDigestFixture('jest/pass.txt')),
    { failed: false, text: renderDigests(digestToolOutput(readDigestFixture('jest/pass.txt'))) });
  assert.equal(digestOutput(readDigestFixture('pytest/fail.txt'))?.failed, true);
});

test('a digest cut to a size keeps its first whole lines and says how many it left out', () => {
  const digest = ['Digest of the whole output:', ...Array.from({ length: 100 }, (unused, index) => `✖ test_${index} — t.py:${index}`)].join('\n');
  assert.equal(cutDigest(digest, digest.length), digest);
  const cut = cutDigest(digest, 200);
  assert.ok(cut.length <= 200, cut);
  const lines = cut.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['Digest of the whole output:', '✖ test_0 — t.py:0', '✖ test_1 — t.py:1']);
  assert.equal(lines.at(-1), `… ${101 - (lines.length - 1)} more digest lines`);
});
