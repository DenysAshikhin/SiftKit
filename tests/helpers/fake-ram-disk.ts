import fs from 'node:fs';
import path from 'node:path';

import type { RamDisk, RamDiskDriver } from '../../src/status-server/ram-disk-cache.ts';
import { createManagedTempDir } from './temp-dirs.ts';

/** A RAM disk whose root is a temp directory; it records every call and can fail one operation on demand. */
export class FakeRamDiskDriver implements RamDiskDriver {
  readonly calls: string[] = [];
  disk: RamDisk | null = null;
  failNext: 'create' | 'grow' | 'remove' | null = null;
  private readonly base = createManagedTempDir('siftkit-fake-ram-disk-');
  private serial = 0;

  /** A disk left by an earlier server: `ownerPid` null leaves no marker. */
  plantLeftover(letter: string, sizeBytes: number, ownerPid: number | null): RamDisk {
    this.disk = this.mount(letter, sizeBytes);
    if (ownerPid !== null) fs.writeFileSync(path.join(this.disk.root, 'siftkit-owner.json'), JSON.stringify({ pid: ownerPid }));
    return this.disk;
  }

  async find(): Promise<RamDisk | null> {
    this.calls.push('find');
    return this.disk;
  }

  async create(toolPath: string, letter: string, sizeBytes: number): Promise<RamDisk> {
    this.calls.push(`create ${letter} ${String(sizeBytes)}`);
    this.failIf('create', toolPath);
    this.disk = this.mount(letter, sizeBytes);
    return this.disk;
  }

  async grow(toolPath: string, disk: RamDisk, sizeBytes: number): Promise<RamDisk> {
    this.calls.push(`grow ${disk.letter} ${String(sizeBytes)}`);
    this.failIf('grow', toolPath);
    this.disk = { ...disk, sizeBytes };
    return this.disk;
  }

  async remove(toolPath: string, disk: RamDisk): Promise<void> {
    this.calls.push(`remove ${disk.letter}`);
    this.failIf('remove', toolPath);
    fs.rmSync(disk.root, { recursive: true, force: true });
    this.disk = null;
  }

  removeDetached(_toolPath: string, disk: RamDisk): void {
    this.calls.push(`remove-detached ${disk.letter}`);
  }

  private mount(letter: string, sizeBytes: number): RamDisk {
    this.serial += 1;
    const root = path.join(this.base, `${letter}-${String(this.serial)}`);
    fs.mkdirSync(root);
    return { letter, root, sizeBytes };
  }

  private failIf(operation: 'create' | 'grow' | 'remove', toolPath: string): void {
    if (this.failNext !== operation) return;
    this.failNext = null;
    throw new Error(`${operation} failed (${toolPath}): The operation was canceled by the user.`);
  }
}
