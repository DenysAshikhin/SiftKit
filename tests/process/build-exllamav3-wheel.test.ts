import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';
import {
  WheelOptionsSchema, validateWheelSource, selectBuiltWheel, buildJobCount, readMsvcEnvironment, verifyInstalledRecord,
} from '../../scripts/build-exllamav3-wheel.ts';

test('production wheel command targets the current source and build environment', () => {
  const packagePath = path.resolve('package.json');
  const packageSchema = z.object({ scripts: z.object({ 'exl3:build-wheel': z.string() }) });
  const manifest = packageSchema.parse(JSON.parse(readFileSync(packagePath, 'utf8')));
  const command = manifest.scripts['exl3:build-wheel'];
  assert.ok(command.includes('--repo C:\\AI\\exl3\\dev-20261011\\src'));
  assert.ok(command.includes('--python C:\\AI\\exl3\\prod-20260924\\venv\\Scripts\\python.exe'));
});

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(): string {
  const repo = createManagedTempDir('exl3-wheel-');
  git(repo, ['init', '-b', 'production-upstream']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'source.txt'), 'base');
  git(repo, ['add', 'source.txt']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['update-ref', 'refs/remotes/origin/dev', 'HEAD']);
  return repo;
}

test('wheel options require absolute paths and reject unknown keys', () => {
  assert.equal(WheelOptionsSchema.safeParse({}).success, false);
  const valid = {
    repo: path.resolve('source'), python: path.resolve('venv/python.exe'), cuda: path.resolve('cuda'),
    vcvars: path.resolve('vc/vcvars64.bat'), packages: path.resolve('packages'), scratch: path.resolve('scratch'),
  };
  assert.equal(WheelOptionsSchema.safeParse(valid).success, true);
  assert.equal(WheelOptionsSchema.parse({ ...valid, jobs: '12' }).jobs, 12);
  assert.equal(WheelOptionsSchema.safeParse({ ...valid, jobs: '0' }).success, false);
  assert.equal(WheelOptionsSchema.safeParse({ ...valid, mode: 'update' }).success, false);
  assert.equal(WheelOptionsSchema.safeParse({ ...valid, repo: 'relative/src' }).success, false);
});

test('build job count is half the logical CPUs, never below one', () => {
  assert.equal(buildJobCount(24), 12);
  assert.equal(buildJobCount(3), 1);
  assert.equal(buildJobCount(1), 1);
});

test('wheel builder loads a Windows build environment from a batch path containing spaces', { skip: process.platform !== 'win32' }, () => {
  const directory = createManagedTempDir('exl3-build-env-');
  const batch = path.join(directory, 'build environment.bat');
  writeFileSync(batch, '@echo off\r\nset EXL3_WHEEL_TEST=ready\r\n');
  assert.equal(readMsvcEnvironment(batch, directory).EXL3_WHEEL_TEST, 'ready');
});

test('wheel source at upstream reports no local commits', () => {
  const repo = fixture();
  const source = validateWheelSource(repo);
  assert.equal(source.commit, git(repo, ['rev-parse', 'HEAD']));
  assert.equal(source.upstream, source.commit);
  assert.deepEqual(source.localCommits, []);
});

test('wheel source rejects tracked and untracked changes', () => {
  const repo = fixture();
  writeFileSync(path.join(repo, 'source.txt'), 'dirty');
  assert.throws(() => validateWheelSource(repo), /dirty/u);
  writeFileSync(path.join(repo, 'source.txt'), 'base');
  writeFileSync(path.join(repo, 'local.txt'), 'untracked');
  assert.throws(() => validateWheelSource(repo), /dirty/u);
});

test('wheel source accepts committed local work rebased on upstream and lists it', () => {
  const repo = fixture();
  writeFileSync(path.join(repo, 'source.txt'), 'fix');
  git(repo, ['commit', '-am', 'Loader: local fix']);
  const source = validateWheelSource(repo);
  assert.equal(source.upstream, git(repo, ['rev-parse', 'origin/dev']));
  assert.equal(source.commit, git(repo, ['rev-parse', 'HEAD']));
  assert.equal(source.localCommits.length, 1);
  assert.match(source.localCommits[0] ?? '', /Loader: local fix$/u);
});

test('wheel source rejects a checkout that has diverged from upstream', () => {
  const repo = fixture();
  writeFileSync(path.join(repo, 'source.txt'), 'local');
  git(repo, ['commit', '-am', 'local']);
  git(repo, ['switch', '-c', 'incoming', 'origin/dev']);
  writeFileSync(path.join(repo, 'source.txt'), 'upstream');
  git(repo, ['commit', '-am', 'upstream']);
  git(repo, ['update-ref', 'refs/remotes/origin/dev', 'HEAD']);
  git(repo, ['switch', 'production-upstream']);
  assert.throws(() => validateWheelSource(repo), /diverged/u);
});

test('wheel source rejects a checkout behind upstream', () => {
  const repo = fixture();
  git(repo, ['switch', '-c', 'incoming']);
  writeFileSync(path.join(repo, 'source.txt'), 'upstream');
  git(repo, ['commit', '-am', 'upstream']);
  git(repo, ['update-ref', 'refs/remotes/origin/dev', 'HEAD']);
  git(repo, ['switch', 'production-upstream']);
  assert.throws(() => validateWheelSource(repo), /behind/u);
});

test('built wheel selection requires exactly one wheel for the expected version', () => {
  const directory = createManagedTempDir('exl3-wheel-out-');
  assert.throws(() => selectBuiltWheel(directory, '1.5.1'), /exactly one/u);
  writeFileSync(path.join(directory, 'exllamav3-1.5.1-cp314-cp314-win_amd64.whl'), '');
  assert.equal(selectBuiltWheel(directory, '1.5.1'), path.join(directory, 'exllamav3-1.5.1-cp314-cp314-win_amd64.whl'));
  assert.throws(() => selectBuiltWheel(directory, '1.5.0'), /1\.5\.0/u);
  writeFileSync(path.join(directory, 'exllamav3-1.5.1-cp314-cp314-win_amd64.whl.bak'), '');
  assert.equal(selectBuiltWheel(directory, '1.5.1'), path.join(directory, 'exllamav3-1.5.1-cp314-cp314-win_amd64.whl'));
  mkdirSync(path.join(directory, 'nested'));
  writeFileSync(path.join(directory, 'other-1.5.1-cp314-cp314-win_amd64.whl'), '');
  assert.equal(selectBuiltWheel(directory, '1.5.1'), path.join(directory, 'exllamav3-1.5.1-cp314-cp314-win_amd64.whl'));
  writeFileSync(path.join(directory, 'exllamav3-1.5.0-cp314-cp314-win_amd64.whl'), '');
  assert.throws(() => selectBuiltWheel(directory, '1.5.1'), /exactly one/u);
});

function installedFixture(): string {
  const site = createManagedTempDir('exl3-site-');
  const files = { 'exllamav3/__init__.py': 'init', 'exllamav3/util/memory.py': 'memory', 'exllamav3_ext.cp314-win_amd64.pyd': 'ext' };
  const lines = ['exllamav3-1.6.5.dist-info/RECORD,,', 'exllamav3/__pycache__/__init__.cpython-314.pyc,,'];
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(site, name)), { recursive: true });
    writeFileSync(path.join(site, name), content);
    lines.push(`${name},sha256=${createHash('sha256').update(content).digest('base64url')},${content.length}`);
  }
  mkdirSync(path.join(site, 'exllamav3-1.6.5.dist-info'));
  writeFileSync(path.join(site, 'exllamav3-1.6.5.dist-info', 'RECORD'), `${lines.join('\r\n')}\r\n`);
  return site;
}

test('installed record verification accepts files matching the wheel record', () => {
  const site = installedFixture();
  mkdirSync(path.join(site, 'exllamav3', 'util', '__pycache__'));
  writeFileSync(path.join(site, 'exllamav3', 'util', '__pycache__', 'memory.cpython-314.pyc'), 'bytecode');
  verifyInstalledRecord(site, '1.6.5');
});

test('installed record verification names changed, missing, and stale files', () => {
  const changed = installedFixture();
  writeFileSync(path.join(changed, 'exllamav3', 'util', 'memory.py'), 'patched');
  assert.throws(() => verifyInstalledRecord(changed, '1.6.5'), /changed: exllamav3\/util\/memory\.py/u);
  const stale = installedFixture();
  writeFileSync(path.join(stale, 'exllamav3', 'util', 'nvml.py'), 'old module');
  assert.throws(() => verifyInstalledRecord(stale, '1.6.5'), /not in the wheel: exllamav3\/util\/nvml\.py/u);
  const missing = installedFixture();
  rmSync(path.join(missing, 'exllamav3_ext.cp314-win_amd64.pyd'));
  assert.throws(() => verifyInstalledRecord(missing, '1.6.5'), /missing: exllamav3_ext\.cp314-win_amd64\.pyd/u);
  assert.throws(() => verifyInstalledRecord(installedFixture(), '1.6.4'), /RECORD/u);
});

test('built wheel selection rejects directories named like wheel artifacts', () => {
  const directory = createManagedTempDir('exl3-wheel-out-');
  mkdirSync(path.join(directory, 'exllamav3-1.5.1-cp314-cp314-win_amd64.whl'));
  assert.throws(() => selectBuiltWheel(directory, '1.5.1'), /exactly one/u);
});
