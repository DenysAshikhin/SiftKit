import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const DASHBOARD_SRC = path.join(process.cwd(), 'dashboard', 'src');
const VITE_CONFIG = path.join(process.cwd(), 'dashboard', 'vite.config.ts');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function requestedPrefixes(): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const file of sourceFiles(DASHBOARD_SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:fetch|fetchJson|fetchStream|EventSource)\(\s*[`'"](\/[A-Za-z0-9_-]+)/g)) {
      const prefix = match[1];
      if (prefix !== undefined && !prefixes.has(prefix)) {
        prefixes.set(prefix, path.relative(process.cwd(), file));
      }
    }
  }
  return prefixes;
}

function proxiedPrefixes(): Set<string> {
  const text = fs.readFileSync(VITE_CONFIG, 'utf8');
  const proxyStart = text.indexOf('proxy: {');
  assert.notEqual(proxyStart, -1, 'dashboard/vite.config.ts must declare a dev-server proxy');
  const proxyBlock = text.slice(proxyStart);
  return new Set([...proxyBlock.matchAll(/^\s*'(\/[A-Za-z0-9_-]+)':\s*\{/gm)].flatMap((match) => (
    match[1] === undefined ? [] : [match[1]]
  )));
}

test('dashboard dev server proxies the authenticated assistant API', () => {
  const source = fs.readFileSync('dashboard/vite.config.ts', 'utf8');
  assert.match(source, /['"]\/assistant['"]\s*:/u);
  assert.match(source, /['"]\/assistant['"]\s*:\s*\{[\s\S]*?target:\s*['"]http:\/\/127\.0\.0\.1:4765['"]/u);
});

test('every origin-relative dashboard request prefix is proxied by the vite dev server', () => {
  const requested = requestedPrefixes();
  const proxied = proxiedPrefixes();
  assert.ok(requested.size > 0, 'expected the dashboard to issue origin-relative requests');
  const missing = [...requested.entries()]
    .filter(([prefix]) => !proxied.has(prefix))
    .map(([prefix, file]) => `${prefix} (used in ${file})`);
  assert.deepEqual(missing, [], `unproxied prefixes fall through to the vite SPA fallback and return HTML: ${missing.join(', ')}`);
});
