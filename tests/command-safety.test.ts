import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIgnorePolicy,
  evaluateCommandSafety,
  getFirstCommandToken,
} from '../src/repo-search/command-safety.js';

test('evaluateCommandSafety allows read-only git commands', () => {
  assert.equal(evaluateCommandSafety('git status --short').safe, true);
  assert.equal(evaluateCommandSafety('git log -n 20 --oneline').safe, true);
  assert.equal(evaluateCommandSafety('git blame -L 40,80 src/summary.ts').safe, true);
});

test('evaluateCommandSafety allows git piped into read-only PowerShell filters', () => {
  assert.equal(evaluateCommandSafety('git log --oneline | Select-Object -First 5').safe, true);
  assert.equal(evaluateCommandSafety('git status --short | Where-Object { $_ -match "src" }').safe, true);
});

test('evaluateCommandSafety rejects every producer other than git', () => {
  // Every other repo tool executes natively from typed args, so no other command
  // token may reach a shell.
  for (const command of [
    'rg -n "planner" src',
    'Get-Content src\\summary.ts',
    'Select-String -Path "src\\*.ts" -Pattern "planner"',
    'Get-ChildItem src -Recurse',
    'pwd',
    'ls src',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.match(result.reason || '', /is not in the allow-list/u);
  }
});

test('evaluateCommandSafety rejects an empty command', () => {
  assert.equal(evaluateCommandSafety('   ').safe, false);
  assert.equal(evaluateCommandSafety('   ').reason, 'empty command');
});

test('evaluateCommandSafety rejects a non-read-only pipe stage', () => {
  const result = evaluateCommandSafety('git log --oneline | findstr summary');
  assert.equal(result.safe, false);
  assert.match(result.reason || '', /is not in the allow-list/u);
});

test('evaluateCommandSafety rejects a ForEach-Object stage that writes', () => {
  const result = evaluateCommandSafety('git log --oneline | ForEach-Object { Rename-Item $_ }');
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'ForEach-Object must be read-only');
});

test('evaluateCommandSafety rejects destructive, network, and chained commands', () => {
  assert.equal(evaluateCommandSafety('rm -rf .').safe, false);
  assert.equal(evaluateCommandSafety('curl http://127.0.0.1:8097/v1/models').safe, false);
  assert.equal(evaluateCommandSafety('git status; del file.txt').safe, false);
  assert.equal(evaluateCommandSafety('git status && del file.txt').safe, false);
  assert.equal(evaluateCommandSafety('git status || del file.txt').safe, false);
  assert.equal(evaluateCommandSafety('git log > out.txt').safe, false);
  assert.equal(evaluateCommandSafety('git log | Select-Object -First 10 | Out-File out.txt').safe, false);
  assert.equal(evaluateCommandSafety('git log `whoami`').safe, false);
});

test('evaluateCommandSafety allows a 2>&1 stderr merge but not a file redirect', () => {
  assert.equal(evaluateCommandSafety('git status --short 2>&1').safe, true);
  assert.equal(evaluateCommandSafety('git status --short 2> errors.txt').safe, false);
});

test('evaluateCommandSafety rejects absolute paths outside the repository root', () => {
  const repoRoot = 'C:\\Users\\denys\\Documents\\GitHub\\SiftKit';
  assert.equal(evaluateCommandSafety('git -C D:\\personal\\models log', repoRoot).safe, false);
  assert.equal(
    evaluateCommandSafety('git -C C:\\Users\\denys\\Documents\\GitHub\\SiftKit\\src log', repoRoot).safe,
    true,
  );
});

test('getFirstCommandToken lowercases the leading token', () => {
  assert.equal(getFirstCommandToken('  Git Status --short'), 'git');
  assert.equal(getFirstCommandToken(''), '');
});

test('buildIgnorePolicy returns deduplicated names plus root-relative paths', () => {
  const policy = buildIgnorePolicy(process.cwd());
  assert.equal(policy.names.length, new Set(policy.names.map((name) => name.toLowerCase())).size);
  assert.equal(policy.namesLower.has('node_modules'), true);
  assert.equal(policy.namesLower.has('.git'), true);
  assert.equal(policy.paths.includes('eval/results'), true);
});
