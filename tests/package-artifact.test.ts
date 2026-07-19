import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

const repoRoot = path.resolve(__dirname, '..');

test('package metadata bundles the private contracts workspace', () => {
  const packageJson = parseJsonText(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    PackageMetadataSchema,
  );

  assert.deepEqual(packageJson.bundleDependencies, ['@siftkit/contracts']);
});

test('npm pack includes the compiled contracts entrypoint', () => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(`${npmCommand} pack --dry-run --json --ignore-scripts`, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
  });
  assert.equal(result.status, 0, result.stderr);

  const artifacts = parseJsonText(result.stdout, PackOutputSchema);
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
