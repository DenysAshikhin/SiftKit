import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('dashboard dev server proxies the authenticated assistant API', () => {
  const source = fs.readFileSync('dashboard/vite.config.ts', 'utf8');
  assert.match(source, /['"]\/assistant['"]\s*:/u);
  assert.match(source, /['"]\/assistant['"]\s*:\s*\{[\s\S]*?target:\s*['"]http:\/\/127\.0\.0\.1:4765['"]/u);
});
