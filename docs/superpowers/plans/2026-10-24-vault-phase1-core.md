# Vault Phase 1 — Core Implementation Plan

> **Status: implemented.** A post-implementation review then changed some details. The code in `src/vault/` is authoritative:
> - Link resolution moved into the `vault_key_owners` SQL view; when two notes share an alias, the oldest note by `created_at_utc` wins.
> - `vault_notes_fts` is deferred to Phase 4.
> - `loadLinkGraph` was replaced by `loadAdjacency` and `degreeOf`.
> - `store.get` and `store.require` were replaced by `readVaultNote` and `requireVaultNote`.
> - The store's input types are now zod schemas in contracts.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the storage and query core of the memory vault: the shared note dialect, the SQLite tables, a revisioned note store, and the queries, search and graph built on top. Nothing is wired into the server or the UI yet.

**Architecture:** The note dialect parser and body editors are pure functions in `@siftkit/contracts`, so the server, the migration and the dashboard share one implementation. Notes live in new `vault_*` tables inside `runtime.sqlite`. `VaultNoteStore` is the only writer. Each write runs in one transaction that checks the expected revision, stores a full revision snapshot, and rebuilds the derived link, alias, tag and FTS rows. Queries, search and graph are read-only classes over those tables.

**Tech Stack:**
- TypeScript, run natively on Node 26 (no build step).
- better-sqlite3 with fts5.
- zod 4. Use `src/lib/zod.ts` on the server and `zod` in contracts.
- `node:test` through `src/test-runner/run-tests.ts`.

**Spec:** `docs/superpowers/specs/2026-10-24-memory-vault-design.md` (§2, §3, §4.1, §4.2: store, queries, search, graph).

---

## Ground rules

- **Run one test file:** `node .\src\test-runner\run-tests.ts <basename-without-.test.ts>`, for example `node .\src\test-runner\run-tests.ts vault-markdown`. Before committing, also run `npm run typecheck` and `npm run lint`.
- **Typing rules, enforced by lint and review:**
  - Forbidden: `any`, `as` casts (except `as const`), non-null `!`, and namespace imports.
  - Parse every SQL row and every JSON text with zod. Use `parseJsonText(text, schema)` from `src/lib/json.ts`.
  - Derive types with `z.infer`. Do not hand-write an interface that duplicates a zod schema.
- **`erasableSyntaxOnly` is on.** That rules out parameter properties and enums. Declare class fields and assign them in the constructor, as the rest of the repo does.
- **Comments:** at most 1–2 lines, explaining why rather than what.
- **Commits:** do not commit unless the user asks. Each task ends with a *checkpoint* (green tests, typecheck and lint) instead of a commit.

## File structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/vault-markdown.ts` (create) | Dialect constants and `parseNoteBody`, which extracts lead, links, tags, fact rows, tasks, unverified facts and embeds. |
| `packages/contracts/src/vault-body.ts` (create) | Body builders and editors: `buildEntityBody`, `addRowValues`, `replaceLead`, `rewriteLinks`, `confirmUnverified`, `dropLine`, `addTasks`, `addUnverified`, `mergeEntityDraft`. |
| `packages/contracts/src/vault.ts` (create) | Zod schemas for vault domain objects and DTOs. Phase 2 serves these over HTTP. |
| `packages/contracts/src/index.ts` (modify) | Re-exports the three new modules. |
| `src/vault/vault-schema.ts` (create) | `VAULT_SCHEMA_SQL`. |
| `src/state/runtime-schema.ts` (modify) | Executes `VAULT_SCHEMA_SQL` during bootstrap. |
| `src/assistant/ids.ts` (modify) | Adds the `vnote` id prefix. |
| `src/vault/errors.ts` (create) | `VaultNotFoundError`, `VaultConflictError`, `VaultTitleTakenError`, `VaultValidationError`. |
| `src/vault/note-rows.ts` (create) | SQL row schemas, plus mapping from a row to `VaultNote` and `VaultNoteSummary`. |
| `src/vault/note-store.ts` (create) | `VaultNoteStore`: create, get, resolve, update, rename, delete, revisions, restore, and the derived index. |
| `src/vault/link-graph.ts` (create) | `loadLinkGraph`: resolves link targets and builds undirected adjacency and degree. Shared by queries, search and graph. |
| `src/vault/note-queries.ts` (create) | Folder list, folder notes, backlinks, outgoing links, review items, stats. |
| `src/vault/vault-search.ts` (create) | Full-text, title and alias search with `tag:`, `path:` and `type:` filters. |
| `src/vault/vault-graph.ts` (create) | Global and local graph data. |
| `tests/helpers/vault-fixture.ts` (create) | `withVault` isolated test context. |
| `tests/vault-*.test.ts` (create) | One test file per unit, listed in each task. |

---

### Task 1: Note dialect parser

**Files:**
- Create: `packages/contracts/src/vault-markdown.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/vault-markdown.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-markdown.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNoteBody, splitValues } from '@siftkit/contracts';

const ENTITY = [
  'Visual Studio Code is a tool you use. It runs on [[Windows]].',
  '',
  '**Uses** [[Git]] · [[Node.js|node]] · Dark Mode',
  '**Runs on** [[Windows]]',
  '',
  '## Plans',
  '- [ ] Try [[Cursor]]',
  '- [x] Install #extensions',
  '',
  '> [!more]- 2 more · uses',
  '> [[npm]] · [[Prettier]]',
  '',
  '> [!unverified]- 2 unverified facts',
  '> - **Uses** [[GitHub]] #unverified',
  '> - Likes dark themes #unverified',
  '',
  '![[attachments/captures/ev_1.png]]',
  '```',
  '[[NotALink]] #nottag',
  '```',
  'Inline `[[code]]` is ignored.',
].join('\n');

test('parseNoteBody extracts the lead from the first plain paragraph', () => {
  const parsed = parseNoteBody(ENTITY);
  assert.deepEqual(parsed.lead, { text: 'Visual Studio Code is a tool you use. It runs on [[Windows]].', line: 0 });
});

test('parseNoteBody reads top-level fact rows only', () => {
  const parsed = parseNoteBody(ENTITY);
  assert.deepEqual(parsed.factRows, [
    { label: 'Uses', values: ['[[Git]]', '[[Node.js|node]]', 'Dark Mode'], line: 2 },
    { label: 'Runs on', values: ['[[Windows]]'], line: 3 },
  ]);
});

test('parseNoteBody records links with row labels, skipping code', () => {
  const parsed = parseNoteBody(ENTITY);
  const summary = parsed.links.map((link) => [link.target, link.display, link.rowLabel, link.line, link.embed]);
  assert.deepEqual(summary, [
    ['Windows', null, null, 0, false],
    ['Git', null, 'Uses', 2, false],
    ['Node.js', 'node', 'Uses', 2, false],
    ['Windows', null, 'Runs on', 3, false],
    ['Cursor', null, null, 6, false],
    ['npm', null, null, 10, false],
    ['Prettier', null, null, 10, false],
    ['GitHub', null, 'Uses', 13, false],
    ['attachments/captures/ev_1.png', null, null, 16, true],
  ]);
});

test('parseNoteBody reads tasks, unverified facts, embeds and tags', () => {
  const parsed = parseNoteBody(ENTITY);
  assert.deepEqual(parsed.tasks, [
    { text: 'Try [[Cursor]]', done: false, line: 6 },
    { text: 'Install #extensions', done: true, line: 7 },
  ]);
  assert.deepEqual(parsed.unverified, [
    { label: 'Uses', value: '[[GitHub]]', line: 13 },
    { label: null, value: 'Likes dark themes', line: 14 },
  ]);
  assert.deepEqual(parsed.embeds, ['attachments/captures/ev_1.png']);
  assert.deepEqual(parsed.tags, ['extensions', 'unverified']);
});

test('parseNoteBody handles an empty body and a body without a lead', () => {
  assert.deepEqual(parseNoteBody(''), { lead: null, links: [], tags: [], factRows: [], tasks: [], unverified: [], embeds: [] });
  assert.equal(parseNoteBody('**Uses** [[A]]').lead, null);
});

test('splitValues trims and drops empty parts', () => {
  assert.deepEqual(splitValues(' [[A]] ·  b  · '), ['[[A]]', 'b']);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-markdown`
Expected: FAIL. `parseNoteBody` is not exported from `@siftkit/contracts`.

- [x] **Step 3: Write the implementation**

```ts
// packages/contracts/src/vault-markdown.ts
/** The vault note dialect (design §2). Pure functions shared by the server, the migration and the dashboard. */
export const VAULT_VALUE_SEPARATOR = ' · ';
export const VAULT_ROW_LIMIT = 8;
export const UNVERIFIED_TAG = '#unverified';
export const FACT_ROW_PATTERN = /^\*\*([^*]+)\*\*\s+(.+)$/;

const LINK_PATTERN = /(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;
const TAG_PATTERN = /(^|\s)#([A-Za-z][\w/-]*)/g;
const TASK_PATTERN = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const UNVERIFIED_PATTERN = /^>\s*[-*]\s+(.*?)\s*#unverified\b/;
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

export function splitValues(text: string): string[] {
  return text.split(VAULT_VALUE_SEPARATOR).map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Strips a callout marker and a bullet, so rows inside callouts still expose their label. */
export function stripLineMarkers(line: string): string {
  return line.replace(/^>\s?/, '').replace(/^\s*[-*]\s+/, '');
}

export function matchFactRow(text: string): { label: string; rest: string } | null {
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
    const contentRow = matchFactRow(stripLineMarkers(scannable));
    for (const match of scannable.matchAll(LINK_PATTERN)) {
      const embed = match[1] === '!';
      const target = (match[2] ?? '').trim();
      links.push({ target, display: match[3] ?? null, rowLabel: embed ? null : contentRow?.label ?? null, line: index, embed });
      if (embed) embeds.push(target);
    }
    for (const match of scannable.matchAll(TAG_PATTERN)) tags.add((match[2] ?? '').toLowerCase());

    const row = matchFactRow(line);
    if (row) factRows.push({ label: row.label, values: splitValues(row.rest), line: index });
    const task = line.match(TASK_PATTERN);
    if (task && !line.startsWith('>')) tasks.push({ text: task[2] ?? '', done: task[1] !== ' ', line: index });
    const fact = line.match(UNVERIFIED_PATTERN)?.[1];
    if (fact !== undefined) {
      const factRow = matchFactRow(fact);
      unverified.push(factRow
        ? { label: factRow.label, value: factRow.rest, line: index }
        : { label: null, value: fact.trim(), line: index });
    }
    if (lead === null && isPlainParagraph(line)) lead = { text: line.trim(), line: index };
  }

  return { lead, links, tags: [...tags], factRows, tasks, unverified, embeds };
}
```

Append to `packages/contracts/src/index.ts`:

```ts
export * from './vault-markdown.ts';
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-markdown`
Expected: PASS (6 tests).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 2: Body builders — entity body, rows, lead, link rewrite

**Files:**
- Create: `packages/contracts/src/vault-body.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `tests/vault-body.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-body.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { addRowValues, buildEntityBody, replaceLead, rewriteLinks } from '@siftkit/contracts';

const values = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `[[${prefix}${i + 1}]]`);

test('buildEntityBody writes lead, capped rows, tasks, overflow and unverified sections', () => {
  const body = buildEntityBody({
    lead: 'SiftKit is a project you work on.',
    rows: [{ label: 'Uses', values: values(10, 'T') }, { label: 'Runs on', values: ['[[Windows]]', '[[windows]]'] }, { label: 'Empty', values: [] }],
    taskSections: [{ heading: 'Plans', items: ['Ship the vault'] }],
    unverified: [{ label: 'Uses', value: '[[GitHub]]' }],
  });
  assert.equal(body, [
    'SiftKit is a project you work on.',
    '',
    `**Uses** ${values(8, 'T').join(' · ')}`,
    '**Runs on** [[Windows]]',
    '',
    '## Plans',
    '- [ ] Ship the vault',
    '',
    '> [!more]- 2 more · uses',
    '> [[T9]] · [[T10]]',
    '',
    '> [!unverified]- 1 unverified fact',
    '> - **Uses** [[GitHub]] #unverified',
  ].join('\n'));
});

test('addRowValues appends to an existing row and skips duplicates case-insensitively', () => {
  const body = 'Lead.\n\n**Uses** [[Git]]';
  assert.equal(addRowValues(body, 'uses', ['[[git]]', '[[npm]]']), 'Lead.\n\n**Uses** [[Git]] · [[npm]]');
  assert.equal(addRowValues(body, 'Uses', ['[[GIT]]']), body);
});

test('addRowValues inserts a new row after the last row, or after the lead', () => {
  assert.equal(addRowValues('Lead.\n\n**Uses** [[Git]]\n\n## Plans\n- [ ] x', 'Runs on', ['[[Windows]]']),
    'Lead.\n\n**Uses** [[Git]]\n**Runs on** [[Windows]]\n\n## Plans\n- [ ] x');
  assert.equal(addRowValues('Lead.', 'Uses', ['[[Git]]']), 'Lead.\n\n**Uses** [[Git]]');
  assert.equal(addRowValues('', 'Uses', ['[[Git]]']), '**Uses** [[Git]]');
});

test('addRowValues moves overflow into the matching more callout, before unverified facts', () => {
  const full = `Lead.\n\n**Uses** ${values(8, 'T').join(' · ')}\n\n> [!unverified]- 1 unverified fact\n> - x #unverified`;
  const once = addRowValues(full, 'Uses', ['[[New1]]']);
  assert.equal(once, `Lead.\n\n**Uses** ${values(8, 'T').join(' · ')}\n\n> [!more]- 1 more · uses\n> [[New1]]\n\n> [!unverified]- 1 unverified fact\n> - x #unverified`);
  const twice = addRowValues(once, 'Uses', ['[[New2]]', '[[new1]]', '[[T3]]']);
  assert.match(twice, /> \[!more\]- 2 more · uses\n> \[\[New1\]\] · \[\[New2\]\]/);
});

test('replaceLead swaps the first paragraph or prepends one', () => {
  assert.equal(replaceLead('Old lead.\n\n**Uses** [[A]]', 'New lead.'), 'New lead.\n\n**Uses** [[A]]');
  assert.equal(replaceLead('**Uses** [[A]]', 'New lead.'), 'New lead.\n\n**Uses** [[A]]');
});

test('rewriteLinks renames link targets but keeps headings, display text and embeds', () => {
  const result = rewriteLinks('[[Old Name]] · [[old name|alias]] · [[Old Name#Plans]] · ![[Old Name]] · [[Old Names]]', 'Old Name', 'New');
  assert.deepEqual(result, { body: '[[New]] · [[New|alias]] · [[New#Plans]] · ![[Old Name]] · [[Old Names]]', count: 3 });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-body`
Expected: FAIL. `buildEntityBody` is not exported.

- [x] **Step 3: Write the implementation**

```ts
// packages/contracts/src/vault-body.ts
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
export const UNVERIFIED_HEADER_PATTERN = /^> \[!unverified\]-\s+\d+ unverified facts?$/;

export const sameVaultValue = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

export function dedupeVaultValues(values: readonly string[]): string[] {
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !kept.some((existing) => sameVaultValue(existing, trimmed))) kept.push(trimmed);
  }
  return kept;
}

export function normalizeVaultLines(lines: readonly string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const rowLine = (label: string, values: readonly string[]) => `**${label}** ${values.join(VAULT_VALUE_SEPARATOR)}`;
const moreHeader = (count: number, label: string) => `> [!more]- ${count} more · ${label.toLowerCase()}`;
export const unverifiedHeader = (count: number) => `> [!unverified]- ${count} unverified fact${count === 1 ? '' : 's'}`;
export const unverifiedLine = (label: string, value: string) => `> - **${label}** ${value} ${UNVERIFIED_TAG}`;

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
```

Append to `packages/contracts/src/index.ts`:

```ts
export * from './vault-body.ts';
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-body`
Expected: PASS (6 tests).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 3: Body editors — triage, tasks, unverified, merge

**Files:**
- Modify: `packages/contracts/src/vault-body.ts`
- Test: `tests/vault-body-edits.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-body-edits.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { addTasks, addUnverified, confirmUnverified, dropLine, mergeEntityDraft } from '@siftkit/contracts';

const BODY = [
  'Lead.',
  '',
  '**Uses** [[Git]]',
  '',
  '## Plans',
  '- [ ] Ship it',
  '',
  '> [!unverified]- 2 unverified facts',
  '> - **Uses** [[GitHub]] #unverified',
  '> - **Prefers** Dark mode #unverified',
].join('\n');

test('confirmUnverified moves the fact into its row and decrements the header', () => {
  assert.equal(confirmUnverified(BODY, 8), [
    'Lead.', '', '**Uses** [[Git]] · [[GitHub]]', '', '## Plans', '- [ ] Ship it', '',
    '> [!unverified]- 1 unverified fact', '> - **Prefers** Dark mode #unverified',
  ].join('\n'));
});

test('confirming the last unverified fact removes the callout and creates a new row', () => {
  const once = confirmUnverified(BODY, 8);
  assert.equal(confirmUnverified(once, 8), 'Lead.\n\n**Uses** [[Git]] · [[GitHub]]\n**Prefers** Dark mode\n\n## Plans\n- [ ] Ship it');
});

test('confirmUnverified rejects a line that is not an unverified fact', () => {
  assert.throws(() => confirmUnverified(BODY, 2), /Line 2 is not an unverified fact/);
});

test('dropLine removes unverified facts with header bookkeeping, and plain lines as-is', () => {
  assert.match(dropLine(BODY, 9), /> \[!unverified\]- 1 unverified fact\n> - \*\*Uses\*\* \[\[GitHub\]\] #unverified$/);
  assert.equal(dropLine('a\nb\nc', 1), 'a\nc');
  assert.throws(() => dropLine('a', 4), /Line 4 is outside the note/);
});

test('addTasks appends under an existing heading or creates the section before callouts', () => {
  assert.match(addTasks(BODY, 'Plans', ['Ship it', 'Write docs']), /## Plans\n- \[ \] Ship it\n- \[ \] Write docs\n\n> \[!unverified\]/);
  assert.match(addTasks(BODY, 'Goals', ['Learn Rust']), /- \[ \] Ship it\n\n## Goals\n- \[ \] Learn Rust\n\n> \[!unverified\]/);
});

test('addUnverified skips facts already present as rows or unverified lines', () => {
  const next = addUnverified(BODY, [{ label: 'Uses', value: '[[Git]]' }, { label: 'Uses', value: '[[github]]' }, { label: 'Owns', value: '[[PC]]' }]);
  assert.match(next, /> \[!unverified\]- 3 unverified facts\n> - \*\*Uses\*\* \[\[GitHub\]\] #unverified\n> - \*\*Prefers\*\* Dark mode #unverified\n> - \*\*Owns\*\* \[\[PC\]\] #unverified$/);
  assert.equal(addUnverified('Lead.', [{ label: 'Uses', value: 'x' }]), 'Lead.\n\n> [!unverified]- 1 unverified fact\n> - **Uses** x #unverified');
});

test('mergeEntityDraft keeps an existing lead and unions rows, tasks and unverified facts', () => {
  const merged = mergeEntityDraft(BODY, {
    lead: 'Other lead.',
    rows: [{ label: 'Uses', values: ['[[Git]]', '[[npm]]'] }],
    taskSections: [{ heading: 'Plans', items: ['Ship it', 'Celebrate'] }],
    unverified: [{ label: 'Owns', value: '[[PC]]' }],
  });
  assert.match(merged, /^Lead\.\n\n\*\*Uses\*\* \[\[Git\]\] · \[\[npm\]\]/);
  assert.match(merged, /- \[ \] Ship it\n- \[ \] Celebrate/);
  assert.match(merged, /> - \*\*Owns\*\* \[\[PC\]\] #unverified$/);
  assert.equal(mergeEntityDraft('', { lead: 'New lead.', rows: [], taskSections: [], unverified: [] }), 'New lead.');
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-body-edits`
Expected: FAIL. `confirmUnverified` is not exported.

- [x] **Step 3: Write the implementation** (append to `packages/contracts/src/vault-body.ts`)

```ts
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
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-body-edits`, then `node .\src\test-runner\run-tests.ts vault-body`.
Expected: PASS (7 tests, plus the 6 from Task 2).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 4: Vault domain schemas, SQL tables and id prefix

**Files:**
- Create: `packages/contracts/src/vault.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `src/vault/vault-schema.ts`
- Modify: `src/state/runtime-schema.ts`. Add the import, and one call after the `ASSISTANT_MOBILE_SCHEMA_SQL` exec (currently line 745).
- Modify: `src/assistant/ids.ts`. Add `'vnote'` to `IdPrefix`.
- Test: `tests/vault-schema.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-schema.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { VaultNoteSchema } from '@siftkit/contracts';
import { z } from '../src/lib/zod.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const NameRowsSchema = z.array(z.object({ name: z.string() }));

test('runtime bootstrap creates every vault table', () => {
  const database = getRuntimeDatabase(path.join(createManagedTempDir('siftkit-vault-schema-'), 'runtime.sqlite'));
  try {
    const names = NameRowsSchema.parse(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vault_%' ORDER BY name",
    ).all()).map((row) => row.name);
    for (const table of ['vault_aliases', 'vault_links', 'vault_note_revisions', 'vault_notes', 'vault_notes_fts', 'vault_tags']) {
      assert.ok(names.includes(table), `missing ${table}`);
    }
  } finally {
    closeAllRuntimeDatabases();
  }
});

test('VaultNoteSchema rejects an unknown kind', () => {
  const note = {
    id: 'vnote_1', title: 'A', folder: '', kind: 'entity', types: [], aliases: [], tags: [], body: '',
    revision: 1, isStub: true, createdAtUtc: '2026-10-24T00:00:00.000Z', updatedAtUtc: '2026-10-24T00:00:00.000Z',
  };
  assert.equal(VaultNoteSchema.parse(note).kind, 'entity');
  assert.throws(() => VaultNoteSchema.parse({ ...note, kind: 'projection' }));
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-schema`
Expected: FAIL. `VaultNoteSchema` is not exported.

- [x] **Step 3: Write the implementation**

```ts
// packages/contracts/src/vault.ts
import { z } from 'zod';

export const VAULT_NOTE_KINDS = ['entity', 'capture', 'daily', 'chat', 'note'] as const;
export const VaultNoteKindSchema = z.enum(VAULT_NOTE_KINDS);
export type VaultNoteKind = z.infer<typeof VaultNoteKindSchema>;

export const VaultNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.string(),
  kind: VaultNoteKindSchema,
  types: z.array(z.string()),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  body: z.string(),
  revision: z.number().int().min(1),
  isStub: z.boolean(),
  createdAtUtc: z.string(),
  updatedAtUtc: z.string(),
}).strict();
export type VaultNote = z.infer<typeof VaultNoteSchema>;

export const VaultNoteSummarySchema = VaultNoteSchema.pick({
  id: true, title: true, folder: true, kind: true, isStub: true, updatedAtUtc: true,
});
export type VaultNoteSummary = z.infer<typeof VaultNoteSummarySchema>;

export const VaultRevisionSummarySchema = z.object({
  revision: z.number().int().min(1),
  actor: z.string(),
  summary: z.string(),
  sourceRef: z.string().nullable(),
  createdAtUtc: z.string(),
}).strict();
export type VaultRevisionSummary = z.infer<typeof VaultRevisionSummarySchema>;

export const VaultRevisionSchema = VaultRevisionSummarySchema.extend({
  title: z.string(),
  folder: z.string(),
  body: z.string(),
  types: z.array(z.string()),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
}).strict();
export type VaultRevision = z.infer<typeof VaultRevisionSchema>;

export const VaultFolderSchema = z.object({
  path: z.string(),
  name: z.string(),
  depth: z.number().int().min(0),
  count: z.number().int().min(0),
}).strict();
export type VaultFolder = z.infer<typeof VaultFolderSchema>;

export const VaultBacklinkSchema = z.object({
  note: VaultNoteSummarySchema,
  labels: z.array(z.string()),
}).strict();
export type VaultBacklink = z.infer<typeof VaultBacklinkSchema>;

export const VaultOutgoingSchema = z.object({
  resolved: z.array(VaultNoteSummarySchema),
  unresolved: z.array(z.string()),
}).strict();
export type VaultOutgoing = z.infer<typeof VaultOutgoingSchema>;

export const VaultReviewItemSchema = z.object({
  note: VaultNoteSummarySchema,
  line: z.number().int().min(0),
  label: z.string().nullable(),
  value: z.string(),
}).strict();
export type VaultReviewItem = z.infer<typeof VaultReviewItemSchema>;

export const VaultReviewSchema = z.object({
  total: z.number().int().min(0),
  items: z.array(VaultReviewItemSchema),
}).strict();
export type VaultReview = z.infer<typeof VaultReviewSchema>;

export const VaultStatsSchema = z.object({
  notes: z.number().int().min(0),
  links: z.number().int().min(0),
  tags: z.number().int().min(0),
  stubs: z.number().int().min(0),
  notesWithUnverified: z.number().int().min(0),
  byKind: z.record(VaultNoteKindSchema, z.number().int().min(0)),
}).strict();
export type VaultStats = z.infer<typeof VaultStatsSchema>;

export const VaultSearchHitSchema = z.object({
  note: VaultNoteSummarySchema,
  score: z.number(),
  snippet: z.string().nullable(),
}).strict();
export type VaultSearchHit = z.infer<typeof VaultSearchHitSchema>;

export const VaultSearchResultSchema = z.object({
  total: z.number().int().min(0),
  hits: z.array(VaultSearchHitSchema),
}).strict();
export type VaultSearchResult = z.infer<typeof VaultSearchResultSchema>;

export const VaultGraphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.string(),
  topFolder: z.string(),
  kind: VaultNoteKindSchema,
  degree: z.number().int().min(0),
}).strict();
export type VaultGraphNode = z.infer<typeof VaultGraphNodeSchema>;

export const VaultGraphSchema = z.object({
  nodes: z.array(VaultGraphNodeSchema),
  edges: z.array(z.object({ source: z.string(), target: z.string() }).strict()),
}).strict();
export type VaultGraph = z.infer<typeof VaultGraphSchema>;
```

Append to `packages/contracts/src/index.ts`:

```ts
export * from './vault.ts';
```

```ts
// src/vault/vault-schema.ts
/** Vault notes and their derived indexes (design §3). Links, aliases, tags and FTS are rebuilt on every note write. */
export const VAULT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vault_notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL UNIQUE,
    folder TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('entity', 'capture', 'daily', 'chat', 'note')),
    types_json TEXT NOT NULL DEFAULT '[]',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    is_stub INTEGER NOT NULL CHECK (is_stub IN (0, 1)),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_notes_folder_idx ON vault_notes(folder, title_key);

CREATE TABLE IF NOT EXISTS vault_note_revisions (
    note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    actor TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_ref TEXT,
    title TEXT NOT NULL,
    folder TEXT NOT NULL,
    body TEXT NOT NULL,
    types_json TEXT NOT NULL,
    aliases_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    PRIMARY KEY (note_id, revision)
);

CREATE TABLE IF NOT EXISTS vault_links (
    from_note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    target_key TEXT NOT NULL,
    row_label TEXT,
    line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_links_target_idx ON vault_links(target_key);
CREATE INDEX IF NOT EXISTS vault_links_from_idx ON vault_links(from_note_id);

CREATE TABLE IF NOT EXISTS vault_aliases (
    alias_key TEXT NOT NULL,
    note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    PRIMARY KEY (alias_key, note_id)
);

CREATE TABLE IF NOT EXISTS vault_tags (
    note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS vault_tags_tag_idx ON vault_tags(tag);

CREATE VIRTUAL TABLE IF NOT EXISTS vault_notes_fts USING fts5(
    note_id UNINDEXED, title, aliases, body, tokenize = 'unicode61');
`;
```

In `src/state/runtime-schema.ts`, add `import { VAULT_SCHEMA_SQL } from '../vault/vault-schema.ts';` next to the assistant schema import. Then add as the last statement of `initializeRuntimeSchema`:

```ts
  database.exec(VAULT_SCHEMA_SQL);
```

In `src/assistant/ids.ts`, change the last member of the `IdPrefix` union from `| 'aevt' | 'asess';` to:

```ts
  | 'aevt' | 'asess' | 'vnote';
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-schema` and `node .\src\test-runner\run-tests.ts assistant-schema`.
Expected: PASS. `assistant-schema` must stay green.

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 5: Note store — create, get, resolve, derived index

**Files:**
- Create: `src/vault/errors.ts`
- Create: `src/vault/note-rows.ts`
- Create: `src/vault/note-store.ts`
- Create: `tests/helpers/vault-fixture.ts`
- Test: `tests/vault-note-store.test.ts`

- [x] **Step 1: Write the fixture and the failing test**

```ts
// tests/helpers/vault-fixture.ts
import path from 'node:path';

import { FixedClock } from '../../src/assistant/clock.ts';
import { SequentialIdGenerator } from '../../src/assistant/ids.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase, type RuntimeDatabase } from '../../src/state/runtime-db.ts';
import { VaultNoteStore, type VaultNoteInput, type VaultWriteMeta } from '../../src/vault/note-store.ts';
import { createManagedTempDir } from './temp-dirs.ts';

export interface VaultTestContext {
  readonly database: RuntimeDatabase;
  readonly clock: FixedClock;
  readonly store: VaultNoteStore;
  readonly runtimeRoot: string;
}

export const VAULT_FIXTURE_START = '2026-10-24T09:00:00.000Z';
export const TEST_META: VaultWriteMeta = { actor: 'you', summary: 'test write', sourceRef: null };

export function entityInput(title: string, body: string, overrides: Partial<VaultNoteInput> = {}): VaultNoteInput {
  return { title, folder: 'Software', kind: 'entity', types: ['software'], aliases: [], tags: [], body, ...overrides };
}

/** Isolated runtime database with the vault schema and a store over it. */
export function withVault<T>(body: (context: VaultTestContext) => T): T {
  const runtimeRoot = createManagedTempDir('siftkit-vault-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  try {
    const clock = new FixedClock(VAULT_FIXTURE_START);
    const store = new VaultNoteStore(database, clock, new SequentialIdGenerator());
    return body({ database, clock, store, runtimeRoot });
  } finally {
    closeAllRuntimeDatabases();
  }
}
```

```ts
// tests/vault-note-store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { VaultTitleTakenError, VaultValidationError } from '../src/vault/errors.ts';
import { TEST_META, VAULT_FIXTURE_START, entityInput, withVault } from './helpers/vault-fixture.ts';

const LinkRowsSchema = z.array(z.object({ target_key: z.string(), row_label: z.string().nullable(), line: z.number() }));
const TagRowsSchema = z.array(z.object({ tag: z.string() }));
const FtsRowsSchema = z.array(z.object({ note_id: z.string() }));

test('create stores a note at revision 1 with a revision snapshot', () => withVault(({ store }) => {
  const note = store.create(entityInput('Visual Studio Code', 'A tool.\n\n**Uses** [[Git]]', { aliases: ['VS Code', 'vs code', 'Visual Studio Code'] }), TEST_META);
  assert.deepEqual(note, {
    id: 'vnote_0001', title: 'Visual Studio Code', folder: 'Software', kind: 'entity', types: ['software'],
    aliases: ['VS Code'], tags: [], body: 'A tool.\n\n**Uses** [[Git]]', revision: 1, isStub: false,
    createdAtUtc: VAULT_FIXTURE_START, updatedAtUtc: VAULT_FIXTURE_START,
  });
  assert.deepEqual(store.get(note.id), note);
  assert.deepEqual(store.listRevisions(note.id), [{ revision: 1, actor: 'you', summary: 'test write', sourceRef: null, createdAtUtc: VAULT_FIXTURE_START }]);
}));

test('create rebuilds links, tags and FTS from the body', () => withVault(({ store, database }) => {
  const note = store.create(entityInput('SiftKit', 'Lead with [[Node.js]] #tooling.\n\n**Uses** [[Git]] · ![[attachments/x.png]]', { tags: ['Project'] }), TEST_META);
  assert.deepEqual(LinkRowsSchema.parse(database.prepare('SELECT target_key, row_label, line FROM vault_links WHERE from_note_id = ? ORDER BY line, target_key').all(note.id)),
    [{ target_key: 'node.js', row_label: null, line: 0 }, { target_key: 'git', row_label: 'Uses', line: 2 }]);
  assert.deepEqual(TagRowsSchema.parse(database.prepare('SELECT tag FROM vault_tags WHERE note_id = ? ORDER BY tag').all(note.id)).map((row) => row.tag), ['project', 'tooling']);
  assert.deepEqual(FtsRowsSchema.parse(database.prepare("SELECT note_id FROM vault_notes_fts WHERE vault_notes_fts MATCH 'tooling'").all()), [{ note_id: note.id }]);
}));

test('resolve finds a note by title or alias, case-insensitively, title first', () => withVault(({ store }) => {
  const vscode = store.create(entityInput('Visual Studio Code', 'x', { aliases: ['VS Code', 'Code'] }), TEST_META);
  const code = store.create(entityInput('Code', 'y'), TEST_META);
  assert.equal(store.resolve('vs code')?.id, vscode.id);
  assert.equal(store.resolve('code')?.id, code.id);
  assert.equal(store.resolve('missing'), null);
}));

test('create rejects duplicate titles and invalid titles', () => withVault(({ store }) => {
  store.create(entityInput('Git', 'x'), TEST_META);
  assert.throws(() => store.create(entityInput('git', 'y'), TEST_META), VaultTitleTakenError);
  for (const title of ['', '   ', 'a[b', 'a|b', 'a#b', 'x'.repeat(201)]) {
    assert.throws(() => store.create(entityInput(title, 'y'), TEST_META), VaultValidationError);
  }
}));

test('isStub is true only for entity notes with no rows, tasks or unverified facts', () => withVault(({ store }) => {
  assert.equal(store.create(entityInput('Prettier', 'Prettier is a tool.'), TEST_META).isStub, true);
  assert.equal(store.create(entityInput('Git', '**Uses** [[Linux]]'), TEST_META).isStub, false);
  assert.equal(store.create(entityInput('2026-10-24', 'Mostly in Chrome.', { kind: 'daily', folder: 'Daily' }), TEST_META).isStub, false);
}));

test('folder paths are normalized', () => withVault(({ store }) => {
  assert.equal(store.create(entityInput('A', 'x', { folder: '/Captures//2026-10-24/' }), TEST_META).folder, 'Captures/2026-10-24');
}));
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-note-store`
Expected: FAIL. Module `src/vault/note-store.ts` not found.

- [x] **Step 3: Write the implementation**

```ts
// src/vault/errors.ts
export class VaultNotFoundError extends Error {
  constructor(what: string) {
    super(`Vault note not found: ${what}`);
    this.name = 'VaultNotFoundError';
  }
}

export class VaultConflictError extends Error {
  readonly currentRevision: number;

  constructor(noteId: string, currentRevision: number) {
    super(`Vault note ${noteId} changed; current revision is ${currentRevision}.`);
    this.name = 'VaultConflictError';
    this.currentRevision = currentRevision;
  }
}

export class VaultTitleTakenError extends Error {
  constructor(title: string) {
    super(`A vault note titled "${title}" already exists.`);
    this.name = 'VaultTitleTakenError';
  }
}

export class VaultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultValidationError';
  }
}
```

```ts
// src/vault/note-rows.ts
import { VaultNoteKindSchema, type VaultNote, type VaultNoteSummary, type VaultRevision } from '@siftkit/contracts';

import { parseJsonText } from '../lib/json.ts';
import { z } from '../lib/zod.ts';

const StringListSchema = z.array(z.string());

export const VaultNoteRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  title_key: z.string(),
  folder: z.string(),
  kind: VaultNoteKindSchema,
  types_json: z.string(),
  aliases_json: z.string(),
  tags_json: z.string(),
  body: z.string(),
  revision: z.number().int(),
  is_stub: z.number().int(),
  created_at_utc: z.string(),
  updated_at_utc: z.string(),
});
export type VaultNoteRow = z.infer<typeof VaultNoteRowSchema>;

export const VaultRevisionRowSchema = z.object({
  revision: z.number().int(),
  actor: z.string(),
  summary: z.string(),
  source_ref: z.string().nullable(),
  title: z.string(),
  folder: z.string(),
  body: z.string(),
  types_json: z.string(),
  aliases_json: z.string(),
  tags_json: z.string(),
  created_at_utc: z.string(),
});

export const parseStringList = (text: string): string[] => parseJsonText(text, StringListSchema);

export function toVaultNote(row: VaultNoteRow): VaultNote {
  return {
    id: row.id,
    title: row.title,
    folder: row.folder,
    kind: row.kind,
    types: parseStringList(row.types_json),
    aliases: parseStringList(row.aliases_json),
    tags: parseStringList(row.tags_json),
    body: row.body,
    revision: row.revision,
    isStub: row.is_stub === 1,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

export function toVaultNoteSummary(note: Pick<VaultNote, 'id' | 'title' | 'folder' | 'kind' | 'isStub' | 'updatedAtUtc'>): VaultNoteSummary {
  return { id: note.id, title: note.title, folder: note.folder, kind: note.kind, isStub: note.isStub, updatedAtUtc: note.updatedAtUtc };
}

export function toVaultRevision(row: z.infer<typeof VaultRevisionRowSchema>): VaultRevision {
  return {
    revision: row.revision,
    actor: row.actor,
    summary: row.summary,
    sourceRef: row.source_ref,
    createdAtUtc: row.created_at_utc,
    title: row.title,
    folder: row.folder,
    body: row.body,
    types: parseStringList(row.types_json),
    aliases: parseStringList(row.aliases_json),
    tags: parseStringList(row.tags_json),
  };
}
```

```ts
// src/vault/note-store.ts
import {
  parseNoteBody, type VaultNote, type VaultNoteKind, type VaultRevision, type VaultRevisionSummary,
} from '@siftkit/contracts';

import type { Clock } from '../assistant/clock.ts';
import type { IdGenerator } from '../assistant/ids.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { VaultNotFoundError, VaultTitleTakenError, VaultValidationError } from './errors.ts';
import { VaultNoteRowSchema, VaultRevisionRowSchema, toVaultNote, toVaultRevision } from './note-rows.ts';

export interface VaultWriteMeta {
  readonly actor: string;
  readonly summary: string;
  readonly sourceRef: string | null;
}

export interface VaultNoteInput {
  readonly title: string;
  readonly folder: string;
  readonly kind: VaultNoteKind;
  readonly types: readonly string[];
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly body: string;
}

const TITLE_MAX_LENGTH = 200;
const TITLE_FORBIDDEN = /[[\]|#^\\/:*?"<>]/;
const IdRowSchema = z.object({ id: z.string() });
const NoteIdRowSchema = z.object({ note_id: z.string() });

export const vaultKey = (text: string): string => text.trim().toLowerCase();

export function validateVaultTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > TITLE_MAX_LENGTH || TITLE_FORBIDDEN.test(trimmed)) {
    throw new VaultValidationError(`Invalid note title: ${JSON.stringify(title)}`);
  }
  return trimmed;
}

function normalizeFolder(folder: string): string {
  const parts = folder.split('/').map((part) => part.trim()).filter((part) => part.length > 0);
  for (const part of parts) {
    if (TITLE_FORBIDDEN.test(part)) throw new VaultValidationError(`Invalid folder: ${JSON.stringify(folder)}`);
  }
  return parts.join('/');
}

function uniqueKeyed(values: readonly string[], exclude: string | null): string[] {
  const seen = new Set<string>(exclude === null ? [] : [vaultKey(exclude)]);
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(vaultKey(trimmed))) continue;
    seen.add(vaultKey(trimmed));
    kept.push(trimmed);
  }
  return kept;
}

export function computeIsStub(kind: VaultNoteKind, body: string): boolean {
  if (kind !== 'entity') return false;
  const parsed = parseNoteBody(body);
  return parsed.factRows.length === 0 && parsed.tasks.length === 0 && parsed.unverified.length === 0;
}

/** The only writer of vault notes. Every write is one transaction: note row, revision snapshot, derived indexes. */
export class VaultNoteStore {
  private readonly database: RuntimeDatabase;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(database: RuntimeDatabase, clock: Clock, ids: IdGenerator) {
    this.database = database;
    this.clock = clock;
    this.ids = ids;
  }

  create(input: VaultNoteInput, meta: VaultWriteMeta): VaultNote {
    return this.database.transaction((): VaultNote => {
      const title = validateVaultTitle(input.title);
      if (this.findIdByTitleKey(vaultKey(title)) !== null) throw new VaultTitleTakenError(title);
      const now = this.clock.nowUtc();
      const note: VaultNote = {
        id: this.ids.next('vnote'),
        title,
        folder: normalizeFolder(input.folder),
        kind: input.kind,
        types: uniqueKeyed(input.types, null),
        aliases: uniqueKeyed(input.aliases, title),
        tags: uniqueKeyed(input.tags.map((tag) => tag.toLowerCase()), null),
        body: input.body,
        revision: 1,
        isStub: computeIsStub(input.kind, input.body),
        createdAtUtc: now,
        updatedAtUtc: now,
      };
      this.database.prepare(`
        INSERT INTO vault_notes (id, title, title_key, folder, kind, types_json, aliases_json, tags_json,
          body, revision, is_stub, created_at_utc, updated_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(note.id, note.title, vaultKey(note.title), note.folder, note.kind, JSON.stringify(note.types),
        JSON.stringify(note.aliases), JSON.stringify(note.tags), note.body, note.revision, note.isStub ? 1 : 0,
        note.createdAtUtc, note.updatedAtUtc);
      this.writeRevision(note, meta);
      this.reindex(note);
      return note;
    })();
  }

  get(id: string): VaultNote | null {
    const row = this.database.prepare('SELECT * FROM vault_notes WHERE id = ?').get(id);
    return row === undefined ? null : toVaultNote(VaultNoteRowSchema.parse(row));
  }

  require(id: string): VaultNote {
    const note = this.get(id);
    if (note === null) throw new VaultNotFoundError(id);
    return note;
  }

  /** Title match wins over alias match; among alias matches the oldest id wins. */
  resolve(titleOrAlias: string): VaultNote | null {
    const key = vaultKey(titleOrAlias);
    const byTitle = this.findIdByTitleKey(key);
    if (byTitle !== null) return this.get(byTitle);
    const alias = this.database.prepare('SELECT note_id FROM vault_aliases WHERE alias_key = ? ORDER BY note_id LIMIT 1').get(key);
    return alias === undefined ? null : this.get(NoteIdRowSchema.parse(alias).note_id);
  }

  listRevisions(id: string): VaultRevisionSummary[] {
    this.require(id);
    return z.array(VaultRevisionRowSchema).parse(this.database.prepare(
      'SELECT * FROM vault_note_revisions WHERE note_id = ? ORDER BY revision DESC',
    ).all(id)).map((row) => {
      const revision = toVaultRevision(row);
      return { revision: revision.revision, actor: revision.actor, summary: revision.summary, sourceRef: revision.sourceRef, createdAtUtc: revision.createdAtUtc };
    });
  }

  getRevision(id: string, revision: number): VaultRevision {
    const row = this.database.prepare('SELECT * FROM vault_note_revisions WHERE note_id = ? AND revision = ?').get(id, revision);
    if (row === undefined) throw new VaultNotFoundError(`${id} revision ${revision}`);
    return toVaultRevision(VaultRevisionRowSchema.parse(row));
  }

  private findIdByTitleKey(key: string): string | null {
    const row = this.database.prepare('SELECT id FROM vault_notes WHERE title_key = ?').get(key);
    return row === undefined ? null : IdRowSchema.parse(row).id;
  }

  private writeRevision(note: VaultNote, meta: VaultWriteMeta): void {
    this.database.prepare(`
      INSERT INTO vault_note_revisions (note_id, revision, actor, summary, source_ref, title, folder, body,
        types_json, aliases_json, tags_json, created_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(note.id, note.revision, meta.actor, meta.summary, meta.sourceRef, note.title, note.folder, note.body,
      JSON.stringify(note.types), JSON.stringify(note.aliases), JSON.stringify(note.tags), note.updatedAtUtc);
  }

  private reindex(note: VaultNote): void {
    for (const table of ['vault_links', 'vault_aliases', 'vault_tags', 'vault_notes_fts']) {
      const column = table === 'vault_links' ? 'from_note_id' : 'note_id';
      this.database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(note.id);
    }
    const parsed = parseNoteBody(note.body);
    const insertLink = this.database.prepare('INSERT INTO vault_links (from_note_id, target_key, row_label, line) VALUES (?, ?, ?, ?)');
    for (const link of parsed.links) {
      if (!link.embed) insertLink.run(note.id, vaultKey(link.target), link.rowLabel, link.line);
    }
    const insertAlias = this.database.prepare('INSERT OR IGNORE INTO vault_aliases (alias_key, note_id) VALUES (?, ?)');
    for (const alias of note.aliases) insertAlias.run(vaultKey(alias), note.id);
    const insertTag = this.database.prepare('INSERT OR IGNORE INTO vault_tags (note_id, tag) VALUES (?, ?)');
    for (const tag of new Set([...note.tags, ...parsed.tags].map((value) => value.toLowerCase()))) insertTag.run(note.id, tag);
    this.database.prepare('INSERT INTO vault_notes_fts (note_id, title, aliases, body) VALUES (?, ?, ?, ?)')
      .run(note.id, note.title, note.aliases.join(' '), note.body);
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-note-store`
Expected: PASS (6 tests).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 6: Note store — update, revisions, restore

**Files:**
- Modify: `src/vault/note-store.ts`
- Test: `tests/vault-note-revisions.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-note-revisions.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { VaultConflictError, VaultNotFoundError } from '../src/vault/errors.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

test('update bumps the revision, snapshots it and reindexes', () => withVault(({ store, clock }) => {
  const note = store.create(entityInput('Git', 'Lead.'), TEST_META);
  clock.advanceSeconds(60);
  const next = store.update(note.id, { body: 'Lead.\n\n**Runs on** [[Linux]]', tags: ['cli'] }, 1, { actor: 'note-writer · screenshot', summary: 'Learned 1 new fact', sourceRef: 'att_1' });
  assert.equal(next.revision, 2);
  assert.equal(next.isStub, false);
  assert.deepEqual(next.tags, ['cli']);
  assert.equal(next.updatedAtUtc, '2026-10-24T09:01:00.000Z');
  assert.deepEqual(store.listRevisions(note.id).map((revision) => [revision.revision, revision.actor, revision.sourceRef]),
    [[2, 'note-writer · screenshot', 'att_1'], [1, 'you', null]]);
  assert.equal(store.getRevision(note.id, 1).body, 'Lead.');
  assert.equal(store.resolve('git')?.revision, 2);
}));

test('update with a stale revision throws a conflict carrying the current revision', () => withVault(({ store }) => {
  const note = store.create(entityInput('Git', 'Lead.'), TEST_META);
  store.update(note.id, { body: 'Two.' }, 1, TEST_META);
  assert.throws(() => store.update(note.id, { body: 'Three.' }, 1, TEST_META),
    (error: Error) => error instanceof VaultConflictError && error.currentRevision === 2);
}));

test('an update that changes nothing creates no revision', () => withVault(({ store }) => {
  const note = store.create(entityInput('Git', 'Lead.'), TEST_META);
  assert.equal(store.update(note.id, { body: 'Lead.' }, 1, TEST_META).revision, 1);
  assert.equal(store.listRevisions(note.id).length, 1);
}));

test('restore writes the old snapshot as a new revision and keeps history', () => withVault(({ store }) => {
  const note = store.create(entityInput('Git', 'One.', { aliases: ['git-scm'] }), TEST_META);
  store.update(note.id, { body: 'Two.', aliases: [] }, 1, TEST_META);
  const restored = store.restore(note.id, 1, 2, { actor: 'you', summary: 'Restored r1', sourceRef: null });
  assert.equal(restored.revision, 3);
  assert.equal(restored.body, 'One.');
  assert.deepEqual(restored.aliases, ['git-scm']);
  assert.equal(store.listRevisions(note.id).length, 3);
}));

test('missing notes and revisions throw not-found', () => withVault(({ store }) => {
  assert.throws(() => store.update('vnote_404', { body: 'x' }, 1, TEST_META), VaultNotFoundError);
  const note = store.create(entityInput('Git', 'One.'), TEST_META);
  assert.throws(() => store.getRevision(note.id, 9), VaultNotFoundError);
}));
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-note-revisions`
Expected: FAIL. `store.update is not a function`.

- [x] **Step 3: Write the implementation**

Add to the imports of `src/vault/note-store.ts`: `VaultConflictError` from `./errors.ts`. Add this interface below `VaultNoteInput`:

```ts
export interface VaultNotePatch {
  readonly body?: string;
  readonly folder?: string;
  readonly types?: readonly string[];
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
}
```

Add these methods inside `VaultNoteStore`, after `getRevision`:

```ts
  update(id: string, patch: VaultNotePatch, expectedRevision: number, meta: VaultWriteMeta): VaultNote {
    return this.database.transaction((): VaultNote => {
      const current = this.requireRevision(id, expectedRevision);
      const body = patch.body ?? current.body;
      const next: VaultNote = {
        ...current,
        body,
        folder: patch.folder === undefined ? current.folder : normalizeFolder(patch.folder),
        types: patch.types === undefined ? current.types : uniqueKeyed(patch.types, null),
        aliases: uniqueKeyed(patch.aliases ?? current.aliases, current.title),
        tags: patch.tags === undefined ? current.tags : uniqueKeyed(patch.tags.map((tag) => tag.toLowerCase()), null),
        isStub: computeIsStub(current.kind, body),
      };
      return this.persist(current, next, meta);
    })();
  }

  restore(id: string, revision: number, expectedRevision: number, meta: VaultWriteMeta): VaultNote {
    return this.database.transaction((): VaultNote => {
      const current = this.requireRevision(id, expectedRevision);
      const snapshot = this.getRevision(id, revision);
      // Title is not restored: renaming rewrites other notes and stays an explicit action.
      return this.persist(current, {
        ...current,
        body: snapshot.body,
        folder: snapshot.folder,
        types: snapshot.types,
        aliases: uniqueKeyed(snapshot.aliases, current.title),
        tags: snapshot.tags,
        isStub: computeIsStub(current.kind, snapshot.body),
      }, meta);
    })();
  }

  private requireRevision(id: string, expectedRevision: number): VaultNote {
    const current = this.require(id);
    if (current.revision !== expectedRevision) throw new VaultConflictError(id, current.revision);
    return current;
  }

  /** Writes `next` as a new revision unless nothing changed. Callers run inside a transaction. */
  private persist(current: VaultNote, next: VaultNote, meta: VaultWriteMeta): VaultNote {
    const unchanged = current.title === next.title && current.body === next.body && current.folder === next.folder
      && JSON.stringify([current.types, current.aliases, current.tags]) === JSON.stringify([next.types, next.aliases, next.tags]);
    if (unchanged) return current;
    const written: VaultNote = { ...next, revision: current.revision + 1, updatedAtUtc: this.clock.nowUtc() };
    this.database.prepare(`
      UPDATE vault_notes SET title = ?, title_key = ?, folder = ?, types_json = ?, aliases_json = ?, tags_json = ?,
        body = ?, revision = ?, is_stub = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(written.title, vaultKey(written.title), written.folder, JSON.stringify(written.types),
      JSON.stringify(written.aliases), JSON.stringify(written.tags), written.body, written.revision,
      written.isStub ? 1 : 0, written.updatedAtUtc, written.id);
    this.writeRevision(written, meta);
    this.reindex(written);
    return written;
  }
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-note-revisions`, then `node .\src\test-runner\run-tests.ts vault-note-store`.
Expected: PASS (5 + 6 tests).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 7: Note store — rename and delete

**Files:**
- Modify: `src/vault/note-store.ts`
- Test: `tests/vault-rename.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-rename.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { VaultConflictError, VaultNotFoundError, VaultTitleTakenError } from '../src/vault/errors.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

const CountSchema = z.object({ count: z.number() });

test('rename rewrites every inbound link as its own revision and keeps the old title as an alias', () => withVault(({ store }) => {
  const target = store.create(entityInput('VS Code', 'Editor.'), TEST_META);
  const a = store.create(entityInput('SiftKit', '**Uses** [[VS Code]] · [[vs code|editor]]'), TEST_META);
  const b = store.create(entityInput('Me', 'I live in [[VS Code#Settings]].'), TEST_META);
  const result = store.rename(target.id, 'Visual Studio Code', 1, { actor: 'you', summary: 'Renamed', sourceRef: null });
  assert.equal(result.note.title, 'Visual Studio Code');
  assert.deepEqual(result.note.aliases, ['VS Code']);
  assert.deepEqual([result.rewrittenNotes, result.rewrittenLinks], [2, 3]);
  assert.equal(store.require(a.id).body, '**Uses** [[Visual Studio Code]] · [[Visual Studio Code|editor]]');
  assert.equal(store.require(a.id).revision, 2);
  assert.equal(store.listRevisions(a.id)[0]?.summary, 'Link updated: VS Code → Visual Studio Code');
  assert.equal(store.require(b.id).body, 'I live in [[Visual Studio Code#Settings]].');
  assert.equal(store.resolve('vs code')?.id, target.id);
}));

test('rename to a title owned by another note fails; case-only rename succeeds', () => withVault(({ store }) => {
  const git = store.create(entityInput('git', 'x'), TEST_META);
  store.create(entityInput('Linux', 'y'), TEST_META);
  assert.throws(() => store.rename(git.id, 'LINUX', 1, TEST_META), VaultTitleTakenError);
  assert.equal(store.rename(git.id, 'Git', 1, TEST_META).note.title, 'Git');
  assert.throws(() => store.rename(git.id, 'Git2', 1, TEST_META), VaultConflictError);
}));

test('delete removes the note, its revisions and derived rows; links to it become unresolved', () => withVault(({ store, database }) => {
  const git = store.create(entityInput('Git', '**Uses** [[Linux]]', { aliases: ['git-scm'], tags: ['cli'] }), TEST_META);
  store.create(entityInput('SiftKit', '**Uses** [[Git]]'), TEST_META);
  store.delete(git.id, 1);
  assert.equal(store.get(git.id), null);
  assert.equal(store.resolve('git-scm'), null);
  for (const [table, column] of [['vault_note_revisions', 'note_id'], ['vault_links', 'from_note_id'], ['vault_aliases', 'note_id'], ['vault_tags', 'note_id'], ['vault_notes_fts', 'note_id']]) {
    assert.equal(CountSchema.parse(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(git.id)).count, 0, table);
  }
  assert.throws(() => store.delete(git.id, 1), VaultNotFoundError);
}));
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-rename`
Expected: FAIL. `store.rename is not a function`.

- [x] **Step 3: Write the implementation**

Add `rewriteLinks` to the `@siftkit/contracts` import in `src/vault/note-store.ts`. Add these methods to `VaultNoteStore` after `restore`:

```ts
  rename(id: string, newTitle: string, expectedRevision: number, meta: VaultWriteMeta): { note: VaultNote; rewrittenNotes: number; rewrittenLinks: number } {
    return this.database.transaction(() => {
      const current = this.requireRevision(id, expectedRevision);
      const title = validateVaultTitle(newTitle);
      const owner = this.findIdByTitleKey(vaultKey(title));
      if (owner !== null && owner !== id) throw new VaultTitleTakenError(title);
      let rewrittenNotes = 0;
      let rewrittenLinks = 0;
      const inbound = z.array(z.object({ from_note_id: z.string() })).parse(this.database.prepare(
        'SELECT DISTINCT from_note_id FROM vault_links WHERE target_key = ? AND from_note_id <> ?',
      ).all(vaultKey(current.title), id));
      for (const { from_note_id: fromId } of inbound) {
        const source = this.require(fromId);
        const rewritten = rewriteLinks(source.body, current.title, title);
        if (rewritten.count === 0) continue;
        this.persist(source, { ...source, body: rewritten.body }, {
          actor: meta.actor, summary: `Link updated: ${current.title} → ${title}`, sourceRef: id,
        });
        rewrittenNotes += 1;
        rewrittenLinks += rewritten.count;
      }
      const note = this.persist(current, {
        ...current, title, aliases: uniqueKeyed([current.title, ...current.aliases], title),
      }, meta);
      return { note, rewrittenNotes, rewrittenLinks };
    })();
  }

  delete(id: string, expectedRevision: number): void {
    this.database.transaction(() => {
      this.requireRevision(id, expectedRevision);
      for (const [table, column] of [['vault_links', 'from_note_id'], ['vault_aliases', 'note_id'], ['vault_tags', 'note_id'],
        ['vault_notes_fts', 'note_id'], ['vault_note_revisions', 'note_id'], ['vault_notes', 'id']] as const) {
        this.database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
      }
    })();
  }
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-rename`
Expected: PASS (3 tests).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 8: Link graph and note queries

**Files:**
- Create: `src/vault/link-graph.ts`
- Create: `src/vault/note-queries.ts`
- Test: `tests/vault-note-queries.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-note-queries.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { VaultNotFoundError } from '../src/vault/errors.ts';
import { loadLinkGraph } from '../src/vault/link-graph.ts';
import { VaultNoteQueries } from '../src/vault/note-queries.ts';
import type { VaultNoteStore } from '../src/vault/note-store.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

function seed(store: VaultNoteStore) {
  const me = store.create(entityInput('Denys', 'This is you.\n\n**Uses** [[VS Code]] · [[Git]]\n\n> [!unverified]- 1 unverified fact\n> - **Owns** [[PC]] #unverified', { folder: '', types: ['person'], tags: ['me'] }), TEST_META);
  const vscode = store.create(entityInput('Visual Studio Code', 'Editor.\n\n**Depends on** [[Git]] · [[Nowhere]]', { aliases: ['VS Code'] }), TEST_META);
  const git = store.create(entityInput('Git', 'Git is a tool.'), TEST_META);
  const day = store.create(entityInput('2026-10-24', 'Mostly in [[VS Code]].', { kind: 'daily', folder: 'Daily', types: [] }), TEST_META);
  const capture = store.create(entityInput('2026-10-24 16.42 Visual Studio Code', 'x', { kind: 'capture', folder: 'Captures/2026-10-24', types: [] }), TEST_META);
  return { me, vscode, git, day, capture };
}

test('loadLinkGraph resolves aliases and builds undirected degree without self links', () => withVault(({ store, database }) => {
  const { me, vscode, git } = seed(store);
  const graph = loadLinkGraph(database);
  assert.equal(graph.resolve('vs code'), vscode.id);
  assert.equal(graph.resolve('nowhere'), null);
  assert.equal(graph.degree(git.id), 2);
  assert.equal(graph.degree(vscode.id), 3);
  assert.deepEqual([...(graph.neighbors.get(me.id) ?? [])].sort(), [git.id, vscode.id].sort());
}));

test('folders lists every folder path with cumulative counts, optionally hiding stubs', () => withVault(({ store, database }) => {
  seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.folders({ includeStubs: true }), [
    { path: 'Captures', name: 'Captures', depth: 0, count: 1 },
    { path: 'Captures/2026-10-24', name: '2026-10-24', depth: 1, count: 1 },
    { path: 'Daily', name: 'Daily', depth: 0, count: 1 },
    { path: 'Software', name: 'Software', depth: 0, count: 2 },
  ]);
  assert.equal(queries.folders({ includeStubs: false }).find((folder) => folder.path === 'Software')?.count, 1);
}));

test('folderNotes returns direct children ordered by degree, dated folders newest first', () => withVault(({ store, database }) => {
  const { vscode, git } = seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.folderNotes('Software', { includeStubs: true, limit: 50 }).map((note) => note.id), [vscode.id, git.id]);
  assert.deepEqual(queries.folderNotes('Software', { includeStubs: false, limit: 50 }).map((note) => note.id), [vscode.id]);
  assert.deepEqual(queries.folderNotes('', { includeStubs: true, limit: 50 }).map((note) => note.title), ['Denys']);
}));

test('backlinks group by source note with row labels; outgoing splits resolved and unresolved', () => withVault(({ store, database }) => {
  const { me, vscode, day } = seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.backlinks(vscode.id).map((link) => [link.note.id, link.labels]), [[me.id, ['Uses']], [day.id, []]]);
  const outgoing = queries.outgoing(vscode.id);
  assert.deepEqual(outgoing.resolved.map((note) => note.title), ['Git']);
  assert.deepEqual(outgoing.unresolved, ['nowhere']);
}));

test('review lists unverified facts; stats counts notes, links, tags and stubs', () => withVault(({ store, database }) => {
  const { me } = seed(store);
  const queries = new VaultNoteQueries(database);
  assert.deepEqual(queries.review(100), { total: 1, items: [{ note: { id: me.id, title: 'Denys', folder: '', kind: 'entity', isStub: false, updatedAtUtc: me.updatedAtUtc }, line: 5, label: 'Owns', value: '[[PC]]' }] });
  assert.deepEqual(queries.stats(), { notes: 5, links: 6, tags: 2, stubs: 1, notesWithUnverified: 1, byKind: { entity: 3, capture: 1, daily: 1, chat: 0, note: 0 } });
}));

test('backlinks and outgoing for an unknown note throw not-found', () => withVault(({ database }) => {
  const queries = new VaultNoteQueries(database);
  assert.throws(() => queries.backlinks('vnote_404'), VaultNotFoundError);
  assert.throws(() => queries.outgoing('vnote_404'), VaultNotFoundError);
}));
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-note-queries`
Expected: FAIL. Module `src/vault/link-graph.ts` not found.

- [x] **Step 3: Write the implementation**

```ts
// src/vault/link-graph.ts
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';

const NoteKeyRowsSchema = z.array(z.object({ id: z.string(), title_key: z.string() }));
const AliasRowsSchema = z.array(z.object({ alias_key: z.string(), note_id: z.string() }));
const LinkRowsSchema = z.array(z.object({ from_note_id: z.string(), target_key: z.string() }));

export interface VaultLinkGraph {
  resolve(targetKey: string): string | null;
  readonly neighbors: ReadonlyMap<string, ReadonlySet<string>>;
  degree(noteId: string): number;
}

/** Resolves every link (title first, then the oldest alias owner) and builds undirected adjacency. */
export function loadLinkGraph(database: RuntimeDatabase): VaultLinkGraph {
  const byKey = new Map<string, string>();
  for (const row of NoteKeyRowsSchema.parse(database.prepare('SELECT id, title_key FROM vault_notes').all())) byKey.set(row.title_key, row.id);
  for (const row of AliasRowsSchema.parse(database.prepare('SELECT alias_key, note_id FROM vault_aliases ORDER BY note_id').all())) {
    if (!byKey.has(row.alias_key)) byKey.set(row.alias_key, row.note_id);
  }
  const neighbors = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (!neighbors.has(left)) neighbors.set(left, new Set());
    neighbors.get(left)?.add(right);
  };
  for (const link of LinkRowsSchema.parse(database.prepare('SELECT from_note_id, target_key FROM vault_links').all())) {
    const target = byKey.get(link.target_key);
    if (target === undefined || target === link.from_note_id) continue;
    connect(link.from_note_id, target);
    connect(target, link.from_note_id);
  }
  return {
    resolve: (targetKey) => byKey.get(targetKey) ?? null,
    neighbors,
    degree: (noteId) => neighbors.get(noteId)?.size ?? 0,
  };
}
```

```ts
// src/vault/note-queries.ts
import {
  parseNoteBody, VaultNoteKindSchema,
  type VaultBacklink, type VaultFolder, type VaultNoteSummary, type VaultOutgoing, type VaultReview, type VaultStats,
} from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { VaultNotFoundError } from './errors.ts';
import { loadLinkGraph } from './link-graph.ts';
import { VaultNoteRowSchema, toVaultNote, toVaultNoteSummary } from './note-rows.ts';

const SummaryRowsSchema = z.array(VaultNoteRowSchema.pick({ id: true, title: true, folder: true, kind: true, is_stub: true, updated_at_utc: true }));
const CountSchema = z.object({ count: z.number() });
/** Folders whose children are dates, so newest-first beats most-linked-first. */
const DATED_FOLDER = /^(Daily|Captures)(\/|$)/;

function toSummary(row: z.infer<typeof SummaryRowsSchema>[number]): VaultNoteSummary {
  return { id: row.id, title: row.title, folder: row.folder, kind: row.kind, isStub: row.is_stub === 1, updatedAtUtc: row.updated_at_utc };
}

export class VaultNoteQueries {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  folders(options: { readonly includeStubs: boolean }): VaultFolder[] {
    const rows = z.array(z.object({ folder: z.string(), count: z.number() })).parse(this.database.prepare(
      `SELECT folder, COUNT(*) AS count FROM vault_notes WHERE folder <> '' ${options.includeStubs ? '' : 'AND is_stub = 0'} GROUP BY folder`,
    ).all());
    const counts = new Map<string, number>();
    for (const row of rows) {
      const parts = row.folder.split('/');
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const path = parts.slice(0, depth).join('/');
        counts.set(path, (counts.get(path) ?? 0) + row.count);
      }
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, count]) => {
      const parts = path.split('/');
      return { path, name: parts.at(-1) ?? path, depth: parts.length - 1, count };
    });
  }

  folderNotes(folder: string, options: { readonly includeStubs: boolean; readonly limit: number }): VaultNoteSummary[] {
    const rows = SummaryRowsSchema.parse(this.database.prepare(
      `SELECT id, title, folder, kind, is_stub, updated_at_utc FROM vault_notes WHERE folder = ? ${options.includeStubs ? '' : 'AND is_stub = 0'}`,
    ).all(folder)).map(toSummary);
    const graph = loadLinkGraph(this.database);
    const ordered = DATED_FOLDER.test(folder)
      ? rows.sort((left, right) => right.title.localeCompare(left.title))
      : rows.sort((left, right) => graph.degree(right.id) - graph.degree(left.id) || left.title.localeCompare(right.title));
    return ordered.slice(0, options.limit);
  }

  backlinks(noteId: string): VaultBacklink[] {
    const graph = loadLinkGraph(this.database);
    const note = this.requireRow(noteId);
    const keys = [note.title, ...note.aliases].map((value) => value.trim().toLowerCase()).filter((key) => graph.resolve(key) === noteId);
    const placeholders = keys.map(() => '?').join(', ');
    const rows = z.array(z.object({ from_note_id: z.string(), row_label: z.string().nullable() })).parse(this.database.prepare(
      `SELECT from_note_id, row_label FROM vault_links WHERE target_key IN (${placeholders}) AND from_note_id <> ? ORDER BY line`,
    ).all(...keys, noteId));
    const labels = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!labels.has(row.from_note_id)) labels.set(row.from_note_id, new Set());
      if (row.row_label !== null) labels.get(row.from_note_id)?.add(row.row_label);
    }
    return [...labels.entries()].map(([fromId, set]) => ({ note: toVaultNoteSummary(this.requireRow(fromId)), labels: [...set] }))
      .sort((left, right) => right.labels.length - left.labels.length || left.note.title.localeCompare(right.note.title));
  }

  outgoing(noteId: string): VaultOutgoing {
    this.requireRow(noteId);
    const graph = loadLinkGraph(this.database);
    const targets = z.array(z.object({ target_key: z.string() })).parse(this.database.prepare(
      'SELECT target_key FROM vault_links WHERE from_note_id = ? GROUP BY target_key ORDER BY MIN(line)',
    ).all(noteId));
    const resolved = new Map<string, VaultNoteSummary>();
    const unresolved: string[] = [];
    for (const { target_key: key } of targets) {
      const id = graph.resolve(key);
      if (id === null) unresolved.push(key);
      else if (id !== noteId && !resolved.has(id)) resolved.set(id, toVaultNoteSummary(this.requireRow(id)));
    }
    return { resolved: [...resolved.values()], unresolved };
  }

  review(limit: number): VaultReview {
    const rows = z.array(VaultNoteRowSchema).parse(this.database.prepare(
      "SELECT * FROM vault_notes WHERE body LIKE '%#unverified%' ORDER BY title_key",
    ).all()).map(toVaultNote);
    const items = rows.flatMap((note) => parseNoteBody(note.body).unverified.map((fact) => ({
      note: toVaultNoteSummary(note), line: fact.line, label: fact.label, value: fact.value,
    })));
    return { total: items.length, items: items.slice(0, limit) };
  }

  stats(): VaultStats {
    const count = (sql: string) => CountSchema.parse(this.database.prepare(sql).get()).count;
    const byKind: VaultStats['byKind'] = { entity: 0, capture: 0, daily: 0, chat: 0, note: 0 };
    for (const row of z.array(z.object({ kind: VaultNoteKindSchema, count: z.number() })).parse(
      this.database.prepare('SELECT kind, COUNT(*) AS count FROM vault_notes GROUP BY kind').all(),
    )) byKind[row.kind] = row.count;
    return {
      notes: count('SELECT COUNT(*) AS count FROM vault_notes'),
      links: count('SELECT COUNT(*) AS count FROM vault_links'),
      tags: count('SELECT COUNT(DISTINCT tag) AS count FROM vault_tags'),
      stubs: count('SELECT COUNT(*) AS count FROM vault_notes WHERE is_stub = 1'),
      notesWithUnverified: count("SELECT COUNT(*) AS count FROM vault_notes WHERE body LIKE '%#unverified%'"),
      byKind,
    };
  }

  /** Phase 2 maps VaultNotFoundError to 404. */
  private requireRow(id: string) {
    const row = this.database.prepare('SELECT * FROM vault_notes WHERE id = ?').get(id);
    if (row === undefined) throw new VaultNotFoundError(id);
    return toVaultNote(VaultNoteRowSchema.parse(row));
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-note-queries`
Expected: PASS (6 tests).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 9: Vault search

**Files:**
- Create: `src/vault/vault-search.ts`
- Test: `tests/vault-search.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-search.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { VaultNoteStore } from '../src/vault/note-store.ts';
import { VaultSearch } from '../src/vault/vault-search.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

function seed(store: VaultNoteStore) {
  store.create(entityInput('Visual Studio Code', 'Editor with **dark** theme.\n\n**Uses** [[Git]]', { aliases: ['VS Code'], tags: ['editor'] }), TEST_META);
  store.create(entityInput('Code Review', 'Reviewing pull requests.', { folder: 'Topics', types: ['topic'] }), TEST_META);
  store.create(entityInput('Git', 'Version control. Used from Visual Studio Code daily.'), TEST_META);
  store.create(entityInput('2026-10-24', 'Mostly in [[Visual Studio Code]].', { kind: 'daily', folder: 'Daily', types: [] }), TEST_META);
}

test('search ranks title prefix, then title contains, then body hits, with snippets', () => withVault(({ store, database }) => {
  seed(store);
  const result = new VaultSearch(database).search('code', 50);
  assert.deepEqual(result.hits.map((hit) => [hit.note.title, hit.snippet]), [
    ['Code Review', null],
    ['Visual Studio Code', null],
    ['2026-10-24', 'Mostly in [[Visual Studio Code]].'],
    ['Git', 'Version control. Used from Visual Studio Code daily.'],
  ]);
  assert.equal(result.total, 4);
}));

test('search matches aliases and reports them as the snippet', () => withVault(({ store, database }) => {
  seed(store);
  const hit = new VaultSearch(database).search('vs code', 50).hits[0];
  assert.deepEqual([hit?.note.title, hit?.snippet], ['Visual Studio Code', 'alias: VS Code']);
}));

test('tag:, path: and type: filters narrow results and work without a text query', () => withVault(({ store, database }) => {
  seed(store);
  const search = new VaultSearch(database);
  assert.deepEqual(search.search('tag:#editor', 50).hits.map((hit) => hit.note.title), ['Visual Studio Code']);
  assert.deepEqual(search.search('path:daily', 50).hits.map((hit) => hit.note.title), ['2026-10-24']);
  assert.deepEqual(search.search('type:topic code', 50).hits.map((hit) => hit.note.title), ['Code Review']);
}));

test('search caps hits at the limit but reports the full total; punctuation is safe', () => withVault(({ store, database }) => {
  seed(store);
  const result = new VaultSearch(database).search('code', 2);
  assert.deepEqual([result.total, result.hits.length], [4, 2]);
  assert.deepEqual(new VaultSearch(database).search('"; DROP --', 10), { total: 0, hits: [] });
  assert.deepEqual(new VaultSearch(database).search('   ', 10).total, 4);
}));
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-search`
Expected: FAIL. Module `src/vault/vault-search.ts` not found.

- [x] **Step 3: Write the implementation**

```ts
// src/vault/vault-search.ts
import type { VaultNote, VaultSearchResult } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { loadLinkGraph } from './link-graph.ts';
import { VaultNoteRowSchema, toVaultNote, toVaultNoteSummary } from './note-rows.ts';

const FILTER_PATTERN = /\b(tag|path|type):(\S*)/g;

interface ParsedQuery {
  readonly text: string;
  readonly filters: readonly { readonly kind: string; readonly value: string }[];
}

function parseQuery(query: string): ParsedQuery {
  const filters: { kind: string; value: string }[] = [];
  const text = query.replace(FILTER_PATTERN, (_match: string, kind: string, value: string) => {
    filters.push({ kind, value: value.replace(/^#/, '').toLowerCase() });
    return '';
  }).trim().toLowerCase();
  return { text, filters };
}

function snippetFor(note: VaultNote, text: string): string | null {
  const line = note.body.split('\n').find((candidate) => candidate.toLowerCase().includes(text));
  return line === undefined ? null : line.replace(/^[-#>*\s]+/, '').trim();
}

export class VaultSearch {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  search(query: string, limit: number): VaultSearchResult {
    const { text, filters } = parseQuery(query);
    const notes = z.array(VaultNoteRowSchema).parse(this.database.prepare('SELECT * FROM vault_notes').all()).map(toVaultNote);
    const tagged = new Map<string, Set<string>>();
    for (const row of z.array(z.object({ note_id: z.string(), tag: z.string() })).parse(this.database.prepare('SELECT note_id, tag FROM vault_tags').all())) {
      if (!tagged.has(row.tag)) tagged.set(row.tag, new Set());
      tagged.get(row.tag)?.add(row.note_id);
    }
    const passes = (note: VaultNote) => filters.every((filter) => {
      if (filter.kind === 'tag') return tagged.get(filter.value)?.has(note.id) ?? false;
      if (filter.kind === 'path') return note.folder.toLowerCase().startsWith(filter.value);
      return note.types.some((type) => type.toLowerCase().includes(filter.value));
    });
    const graph = loadLinkGraph(this.database);
    const hits = notes.filter(passes).flatMap((note) => {
      if (text.length === 0) return [{ note: toVaultNoteSummary(note), score: 1, snippet: null }];
      const title = note.title.toLowerCase();
      const alias = note.aliases.find((candidate) => candidate.toLowerCase().includes(text));
      const titleScore = title === text ? 100 : title.startsWith(text) ? 60 : title.includes(text) ? 40 : alias ? 30 : 0;
      const bodySnippet = titleScore === 0 ? snippetFor(note, text) : null;
      const score = titleScore + (note.body.toLowerCase().includes(text) ? 10 : 0);
      if (titleScore === 0 && bodySnippet === null) return [];
      const snippet = alias && titleScore === 30 ? `alias: ${alias}` : bodySnippet;
      return [{ note: toVaultNoteSummary(note), score: score + Math.min(5, graph.degree(note.id) / 20), snippet }];
    }).sort((left, right) => right.score - left.score || left.note.title.localeCompare(right.note.title));
    return { total: hits.length, hits: hits.slice(0, limit) };
  }
}
```

> Search runs over every note in memory. That covers the ~3k-note vault in milliseconds and avoids FTS query-syntax escaping. `vault_notes_fts` stays for the Phase 4 retriever, which needs ranked term matching. If the vault grows past ~50k notes, move the text pass onto FTS.

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-search`
Expected: PASS (4 tests).

- [x] **Step 5: Checkpoint**

Run: `npm run typecheck` and `npm run lint`. Expected: both exit 0.

---

### Task 10: Vault graph

**Files:**
- Create: `src/vault/vault-graph.ts`
- Test: `tests/vault-graph.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// tests/vault-graph.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import type { VaultNoteStore } from '../src/vault/note-store.ts';
import { VaultGraphQueries } from '../src/vault/vault-graph.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

function seedChain(store: VaultNoteStore) {
  // a — b — c — d, plus a capture linking to b, plus an isolated note
  store.create(entityInput('A', '**Uses** [[B]]'), TEST_META);
  store.create(entityInput('B', '**Uses** [[C]] · [[A]]'), TEST_META);
  store.create(entityInput('C', '**Uses** [[D]]'), TEST_META);
  store.create(entityInput('D', 'End.'), TEST_META);
  store.create(entityInput('Cap', '[[B]]', { kind: 'capture', folder: 'Captures/2026-10-24', types: [] }), TEST_META);
  store.create(entityInput('Lonely', 'Alone.', { folder: 'Topics' }), TEST_META);
}

test('global graph filters by hidden top folders and minimum links, with deduplicated edges', () => withVault(({ store, database }) => {
  seedChain(store);
  const graph = new VaultGraphQueries(database).global({ minLinks: 1, hiddenTopFolders: ['Captures'] });
  assert.deepEqual(graph.nodes.map((node) => [node.title, node.topFolder, node.degree]), [
    ['A', 'Software', 1], ['B', 'Software', 3], ['C', 'Software', 2], ['D', 'Software', 1],
  ]);
  assert.equal(graph.edges.length, 3);
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  assert.deepEqual(graph.edges.map((edge) => [titles.get(edge.source), titles.get(edge.target)].sort().join('-')).sort(), ['A-B', 'B-C', 'C-D']);
  assert.equal(new VaultGraphQueries(database).global({ minLinks: 0, hiddenTopFolders: [] }).nodes.length, 6);
}));

test('local graph walks one or two hops and caps the node count', () => withVault(({ store, database }) => {
  seedChain(store);
  const queries = new VaultGraphQueries(database);
  const a = store.resolve('A');
  assert.ok(a);
  assert.deepEqual(queries.local(a.id, 1, 160).nodes.map((node) => node.title).sort(), ['A', 'B']);
  assert.deepEqual(queries.local(a.id, 2, 160).nodes.map((node) => node.title).sort(), ['A', 'B', 'C', 'Cap']);
  assert.equal(queries.local(a.id, 2, 2).nodes.length, 2);
}));
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts vault-graph`
Expected: FAIL. Module `src/vault/vault-graph.ts` not found.

- [x] **Step 3: Write the implementation**

```ts
// src/vault/vault-graph.ts
import type { VaultGraph, VaultGraphNode } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { z } from '../lib/zod.ts';
import { loadLinkGraph, type VaultLinkGraph } from './link-graph.ts';
import { VaultNoteRowSchema } from './note-rows.ts';

const GraphRowsSchema = z.array(VaultNoteRowSchema.pick({ id: true, title: true, folder: true, kind: true }));

export class VaultGraphQueries {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  global(options: { readonly minLinks: number; readonly hiddenTopFolders: readonly string[] }): VaultGraph {
    const links = loadLinkGraph(this.database);
    const hidden = new Set(options.hiddenTopFolders);
    const nodes = this.allNodes(links).filter((node) => !hidden.has(node.topFolder) && node.degree >= options.minLinks);
    return { nodes, edges: edgesAmong(nodes, links) };
  }

  local(noteId: string, depth: 1 | 2, cap: number): VaultGraph {
    const links = loadLinkGraph(this.database);
    const included = new Set([noteId]);
    let frontier = [noteId];
    for (let hop = 0; hop < depth; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of [...(links.neighbors.get(id) ?? [])].sort()) {
          if (included.size >= cap) break;
          if (!included.has(neighbor)) {
            included.add(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    const nodes = this.allNodes(links).filter((node) => included.has(node.id));
    return { nodes, edges: edgesAmong(nodes, links) };
  }

  private allNodes(links: VaultLinkGraph): VaultGraphNode[] {
    return GraphRowsSchema.parse(this.database.prepare('SELECT id, title, folder, kind FROM vault_notes ORDER BY title_key').all())
      .map((row) => ({ id: row.id, title: row.title, folder: row.folder, topFolder: row.folder.split('/')[0] ?? '', kind: row.kind, degree: links.degree(row.id) }));
  }
}

function edgesAmong(nodes: readonly VaultGraphNode[], links: VaultLinkGraph): VaultGraph['edges'] {
  const ids = new Set(nodes.map((node) => node.id));
  const edges: VaultGraph['edges'] = [];
  for (const node of nodes) {
    for (const neighbor of links.neighbors.get(node.id) ?? []) {
      if (ids.has(neighbor) && node.id < neighbor) edges.push({ source: node.id, target: neighbor });
    }
  }
  return edges;
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node .\src\test-runner\run-tests.ts vault-graph`
Expected: PASS (2 tests).

- [x] **Step 5: Phase checkpoint**

Run, in order:
- `npm run typecheck`, expect exit 0;
- `npm run lint`, expect exit 0;
- `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and file:line anchors."`, expect all passing. The new `vault-*` files run in the default node suite.

---

## Self-review notes

- **Spec coverage, Phase 1:**
  - §2 dialect: Tasks 1–3.
  - §3 tables, concurrency, rename and restore: Tasks 4–7.
  - §4.1 shared module, every listed function: Tasks 1–3.
  - §4.2 `note-store`, `note-queries`, `vault-search`, `vault-graph`: Tasks 5–10.
  - Attachments, captures, export, owner identity, note-writer, retriever and HTTP belong to later phase plans.
- **Type consistency:** `VaultNoteStore.{create, get, require, resolve, update, rename, delete, listRevisions, getRevision, restore}`, `VaultNoteQueries.{folders, folderNotes, backlinks, outgoing, review, stats}`, `VaultSearch.search` and `VaultGraphQueries.{global, local}` are the names Phase 2 routes will call.
