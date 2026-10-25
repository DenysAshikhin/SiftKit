import type { VaultNoteKind } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { NoteIdRowSchema } from './note-rows.ts';

const NoteIdRowsSchema = z.array(NoteIdRowSchema);
/** bm25 column weights: note_id (unindexed), title, aliases, body. */
const BM25_WEIGHTS = '0, 10, 6, 1';

/** Each term becomes a quoted fts5 string, so operators and quotes in user text stay literal. */
export function ftsMatchQuery(terms: readonly string[]): string | null {
  const quoted = terms.map((term) => term.trim()).filter((term) => term.length > 0).map((term) => `"${term.replace(/"/g, '""')}"`);
  return quoted.length === 0 ? null : quoted.join(' OR ');
}

/** Ids of notes of the given kinds matching any term, best bm25 rank first. */
export function searchNoteIds(database: RuntimeDatabase, terms: readonly string[], kinds: readonly VaultNoteKind[], limit: number): string[] {
  const query = ftsMatchQuery(terms);
  if (query === null || kinds.length === 0) return [];
  return NoteIdRowsSchema.parse(database.prepare(`
    SELECT vault_notes_fts.note_id FROM vault_notes_fts JOIN vault_notes n ON n.id = vault_notes_fts.note_id
    WHERE vault_notes_fts MATCH ? AND n.kind IN (${kinds.map(() => '?').join(', ')})
    ORDER BY bm25(vault_notes_fts, ${BM25_WEIGHTS}) LIMIT ?
  `).all(query, ...kinds, limit)).map((row) => row.note_id);
}
