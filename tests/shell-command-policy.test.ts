import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { UNFILTERED_CHECK_OUTPUT_RULE } from '../src/output-digest/types.ts';
import { findPathsOutsideRepo, findShellCommandProblem } from '../src/repo-search/engine/shell-command-policy.ts';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

function makeRoot(): string {
  const root = createManagedTempDir('siftkit-shell-policy-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

const run = (command: string) => ({ toolName: 'run' as const, args: { command } });

test('a run command may not reach outside the repository root', () => {
  const root = makeRoot();
  const outside = path.dirname(root);
  for (const [command, named] of [
    ['cd C:\\Users\\someone\\repo; npm test', 'C:\\Users\\someone\\repo'],
    [`Set-Content -Path '${path.join(outside, 'a.txt')}' -Value x`, path.join(outside, 'a.txt')],
    ['Get-Content ..\\other\\a.txt', '..\\other\\a.txt'],
    ['cd ..; Get-ChildItem', '..'],
    ['Set-Location -Path src; Get-Content ..\\..\\x.txt', '..\\..\\x.txt'],
    ['git -C ../other status', '../other'],
    ['Get-ChildItem \\\\server\\share', '\\\\server\\share'],
    ['Get-Content ~\\notes.txt', '~\\'],
    ['Get-Content $env:USERPROFILE\\notes.txt', '$env:USERPROFILE'],
    ['node -e "require(\'C:/elsewhere/x.js\')"', 'C:/elsewhere/x.js'],
  ]) {
    const problem = findShellCommandProblem(run(command), root);
    assert.ok(problem !== null, command);
    assert.ok(problem.includes(`\`${named}\``), `${command}\n${problem}`);
    assert.ok(problem.includes(`outside the repository root ${root}`), problem);
  }
});

test('a run command inside the repository root is allowed', () => {
  const root = makeRoot();
  for (const command of [
    'cd .; npm test',
    'node .\\src\\test-runner\\run-tests.ts orchestrator',
    `Get-Content "${path.join(root, 'src', 'a.ts')}"`,
    `cd ${root}; git status --short`,
    'cd src; Get-Content ..\\package.json',
    '1..3 | ForEach-Object { $_ }',
    '$l = Get-Content scratch\\e2e.log; $l[($i)..($i + 40)]',
    'cd $PWD; git diff --stat',
  ]) {
    assert.equal(findShellCommandProblem(run(command), root), null, command);
  }
});

test('a run_check cwd and command are judged from that cwd', () => {
  const root = makeRoot();
  assert.match(findShellCommandProblem({ toolName: 'run_check', args: { command: 'npm test', cwd: '..' } }, root) ?? '',
    /`\.\.` is outside the repository root/u);
  assert.equal(findShellCommandProblem({ toolName: 'run_check', args: { command: 'Get-Content ..\\package.json', cwd: 'src' } }, root), null);
});

test('a test, build, lint, or typecheck command may not have its output cut', () => {
  const root = makeRoot();
  for (const [command, filter] of [
    ['node .\\src\\test-runner\\run-tests.ts orchestrator 2>&1 | Select-Object -Last 40', 'Select-Object'],
    ['npm run typecheck | Select-String error', 'Select-String'],
    ['npm test > out.txt', '>'],
    ['npm run lint 2>&1 | Out-File log.txt; Get-Content log.txt -Tail 20', 'Out-File'],
    ['cd .; npx vitest run dashboard 2>&1 | Where-Object { $_ -match "fail" }', 'Where-Object'],
    ['$out = npm test 2>&1 | Select-Object -Last 5', 'Select-Object'],
    ['1..3 | ForEach-Object { node --test tests/a.test.ts | Out-Null }', 'Out-Null'],
    ['.\\node_modules\\.bin\\tsc --noEmit | Select-String error', 'Select-String'],
    ['python -m pytest | Select-Object -Last 5', 'Select-Object'],
  ]) {
    const problem = findShellCommandProblem(run(command), root);
    assert.ok(problem !== null, command);
    assert.ok(problem.startsWith(`\`${filter}\` cuts the output of a test, build, lint, or typecheck command.`), `${command}\n${problem}`);
    assert.match(problem, /Run test, build, lint, and typecheck commands unfiltered/u);
    // Real case (run 560566c3): workers looped a suite through Out-Null and Select-String only to see whether it was flaky.
    assert.match(problem, /To repeat a check, run it again; each run gets its own digest./u);
  }
  assert.ok(findShellCommandProblem({ toolName: 'run_check', args: { command: 'npm test | Select-Object -Last 5', cwd: '.' } }, root) !== null);
});

test('unfiltered checks and filtered non-check commands are allowed', () => {
  const root = makeRoot();
  for (const command of [
    'npm test 2>&1',
    'node .\\src\\test-runner\\run-tests.ts orchestrator; "EXIT=$LASTEXITCODE"',
    'New-Item -ItemType Directory -Force scratch | Out-Null; npm run lint',
    'git log --oneline | Select-Object -First 5',
    // Real case (run 560566c3): a file listing whose filter names a check tool runs no check.
    'Get-ChildItem . -Filter eslint* | Select-Object Name',
    'rg -n eslint src | Select-Object -First 20',
    'Select-String -Path package.json -Pattern jest | Select-Object -First 3',
    'node .\\src\\test-runner\\run-tests.ts --test-name-pattern "a > b | Select-Object"',
  ]) {
    assert.equal(findShellCommandProblem(run(command), root), null, command);
  }
});

// Real case (run 560566c3): 10 of 17 workers filtered a check first; the rule sat mid-paragraph in the system prompt only.
test('the run and run_check tools state the unfiltered-check rule where the call is written', () => {
  for (const definition of resolveRepoSearchPlannerToolDefinitions(['run', 'run_check'])) {
    assert.ok(definition.function.description.includes(UNFILTERED_CHECK_OUTPUT_RULE), definition.function.description);
  }
});

test('an instruction naming an absolute path outside the repository is caught; paths inside it are not', () => {
  const root = makeRoot();
  const inside = path.join(root, 'src', 'b.ts');
  assert.deepEqual(findPathsOutsideRepo(`Repo: C:\\Users\\someone\\siftkit (Windows). Edit src/a.ts and ${inside}. Again: C:\\Users\\someone\\siftkit.`, root),
    ['C:\\Users\\someone\\siftkit']);
  assert.deepEqual(findPathsOutsideRepo(`Edit src/a.ts and ${inside}.`, root), []);
});

test('neither the orchestrator nor a worker may start siftkit from a command', () => {
  const root = makeRoot();
  for (const command of [
    'siftkit repo-search --prompt "find the router"',
    'npx siftkit summary --question q',
    'npx --yes siftkit status',
    'cmd /c siftkit repo-search --prompt x',
    '& siftkit.cmd repo-agent "fix it"',
    'cd src; siftkit.ps1 summary',
    'npm test 2>&1 | siftkit summary --question "pass?"',
  ]) {
    for (const call of [run(command), { toolName: 'run_check' as const, args: { command, cwd: '.' } }]) {
      assert.match(findShellCommandProblem(call, root) ?? '', /may not run `siftkit`/u, `${call.toolName}: ${command}`);
    }
  }
  for (const command of [
    'git log --oneline --grep siftkit',
    'Select-String -Path src\\*.ts -Pattern siftkit',
    'node .\\src\\test-runner\\run-tests.ts siftkit-cli',
  ]) {
    assert.equal(findShellCommandProblem(run(command), root), null, command);
  }
});

test('tools other than run and run_check are not judged', () => {
  assert.equal(findShellCommandProblem({ toolName: 'read', args: { path: '..\\x.txt' } }, makeRoot()), null);
});
