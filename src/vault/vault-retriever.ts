import { MEMORY_NOTE_HEADING_PREFIX, parseNoteBody, VAULT_LINK_PATTERN, VAULT_VALUE_SEPARATOR, type VaultNote } from '@siftkit/contracts';

import type { Clock } from '../assistant/clock.ts';
import type { TokenCounter } from '../assistant/domain/tokens.ts';
import { QueryIntentExtractor } from '../assistant/retrieval/query-intent.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { bodyFactPoints, touchAccess, type FactPointKey } from './fact-points.ts';
import { readVaultNote } from './note-rows.ts';
import { findOwnerNote } from './owner-identity.ts';
import { searchNoteIds } from './vault-fts.ts';

const RENDER_HEADING = '## Relevant personal context';

export interface VaultRetrievalLimits {
  readonly maxContextTokens: number;
  readonly maxNotes: number;
}

export interface VaultRetrieveResult {
  /** Markdown block to inject, or `''` when nothing fits. */
  readonly renderedBlock: string;
  readonly noteIds: readonly string[];
  readonly tokenCount: number;
}

export interface VaultRetrieverOptions {
  readonly database: RuntimeDatabase;
  readonly tokens: TokenCounter;
  /** Injected notes, and the values shown, are stamped accessed. */
  readonly clock: Clock;
}

/** No personal context: nothing matched, nothing fit, or memory is off. */
export const EMPTY_RETRIEVAL: VaultRetrieveResult = { renderedBlock: '', noteIds: [], tokenCount: 0 };

/** Links read as their display text and embeds drop out; the model gets prose, not vault syntax. */
function plainText(text: string): string {
  let plain = '';
  let last = 0;
  for (const match of text.matchAll(VAULT_LINK_PATTERN)) {
    plain += text.slice(last, match.index) + (match[1] === '!' ? '' : (match[3] ?? match[2] ?? '').trim());
    last = match.index + match[0].length;
  }
  return (plain + text.slice(last)).trim();
}

function renderNote(note: VaultNote, heading: string, withRows: boolean): string {
  const parsed = parseNoteBody(note.body);
  const rows = withRows ? parsed.factRows.map((row) => `**${row.label}** ${row.values.map(plainText).join(VAULT_VALUE_SEPARATOR)}`) : [];
  return [`${MEMORY_NOTE_HEADING_PREFIX}${heading}`, ...(parsed.lead === null ? [] : [plainText(parsed.lead.text)]), ...rows].join('\n');
}

/**
 * Chat context from the vault (design §4.2): the owner note's lead always comes first, then FTS
 * matches, and the longest prefix that fits `maxContextTokens` is found by binary search.
 */
export class VaultRetriever {
  private readonly database: RuntimeDatabase;
  private readonly tokens: TokenCounter;
  private readonly clock: Clock;

  constructor(options: VaultRetrieverOptions) {
    this.database = options.database;
    this.tokens = options.tokens;
    this.clock = options.clock;
  }

  async retrieve(userMessage: string, limits: VaultRetrievalLimits): Promise<VaultRetrieveResult> {
    const owner = findOwnerNote(this.database);
    const hitIds = searchNoteIds(this.database, new QueryIntentExtractor().extract(userMessage).terms, ['entity', 'note'], limits.maxNotes + 1);
    const hits = hitIds.filter((id) => id !== owner?.id).slice(0, limits.maxNotes).flatMap((id) => readVaultNote(this.database, id) ?? []);
    const shown = (note: VaultNote, withRows: boolean): FactPointKey[] => (withRows ? bodyFactPoints(note.body) : []);
    const ownerRows = owner !== null && hitIds.includes(owner.id);
    const fixed = owner === null ? [] : [{ id: owner.id, keys: shown(owner, ownerRows), block: renderNote(owner, `${owner.title} (you)`, ownerRows) }];
    const ranked = hits.map((note) => ({ id: note.id, keys: shown(note, true), block: renderNote(note, note.title, true) }));

    // Token count grows with every included note, so the largest fitting prefix is a binary search:
    // O(log n) tokenizer calls, each of which may be an HTTP round trip in production.
    const measured = new Map<number, { text: string; tokenCount: number }>();
    const measure = async (included: number) => {
      const cached = measured.get(included);
      if (cached !== undefined) return cached;
      const text = `${RENDER_HEADING}\n\n${[...fixed, ...ranked.slice(0, included)].map((entry) => entry.block).join('\n\n')}`;
      const value = { text, tokenCount: (await this.tokens.count(text)).tokenCount };
      measured.set(included, value);
      return value;
    };
    let low = 0;
    let high = ranked.length;
    if (fixed.length > 0 && (await measure(0)).tokenCount > limits.maxContextTokens) return EMPTY_RETRIEVAL;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((await measure(mid)).tokenCount <= limits.maxContextTokens) low = mid;
      else high = mid - 1;
    }
    const included = [...fixed, ...ranked.slice(0, low)];
    if (included.length === 0) return EMPTY_RETRIEVAL;
    const { text, tokenCount } = await measure(low);
    const nowUtc = this.clock.nowUtc();
    this.database.transaction(() => {
      for (const entry of included) touchAccess(this.database, entry.id, entry.keys, nowUtc);
    })();
    return { renderedBlock: text, noteIds: included.map((entry) => entry.id), tokenCount };
  }
}
