import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  KeyMaterialDtoSchema,
  type AssistantRestorePreviewResponse,
  type AssistantRestoreResult,
} from '@siftkit/contracts';
import { parseJsonText } from '../../lib/json.js';
import { z } from '../../lib/zod.js';
import { ZipFileReader } from '../../lib/zip-file-reader.js';
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

  /**
   * Verifies the uploaded archive end to end and parks a copy. Nothing is mutated until
   * `confirm`. The upload is read from disk throughout — a backup is the size of the whole
   * evidence tree and never belongs in the heap.
   */
  async preview(uploadPath: string): Promise<AssistantRestorePreviewResponse> {
    const reader = await ZipFileReader.open(uploadPath);
    let manifest: BackupManifest;
    let fileCount: number;
    let totalBytes = 0;
    try {
      await this.verifyEntries(reader);
      manifest = this.readManifest(reader);
      const names = reader.entryNames();
      fileCount = names.length;
      for (const name of names) totalBytes += reader.entrySize(name);
    } finally {
      await reader.close();
    }

    const uploadId = `upload_${randomBytes(16).toString('hex')}`;
    const archivePath = path.join(this.uploadsDir, `${uploadId}.zip`);
    // A backup is the size of the whole evidence tree; copying it synchronously would stall the
    // status server for exactly as long as the streamed verification above avoided stalling it.
    await fs.promises.mkdir(this.uploadsDir, { recursive: true });
    await fs.promises.copyFile(uploadPath, archivePath);

    const confirmToken = randomBytes(32).toString('base64url');
    this.pending.set(uploadId, { archivePath, confirmToken });
    this.evictBeyondCap();

    return {
      uploadId,
      confirmToken,
      schemaVersion: manifest.schemaVersion,
      custody: manifest.custody,
      fileCount,
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

    const snapshotPath = path.join(this.uploadsDir, `${uploadId}.sqlite`);
    const reader = await ZipFileReader.open(request.archivePath);
    let recovered: boolean;
    try {
      // Re-verify: the parked file could have been swapped since the preview.
      await this.verifyEntries(reader);
      this.readManifest(reader);

      await this.replaceRows(reader, snapshotPath);
      await this.replaceBlobTree(reader);
      recovered = await this.recoverKey(reader);
    } finally {
      await reader.close();
      fs.rmSync(snapshotPath, { force: true });
    }

    // Only a completed restore retires the upload; a failure leaves it parked for a retry. The
    // reader is closed above, so Windows will let the archive go.
    this.pending.delete(uploadId);
    fs.rmSync(request.archivePath, { force: true });
    return {
      ok: true,
      blobsReadable: recovered,
      warning: recovered ? null : UNREADABLE_BLOBS_WARNING,
    };
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
  private async verifyEntries(reader: ZipFileReader): Promise<void> {
    const manifest = this.readManifestOnly(reader);
    for (const [name, hash] of Object.entries(manifest.files)) {
      if (!reader.hasEntry(name)) {
        throw new Error(`Backup entry ${name} is missing.`);
      }
      if (await reader.hashEntry(name) !== hash) {
        throw new Error(`Backup entry ${name} failed its manifest hash check.`);
      }
    }
    for (const name of reader.entryNames()) {
      if (name !== MANIFEST_ENTRY && manifest.files[name] === undefined) {
        throw new Error(`Backup entry ${name} is not covered by the manifest hash list.`);
      }
    }
  }

  private readManifestOnly(reader: ZipFileReader): BackupManifest {
    if (!reader.hasEntry(MANIFEST_ENTRY)) throw new Error('Backup is missing its manifest.json.');
    return parseJsonText(reader.readEntry(MANIFEST_ENTRY).toString('utf8'), BackupManifestSchema);
  }

  private readManifest(reader: ZipFileReader): BackupManifest {
    const manifest = this.readManifestOnly(reader);
    if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Backup schema version ${manifest.schemaVersion} is newer than this build's `
        + `${CURRENT_SCHEMA_VERSION}; upgrade SiftKit before restoring.`,
      );
    }
    if (!reader.hasEntry(SNAPSHOT_ENTRY)) throw new Error('Backup is missing its database snapshot.');
    return manifest;
  }

  /**
   * Copies the assistant tables out of the snapshot, table by table, over an explicit column
   * intersection so an older backup restores into today's columns without silently dropping
   * anything the two schemas share.
   */
  private async replaceRows(reader: ZipFileReader, snapshotPath: string): Promise<void> {
    await reader.extractTo(SNAPSHOT_ENTRY, snapshotPath);
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
  private async replaceBlobTree(reader: ZipFileReader): Promise<void> {
    const root = assistantEvidenceDir(this.graph.runtimeRoot);
    fs.rmSync(root, { recursive: true, force: true });
    for (const name of reader.entryNames()) {
      if (!name.startsWith(BLOB_PREFIX)) continue;
      const target = path.join(root, ...name.slice(BLOB_PREFIX.length).split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await reader.extractTo(name, target);
    }
  }

  /**
   * Unseals the backup key and proves it reads the restored evidence. A key that cannot be
   * unsealed here — a backup from another machine or account — is reported, never swallowed.
   */
  private async recoverKey(reader: ZipFileReader): Promise<boolean> {
    if (!reader.hasEntry(KEY_ENTRY)) return false;
    const sealed = reader.readEntry(KEY_ENTRY);
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
