import { PENDING_CAPTURE_LIST_STATES, PendingCaptureDtoSchema, type PendingCaptureDto } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { VaultNotFoundError } from './errors.ts';

export const VAULT_CAPTURE_STATES = [...PENDING_CAPTURE_LIST_STATES, 'processed', 'image_removed'] as const;
export const VaultCaptureStateSchema = z.enum(VAULT_CAPTURE_STATES);
export type VaultCaptureState = z.infer<typeof VaultCaptureStateSchema>;

export const VaultCaptureRowSchema = z.object({
  attachment_id: z.string(), note_id: z.string(), state: VaultCaptureStateSchema, foreground_context_key: z.string(),
  pixel_sha256: z.string(), perceptual_hash: z.string(), app: z.string(), window_title: z.string().nullable(),
  captured_at_utc: z.string(), processed_at_utc: z.string().nullable(),
});
export type VaultCaptureRow = z.infer<typeof VaultCaptureRowSchema>;
export type NewVaultCapture = Omit<VaultCaptureRow, 'processed_at_utc'>;

const PerceptualRowSchema = z.object({ perceptual_hash: z.string() });
const LiveCaptureRowSchema = z.object({ attachment_id: z.string(), byte_length: z.number(), captured_at_utc: z.string() });
export type LiveCapture = z.infer<typeof LiveCaptureRowSchema>;
const FolderCaptureRowSchema = z.object({ note_id: z.string(), relative_path: z.string() });
const AttachmentIdRowSchema = z.object({ attachment_id: z.string() });
const CountRowSchema = z.object({ count: z.number() });
const BytesRowSchema = z.object({ bytes: z.number() });
const placeholders = (values: readonly string[]) => values.map(() => '?').join(', ');

export function insertCapture(database: RuntimeDatabase, capture: NewVaultCapture): void {
  database.prepare(`
    INSERT INTO vault_captures (attachment_id, note_id, state, foreground_context_key, pixel_sha256, perceptual_hash, app, window_title, captured_at_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(capture.attachment_id, capture.note_id, capture.state, capture.foreground_context_key, capture.pixel_sha256,
    capture.perceptual_hash, capture.app, capture.window_title, capture.captured_at_utc);
}

export function requireCapture(database: RuntimeDatabase, attachmentId: string): VaultCaptureRow {
  const row = database.prepare('SELECT * FROM vault_captures WHERE attachment_id = ?').get(attachmentId);
  if (row === undefined) throw new VaultNotFoundError(`capture ${attachmentId}`);
  return VaultCaptureRowSchema.parse(row);
}

export function setCaptureState(database: RuntimeDatabase, attachmentId: string, state: VaultCaptureState): void {
  database.prepare('UPDATE vault_captures SET state = ? WHERE attachment_id = ?').run(state, attachmentId);
}

/** Closes a capture for good: the note-writer is done with it, whatever state it ends in. */
export function finishCapture(database: RuntimeDatabase, attachmentId: string, state: 'processed' | 'image_removed', processedAtUtc: string): void {
  database.prepare('UPDATE vault_captures SET state = ?, processed_at_utc = ? WHERE attachment_id = ?').run(state, processedAtUtc, attachmentId);
}

export function hasPixelCaptureSince(database: RuntimeDatabase, pixelSha256: string, sinceUtc: string): boolean {
  return database.prepare('SELECT 1 FROM vault_captures WHERE pixel_sha256 = ? AND captured_at_utc >= ? LIMIT 1').get(pixelSha256, sinceUtc) !== undefined;
}

export function listContextHashesSince(database: RuntimeDatabase, foregroundContextKey: string, sinceUtc: string): string[] {
  return z.array(PerceptualRowSchema).parse(database.prepare(
    'SELECT perceptual_hash FROM vault_captures WHERE foreground_context_key = ? AND captured_at_utc >= ?',
  ).all(foregroundContextKey, sinceUtc)).map((row) => row.perceptual_hash);
}

/** Captures whose PNG is still on disk, oldest first, with the file size retention weighs. */
export function listLiveCapturesOldestFirst(database: RuntimeDatabase): LiveCapture[] {
  return z.array(LiveCaptureRowSchema).parse(database.prepare(`
    SELECT c.attachment_id, a.byte_length, c.captured_at_utc FROM vault_captures c JOIN vault_attachments a ON a.id = c.attachment_id
    WHERE c.state <> 'image_removed' ORDER BY c.captured_at_utc, c.attachment_id
  `).all());
}

/** The capture notes filed in one folder with their PNG paths, in capture order. */
export function listFolderCaptures(database: RuntimeDatabase, folder: string): z.infer<typeof FolderCaptureRowSchema>[] {
  return z.array(FolderCaptureRowSchema).parse(database.prepare(`
    SELECT c.note_id, a.relative_path FROM vault_captures c
    JOIN vault_notes n ON n.id = c.note_id JOIN vault_attachments a ON a.id = c.attachment_id
    WHERE n.folder = ? ORDER BY c.captured_at_utc, c.attachment_id
  `).all(folder));
}

/** Ids of captures in the given states, oldest first; a negative `limit` lists them all. */
export function listCaptureIdsInStates(database: RuntimeDatabase, states: readonly VaultCaptureState[], limit: number): string[] {
  return z.array(AttachmentIdRowSchema).parse(database.prepare(`
    SELECT attachment_id FROM vault_captures WHERE state IN (${placeholders(states)}) ORDER BY captured_at_utc, attachment_id LIMIT ?
  `).all(...states, limit)).map((row) => row.attachment_id);
}

/** A worker that died mid-write leaves its capture `processing`; those without a live job rejoin the queue. */
export function requeueStrandedCaptures(database: RuntimeDatabase, liveAttachmentIds: readonly string[]): number {
  return database.prepare(`
    UPDATE vault_captures SET state = 'queued' WHERE state = 'processing' AND attachment_id NOT IN (${placeholders(liveAttachmentIds)})
  `).run(...liveAttachmentIds).changes;
}

export function countCapturesInStates(database: RuntimeDatabase, states: readonly VaultCaptureState[]): number {
  return CountRowSchema.parse(database.prepare(`SELECT COUNT(*) AS count FROM vault_captures WHERE state IN (${placeholders(states)})`).get(...states)).count;
}

/** Bytes of capture PNGs still on disk. */
export function liveCaptureBytes(database: RuntimeDatabase): number {
  return BytesRowSchema.parse(database.prepare(`
    SELECT COALESCE(SUM(a.byte_length), 0) AS bytes FROM vault_captures c JOIN vault_attachments a ON a.id = c.attachment_id WHERE c.state <> 'image_removed'
  `).get()).bytes;
}

/** Captures the owner is still waiting on, oldest first, for the dashboard pending view. */
export function listPendingCaptures(database: RuntimeDatabase, limit: number): PendingCaptureDto[] {
  return z.array(PendingCaptureDtoSchema).parse(database.prepare(`
    SELECT c.attachment_id AS attachmentId, c.note_id AS noteId, n.title AS noteTitle, c.state, c.captured_at_utc AS capturedAtUtc,
      a.byte_length AS byteLength, a.relative_path AS relativePath
    FROM vault_captures c JOIN vault_notes n ON n.id = c.note_id JOIN vault_attachments a ON a.id = c.attachment_id
    WHERE c.state IN (${placeholders(PENDING_CAPTURE_LIST_STATES)}) ORDER BY c.captured_at_utc, c.attachment_id LIMIT ?
  `).all(...PENDING_CAPTURE_LIST_STATES, limit));
}
