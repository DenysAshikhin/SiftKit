import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.resolve(process.cwd(), 'scripts', 'refresh-global.ps1');

test('global refresh links this checkout as the global package instead of packing a tarball', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(script, /Install-SiftKitViaShellIntegration/u);
  assert.doesNotMatch(script, /^catch\s*\{/mu);
  // Node will not strip types under node_modules, so only a link (realpath = repo) can run the sources.
  assert.match(script, /Invoke-RetryableCommand[^\r\n]+@\('i', '-g', \$script:RepoRoot,[^\r\n]*\)/u);
  assert.doesNotMatch(script, /'pack'|tarball/iu);
  // A link copies no package files, so a lock retry could only mask a real failure.
  assert.match(script, /@\('i', '-g', \$script:RepoRoot,[^\r\n]*-MaxAttempts 1\r?$/mu);
});

test('global refresh never resolves packages or crates from the network', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /Invoke-RetryableCommand[^\r\n]+@\('install', '--offline',[^\r\n]*\)/u);
  assert.match(script, /Invoke-RetryableCommand[^\r\n]+@\('i', '-g', \$script:RepoRoot,[^\r\n]*'--offline'[^\r\n]*\)/u);
  assert.match(script, /\$env:CARGO_NET_OFFLINE = 'true'[\s\S]+'desktop:build'/u);
});
