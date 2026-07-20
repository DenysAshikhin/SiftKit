import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'refresh-global.ps1');

test('global refresh uses only the npm tarball installation path', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(script, /Install-SiftKitViaShellIntegration/u);
  assert.doesNotMatch(script, /Falling back to Install-SiftKitShellIntegration/u);
  assert.doesNotMatch(script, /^catch\s*\{/mu);
  assert.match(
    script,
    /Invoke-RetryableCommand[^\r\n]+@\('i', '-g', \$tarballName, '--force', '--loglevel', 'error'\)/u,
  );
});

test('global refresh packs only the root package without workspace traversal', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(
    script,
    /Invoke-RetryableCommand[^\r\n]+@\('pack', '--workspaces=false', '--loglevel', 'error'\)/u,
  );
});
