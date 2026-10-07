import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// jsdom and its peers cost ~0.5s to load, so every process that merely imports the service must not pay it.
test('loading WebFetchService defers the HTML toolchain until a page is converted', () => {
  const modulePath = pathToFileURL(path.resolve('src', 'web-search', 'web-fetch-service.ts')).href;
  // A resolve hook sees ESM and CJS loads alike; require.cache misses packages that ESM imports.
  const probe = [
    "const { registerHooks } = await import('node:module');",
    'const resolved = [];',
    'registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); resolved.push(result.url); return result; } });',
    `await import(${JSON.stringify(modulePath)});`,
    "const loaded = resolved.filter((url) => /\\/node_modules\\/(?:jsdom|turndown|@mozilla\\/readability)\\//u.test(url));",
    'process.stdout.write(String(loaded.length));',
  ].join('\n');
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }), '0');
});
