import { parseNoteBody, vaultKey } from '@siftkit/contracts';

import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from '../state/database-handle.ts';

const DAY_MS = 86_400_000;

export const FactPointRowSchema = z.object({
  note_id: z.string(),
  label_key: z.string(),
  value_key: z.string(),
  label: z.string(),
  value: z.string(),
  added_at_utc: z.string(),
  edited_at_utc: z.string(),
  last_accessed_at_utc: z.string().nullable(),
  validated_at_utc: z.string().nullable(),
});
export type FactPointRow = z.infer<typeof FactPointRowSchema>;

const FactPointKeyRowsSchema = z.array(FactPointRowSchema.pick({ label_key: true, value_key: true }));

export interface FactPointKey {
  readonly labelKey: string;
  readonly valueKey: string;
}

export const factPointKey = (label: string, value: string): FactPointKey => ({ labelKey: vaultKey(label), valueKey: vaultKey(value) });
const keyId = (key: FactPointKey) => `${key.labelKey}\n${key.valueKey}`;

/** Every fact value a body's visible fact rows hold. */
export function bodyFactPoints(body: string): Array<FactPointKey & { readonly label: string; readonly value: string }> {
  return parseNoteBody(body).factRows.flatMap((row) => row.values.map((value) => ({ ...factPointKey(row.label, value), label: row.label, value })));
}

/** Keeps a note's fact points in step with its body; unchanged values keep all their times. */
export function syncFactPoints(database: RuntimeDatabase, noteId: string, body: string, nowUtc: string): void {
  const current = new Map(bodyFactPoints(body).map((point) => [keyId(point), point]));
  const remove = database.prepare('DELETE FROM vault_fact_points WHERE note_id = ? AND label_key = ? AND value_key = ?');
  for (const row of FactPointKeyRowsSchema.parse(database.prepare('SELECT label_key, value_key FROM vault_fact_points WHERE note_id = ?').all(noteId))) {
    if (!current.delete(keyId({ labelKey: row.label_key, valueKey: row.value_key }))) remove.run(noteId, row.label_key, row.value_key);
  }
  const insert = database.prepare(`
    INSERT INTO vault_fact_points (note_id, label_key, value_key, label, value, added_at_utc, edited_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const point of current.values()) insert.run(noteId, point.labelKey, point.valueKey, point.label, point.value, nowUtc, nowUtc);
}

/** Stamps last access on a note and on the listed fact values it showed. */
export function touchAccess(database: RuntimeDatabase, noteId: string, keys: readonly FactPointKey[], nowUtc: string): void {
  database.prepare('UPDATE vault_notes SET last_accessed_at_utc = ? WHERE id = ?').run(nowUtc, noteId);
  const point = database.prepare('UPDATE vault_fact_points SET last_accessed_at_utc = ? WHERE note_id = ? AND label_key = ? AND value_key = ?');
  for (const key of keys) point.run(nowUtc, noteId, key.labelKey, key.valueKey);
}

/** A committed review: the note and every value it holds are validated, except the flagged ones. */
export function stampValidated(database: RuntimeDatabase, noteId: string, flagged: readonly FactPointKey[], nowUtc: string): void {
  database.prepare('UPDATE vault_notes SET validated_at_utc = ? WHERE id = ?').run(nowUtc, noteId);
  const skip = new Set(flagged.map(keyId));
  for (const row of FactPointKeyRowsSchema.parse(database.prepare('SELECT label_key, value_key FROM vault_fact_points WHERE note_id = ?').all(noteId))) {
    const key = { labelKey: row.label_key, valueKey: row.value_key };
    if (!skip.has(keyId(key))) validateFactPoint(database, noteId, key, nowUtc);
  }
}

export function validateFactPoint(database: RuntimeDatabase, noteId: string, key: FactPointKey, nowUtc: string): void {
  database.prepare('UPDATE vault_fact_points SET validated_at_utc = ? WHERE note_id = ? AND label_key = ? AND value_key = ?')
    .run(nowUtc, noteId, key.labelKey, key.valueKey);
}

const days = (fromUtc: string, nowUtc: string) => `${Math.max(0, Math.floor((Date.parse(nowUtc) - Date.parse(fromUtc)) / DAY_MS))}d`;

/** `added 40d · edited 12d · validated never`, the age line shown to the agent. */
export function factAges(row: Pick<FactPointRow, 'added_at_utc' | 'edited_at_utc' | 'validated_at_utc'>, nowUtc: string): string {
  return `added ${days(row.added_at_utc, nowUtc)} · edited ${days(row.edited_at_utc, nowUtc)} · validated ${
    row.validated_at_utc === null ? 'never' : days(row.validated_at_utc, nowUtc)}`;
}
