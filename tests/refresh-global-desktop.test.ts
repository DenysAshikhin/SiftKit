import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const script = fs.readFileSync(path.join('scripts', 'refresh-global.ps1'), 'utf8');

test('refresh-global resolves the tooling root from toolchain-paths.mjs, not a ps1 mirror', () => {
  assert.match(script, /toolchain-paths\.mjs/u);
  assert.match(script, /TOOLING_ROOT/u);
  assert.doesNotMatch(script, /siftkit-gate-d/u);
  assert.match(script, /cargo\\bin\\cargo-tauri\.exe/u);
  assert.match(script, /desktop:install-toolchain/u);
});

test('refresh-global builds the desktop shell before packing', () => {
  assert.match(script, /desktop:build/u);
  const desktopIndex = script.indexOf('desktop:build');
  const packIndex = script.indexOf('Packing current repo');
  assert.ok(desktopIndex >= 0 && packIndex >= 0 && desktopIndex < packIndex);
});
