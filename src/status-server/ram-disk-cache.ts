import fs from 'node:fs';
import path from 'node:path';

import { PRESET_ID_PATTERN } from '@siftkit/contracts';
import type { Exl3RamDiskConfig, ModelRuntimePreset } from '../config/types.ts';
import { GIB, requiredRamDiskBytes } from '../inference-presets/cache-sizing.ts';
import { parseJsonValueText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';
import { serverLogger } from './server-logger.ts';

const OWNER_FILE = 'siftkit-owner.json';
const OwnerSchema = z.object({ pid: z.number().int().positive() });

/** SiftKit's mounted RAM disk: its letter, the directory it is mounted at, and its size. */
export type RamDisk = { readonly letter: string; readonly root: string; readonly sizeBytes: number };

/** Finds, creates, grows, and removes SiftKit's RAM disk; every call but `find` may need elevation. */
export interface RamDiskDriver {
  find(): Promise<RamDisk | null>;
  create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk>;
  grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk>;
  remove(toolPath: string, disk: RamDisk): Promise<void>;
  /** Starts the removal and returns at once, for the synchronous process-exit path. */
  removeDetached(toolPath: string, disk: RamDisk): void;
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

function requireToolPath(config: Exl3RamDiskConfig): string {
  if (config.ToolPath === null) throw new Error('RAM disk cache needs Server.Engines.Exl3.RamDisk.ToolPath (aim_ll.exe).');
  return config.ToolPath;
}

/** Keeps SiftKit's RAM disk sized for every RAM-disk preset; runs only while no engine uses the disk. */
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
    const toolPath = requireToolPath(config);
    await this.removeLeftover(toolPath, true);
    const ramDiskPresets = presets.filter((entry) => entry.RamDiskCache);
    const required = requiredRamDiskBytes(ramDiskPresets.map((entry) => entry.RamDiskCacheGiB));
    let disk = this.disk;
    if (disk !== null && disk.letter !== config.DriveLetter) {
      await this.driver.remove(toolPath, disk);
      disk = null;
    }
    if (disk === null) disk = await this.create(toolPath, config.DriveLetter, required);
    else if (disk.sizeBytes < required) disk = await this.grow(toolPath, disk, required);
    this.disk = disk;
    this.tidyFolders(disk, ramDiskPresets);
    fs.mkdirSync(path.join(disk.root, preset.id), { recursive: true });
  }

  /** Removes SiftKit's disk, if any, once no engine caches on it; a leftover found at the first check goes too. */
  async release(config: Exl3RamDiskConfig): Promise<void> {
    if (this.disk === null && (this.checked || config.ToolPath === null)) return;
    const toolPath = requireToolPath(config);
    await this.removeLeftover(toolPath, false);
    const disk = this.disk;
    if (disk === null) return;
    await this.driver.remove(toolPath, disk);
    this.disk = null;
  }

  releaseForProcessExitSync(config: Exl3RamDiskConfig): void {
    if (this.disk === null || config.ToolPath === null) return;
    this.driver.removeDetached(config.ToolPath, this.disk);
    this.disk = null;
  }

  /** Until a check succeeds, removes a disk an earlier server left; a live owner's disk fails a load and is skipped by release. */
  private async removeLeftover(toolPath: string, failOnLiveOwner: boolean): Promise<void> {
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
    await this.driver.remove(toolPath, found);
  }
  private async create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk> {
    const disk = await this.driver.create(toolPath, letter, sizeBytes);
    fs.writeFileSync(path.join(disk.root, OWNER_FILE), JSON.stringify({ pid: process.pid }));
    return disk;
  }

  private async grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    try {
      return await this.driver.grow(toolPath, disk, sizeBytes);
    } catch (error) {
      serverLogger.warning({ scope: 'exl3', id: disk.letter, event: 'ram_disk_recreated', fields: '',
        alert: `Could not grow RAM disk ${disk.letter}: (${error instanceof Error ? error.message : String(error)}); recreated it empty.` });
      await this.driver.remove(toolPath, disk);
      return this.create(toolPath, disk.letter, sizeBytes);
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
      }
    }
  }
}
