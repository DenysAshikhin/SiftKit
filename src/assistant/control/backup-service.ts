import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ZipWriter } from '../../lib/zip.js';
import { CURRENT_SCHEMA_VERSION, type RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { dpapiProtect } from '../crypto/dpapi.js';
import type { KeyCustodyService } from '../crypto/key-custody.js';
import { assistantEvidenceDir } from '../layout.js';
import {
  BLOB_PREFIX, KEY_ENTRY, MANIFEST_ENTRY, SNAPSHOT_ENTRY, type BackupManifest,
} from './backup-format.js';

export interface BackupServiceOptions {
  readonly graph: AssistantGraph;
  readonly database: RuntimeDatabase;
  readonly keyCustody: KeyCustodyService;
}

/**
 * §16.4 backup: a consistent online snapshot of the runtime database, the evidence tree exactly
 * as it sits on disk (still encrypted), and the evidence key sealed under DPAPI. The manifest
 * hashes every entry, so a restore can refuse a damaged or edited artifact before it touches
 * anything. The key never reaches the archive in the clear — without the user's Windows account
 * the backup is inert.
 */
export class BackupService {
  private readonly graph: AssistantGraph;
  private readonly database: RuntimeDatabase;
  private readonly keyCustody: KeyCustodyService;

  constructor(options: BackupServiceOptions) {
    this.graph = options.graph;
    this.database = options.database;
    this.keyCustody = options.keyCustody;
  }

  async createBackup(): Promise<Buffer> {
    const writer = new ZipWriter();
    const hashes: Record<string, string> = {};
    const add = (name: string, data: Buffer): void => {
      writer.add(name, data);
      hashes[name] = createHash('sha256').update(data).digest('hex');
    };

    add(SNAPSHOT_ENTRY, await this.snapshot());
    for (const [name, bytes] of this.blobFiles()) add(name, bytes);
    add(KEY_ENTRY, await dpapiProtect(
      Buffer.from(JSON.stringify(this.keyCustody.exportForBackup()), 'utf8'),
    ));

    // Written last so it can hash everything else; it is the one entry not covered itself.
    const manifest: BackupManifest = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAtUtc: this.graph.nowUtc(),
      custody: this.keyCustody.status().custody,
      files: hashes,
    };
    writer.add(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    return writer.build();
  }

  /** better-sqlite3's online backup: consistent without blocking writers or closing the file. */
  private async snapshot(): Promise<Buffer> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-backup-'));
    const snapshotPath = path.join(directory, SNAPSHOT_ENTRY);
    try {
      await this.database.backup(snapshotPath);
      return fs.readFileSync(snapshotPath);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  /** Every file under the evidence tree, keyed by its path relative to that root. */
  private blobFiles(): Map<string, Buffer> {
    const root = assistantEvidenceDir(this.graph.runtimeRoot);
    const files = new Map<string, Buffer>();
    if (!fs.existsSync(root)) return files;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      files.set(`${BLOB_PREFIX}${relative}`, fs.readFileSync(absolute));
    }
    return files;
  }
}
