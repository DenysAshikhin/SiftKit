import { parseFactRow, parseNoteBody, splitValues } from '@siftkit/contracts';

export const MAX_RENDER_LINES = 400;

export type VaultListItem =
  | { readonly kind: 'task'; readonly done: boolean; readonly text: string; readonly line: number }
  | { readonly kind: 'item'; readonly label: string | null; readonly text: string; readonly unverified: boolean; readonly line: number };

export interface VaultFactRowBlock {
  readonly label: string;
  readonly values: readonly string[];
  readonly line: number;
}

export type VaultCalloutPart =
  | { readonly kind: 'list'; readonly items: readonly VaultListItem[] }
  | { readonly kind: 'pills'; readonly values: readonly string[] };

export type VaultBlock =
  | { readonly kind: 'paragraph'; readonly text: string; readonly lead: boolean; readonly line: number }
  | { readonly kind: 'facts'; readonly rows: readonly VaultFactRowBlock[] }
  | { readonly kind: 'heading'; readonly level: 2 | 3; readonly text: string; readonly line: number }
  | { readonly kind: 'list'; readonly items: readonly VaultListItem[] }
  | { readonly kind: 'callout'; readonly calloutKind: string; readonly fold: '' | '+' | '-'; readonly title: string; readonly parts: readonly VaultCalloutPart[] }
  | { readonly kind: 'quote'; readonly lines: readonly string[] }
  | { readonly kind: 'embeds'; readonly targets: readonly string[] }
  | { readonly kind: 'fence'; readonly text: string }
  | { readonly kind: 'more'; readonly remaining: number };

const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/;
const LIST_PATTERN = /^\s*[-*]\s+(.*)$/;
const TASK_PATTERN = /^\[( |x|X)\]\s+(.*)$/;
const EMBED_PATTERN = /^!\[\[([^\]]+)\]\]$/;
const CALLOUT_HEAD_PATTERN = /^\[!(\w+)\]([+-]?)\s*(.*)$/;
const isFence = (line: string) => line.trimStart().startsWith('```');

interface QuoteLine {
  readonly text: string;
  readonly line: number;
}

function listItem(text: string, line: number, unverifiedLines: ReadonlySet<number>): VaultListItem {
  const task = text.match(TASK_PATTERN);
  if (task) return { kind: 'task', done: task[1] !== ' ', text: task[2] ?? '', line };
  const row = parseFactRow(text);
  return { kind: 'item', label: row?.label ?? null, text: row?.rest ?? text, unverified: unverifiedLines.has(line), line };
}

function quoteBlock(lines: readonly QuoteLine[], unverifiedLines: ReadonlySet<number>): VaultBlock {
  const head = lines[0]?.text.match(CALLOUT_HEAD_PATTERN);
  if (!head) return { kind: 'quote', lines: lines.map((entry) => entry.text) };
  const parts: VaultCalloutPart[] = [];
  for (const entry of lines.slice(1)) {
    const item = entry.text.match(LIST_PATTERN);
    const last = parts.at(-1);
    if (item) {
      const next = listItem(item[1] ?? '', entry.line, unverifiedLines);
      if (last?.kind === 'list') parts[parts.length - 1] = { kind: 'list', items: [...last.items, next] };
      else parts.push({ kind: 'list', items: [next] });
    } else if (entry.text.trim().length > 0) {
      parts.push({ kind: 'pills', values: splitValues(entry.text) });
    }
  }
  const fold = head[2] === '+' || head[2] === '-' ? head[2] : '';
  return { kind: 'callout', calloutKind: (head[1] ?? '').toLowerCase(), fold, title: head[3] ?? '', parts };
}

/** Groups a note body into renderable blocks, mirroring the mockup renderer; the first paragraph is the lead. */
export function noteBlocks(body: string, options: { readonly limit: number; readonly full: boolean }): VaultBlock[] {
  const lines = body.length === 0 ? [] : body.split('\n');
  const unverifiedLines = new Set(parseNoteBody(body).unverified.map((fact) => fact.line));
  const blocks: VaultBlock[] = [];
  let list: VaultListItem[] | null = null;
  let quote: QuoteLine[] | null = null;
  let facts: VaultFactRowBlock[] | null = null;
  let embeds: string[] | null = null;
  let fence: string[] | null = null;
  let sawParagraph = false;
  const flush = (keep: 'list' | 'quote' | 'facts' | 'embeds' | 'none') => {
    if (keep !== 'list' && list) { blocks.push({ kind: 'list', items: list }); list = null; }
    if (keep !== 'quote' && quote) { blocks.push(quoteBlock(quote, unverifiedLines)); quote = null; }
    if (keep !== 'facts' && facts) { blocks.push({ kind: 'facts', rows: facts }); facts = null; }
    if (keep !== 'embeds' && embeds) { blocks.push({ kind: 'embeds', targets: embeds }); embeds = null; }
  };

  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      if (isFence(line)) { blocks.push({ kind: 'fence', text: fence.join('\n') }); fence = null; } else fence.push(line);
      continue;
    }
    if (index >= options.limit && !options.full) {
      flush('none');
      blocks.push({ kind: 'more', remaining: lines.length - index });
      return blocks;
    }
    if (isFence(line)) { flush('none'); fence = []; continue; }
    const embed = line.trim().match(EMBED_PATTERN)?.[1];
    if (embed !== undefined) { flush('embeds'); (embeds ??= []).push(embed); continue; }
    if (line.startsWith('>')) { flush('quote'); (quote ??= []).push({ text: line.replace(/^>\s?/, ''), line: index }); continue; }
    const row = parseFactRow(line);
    if (row) { flush('facts'); (facts ??= []).push({ label: row.label, values: splitValues(row.rest), line: index }); continue; }
    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      flush('none');
      blocks.push({ kind: 'heading', level: (heading[1] ?? '').length === 3 ? 3 : 2, text: heading[2] ?? '', line: index });
      continue;
    }
    const item = line.match(LIST_PATTERN);
    if (item) { flush('list'); (list ??= []).push(listItem(item[1] ?? '', index, unverifiedLines)); continue; }
    flush('none');
    if (line.trim().length === 0) continue;
    blocks.push({ kind: 'paragraph', text: line.trim(), lead: !sawParagraph, line: index });
    sawParagraph = true;
  }
  flush('none');
  return blocks;
}
