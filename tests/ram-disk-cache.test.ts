import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.ts';
import type { ModelRuntimePreset } from '../src/config/types.ts';
import { GIB, requiredRamDiskBytes } from '../src/inference-presets/cache-sizing.ts';
import { z } from '../src/lib/zod.ts';
import { BUDGET_MARKER_FILE, OWNER_FILE, RamDiskCache } from '../src/status-server/ram-disk-cache.ts';
import { serverLogger } from '../src/status-server/server-logger.ts';
import { FakeRamDiskDriver } from './helpers/fake-ram-disk.ts';

const CONFIG = { DriveLetter: 'S' };
const OwnerFileSchema = z.object({ pid: z.number() });
const BudgetMarkerFileSchema = z.object({ budgetBytes: z.number() });

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
  assert.equal(driver.watchedOwnerPid, process.pid, 'the watcher waits on the pid the marker names');
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
  await assert.rejects(new RamDiskCache(driver).prepare(CONFIG, [NEXT], NEXT), /create failed: The operation was canceled by the user/u);
});

test('every engine budget declaration left on the disk is cleared before a launch, and the cached pages stay', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT, BIG], NEXT);
  await cache.prepare(CONFIG, [NEXT, BIG], BIG);
  const root = driver.disk?.root ?? '';
  for (const id of ['flash-next', 'qwen-27b']) {
    fs.mkdirSync(path.join(root, id, 'c375d7f601493972'), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'c375d7f601493972', 'budget.json'), '{"root_size": 10737418240, "pid": 44336}');
    fs.writeFileSync(path.join(root, id, 'c375d7f601493972', 'index.sqlite'), 'pages');
  }
  await cache.prepare(CONFIG, [preset('flash-next', true, 11), preset('qwen-27b', true, 12)], BIG);
  for (const id of ['flash-next', 'qwen-27b']) {
    assert.equal(fs.existsSync(path.join(root, id, 'c375d7f601493972', 'budget.json')), false, id);
    assert.ok(fs.existsSync(path.join(root, id, 'c375d7f601493972', 'index.sqlite')), id);
  }
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
  assert.deepEqual(fs.readdirSync(path.join(root, 'flash-next')), [BUDGET_MARKER_FILE], 'lowered budget: wiped and remade with only its marker');
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]?.event), ['ram_disk_folder_wiped']);
});

// Real case (run e85529c8): exllamav3 filled the 27B folder to 1.1 MB under its budget; one more write and a swap wiped it.
test('a folder filled past its unchanged budget keeps its cache; only a lowered budget wipes it', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  const small = preset('flash-next', true, 1);
  await cache.prepare(CONFIG, [small, BIG], small);
  const root = driver.disk?.root ?? '';
  const pages = fs.openSync(path.join(root, 'flash-next', 'pages.bin'), 'w');
  fs.ftruncateSync(pages, GIB + 4096);
  fs.closeSync(pages);
  await cache.prepare(CONFIG, [small, BIG], BIG);
  await cache.prepare(CONFIG, [small, BIG], small);
  assert.ok(fs.existsSync(path.join(root, 'flash-next', 'pages.bin')), 'over its own budget by overhead only: kept');
  assert.deepEqual(warnings.mock.calls, []);
  await cache.prepare(CONFIG, [preset('flash-next', true, 2), BIG], BIG);
  assert.ok(fs.existsSync(path.join(root, 'flash-next', 'pages.bin')), 'a raised budget keeps the cache too');
  const marker = BudgetMarkerFileSchema.parse(JSON.parse(fs.readFileSync(path.join(root, 'flash-next', BUDGET_MARKER_FILE), 'utf8')));
  assert.equal(marker.budgetBytes, 2 * GIB);
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
  fs.writeFileSync(path.join(leftover.root, OWNER_FILE), '{"pid":');
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
  fs.writeFileSync(path.join(disk.root, OWNER_FILE), JSON.stringify({ pid: 2_147_483_647 }));
  await cache.prepare(CONFIG, [NEXT], NEXT);
  assert.deepEqual(driver.calls.slice(-3), ['find', 'remove S', `create S ${String(requiredRamDiskBytes([11]))}`]);
});

test('release removes the disk, and a leftover is removed at the first check while a live owner disk is never touched', async (t) => {
  t.mock.method(serverLogger, 'warning', () => {});
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.prepare(CONFIG, [NEXT], NEXT);
  await cache.release();
  assert.equal(driver.disk, null);

  const leftover = new FakeRamDiskDriver();
  leftover.plantLeftover('S', GIB, null);
  await new RamDiskCache(leftover).release();
  assert.deepEqual(leftover.calls, ['find', 'remove S']);

  const foreign = new FakeRamDiskDriver();
  foreign.plantLeftover('S', GIB, process.ppid);
  const other = new RamDiskCache(foreign);
  await other.release();
  assert.deepEqual(foreign.calls, ['find'], 'a disk of a live SiftKit process is left alone');
  await assert.rejects(other.prepare(CONFIG, [NEXT], NEXT), new RegExp(`RAM disk S: belongs to SiftKit process ${String(process.ppid)}`, 'u'));
});

test('without a disk, release looks for a leftover once and then does nothing', async () => {
  const driver = new FakeRamDiskDriver();
  const cache = new RamDiskCache(driver);
  await cache.release();
  await cache.release();
  assert.deepEqual(driver.calls, ['find']);
});
