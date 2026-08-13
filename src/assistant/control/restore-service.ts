import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  KeyMaterialDtoSchema,
  type AssistantRestorePreviewResponse,
  type AssistantRestoreResult,
} from '@siftkit/contracts';
import { parseJsonText } from '../../lib/json.js';
import { z } from '../../lib/zod.js';
import { readZip } from '../../lib/zip.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabaseFile, type RuntimeDatabase } from '../../state/runtime-db.js';
import type { AssistantGraph } from '../assistant-graph.js';
import { DpapiUnavailableError, dpapiUnprotect } from '../crypto/dpapi.js';
import type { KeyCustodyService } from '../crypto/key-custody.js';
import { AssistantConflictError, AssistantNotFoundError } from '../errors.js';
import { assistantEvidenceDir, assistantRestoreUploadsDir } from '../layout.js';
import {
  ASSISTANT_FTS_TABLE_NAMES, ASSISTANT_METADATA_PREFIX, ASSISTANT_TABLE_NAMES,
} from '../storage/schema.js';
import {
  BLOB_PREFIX, KEY_ENTRY, MANIFEST_ENTRY, SNAPSHOT_ENTRY,
  BackupManifestSchema, type BackupManifest,
} from './backup-format.js';

const ATTACHED = 'restore_src';

/**
 * How many verified uploads may sit between preview and confirm. Beyond this the oldest is
 * evicted and its parked bytes deleted — an abandoned preview must not accumulate backups.
 */
export const MAX_PENDING_RESTORE_UPLOADS = 4;

const UNREADABLE_BLOBS_WARNING =
  'The evidence key could not be unsealed on this machine; graph and projections are restored, '
  + 'blob contents are unreadable.';

const ColumnRowSchema = z.object({ name: z.string() });

interface PendingRestore {
  readonly archivePath: string;
  readonly confirmToken: string;
}

export interface RestoreServiceOptions {
  readonly graph: AssistantGraph;
  readonly database: RuntimeDatabase;
  readonly keyCustody: KeyCustodyService;
}

/**
 * §16.4 restore. Two steps on purpose: `preview` verifies the artifact completely and parks it,
 * `confirm` replaces the assistant's rows, blob tree, and key. Only assistant-owned tables are
 * touched — the rest of the runtime database belongs to SiftKit, not to the backup.
 */
export class RestoreService {
  private readonly graph: AssistantGraph;
  private readonly database: RuntimeDatabase;
  private readonly keyCustody: KeyCustodyService;
  private readonly uploadsDir: string;
  private readonly pending = new Map<string, PendingRestore>();

  constructor(options: RestoreServiceOptions) {
    this.graph = options.graph;
    this.database = options.database;
    this.keyCustody = options.keyCustody;
    this.uploadsDir = assistantRestoreUploadsDir(this.graph.runtimeRoot);
    // Uploads parked by a previous process are unconfirmable — their tokens died with it.
    fs.rmSync(this.uploadsDir, { recursive: true, force: true });
  }

  /** Verifies the archive end to end and parks it. Nothing is mutated until `confirm`. */
  preview(archiveBytes: Buffer): AssistantRestorePreviewResponse {
    const entries = this.verifiedEntries(archiveBytes);
    const manifest = this.readManifest(entries);

    const uploadId = `upload_${randomBytes(16).toString('hex')}`;
    const archivePath = path.join(this.uploadsDir, `${uploadId}.zip`);
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    fs.writeFileSync(archivePath, archiveBytes);

    const confirmToken = randomBytes(32).toString('base64url');
    this.pending.set(uploadId, { archivePath, confirmToken });
    this.evictBeyondCap();

    let totalBytes = 0;
    for (const data of entries.values()) totalBytes += data.byteLength;
    return {
      uploadId,
      confirmToken,
      schemaVersion: manifest.schemaVersion,
      custody: manifest.custody,
      fileCount: entries.size,
      totalBytes,
    };
  }

  async confirm(uploadId: string, confirmToken: string): Promise<AssistantRestoreResult> {
    const request = this.pending.get(uploadId);
    if (request === undefined) {
      throw new AssistantNotFoundError(`Unknown restore upload: ${uploadId}`);
    }
    const supplied = Buffer.from(confirmToken, 'utf8');
    const expected = Buffer.from(request.confirmToken, 'utf8');
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new AssistantConflictError('Restore confirm token does not match this upload.');
    }
    // Re-verify: the parked file could have been swapped since the preview.
    const entries = this.verifiedEntries(fs.readFileSync(request.archivePath));
    this.readManifest(entries);

    const snapshotPath = path.join(this.uploadsDir, `${uploadId}.sqlite`);
    try {
      this.replaceRows(entries, snapshotPath);
      this.replaceBlobTree(entries);
      const recovered = await this.recoverKey(entries);
      this.pending.delete(uploadId);
      fs.rmSync(request.archivePath, { force: true });
      return {
        ok: true,
        blobsReadable: recovered,
        warning: recovered ? null : UNREADABLE_BLOBS_WARNING,
      };
    } finally {
      fs.rmSync(snapshotPath, { force: true });
    }
  }

  /** Oldest first — `pending` iterates in insertion order — with the parked bytes deleted too. */
  private evictBeyondCap(): void {
    while (this.pending.size > MAX_PENDING_RESTORE_UPLOADS) {
      const oldest = this.pending.entries().next();
      if (oldest.done === true) return;
      const [uploadId, entry] = oldest.value;
      this.pending.delete(uploadId);
      fs.rmSync(entry.archivePath, { force: true });
    }
  }

  /** Every entry, with each manifest hash checked. A damaged archive never reaches the database. */
  private verifiedEntries(archiveBytes: Buffer): Map<string, Buffer> {
    const entries = readZip(archiveBytes);
    const manifest = this.readManifestOnly(entries);
    for (const [name, hash] of Object.entries(manifest.files)) {
      const data = entries.get(name);
      if (data === undefined) {
        throw new Error(`Backup entry ${name} is missing.`);
      }
      if (createHash('sha256').update(data).digest('hex') !== hash) {
        throw new Error(`Backup entry ${name} failed its manifest hash check.`);
      }
    }
    for (const name of entries.keys()) {
      if (name !== MANIFEST_ENTRY && manifest.files[name] === undefined) {
        throw new Error(`Backup entry ${name} is not covered by the manifest hash list.`);
      }
    }
    return entries;
  }

  private readManifestOnly(entries: ReadonlyMap<string, Buffer>): BackupManifest {
    const raw = entries.get(MANIFEST_ENTRY);
    if (raw === undefined) throw new Error('Backup is missing its manifest.json.');
    return parseJsonText(raw.toString('utf8'), BackupManifestSchema);
  }

  private readManifest(entries: ReadonlyMap<string, Buffer>): BackupManifest {
    const manifest = this.readManifestOnly(entries);
    if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Backup schema version ${manifest.schemaVersion} is newer than this build's `
        + `${CURRENT_SCHEMA_VERSION}; upgrade SiftKit before restoring.`,
      );
    }
    if (!entries.has(SNAPSHOT_ENTRY)) throw new Error('Backup is missing its database snapshot.');
    return manifest;
  }

  /**
   * Copies the assistant tables out of the snapshot, table by table, over an explicit column
   * intersection so an older backup restores into today's columns without silently dropping
   * anything the two schemas share.
   */
  private replaceRows(entries: ReadonlyMap<string, Buffer>, snapshotPath: string): void {
    fs.writeFileSync(snapshotPath, entries.get(SNAPSHOT_ENTRY) ?? Buffer.alloc(0));
    migrateDatabaseFile(snapshotPath);

    // ATTACH cannot run inside a transaction, so it brackets the whole copy.
    this.database.exec(`ATTACH DATABASE '${snapshotPath.replace(/'/gu, "''")}' AS ${ATTACHED}`);
    try {
      const transaction = this.graph.transactions.begin();
      try {
        for (const table of ASSISTANT_FTS_TABLE_NAMES) {
          this.database.prepare(`DELETE FROM main.${table}`).run();
        }
        for (const table of ASSISTANT_TABLE_NAMES) {
          this.database.prepare(`DELETE FROM main.${table}`).run();
        }
        // Parents first, so every foreign key has its target by the time children land.
        for (const table of [...ASSISTANT_TABLE_NAMES].reverse()) this.copyTable(table);
        for (const table of ASSISTANT_FTS_TABLE_NAMES) this.copyTable(table);
        this.database.prepare(`
          INSERT OR REPLACE INTO main.runtime_metadata
          SELECT * FROM ${ATTACHED}.runtime_metadata WHERE key LIKE '${ASSISTANT_METADATA_PREFIX}%'
        `).run();
        transaction.commit();
      } catch (error) {
        transaction.rollbackAfter(error);
      }
    } finally {
      this.database.exec(`DETACH DATABASE ${ATTACHED}`);
    }
  }

  private copyTable(table: string): void {
    const columns = this.columnsOf('main', table)
      .filter((column) => this.columnsOf(ATTACHED, table).includes(column));
    if (columns.length === 0) return;
    const list = columns.join(', ');
    this.database.prepare(
      `INSERT INTO main.${table} (${list}) SELECT ${list} FROM ${ATTACHED}.${table}`,
    ).run();
  }

  private columnsOf(schema: string, table: string): string[] {
    return z.array(ColumnRowSchema)
      .parse(this.database.pragma(`${schema}.table_info(${table})`))
      .map((column) => column.name);
  }

  /** The blob tree is replaced wholesale: a half-old, half-new tree would be undetectable. */
  private replaceBlobTree(entries: ReadonlyMap<string, Buffer>): void {
    const root = assistantEvidenceDir(this.graph.runtimeRoot);
    fs.rmSync(root, { recursive: true, force: true });
    for (const [name, data] of entries) {
      if (!name.startsWith(BLOB_PREFIX)) continue;
      const target = path.join(root, ...name.slice(BLOB_PREFIX.length).split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }

  /**
   * Unseals the backup key and proves it reads the restored evidence. A key that cannot be
   * unsealed here — a backup from another machine or account — is reported, never swallowed.
   */
  private async recoverKey(entries: ReadonlyMap<string, Buffer>): Promise<boolean> {
    const sealed = entries.get(KEY_ENTRY);
    if (sealed === undefined) return false;
    try {
      const material = parseJsonText(
        (await dpapiUnprotect(sealed)).toString('utf8'),
        KeyMaterialDtoSchema,
      );
      this.keyCustody.adoptRestoredKeyMaterial(material);
      return true;
    } catch (error) {
      if (error instanceof DpapiUnavailableError) return false;
      throw error;
    }
  }
}
