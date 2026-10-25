import { VaultActorSchema, VaultNoteKindSchema, type VaultNote, type VaultNoteSummary, type VaultRevision } from '@siftkit/contracts';

import { parseJsonText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { VaultNotFoundError } from './errors.ts';

const StringListSchema = z.array(z.string());
export const NoteIdRowSchema = z.object({ note_id: z.string() });

/** Link targets, titles and aliases all compare on this key. */

export const VaultNoteRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  title_key: z.string(),
  folder: z.string(),
  kind: VaultNoteKindSchema,
  types_json: z.string(),
  aliases_json: z.string(),
  tags_json: z.string(),
  body: z.string(),
  revision: z.number().int(),
  is_stub: z.number().int(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type VaultNoteRow = z.infer<typeof VaultNoteRowSchema>;

export const VaultRevisionRowSchema = z.object({
  revision: z.number().int(),
  actor: VaultActorSchema,
  summary: z.string(),
  source_ref: z.string().nullable(),
  title: z.string(),
  folder: z.string(),
  body: z.string(),
  types_json: z.string(),
  aliases_json: z.string(),
  tags_json: z.string(),
  created_at_utc: z.string(),
});

export const parseStringList = (text: string): string[] => parseJsonText(text, StringListSchema);

export function toVaultNote(row: VaultNoteRow): VaultNote {
  return {
    id: row.id,
    title: row.title,
    folder: row.folder,
    kind: row.kind,
    types: parseStringList(row.types_json),
    aliases: parseStringList(row.aliases_json),
    tags: parseStringList(row.tags_json),
    body: row.body,
    revision: row.revision,
    isStub: row.is_stub === 1,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

export function toVaultNoteSummary(note: Pick<VaultNote, 'id' | 'title' | 'folder' | 'kind' | 'isStub' | 'updatedAtUtc'>): VaultNoteSummary {
  return { id: note.id, title: note.title, folder: note.folder, kind: note.kind, isStub: note.isStub, updatedAtUtc: note.updatedAtUtc };
}

export function toVaultRevision(row: z.infer<typeof VaultRevisionRowSchema>): VaultRevision {
  return {
    revision: row.revision,
    actor: row.actor,
    summary: row.summary,
    sourceRef: row.source_ref,
    createdAtUtc: row.created_at_utc,
    title: row.title,
    folder: row.folder,
    body: row.body,
    types: parseStringList(row.types_json),
    aliases: parseStringList(row.aliases_json),
    tags: parseStringList(row.tags_json),
  };
}

export function readVaultNotes(database: RuntimeDatabase, sql: string, ...params: readonly string[]): VaultNote[] {
  return z.array(VaultNoteRowSchema).parse(database.prepare(sql).all(...params)).map(toVaultNote);
}

export function readVaultNote(database: RuntimeDatabase, id: string): VaultNote | null {
  return readVaultNotes(database, 'SELECT * FROM vault_notes WHERE id = ?', id)[0] ?? null;
}

export function requireVaultNote(database: RuntimeDatabase, id: string): VaultNote {
  const note = readVaultNote(database, id);
  if (note === null) throw new VaultNotFoundError(id);
  return note;
}
