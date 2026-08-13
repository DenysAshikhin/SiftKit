import { z } from '../../lib/zod.js';

/**
 * The §16.4 backup archive format — the one definition both `BackupService` (writer) and
 * `RestoreService` (reader) build against, so the two sides cannot drift apart.
 */

export const SNAPSHOT_ENTRY = 'snapshot.sqlite';
export const KEY_ENTRY = 'key.protected';
export const MANIFEST_ENTRY = 'manifest.json';
export const BLOB_PREFIX = 'blobs/';

export const BackupManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  createdAtUtc: z.string(),
  custody: z.enum(['file', 'desktop']),
  /** entry name -> sha256 hex. Covers every entry except the manifest itself. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/u)),
}).strict();
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
