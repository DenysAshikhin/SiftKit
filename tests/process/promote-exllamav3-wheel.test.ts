import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createManagedTempDir } from '../helpers/temp-dirs.ts';
import { writeWheelSha256 } from '../../scripts/build-exllamav3-wheel.ts';
import {
  PromoteOptionsSchema, diskCacheRoots, readWheelProvenance, retireDiskCacheDirectories,
} from '../../scripts/promote-exllamav3-wheel.ts';

test('production promote command targets the runtime venv', () => {
  const packageSchema = z.object({ scripts: z.object({ 'exl3:promote-wheel': z.string() }) });
  const command = packageSchema.parse(JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'))).scripts['exl3:promote-wheel'];
  assert.ok(command.includes('--python C:\\AI\\exl3\\prod-20260924\\venv-runtime\\Scripts\\python.exe'));
  assert.ok(command.includes('scripts\\promote-exllamav3-wheel.ts'));
});

test('promote options require absolute paths and reject unknown keys', () => {
  const valid = { wheel: path.resolve('a.whl'), python: path.resolve('venv/python.exe'), scratch: path.resolve('scratch') };
  assert.equal(PromoteOptionsSchema.safeParse(valid).success, true);
  assert.equal(PromoteOptionsSchema.safeParse({ ...valid, wheel: 'a.whl' }).success, false);
  assert.equal(PromoteOptionsSchema.safeParse({ ...valid, repo: path.resolve('src') }).success, false);
  assert.equal(PromoteOptionsSchema.safeParse({ wheel: valid.wheel }).success, false);
});

function wheelFixture(name: string, content: string): string {
  const wheel = path.join(createManagedTempDir('exl3-promote-'), name);
  writeFileSync(wheel, content);
  return wheel;
}

test('wheel provenance returns the version once the recorded hash matches', () => {
  const wheel = wheelFixture('exllamav3-1.6.5-cp314-cp314-win_amd64.whl', 'wheel bytes');
  writeWheelSha256(wheel);
  const provenance = readWheelProvenance(wheel);
  assert.equal(provenance.version, '1.6.5');
  assert.match(provenance.sha256, /^[a-f0-9]{64}$/u);
});

test('wheel provenance rejects a changed wheel, a missing hash file, and other packages', () => {
  const wheel = wheelFixture('exllamav3-1.6.5-cp314-cp314-win_amd64.whl', 'wheel bytes');
  assert.throws(() => readWheelProvenance(wheel), /wheel\.sha256/u);
  writeWheelSha256(wheel);
  writeFileSync(wheel, 'tampered');
  assert.throws(() => readWheelProvenance(wheel), /does not match/u);
  const other = wheelFixture('torch-2.14.0-cp314-cp314-win_amd64.whl', 'other');
  writeWheelSha256(other);
  assert.throws(() => readWheelProvenance(other), /Not an EXL3 wheel/u);
});

test('wheel provenance rejects a hash file that names another wheel', () => {
  const wheel = wheelFixture('exllamav3-1.6.5-cp314-cp314-win_amd64.whl', 'wheel bytes');
  writeWheelSha256(wheel);
  const hashFile = path.join(path.dirname(wheel), 'wheel.sha256');
  writeFileSync(hashFile, readFileSync(hashFile, 'utf8').replace('1.6.5', '1.6.4'));
  assert.throws(() => readWheelProvenance(wheel), /does not describe/u);
});

function cacheDirectory(root: string, name: string, version: string | null): string {
  const directory = path.join(root, name);
  mkdirSync(path.join(directory, 'pages'), { recursive: true });
  if (version !== null) writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ fingerprint: name, inputs: { exllamav3: version, format: 2 } }));
  return directory;
}

test('disk cache retirement removes only fingerprint folders of other EXL3 versions', () => {
  const root = createManagedTempDir('exl3-disk-cache-');
  const older = cacheDirectory(root, 'older', '1.6.3');
  const newer = cacheDirectory(root, 'newer', '1.6.6');
  const current = cacheDirectory(root, 'current', '1.6.5');
  const unknown = cacheDirectory(root, 'unknown', null);
  writeFileSync(path.join(root, 'notes.txt'), 'not a cache');
  assert.deepEqual(retireDiskCacheDirectories([root], '1.6.5').sort(), [newer, older].sort());
  assert.equal(existsSync(older), false);
  assert.equal(existsSync(newer), false);
  assert.equal(existsSync(current), true);
  assert.equal(existsSync(unknown), true);
  assert.equal(existsSync(path.join(root, 'notes.txt')), true);
});

test('disk cache retirement skips a root that does not exist yet', () => {
  assert.deepEqual(retireDiskCacheDirectories([path.join(createManagedTempDir('exl3-disk-cache-'), 'absent')], '1.6.5'), []);
});

test('disk cache retirement fails on a manifest it cannot read', () => {
  const root = createManagedTempDir('exl3-disk-cache-');
  const broken = cacheDirectory(root, 'broken', null);
  writeFileSync(path.join(broken, 'manifest.json'), JSON.stringify({ fingerprint: 'broken', inputs: {} }));
  assert.throws(() => retireDiskCacheDirectories([root], '1.6.5'));
  assert.equal(existsSync(broken), true);
});

test('disk cache roots are the distinct preset directories', () => {
  const roots = diskCacheRoots([
    { DiskCacheDir: 'D:\\AI\\exl3-disk-cache' },
    { DiskCacheDir: 'd:/ai/exl3-disk-cache/' },
    { DiskCacheDir: null },
    { DiskCacheDir: 'E:\\cache' },
  ]);
  assert.deepEqual(roots, ['D:\\AI\\exl3-disk-cache', 'E:\\cache']);
});
