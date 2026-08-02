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

test('evaluateCommandSafety rejects a script block that writes, whichever cmdlet takes it', () => {
  for (const command of [
    'git log --oneline | ForEach-Object { Rename-Item $_ }',
    'git ls-files | Where-Object { Remove-Item $_ }',
    'git ls-files | Select-Object -Property @{ n = "x"; e = { Out-File $_ } }',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.match(result.reason || '', /is not in the allow-list/u);
  }
});

test('evaluateCommandSafety rejects non-allow-listed invocations inside blocks and subexpressions', () => {
  for (const command of [
    'git ls-files | ForEach-Object { New-Item pwned.txt }',
    'git ls-files | ForEach-Object { Set-Item x y }',
    'git ls-files | ForEach-Object { Invoke-Expression $_ }',
    'git ls-files | ForEach-Object { iex $_ }',
    'git ls-files | ForEach-Object { $null; New-Item pwned.txt }',
    'git ls-files | Select-Object (New-Item pwned.txt)',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.match(result.reason || '', /is not in the allow-list/u);
  }
});

test('evaluateCommandSafety rejects call operators, dot-sourcing, and static member access', () => {
  for (const command of [
    'git ls-files | ForEach-Object { & notepad $_ }',
    'git log & whoami',
    'git ls-files | ForEach-Object { . .\\payload.ps1 }',
    'git ls-files | ForEach-Object { [System.IO.File]::Delete($_) }',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
  }
});

test('evaluateCommandSafety rejects mutating git subcommands', () => {
  for (const command of [
    'git commit -m "x"',
    'git checkout .',
    'git clean -fd',
    'git reset --hard HEAD~1',
    'git push origin main',
    'git add .',
    'git -c alias.st=status st',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.match(result.reason || '', /is not read-only/u);
  }
});

test('evaluateCommandSafety allows expression-only script blocks including multi-statement ones', () => {
  for (const command of [
    'git ls-files | Select-Object -Property @{ n = "x"; e = { $_ } }',
    'git log --oneline | ForEach-Object { $parts = $_ -split " "; $parts[0] }',
    'git ls-files | Where-Object { -not ($_ -match "test") }',
    'git log --oneline | Where-Object { ($_ -match "fix") -and ($_ -notmatch "wip") }',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, true, `expected ${command} to be allowed, got ${result.reason}`);
  }
});

test('evaluateCommandSafety allows write-command substrings in path operands and quoted arguments', () => {
  for (const command of [
    'git log --oneline -- docs/rm.md',
    'git log --oneline -- src/cp/index.ts',
    'git grep -n "export-default"',
    'git log --grep="remove-item"',
    'git log --format="%h <%an>"',
    "git log --grep='back`tick'",
    'git show HEAD:package.json | Measure-Object -Character',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, true, `expected ${command} to be allowed, got ${result.reason}`);
  }
});

test('evaluateCommandSafety rejects command substitution and escapes outside single quotes', () => {
  for (const command of [
    'git log --grep="$(Remove-Item x)"',
    'git log --grep=$(whoami)',
    'git log --grep="a`nb"',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.equal(result.reason, 'command substitution and escape characters are not allowed');
  }
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
