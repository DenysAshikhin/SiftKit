import type { VaultActor, VaultBacklink, VaultNoteSummary } from '@siftkit/contracts';

const TASK_LINE_PATTERN = /^(\s*[-*]\s+\[)( |x|X)(\])/;
const OPEN_LINK_PATTERN = /\[\[([^\]\n]*)$/;
const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/;
const LIST_PATTERN = /^\s*[-*]\s/;
const UNLABELLED_BACKLINK = 'Mentioned in';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function toggleTask(body: string, line: number): string {
  const lines = body.split('\n');
  const current = lines[line];
  if (current === undefined || !TASK_LINE_PATTERN.test(current)) throw new Error(`Line ${line} is not a task.`);
  lines[line] = current.replace(TASK_LINE_PATTERN, (_match, open: string, mark: string, close: string) => `${open}${mark === ' ' ? 'x' : ' '}${close}`);
  return lines.join('\n');
}

/** Wraps the first bare mention of `title` in a wikilink; `null` when there is none. */
export function linkFirstMention(body: string, title: string): string | null {
  const pattern = new RegExp(`(?<![\\w[])${escapeRegExp(title)}(?![\\w\\]])`, 'i');
  return pattern.test(body) ? body.replace(pattern, `[[${title}]]`) : null;
}

/** The text typed after an unclosed `[[` before the caret, or `null` outside a link. */
export function linkQueryAt(value: string, caret: number): string | null {
  return value.slice(0, caret).match(OPEN_LINK_PATTERN)?.[1] ?? null;
}

export function insertLink(value: string, caret: number, title: string): { value: string; caret: number } {
  const before = value.slice(0, caret).replace(OPEN_LINK_PATTERN, `[[${title}]]`);
  return { value: before + value.slice(caret).replace(/^\]\]/, ''), caret: before.length };
}

export function fuzzyMatch(query: string, text: string): boolean {
  let matched = 0;
  for (const char of text) if (char === query[matched]) matched += 1;
  return matched === query.length;
}

/** Filters titles by substring or subsequence, then ranks prefix matches first and better-linked notes next. */
export function rankTitles<T extends { readonly title: string; readonly degree: number }>(
  entries: readonly T[], query: string, match: 'contains' | 'fuzzy', limit: number,
): T[] {
  const needle = query.trim().toLowerCase();
  const prefixRank = (entry: T) => (entry.title.toLowerCase().startsWith(needle) ? 0 : 1);
  return entries
    .filter((entry) => (match === 'fuzzy' ? fuzzyMatch(needle, entry.title.toLowerCase()) : entry.title.toLowerCase().includes(needle)))
    .sort((left, right) => prefixRank(left) - prefixRank(right) || right.degree - left.degree || left.title.localeCompare(right.title))
    .slice(0, limit);
}

export interface VaultContextGroup {
  readonly label: string;
  readonly notes: readonly VaultNoteSummary[];
}

/** The "Where it shows up" card: linking notes grouped by the fact row they link from. */
export function contextGroups(backlinks: readonly VaultBacklink[]): VaultContextGroup[] {
  const groups = new Map<string, VaultNoteSummary[]>();
  for (const backlink of backlinks) {
    for (const label of backlink.labels.length > 0 ? backlink.labels : [UNLABELLED_BACKLINK]) {
      groups.set(label, [...(groups.get(label) ?? []), backlink.note]);
    }
  }
  return [...groups.entries()].map(([label, notes]) => ({ label, notes })).sort((left, right) => right.notes.length - left.notes.length);
}

export interface VaultOutlineEntry {
  readonly line: number;
  readonly text: string;
  readonly level: number;
  readonly items: number;
}

export function outlineOf(body: string): VaultOutlineEntry[] {
  const lines = body.split('\n');
  const entries: VaultOutlineEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const heading = line.match(HEADING_PATTERN);
    if (!heading) continue;
    let items = 0;
    for (const next of lines.slice(index + 1)) {
      if (HEADING_PATTERN.test(next)) break;
      if (LIST_PATTERN.test(next)) items += 1;
    }
    entries.push({ line: index, text: heading[2] ?? '', level: (heading[1] ?? '').length, items });
  }
  return entries;
}

export function actorClass(actor: VaultActor): string {
  if (actor === 'you') return 'v-actor-you';
  if (actor === 'migration') return 'v-actor-migration';
  if (actor === 'capture-intake') return 'v-actor-intake';
  return actor === 'note-writer · tidy' ? 'v-actor-tidy' : 'v-actor-writer';
}
