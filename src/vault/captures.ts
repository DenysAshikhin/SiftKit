import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { VaultNotFoundError } from './errors.ts';

export const VAULT_CAPTURE_STATES = ['queued', 'awaiting_image_capability', 'processing', 'processed', 'image_removed'] as const;
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
