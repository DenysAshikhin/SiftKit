import fs from 'node:fs';
import path from 'node:path';

import { PRESET_ID_PATTERN } from '@siftkit/contracts';
import type { Exl3RamDiskConfig, ModelRuntimePreset } from '../config/types.ts';
import { GIB, requiredRamDiskBytes } from '../inference-presets/cache-sizing.ts';
import { toError } from '../lib/errors.ts';
import { parseJsonValueText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';
import { serverLogger } from './server-logger.ts';

export const OWNER_FILE = 'siftkit-owner.json';
// exllamav3's per-directory record of the disk budget its process uses.
const BUDGET_FILE = 'budget.json';
const OwnerSchema = z.object({ pid: z.number().int().positive() });

/** SiftKit's mounted RAM disk: its letter, the directory it is mounted at, and its size. */
export type RamDisk = { readonly letter: string; readonly root: string; readonly sizeBytes: number };

/** Finds, creates, grows, and removes SiftKit's RAM disk; every call but `find` may need elevation. */
export interface RamDiskDriver {
  find(): Promise<RamDisk | null>;
  /** Also starts a watcher that removes the disk once process `ownerPid` exits, however it exits. */
  create(letter: string, sizeBytes: number, ownerPid: number): Promise<RamDisk>;
  grow(disk: RamDisk, sizeBytes: number): Promise<RamDisk>;
  remove(disk: RamDisk): Promise<void>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live SiftKit process, other than this one, that owns `disk`; a missing or corrupt marker means none. */
function liveOwner(disk: RamDisk): number | null {
  const file = path.join(disk.root, OWNER_FILE);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = OwnerSchema.safeParse(parseJsonValueText(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  if (!parsed.success || parsed.data.pid === process.pid || !isAlive(parsed.data.pid)) return null;
  return parsed.data.pid;
}

function directoryBytes(directory: string): number {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .reduce((sum, entry) => sum + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);
}

/** Keeps SiftKit's RAM disk sized for the RAM-disk presets in use; runs only while no engine uses the disk. */
export class RamDiskCache {
  private disk: RamDisk | null = null;
  /** Set once no disk is found or a found one was claimed as a leftover; a live owner's disk is looked up again. */
  private checked = false;
  private readonly driver: RamDiskDriver;

  constructor(driver: RamDiskDriver) {
    this.driver = driver;
  }

  /** Readies the disk and `preset`'s folder before an engine that caches on it launches. */
  async prepare(config: Exl3RamDiskConfig, presets: readonly ModelRuntimePreset[], preset: ModelRuntimePreset): Promise<void> {
    await this.removeLeftover(true);
    const ramDiskPresets = presets.filter((entry) => entry.RamDiskCache);
    const required = requiredRamDiskBytes(ramDiskPresets.map((entry) => entry.RamDiskCacheGiB));
    let disk = this.disk;
    if (disk !== null && disk.letter !== config.DriveLetter) {
      await this.driver.remove(disk);
      disk = null;
    }
    if (disk === null) disk = await this.create(config.DriveLetter, required);
    else if (disk.sizeBytes < required) disk = await this.grow(disk, required);
    this.disk = disk;
    this.tidyFolders(disk, ramDiskPresets);
    fs.mkdirSync(path.join(disk.root, preset.id), { recursive: true });
  }

  /** For a switch to a preset without the disk: removes it once no engine caches on it; a leftover found at the first check goes too. */
  async release(): Promise<void> {
    await this.removeLeftover(false);
    const disk = this.disk;
    if (disk === null) return;
    await this.driver.remove(disk);
    this.disk = null;
  }

  /** Until a check succeeds, removes a disk an earlier server left; a live owner's disk fails a load and is skipped by release. */
  private async removeLeftover(failOnLiveOwner: boolean): Promise<void> {
    if (this.checked) return;
    const found = await this.driver.find();
    const owner = found === null ? null : liveOwner(found);
    if (found !== null && owner !== null) {
      if (failOnLiveOwner) throw new Error(`RAM disk ${found.letter}: belongs to SiftKit process ${String(owner)}.`);
      return;
    }
    this.checked = true;
    if (found === null) return;
    serverLogger.warning({ scope: 'exl3', id: found.letter, event: 'ram_disk_leftover_removed', fields: '',
      alert: `Removed a leftover SiftKit RAM disk ${found.letter}: from an earlier server.` });
    await this.driver.remove(found);
  }

  /** One owner pid for the marker and the driver's watcher, which removes the disk only while the two agree. */
  private async create(letter: string, sizeBytes: number): Promise<RamDisk> {
    const ownerPid = process.pid;
    const disk = await this.driver.create(letter, sizeBytes, ownerPid);
    fs.writeFileSync(path.join(disk.root, OWNER_FILE), JSON.stringify({ pid: ownerPid }));
    return disk;
  }

  private async grow(disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    try {
      return await this.driver.grow(disk, sizeBytes);
    } catch (error) {
      serverLogger.warning({ scope: 'exl3', id: disk.letter, event: 'ram_disk_recreated', fields: '',
        alert: `Could not grow RAM disk ${disk.letter}: (${toError(error).message}); recreated it empty.` });
      await this.driver.remove(disk);
      return this.create(disk.letter, sizeBytes);
    }
  }

  /** Only folders named like preset ids are SiftKit's; NTFS keeps its own (System Volume Information) at the root. */
  private tidyFolders(disk: RamDisk, ramDiskPresets: readonly ModelRuntimePreset[]): void {
    const budgets = new Map(ramDiskPresets.map((entry) => [entry.id, entry.RamDiskCacheGiB * GIB]));
    for (const entry of fs.readdirSync(disk.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PRESET_ID_PATTERN.test(entry.name)) continue;
      const folder = path.join(disk.root, entry.name);
      const budget = budgets.get(entry.name);
      if (budget === undefined) {
        fs.rmSync(folder, { recursive: true, force: true });
      } else if (directoryBytes(folder) > budget) {
        serverLogger.warning({ scope: 'exl3', id: entry.name, event: 'ram_disk_folder_wiped', fields: '',
          alert: `RAM disk cache of preset '${entry.name}' exceeded its lowered budget; wiped it.` });
        fs.rmSync(folder, { recursive: true, force: true });
      } else {
        clearBudgetDeclarations(folder);
      }
    }
  }
}

/**
 * exllamav3 on Windows leaves its budget.json behind at close (it deletes the file while still holding it open), and a
 * leftover with another budget refuses the next engine for 10 minutes. No engine runs during prepare, so every one is stale.
 */
function clearBudgetDeclarations(folder: string): void {
  for (const cacheDirectory of fs.readdirSync(folder, { withFileTypes: true })) {
    if (cacheDirectory.isDirectory()) fs.rmSync(path.join(folder, cacheDirectory.name, BUDGET_FILE), { force: true });
  }
}
