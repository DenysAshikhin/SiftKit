import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// jsdom and its peers cost ~0.5s to load, so every process that merely imports the service must not pay it.
test('loading WebFetchService defers the HTML toolchain until a page is converted', () => {
  const modulePath = pathToFileURL(path.resolve('dist', 'web-search', 'web-fetch-service.js')).href;
  const probe = [
    `await import(${JSON.stringify(modulePath)});`,
    "const { createRequire } = await import('node:module');",
    'const loaded = Object.keys(createRequire(import.meta.url).cache)',
    "  .filter((key) => /[\\\\/]node_modules[\\\\/](?:jsdom|turndown|@mozilla[\\\\/]readability)[\\\\/]/u.test(key));",
    'process.stdout.write(String(loaded.length));',
  ].join('\n');
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }), '0');
});
