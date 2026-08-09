import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseJsonText } from '../src/lib/json.js';
import { z } from '../src/lib/zod.js';

const PackageMetadataSchema = z.object({
  bundleDependencies: z.array(z.string()).optional(),
});

const PackOutputSchema = z.array(z.object({
  files: z.array(z.object({ path: z.string() })),
}));

const repoRoot = process.cwd();

test('package metadata bundles the private contracts workspace', () => {
  const packageJson = parseJsonText(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    PackageMetadataSchema,
  );

  assert.deepEqual(packageJson.bundleDependencies, ['@siftkit/contracts']);
});

test('prebuilt npm pack manifest includes the compiled contracts entrypoint', () => {
  const artifacts = parseJsonText(
    fs.readFileSync(path.join(repoRoot, '.test-build', 'npm-pack-dry-run.json'), 'utf8'),
    PackOutputSchema,
  );
  const artifact = artifacts[0];
  assert.ok(artifact);

  let contractsEntrypointFound = false;
  for (const file of artifact.files) {
    if (file.path === 'node_modules/@siftkit/contracts/dist/index.js') {
      contractsEntrypointFound = true;
      break;
    }
  }
  assert.equal(contractsEntrypointFound, true);
});
