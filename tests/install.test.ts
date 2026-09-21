import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installCodexPolicy, installShellIntegration, installSiftKit } from '../src/install.js';
import { spawnProcess } from './_runtime-helpers.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { createManagedTempDir, removeDirectoryWithRetries } from './helpers/temp-dirs.js';

void installShellIntegration;

test('installCodexPolicy creates AGENTS.md with policy block', async () => {
  const tempRoot = createManagedTempDir('siftkit-install-policy-');
  const codexHome = path.join(tempRoot, '.codex');
  try {
    const result = await installCodexPolicy(codexHome);
    assert.equal(result.Installed, true);
    assert.equal(typeof result.AgentsPath, 'string');
    const content = fs.readFileSync(result.AgentsPath, 'utf8');
    assert.match(content, /SiftKit Policy:Start/u);
    assert.match(content, /SiftKit Policy:End/u);
    assert.match(content, /SiftKit default shell-output handling/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installCodexPolicy updates existing AGENTS.md replacing policy block', async () => {
  const tempRoot = createManagedTempDir('siftkit-install-replace-');
  const codexHome = path.join(tempRoot, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const agentsPath = path.join(codexHome, 'AGENTS.md');
  fs.writeFileSync(agentsPath, '# My AGENTS\n\n<!-- SiftKit Policy:Start -->\nold policy\n<!-- SiftKit Policy:End -->\n\n# Footer\n', 'utf8');
  try {
    const result = await installCodexPolicy(codexHome);
    assert.equal(result.Installed, true);
    const content = fs.readFileSync(agentsPath, 'utf8');
    assert.match(content, /# My AGENTS/u);
    assert.match(content, /# Footer/u);
    assert.match(content, /SiftKit default shell-output handling/u);
    assert.doesNotMatch(content, /old policy/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('installCodexPolicy appends to existing AGENTS.md without existing policy', async () => {
  const tempRoot = createManagedTempDir('siftkit-install-append-');
  const codexHome = path.join(tempRoot, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const agentsPath = path.join(codexHome, 'AGENTS.md');
  fs.writeFileSync(agentsPath, '# Existing content\nSome rules here.\n', 'utf8');
  try {
    const result = await installCodexPolicy(codexHome, true);
    assert.equal(result.Installed, true);
    const content = fs.readFileSync(agentsPath, 'utf8');
    assert.match(content, /# Existing content/u);
    assert.match(content, /SiftKit Policy:Start/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('PowerShell wrappers do not enable common-parameter parsing for forwarded args', () => {
  const repoRoot = process.cwd();
  const wrapperContent = fs.readFileSync(path.join(repoRoot, 'bin', 'siftkit.ps1'), 'utf8');
  const postinstallContent = fs.readFileSync(path.join(repoRoot, 'scripts', 'postinstall.cjs'), 'utf8');

  assert.doesNotMatch(wrapperContent, /\[CmdletBinding\(\)\]/u);
  assert.doesNotMatch(postinstallContent, /\[CmdletBinding\(\)\]/u);
  assert.doesNotMatch(wrapperContent, /^\s*(?:\[CmdletBinding\(\)\]\s*)?param\s*\(/u);
  assert.doesNotMatch(postinstallContent, /^\s*(?:#![^\n]*\n)?\s*(?:\[CmdletBinding\(\)\]\s*)?param\s*\(/u);
  assert.match(wrapperContent, /\$CliArgs\s*=\s*@\(\$args\)/u);
  assert.match(postinstallContent, /\$CliArgs\s*=\s*@\(\$args\)/u);
});

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

// installShellIntegration is not directly testable because getRepoRoot()
// resolves to the repo root when run from dist/, which would copy the entire
// repository. It is tested indirectly via the CLI internal op path.

test('installSiftKit returns installation info', async () => {
  await withTestEnvAndServer(async () => {
    const result = await installSiftKit(false);
    assert.equal(result.Installed, true);
    assert.equal(typeof result.ConfigPath, 'string');
    assert.equal(typeof result.RuntimeRoot, 'string');
    assert.equal(typeof result.Backend, 'string');
  });
});
