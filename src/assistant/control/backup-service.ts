import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { CURRENT_SCHEMA_VERSION, type RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { dpapiProtect } from '../crypto/dpapi.js';
import type { KeyCustodyService } from '../crypto/key-custody.js';
import { assistantEvidenceDir } from '../layout.js';
import {
  BLOB_PREFIX, KEY_ENTRY, MANIFEST_ENTRY, SNAPSHOT_ENTRY, type BackupManifest,
} from './backup-format.js';
import { TempArchiveBuilder, type TempArchive } from './temp-archive.js';

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

  /**
   * The archive is streamed to a temp file: a backup is the size of the whole evidence tree,
   * which has no business sitting in the heap. The caller owns the returned handle and must
   * `cleanup()` it once the bytes are delivered.
   */
  async createBackup(): Promise<TempArchive> {
    const builder = new TempArchiveBuilder('siftkit-backup-');
    try {
      const hashes: Record<string, string> = {};

      const snapshotPath = builder.scratchPath(SNAPSHOT_ENTRY);
      await this.database.backup(snapshotPath);
      hashes[SNAPSHOT_ENTRY] = await hashFile(snapshotPath);
      await builder.writer.addFile(SNAPSHOT_ENTRY, snapshotPath);
      fs.rmSync(snapshotPath, { force: true });

      for (const [name, absolute] of this.blobFilePaths()) {
        hashes[name] = await hashFile(absolute);
        await builder.writer.addFile(name, absolute);
      }

      const keyBytes = await dpapiProtect(
        Buffer.from(JSON.stringify(this.keyCustody.exportForBackup()), 'utf8'),
      );
      hashes[KEY_ENTRY] = createHash('sha256').update(keyBytes).digest('hex');
      builder.writer.addBuffer(KEY_ENTRY, keyBytes);

      // Written last so it can hash everything else; it is the one entry not covered itself.
      const manifest: BackupManifest = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAtUtc: this.graph.nowUtc(),
        custody: this.keyCustody.status().custody,
        files: hashes,
      };
      builder.writer.addBuffer(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      return builder.finish();
    } catch (error) {
      builder.cleanup();
      throw error;
    }
  }

  /** Absolute paths of every file under the evidence tree, keyed by archive entry name. */
  private blobFilePaths(): Map<string, string> {
    const root = assistantEvidenceDir(this.graph.runtimeRoot);
    const files = new Map<string, string>();
    if (!fs.existsSync(root)) return files;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      files.set(`${BLOB_PREFIX}${relative}`, absolute);
    }
    return files;
  }
}

/** Hashes a file without reading it whole; the manifest covers entries of any size. */
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}
