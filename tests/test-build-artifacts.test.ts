import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('test bundling does not rewrite source modules or lie about side effects', () => {
  const builderSource = fs.readFileSync(path.resolve('scripts', 'build-test.ts'), 'utf8');

  assert.doesNotMatch(builderSource, /locationSensitiveModulePaths|entrypointModulePaths/u);
  assert.doesNotMatch(builderSource, /contents\.replace|sideEffects:\s*false/u);
  assert.doesNotMatch(builderSource, /preserveLocationDependentModules|external:\s*true/u);
});

test('compiled test entrypoints are isolated wrappers over bundled module graphs', () => {
  const entrypoint = path.resolve('.test-build', 'tests', 'test-build-artifacts.test.js');
  const bundle = path.resolve('.test-build', 'tests', 'test-build-artifacts.test.bundle.js');

  assert.equal(fs.readFileSync(entrypoint, 'utf8').trim(), "import './test-build-artifacts.test.bundle.js';");
  assert.equal(fs.existsSync(bundle), true, bundle);
});

test('compiled test runner loads only emitted runtime dependencies', async () => {
  const targetUrl = pathToFileURL(path.resolve('dist', 'test-runner', 'test-targets.js')).href;

  await assert.doesNotReject(import(targetUrl));
});
