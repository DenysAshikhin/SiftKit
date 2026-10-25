import {
  UNVERIFIED_TAG, VAULT_ROW_LIMIT, VAULT_VALUE_SEPARATOR, parseNoteBody, splitValues,
} from './vault-markdown.ts';

export interface VaultRowDraft {
  readonly label: string;
  readonly values: readonly string[];
}

export interface VaultTaskSectionDraft {
  readonly heading: string;
  readonly items: readonly string[];
}

export interface VaultUnverifiedDraft {
  readonly label: string;
  readonly value: string;
}

export interface VaultEntityDraft {
  readonly lead: string;
  readonly rows: readonly VaultRowDraft[];
  readonly taskSections: readonly VaultTaskSectionDraft[];
  readonly unverified: readonly VaultUnverifiedDraft[];
}

const MORE_HEADER_PATTERN = /^> \[!more\]-\s+\d+ more · (.+)$/;
const UNVERIFIED_HEADER_PATTERN = /^> \[!unverified\]-\s+\d+ unverified facts?$/;

const sameVaultValue = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

function dedupeVaultValues(values: readonly string[]): string[] {
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !kept.some((existing) => sameVaultValue(existing, trimmed))) kept.push(trimmed);
  }
  return kept;
}

function normalizeVaultLines(lines: readonly string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const rowLine = (label: string, values: readonly string[]) => `**${label}** ${values.join(VAULT_VALUE_SEPARATOR)}`;
const moreHeader = (count: number, label: string) => `> [!more]- ${count} more · ${label.toLowerCase()}`;
const unverifiedHeader = (count: number) => `> [!unverified]- ${count} unverified fact${count === 1 ? '' : 's'}`;
const unverifiedLine = (label: string, value: string) => `> - **${label}** ${value} ${UNVERIFIED_TAG}`;

export function buildEntityBody(draft: VaultEntityDraft): string {
  const lines: string[] = [draft.lead, ''];
  const overflow: VaultRowDraft[] = [];
  for (const row of draft.rows) {
    const rowValues = dedupeVaultValues(row.values);
    if (rowValues.length === 0) continue;
    lines.push(rowLine(row.label, rowValues.slice(0, VAULT_ROW_LIMIT)));
    if (rowValues.length > VAULT_ROW_LIMIT) overflow.push({ label: row.label, values: rowValues.slice(VAULT_ROW_LIMIT) });
  }
  lines.push('');
  for (const section of draft.taskSections) {
    if (section.items.length === 0) continue;
    lines.push(`## ${section.heading}`, ...section.items.map((item) => `- [ ] ${item}`), '');
  }
  for (const row of overflow) lines.push(moreHeader(row.values.length, row.label), `> ${row.values.join(VAULT_VALUE_SEPARATOR)}`, '');
  if (draft.unverified.length > 0) {
    lines.push(unverifiedHeader(draft.unverified.length), ...draft.unverified.map((fact) => unverifiedLine(fact.label, fact.value)));
  }
  return normalizeVaultLines(lines);
}

/** Adds values to a fact row; values past the row limit go to that label's `more` callout. */
export function addRowValues(body: string, label: string, values: readonly string[]): string {
  const lines = body.split('\n');
  const parsed = parseNoteBody(body);
  const row = parsed.factRows.find((candidate) => sameVaultValue(candidate.label, label));
  const moreIndex = lines.findIndex((line) => {
    const moreLabel = line.match(MORE_HEADER_PATTERN)?.[1];
    return moreLabel !== undefined && sameVaultValue(moreLabel, label);
  });
  const moreValues = moreIndex >= 0 ? splitValues((lines[moreIndex + 1] ?? '').replace(/^>\s?/, '')) : [];
  const visible = row?.values ?? [];
  const fresh = dedupeVaultValues(values).filter((value) => ![...visible, ...moreValues].some((existing) => sameVaultValue(existing, value)));
  if (fresh.length === 0) return body;
  const room = Math.max(0, VAULT_ROW_LIMIT - visible.length);
  const intoRow = fresh.slice(0, room);
  const intoMore = fresh.slice(room);
  const rowLabel = row?.label ?? label;

  // The more callout sits below the rows, so editing it first never shifts a row's line index.
  if (intoMore.length > 0) {
    const allMore = [...moreValues, ...intoMore];
    if (moreIndex >= 0) {
      lines[moreIndex] = moreHeader(allMore.length, rowLabel);
      lines[moreIndex + 1] = `> ${allMore.join(VAULT_VALUE_SEPARATOR)}`;
    } else {
      const unverifiedIndex = lines.findIndex((line) => UNVERIFIED_HEADER_PATTERN.test(line));
      const at = unverifiedIndex >= 0 ? unverifiedIndex : lines.length;
      lines.splice(at, 0, '', moreHeader(allMore.length, rowLabel), `> ${allMore.join(VAULT_VALUE_SEPARATOR)}`, '');
    }
  }
  if (row) {
    if (intoRow.length > 0) lines[row.line] = rowLine(row.label, [...visible, ...intoRow]);
  } else if (intoRow.length > 0) {
    const lastRow = parsed.factRows.at(-1);
    if (lastRow) lines.splice(lastRow.line + 1, 0, rowLine(label, intoRow));
    else if (parsed.lead) lines.splice(parsed.lead.line + 1, 0, '', rowLine(label, intoRow), '');
    else lines.splice(0, 0, rowLine(label, intoRow), '');
  }
  return normalizeVaultLines(lines);
}

export function replaceLead(body: string, lead: string): string {
  const parsed = parseNoteBody(body);
  const lines = body.split('\n');
  if (parsed.lead) lines[parsed.lead.line] = lead;
  else lines.unshift(lead, '');
  return normalizeVaultLines(lines);
}

export function rewriteLinks(body: string, oldTitle: string, newTitle: string): { body: string; count: number } {
  const escaped = oldTitle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<!!)\\[\\[\\s*${escaped}\\s*(#[^\\]|\\n]*)?(\\|[^\\]\\n]+)?\\]\\]`, 'gi');
  let count = 0;
  const next = body.replace(pattern, (_match: string, heading: string | undefined, display: string | undefined) => {
    count += 1;
    return `[[${newTitle}${heading ?? ''}${display ?? ''}]]`;
  });
  return { body: next, count };
}

function removeUnverifiedLine(body: string, line: number): string {
  const lines = body.split('\n');
  lines.splice(line, 1);
  const remaining = parseNoteBody(lines.join('\n')).unverified.length;
  const header = lines.findIndex((candidate) => UNVERIFIED_HEADER_PATTERN.test(candidate));
  if (header >= 0) {
    if (remaining === 0) lines.splice(header, 1);
    else lines[header] = unverifiedHeader(remaining);
  }
  return normalizeVaultLines(lines);
}

/** Keeps an unverified fact: it leaves the callout and joins its fact row. */
export function confirmUnverified(body: string, line: number): string {
  const fact = parseNoteBody(body).unverified.find((candidate) => candidate.line === line);
  if (!fact) throw new Error(`Line ${line} is not an unverified fact.`);
  return addRowValues(removeUnverifiedLine(body, line), fact.label ?? 'Facts', [fact.value]);
}

export function dropLine(body: string, line: number): string {
  const lines = body.split('\n');
  if (line < 0 || line >= lines.length) throw new Error(`Line ${line} is outside the note.`);
  if (parseNoteBody(body).unverified.some((fact) => fact.line === line)) return removeUnverifiedLine(body, line);
  lines.splice(line, 1);
  return normalizeVaultLines(lines);
}

const firstCalloutIndex = (lines: readonly string[]) => {
  const index = lines.findIndex((line) => line.startsWith('> [!'));
  return index < 0 ? lines.length : index;
};

export function addTasks(body: string, heading: string, items: readonly string[]): string {
  const parsed = parseNoteBody(body);
  const fresh = dedupeVaultValues(items).filter((item) => !parsed.tasks.some((task) => sameVaultValue(task.text, item)));
  if (fresh.length === 0) return body;
  const lines = body.split('\n');
  const taskLines = fresh.map((item) => `- [ ] ${item}`);
  const headingIndex = lines.findIndex((line) => line.startsWith('## ') && sameVaultValue(line.slice(3), heading));
  if (headingIndex >= 0) {
    let end = headingIndex + 1;
    while (end < lines.length && /^\s*[-*]\s+\[[ xX]\]/.test(lines[end] ?? '')) end += 1;
    lines.splice(end, 0, ...taskLines);
  } else {
    lines.splice(firstCalloutIndex(lines), 0, '', `## ${heading}`, ...taskLines, '');
  }
  return normalizeVaultLines(lines);
}

export function addUnverified(body: string, facts: readonly VaultUnverifiedDraft[]): string {
  const parsed = parseNoteBody(body);
  const fresh = facts.filter((fact) =>
    !parsed.unverified.some((existing) => sameVaultValue(existing.value, fact.value) && sameVaultValue(existing.label ?? '', fact.label))
    && !parsed.factRows.some((row) => sameVaultValue(row.label, fact.label) && row.values.some((value) => sameVaultValue(value, fact.value))));
  if (fresh.length === 0) return body;
  const lines = body.split('\n');
  const newLines = fresh.map((fact) => unverifiedLine(fact.label, fact.value));
  const header = lines.findIndex((line) => UNVERIFIED_HEADER_PATTERN.test(line));
  if (header >= 0) {
    let end = header + 1;
    while (end < lines.length && (lines[end] ?? '').startsWith('>')) end += 1;
    lines.splice(end, 0, ...newLines);
    lines[header] = unverifiedHeader(parsed.unverified.length + fresh.length);
  } else {
    lines.push('', unverifiedHeader(fresh.length), ...newLines);
  }
  return normalizeVaultLines(lines);
}

/** Merges a migration draft into a note that already exists; the existing lead wins. */
export function mergeEntityDraft(existingBody: string, draft: VaultEntityDraft): string {
  let body = parseNoteBody(existingBody).lead === null && draft.lead.trim() ? replaceLead(existingBody, draft.lead) : existingBody;
  for (const row of draft.rows) body = addRowValues(body, row.label, row.values);
  for (const section of draft.taskSections) body = addTasks(body, section.heading, section.items);
  return addUnverified(body, draft.unverified);
}

const isSectionBreak = (line: string) => /^#{1,2}\s/.test(line) || line.startsWith('> [!');

/** The lines of a `## heading` section, excluding the heading and trailing blank lines. */
function sectionBounds(lines: readonly string[], heading: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.startsWith('## ') && sameVaultValue(line.slice(3), heading));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !isSectionBreak(lines[end] ?? '')) end += 1;
  while (end - 1 > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return { start, end };
}

/** The lines of a `## heading` section, or `null` when the body has no such section. */
export function sectionLines(body: string, heading: string): string[] | null {
  const lines = body.split('\n');
  const bounds = sectionBounds(lines, heading);
  return bounds === null ? null : lines.slice(bounds.start + 1, bounds.end);
}

/** Appends lines the section does not already hold; a missing section is added at the end. */
export function appendSectionLines(body: string, heading: string, newLines: readonly string[]): string {
  const existing = sectionLines(body, heading) ?? [];
  const fresh = dedupeVaultValues(newLines).filter((line) => !existing.some((current) => sameVaultValue(current, line)));
  return fresh.length === 0 ? body : insertSectionLines(body, heading, fresh);
}

/** Appends lines at the end of a section as given, repeats included; a missing section is added at the end. */
export function insertSectionLines(body: string, heading: string, newLines: readonly string[]): string {
  const lines = body.split('\n');
  const bounds = sectionBounds(lines, heading);
  if (bounds === null) lines.push('', `## ${heading}`, ...newLines);
  else lines.splice(bounds.end, 0, ...newLines);
  return normalizeVaultLines(lines);
}

export function replaceSection(body: string, heading: string, newLines: readonly string[]): string {
  const lines = body.split('\n');
  const bounds = sectionBounds(lines, heading);
  if (bounds === null) lines.push('', `## ${heading}`, ...newLines);
  else lines.splice(bounds.start + 1, bounds.end - bounds.start - 1, ...newLines);
  return normalizeVaultLines(lines);
}

/** Removes every `> [!kind]` callout block, header and body lines alike. */
export function removeCallouts(body: string, kind: string): string {
  const header = `> [!${kind.toLowerCase()}]`;
  const kept: string[] = [];
  let inside = false;
  for (const line of body.split('\n')) {
    if (line.toLowerCase().startsWith(header)) { inside = true; continue; }
    if (inside && line.startsWith('>')) continue;
    inside = false;
    kept.push(line);
  }
  return normalizeVaultLines(kept);
}
