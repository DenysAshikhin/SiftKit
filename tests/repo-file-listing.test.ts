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
