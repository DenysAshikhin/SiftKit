import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import type { ModelRuntimePreset } from '../src/config/types.ts';
import { GIB, requiredRamDiskBytes } from '../src/inference-presets/cache-sizing.ts';
import { z } from '../src/lib/zod.ts';
import { RamDiskCache } from '../src/status-server/ram-disk-cache.ts';
import { serverLogger } from '../src/status-server/server-logger.ts';
import { FakeRamDiskDriver } from './helpers/fake-ram-disk.ts';

const CONFIG = { ToolPath: 'C:\\aim\\aim_ll.exe', DriveLetter: 'S' };
const OwnerFileSchema = z.object({ pid: z.number() });

function preset(id: string, ramDisk: boolean, gib = 10): ModelRuntimePreset {
  const base = getDefaultConfigObject().Server.ModelPresets.Presets[0];
  if (!base) throw new Error('Default model preset is missing');
  return { ...base, id, Backend: 'exl3', RamDiskCache: ramDisk, RamDiskCacheGiB: gib };
}

const NEXT = preset('flash-next', true, 11);
const BIG = preset('qwen-27b', true, 11);
const PLAIN = preset('plain', false);

test('the first RAM-disk load creates the disk for every RAM-disk budget, marks it, and makes the preset folder', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT, BIG, PLAIN], NEXT);
  assert.deepEqual(driver.calls, ['find', `create S ${String(requiredRamDiskBytes([11, 11]))}`]);
  const root = driver.disk?.root ?? '';
  assert.equal(OwnerFileSchema.parse(JSON.parse(fs.readFileSync(path.join(root, 'siftkit-owner.json'), 'utf8'))).pid, process.pid);
  assert.ok(fs.statSync(path.join(root, 'flash-next')).isDirectory());
});

test('switching between RAM-disk presets keeps the disk and both folders', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT, BIG], NEXT);
  const root = driver.disk?.root ?? '';
  fs.writeFileSync(path.join(root, 'flash-next', 'page.bin'), 'x');
  await cache.prepare(CONFIG, [NEXT, BIG], BIG);
  await cache.prepare(CONFIG, [NEXT, BIG], NEXT);
  assert.deepEqual(driver.calls.filter((call) => !call.startsWith('find')), [`create S ${String(requiredRamDiskBytes([11, 11]))}`]);
  assert.ok(fs.existsSync(path.join(root, 'flash-next', 'page.bin')), 'the first preset kept its cache');
  assert.ok(fs.existsSync(path.join(root, 'qwen-27b')));
});

test('a raised budget grows the disk in place; a failed grow recreates it empty and warns', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  await cache.prepare(CONFIG, [preset('flash-next', true, 20)], NEXT);
  assert.equal(driver.calls.at(-1), `grow S ${String(requiredRamDiskBytes([20]))}`);
  driver.failNext = 'grow';
  await cache.prepare(CONFIG, [preset('flash-next', true, 30)], NEXT);
  assert.deepEqual(driver.calls.slice(-3), [`grow S ${String(requiredRamDiskBytes([30]))}`, 'remove S', `create S ${String(requiredRamDiskBytes([30]))}`]);
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]?.event), ['ram_disk_recreated']);
});

test('a failed create or a declined UAC prompt fails the load with the reason', async () => {
  const driver = new FakeRamDiskDriver();
  driver.failNext = 'create';
  await assert.rejects(new RamDiskCache(driver).prepare(CONFIG, [NEXT], NEXT), /create failed .*canceled by the user/u);
});

test('a RAM-disk preset needs the aim_ll path', async () => {
  await assert.rejects(new RamDiskCache(new FakeRamDiskDriver()).prepare({ ToolPath: null, DriveLetter: 'S' }, [NEXT], NEXT),
    /RAM disk cache needs Server\.Engines\.Exl3\.RamDisk\.ToolPath \(aim_ll\.exe\)/u);
});

test('folders of presets no longer on the RAM disk are deleted, and a folder over its lowered budget is wiped with a warning', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT, BIG], NEXT);
  const root = driver.disk?.root ?? '';
  fs.mkdirSync(path.join(root, 'qwen-27b'), { recursive: true });
  fs.mkdirSync(path.join(root, 'System Volume Information'));
  const big = fs.openSync(path.join(root, 'flash-next', 'pages.bin'), 'w');
  fs.ftruncateSync(big, 2 * GIB);
  fs.closeSync(big);
  await cache.prepare(CONFIG, [preset('flash-next', true, 1), preset('qwen-27b', false)], NEXT);
  assert.equal(fs.existsSync(path.join(root, 'qwen-27b')), false, 'a preset switched off loses its folder');
  assert.ok(fs.existsSync(path.join(root, 'System Volume Information')), 'folders that are no preset id are not ours');
  assert.deepEqual(fs.readdirSync(path.join(root, 'flash-next')), [], 'over budget: wiped and remade empty');
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]?.event), ['ram_disk_folder_wiped']);
});

test('changing the drive letter moves the cache to a new disk under the new letter', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  await cache.prepare({ ...CONFIG, DriveLetter: 'R' }, [NEXT], NEXT);
  assert.deepEqual(driver.calls.slice(-2), ['remove S', `create R ${String(requiredRamDiskBytes([11]))}`]);
  assert.ok(fs.statSync(path.join(driver.disk?.root ?? '', 'flash-next')).isDirectory());
});

test('a leftover whose owner marker is corrupt is removed like any leftover', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const leftover = driver.plantLeftover('S', GIB, null);
  fs.writeFileSync(path.join(leftover.root, 'siftkit-owner.json'), '{"pid":');
  await new RamDiskCache(driver).prepare(CONFIG, [NEXT], NEXT);
  assert.deepEqual(driver.calls, ['find', 'remove S', `create S ${String(requiredRamDiskBytes([11]))}`]);
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]?.event), ['ram_disk_leftover_removed']);
});

test('a disk whose SiftKit owner has exited becomes a leftover the next load removes', async (t) => {
  t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const disk = driver.plantLeftover('S', GIB, process.ppid);
  const cache = new RamDiskCache(driver);
  await assert.rejects(cache.prepare(CONFIG, [NEXT], NEXT), new RegExp(`belongs to SiftKit process ${String(process.ppid)}`, 'u'));
  // Windows pids are multiples of 4, so this one never names a live process.
  fs.writeFileSync(path.join(disk.root, 'siftkit-owner.json'), JSON.stringify({ pid: 2_147_483_647 }));
  await cache.prepare(CONFIG, [NEXT], NEXT);
  assert.deepEqual(driver.calls.slice(-3), ['find', 'remove S', `create S ${String(requiredRamDiskBytes([11]))}`]);
});

test('release removes the disk, and a leftover is removed at the first check while a live owner disk is never touched', async (t) => {
  t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  await cache.release(CONFIG);
  assert.equal(driver.disk, null);

  const leftover = new FakeRamDiskDriver();
  leftover.plantLeftover('S', GIB, null);
  await new RamDiskCache(leftover).release(CONFIG);
  assert.deepEqual(leftover.calls, ['find', 'remove S']);

  const foreign = new FakeRamDiskDriver();
  foreign.plantLeftover('S', GIB, process.ppid);
  const other = new RamDiskCache(foreign);
  await other.release(CONFIG);
  assert.deepEqual(foreign.calls, ['find'], 'a disk of a live SiftKit process is left alone');
  await assert.rejects(other.prepare(CONFIG, [NEXT], NEXT), new RegExp(`RAM disk S: belongs to SiftKit process ${String(process.ppid)}`, 'u'));
});

test('release without an aim_ll path and without a disk does nothing', async () => {
  const driver = new FakeRamDiskDriver();
  await new RamDiskCache(driver).release({ ToolPath: null, DriveLetter: 'S' });
  assert.deepEqual(driver.calls, []);
});

test('the process-exit path starts the removal without waiting', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  cache.releaseForProcessExitSync(CONFIG);
  assert.equal(driver.calls.at(-1), 'remove-detached S');
});
