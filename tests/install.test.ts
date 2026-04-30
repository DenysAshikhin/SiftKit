import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installCodexPolicy, installShellIntegration, installSiftKit } from '../dist/install.js';
import { withTestEnvAndServer } from './_test-helpers.js';

void installShellIntegration;

test('installCodexPolicy creates AGENTS.md with policy block', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-install-policy-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-install-replace-'));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-install-append-'));
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
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const wrapperContent = fs.readFileSync(path.join(repoRoot, 'bin', 'siftkit.ps1'), 'utf8');
  const postinstallContent = fs.readFileSync(path.join(repoRoot, 'scripts', 'postinstall.js'), 'utf8');

  assert.doesNotMatch(wrapperContent, /\[CmdletBinding\(\)\]/u);
  assert.doesNotMatch(postinstallContent, /\[CmdletBinding\(\)\]/u);
  assert.doesNotMatch(wrapperContent, /^\s*(?:\[CmdletBinding\(\)\]\s*)?param\s*\(/u);
  assert.doesNotMatch(postinstallContent, /^\s*(?:#![^\n]*\n)?\s*(?:\[CmdletBinding\(\)\]\s*)?param\s*\(/u);
  assert.match(wrapperContent, /\$CliArgs\s*=\s*@\(\$args\)/u);
  assert.match(postinstallContent, /\$CliArgs\s*=\s*@\(\$args\)/u);
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
