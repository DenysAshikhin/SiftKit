import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { spawnProcess } from '../_runtime-helpers.js';
import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.js';

test('siftkit.ps1 completes inside Start-Job when the CLI writes to stderr', async () => {
  const tempRoot = createManagedTempDir('siftkit-shim-stderr-');
  try {
    const probePath = path.join(tempRoot, 'stderr-probe.cjs');
    fs.writeFileSync(probePath, "process.stderr.write('shim stderr probe\\n');\n", 'utf8');

    const shimPath = path.resolve(process.cwd(), 'bin', 'siftkit.ps1').replace(/'/gu, "''");
    const commandText = [
      `$job = Start-Job -ScriptBlock { param($shim) & $shim --help } -ArgumentList '${shimPath}'`,
      `$null = Wait-Job $job -Timeout 120`,
      `$state = $job.State`,
      `$received = @(Receive-Job $job 2>&1 | ForEach-Object { $_.ToString() }) -join "\`n"`,
      `Remove-Job $job -Force`,
      `Write-Output "STATE=$state"`,
      `Write-Output $received`,
    ].join('; ');

    const requireArg = probePath.includes(' ') ? `"${probePath}"` : probePath;
    const result = await spawnProcess('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', commandText,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${requireArg}`.trim(),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^STATE=Completed$/mu);
    assert.match(result.stdout, /shim stderr probe/u);
    assert.match(result.stdout, /Usage|usage|siftkit/u);
  } finally {
    await removeDirectoryWithRetries(tempRoot);
  }
});
