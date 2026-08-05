import fs from 'node:fs';
import path from 'node:path';

import type { JsonObject } from '../../lib/json-types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';
import type { BlobCipher } from '../crypto/blob-cipher.js';
import type { EvidenceSourceType, EvidenceStatus, Sensitivity } from '../domain/enums.js';
import { hashBytes, hashTextContent } from '../domain/keys.js';
import type { IdGenerator } from '../ids.js';
import {
  BlobRowSchema, CountRowSchema, EvidenceRowSchema, type BlobRow, type EvidenceRow,
} from './rows.js';

interface EvidenceCommonInput {
  readonly ownerId: string;
  readonly deviceId: string | null;
  readonly sourceEventId: string;
  readonly parentEvidenceId: string | null;
  readonly sourceType: EvidenceSourceType;
  readonly sourceRef: string | null;
  readonly capturedAtUtc: string;
  readonly sourceTimezone: string | null;
  readonly sensitivity: Sensitivity;
  readonly retentionUntilUtc: string | null;
  readonly metadata: JsonObject;
}

export interface RecordTextEvidenceInput extends EvidenceCommonInput {
  readonly text: string;
}

export interface RecordBlobEvidenceInput extends EvidenceCommonInput {
  readonly mimeType: string;
  readonly bytes: Buffer;
}

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Owns evidence records and encrypted blob files. Storage URIs are derived from the content hash
 * only; any other shape is rejected before a path is built (§5.6, §17.1 path traversal).
 */
export class EvidenceStore {
  constructor(
    private readonly database: RuntimeDatabase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly cipher: BlobCipher,
    private readonly evidenceRoot: string,
  ) {}

  recordTextEvidence(input: RecordTextEvidenceInput): EvidenceRow {
    const existing = this.findBySourceEventId(input.ownerId, input.sourceEventId);
    if (existing !== null) return existing;
    return this.insertEvidence(input, hashTextContent(input.text), null, 'text/plain');
  }

  recordBlobEvidence(input: RecordBlobEvidenceInput): EvidenceRow {
    const existing = this.findBySourceEventId(input.ownerId, input.sourceEventId);
    if (existing !== null) return existing;
    const contentHash = hashBytes(input.bytes);
    const blob = this.persistBlob(input.ownerId, contentHash, input.mimeType, input.bytes);
    return this.insertEvidence(input, contentHash, blob.id, input.mimeType);
  }

  getEvidence(evidenceId: string): EvidenceRow | null {
    const row = this.database.prepare('SELECT * FROM evidence_records WHERE id = ?').get(evidenceId);
    return row === undefined || row === null ? null : EvidenceRowSchema.parse(row);
  }

  requireEvidence(evidenceId: string): EvidenceRow {
    const evidence = this.getEvidence(evidenceId);
    if (evidence === null) {
      throw new Error(`Unknown evidence record: ${evidenceId}`);
    }
    return evidence;
  }

  findBySourceEventId(ownerId: string, sourceEventId: string): EvidenceRow | null {
    const row = this.database
      .prepare('SELECT * FROM evidence_records WHERE owner_id = ? AND source_event_id = ?')
      .get(ownerId, sourceEventId);
    return row === undefined || row === null ? null : EvidenceRowSchema.parse(row);
  }

  countEvidence(ownerId: string): number {
    return CountRowSchema.parse(this.database
      .prepare("SELECT COUNT(*) AS count FROM evidence_records WHERE owner_id = ? AND status <> 'deleted'")
      .get(ownerId)).count;
  }

  countBlobs(ownerId: string): number {
    return CountRowSchema.parse(this.database
      .prepare('SELECT COUNT(*) AS count FROM evidence_blobs WHERE owner_id = ? AND deleted_at_utc IS NULL')
      .get(ownerId)).count;
  }

  requireBlob(blobId: string): BlobRow {
    const row = this.database.prepare('SELECT * FROM evidence_blobs WHERE id = ?').get(blobId);
    if (row === undefined || row === null) {
      throw new Error(`Unknown evidence blob: ${blobId}`);
    }
    return BlobRowSchema.parse(row);
  }

  setStatus(evidenceId: string, status: EvidenceStatus): EvidenceRow {
    const nowUtc = this.clock.nowUtc();
    this.database
      .prepare('UPDATE evidence_records SET status = ?, updated_at_utc = ? WHERE id = ?')
      .run(status, nowUtc, evidenceId);
    return this.requireEvidence(evidenceId);
  }

  /**
   * Marks the record deleted and purges its blob file, but only when no other live record still
   * references that blob.
   */
  deleteEvidence(evidenceId: string): EvidenceRow {
    const evidence = this.requireEvidence(evidenceId);
    this.setStatus(evidenceId, 'deleted');
    if (evidence.blob_id === null) return this.requireEvidence(evidenceId);

    const remaining = CountRowSchema.parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM evidence_records
      WHERE blob_id = ? AND status <> 'deleted'
    `).get(evidence.blob_id)).count;
    if (remaining > 0) return this.requireEvidence(evidenceId);

    const blob = this.requireBlob(evidence.blob_id);
    const filePath = this.resolveBlobPath(blob.storage_uri);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath);
    }
    this.database
      .prepare('UPDATE evidence_blobs SET deleted_at_utc = ? WHERE id = ?')
      .run(this.clock.nowUtc(), blob.id);
    return this.requireEvidence(evidenceId);
  }

  readBlobBytes(blobId: string): Buffer {
    const blob = this.requireBlob(blobId);
    if (blob.deleted_at_utc !== null) {
      throw new Error(`Evidence blob ${blobId} has been deleted.`);
    }
    const plaintext = this.cipher.decrypt(fs.readFileSync(this.resolveBlobPath(blob.storage_uri)));
    if (hashBytes(plaintext) !== blob.content_hash) {
      throw new Error(`Evidence blob ${blobId} content hash mismatch.`);
    }
    return plaintext;
  }

  /**
   * A storage URI is a bare content hash. Anything else — a path, a traversal, an empty string —
   * is rejected before a filesystem path is constructed.
   */
  resolveBlobPath(storageUri: string): string {
    if (!CONTENT_HASH_PATTERN.test(storageUri)) {
      throw new Error(
        `Evidence storage URI must be a bare SHA-256 content hash, received: ${storageUri}`,
      );
    }
    const resolved = path.resolve(this.evidenceRoot, storageUri.slice(0, 2), storageUri);
    const root = path.resolve(this.evidenceRoot);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error('Evidence storage URI escapes the evidence root.');
    }
    return resolved;
  }

  private persistBlob(
    ownerId: string, contentHash: string, mimeType: string, bytes: Buffer,
  ): BlobRow {
    const existing = this.database
      .prepare('SELECT * FROM evidence_blobs WHERE owner_id = ? AND content_hash = ?')
      .get(ownerId, contentHash);
    if (existing !== undefined && existing !== null) {
      return BlobRowSchema.parse(existing);
    }

    const filePath = this.resolveBlobPath(contentHash);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const encrypted = this.cipher.encrypt(bytes);
    fs.writeFileSync(filePath, encrypted.envelope);

    const id = this.ids.next('blob');
    this.database.prepare(`
      INSERT INTO evidence_blobs (
        id, owner_id, content_hash, byte_length, mime_type, storage_uri, encrypted, key_id,
        created_at_utc, deleted_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `).run(
      id, ownerId, contentHash, bytes.byteLength, mimeType, contentHash,
      encrypted.keyId, this.clock.nowUtc(),
    );
    return this.requireBlob(id);
  }

  private insertEvidence(
    input: EvidenceCommonInput, contentHash: string, blobId: string | null, mimeType: string,
  ): EvidenceRow {
    const id = this.ids.next('ev');
    const nowUtc = this.clock.nowUtc();
    this.database.prepare(`
      INSERT INTO evidence_records (
        id, owner_id, device_id, source_event_id, parent_evidence_id, blob_id, source_type,
        source_ref, captured_at_utc, source_timezone, ingested_at_utc, content_hash, mime_type,
        sensitivity, retention_until_utc, status, metadata_json, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      id, input.ownerId, input.deviceId, input.sourceEventId, input.parentEvidenceId, blobId,
      input.sourceType, input.sourceRef, input.capturedAtUtc, input.sourceTimezone, nowUtc,
      contentHash, mimeType, input.sensitivity, input.retentionUntilUtc,
      JSON.stringify(input.metadata), nowUtc, nowUtc,
    );
    return this.requireEvidence(id);
  }
}