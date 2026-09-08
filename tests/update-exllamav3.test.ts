import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { UpdateOptionsSchema, validateUpstreamSource, fastForwardSource, readMsvcEnvironment } from '../scripts/update-exllamav3.js';

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(): string {
  const repo = createManagedTempDir('exl3-update-');
  git(repo, ['init', '-b', 'production-upstream']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'source.txt'), 'base');
  git(repo, ['add', 'source.txt']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['update-ref', 'refs/remotes/origin/dev', 'HEAD']);
  return repo;
}

test('updater rejects missing paths and unsupported modes', () => {
  assert.equal(UpdateOptionsSchema.safeParse({}).success, false);
  assert.equal(UpdateOptionsSchema.safeParse({ mode: 'merge-custom' }).success, false);
});

test('updater loads a Windows build environment from a batch path containing spaces', { skip: process.platform !== 'win32' }, () => {
  const directory = createManagedTempDir('exl3-build-env-');
  const batch = path.join(directory, 'build environment.bat');
  writeFileSync(batch, '@echo off\r\nset EXL3_UPDATER_TEST=ready\r\n');
  assert.equal(readMsvcEnvironment(batch, directory).EXL3_UPDATER_TEST, 'ready');
});

test('updater accepts pristine upstream and rejects tracked and untracked changes', () => {
  const repo = fixture();
  assert.doesNotThrow(() => validateUpstreamSource(repo));
  writeFileSync(path.join(repo, 'source.txt'), 'dirty');
  assert.throws(() => validateUpstreamSource(repo), /dirty/u);
  writeFileSync(path.join(repo, 'source.txt'), 'base');
  writeFileSync(path.join(repo, 'local.txt'), 'untracked');
  assert.throws(() => validateUpstreamSource(repo), /dirty/u);
});

test('updater refuses local commits even when the tracked files are clean', () => {
  const repo = fixture();
  writeFileSync(path.join(repo, 'source.txt'), 'custom engine');
  git(repo, ['commit', '-am', 'custom']);
  assert.throws(() => fastForwardSource(repo), /diverged|local commits/u);
  assert.equal(git(repo, ['show', 'HEAD:source.txt']), 'custom engine');
});

test('updater fast-forwards to upstream without creating a merge commit', () => {
  const repo = fixture();
  git(repo, ['switch', '-c', 'incoming']);
  writeFileSync(path.join(repo, 'source.txt'), 'upstream');
  git(repo, ['commit', '-am', 'upstream']);
  const upstream = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['update-ref', 'refs/remotes/origin/dev', upstream]);
  git(repo, ['switch', 'production-upstream']);
  assert.throws(() => validateUpstreamSource(repo), /upstream/u);
  fastForwardSource(repo);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), upstream);
  assert.doesNotThrow(() => validateUpstreamSource(repo));
});
