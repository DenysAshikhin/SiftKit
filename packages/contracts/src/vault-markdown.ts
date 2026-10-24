/** The vault note dialect (design §2). Pure functions shared by the server, the migration and the dashboard. */
export const VAULT_VALUE_SEPARATOR = ' · ';
export const VAULT_ROW_LIMIT = 8;
export const UNVERIFIED_TAG_NAME = 'unverified';
export const UNVERIFIED_TAG = `#${UNVERIFIED_TAG_NAME}`;

const FACT_ROW_PATTERN = /^\*\*([^*]+)\*\*\s+(.+)$/;
export const VAULT_LINK_PATTERN = /(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;
export const VAULT_TAG_PATTERN = /(?<!\S)#([A-Za-z][\w/-]*)/g;
const TASK_PATTERN = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const UNVERIFIED_PATTERN = new RegExp(String.raw`^>\s*[-*]\s+(.*?)\s*${UNVERIFIED_TAG}\b`);
const CODE_SPAN_PATTERN = /`[^`]*`/g;

export interface VaultLink {
  readonly target: string;
  readonly display: string | null;
  readonly rowLabel: string | null;
  readonly line: number;
  readonly embed: boolean;
}

export interface VaultFactRow {
  readonly label: string;
  readonly values: readonly string[];
  readonly line: number;
}

export interface VaultTask {
  readonly text: string;
  readonly done: boolean;
  readonly line: number;
}

export interface VaultUnverifiedFact {
  readonly label: string | null;
  readonly value: string;
  readonly line: number;
}

export interface ParsedNoteBody {
  readonly lead: { readonly text: string; readonly line: number } | null;
  readonly links: readonly VaultLink[];
  readonly tags: readonly string[];
  readonly factRows: readonly VaultFactRow[];
  readonly tasks: readonly VaultTask[];
  readonly unverified: readonly VaultUnverifiedFact[];
  readonly embeds: readonly string[];
}

/** The case-insensitive identity of a title or alias; links resolve by it. */
export const vaultKey = (text: string): string => text.trim().toLowerCase();

export function splitValues(text: string): string[] {
  return text.split(VAULT_VALUE_SEPARATOR).map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Strips a callout marker and a bullet, so rows inside callouts still expose their label. */
function stripLineMarkers(line: string): string {
  return line.replace(/^>\s?/, '').replace(/^\s*[-*]\s+/, '');
}

export function parseFactRow(text: string): { label: string; rest: string } | null {
  const match = text.match(FACT_ROW_PATTERN);
  const label = match?.[1];
  const rest = match?.[2];
  return label !== undefined && rest !== undefined ? { label, rest: rest.trim() } : null;
}

function isPlainParagraph(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !/^(#|\*\*[^*]+\*\*\s|[-*]\s|>|!\[\[|```|\|)/.test(trimmed);
}

export function parseNoteBody(body: string): ParsedNoteBody {
  const links: VaultLink[] = [];
  const tags = new Set<string>();
  const factRows: VaultFactRow[] = [];
  const tasks: VaultTask[] = [];
  const unverified: VaultUnverifiedFact[] = [];
  const embeds: string[] = [];
  let lead: ParsedNoteBody['lead'] = null;
  let inFence = false;

  for (const [index, line] of body.split('\n').entries()) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0) continue;
    const scannable = line.replace(CODE_SPAN_PATTERN, '');
    const contentRow = parseFactRow(stripLineMarkers(scannable));
    for (const match of scannable.matchAll(VAULT_LINK_PATTERN)) {
      const embed = match[1] === '!';
      const target = (match[2] ?? '').trim();
      links.push({ target, display: match[3] ?? null, rowLabel: embed ? null : contentRow?.label ?? null, line: index, embed });
      if (embed) embeds.push(target);
    }
    for (const match of scannable.matchAll(VAULT_TAG_PATTERN)) tags.add((match[1] ?? '').toLowerCase());

    const row = parseFactRow(line);
    if (row) factRows.push({ label: row.label, values: splitValues(row.rest), line: index });
    const task = line.match(TASK_PATTERN);
    if (task) tasks.push({ text: task[2] ?? '', done: task[1] !== ' ', line: index });
    const fact = line.match(UNVERIFIED_PATTERN)?.[1];
    if (fact !== undefined) {
      const factRow = parseFactRow(fact);
      unverified.push(factRow
        ? { label: factRow.label, value: factRow.rest, line: index }
        : { label: null, value: fact.trim(), line: index });
    }
    if (lead === null && isPlainParagraph(line)) lead = { text: line.trim(), line: index };
  }

  return { lead, links, tags: [...tags], factRows, tasks, unverified, embeds };
}
