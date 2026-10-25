import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { ImageMimeSchema, type ImageMime } from '@siftkit/contracts';

import type { Clock } from '../assistant/clock.ts';
import type { IdGenerator } from '../assistant/ids.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { VaultNotFoundError } from './errors.ts';

const EXTENSION: Readonly<Record<ImageMime, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const ATTACHMENTS_PREFIX = 'attachments';
const AttachmentRowSchema = z.object({
  id: z.string(), note_id: z.string().nullable(), relative_path: z.string(), mime_type: ImageMimeSchema,
  byte_length: z.number(), sha256: z.string(), created_at_utc: z.string(),
});

export interface VaultAttachment {
  readonly id: string;
  readonly noteId: string | null;
  readonly relativePath: string;
  readonly mimeType: ImageMime;
  readonly byteLength: number;
  readonly sha256: string;
}

export const vaultAttachmentsDir = (runtimeRoot: string): string => path.join(runtimeRoot, 'vault', ATTACHMENTS_PREFIX);
/** The markdown embed for an attachment; notes address files relative to the vault root. */
export const attachmentEmbed = (relativePath: string): string => `![[${ATTACHMENTS_PREFIX}/${relativePath}]]`;

/** PNG and other image files under `<runtimeRoot>/vault/attachments`, one row each. Reads never leave that root. */
export class VaultAttachments {
  private readonly database: RuntimeDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly root: string;

  constructor(database: RuntimeDatabase, clock: Clock, ids: IdGenerator, runtimeRoot: string) {
    this.database = database;
    this.clock = clock;
    this.ids = ids;
    this.root = vaultAttachmentsDir(runtimeRoot);
  }

  /** Writes the file and its row; `assign` links it to the note that embeds it once that note exists. */
  write(input: { readonly directory: string; readonly mimeType: ImageMime; readonly bytes: Buffer }): VaultAttachment {
    const id = this.ids.next('vatt');
    const attachment: VaultAttachment = {
      id, noteId: null, relativePath: `${input.directory}/${id}.${EXTENSION[input.mimeType]}`, mimeType: input.mimeType,
      byteLength: input.bytes.byteLength, sha256: createHash('sha256').update(input.bytes).digest('hex'),
    };
    const file = this.contained(attachment.relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, input.bytes);
    this.database.prepare(`
      INSERT INTO vault_attachments (id, note_id, relative_path, mime_type, byte_length, sha256, created_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(attachment.id, attachment.noteId, attachment.relativePath, attachment.mimeType, attachment.byteLength, attachment.sha256, this.clock.nowUtc());
    return attachment;
  }

  assign(id: string, noteId: string): void {
    this.database.prepare('UPDATE vault_attachments SET note_id = ? WHERE id = ?').run(noteId, id);
  }

  require(id: string): VaultAttachment {
    const row = this.database.prepare('SELECT * FROM vault_attachments WHERE id = ?').get(id);
    if (row === undefined) throw new VaultNotFoundError(`attachment ${id}`);
    return toAttachment(AttachmentRowSchema.parse(row));
  }

  read(relativePath: string): { readonly mimeType: ImageMime; readonly bytes: Buffer } {
    const row = this.database.prepare('SELECT * FROM vault_attachments WHERE relative_path = ?').get(relativePath);
    const file = this.contained(relativePath);
    if (row === undefined || !fs.existsSync(file)) throw new VaultNotFoundError(`attachment ${relativePath}`);
    return { mimeType: AttachmentRowSchema.parse(row).mime_type, bytes: fs.readFileSync(file) };
  }

  /** Removes the file and its row, for an attachment whose note never came to be. */
  delete(id: string): void {
    this.removeFile(id);
    this.database.prepare('DELETE FROM vault_attachments WHERE id = ?').run(id);
  }

  /** Deletes the file and keeps the row, so the note's embed can still say what was there. */
  removeFile(id: string): void {
    fs.rmSync(this.contained(this.require(id).relativePath), { force: true });
  }

  private contained(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    if (relativePath.length === 0 || path.isAbsolute(relativePath) || !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new VaultNotFoundError(`attachment ${relativePath}`);
    }
    return resolved;
  }
}

function toAttachment(row: z.infer<typeof AttachmentRowSchema>): VaultAttachment {
  return { id: row.id, noteId: row.note_id, relativePath: row.relative_path, mimeType: row.mime_type, byteLength: row.byte_length, sha256: row.sha256 };
}
