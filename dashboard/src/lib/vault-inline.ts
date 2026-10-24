import { VAULT_LINK_PATTERN, VAULT_TAG_PATTERN } from '@siftkit/contracts';

export type InlineToken =
  | { readonly kind: 'text' | 'code' | 'bold' | 'italic' | 'dim'; readonly text: string }
  | { readonly kind: 'link'; readonly target: string; readonly label: string | null; readonly embed: boolean }
  | { readonly kind: 'tag'; readonly tag: string };

export type PillValue =
  | { readonly kind: 'link'; readonly target: string; readonly label: string | null }
  | { readonly kind: 'text'; readonly text: string };

// Groups: 1 code · 2-4 link (bang, target, label) · 5 bold · 6 italic · 7 dim · 8 tag.
const INLINE_PATTERN = new RegExp([
  '`([^`]+)`',
  VAULT_LINK_PATTERN.source,
  String.raw`\*\*([^*]+)\*\*`,
  String.raw`\*([^*\s][^*]*)\*`,
  String.raw`(?<![^\s(])_([^_]+)_(?=$|[\s.,)])`,
  VAULT_TAG_PATTERN.source,
].join('|'), 'g');
const LONE_LINK_PATTERN = new RegExp(`^${VAULT_LINK_PATTERN.source}$`);

function tokenOf(match: RegExpMatchArray): InlineToken {
  const [, code, bang, target, label, bold, italic, dim, tag] = match;
  if (code !== undefined) return { kind: 'code', text: code };
  if (target !== undefined) return { kind: 'link', target: target.trim(), label: label ?? null, embed: bang === '!' };
  if (bold !== undefined) return { kind: 'bold', text: bold };
  if (italic !== undefined) return { kind: 'italic', text: italic };
  if (dim !== undefined) return { kind: 'dim', text: dim };
  return { kind: 'tag', tag: (tag ?? '').toLowerCase() };
}

export function inlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, start) });
    tokens.push(tokenOf(match));
    cursor = start + match[0].length;
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) });
  return tokens;
}

/** A fact-row value: a lone `[[link]]` becomes a link pill, anything else a text pill. */
export function pillValue(value: string): PillValue {
  const trimmed = value.trim();
  const match = trimmed.match(LONE_LINK_PATTERN);
  const target = match?.[2];
  if (match === null || match[1] === '!' || target === undefined) return { kind: 'text', text: trimmed };
  return { kind: 'link', target: target.trim(), label: match[3] ?? null };
}
