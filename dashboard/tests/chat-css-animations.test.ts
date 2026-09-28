import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sourceRoot = path.join(repoRoot, 'dashboard', 'src');
const ANIMATION_DECLARATION = /animation(?:-iteration-count)?\s*:\s*([^;}]+)/gu;

test('no dashboard CSS animation runs forever', () => {
  const cssFiles = fs.readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.css'));
  assert.ok(cssFiles.length > 0, 'expected .css files under dashboard/src');
  for (const file of cssFiles) {
    for (const [, value = ''] of fs.readFileSync(path.join(sourceRoot, file), 'utf8').matchAll(ANIMATION_DECLARATION)) {
      // Even a stepped infinite animation keeps Chrome rendering frames: measured ~8% renderer CPU for a blinking caret.
      assert.doesNotMatch(value, /infinite/u, `dashboard/src/${file} animates forever: ${value.trim()}`);
    }
  }
});
