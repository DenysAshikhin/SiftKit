import type { VaultNote, VaultSearchResult } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { degreeOf, loadAdjacency, type VaultAdjacency } from './link-graph.ts';
import { readVaultNotes, toVaultNoteSummary } from './note-rows.ts';

const FILTER_PATTERN = /\b(tag|path|type):(\S*)/g;
const SearchFilterSchema = z.object({ kind: z.enum(['tag', 'path', 'type']), value: z.string() });
type SearchFilter = z.infer<typeof SearchFilterSchema>;
/** Title matches dominate; a body hit and link degree only break ties. */
const SEARCH_WEIGHTS = { exactTitle: 100, titlePrefix: 60, titleContains: 40, alias: 30, bodyHit: 10, maxDegreeBonus: 5, degreePerBonusPoint: 20 } as const;

function parseQuery(query: string): { text: string; filters: SearchFilter[] } {
  const filters: SearchFilter[] = [];
  const text = query.replace(FILTER_PATTERN, (_match: string, kind: string, value: string) => {
    filters.push(SearchFilterSchema.parse({ kind, value: value.replace(/^#/, '').toLowerCase() }));
    return '';
  }).trim().toLowerCase();
  return { text, filters };
}

function snippetFor(note: VaultNote, text: string): string | null {
  const line = note.body.split('\n').find((candidate) => candidate.toLowerCase().includes(text));
  return line === undefined ? null : line.replace(/^[-#>*\s]+/, '').trim();
}

function passesFolderAndType(note: VaultNote, filters: readonly SearchFilter[]): boolean {
  return filters.every((filter) => {
    if (filter.kind === 'path') return note.folder.toLowerCase().startsWith(filter.value);
    if (filter.kind === 'type') return note.types.some((type) => type.toLowerCase().includes(filter.value));
    return true;
  });
}

function scoreNote(note: VaultNote, text: string): { score: number; snippet: string | null } | null {
  if (text.length === 0) return { score: 0, snippet: null };
  const title = note.title.toLowerCase();
  const alias = note.aliases.find((candidate) => candidate.toLowerCase().includes(text));
  const titleScore = title === text ? SEARCH_WEIGHTS.exactTitle
    : title.startsWith(text) ? SEARCH_WEIGHTS.titlePrefix
      : title.includes(text) ? SEARCH_WEIGHTS.titleContains
        : alias ? SEARCH_WEIGHTS.alias : 0;
  const bodyHit = note.body.toLowerCase().includes(text);
  if (titleScore === 0 && !bodyHit) return null;
  const snippet = titleScore === SEARCH_WEIGHTS.alias && alias ? `alias: ${alias}` : titleScore === 0 ? snippetFor(note, text) : null;
  return { score: titleScore + (bodyHit ? SEARCH_WEIGHTS.bodyHit : 0), snippet };
}

export class VaultSearch {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  search(query: string, limit: number): VaultSearchResult {
    const { text, filters } = parseQuery(query);
    const tags = filters.filter((filter) => filter.kind === 'tag').map((filter) => filter.value);
    const tagClause = tags.map(() => 'EXISTS (SELECT 1 FROM vault_tags t WHERE t.note_id = n.id AND t.tag = ?)').join(' AND ');
    const notes = readVaultNotes(this.database, `SELECT n.* FROM vault_notes n ${tagClause ? `WHERE ${tagClause}` : ''}`, ...tags)
      .filter((note) => passesFolderAndType(note, filters));
    const matches = notes.flatMap((note) => {
      const scored = scoreNote(note, text);
      return scored === null ? [] : [{ note, ...scored }];
    });
    const adjacency: VaultAdjacency = matches.length > 0 ? loadAdjacency(this.database) : new Map();
    const hits = matches.map((match) => ({
      note: toVaultNoteSummary(match.note),
      score: match.score + Math.min(SEARCH_WEIGHTS.maxDegreeBonus, degreeOf(adjacency, match.note.id) / SEARCH_WEIGHTS.degreePerBonusPoint),
      snippet: match.snippet,
    })).sort((left, right) => right.score - left.score || left.note.title.localeCompare(right.note.title));
    return { total: hits.length, hits: hits.slice(0, limit) };
  }
}
