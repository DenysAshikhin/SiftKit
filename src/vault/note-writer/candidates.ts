import type { RuntimeDatabase } from '../../state/runtime-db.ts';
import { requireVaultNote } from '../note-rows.ts';
import { searchNoteIds } from '../vault-fts.ts';

const MAX_CANDIDATES = 20;

/** Up to 20 entity titles matching the terms, as the "Known notes" block a writer prompt carries. */
export function knownNotesText(database: RuntimeDatabase, terms: readonly string[]): string {
  const titles = searchNoteIds(database, terms, ['entity'], MAX_CANDIDATES).map((id) => requireVaultNote(database, id).title);
  return titles.length === 0 ? 'Known notes: none' : ['Known notes:', ...titles.map((title) => `- ${title}`)].join('\n');
}
