import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import {
  buildReadOnlyGitInvocation,
  ReadOnlyGitTool,
} from '../src/repo-search/engine/read-only-git-tool.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import type { RepoToolExecution } from '../src/repo-search/engine/repo-tools.js';
import type { GitToolArgs } from '../src/repo-search/repo-tool-arguments.js';

const BASE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '--no-optional-locks'];

function successfulOutput(result: RepoToolExecution | undefined): string {
  if (!result) throw new Error('Expected Git execution result.');
  if (!result.ok) throw new Error(result.reason);
  return result.output;
}

function makeGitRepo(): string {
  const root = createManagedTempDir('siftkit-native-git-');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'file.ts'), 'first\nneedle\nthird\n', 'utf8');
  execFileSync('git', ['add', 'src/file.ts'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: root });
  return root;
}

test('read-only git invocation uses fixed safety arguments and a scrubbed environment', () => {
  const root = makeGitRepo();
  const previous = process.env.GIT_EXTERNAL_DIFF;
  process.env.GIT_EXTERNAL_DIFF = 'unsafe-command';
  try {
    const invocation = buildReadOnlyGitInvocation(root, buildIgnorePolicy(root), {
      operation: 'grep', pattern: '--open-files-in-pager=unsafe', ref: 'HEAD', path: 'src', limit: 3,
    });
    assert.equal(invocation.ok, true);
    if (!invocation.ok) return;
    assert.deepEqual(invocation.args.slice(0, BASE_ARGS.length), BASE_ARGS);
    assert.deepEqual(invocation.args.slice(BASE_ARGS.length), [
      'grep', '-m', '3', '-e', '--open-files-in-pager=unsafe', 'HEAD', '--', 'src',
    ]);
    assert.equal(Object.keys(invocation.env).some((key) => key.toUpperCase().startsWith('GIT_')), false);
  } finally {
    if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF;
    else process.env.GIT_EXTERNAL_DIFF = previous;
  }
});

test('read-only git diff-family operations disable external diff and textconv', () => {
  const root = makeGitRepo();
  const policy = buildIgnorePolicy(root);
  for (const args of [
    { operation: 'show', ref: 'HEAD' } as const,
    { operation: 'diff' } as const,
    { operation: 'blame', path: 'src/file.ts' } as const,
    { operation: 'log', patches: true } as const,
  ]) {
    const invocation = buildReadOnlyGitInvocation(root, policy, args);
    assert.equal(invocation.ok, true);
    if (!invocation.ok) continue;
    assert.equal(invocation.args.includes('--no-ext-diff'), true);
    assert.equal(invocation.args.includes('--no-textconv'), true);
  }
});

test('read-only git builds exact fixed argv for every operation', () => {
  const root = makeGitRepo();
  const policy = buildIgnorePolicy(root);
  const cases: Array<{ args: GitToolArgs; expected: string[] }> = [
    { args: { operation: 'status' }, expected: ['status', '--short'] },
    { args: { operation: 'log', limit: 2, ref: 'HEAD', path: 'src', patches: true },
      expected: ['log', '--no-ext-diff', '--no-textconv', '-p', '--oneline', '-n', '2', 'HEAD', '--', 'src'] },
    { args: { operation: 'show', ref: 'HEAD', path: 'src/file.ts' },
      expected: ['show', '--no-ext-diff', '--no-textconv', 'HEAD:src/file.ts'] },
    { args: { operation: 'diff', base: 'HEAD~1', target: 'HEAD', path: 'src' },
      expected: ['diff', '--no-ext-diff', '--no-textconv', 'HEAD~1', 'HEAD', '--', 'src'] },
    { args: { operation: 'blame', path: 'src/file.ts', startLine: 1, endLine: 2 },
      expected: ['blame', '--no-ext-diff', '--no-textconv', '-L', '1,2', '--', 'src/file.ts'] },
    { args: { operation: 'grep', pattern: 'needle', ref: 'HEAD', path: 'src', ignoreCase: true, limit: 4 },
      expected: ['grep', '-i', '-m', '4', '-e', 'needle', 'HEAD', '--', 'src'] },
    { args: { operation: 'ls_files', path: 'src', limit: 3 }, expected: ['ls-files', '--', 'src'] },
  ];
  for (const fixture of cases) {
    const invocation = buildReadOnlyGitInvocation(root, policy, fixture.args);
    if (!invocation.ok) throw new Error(invocation.reason);
    assert.deepEqual(invocation.args, [...BASE_ARGS, ...fixture.expected]);
  }
});

test('read-only git rejects unsafe and ignored paths before execution', () => {
  const root = makeGitRepo();
  const policy = buildIgnorePolicy(root);
  const outside = path.resolve(root, '..', 'outside.txt');
  const cases = [outside, '../outside.txt', '.git/config', '-C'];
  for (const candidate of cases) {
    const invocation = buildReadOnlyGitInvocation(root, policy, { operation: 'ls_files', path: candidate });
    assert.equal(invocation.ok, false, candidate);
  }
});

test('read-only git executes every typed operation in a real repository', async () => {
  const root = makeGitRepo();
  fs.writeFileSync(path.join(root, 'src', 'file.ts'), 'first\nneedle changed\nthird\n', 'utf8');
  const tool = new ReadOnlyGitTool({ repoRoot: root, ignorePolicy: buildIgnorePolicy(root) });
  const calls = [
    { operation: 'status' } as const,
    { operation: 'log', limit: 1 } as const,
    { operation: 'show', ref: 'HEAD', path: 'src/file.ts' } as const,
    { operation: 'diff', path: 'src/file.ts' } as const,
    { operation: 'blame', path: 'src/file.ts', startLine: 1, endLine: 2 } as const,
    { operation: 'grep', pattern: 'needle', ref: 'HEAD', path: 'src', limit: 1 } as const,
    { operation: 'ls_files', path: 'src', limit: 1 } as const,
  ];
  const results = await Promise.all(calls.map((args) => tool.execute(args)));
  assert.equal(results.every((result) => result.ok), true);
  assert.match(successfulOutput(results[0]), /src\/file\.ts/u);
  assert.match(successfulOutput(results[1]), /initial/u);
  assert.equal(successfulOutput(results[2]), 'first\nneedle\nthird');
  assert.match(successfulOutput(results[3]), /needle changed/u);
  assert.match(successfulOutput(results[4]), /first[\s\S]*needle changed/u);
  assert.match(successfulOutput(results[5]), /needle/u);
  assert.equal(successfulOutput(results[6]).trim(), 'src/file.ts');
});
