import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readPackageJson } from './helpers/package-json.ts';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts', 'verify-client.ps1');

function readScript(): string {
  return fs.readFileSync(scriptPath, 'utf8');
}

test('verify-client.ps1 names only existing repo files', () => {
  const tokens = [...readScript().matchAll(/\.(?:\\[^\\\s;|&<>:"'`]+)+/gu)].map((match) => match[0]);
  assert.ok(tokens.length > 0, 'expected repo path literals in verify-client.ps1');
  const missing = tokens.filter((token) => {
    const resolved = path.join(repoRoot, ...token.slice(1).split('\\'));
    const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : undefined;
    return stat === undefined || !stat.isFile();
  });
  assert.deepEqual(missing, [], `verify-client.ps1 references missing files: ${missing.join(', ')}`);
});

test('verify-client.ps1 only invokes npm scripts defined in package.json', () => {
  const invoked = [...new Set([...readScript().matchAll(/npm\s+run\s+([\w:-]+)/gu)].map((match) => match[1]))];
  assert.ok(invoked.length > 0, 'expected npm run invocations in verify-client.ps1');
  const defined = Object.keys(readPackageJson().scripts);
  const missing = invoked.filter((name) => !defined.includes(name));
  assert.deepEqual(missing, [], `npm scripts invoked but not defined: ${missing.join(', ')}`);
});

test('verify-client.ps1 runs the Node test suite through the TypeScript test runner', () => {
  const script = readScript();
  assert.match(script, /node\s+\.\\src\\test-runner\\run-tests\.ts/u);
  // The runner owns discovery of .test.ts sources; a compiled file could silently drop tests.
  assert.doesNotMatch(script, /node\s+--test/u);
});