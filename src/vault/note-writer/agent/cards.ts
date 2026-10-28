import { parseNoteBody, type VaultNote } from '@siftkit/contracts';

import { QueryIntentExtractor } from '../../../assistant/retrieval/query-intent.ts';
import type { RuntimeDatabase } from '../../../state/database-handle.ts';
import { factAges, factPointKey, touchAccess } from '../../fact-points.ts';
import { readVaultNote } from '../../note-rows.ts';
import { findOwnerNote } from '../../owner-identity.ts';
import type { VaultValidationQueue } from '../../validation-queue.ts';
import { searchNoteIds } from '../../vault-fts.ts';
import { READ_PAGE_VALUES } from './tools.ts';

const OWNER_ROWS = 10;
const CANDIDATE_CARDS = 5;
const KNOWN_TITLES = 15;

/** The `#me` note: title, aliases, lead and its first 10 fact rows. Stamps what it shows. */
export function ownerCard(database: RuntimeDatabase, nowUtc: string): string {
  const owner = findOwnerNote(database);
  if (owner === null) return 'Owner: no owner note yet; refer to the user as "the user".';
  const parsed = parseNoteBody(owner.body);
  const rows = parsed.factRows.slice(0, OWNER_ROWS);
  touchAccess(database, owner.id, rows.flatMap((row) => row.values.map((value) => factPointKey(row.label, value))), nowUtc);
  return [
    `Owner: ${owner.title}${owner.aliases.length === 0 ? '' : ` (aliases: ${owner.aliases.join(', ')})`}`,
    parsed.lead?.text ?? '', ...rows.map((row) => `**${row.label}** ${row.values.join(' · ')}`),
  ].filter((line) => line.length > 0).join('\n');
}

function cardOf(note: VaultNote): string {
  const parsed = parseNoteBody(note.body);
  return [
    `### ${note.title} · ${note.folder || 'no folder'} · ${note.types.join(', ') || 'untyped'}${note.aliases.length === 0 ? '' : ` · aliases: ${note.aliases.join(', ')}`}`,
    parsed.lead?.text ?? '', `rows: ${parsed.factRows.map((row) => row.label).join(', ') || 'none'}`,
  ].filter((line) => line.length > 0).join('\n');
}

/** Top 5 full-text matches on the source as cards, then the next 15 as titles. Cards stamp their notes. */
export function candidateCards(database: RuntimeDatabase, sourceText: string, nowUtc: string): string {
  const ownerId = findOwnerNote(database)?.id ?? null;
  const notes = searchNoteIds(database, new QueryIntentExtractor().extract(sourceText).terms, ['entity'], CANDIDATE_CARDS + KNOWN_TITLES + 1)
    .filter((id) => id !== ownerId).flatMap((id) => readVaultNote(database, id) ?? []);
  const cards = notes.slice(0, CANDIDATE_CARDS);
  for (const note of cards) touchAccess(database, note.id, [], nowUtc);
  const titles = notes.slice(CANDIDATE_CARDS, CANDIDATE_CARDS + KNOWN_TITLES).map((note) => `- ${note.title}`);
  return [
    '## Likely related notes', ...(cards.length === 0 ? ['none'] : cards.map(cardOf)),
    '## Other known titles', titles.length === 0 ? 'none' : titles.join('\n'),
  ].join('\n\n');
}

/** One card per queued note, its values stalest first with their ages. Stamps what it shows. */
export function reviewCards(database: RuntimeDatabase, queue: VaultValidationQueue, noteIds: readonly string[], nowUtc: string): string {
  return noteIds.flatMap((id) => {
    const note = readVaultNote(database, id);
    if (note === null) return [];
    const facts = queue.staleFacts(id).slice(0, READ_PAGE_VALUES);
    touchAccess(database, id, facts.map((row) => ({ labelKey: row.label_key, valueKey: row.value_key })), nowUtc);
    return [[cardOf(note), ...facts.map((row) => `- **${row.label}** ${row.value} — ${factAges(row, nowUtc)}`)].join('\n')];
  }).join('\n\n');
}
