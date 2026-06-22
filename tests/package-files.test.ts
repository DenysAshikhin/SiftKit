import test from 'node:test';
import assert from 'node:assert/strict';

import { readPackageJson } from './helpers/package-json.js';

test('package files whitelist ships only runtime, not dev harnesses', () => {
  const { files } = readPackageJson();
  assert.ok(!files.includes('eval'), 'eval dir (untracked dev fixtures) must not be packed');
  assert.ok(!files.includes('scripts'), 'broad scripts/ dev tree must not be packed');
  assert.ok(files.includes('scripts/postinstall.js'), 'postinstall hook script must be packed');
  for (const required of ['bin', 'SiftKit', 'dist', 'README.md', 'docs']) {
    assert.ok(files.includes(required), `${required} must be packed`);
  }
});

test('postinstall hook references the packed postinstall script', () => {
  const { scripts } = readPackageJson();
  assert.equal(scripts.postinstall, 'node scripts/postinstall.js');
});

test('coverage test scripts reuse the project test runner instead of raw discovery', () => {
  const { scripts } = readPackageJson();
  assert.match(scripts['test:coverage'], /\bdist[\\/]scripts[\\/]run-tests\.js\b/u);
  assert.doesNotMatch(scripts['test:coverage'], /\btsx --test\b/u);
  assert.match(scripts['test:coverage:llm'], /\bdist[\\/]scripts[\\/]run-tests\.js\b/u);
  assert.doesNotMatch(scripts['test:coverage:llm'], /\btsx --test\b/u);
});
