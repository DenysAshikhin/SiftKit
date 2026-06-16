import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface PackageManifest {
  files: string[];
  scripts: Record<string, string>;
}

function readManifest(): PackageManifest {
  const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(raw) as PackageManifest;
}

test('package files whitelist ships only runtime, not dev harnesses', () => {
  const { files } = readManifest();
  assert.ok(!files.includes('eval'), 'eval dir (untracked dev fixtures) must not be packed');
  assert.ok(!files.includes('scripts'), 'broad scripts/ dev tree must not be packed');
  assert.ok(files.includes('scripts/postinstall.js'), 'postinstall hook script must be packed');
  for (const required of ['bin', 'SiftKit', 'dist', 'README.md', 'docs']) {
    assert.ok(files.includes(required), `${required} must be packed`);
  }
});

test('postinstall hook references the packed postinstall script', () => {
  const { scripts } = readManifest();
  assert.equal(scripts.postinstall, 'node scripts/postinstall.js');
});
