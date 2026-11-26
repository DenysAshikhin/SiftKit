import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { spawnProcess } from '../_runtime-helpers.ts';
import { createManagedTempDir, removeDirectoryWithRetries } from '../helpers/temp-dirs.ts';

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

// The install is linked, not copied, so the installed module and shim must run this checkout from any cwd.
test('shell integration installs a module and shim that run this checkout', async () => {
  const tempRoot = createManagedTempDir('siftkit-shell-integration-');
  try {
    const binDir = path.join(tempRoot, 'bin');
    const manifestPath = path.resolve('SiftKit', 'SiftKit.psd1').replace(/'/gu, "''");
    const install = await spawnProcess('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Import-Module '${manifestPath}' -Force; $null = Install-SiftKitShellIntegration -BinDir '${binDir}' -ModuleInstallRoot '${tempRoot}' -Force`,
    ], { cwd: process.cwd() });
    assert.equal(install.code, 0, install.stderr);

    const help = await spawnProcess('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(binDir, 'siftkit.ps1'), '--help',
    ], { cwd: tempRoot });
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Usage|usage|siftkit/u);
  } finally {
    await removeDirectoryWithRetries(tempRoot);
  }
});

test('siftkit.cmd exits with the exit code of what it runs, through PowerShell and through node', async () => {
  const tempRoot = createManagedTempDir('siftkit-cmd-exit-');
  try {
    const bin = path.join(tempRoot, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(tempRoot, 'src', 'cli'), { recursive: true });
    fs.copyFileSync(path.resolve('bin', 'siftkit.cmd'), path.join(bin, 'siftkit.cmd'));
    fs.writeFileSync(path.join(tempRoot, 'src', 'cli', 'main.ts'), 'process.exit(5);\n');
    const run = () => spawnProcess('cmd.exe', ['/d', '/c', path.join(bin, 'siftkit.cmd'), 'probe'], { cwd: bin, env: process.env });

    assert.equal((await run()).code, 5);
    fs.writeFileSync(path.join(bin, 'siftkit.ps1'), 'exit 7\r\n');
    assert.equal((await run()).code, 7);
    fs.writeFileSync(path.join(bin, 'siftkit.ps1'), 'exit 0\r\n');
    assert.equal((await run()).code, 0);
  } finally {
    await removeDirectoryWithRetries(tempRoot);
  }
});

// This test pins argument fidelity at the cmd boundary for the shapes this platform delivers.
test('siftkit.cmd passes a quoted spaced argument through intact, through PowerShell and node', async () => {
  const tempRoot = createManagedTempDir('siftkit-cmd-args-');
  try {
    const bin = path.join(tempRoot, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(tempRoot, 'src', 'cli'), { recursive: true });
    fs.copyFileSync(path.resolve('bin', 'siftkit.cmd'), path.join(bin, 'siftkit.cmd'));
    // The spaced value is one spawn argument; node quotes it so cmd sees "a b".
    const shimArgs = ['summarize', '--question', 'a b', '--flag'];
    const expectedLines = ['ARG=summarize', 'ARG=--question', 'ARG=a b', 'ARG=--flag'];
    const argLines = (stdout: string) => stdout.split(/\r?\n/u).filter((line) => line.length > 0);
    const runShim = () => spawnProcess('cmd.exe', ['/d', '/c', path.join(bin, 'siftkit.cmd'), ...shimArgs], { cwd: bin, env: process.env });

    // PowerShell branch: a probe ps1 prints one ARG line per argument it receives.
    fs.writeFileSync(path.join(bin, 'siftkit.ps1'), 'foreach ($a in $args) { Write-Output "ARG=$a" }\r\nexit 0\r\n');
    const ps = await runShim();
    assert.deepEqual(argLines(ps.stdout), expectedLines, ps.stdout);

    // Node branch: with no ps1 sibling the shim falls through to a probe main.ts.
    fs.rmSync(path.join(bin, 'siftkit.ps1'));
    fs.writeFileSync(path.join(tempRoot, 'src', 'cli', 'main.ts'), 'for (const a of process.argv.slice(2)) { console.log(`ARG=${a}`); }\n');
    const nodeRun = await runShim();
    assert.deepEqual(argLines(nodeRun.stdout), expectedLines, nodeRun.stdout);
  } finally {
    await removeDirectoryWithRetries(tempRoot);
  }
});
