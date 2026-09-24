import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.resolve(process.cwd(), 'scripts', 'refresh-global.ps1');

test('global refresh uses only the npm tarball installation path', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(script, /Install-SiftKitViaShellIntegration/u);
  assert.doesNotMatch(script, /Falling back to Install-SiftKitShellIntegration/u);
  assert.doesNotMatch(script, /^catch\s*\{/mu);
  // The install must go through the packed tarball with a forced overwrite. Pinning the whole
  // argument vector instead breaks on every legitimate flag addition, which is what this
  // assertion is here to survive, so only the load-bearing arguments are matched.
  assert.match(
    script,
    /Invoke-RetryableCommand[^\r\n]+@\('i', '-g', \$tarballName, '--force',[^\r\n]*\)/u,
  );
});

test('global refresh never resolves packages or crates from the network', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /Invoke-RetryableCommand[^\r\n]+@\('install', '--offline',[^\r\n]*\)/u);
  assert.match(script, /Invoke-RetryableCommand[^\r\n]+@\('i', '-g', \$tarballName,[^\r\n]*'--offline'[^\r\n]*\)/u);
  assert.match(script, /\$env:CARGO_NET_OFFLINE = 'true'[\s\S]+'desktop:build'/u);
});

test('global refresh packs only the root package without workspace traversal', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(
    script,
    /Invoke-RetryableCommand[^\r\n]+@\('pack', '--workspaces=false', '--loglevel', 'error'\)/u,
  );
});
