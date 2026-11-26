import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.ts';
import { scanRepoFiles } from '../src/repo-search/prompts.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

test('the repository file listing never advertises runtime state under .siftkit', () => {
  const root = createManagedTempDir('siftkit-listing-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export {};\n');
  fs.mkdirSync(path.join(root, '.siftkit', 'orchestrator', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(root, '.siftkit', 'orchestrator', 'run-1', 'plan.md'), '# Old plan\n');

  const listing = scanRepoFiles(root, buildIgnorePolicy(root));

  assert.match(listing, /src\/main\.ts/u);
  assert.doesNotMatch(listing, /\.siftkit/u);
});

test('the non-code directory summaries sort in byte order, so uppercase names precede lowercase', () => {
  const root = createManagedTempDir('siftkit-listing-');
  fs.mkdirSync(path.join(root, 'B'));
  fs.writeFileSync(path.join(root, 'B', 'x.pdf'), 'x');
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'a', 'y.pdf'), 'y');

  const lines = scanRepoFiles(root, buildIgnorePolicy(root)).split('\n');

  const bIndex = lines.indexOf('B/ [1 .pdf]');
  const aIndex = lines.indexOf('a/ [1 .pdf]');
  assert.notEqual(bIndex, -1, 'the listing should include the B/ summary line');
  assert.notEqual(aIndex, -1, 'the listing should include the a/ summary line');
  assert.ok(bIndex < aIndex, 'byte order puts the uppercase B/ summary before the a/ summary');
});
