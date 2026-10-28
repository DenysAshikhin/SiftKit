# Vault Note-Writer Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three single-shot vault writers with one tool-using note-writer agent, condense the deterministic jobs into one maintenance job, and add per-note/per-fact timestamps with an indexed validation queue feeding a review pass.

**Architecture:** One `vault_write` job type (sources `capture | chat | review`) runs `VaultNoteWriter`, which drives the shared `AgentLoop` through a `VaultWriterSession`. The session holds the message history and implements all four loop adapters. The model explores the vault with read-only tools and finishes with `submit_edits`, which the existing `VaultEditApplier` (plus new guards) commits in one transaction. One `vault_maintenance` job runs retention, the pending daily rollups from `vault_rollup_days`, and enqueues a review batch from `VaultValidationQueue`. `vault_fact_points` is kept in step by `VaultNoteStore.reindex`.

**Tech Stack:** Node 26 native TS, better-sqlite3, zod (`src/lib/zod.ts`), `node:test` runner (`node ./src/test-runner/run-tests.ts <substr>`), Vitest for the dashboard (`npx vitest run --config dashboard/vitest.config.ts <file>`), React dashboard.

**Spec:** `docs/superpowers/specs/2026-10-27-vault-note-writer-agent-design.md`

---

## Ground rules (apply to every task)

- **Do not commit.** The user commits. Every "Commit" step from the template is replaced by "Leave uncommitted".
- TDD: write the failing test, run it and see it fail, implement, run it and see it pass.
- Forbidden: `any`, explicit `unknown` (lint-banned; use `toError(error)` from `src/lib/errors.ts` or `instanceof Error`), `as` casts (except `as const`), `!` non-null assertions, namespace imports. Parse IO with zod and derive types with `z.infer`.
- Comments are 1–2 lines.
- Refactors are complete replacements: delete obsolete code, tests and exports. No shims.
- Several files already carry **unrelated uncommitted edits** (`packages/contracts/src/config.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`, `dashboard/tests/fixtures.ts`, `tests/config-normalization.test.ts` and others in `git status`). Edit only the lines named here; never revert or reformat other hunks.
- Scratch files go in `.siftkit/tmp/` and are deleted at the end.
- **Public repo:** never write personal vault data into tracked files. Live-validation output stays in `.siftkit/tmp/`.

## Deliberate refinements of the spec (call out to the user at handoff)

1. **Validation queue eligibility.** `nextBatch` only takes entity notes never validated or validated more than 30 days ago, the same rule as the queue depth (§4.5). Without it, a small vault that is fully validated would be re-reviewed on every drain.
2. **Live-review exclusion** comes from the trigger, not a parameter. At most one review job is ever live: its key is `vault_write:review`, and maintenance enqueues only when no `vault_write` is queued. The test asserts that maintenance never creates a second review while one is live.
3. **Queue stats are shown in the vault Review panel**, next to the unverified count, which already loads `VaultStats`. The Settings view does not fetch vault stats today.
4. **Fact values are the visible fact rows** (`parseNoteBody(body).factRows`). Values that overflowed into a `[!more]` callout are not tracked as fact points.

---

## File map

**Create**
- `src/vault/fact-points.ts`: fact-point sync, access and validated stamps, the age text.
- `src/vault/validation-queue.ts`: `VaultValidationQueue` (`nextBatch`, `staleFacts`, `depth`).
- `src/vault/triage.ts`: server-side Keep/Drop of an unverified item.
- `src/vault/maintenance.ts`: `VaultMaintenance`.
- `src/state/schema-upgrades/vault-validation.ts`: upgrade 87 → 88.
- `src/vault/note-writer/chat-turn.ts`: `VaultChatTurnSchema` (moved out of `chat-writer.ts`).
- `src/vault/note-writer/agent/writer-job.ts`: `VaultWriterJobSchema`.
- `src/vault/note-writer/agent/tools.ts`: `VaultWriterTools`, the read-only tools.
- `src/vault/note-writer/agent/definitions.ts`: the tool definitions and `submit_edits`.
- `src/vault/note-writer/agent/cards.ts`: the seeded first-message builders.
- `src/vault/note-writer/agent/prompt.ts`: the instructions.
- `src/vault/note-writer/agent/session.ts`: `VaultWriterSession`, the AgentLoop adapters.
- `src/vault/note-writer/agent/note-writer.ts`: `VaultNoteWriter`.
- Tests: `tests/vault-fact-points.test.ts`, `tests/vault-validation-queue.test.ts`, `tests/vault-triage.test.ts`, `tests/vault-maintenance.test.ts`, `tests/vault-writer-tools.test.ts`, `tests/vault-writer-session.test.ts`, `tests/vault-note-writer.test.ts`, `tests/vault-validation-upgrade.test.ts`.

**Modify**
- `packages/contracts/src/vault-markdown.ts`, `packages/contracts/src/vault-body.ts`, `packages/contracts/src/vault.ts`
- `src/vault/vault-schema.ts`, `src/vault/note-store.ts`, `src/vault/vault-retriever.ts`, `src/vault/note-queries.ts`
- `src/vault/note-writer/edit-ops.ts`, `src/vault/note-writer/edit-applier.ts`, `src/vault/note-writer/rejections.ts`
- `src/agent-loop/types.ts` (`AgentLoopKind`)
- `src/assistant/inference/client.ts`, `src/assistant/inference/roles.ts`
- `src/assistant/jobs/job-types.ts`, `src/assistant/storage/job-store.ts`, `src/assistant/jobs/job-runner.ts`, `src/assistant/assistant-service.ts`
- `src/state/runtime-db.ts`, `src/status-server/routes/assistant.ts`, `src/status-server/routes/assistant/vault-routes.ts`, `src/status-server/chat-memory-seam.ts`
- `packages/contracts/src/config.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`
- `dashboard/src/tabs/settings/AssistantSettings.tsx`, `dashboard/src/vault-api.ts`, `dashboard/src/hooks/useVaultController.ts`, `dashboard/src/components/vault/vault-actions.ts`, `dashboard/src/components/vault/VaultPanels.tsx`
- `scripts/assistant-bench/seed.ts` (only if it breaks)
- `docs/mockups/vault/note-writer-flow.html`, `docs/superpowers/specs/2026-10-24-memory-vault-design.md`

**Delete**
- `src/vault/note-writer/capture-writer.ts`, `src/vault/note-writer/chat-writer.ts`, `src/vault/note-writer/tidy-pass.ts`, `src/vault/note-writer/candidates.ts`
- `src/assistant/inference/structured-runner.ts`
- `tests/vault-capture-writer.test.ts`, `tests/vault-chat-writer.test.ts`, `tests/vault-tidy-pass.test.ts`

---

### Task 1: Unverified flags and row-value helpers (contracts)

**Files:**
- Modify: `packages/contracts/src/vault.ts`, `packages/contracts/src/vault-markdown.ts`, `packages/contracts/src/vault-body.ts`
- Test: `tests/vault-markdown.test.ts`, `tests/vault-body-edits.test.ts`

- [ ] **Step 1: Write the failing tests.** Append the parser test to `tests/vault-markdown.test.ts`:

```ts
test('unverified items carry their flag: a conflict names the value it replaces, a doubt its reason', () => {
  const parsed = parseNoteBody([
    'Lead.',
    '',
    '> [!unverified]- 3 unverified facts',
    '> - **Editor** Helix #unverified (replaces: Neovim)',
    '> - **Hobby** flying by flapping hands #unverified (doubt: implausible: humans cannot fly)',
    '> - **Uses** Git #unverified',
  ].join('\n'));
  assert.deepEqual(parsed.unverified.map(({ label, value, flag }) => ({ label, value, flag })), [
    { label: 'Editor', value: 'Helix', flag: { kind: 'replaces', value: 'Neovim' } },
    { label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible: humans cannot fly' } },
    { label: 'Uses', value: 'Git', flag: null },
  ]);
});
```

Append to `tests/vault-body-edits.test.ts` (replace the `confirmUnverified` and `dropLine` imports with `addUnverified, findRowValue, resolveUnverified`, and delete the old `confirmUnverified`/`dropLine` tests. Their behaviour is covered by the plain-flag cases below):

```ts
const FLAGGED = [
  'Denys builds tools.',
  '',
  '**Editor** [[Neovim]] · Vim',
  '**Hobby** flying by flapping hands · chess',
].join('\n');

test('addUnverified writes a conflict or doubt flag, and a doubt may name a value the row already holds', () => {
  const body = addUnverified(FLAGGED, [
    { label: 'Editor', value: 'Helix', flag: { kind: 'replaces', value: 'Neovim' } },
    { label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible' } },
  ]);
  assert.match(body, /^> - \*\*Editor\*\* Helix #unverified \(replaces: Neovim\)$/m);
  assert.match(body, /^> - \*\*Hobby\*\* flying by flapping hands #unverified \(doubt: implausible\)$/m);
  assert.match(body, /^> \[!unverified\]- 2 unverified facts$/m);
});

test('Keep on a conflict replaces the old value in its row; Drop only removes the flag', () => {
  const flagged = addUnverified(FLAGGED, [{ label: 'Editor', value: 'Helix', flag: { kind: 'replaces', value: 'Neovim' } }]);
  const line = flagged.split('\n').findIndex((candidate) => candidate.includes('#unverified'));
  const kept = resolveUnverified(flagged, line, 'confirm');
  assert.match(kept.body, /^\*\*Editor\*\* Helix · Vim$/m);
  assert.doesNotMatch(kept.body, /#unverified/);
  assert.equal(kept.validated, null);
  assert.equal(resolveUnverified(flagged, line, 'drop').body, FLAGGED);
});

test('Keep on a doubt removes the flag and reports the value validated; Drop removes the flag and the value', () => {
  const flagged = addUnverified(FLAGGED, [{ label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible' } }]);
  const line = flagged.split('\n').findIndex((candidate) => candidate.includes('#unverified'));
  const kept = resolveUnverified(flagged, line, 'confirm');
  assert.equal(kept.body, FLAGGED);
  assert.deepEqual(kept.validated, { label: 'Hobby', value: 'flying by flapping hands' });
  const dropped = resolveUnverified(flagged, line, 'drop');
  assert.match(dropped.body, /^\*\*Hobby\*\* chess$/m);
  assert.equal(dropped.validated, null);
});

test('a plain unverified item still joins its row on Keep and disappears on Drop', () => {
  const flagged = addUnverified(FLAGGED, [{ label: 'Uses', value: 'Git', flag: null }]);
  const line = flagged.split('\n').findIndex((candidate) => candidate.includes('#unverified'));
  assert.match(resolveUnverified(flagged, line, 'confirm').body, /^\*\*Uses\*\* Git$/m);
  assert.equal(resolveUnverified(flagged, line, 'drop').body, FLAGGED);
  assert.throws(() => resolveUnverified(FLAGGED, 0, 'drop'), /not an unverified fact/);
});

test('findRowValue matches a linked value by its plain name, ignoring case, and returns it as stored', () => {
  assert.deepEqual(findRowValue(FLAGGED, 'editor', 'neovim'), { label: 'Editor', value: '[[Neovim]]' });
  assert.equal(findRowValue(FLAGGED, 'Editor', 'Helix'), null);
  assert.equal(findRowValue(FLAGGED, 'Missing', 'Vim'), null);
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**

Run: `node ./src/test-runner/run-tests.ts vault-markdown` and `node ./src/test-runner/run-tests.ts vault-body-edits`
Expected: FAIL. `flag` is undefined and `resolveUnverified` / `findRowValue` are not exported.

- [ ] **Step 3: Add the flag schema and triage action to `packages/contracts/src/vault.ts`.** Put this near `VaultReviewItemSchema` and add `flag` to the review item:

```ts
export const VaultUnverifiedFlagSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replaces'), value: z.string() }).strict(),
  z.object({ kind: z.literal('doubt'), reason: z.string() }).strict(),
]);
export type VaultUnverifiedFlag = z.infer<typeof VaultUnverifiedFlagSchema>;

export const VaultTriageActionSchema = z.enum(['confirm', 'drop']);
export type VaultTriageAction = z.infer<typeof VaultTriageActionSchema>;

export const VaultReviewItemSchema = z.object({
  note: VaultNoteSummarySchema,
  line: z.number().int().min(0),
  label: z.string().nullable(),
  value: z.string(),
  flag: VaultUnverifiedFlagSchema.nullable(),
}).strict();
```

- [ ] **Step 4: Parse the flag in `packages/contracts/src/vault-markdown.ts`.**

```ts
import type { VaultUnverifiedFlag } from './vault.ts';
// ...
const UNVERIFIED_PATTERN = new RegExp(String.raw`^>\s*[-*]\s+(.*?)\s*${UNVERIFIED_TAG}\b(?:\s*\((replaces|doubt):\s*(.+)\))?`);

export interface VaultUnverifiedFact {
  readonly label: string | null;
  readonly value: string;
  /** Set by the note-writer: the value a conflict replaces, or why a held value is doubted. */
  readonly flag: VaultUnverifiedFlag | null;
  readonly line: number;
}
```

In `parseNoteBody`, replace the unverified block with:

```ts
    const unverifiedMatch = line.match(UNVERIFIED_PATTERN);
    const fact = unverifiedMatch?.[1];
    if (fact !== undefined) {
      const flagText = unverifiedMatch?.[3]?.trim();
      const flag: VaultUnverifiedFlag | null = flagText === undefined ? null
        : unverifiedMatch?.[2] === 'replaces' ? { kind: 'replaces', value: flagText } : { kind: 'doubt', reason: flagText };
      const factRow = parseFactRow(fact);
      unverified.push(factRow
        ? { label: factRow.label, value: factRow.rest, flag, line: index }
        : { label: null, value: fact.trim(), flag, line: index });
    }
```

- [ ] **Step 5: Update `packages/contracts/src/vault-body.ts`.**

```ts
import type { VaultTriageAction, VaultUnverifiedFlag } from './vault.ts';
import { UNVERIFIED_TAG, VAULT_ROW_LIMIT, VAULT_VALUE_SEPARATOR, parseNoteBody, splitValues, type VaultFactRow } from './vault-markdown.ts';

export interface VaultUnverifiedDraft {
  readonly label: string;
  readonly value: string;
  readonly flag: VaultUnverifiedFlag | null;
}

const LONE_LINK = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/;
/** A value compared by its plain name, so `[[Neovim]]` and `neovim` are the same fact. */
const sameFactValue = (left: string, right: string): boolean =>
  sameVaultValue(left.match(LONE_LINK)?.[1] ?? left, right.match(LONE_LINK)?.[1] ?? right);

const flagSuffix = (flag: VaultUnverifiedFlag | null) =>
  (flag === null ? '' : flag.kind === 'replaces' ? ` (replaces: ${flag.value})` : ` (doubt: ${flag.reason})`);
const unverifiedLine = (fact: VaultUnverifiedDraft) => `> - **${fact.label}** ${fact.value} ${UNVERIFIED_TAG}${flagSuffix(fact.flag)}`;
```

Update the `buildEntityBody` call site to `draft.unverified.map(unverifiedLine)`.

Rewrite `addUnverified`'s filter. A doubt names a value the row already holds by design, so the "already in a row" skip applies only to unflagged facts:

```ts
  const fresh = facts.filter((fact) =>
    !parsed.unverified.some((existing) => sameVaultValue(existing.value, fact.value) && sameVaultValue(existing.label ?? '', fact.label))
    && !(fact.flag === null && parsed.factRows.some((row) => sameVaultValue(row.label, fact.label) && row.values.some((value) => sameVaultValue(value, fact.value)))));
  // ...
  const newLines = fresh.map(unverifiedLine);
```

Delete `confirmUnverified` and `dropLine` and add:

```ts
const findRow = (body: string, label: string): VaultFactRow | undefined =>
  parseNoteBody(body).factRows.find((row) => sameVaultValue(row.label, label));

/** Rewrites one fact row; a row left empty is removed. */
function writeRowValues(body: string, row: VaultFactRow, values: readonly string[]): string {
  const lines = body.split('\n');
  if (values.length === 0) lines.splice(row.line, 1);
  else lines[row.line] = rowLine(row.label, dedupeVaultValues(values));
  return normalizeVaultLines(lines);
}

/** The row's label and value as stored, when the row holds `value`; a link matches its plain name. */
export function findRowValue(body: string, label: string, value: string): { label: string; value: string } | null {
  const row = findRow(body, label);
  const stored = row?.values.find((candidate) => sameFactValue(candidate, value));
  return row === undefined || stored === undefined ? null : { label: row.label, value: stored };
}

export function removeRowValue(body: string, label: string, value: string): string {
  const row = findRow(body, label);
  return row === undefined ? body : writeRowValues(body, row, row.values.filter((candidate) => !sameFactValue(candidate, value)));
}

/** Swaps `oldValue` for `newValue` in the row; with no old value to swap, the new one is added. */
export function replaceRowValue(body: string, label: string, oldValue: string, newValue: string): string {
  const row = findRow(body, label);
  if (row === undefined || !row.values.some((candidate) => sameFactValue(candidate, oldValue))) return addRowValues(body, label, [newValue]);
  return writeRowValues(body, row, row.values.map((candidate) => (sameFactValue(candidate, oldValue) ? newValue : candidate)));
}

export interface VaultTriageResult {
  readonly body: string;
  /** The fact value Keep on a doubt confirmed; it is stamped validated. */
  readonly validated: { readonly label: string; readonly value: string } | null;
}

/** Keep or Drop one Review item (spec §3.3). */
export function resolveUnverified(body: string, line: number, action: VaultTriageAction): VaultTriageResult {
  const fact = parseNoteBody(body).unverified.find((candidate) => candidate.line === line);
  if (!fact) throw new Error(`Line ${line} is not an unverified fact.`);
  const label = fact.label ?? 'Facts';
  const rest = removeUnverifiedLine(body, line);
  if (fact.flag?.kind === 'doubt') {
    return action === 'confirm'
      ? { body: rest, validated: { label, value: fact.value } }
      : { body: removeRowValue(rest, label, fact.value), validated: null };
  }
  if (action === 'drop') return { body: rest, validated: null };
  return {
    body: fact.flag?.kind === 'replaces' ? replaceRowValue(rest, label, fact.flag.value, fact.value) : addRowValues(rest, label, [fact.value]),
    validated: null,
  };
}
```

Fix every other `addUnverified` / `VaultUnverifiedDraft` caller to pass `flag: null`. Find them with `Grep pattern="addUnverified\(|unverified: \[" path=src scripts packages tests`. In `VaultNoteQueries.review` (`src/vault/note-queries.ts`), add `flag: fact.flag` to each item.

- [ ] **Step 6: Run the tests and confirm they pass.**

Run: `node ./src/test-runner/run-tests.ts vault-markdown`, `node ./src/test-runner/run-tests.ts vault-body`, `node ./src/test-runner/run-tests.ts vault-note-queries`
Expected: PASS. `npm run typecheck` will still fail in `dashboard/src/hooks/useVaultController.ts`, which imports `confirmUnverified`/`dropLine`; Task 3 fixes that. Do not shim them.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 2: Timestamps, fact points and the 87 → 88 schema upgrade

**Files:**
- Create: `src/vault/fact-points.ts`, `src/state/schema-upgrades/vault-validation.ts`
- Modify: `src/vault/vault-schema.ts`, `src/vault/note-store.ts`, `src/state/runtime-db.ts`
- Test: `tests/vault-fact-points.test.ts`, `tests/vault-validation-upgrade.test.ts`, `tests/vault-job-upgrade.test.ts`

- [ ] **Step 1: Write the failing fact-point test** in `tests/vault-fact-points.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { FactPointRowSchema, factAges, touchAccess, validateFactPoint, stampValidated, factPointKey } from '../src/vault/fact-points.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

const points = (context: VaultTestContext, noteId: string) => z.array(FactPointRowSchema).parse(
  context.database.prepare('SELECT * FROM vault_fact_points WHERE note_id = ? ORDER BY label_key, value_key').all(noteId));

test('every note write keeps fact points in step: new values added, removed ones dropped, unchanged ones keep their times', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Neovim', 'Editor.\n\n**Uses** [[Lua]] · plugins'), TEST_META);
    const created = points(context, note.id);
    assert.deepEqual(created.map((row) => [row.label, row.value, row.added_at_utc]), [
      ['Uses', '[[Lua]]', context.clock.nowUtc()], ['Uses', 'plugins', context.clock.nowUtc()],
    ]);
    const addedAt = context.clock.nowUtc();
    context.clock.advanceDays(3);
    context.store.update(note.id, { body: 'Editor.\n\n**Uses** [[Lua]] · LSP' }, note.revision, TEST_META);
    const after = points(context, note.id);
    assert.deepEqual(after.map((row) => [row.value, row.added_at_utc, row.edited_at_utc]), [
      ['[[Lua]]', addedAt, addedAt], ['LSP', context.clock.nowUtc(), context.clock.nowUtc()],
    ]);
  });
});

test('deleting a note removes its fact points', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub'), TEST_META);
    context.store.delete(note.id, note.revision);
    assert.equal(points(context, note.id).length, 0);
  });
});

test('access stamps the note and only the listed values; validated skips flagged values', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub · GitLab'), TEST_META);
    context.clock.advanceDays(1);
    touchAccess(context.database, note.id, [factPointKey('Hosts', 'GitHub')], context.clock.nowUtc());
    assert.deepEqual(points(context, note.id).map((row) => row.last_accessed_at_utc), [context.clock.nowUtc(), null]);
    stampValidated(context.database, note.id, [factPointKey('Hosts', 'GitLab')], context.clock.nowUtc());
    assert.deepEqual(points(context, note.id).map((row) => row.validated_at_utc), [context.clock.nowUtc(), null]);
    validateFactPoint(context.database, note.id, factPointKey('hosts', 'gitlab'), context.clock.nowUtc());
    assert.deepEqual(points(context, note.id).map((row) => row.validated_at_utc), [context.clock.nowUtc(), context.clock.nowUtc()]);
    const noteRow = z.object({ last_accessed_at_utc: z.string().nullable(), validated_at_utc: z.string().nullable() })
      .parse(context.database.prepare('SELECT last_accessed_at_utc, validated_at_utc FROM vault_notes WHERE id = ?').get(note.id));
    assert.deepEqual(noteRow, { last_accessed_at_utc: context.clock.nowUtc(), validated_at_utc: context.clock.nowUtc() });
  });
});

test('factAges reads whole days and "never"', () => {
  const row = { added_at_utc: '2026-09-14T09:00:00.000Z', edited_at_utc: '2026-10-12T09:00:00.000Z', validated_at_utc: null };
  assert.equal(factAges(row, '2026-10-24T09:00:00.000Z'), 'added 40d · edited 12d · validated never');
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts vault-fact-points`. Expected: FAIL, the module is not found.

- [ ] **Step 3: Extend `src/vault/vault-schema.ts`.** Add the two columns to `CREATE TABLE vault_notes`, after `updated_at_utc TEXT NOT NULL`:

```sql
    updated_at_utc TEXT NOT NULL,
    last_accessed_at_utc TEXT,
    validated_at_utc TEXT
```

Add an exported constant above `VAULT_SCHEMA_SQL`:

```ts
/** Created by the 87 → 88 upgrade on existing databases and by the schema on fresh ones. */
export const VAULT_VALIDATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS vault_fact_points (
    note_id TEXT NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
    label_key TEXT NOT NULL,
    value_key TEXT NOT NULL,
    label TEXT NOT NULL,
    value TEXT NOT NULL,
    added_at_utc TEXT NOT NULL,
    edited_at_utc TEXT NOT NULL,
    last_accessed_at_utc TEXT,
    validated_at_utc TEXT,
    PRIMARY KEY (note_id, label_key, value_key)
);
CREATE TABLE IF NOT EXISTS vault_rollup_days (day TEXT PRIMARY KEY);
`;
```

Append the tables and indexes to the end of `VAULT_SCHEMA_SQL`. The schema runs after the upgrade chain (`runtime-db.ts:262-267`), so the indexes never see a missing column:

```sql
${VAULT_VALIDATION_TABLES_SQL}
CREATE INDEX IF NOT EXISTS vault_notes_validation_idx ON vault_notes(kind, last_accessed_at_utc, validated_at_utc);
CREATE INDEX IF NOT EXISTS vault_fact_points_validation_idx ON vault_fact_points(last_accessed_at_utc, validated_at_utc);
```

- [ ] **Step 4: Create `src/vault/fact-points.ts`.**

```ts
import { parseNoteBody, vaultKey } from '@siftkit/contracts';

import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';

const DAY_MS = 86_400_000;

export const FactPointRowSchema = z.object({
  note_id: z.string(),
  label_key: z.string(),
  value_key: z.string(),
  label: z.string(),
  value: z.string(),
  added_at_utc: z.string(),
  edited_at_utc: z.string(),
  last_accessed_at_utc: z.string().nullable(),
  validated_at_utc: z.string().nullable(),
});
export type FactPointRow = z.infer<typeof FactPointRowSchema>;

const FactPointKeyRowsSchema = z.array(FactPointRowSchema.pick({ label_key: true, value_key: true }));

export interface FactPointKey {
  readonly labelKey: string;
  readonly valueKey: string;
}

export const factPointKey = (label: string, value: string): FactPointKey => ({ labelKey: vaultKey(label), valueKey: vaultKey(value) });
const keyId = (key: FactPointKey) => `${key.labelKey}\n${key.valueKey}`;

/** Every fact value a body's visible fact rows hold. */
export function bodyFactPoints(body: string): Array<FactPointKey & { readonly label: string; readonly value: string }> {
  return parseNoteBody(body).factRows.flatMap((row) => row.values.map((value) => ({ ...factPointKey(row.label, value), label: row.label, value })));
}

/** Keeps a note's fact points in step with its body. Unchanged values keep all their times (spec §4.4). */
export function syncFactPoints(database: RuntimeDatabase, noteId: string, body: string, nowUtc: string): void {
  const current = new Map(bodyFactPoints(body).map((point) => [keyId(point), point]));
  const remove = database.prepare('DELETE FROM vault_fact_points WHERE note_id = ? AND label_key = ? AND value_key = ?');
  for (const row of FactPointKeyRowsSchema.parse(database.prepare('SELECT label_key, value_key FROM vault_fact_points WHERE note_id = ?').all(noteId))) {
    if (!current.delete(keyId({ labelKey: row.label_key, valueKey: row.value_key }))) remove.run(noteId, row.label_key, row.value_key);
  }
  const insert = database.prepare(`
    INSERT INTO vault_fact_points (note_id, label_key, value_key, label, value, added_at_utc, edited_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const point of current.values()) insert.run(noteId, point.labelKey, point.valueKey, point.label, point.value, nowUtc, nowUtc);
}

/** Stamps last access on a note and on the listed fact values it showed. */
export function touchAccess(database: RuntimeDatabase, noteId: string, keys: readonly FactPointKey[], nowUtc: string): void {
  database.prepare('UPDATE vault_notes SET last_accessed_at_utc = ? WHERE id = ?').run(nowUtc, noteId);
  const point = database.prepare('UPDATE vault_fact_points SET last_accessed_at_utc = ? WHERE note_id = ? AND label_key = ? AND value_key = ?');
  for (const key of keys) point.run(nowUtc, noteId, key.labelKey, key.valueKey);
}

/** A committed review: the note and every value it holds are validated, except the flagged ones. */
export function stampValidated(database: RuntimeDatabase, noteId: string, flagged: readonly FactPointKey[], nowUtc: string): void {
  database.prepare('UPDATE vault_notes SET validated_at_utc = ? WHERE id = ?').run(nowUtc, noteId);
  const skip = new Set(flagged.map(keyId));
  for (const row of FactPointKeyRowsSchema.parse(database.prepare('SELECT label_key, value_key FROM vault_fact_points WHERE note_id = ?').all(noteId))) {
    const key = { labelKey: row.label_key, valueKey: row.value_key };
    if (!skip.has(keyId(key))) validateFactPoint(database, noteId, key, nowUtc);
  }
}

export function validateFactPoint(database: RuntimeDatabase, noteId: string, key: FactPointKey, nowUtc: string): void {
  database.prepare('UPDATE vault_fact_points SET validated_at_utc = ? WHERE note_id = ? AND label_key = ? AND value_key = ?')
    .run(nowUtc, noteId, key.labelKey, key.valueKey);
}

const days = (fromUtc: string, nowUtc: string) => `${Math.max(0, Math.floor((Date.parse(nowUtc) - Date.parse(fromUtc)) / DAY_MS))}d`;

/** `added 40d · edited 12d · validated never`, the age line shown to the agent. */
export function factAges(row: Pick<FactPointRow, 'added_at_utc' | 'edited_at_utc' | 'validated_at_utc'>, nowUtc: string): string {
  return `added ${days(row.added_at_utc, nowUtc)} · edited ${days(row.edited_at_utc, nowUtc)} · validated ${
    row.validated_at_utc === null ? 'never' : days(row.validated_at_utc, nowUtc)}`;
}
```

- [ ] **Step 5: Hook the sync into `VaultNoteStore.reindex`** (`src/vault/note-store.ts`). Import `syncFactPoints` from `./fact-points.ts` and add this as the last line of `reindex`. `updatedAtUtc` is "now" on every write:

```ts
    syncFactPoints(this.database, note.id, note.body, note.updatedAtUtc);
```

- [ ] **Step 6: Run the fact-point test and confirm it passes.** Run: `node ./src/test-runner/run-tests.ts vault-fact-points`. Expected: PASS.

- [ ] **Step 7: Write the failing upgrade test** in `tests/vault-validation-upgrade.test.ts`. It builds a real 87 database by dropping the 88 objects from a fresh one:

```ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { z } from '../src/lib/zod.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';
import { downgradeVaultTo87 } from './helpers/vault-schema-87.ts';

const NOTE_UPDATED = '2026-09-01T10:00:00.000Z';

function seedSchema87(): string {
  const dbPath = path.join(createManagedTempDir('siftkit-vault-88-'), 'runtime.sqlite');
  getRuntimeDatabase(dbPath);
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    downgradeVaultTo87(database);
    database.prepare(`
      INSERT INTO vault_notes (id, title, title_key, folder, kind, types_json, aliases_json, tags_json, body, revision, is_stub, created_at_utc, updated_at_utc)
      VALUES ('vnote_1', 'Neovim', 'neovim', 'Software', 'entity', '[]', '[]', '[]', ?, 1, 0, ?, ?)
    `).run('Editor.\n\n**Uses** [[Lua]] · plugins', NOTE_UPDATED, NOTE_UPDATED);
    database.exec('UPDATE runtime_schema SET version = 87 WHERE id = 1');
  });
  return dbPath;
}

test('the 87 to 88 upgrade adds the timestamp columns and backfills fact points from every note', (t) => {
  t.after(closeAllRuntimeDatabases);
  const database = getRuntimeDatabase(seedSchema87());
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  const rows = z.array(z.object({ value: z.string(), added_at_utc: z.string(), edited_at_utc: z.string(), last_accessed_at_utc: z.null(), validated_at_utc: z.null() }))
    .parse(database.prepare("SELECT value, added_at_utc, edited_at_utc, last_accessed_at_utc, validated_at_utc FROM vault_fact_points WHERE note_id = 'vnote_1' ORDER BY value_key").all());
  assert.deepEqual(rows.map((row) => [row.value, row.added_at_utc, row.edited_at_utc]), [['[[Lua]]', NOTE_UPDATED, NOTE_UPDATED], ['plugins', NOTE_UPDATED, NOTE_UPDATED]]);
  assert.deepEqual(database.prepare("SELECT last_accessed_at_utc, validated_at_utc FROM vault_notes WHERE id = 'vnote_1'").get(), { last_accessed_at_utc: null, validated_at_utc: null });
});
```

Create `tests/helpers/vault-schema-87.ts`:

```ts
import type { RuntimeDatabase } from '../../src/state/runtime-db.ts';

/** Removes what schema 88 added, so a fresh database stands in for a real 87 file. */
export function downgradeVaultTo87(database: RuntimeDatabase): void {
  database.exec(`
    DROP INDEX IF EXISTS vault_notes_validation_idx;
    DROP INDEX IF EXISTS vault_fact_points_validation_idx;
    DROP TABLE IF EXISTS vault_fact_points;
    DROP TABLE IF EXISTS vault_rollup_days;
    ALTER TABLE vault_notes DROP COLUMN last_accessed_at_utc;
    ALTER TABLE vault_notes DROP COLUMN validated_at_utc;
  `);
}
```

`RuntimeDatabase` here is whatever `withRuntimeDatabaseConnection` passes. If it passes a raw better-sqlite3 handle, type the parameter as that callback's argument type instead.

In `tests/vault-job-upgrade.test.ts`, call `downgradeVaultTo87(database)` inside `seedSchema86` before setting version 86. Otherwise the chain 86 → 87 → 88 tries to add columns a fresh file already has.

- [ ] **Step 8: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts vault-validation-upgrade`. Expected: FAIL; the version is still 87 or the columns are missing.

- [ ] **Step 9: Create `src/state/schema-upgrades/vault-validation.ts`** (Task 10 adds the job conversion to this same function):

```ts
import { z } from '../../lib/zod.ts';
import { syncFactPoints } from '../../vault/fact-points.ts';
import { VAULT_VALIDATION_TABLES_SQL } from '../../vault/vault-schema.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const NoteRowsSchema = z.array(z.object({ id: z.string(), body: z.string(), updated_at_utc: z.string() }));

/** Schema 88: note and fact-value timestamps, backfilled so the whole vault enters the validation queue. */
export function upgradeVaultValidation(database: RuntimeDatabase): void {
  database.exec(`
    ALTER TABLE vault_notes ADD COLUMN last_accessed_at_utc TEXT;
    ALTER TABLE vault_notes ADD COLUMN validated_at_utc TEXT;
  `);
  database.exec(VAULT_VALIDATION_TABLES_SQL);
  for (const note of NoteRowsSchema.parse(database.prepare('SELECT id, body, updated_at_utc FROM vault_notes').all())) {
    syncFactPoints(database, note.id, note.body, note.updated_at_utc);
  }
}
```

If `syncFactPoints` takes `RuntimeDatabase` from `runtime-db.ts` and that type differs from `database-handle.ts`'s, use the one the upgrade receives. Check `upgradeVaultCutoverJobs` for the exact import.

In `src/state/runtime-db.ts`, set `CURRENT_SCHEMA_VERSION = 88`, import the function and append `{ from: 87, apply: upgradeVaultValidation }` to `SCHEMA_UPGRADES`.

- [ ] **Step 10: Run the upgrade tests.** Run: `node ./src/test-runner/run-tests.ts vault-validation-upgrade`, `node ./src/test-runner/run-tests.ts vault-job-upgrade`, `node ./src/test-runner/run-tests.ts vault-schema`, `node ./src/test-runner/run-tests.ts vault-note-store`. Expected: PASS. Any test that asserts the schema version number (search `CURRENT_SCHEMA_VERSION\|version = 87\|, 87` under `tests/`) is updated to 88.

- [ ] **Step 11: Leave uncommitted.**

---

### Task 3: Server-side triage (Keep/Drop) and the dashboard switch

**Files:**
- Create: `src/vault/triage.ts`
- Modify: `packages/contracts/src/vault.ts`, `src/assistant/assistant-service.ts`, `src/status-server/routes/assistant/vault-routes.ts`, `src/status-server/routes/assistant.ts`, `dashboard/src/vault-api.ts`, `dashboard/src/hooks/useVaultController.ts`, `dashboard/src/components/vault/vault-actions.ts`
- Test: `tests/vault-triage.test.ts`, `tests/vault-routes.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/vault-triage.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { addUnverified } from '@siftkit/contracts';
import { z } from '../src/lib/zod.ts';
import { VaultValidationError } from '../src/vault/errors.ts';
import { triageUnverified } from '../src/vault/triage.ts';
import { TEST_META, entityInput, withVault } from './helpers/vault-fixture.ts';

const BODY = 'Denys builds tools.\n\n**Hobby** flying by flapping hands · chess';

test('Keep on a doubt removes the flag and stamps that fact value validated', () => {
  withVault((context) => {
    const created = context.store.create(entityInput('Denys', BODY), TEST_META);
    const flagged = context.store.update(created.id, {
      body: addUnverified(BODY, [{ label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible' } }]),
    }, created.revision, TEST_META);
    const line = flagged.body.split('\n').findIndex((candidate) => candidate.includes('#unverified'));
    context.clock.advanceDays(1);
    const kept = triageUnverified(context.store, context.database, created.id, { line, action: 'confirm', expectedRevision: flagged.revision }, context.clock.nowUtc());
    assert.equal(kept.body, BODY);
    const validated = z.array(z.object({ value: z.string(), validated_at_utc: z.string().nullable() })).parse(
      context.database.prepare('SELECT value, validated_at_utc FROM vault_fact_points WHERE note_id = ? ORDER BY value_key').all(created.id));
    assert.deepEqual(validated, [{ value: 'chess', validated_at_utc: null }, { value: 'flying by flapping hands', validated_at_utc: context.clock.nowUtc() }]);
  });
});

test('Drop on a doubt removes the value; a line that is not a Review item is a validation error', () => {
  withVault((context) => {
    const created = context.store.create(entityInput('Denys', BODY), TEST_META);
    const flagged = context.store.update(created.id, {
      body: addUnverified(BODY, [{ label: 'Hobby', value: 'flying by flapping hands', flag: { kind: 'doubt', reason: 'implausible' } }]),
    }, created.revision, TEST_META);
    const line = flagged.body.split('\n').findIndex((candidate) => candidate.includes('#unverified'));
    const dropped = triageUnverified(context.store, context.database, created.id, { line, action: 'drop', expectedRevision: flagged.revision }, context.clock.nowUtc());
    assert.equal(dropped.body, 'Denys builds tools.\n\n**Hobby** chess');
    assert.throws(() => triageUnverified(context.store, context.database, created.id, { line: 0, action: 'drop', expectedRevision: dropped.revision }, context.clock.nowUtc()), VaultValidationError);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts vault-triage`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Add the request schema** to `packages/contracts/src/vault.ts`, next to `VaultRestoreRequestSchema`:

```ts
export const VaultTriageRequestSchema = z.object({
  line: z.number().int().min(0),
  action: VaultTriageActionSchema,
  expectedRevision: VaultRevisionNumberSchema,
}).strict();
export type VaultTriageRequest = z.infer<typeof VaultTriageRequestSchema>;
```

- [ ] **Step 4: Create `src/vault/triage.ts`.**

```ts
import { parseNoteBody, resolveUnverified, type VaultNote, type VaultTriageRequest } from '@siftkit/contracts';

import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { VaultValidationError } from './errors.ts';
import { factPointKey, validateFactPoint } from './fact-points.ts';
import { requireVaultNote } from './note-rows.ts';
import type { VaultNoteStore } from './note-store.ts';

/** Keep or Drop one Review item as the user; Keep on a doubt stamps the value validated (spec §4.4). */
export function triageUnverified(store: VaultNoteStore, database: RuntimeDatabase, noteId: string, request: VaultTriageRequest, nowUtc: string): VaultNote {
  return database.transaction((): VaultNote => {
    const note = requireVaultNote(database, noteId);
    if (!parseNoteBody(note.body).unverified.some((fact) => fact.line === request.line)) {
      throw new VaultValidationError(`Line ${request.line} is not a Review item.`);
    }
    const result = resolveUnverified(note.body, request.line, request.action);
    const written = store.update(note.id, { body: result.body }, request.expectedRevision, {
      actor: 'you', sourceRef: null, summary: request.action === 'confirm' ? 'Kept a Review item' : 'Dropped a Review item',
    });
    if (result.validated !== null) validateFactPoint(database, note.id, factPointKey(result.validated.label, result.validated.value), nowUtc);
    return written;
  })();
}
```

- [ ] **Step 5: Run the test and confirm it passes.** Run: `node ./src/test-runner/run-tests.ts vault-triage`. Expected: PASS.

- [ ] **Step 6: Add the route and service method.** In `AssistantService`:

```ts
  triageVaultFact(noteId: string, request: VaultTriageRequest): VaultNote {
    return triageUnverified(this.vaultNotes, this.database, noteId, request, this.clock.nowUtc());
  }
```

In `vault-routes.ts`:

```ts
export const vaultTriageEndpoint = assistantRoute(async ({ service, req, res, match }) => {
  sendJson(res, 200, service.triageVaultFact(id(match), await body(req, VaultTriageRequestSchema)));
});
```

In `routes/assistant.ts`, next to the restore route:

```ts
  { method: 'POST', path: /^\/assistant\/vault\/notes\/([^/]+)\/triage$/u, endpoint: vaultTriageEndpoint },
```

Add a route test to `tests/vault-routes.test.ts`, following that file's existing request helper. POST a Keep on a doubt item, then assert 200, that the returned body has no `#unverified`, and that a stale `expectedRevision` returns the existing conflict status.

- [ ] **Step 7: Switch the dashboard to the route.** In `dashboard/src/vault-api.ts`:

```ts
export function triageVaultFact(token: string, id: string, triage: VaultTriageRequest): Promise<VaultNote> {
  return request(`${noteId(id)}/triage`, token, VaultNoteSchema, json('POST', triage));
}
```

In `dashboard/src/components/vault/vault-actions.ts`, delete the local `VaultTriage` type and use `VaultTriageAction` from `@siftkit/contracts` in `triage(noteId, line, action: VaultTriageAction)`. Update its importers (`useVaultController.ts`, `NoteMarkdown.tsx`, `VaultPanels.tsx`) to match.

In `useVaultController.ts`, drop the `confirmUnverified, dropLine` imports, extract the conflict recovery that `writeBody` already does, and reuse it:

```ts
  async function recoverConflict(auth: string, noteId: string): Promise<void> {
    await loadDetail(auth, noteId);
    notify('This note changed elsewhere; the latest revision is loaded.', true);
  }
```

`writeBody`'s catch becomes `if (!(caught instanceof VaultRequestError && caught.code === 'conflict')) throw caught; await recoverConflict(auth, note.id);`. Then:

```ts
    triage: (noteId, line, action) => authed(async (auth) => {
      const { note } = await loadDetail(auth, noteId);
      try {
        await afterWrite(auth, await triageVaultFact(auth, note.id, { line, action, expectedRevision: note.revision }));
        notify(action === 'confirm' ? 'Kept.' : 'Dropped.');
      } catch (caught) {
        if (!(caught instanceof VaultRequestError && caught.code === 'conflict')) throw caught;
        await recoverConflict(auth, note.id);
      }
      if (activeTab?.kind === 'review') setReview(await getVaultReview(auth, REVIEW_LIMIT));
    }),
```

In `VaultPanels.tsx`, show the flag on each Review row next to label/value: `item.flag?.kind === 'replaces'` renders `replaces {item.flag.value}`, and `'doubt'` renders `doubt: {item.flag.reason}`, in a `<small className="v-flag">`.

- [ ] **Step 8: Run the dashboard vault tests and typecheck.** Run: `npx vitest run --config dashboard/vitest.config.ts dashboard/tests` (narrow it to the vault files if the full run is slow), `node ./src/test-runner/run-tests.ts vault-routes`, then `npm run typecheck`. Expected: PASS. Any dashboard test that asserted the old PUT-on-triage request now expects `POST …/triage`.

- [ ] **Step 9: Leave uncommitted.**

---

### Task 4: Chat retrieval stamps access

**Files:**
- Modify: `src/vault/vault-retriever.ts`, `src/assistant/assistant-service.ts`
- Test: `tests/vault-retriever.test.ts`, `tests/vault-routes.test.ts`

- [ ] **Step 1: Write the failing tests.** In `tests/vault-retriever.test.ts`, pass `clock: context.clock` to every `new VaultRetriever({...})` and add:

```ts
test('notes injected into a chat prompt, and the values shown, are stamped accessed; unmatched notes are not', async () => {
  await withVaultAsync(async (context) => {
    const hit = context.store.create(entityInput('Neovim', 'Editor.\n\n**Uses** [[Lua]]'), TEST_META);
    const miss = context.store.create(entityInput('Excel', 'Spreadsheets.\n\n**Uses** formulas'), TEST_META);
    context.clock.advanceDays(2);
    const retriever = new VaultRetriever({ database: context.database, tokens: new EstimateTokenCounter(4), clock: context.clock });
    await retriever.retrieve('how do I configure neovim', { maxContextTokens: 2_000, maxNotes: 5 });
    const accessed = (id: string) => z.object({ last_accessed_at_utc: z.string().nullable() })
      .parse(context.database.prepare('SELECT last_accessed_at_utc FROM vault_notes WHERE id = ?').get(id)).last_accessed_at_utc;
    assert.equal(accessed(hit.id), context.clock.nowUtc());
    assert.equal(accessed(miss.id), null);
    const point = z.object({ last_accessed_at_utc: z.string().nullable() })
      .parse(context.database.prepare('SELECT last_accessed_at_utc FROM vault_fact_points WHERE note_id = ?').get(hit.id));
    assert.equal(point.last_accessed_at_utc, context.clock.nowUtc());
  });
});
```

Use the async fixture variant the file already uses. If it has none, wrap with the same open/close helper the existing async tests use.

In `tests/vault-routes.test.ts`, add a test that GETs `/assistant/vault/notes/<id>` and then asserts the note's `last_accessed_at_utc` is still `null`. Opening a note in the UI does not count as access.

- [ ] **Step 2: Run them and confirm they fail.** Run: `node ./src/test-runner/run-tests.ts vault-retriever`. Expected: FAIL; the `clock` option is unknown and the timestamp is null.

- [ ] **Step 3: Implement.** In `vault-retriever.ts`, add `readonly clock: Clock;` to `VaultRetrieverOptions` and store it. Import `bodyFactPoints`, `touchAccess` and `type FactPointKey` from `./fact-points.ts`. Give each entry its shown keys:

```ts
    const keysOf = (note: VaultNote, withRows: boolean): FactPointKey[] => (withRows ? bodyFactPoints(note.body) : []);
    const fixed = owner === null ? [] : [{
      id: owner.id, keys: keysOf(owner, hitIds.includes(owner.id)), block: renderNote(owner, `${owner.title} (you)`, hitIds.includes(owner.id)),
    }];
    const ranked = hits.map((note) => ({ id: note.id, keys: keysOf(note, true), block: renderNote(note, note.title, true) }));
```

After `included` is computed and before the return:

```ts
    const nowUtc = this.clock.nowUtc();
    this.database.transaction(() => { for (const entry of included) touchAccess(this.database, entry.id, entry.keys, nowUtc); })();
```

In `AssistantService`, construct it as `new VaultRetriever({ database, tokens: options.tokens, clock })`.

- [ ] **Step 4: Run the tests and confirm they pass.** Run: `node ./src/test-runner/run-tests.ts vault-retriever` and `node ./src/test-runner/run-tests.ts vault-routes`. Expected: PASS.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 5: Validation queue and queue stats

**Files:**
- Create: `src/vault/validation-queue.ts`
- Modify: `packages/contracts/src/vault.ts`, `src/vault/note-queries.ts`, `src/assistant/assistant-service.ts`, `src/status-server/routes/assistant/vault-routes.ts`, `dashboard/src/components/vault/VaultPanels.tsx`
- Test: `tests/vault-validation-queue.test.ts`, `tests/vault-note-queries.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/vault-validation-queue.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { factPointKey, stampValidated, touchAccess } from '../src/vault/fact-points.ts';
import { VaultValidationQueue } from '../src/vault/validation-queue.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

function seed(context: VaultTestContext, count: number): string[] {
  return Array.from({ length: count }, (_, index) => context.store.create(entityInput(`Tool ${index}`, `Tool ${index}.\n\n**Uses** x${index}`), TEST_META).id);
}

test('batch is 10% of entity notes, at least 1 and at most 25', () => {
  withVault((context) => {
    const queue = new VaultValidationQueue(context.database);
    assert.deepEqual(queue.nextBatch(context.clock.nowUtc()), []);
    seed(context, 3);
    assert.equal(queue.nextBatch(context.clock.nowUtc()).length, 1);
    seed(context, 37);
    assert.equal(queue.nextBatch(context.clock.nowUtc()).length, 4);
    seed(context, 300);
    assert.equal(queue.nextBatch(context.clock.nowUtc()).length, 25);
  });
});

test('never-accessed notes come first, then the oldest access; ties go to the oldest validation', () => {
  withVault((context) => {
    const [a, b, c, d] = seed(context, 4);
    const queue = new VaultValidationQueue(context.database);
    touchAccess(context.database, a, [], '2026-10-01T00:00:00.000Z');
    touchAccess(context.database, b, [], '2026-10-01T00:00:00.000Z');
    touchAccess(context.database, c, [], '2026-09-01T00:00:00.000Z');
    stampValidated(context.database, a, [], '2026-08-01T00:00:00.000Z');
    assert.deepEqual(queue.order(context.clock.nowUtc()), [d, c, b, a]);
  });
});

test('notes validated in the last 30 days are not queued, and the depth counts the rest', () => {
  withVault((context) => {
    const [fresh, stale] = seed(context, 2);
    const queue = new VaultValidationQueue(context.database);
    stampValidated(context.database, fresh, [], context.clock.nowUtc());
    stampValidated(context.database, stale, [], '2026-08-01T00:00:00.000Z');
    assert.deepEqual(queue.nextBatch(context.clock.nowUtc()), [stale]);
    assert.deepEqual(queue.depth(context.clock.nowUtc()), { queueDepth: 1, oldestValidatedAtUtc: '2026-08-01T00:00:00.000Z' });
  });
});

test('staleFacts lists never-accessed values first, then the oldest access', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub · GitLab · Gitea'), TEST_META);
    touchAccess(context.database, note.id, [factPointKey('Hosts', 'GitHub')], '2026-10-01T00:00:00.000Z');
    touchAccess(context.database, note.id, [factPointKey('Hosts', 'Gitea')], '2026-09-01T00:00:00.000Z');
    assert.deepEqual(new VaultValidationQueue(context.database).staleFacts(note.id).map((row) => row.value), ['GitLab', 'Gitea', 'GitHub']);
  });
});
```

`order(nowUtc)` is a small public method returning every eligible entity note id in queue order; `nextBatch` slices it.

- [ ] **Step 2: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts vault-validation-queue`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Create `src/vault/validation-queue.ts`.**

```ts
import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { FactPointRowSchema, type FactPointRow } from './fact-points.ts';

const BATCH_FRACTION = 0.1;
export const VALIDATION_BATCH_MIN = 1;
export const VALIDATION_BATCH_MAX = 25;
const REVALIDATE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;
const IdRowsSchema = z.array(z.object({ id: z.string() }));
const CountSchema = z.object({ count: z.number() });
// SQLite sorts NULL first ascending: never accessed, then never validated, lead the queue.
const NOTE_ORDER = 'ORDER BY last_accessed_at_utc, validated_at_utc, updated_at_utc, id';
const ELIGIBLE = "kind = 'entity' AND (validated_at_utc IS NULL OR validated_at_utc < ?)";

/** The validation queue (spec §4.5): an ordered query over indexed timestamps, never a separate table. */
export class VaultValidationQueue {
  private readonly database: RuntimeDatabase;

  constructor(database: RuntimeDatabase) {
    this.database = database;
  }

  /** Every queued entity note id, head first. */
  order(nowUtc: string): string[] {
    return IdRowsSchema.parse(this.database.prepare(`SELECT id FROM vault_notes WHERE ${ELIGIBLE} ${NOTE_ORDER}`).all(revalidateCutoff(nowUtc)))
      .map((row) => row.id);
  }

  /** The head of the queue: 10% of entity notes, at least 1 and at most 25. */
  nextBatch(nowUtc: string): string[] {
    const total = CountSchema.parse(this.database.prepare("SELECT COUNT(*) AS count FROM vault_notes WHERE kind = 'entity'").get()).count;
    const size = Math.min(VALIDATION_BATCH_MAX, Math.max(VALIDATION_BATCH_MIN, Math.floor(total * BATCH_FRACTION)));
    return this.order(nowUtc).slice(0, size);
  }

  staleFacts(noteId: string): FactPointRow[] {
    return z.array(FactPointRowSchema).parse(this.database.prepare(
      'SELECT * FROM vault_fact_points WHERE note_id = ? ORDER BY last_accessed_at_utc, validated_at_utc, edited_at_utc, label_key, value_key',
    ).all(noteId));
  }

  depth(nowUtc: string): { queueDepth: number; oldestValidatedAtUtc: string | null } {
    const queueDepth = CountSchema.parse(this.database.prepare(`SELECT COUNT(*) AS count FROM vault_notes WHERE ${ELIGIBLE}`).get(revalidateCutoff(nowUtc))).count;
    const oldest = z.object({ oldest: z.string().nullable() }).parse(this.database.prepare(
      "SELECT MIN(validated_at_utc) AS oldest FROM vault_notes WHERE kind = 'entity'",
    ).get()).oldest;
    return { queueDepth, oldestValidatedAtUtc: oldest };
  }
}

const revalidateCutoff = (nowUtc: string) => new Date(Date.parse(nowUtc) - REVALIDATE_AFTER_DAYS * DAY_MS).toISOString();
```


- [ ] **Step 4: Run the test and confirm it passes.** Run: `node ./src/test-runner/run-tests.ts vault-validation-queue`. Expected: PASS.

- [ ] **Step 5: Add queue stats.** In `packages/contracts/src/vault.ts`, `VaultStatsSchema` gains:

```ts
  validation: z.object({ queueDepth: z.number().int().min(0), oldestValidatedAtUtc: z.string().nullable() }).strict(),
```

`VaultNoteQueries` holds `private readonly queue: VaultValidationQueue` (built in its constructor), and `stats(nowUtc: string)` returns `validation: this.queue.depth(nowUtc)`. Add `vaultStats(): VaultStats { return this.vaultQueries.stats(this.clock.nowUtc()); }` to `AssistantService`, and `vaultStatsEndpoint` calls `service.vaultStats()`. Update `tests/vault-note-queries.test.ts`'s stats assertion to include `validation` and pass a `nowUtc`. Update any dashboard fixture that builds a `VaultStats` (search `notesWithUnverified` under `dashboard/tests`) to include `validation: { queueDepth: 0, oldestValidatedAtUtc: null }`.

In `VaultPanels.tsx` (the Review panel stat block near line 187), add:

```tsx
        <div className="v-stat"><b>{num(stats?.validation.queueDepth ?? 0)}</b><small>notes awaiting validation</small></div>
        <div className="v-stat"><b>{stats?.validation.oldestValidatedAtUtc?.slice(0, 10) ?? 'never'}</b><small>oldest validation</small></div>
```

- [ ] **Step 6: Run the tests.** Run: `node ./src/test-runner/run-tests.ts vault-note-queries`, `node ./src/test-runner/run-tests.ts vault-routes`, then the vault dashboard tests. Expected: PASS.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 6: New operations and applier guards

**Files:**
- Modify: `src/vault/note-writer/edit-ops.ts`, `src/vault/note-writer/edit-applier.ts`
- Test: `tests/vault-edit-applier.test.ts`

- [ ] **Step 1: Write the failing tests.** In `tests/vault-edit-applier.test.ts`, change the `apply` helper to pass `scopeNoteIds: []` and expose a variant that takes scope:

```ts
  const apply = (operations: readonly VaultEditOp[], scopeNoteIds: readonly string[] = []) =>
    edits.apply({ ownerId: OWNER_ID, operations, actor: 'note-writer · screenshot', sourceRef: 'vatt_1', summary: 'Screenshot 09:00', scopeNoteIds });
```

Add:

```ts
test('a near-duplicate create_note becomes an alias of the existing note and is audited as merged_into_existing', () => {
  withVault((context) => {
    const { apply, audit } = applier(context);
    const existing = context.store.create(entityInput('VS Code', 'Editor.'), TEST_META);
    const result = apply([{ op: 'create_note', title: 'vs-code', type: 'software', lead: 'Editor.' }]);
    assert.deepEqual(context.store.resolve('vs-code')?.id, existing.id);
    assert.deepEqual(context.store.resolve('VS Code')?.aliases, ['vs-code']);
    assert.equal(result.dropped, 0);
    assert.ok(audit.listAuditEvents(OWNER_ID).some((event) => event.eventType === 'vault_edit_merged' && event.details.reason === 'merged_into_existing'));
  });
});

test('a value already in its row is dropped silently', () => {
  withVault((context) => {
    const { apply } = applier(context);
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub'), TEST_META);
    const result = apply([{ op: 'add_facts', note: 'Git', label: 'hosts', values: ['github'] }]);
    assert.equal(context.store.resolve('Git')?.revision, note.revision);
    assert.equal(result.dropped, 0);
  });
});

test('flag_conflict lands in Review when the note holds the replaced value; an unknown fact is dropped', () => {
  withVault((context) => {
    const { apply } = applier(context);
    context.store.create(entityInput('Denys', 'Owner.\n\n**Editor** [[Neovim]]', { tags: ['me'] }), TEST_META);
    const result = apply([
      { op: 'flag_conflict', note: 'Denys', label: 'Editor', value: 'Helix', conflictsWith: 'Neovim' },
      { op: 'flag_conflict', note: 'Denys', label: 'Editor', value: 'Emacs', conflictsWith: 'Notepad' },
    ]);
    const body = context.store.resolve('Denys')?.body ?? '';
    assert.match(body, /\*\*Editor\*\* Helix #unverified \(replaces: Neovim\)/);
    assert.doesNotMatch(body, /Emacs/);
    assert.equal(result.dropped, 1);
  });
});

test('flag_doubt marks a held value and reports it flagged, so review does not validate it', () => {
  withVault((context) => {
    const { apply } = applier(context);
    const note = context.store.create(entityInput('Pet Safety', 'A project.\n\n**Uses** [[Neovim]] · TypeScript'), TEST_META);
    const result = apply([{ op: 'flag_doubt', note: 'Pet Safety', label: 'Uses', value: 'Neovim', reason: 'bad link: an editor is not used by a pet-safety project' }], [note.id]);
    assert.match(context.store.resolve('Pet Safety')?.body ?? '', /\*\*Uses\*\* Neovim #unverified \(doubt: bad link: /);
    assert.deepEqual(result.flagged, [{ noteId: note.id, labelKey: 'uses', valueKey: '[[neovim]]' }]);
  });
});

test('set_lead applies only to notes the batch touches or the review scope holds', () => {
  withVault((context) => {
    const { apply } = applier(context);
    const git = context.store.create(entityInput('Git', 'Old lead.\n\n**Hosts** GitHub'), TEST_META);
    context.store.create(entityInput('Excel', 'Old lead.'), TEST_META);
    const result = apply([
      { op: 'add_facts', note: 'Git', label: 'Hosts', values: ['GitLab'] },
      { op: 'set_lead', note: 'Git', lead: 'Git is a version control system.' },
      { op: 'set_lead', note: 'Excel', lead: 'Excel is a spreadsheet.' },
    ]);
    assert.match(context.store.resolve('Git')?.body ?? '', /^Git is a version control system\./);
    assert.match(context.store.resolve('Excel')?.body ?? '', /^Old lead\./);
    assert.equal(result.dropped, 1);
    apply([{ op: 'set_lead', note: 'Excel', lead: 'Excel is a spreadsheet.' }], [context.store.resolve('Excel')?.id ?? '']);
    assert.match(context.store.resolve('Excel')?.body ?? '', /^Excel is a spreadsheet\./);
    assert.equal(git.title, 'Git');
  });
});
```

The flagged `valueKey` is the key of the value as the row stores it (`[[Neovim]]` → `[[neovim]]`), so `stampValidated` skips exactly that fact point.

Check `AuditStore`'s actual list method name with `Grep pattern="list.*\(" path=src/assistant/storage/audit-store.ts` and adjust the call.

- [ ] **Step 2: Run them and confirm they fail.** Run: `node ./src/test-runner/run-tests.ts vault-edit-applier`. Expected: FAIL; the ops are unknown and `scopeNoteIds` / `flagged` are missing.

- [ ] **Step 3: Extend `edit-ops.ts`.**

```ts
  z.object({ op: z.literal('set_lead'), note: NoteRef, lead: text(600) }).strict(),
  z.object({ op: z.literal('flag_conflict'), note: NoteRef, label: Label, value: Value, conflictsWith: Value }).strict(),
  z.object({ op: z.literal('flag_doubt'), note: NoteRef, label: Label, value: Value, reason: Value }).strict(),
```

Replace `VAULT_EDIT_INSTRUCTIONS` with the vocabulary for `submit_edits`:

```ts
export const VAULT_EDIT_INSTRUCTIONS = [
  'Finish by calling submit_edits with {"operations": [...]}. Each operation is one of:',
  '- create_note {title, type, lead}: a new entity (tool, project, person, place, topic...). Only after searching shows no note fits.',
  '- add_facts {note, label, values}: durable facts as a short row label ("Uses", "Works on", "Prefers") and up to 8 values. Write a known note as [[Title]].',
  '- add_aliases {note, aliases}: other names the note goes by.',
  '- add_task {note, text}: something the user plans or wants to do.',
  '- learned {note, label, value}: one line summarising what this source taught about a note.',
  '- set_lead {note, lead}: rewrite the 1-3 sentence lead of a note this batch also edits.',
  '- flag_conflict {note, label, value, conflictsWith}: the source contradicts a held value; the user decides.',
  '- flag_doubt {note, label, value, reason}: a held value looks wrong (implausible, bad link, stale); the user decides.',
  'Refer to notes by their exact title. Refer to the user as "the user". Never change or delete an existing fact; flag it.',
  'Record only what is clearly shown. Jokes, fiction, misreads and impossible claims are not facts about the user.',
  'Never record credentials, protected traits, or a medical diagnosis. Submit {"operations": []} when nothing durable is shown.',
].join('\n');
```

- [ ] **Step 4: Extend `edit-applier.ts`.**

Add to `VaultEditRequest`: `/** Notes a review batch may lead-edit without touching them otherwise. */ readonly scopeNoteIds: readonly string[];`

Add to `VaultEditResult`: `/** Values a flag_doubt marked; review leaves them unvalidated. */ readonly flagged: readonly VaultFlaggedPoint[];` with:

```ts
export interface VaultFlaggedPoint extends FactPointKey {
  readonly noteId: string;
}
```

`DropReason` gains `'unknown_fact' | 'out_of_scope'`. `opStrings` gains:

```ts
    case 'set_lead': return [op.note, op.lead];
    case 'flag_conflict': return [op.note, op.label, op.value, op.conflictsWith];
    case 'flag_doubt': return [op.note, op.label, op.value, op.reason];
```

Add the near-duplicate key and lookup (module level and a private method):

```ts
/** Title identity ignoring case, whitespace and punctuation (spec §3.5). */
const looseKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  private findNearDuplicate(title: string): VaultNote | null {
    const key = looseKey(title);
    if (key.length === 0) return null;
    const owners = z.array(z.object({ key: z.string(), note_id: z.string() })).parse(this.database.prepare('SELECT key, note_id FROM vault_key_owners').all());
    const match = owners.find((owner) => looseKey(owner.key) === key);
    return match === undefined ? null : readVaultNote(this.database, match.note_id);
  }
```

Rewrite the loop in `apply`. Leads are applied after the other ops so scope covers the whole batch:

```ts
      const created = new Set<string>();
      const flagged: VaultFlaggedPoint[] = [];
      const leads: Array<Extract<VaultEditOp, { op: 'set_lead' }>> = [];
      for (const op of request.operations) {
        const secretRules = opStrings(op).flatMap((value) => this.scanner.scan(value).matchedRuleIds);
        if (secretRules.length > 0) { drop(op, 'secret', [...new Set(secretRules)]); continue; }
        if (op.op === 'set_lead') { leads.push(op); continue; }
        if (op.op === 'create_note') {
          if (owner.matches(op.title) || this.store.resolveId(op.title) !== null) continue;
          const near = this.findNearDuplicate(op.title);
          if (near !== null) {
            const draft = draftFor(near.title);
            if (draft !== null) draft.aliases = [...draft.aliases, op.title.trim()];
            this.audit.recordAuditEvent({
              ownerId: request.ownerId, eventType: 'vault_edit_merged', targetType: 'vault_edit', targetId: request.sourceRef,
              summary: `Merged "${op.title}" into "${near.title}" as an alias.`, details: { reason: 'merged_into_existing', title: op.title, note: near.title },
            });
            continue;
          }
          try {
            const note = this.store.create({
              title: validateVaultTitle(op.title), folder: typeFolder(op.type), kind: 'entity', types: [op.type.trim().toLowerCase()],
              aliases: [], tags: [], body: buildEntityBody({ lead: op.lead, rows: [], taskSections: [], unverified: [] }),
            }, meta);
            touched.add(note.id);
            created.add(note.id);
          } catch (error) {
            if (!(error instanceof VaultValidationError)) throw error;
            drop(op, 'invalid_title');
          }
          continue;
        }
        const draft = draftFor(op.note);
        if (draft === null) { drop(op, 'unknown_note'); continue; }
        if (op.op === 'add_facts') draft.body = addRowValues(draft.body, op.label, op.values.map(linkValue));
        else if (op.op === 'add_aliases') draft.aliases = [...draft.aliases, ...op.aliases.filter((alias) => draft.note.tags.includes(VAULT_OWNER_TAG) || !owner.matches(alias))];
        else if (op.op === 'add_task') draft.body = addTasks(draft.body, PLANS_HEADING, [op.text]);
        else if (op.op === 'learned') learned.push(`- [[${draft.note.title}]]: **${op.label}** ${op.value}`);
        else if (op.op === 'flag_conflict') {
          if (findRowValue(draft.body, op.label, op.conflictsWith) === null) { drop(op, 'unknown_fact'); continue; }
          draft.body = addUnverified(draft.body, [{ label: op.label, value: op.value, flag: { kind: 'replaces', value: op.conflictsWith } }]);
        } else {
          const stored = findRowValue(draft.body, op.label, op.value);
          if (stored === null) { drop(op, 'unknown_fact'); continue; }
          draft.body = addUnverified(draft.body, [{ label: op.label, value: op.value, flag: { kind: 'doubt', reason: op.reason } }]);
          flagged.push({ noteId: draft.note.id, ...factPointKey(stored.label, stored.value) });
        }
      }
      const scope = new Set(request.scopeNoteIds);
      for (const op of leads) {
        const target = resolveNote(op.note);
        if (target === null) { drop(op, 'unknown_note'); continue; }
        if (!drafts.has(target.id) && !created.has(target.id) && !scope.has(target.id)) { drop(op, 'out_of_scope'); continue; }
        const draft = draftFor(op.note);
        if (draft !== null) draft.body = replaceLead(draft.body, op.lead);
      }
```

`findRowValue` returns the value as the row stores it (`[[Neovim]]` for a doubt naming `Neovim`), so the flagged key matches the fact point `stampValidated` must skip.

Return `{ learned: [...new Set(learned)], touchedNoteIds: [...touched], dropped, flagged }`. New imports: `addUnverified, findRowValue, replaceLead` from contracts; `z`; `readVaultNote` from `../note-rows.ts`; `factPointKey, type FactPointKey` from `../fact-points.ts`.

Note that a draft created for a near-duplicate merge means the owner-lead scope check counts it as touched, which is correct: the note gains an alias.

- [ ] **Step 5: Run the tests and confirm they pass.** Run: `node ./src/test-runner/run-tests.ts vault-edit-applier`. Expected: PASS. Existing callers of `apply` (`capture-writer.ts`, `chat-writer.ts`) fail typecheck until Task 10 deletes them. Pass `scopeNoteIds: []` there temporarily so the tree typechecks between tasks.

- [ ] **Step 6: Leave uncommitted.**

---

### Task 7: Read-only tools, definitions and seeded cards

**Files:**
- Create: `src/vault/note-writer/agent/tools.ts`, `src/vault/note-writer/agent/definitions.ts`, `src/vault/note-writer/agent/cards.ts`
- Test: `tests/vault-writer-tools.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/vault-writer-tools.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { VaultWriterTools } from '../src/vault/note-writer/agent/tools.ts';
import { candidateCards, ownerCard } from '../src/vault/note-writer/agent/cards.ts';
import { TEST_META, entityInput, withVault, type VaultTestContext } from './helpers/vault-fixture.ts';

const accessed = (context: VaultTestContext, id: string) => z.object({ last_accessed_at_utc: z.string().nullable() })
  .parse(context.database.prepare('SELECT last_accessed_at_utc FROM vault_notes WHERE id = ?').get(id)).last_accessed_at_utc;

function tools(context: VaultTestContext) {
  return new VaultWriterTools({ database: context.database, store: context.store, clock: context.clock, day: '2026-10-24' });
}

test('read_note resolves an alias, lists values with their ages, and stamps the note accessed', () => {
  withVault((context) => {
    const note = context.store.create(entityInput('Visual Studio Code', 'Editor.\n\n**Uses** [[TypeScript]] · GitLens', { aliases: ['vscode'] }), TEST_META);
    context.clock.advanceDays(12);
    const text = tools(context).execute('read_note', { title: 'VSCode', page: 1 });
    assert.match(text, /^# Visual Studio Code/m);
    assert.match(text, /aliases: vscode/);
    assert.match(text, /- \*\*Uses\*\* \[\[TypeScript\]\] — added 12d · edited 12d · validated never/);
    assert.equal(accessed(context, note.id), context.clock.nowUtc());
  });
});

test('read_note pages 40 values at a time and says how to get the next page', () => {
  withVault((context) => {
    const values = Array.from({ length: 45 }, (_, index) => `v${index}`);
    const rows = Array.from({ length: 6 }, (_, row) => `**Row ${row}** ${values.slice(row * 8, row * 8 + 8).join(' · ')}`).join('\n');
    context.store.create(entityInput('Big', `Big note.\n\n${rows}`), TEST_META);
    const first = tools(context).execute('read_note', { title: 'Big', page: 1 });
    assert.match(first, /values 1–40 of 45 · next page 2/);
    assert.doesNotMatch(tools(context).execute('read_note', { title: 'Big', page: 2 }), /next page/);
  });
});

test('a miss names the closest notes instead of failing', () => {
  withVault((context) => {
    context.store.create(entityInput('Neovim', 'Editor.'), TEST_META);
    assert.match(tools(context).execute('read_note', { title: 'neovim config', page: 1 }), /^no note "neovim config"; closest: Neovim/);
  });
});

test('neighbors renders labelled relations both ways and stamps the listed notes', () => {
  withVault((context) => {
    const lua = context.store.create(entityInput('Lua', 'Language.'), TEST_META);
    context.store.create(entityInput('Neovim', 'Editor.\n\n**Uses** [[Lua]]'), TEST_META);
    context.store.create(entityInput('Denys', 'Owner.\n\n**Edits with** [[Neovim]]'), TEST_META);
    const text = tools(context).execute('neighbors', { title: 'Neovim', depth: 1 });
    assert.match(text, /Neovim —Uses→ Lua/);
    assert.match(text, /Denys —Edits with→ Neovim/);
    assert.equal(accessed(context, lua.id), context.clock.nowUtc());
  });
});

test('search_notes matches bodies and aliases; bad arguments come back as an error result', () => {
  withVault((context) => {
    context.store.create(entityInput('Visual Studio Code', 'Editor with the GitLens extension.', { aliases: ['vscode'] }), TEST_META);
    assert.match(tools(context).execute('search_notes', { query: 'gitlens', limit: 5 }), /Visual Studio Code/);
    assert.match(tools(context).execute('search_notes', { query: '' }), /^Error: /);
    assert.match(tools(context).execute('rm_rf', {}), /^Error: unknown tool/);
  });
});

test('the owner card and candidate cards carry what the agent needs to avoid duplicates', () => {
  withVault((context) => {
    context.store.create(entityInput('Denys', 'Denys builds tools.\n\n**Uses** [[Neovim]]', { tags: ['me'], aliases: ['the user'] }), TEST_META);
    context.store.create(entityInput('Neovim', 'Editor.\n\n**Uses** [[Lua]]', { aliases: ['nvim'], types: ['software'] }), TEST_META);
    assert.match(ownerCard(context.database, context.clock.nowUtc()), /Owner: Denys \(aliases: the user\)[\s\S]*\*\*Uses\*\* \[\[Neovim\]\]/);
    const cards = candidateCards(context.database, 'nvim init.lua', context.clock.nowUtc());
    assert.match(cards.text, /### Neovim · Software · software · aliases: nvim[\s\S]*rows: Uses/);
  });
});
```

`entityInput` overrides take `types` and `tags`; check `tests/helpers/vault-fixture.ts` and adjust if the folder is not derived from the type. The test only asserts the folder text the fixture produces.

- [ ] **Step 2: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts vault-writer-tools`. Expected: FAIL, the modules are missing.

- [ ] **Step 3: Create `src/vault/note-writer/agent/tools.ts`.**

```ts
import { parseNoteBody, sectionLines, type VaultNote } from '@siftkit/contracts';

import type { Clock } from '../../../assistant/clock.ts';
import { QueryIntentExtractor } from '../../../assistant/retrieval/query-intent.ts';
import { toError } from '../../../lib/errors.ts';
import type { JsonObject } from '../../../lib/json-types.ts';
import { z } from '../../../lib/zod.ts';
import type { RuntimeDatabase } from '../../../state/runtime-db.ts';
import { FactPointRowSchema, factAges, factPointKey, touchAccess } from '../../fact-points.ts';
import { readVaultNote, requireVaultNote } from '../../note-rows.ts';
import type { VaultNoteStore } from '../../note-store.ts';
import { searchNoteIds } from '../../vault-fts.ts';
import { CHATS_FOLDER, LEARNED_HEADING, captureFolder } from '../../vault-layout.ts';

/** About 1,500 tokens per tool result (spec §2.1). */
export const MAX_RESULT_CHARS = 6_000;
export const READ_PAGE_VALUES = 40;
const MAX_BACKLINKS = 10;
const CLOSEST_LIMIT = 3;

export const SearchNotesArgsSchema = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).default(5) }).strict();
export const ReadNoteArgsSchema = z.object({ title: z.string().trim().min(1).max(120), page: z.number().int().min(1).default(1) }).strict();
export const NeighborsArgsSchema = z.object({ title: z.string().trim().min(1).max(120), depth: z.union([z.literal(1), z.literal(2)]).default(1) }).strict();
export const DayContextArgsSchema = z.object({}).strict();

const RelationRowsSchema = z.array(z.object({ label: z.string(), other_id: z.string().nullable(), other_key: z.string() }));
const CaptureRowsSchema = z.array(z.object({ app: z.string(), window_title: z.string().nullable(), note_id: z.string() }));
const NoteIdRowsSchema = z.array(z.object({ note_id: z.string() }));

export interface VaultWriterToolsOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly clock: Clock;
  /** The local day `day_context` reports: the source's day. */
  readonly day: string;
}

const cap = (text: string) => (text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`);

/** The agent's read-only view of the vault (spec §3.2). Tools never write content; they only stamp access. */
export class VaultWriterTools {
  private readonly options: VaultWriterToolsOptions;

  constructor(options: VaultWriterToolsOptions) {
    this.options = options;
  }

  /** Runs one tool; any failure becomes a result the model can correct from. */
  execute(name: string, args: JsonObject): string {
    try {
      switch (name) {
        case 'search_notes': return cap(this.search(SearchNotesArgsSchema.parse(args)));
        case 'read_note': return cap(this.readNote(ReadNoteArgsSchema.parse(args)));
        case 'neighbors': return cap(this.neighbors(NeighborsArgsSchema.parse(args)));
        case 'day_context': DayContextArgsSchema.parse(args); return cap(this.dayContext());
        default: return `Error: unknown tool "${name}".`;
      }
    } catch (error) {
      return `Error: ${toError(error).message}`;
    }
  }

  private matches(text: string, limit: number): VaultNote[] {
    return searchNoteIds(this.options.database, new QueryIntentExtractor().extract(text).terms, ['entity'], limit)
      .flatMap((id) => readVaultNote(this.options.database, id) ?? []);
  }

  private search(args: z.infer<typeof SearchNotesArgsSchema>): string {
    const notes = this.matches(args.query, args.limit);
    if (notes.length === 0) return `no notes match "${args.query}"`;
    const terms = new QueryIntentExtractor().extract(args.query).terms.map((term) => term.toLowerCase());
    return notes.map((note) => {
      const snippet = note.body.split('\n').find((line) => terms.some((term) => line.toLowerCase().includes(term)));
      return [`- ${note.title} · ${note.folder} · ${note.types.join(', ') || 'untyped'}`,
        ...(note.aliases.length === 0 ? [] : [`  aliases: ${note.aliases.join(', ')}`]),
        ...(snippet === undefined ? [] : [`  > ${snippet.trim()}`])].join('\n');
    }).join('\n');
  }

  private readNote(args: z.infer<typeof ReadNoteArgsSchema>): string {
    const note = this.options.store.resolve(args.title);
    if (note === null) {
      const closest = this.matches(args.title, CLOSEST_LIMIT).map((candidate) => candidate.title);
      return `no note "${args.title}"; closest: ${closest.length === 0 ? 'none' : closest.join(', ')}`;
    }
    const nowUtc = this.options.clock.nowUtc();
    const parsed = parseNoteBody(note.body);
    const ages = new Map(z.array(FactPointRowSchema).parse(this.options.database.prepare('SELECT * FROM vault_fact_points WHERE note_id = ?').all(note.id))
      .map((row) => [`${row.label_key}\n${row.value_key}`, row]));
    const values = parsed.factRows.flatMap((row) => row.values.map((value) => ({ label: row.label, value })));
    const start = (args.page - 1) * READ_PAGE_VALUES;
    const page = values.slice(start, start + READ_PAGE_VALUES);
    const valueLines = page.map(({ label, value }) => {
      const key = factPointKey(label, value);
      const row = ages.get(`${key.labelKey}\n${key.valueKey}`);
      return `- **${label}** ${value}${row === undefined ? '' : ` — ${factAges(row, nowUtc)}`}`;
    });
    const backlinks = this.relations(note.id, 'in').slice(0, MAX_BACKLINKS).map((relation) => relation.text);
    const end = Math.min(start + READ_PAGE_VALUES, values.length);
    const footer = values.length > end ? [`values ${start + 1}–${end} of ${values.length} · next page ${args.page + 1}`] : [];
    touchAccess(this.options.database, note.id, page.map(({ label, value }) => factPointKey(label, value)), nowUtc);
    return [
      `# ${note.title}  (${note.folder || 'no folder'} · ${note.types.join(', ') || 'untyped'})`,
      `aliases: ${note.aliases.join(', ') || 'none'}`,
      `lead: ${parsed.lead?.text ?? 'none'}`,
      'facts:', ...(valueLines.length === 0 ? ['- none'] : valueLines),
      'open tasks:', ...parsed.tasks.filter((task) => !task.done).map((task) => `- ${task.text}`),
      'unverified:', ...parsed.unverified.map((fact) => `- **${fact.label ?? 'Facts'}** ${fact.value}${fact.flag === null ? '' : ` (${fact.flag.kind})`}`),
      'backlinks:', ...backlinks,
      ...footer,
    ].join('\n');
  }

  /** Labelled relations of one note: rows linking out of it, or rows elsewhere linking to it. */
  private relations(noteId: string, direction: 'out' | 'in'): Array<{ text: string; otherId: string | null }> {
    const title = requireVaultNote(this.options.database, noteId).title;
    const rows = RelationRowsSchema.parse(direction === 'out'
      ? this.options.database.prepare(`
          SELECT l.row_label AS label, k.note_id AS other_id, l.target_key AS other_key FROM vault_links l
          LEFT JOIN vault_key_owners k ON k.key = l.target_key WHERE l.from_note_id = ? AND l.row_label IS NOT NULL ORDER BY l.line
        `).all(noteId)
      : this.options.database.prepare(`
          SELECT l.row_label AS label, l.from_note_id AS other_id, l.from_note_id AS other_key FROM vault_links l
          JOIN vault_key_owners k ON k.key = l.target_key WHERE k.note_id = ? AND l.from_note_id <> ? AND l.row_label IS NOT NULL
        `).all(noteId, noteId));
    return rows.map((row) => {
      const other = row.other_id === null ? row.other_key : readVaultNote(this.options.database, row.other_id)?.title ?? row.other_key;
      return { text: direction === 'out' ? `${title} —${row.label}→ ${other}` : `${other} —${row.label}→ ${title}`, otherId: row.other_id };
    });
  }

  private neighbors(args: z.infer<typeof NeighborsArgsSchema>): string {
    const root = this.options.store.resolve(args.title);
    if (root === null) return `no note "${args.title}"`;
    const lines = new Set<string>();
    const listed = new Set<string>([root.id]);
    let frontier = [root.id];
    for (let level = 0; level < args.depth; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const relation of [...this.relations(id, 'out'), ...this.relations(id, 'in')]) {
          lines.add(relation.text);
          if (relation.otherId !== null && !listed.has(relation.otherId)) { listed.add(relation.otherId); next.push(relation.otherId); }
        }
      }
      frontier = next;
    }
    const nowUtc = this.options.clock.nowUtc();
    for (const id of listed) touchAccess(this.options.database, id, [], nowUtc);
    return lines.size === 0 ? `${root.title} has no labelled relations` : [...lines].join('\n');
  }

  private dayContext(): string {
    const { database, day } = this.options;
    const captures = CaptureRowsSchema.parse(database.prepare(`
      SELECT c.app, c.window_title, c.note_id FROM vault_captures c JOIN vault_notes n ON n.id = c.note_id
      WHERE n.folder = ? AND c.processed_at_utc IS NOT NULL ORDER BY c.captured_at_utc
    `).all(captureFolder(day)));
    const chats = NoteIdRowsSchema.parse(database.prepare('SELECT note_id FROM vault_chat_notes WHERE day = ?').all(day));
    const learnedOf = (id: string) => sectionLines(readVaultNote(database, id)?.body ?? '', LEARNED_HEADING) ?? [];
    return [
      `Captures on ${day}:`, ...captures.flatMap((capture) => [`- ${capture.app}${capture.window_title === null ? '' : ` · ${capture.window_title}`}`, ...learnedOf(capture.note_id).map((line) => `  ${line}`)]),
      `Chat notes on ${day} (${CHATS_FOLDER}):`, ...chats.flatMap((chat) => [`- ${readVaultNote(database, chat.note_id)?.title ?? chat.note_id}`, ...learnedOf(chat.note_id).map((line) => `  ${line}`)]),
    ].join('\n');
  }
}

```


- [ ] **Step 4: Create `src/vault/note-writer/agent/definitions.ts`.**

```ts
import type { AgentLoopFinishAction } from '../../../agent-loop/types.ts';
import { JsonObjectSchema, type JsonObject } from '../../../lib/json-types.ts';
import type { InferenceToolDefinition } from '../../../llm-protocol/types.ts';
import { z } from '../../../lib/zod.ts';
import { buildPlannerJsonSchema, type PlannerToolDefinition } from '../../../planner-protocol/json-schema.ts';
import { VaultEditResponseSchema } from '../edit-ops.ts';
import { DayContextArgsSchema, NeighborsArgsSchema, ReadNoteArgsSchema, SearchNotesArgsSchema } from './tools.ts';

function readTool<T extends z.ZodType>(name: string, description: string, schema: T, exampleArgs: JsonObject): PlannerToolDefinition {
  return {
    kind: 'tool', type: 'function', exampleArgs,
    argumentSchema: schema.transform((args) => JsonObjectSchema.parse(args)),
    function: { name, description, parameters: buildPlannerJsonSchema(schema) },
  };
}

export const SUBMIT_EDITS_TOOL: PlannerToolDefinition = {
  kind: 'finish', type: 'function', exampleArgs: { operations: [] },
  argumentSchema: VaultEditResponseSchema.transform((args): AgentLoopFinishAction => ({ kind: 'finish', text: '', rawAction: JsonObjectSchema.parse(args) })),
  function: { name: 'submit_edits', description: 'Submit the final vault edits. This ends the job.', parameters: buildPlannerJsonSchema(VaultEditResponseSchema) },
};

export const VAULT_WRITER_TOOLS: readonly PlannerToolDefinition[] = [
  readTool('search_notes', 'Full-text search over note titles, aliases and bodies. Returns title, folder, types, aliases and a snippet.', SearchNotesArgsSchema, { query: 'neovim', limit: 5 }),
  readTool('read_note', 'Read one note by title or alias: lead, fact values with their ages, open tasks, unverified items, aliases, backlinks. 40 values per page.', ReadNoteArgsSchema, { title: 'Neovim', page: 1 }),
  readTool('neighbors', 'Labelled relations around a note (A —Label→ B), one or two hops.', NeighborsArgsSchema, { title: 'Neovim', depth: 1 }),
  readTool('day_context', "Today's earlier captures and chat notes with what they taught.", DayContextArgsSchema, {}),
  SUBMIT_EDITS_TOOL,
];

export const toInferenceTool = (definition: PlannerToolDefinition): InferenceToolDefinition => ({ type: 'function', function: definition.function });
```

- [ ] **Step 5: Create `src/vault/note-writer/agent/cards.ts`.**

```ts
import { parseNoteBody, type VaultNote } from '@siftkit/contracts';

import { QueryIntentExtractor } from '../../../assistant/retrieval/query-intent.ts';
import type { RuntimeDatabase } from '../../../state/runtime-db.ts';
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

const cardOf = (note: VaultNote) => {
  const parsed = parseNoteBody(note.body);
  return [
    `### ${note.title} · ${note.folder || 'no folder'} · ${note.types.join(', ') || 'untyped'}${note.aliases.length === 0 ? '' : ` · aliases: ${note.aliases.join(', ')}`}`,
    parsed.lead?.text ?? '', `rows: ${parsed.factRows.map((row) => row.label).join(', ') || 'none'}`,
  ].filter((line) => line.length > 0).join('\n');
};

/** Top 5 full-text matches as cards, then the next 15 as titles only. Cards stamp their notes accessed. */
export function candidateCards(database: RuntimeDatabase, sourceText: string, nowUtc: string): { readonly text: string } {
  const ownerId = findOwnerNote(database)?.id ?? null;
  const notes = searchNoteIds(database, new QueryIntentExtractor().extract(sourceText).terms, ['entity'], CANDIDATE_CARDS + KNOWN_TITLES + 1)
    .filter((id) => id !== ownerId).flatMap((id) => readVaultNote(database, id) ?? []);
  const cards = notes.slice(0, CANDIDATE_CARDS);
  for (const note of cards) touchAccess(database, note.id, [], nowUtc);
  const titles = notes.slice(CANDIDATE_CARDS, CANDIDATE_CARDS + KNOWN_TITLES).map((note) => `- ${note.title}`);
  return {
    text: [
      '## Likely related notes', ...(cards.length === 0 ? ['none'] : cards.map(cardOf)),
      '## Other known titles', ...(titles.length === 0 ? ['none'] : titles),
    ].join('\n\n'),
  };
}

/** One card per queued note; values listed stalest first with their ages (spec §3.1). */
export function reviewCards(database: RuntimeDatabase, queue: VaultValidationQueue, noteIds: readonly string[], nowUtc: string): string {
  return noteIds.flatMap((id) => {
    const note = readVaultNote(database, id);
    if (note === null) return [];
    const facts = queue.staleFacts(id).slice(0, READ_PAGE_VALUES);
    touchAccess(database, id, facts.map((row) => ({ labelKey: row.label_key, valueKey: row.value_key })), nowUtc);
    return [[cardOf(note), ...facts.map((row) => `- **${row.label}** ${row.value} — ${factAges(row, nowUtc)}`)].join('\n')];
  }).join('\n\n');
}
```

- [ ] **Step 6: Run the test and confirm it passes.** Run: `node ./src/test-runner/run-tests.ts vault-writer-tools`. Expected: PASS. Fix the expected strings, not the code, only where the fixture's folder or types differ from the assumption. Behaviour assertions (aliases resolve, ages, paging, stamping, relations) must hold as written.

- [ ] **Step 7: Leave uncommitted.**

---

### Task 8: Tool-capable inference client

**Files:**
- Modify: `src/assistant/inference/client.ts`, `src/assistant/inference/roles.ts`, `src/agent-loop/types.ts`, `tests/helpers/assistant-inference-fake.ts`
- Test: `tests/assistant-inference-client.test.ts`

- [ ] **Step 1: Write the failing test.** Replace `tests/assistant-inference-client.test.ts` with tests for the new method, following the recorder backend style it already uses (an `AssistantChatBackend` that records `InferenceChatOptions`):

```ts
test('chat sends the tools, attaches admitted images to the first user message only, and turns reasoning off', async () => {
  const backend = new RecordingBackend(); // returns a fixed NormalizedInferenceChatResponse
  const client = new DefaultAssistantInferenceClient(TEST_CONFIG, { getPreset: () => VISION_PRESET }, backend);
  await client.chat({
    role: 'vault_writer',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'seed' }, { role: 'user', content: 'later' }],
    images: [PNG_DATA_URL], tools: [SEARCH_TOOL], abortSignal: new AbortController().signal,
  });
  const sent = backend.requests[0];
  assert.ok(sent);
  assert.deepEqual(sent.tools, [SEARCH_TOOL]);
  assert.deepEqual(sent.allowedToolNames, ['search_notes']);
  assert.equal(sent.reasoningOverride, 'off');
  assert.equal(sent.responseFormat, undefined);
  assert.ok(Array.isArray(sent.messages[1]?.content), 'the seed message carries the image');
  assert.equal(sent.messages[2]?.content, 'later');
});

test('chat refuses an already aborted request and contextTokens reports the preset window', async () => {
  const client = new DefaultAssistantInferenceClient(TEST_CONFIG, { getPreset: () => VISION_PRESET }, new RecordingBackend());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.chat({ role: 'vault_writer', messages: [], images: [], tools: [], abortSignal: controller.signal }), /aborted/);
  assert.equal(client.contextTokens(), getConfiguredContextTokens(TEST_CONFIG).totalContextTokens);
});
```

Reuse the fixtures (`TEST_CONFIG`, a vision preset, a PNG data URL, the recorder) the current file already defines for the `complete` tests. Delete the `complete` tests.

- [ ] **Step 2: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts assistant-inference-client`. Expected: FAIL, `chat` does not exist.

- [ ] **Step 3: Implement.** In `roles.ts`:

```ts
export const ASSISTANT_INFERENCE_ROLES = ['vault_writer'] as const;
export const ROLE_PROMPT_VERSION = { vault_writer: '1' } as const satisfies Record<AssistantInferenceRole, string>;
```

The preamble text changes its last line to `Use only the provided read-only tools, then submit the requested edits.` instead of "Produce only the requested structured description…".

In `client.ts`, **add** alongside `complete` (Task 10 deletes `complete`):

```ts
export interface AssistantAgentTurnRequest {
  readonly role: AssistantInferenceRole;
  readonly messages: readonly InferenceChatMessage[];
  /** Attached to the first user message; empty for text-only sources. */
  readonly images: readonly ImageDataUrl[];
  readonly tools: readonly InferenceToolDefinition[];
  readonly abortSignal: AbortSignal;
}
```

Add `chat(request: AssistantAgentTurnRequest): Promise<NormalizedInferenceChatResponse>;` and `contextTokens(): number;` to `AssistantInferenceClient`. Implement them in `DefaultAssistantInferenceClient`:

```ts
/** One agent turn may submit up to 30 operations. */
const AGENT_MAX_OUTPUT_TOKENS = 4_096;

  async chat(request: AssistantAgentTurnRequest): Promise<NormalizedInferenceChatResponse> {
    if (request.abortSignal.aborted) throw new Error('Assistant inference aborted before the request was issued.');
    const operationId = randomUUID();
    const model = getConfiguredModel(this.config);
    return this.backend.chat({
      config: this.config, model,
      messages: this.withImages(request.messages, request.images),
      tools: [...request.tools],
      allowedToolNames: request.tools.map((tool) => tool.function.name),
      maxTokens: AGENT_MAX_OUTPUT_TOKENS,
      idleTimeoutSeconds: ASSISTANT_IDLE_TIMEOUT_SECONDS,
      reasoningOverride: 'off',
      throughputAudit: { operationType: 'assistant', operationId, requestId: operationId, stage: `agent_${request.role}`, model, presetId: this.presets.getPreset().id },
      abortSignal: request.abortSignal,
    });
  }

  contextTokens(): number {
    return getConfiguredContextTokens(this.config).totalContextTokens;
  }

  private withImages(messages: readonly InferenceChatMessage[], images: readonly ImageDataUrl[]): InferenceChatMessage[] {
    if (images.length === 0) return [...messages];
    const admitted = admitImagesForPreset(this.presets.getPreset(), images).map((image) => image.dataUrl);
    const first = messages.findIndex((message) => message.role === 'user');
    return messages.map((message, index) => (index === first && typeof message.content === 'string'
      ? { ...message, content: buildUserContent(message.content, admitted) } : message));
  }
```

Import `getConfiguredContextTokens` from `../../config/index.ts` (check that it is re-exported there; if not, from `../../config/getters.ts`). Import `InferenceChatMessage` and `InferenceToolDefinition` from `../../llm-protocol/types.ts`.

In `src/agent-loop/types.ts`: `export type AgentLoopKind = 'repo-search' | 'chat' | 'summary-planner' | 'vault-writer';`

Rewrite `tests/helpers/assistant-inference-fake.ts` as a scripted agent fake (the old `complete` stays until Task 10, throwing `'complete() is retired'`):

```ts
import { CLEAN_STREAM_STOP, type NormalizedInferenceChatResponse } from '../../src/llm-protocol/types.ts';
import type { JsonObject } from '../../src/lib/json-types.ts';
import type { AssistantAgentTurnRequest, AssistantInferenceClient } from '../../src/assistant/inference/client.ts';

export type FakeAgentTurn =
  | { readonly kind: 'tools'; readonly calls: readonly { readonly name: string; readonly args: JsonObject }[] }
  | { readonly kind: 'text'; readonly text: string };

export const toolTurn = (name: string, args: JsonObject): FakeAgentTurn => ({ kind: 'tools', calls: [{ name, args }] });
export const submitTurn = (operations: readonly JsonObject[]): FakeAgentTurn => toolTurn('submit_edits', { operations: [...operations] });

/** Replays scripted agent turns in order; running out is a test bug and throws. */
export class FakeAssistantInference implements AssistantInferenceClient {
  readonly requests: AssistantAgentTurnRequest[] = [];
  private readonly remaining: FakeAgentTurn[];
  private readonly window: number;
  private readonly promptTokensPerTurn: number;
  /** Aborts this controller when the given turn is requested, to simulate preemption. */
  abortOnTurn: { readonly turn: number; readonly controller: AbortController } | null = null;

  constructor(turns: readonly FakeAgentTurn[], options: { readonly contextTokens?: number; readonly promptTokensPerTurn?: number } = {}) {
    this.remaining = [...turns];
    this.window = options.contextTokens ?? 100_000;
    this.promptTokensPerTurn = options.promptTokensPerTurn ?? 1_000;
  }

  contextTokens(): number { return this.window; }

  async chat(request: AssistantAgentTurnRequest): Promise<NormalizedInferenceChatResponse> {
    this.requests.push(request);
    if (this.abortOnTurn?.turn === this.requests.length) {
      this.abortOnTurn.controller.abort();
      throw new Error('aborted mid-request');
    }
    const next = this.remaining.shift();
    if (next === undefined) throw new Error(`FakeAssistantInference ran out of turns on request ${this.requests.length}.`);
    const text = next.kind === 'text' ? next.text : '';
    return {
      text, rawText: text, narrationText: text, classification: 'narration', reasoningText: '',
      toolCalls: next.kind === 'tools'
        ? next.calls.map((call, index) => ({ id: `call_${this.requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
        : [],
      usage: { promptTokens: this.promptTokensPerTurn * this.requests.length, completionTokens: 50, totalTokens: null, outputTokens: 50, thinkingTokens: 0, promptCacheTokens: null, promptEvalTokens: null },
      raw: {}, stop: CLEAN_STREAM_STOP,
    };
  }
}
```

Match `InferenceUsage`'s exact field list in `src/llm-protocol/types.ts`.

- [ ] **Step 4: Run the test and confirm it passes.** Run: `node ./src/test-runner/run-tests.ts assistant-inference-client`. Expected: PASS. `npm run typecheck` still passes; the old writers keep compiling through `complete`.

- [ ] **Step 5: Leave uncommitted.**

---

### Task 9: The agent session and `VaultNoteWriter`

**Files:**
- Create: `src/vault/note-writer/chat-turn.ts`, `src/vault/note-writer/agent/writer-job.ts`, `src/vault/note-writer/agent/prompt.ts`, `src/vault/note-writer/agent/session.ts`, `src/vault/note-writer/agent/note-writer.ts`
- Modify: `src/vault/note-writer/rejections.ts`
- Test: `tests/vault-writer-session.test.ts`, `tests/vault-note-writer.test.ts`

- [ ] **Step 1: Move the chat turn schema.** Create `src/vault/note-writer/chat-turn.ts` holding `VaultChatTurnSchema` and `VaultChatTurn`, cut verbatim from `chat-writer.ts`. Point `chat-writer.ts`, `job-types.ts` and `src/status-server/chat-memory-seam.ts` at the new module. Run `npm run typecheck`; expected PASS.

- [ ] **Step 2: Create `src/vault/note-writer/agent/writer-job.ts`.**

```ts
import { z } from '../../../lib/zod.ts';
import { VALIDATION_BATCH_MAX, VALIDATION_BATCH_MIN } from '../../validation-queue.ts';
import { VaultChatTurnSchema } from '../chat-turn.ts';

/** What one `vault_write` job asks the agent to do (spec §4.1). */
export const VaultWriterJobSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('capture'), attachmentId: z.string() }).strict(),
  z.object({ source: z.literal('chat'), turn: VaultChatTurnSchema }).strict(),
  z.object({ source: z.literal('review'), noteIds: z.array(z.string()).min(VALIDATION_BATCH_MIN).max(VALIDATION_BATCH_MAX) }).strict(),
]);
export type VaultWriterJob = z.infer<typeof VaultWriterJobSchema>;
```

- [ ] **Step 3: Write the failing session test** in `tests/vault-writer-session.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { BUDGET_SPENT_NOTICE, VAULT_WRITER_MAX_TURNS, VaultWriterSession } from '../src/vault/note-writer/agent/session.ts';
import { VaultWriterTools } from '../src/vault/note-writer/agent/tools.ts';
import { FakeAssistantInference, submitTurn, toolTurn, type FakeAgentTurn } from './helpers/assistant-inference-fake.ts';
import { TEST_META, entityInput, withVaultAsync, type VaultTestContext } from './helpers/vault-fixture.ts';

function session(context: VaultTestContext, inference: FakeAssistantInference, signal = new AbortController().signal) {
  return new VaultWriterSession({
    systemPrompt: 'sys', seedText: 'seed', images: [], inference, abortSignal: signal,
    tools: new VaultWriterTools({ database: context.database, store: context.store, clock: context.clock, day: '2026-10-24' }),
  });
}

test('tool results flow back to the model and submit_edits ends the run with the operations', async () => {
  await withVaultAsync(async (context) => {
    context.store.create(entityInput('Neovim', 'Editor.'), TEST_META);
    const inference = new FakeAssistantInference([
      toolTurn('read_note', { title: 'Neovim' }),
      submitTurn([{ op: 'add_facts', note: 'Neovim', label: 'Uses', values: ['Lua'] }]),
    ]);
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'submitted');
    if (outcome.kind !== 'submitted') return;
    assert.deepEqual(outcome.operations, [{ op: 'add_facts', note: 'Neovim', label: 'Uses', values: ['Lua'] }]);
    assert.deepEqual(outcome.trace.toolCalls, ['read_note', 'submit_edits']);
    const second = inference.requests[1]?.messages ?? [];
    assert.match(String(second.at(-1)?.content), /^# Neovim/);
    assert.equal(second.at(-1)?.role, 'tool');
  });
});

test('a bad tool argument comes back as a tool error the model corrects', async () => {
  await withVaultAsync(async (context) => {
    const inference = new FakeAssistantInference([toolTurn('read_note', { title: '' }), submitTurn([])]);
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'submitted');
    assert.match(String(inference.requests[1]?.messages.at(-1)?.content), /Error: |invalid/);
  });
});

test('no tool call gets one reminder, then the run fails as invalid_output', async () => {
  await withVaultAsync(async (context) => {
    const inference = new FakeAssistantInference([{ kind: 'text', text: 'I think it is fine.' }, { kind: 'text', text: 'Still fine.' }]);
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'invalid_output');
    if (outcome.kind === 'invalid_output') assert.equal(outcome.rawSample, 'Still fine.');
    assert.equal(inference.requests.length, 2);
  });
});

test('the turn cap forces a final submit-only turn with the budget notice', async () => {
  await withVaultAsync(async (context) => {
    const reads: FakeAgentTurn[] = Array.from({ length: VAULT_WRITER_MAX_TURNS - 1 }, () => toolTurn('day_context', {}));
    // A huge window keeps the 75% rule out of the way, so only the turn cap forces.
    const inference = new FakeAssistantInference([...reads, submitTurn([])], { contextTokens: 1_000_000_000 });
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'submitted');
    const last = inference.requests.at(-1);
    assert.deepEqual(last?.tools.map((tool) => tool.function.name), ['submit_edits']);
    assert.equal(last?.messages.at(-1)?.content, BUDGET_SPENT_NOTICE);
  });
});

test('reaching 75% of the context window forces the final turn early; a forced turn that does not submit is invalid_output', async () => {
  await withVaultAsync(async (context) => {
    const inference = new FakeAssistantInference([toolTurn('day_context', {}), toolTurn('day_context', {})], { contextTokens: 1_000, promptTokensPerTurn: 800 });
    const outcome = await session(context, inference).run();
    assert.equal(outcome.kind, 'invalid_output');
    assert.deepEqual(inference.requests[1]?.tools.map((tool) => tool.function.name), ['submit_edits']);
  });
});

test('an abort mid-loop ends the run as aborted', async () => {
  await withVaultAsync(async (context) => {
    const controller = new AbortController();
    const inference = new FakeAssistantInference([toolTurn('day_context', {}), submitTurn([])]);
    inference.abortOnTurn = { turn: 2, controller };
    assert.deepEqual(await session(context, inference, controller.signal).run(), { kind: 'aborted' });
  });
});
```

If `tests/helpers/vault-fixture.ts` has no async variant, add `withVaultAsync`, mirroring `withVault` with `await body(context)` inside the same try/finally.

- [ ] **Step 4: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts vault-writer-session`. Expected: FAIL, the module is missing.

- [ ] **Step 5: Create `src/vault/note-writer/agent/session.ts`.**

```ts
import type { ImageDataUrl } from '@siftkit/contracts';

import { AgentLoop, type AgentLoopModelClient } from '../../../agent-loop/agent-loop.ts';
import type {
  AgentLoopAction, AgentLoopActionAdapter, AgentLoopFinishAction, AgentLoopFinishEvaluation, AgentLoopInvalidResponseResult, AgentLoopKind,
  AgentLoopModelResponse, AgentLoopPreparedTurn, AgentLoopPromptAdapter, AgentLoopResponseContext, AgentLoopToolAction, AgentLoopToolAdapter,
  AgentLoopToolExecution, AgentLoopTurnOutcome,
} from '../../../agent-loop/types.ts';
import type { AssistantInferenceClient } from '../../../assistant/inference/client.ts';
import type { InferenceChatMessage, InferenceToolDefinition } from '../../../llm-protocol/types.ts';
import { NativePlannerToolCallError, parseNativePlannerActions } from '../../../planner-protocol/native-actions.ts';
import type { PlannerToolDefinition } from '../../../planner-protocol/json-schema.ts';
import { VaultEditResponseSchema, type VaultEditOp } from '../edit-ops.ts';
import { SUBMIT_EDITS_TOOL, VAULT_WRITER_TOOLS, toInferenceTool } from './definitions.ts';
import type { VaultWriterTools } from './tools.ts';

export const VAULT_WRITER_MAX_TURNS = 80;
const FORCE_AT_CONTEXT_FRACTION = 0.75;
const CHARS_PER_TOKEN = 4;
const MAX_OUTPUT_TOKENS = 4_096;
const RAW_SAMPLE_LIMIT = 500;
export const BUDGET_SPENT_NOTICE = 'Turn budget spent: submit your edits now.';
const NO_TOOL_REMINDER = 'Reply with a tool call: explore with the read-only tools, or finish with submit_edits.';

export interface VaultWriterSessionInput {
  readonly systemPrompt: string;
  readonly seedText: string;
  readonly images: readonly ImageDataUrl[];
  readonly tools: VaultWriterTools;
  readonly inference: AssistantInferenceClient;
  readonly abortSignal: AbortSignal;
}

export interface VaultWriterTrace {
  readonly turns: number;
  readonly toolCalls: readonly string[];
}

export type VaultWriterSessionOutcome =
  | { readonly kind: 'submitted'; readonly operations: readonly VaultEditOp[]; readonly trace: VaultWriterTrace }
  | { readonly kind: 'invalid_output'; readonly rawSample: string; readonly trace: VaultWriterTrace }
  | { readonly kind: 'aborted' };

/** One agent run. The four AgentLoop adapters share its message history, so one object implements them. */
export class VaultWriterSession implements AgentLoopPromptAdapter, AgentLoopActionAdapter, AgentLoopToolAdapter, AgentLoopModelClient {
  readonly kind: AgentLoopKind = 'vault-writer';
  private readonly input: VaultWriterSessionInput;
  private readonly messages: InferenceChatMessage[];
  private readonly toolCalls: string[] = [];
  private promptEstimate = 0;
  private forced = false;
  private reminded = false;
  private submitted: readonly VaultEditOp[] | null = null;
  private rawSample = '';

  constructor(input: VaultWriterSessionInput) {
    this.input = input;
    this.messages = [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.seedText }];
  }

  async run(): Promise<VaultWriterSessionOutcome> {
    const result = await new AgentLoop({ maxTurns: VAULT_WRITER_MAX_TURNS, promptAdapter: this, actionAdapter: this, toolAdapter: this, modelClient: this }).run();
    if (this.input.abortSignal.aborted) return { kind: 'aborted' };
    const trace = { turns: result.turns.length, toolCalls: [...this.toolCalls] };
    return this.submitted === null ? { kind: 'invalid_output', rawSample: this.rawSample, trace } : { kind: 'submitted', operations: this.submitted, trace };
  }

  private definitions(): readonly PlannerToolDefinition[] {
    return this.forced ? [SUBMIT_EDITS_TOOL] : VAULT_WRITER_TOOLS;
  }

  async prepareTurn(turnNumber: number): Promise<AgentLoopPreparedTurn> {
    const forced = turnNumber >= VAULT_WRITER_MAX_TURNS || this.promptEstimate >= FORCE_AT_CONTEXT_FRACTION * this.input.inference.contextTokens();
    if (forced && !this.forced) {
      this.forced = true;
      this.messages.push({ role: 'user', content: BUDGET_SPENT_NOTICE });
    }
    return {
      outcome: this.input.abortSignal.aborted ? 'stop' : 'continue', turnNumber, promptTokenCount: this.promptEstimate, maxOutputTokens: MAX_OUTPUT_TOKENS,
      messages: [...this.messages], toolDefinitions: this.definitions().map(toInferenceTool), inForcedFinishMode: this.forced,
    };
  }

  async chat(options: { turnNumber: number; preparedTurn: AgentLoopPreparedTurn; messages: InferenceChatMessage[]; tools: InferenceToolDefinition[]; allowedToolNames: string[] }): Promise<AgentLoopModelResponse> {
    try {
      const response = await this.input.inference.chat({ role: 'vault_writer', messages: options.messages, images: this.input.images, tools: options.tools, abortSignal: this.input.abortSignal });
      this.promptEstimate = (response.usage.promptTokens ?? 0) + (response.usage.completionTokens ?? 0);
      return { outcome: 'continue', response, data: null };
    } catch (error) {
      if (this.input.abortSignal.aborted) return { outcome: 'stop', data: null };
      throw error;
    }
  }

  inspectResponse(): AgentLoopTurnOutcome | null {
    return null;
  }

  parseActions(context: AgentLoopResponseContext): AgentLoopAction[] {
    return parseNativePlannerActions(context.response, { toolDefinitions: this.definitions(), contentWithoutTools: 'invalid' });
  }

  async handleInvalidResponse(context: AgentLoopResponseContext & { error: Error }): Promise<AgentLoopInvalidResponseResult> {
    const { error, response } = context;
    if (error instanceof NativePlannerToolCallError && !this.forced) {
      this.messages.push({ role: 'assistant', content: response.narrationText || null, tool_calls: [{ id: error.callId, type: 'function', function: { name: error.toolName, arguments: JSON.stringify(error.args) } }] });
      this.messages.push({ role: 'tool', tool_call_id: error.callId, content: `Error: ${error.message}` });
      return { outcome: 'continue' };
    }
    if (this.forced || this.reminded) {
      this.rawSample = response.rawText.slice(0, RAW_SAMPLE_LIMIT);
      return { outcome: 'stop' };
    }
    this.reminded = true;
    this.messages.push({ role: 'assistant', content: response.rawText }, { role: 'user', content: NO_TOOL_REMINDER });
    return { outcome: 'continue' };
  }

  async evaluateFinish(action: AgentLoopFinishAction): Promise<AgentLoopFinishEvaluation> {
    this.submitted = VaultEditResponseSchema.parse(action.rawAction).operations;
    this.toolCalls.push('submit_edits');
    return { accepted: true, outcome: 'stop' };
  }

  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    this.messages.push({
      role: 'assistant', content: context.response.narrationText || null,
      tool_calls: actions.map((action) => ({ id: action.callId, type: 'function', function: { name: action.toolName, arguments: JSON.stringify(action.args) } })),
    });
    const results = actions.map((action) => {
      const text = this.input.tools.execute(action.toolName, action.args);
      this.toolCalls.push(action.toolName);
      this.messages.push({ role: 'tool', tool_call_id: action.callId, content: text });
      this.promptEstimate += Math.ceil(text.length / CHARS_PER_TOKEN);
      return { callId: action.callId, toolName: action.toolName, args: action.args, text, raw: text };
    });
    return { outcome: 'continue', results };
  }
}
```

The "no tool call" test expects the reminder turn to count as request 2, followed by stop. With `reminded` set after the first text, the second text stops: two requests. In the 75% test, turn 1 reports promptTokens 800 + 50, which is ≥ 750, so turn 2 is forced and offers only `submit_edits`. The model calls `day_context`, which `parseNativePlannerActions` rejects as disallowed; forced, so the run stops as invalid_output.

- [ ] **Step 6: Run the session test and confirm it passes.** Run: `node ./src/test-runner/run-tests.ts vault-writer-session`. Expected: PASS.

- [ ] **Step 7: Create `src/vault/note-writer/agent/prompt.ts`.**

```ts
import { VAULT_EDIT_INSTRUCTIONS } from '../edit-ops.ts';

const EXPLORE = [
  'You maintain a personal knowledge vault of linked notes about the user.',
  'Before editing, explore: search_notes for each entity the source mentions, read_note to see what a note already holds,',
  'neighbors to check how notes relate, day_context for what earlier sources today already recorded.',
  'Never create a note another name already covers; add an alias instead. Never repeat a value a row already holds.',
  'Put each fact on the note it is about. Link known notes as [[Title]] values.',
].join('\n');

const SOURCE = {
  capture: "The image is a screenshot of the user's screen. Record what it shows about the user: tools, projects, people, places, plans and preferences.",
  chat: "Below is one chat turn. Record durable facts the user states about themselves. Skip questions, hypotheticals, quotations and requests; the assistant's reply is context only.",
  review: [
    'This is a review pass over the notes below, listed stalest values first. For each note check:',
    '- Plausibility: does each fact make common sense? Flag anything impossible, absurd, a joke, a misread or a hallucination with flag_doubt, reason "implausible: …".',
    '- Connections: does each link point to the right note, and does the relation make sense for both ends\' types? Flag a wrong one with flag_doubt, reason "bad link: …". Add links that clearly belong.',
    '- Consistency: do facts agree with each other, with neighbours and with the owner note? Flag contradictions with flag_conflict. Merge duplicates by adding an alias. Rewrite a wrong or stale lead with set_lead.',
    'Delete nothing. Submit {"operations": []} when every note checks out.',
  ].join('\n'),
} as const;

export type VaultWriterSourceKind = keyof typeof SOURCE;

export function writerInstructions(source: VaultWriterSourceKind): string {
  return [EXPLORE, SOURCE[source], VAULT_EDIT_INSTRUCTIONS].join('\n\n');
}
```

- [ ] **Step 8: Rewrite `src/vault/note-writer/rejections.ts`** for the agent's sample:

```ts
import type { SecretScanner } from '../../assistant/domain/secrets.ts';
import type { JsonObject } from '../../lib/json-types.ts';

/** Audit details for an agent run that never submitted; the raw sample is kept only when it holds no secret. */
export function outputRejectionDetails(scanner: SecretScanner, rawSample: string, turns: number): JsonObject {
  const scan = scanner.scan(rawSample);
  return {
    code: 'invalid_output', turns,
    rawSample: scan.containsSecret ? null : rawSample,
    ...(scan.containsSecret ? { rawSampleWithheld: [...scan.matchedRuleIds] } : {}),
  };
}
```

The old writers still call the old signature until Task 10 deletes them. Keep them compiling by deleting their audit `details` argument usage now: pass `outputRejectionDetails(this.scanner, outcome.rawSample, outcome.attempts)`.

- [ ] **Step 9: Write the failing note-writer test** in `tests/vault-note-writer.test.ts`. Use the service-free wiring below. Build the capture fixture the way `tests/vault-capture-writer.test.ts` builds one (intake + attachment + capability fake); copy that setup before deleting that file in Task 10.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.ts';
import { FakeAssistantInference, submitTurn, toolTurn } from './helpers/assistant-inference-fake.ts';
import { LOCAL_OWNER_ID } from '../src/assistant/storage/schema.ts';
import { TEST_META, entityInput, withVaultAsync } from './helpers/vault-fixture.ts';
import { buildNoteWriter, seedCapture, chatTurn } from './helpers/note-writer-fixture.ts';

const OWNER = LOCAL_OWNER_ID;

test('a capture finds an existing note under another name and adds facts without creating a duplicate', async () => {
  await withVaultAsync(async (context) => {
    const vscode = context.store.create(entityInput('Visual Studio Code', 'Editor.', { aliases: ['vscode'] }), TEST_META);
    const attachmentId = seedCapture(context, { app: 'Code.exe', windowTitle: 'index.ts - vscode' });
    const inference = new FakeAssistantInference([
      toolTurn('search_notes', { query: 'vscode' }),
      submitTurn([
        { op: 'create_note', title: 'VSCode', type: 'software', lead: 'Editor.' },
        { op: 'add_facts', note: 'vscode', label: 'Extensions', values: ['GitLens'] },
        { op: 'learned', note: 'Visual Studio Code', label: 'Seen', value: 'editing index.ts' },
      ]),
    ]);
    const outcome = await buildNoteWriter(context, inference).run(OWNER, { source: 'capture', attachmentId }, new AbortController().signal);
    assert.equal(outcome.kind, 'written');
    assert.equal(z.object({ count: z.number() }).parse(context.database.prepare("SELECT COUNT(*) AS count FROM vault_notes WHERE kind = 'entity'").get()).count, 1);
    assert.equal(context.store.resolve('vscode')?.id, vscode.id);
    assert.match(context.store.resolve('Visual Studio Code')?.body ?? '', /\*\*Extensions\*\* GitLens/);
    assert.equal(z.array(z.object({ day: z.string() })).parse(context.database.prepare('SELECT day FROM vault_rollup_days').all()).length, 1);
  });
});

test('a capture with no submission still closes the capture with an empty Learned section and audits the rejection', async () => {
  await withVaultAsync(async (context) => {
    const attachmentId = seedCapture(context, { app: 'Code.exe', windowTitle: 'x' });
    const inference = new FakeAssistantInference([{ kind: 'text', text: 'nothing' }, { kind: 'text', text: 'nothing' }]);
    const outcome = await buildNoteWriter(context, inference).run(OWNER, { source: 'capture', attachmentId }, new AbortController().signal);
    assert.equal(outcome.kind, 'written');
    assert.equal(z.object({ state: z.string() }).parse(context.database.prepare('SELECT state FROM vault_captures WHERE attachment_id = ?').get(attachmentId)).state, 'processed');
  });
});

test('a chat turn flags a conflict instead of overwriting', async () => {
  await withVaultAsync(async (context) => {
    context.store.create(entityInput('Denys', 'Owner.\n\n**Editor** [[Neovim]]', { tags: ['me'] }), TEST_META);
    const inference = new FakeAssistantInference([submitTurn([{ op: 'flag_conflict', note: 'Denys', label: 'Editor', value: 'Helix', conflictsWith: 'Neovim' }])]);
    await buildNoteWriter(context, inference).run(OWNER, { source: 'chat', turn: chatTurn('I switched from Neovim to Helix') }, new AbortController().signal);
    const body = context.store.resolve('Denys')?.body ?? '';
    assert.match(body, /\*\*Editor\*\* \[\[Neovim\]\]/);
    assert.match(body, /Helix #unverified \(replaces: Neovim\)/);
  });
});

test('a review flags an implausible fact and a bad link, then stamps the batch validated except the flagged values', async () => {
  await withVaultAsync(async (context) => {
    const owner = context.store.create(entityInput('Denys', 'Owner.\n\n**Learning** flying by flapping hands · Rust', { tags: ['me'] }), TEST_META);
    const project = context.store.create(entityInput('Pet Safety', 'A project.\n\n**Uses** [[Neovim]] · TypeScript'), TEST_META);
    const inference = new FakeAssistantInference([submitTurn([
      { op: 'flag_doubt', note: 'Denys', label: 'Learning', value: 'flying by flapping hands', reason: 'implausible: humans cannot fly by flapping' },
      { op: 'flag_doubt', note: 'Pet Safety', label: 'Uses', value: 'Neovim', reason: 'bad link: an editor is not part of a pet-safety project' },
    ])]);
    await buildNoteWriter(context, inference).run(OWNER, { source: 'review', noteIds: [owner.id, project.id] }, new AbortController().signal);
    const validated = z.array(z.object({ value: z.string(), validated_at_utc: z.string().nullable() })).parse(
      context.database.prepare('SELECT value, validated_at_utc FROM vault_fact_points ORDER BY value').all());
    assert.deepEqual(validated.filter((row) => row.validated_at_utc === null).map((row) => row.value).sort(), ['[[Neovim]]', 'flying by flapping hands']);
    assert.match(context.store.resolve('Denys')?.body ?? '', /#unverified \(doubt: implausible: /);
  });
});

test('an invalid review stamps nothing, and an abort writes nothing and throws for the runner to re-queue', async () => {
  await withVaultAsync(async (context) => {
    const note = context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub'), TEST_META);
    const invalid = new FakeAssistantInference([{ kind: 'text', text: 'x' }, { kind: 'text', text: 'x' }]);
    await buildNoteWriter(context, invalid).run(OWNER, { source: 'review', noteIds: [note.id] }, new AbortController().signal);
    assert.equal(z.object({ v: z.string().nullable() }).parse(context.database.prepare('SELECT validated_at_utc AS v FROM vault_notes WHERE id = ?').get(note.id)).v, null);
    const controller = new AbortController();
    const aborting = new FakeAssistantInference([toolTurn('day_context', {}), submitTurn([{ op: 'add_facts', note: 'Git', label: 'Hosts', values: ['GitLab'] }])]);
    aborting.abortOnTurn = { turn: 2, controller };
    await assert.rejects(buildNoteWriter(context, aborting).run(OWNER, { source: 'review', noteIds: [note.id] }, controller.signal), /aborted/);
    assert.doesNotMatch(context.store.resolve('Git')?.body ?? '', /GitLab/);
  });
});
```

Create `tests/helpers/note-writer-fixture.ts` with:
- `buildNoteWriter(context, inference)`, which wires `VaultNoteWriter` with a real `VaultEditApplier`, `AuditStore`, `SecretScanner`, `VaultAttachments`, a usable capability fake and a `VaultValidationQueue`;
- `seedCapture(context, { app, windowTitle })`, which submits a 1×1 PNG through `VaultCaptureIntake` and returns the attachment id;
- `chatTurn(userText)`.

Lift the setup from `tests/vault-capture-writer.test.ts` and `tests/vault-chat-writer.test.ts`.

- [ ] **Step 10: Run it and confirm it fails.** Run: `node ./src/test-runner/run-tests.ts vault-note-writer`. Expected: FAIL, the module is missing.

- [ ] **Step 11: Create `src/vault/note-writer/agent/note-writer.ts`.** It moves the bookkeeping out of `capture-writer.ts` (`readImage`, `finish`, `awaitCapability`) and `chat-writer.ts` (`message`, `chatNote`, `createChatNote`, transcript assembly, `escapeStructure`, `WITHHELD`, `SUPPRESSION_PATTERN` handling) **verbatim**, re-pointed at the agent:

```ts
export type VaultNoteWriterOutcome = { readonly kind: 'written' } | { readonly kind: 'skipped' };

export interface VaultNoteWriterOptions {
  readonly database: RuntimeDatabase;
  readonly store: VaultNoteStore;
  readonly attachments: VaultAttachments;
  readonly applier: VaultEditApplier;
  readonly audit: AuditStore;
  readonly scanner: SecretScanner;
  readonly clock: Clock;
  readonly inference: AssistantInferenceClient;
  readonly capability: AssistantImageCapabilityProvider;
  readonly queue: VaultValidationQueue;
}

/** The single note-writer (spec §2.1): runs the agent, applies its edits, then does the source's bookkeeping. */
export class VaultNoteWriter {
  // fields from options

  async run(ownerId: string, job: VaultWriterJob, signal: AbortSignal): Promise<VaultNoteWriterOutcome> {
    switch (job.source) {
      case 'capture': return this.capture(ownerId, job.attachmentId, signal);
      case 'chat': return this.chat(ownerId, job.turn, signal);
      case 'review': return this.review(ownerId, job.noteIds, signal);
    }
  }

  /** Runs the agent; an abort throws before anything is written, so the runner re-queues the job. */
  private async agent(source: VaultWriterSourceKind, seedText: string, images: readonly ImageDataUrl[], day: string, signal: AbortSignal) {
    const outcome = await new VaultWriterSession({
      systemPrompt: buildRoleSystemPrompt('vault_writer', writerInstructions(source)), seedText, images, inference: this.inference, abortSignal: signal,
      tools: new VaultWriterTools({ database: this.database, store: this.store, clock: this.clock, day }),
    }).run();
    if (outcome.kind === 'aborted') throw new Error('Vault writer aborted before writing.');
    return outcome;
  }

  private seed(sourceText: string, source: string): string {
    const nowUtc = this.clock.nowUtc();
    return [ownerCard(this.database, nowUtc), candidateCards(this.database, sourceText, nowUtc).text, source].join('\n\n');
  }

  private rejectAudit(ownerId: string, targetType: string, targetId: string, summary: string, outcome: { readonly rawSample: string; readonly trace: VaultWriterTrace }): void {
    this.audit.recordAuditEvent({ ownerId, eventType: 'vault_writer_rejected', targetType, targetId, summary, details: outputRejectionDetails(this.scanner, outcome.rawSample, outcome.trace.turns) });
  }

  private recordRollupDay(day: string): void {
    this.database.prepare('INSERT OR IGNORE INTO vault_rollup_days (day) VALUES (?)').run(day);
  }
```

`capture(ownerId, attachmentId, signal)`, step by step:
1. Mirror the old `VaultCaptureWriter.run`. `already_processed` returns `{kind:'skipped'}`. No usable capability returns `{kind:'skipped'}` after `setCaptureState(..., 'awaiting_image_capability')`. Set `processing`. A missing image runs `finish(capture, [], 'image_removed')` and returns `{kind:'written'}`. An instance-id change returns skipped after the await-capability state.
2. Build the source text `App: …\nWindow title: …` and `seedText = this.seed(`${capture.app} ${capture.window_title ?? ''}`, sourceText)`.
3. `const outcome = await this.agent('capture', seedText, [image], localDay(capture.captured_at_utc), signal);`
4. On `invalid_output`, run `rejectAudit(ownerId, 'vault_capture', attachmentId, 'Screenshot note-writer submitted no edits.', outcome)`, then `finish(capture, [], 'processed')` and `recordRollupDay`, inside one transaction. Return written.
5. On submitted, inside one transaction: `applier.apply({ ownerId, operations: outcome.operations, actor: 'note-writer · screenshot', sourceRef: attachmentId, summary: `Screenshot ${note.title}`, scopeNoteIds: [] })`, then `finish(capture, result.learned, 'processed')` and `recordRollupDay(localDay(capture.captured_at_utc))`. Return written.

`chat(ownerId, turn, signal)`, step by step:
1. Suppression returns skipped after the `turn_suppressed_by_user` audit (verbatim).
2. Build the user and assistant messages (verbatim).
3. If `user.visible` is empty, there is no agent run. Otherwise build the source text `The user wrote:\n…\n\nThe assistant replied:\n…` and run `seedText = this.seed(user.visible, sourceText)` and `this.agent('chat', seedText, [], localDay(turn.capturedAtUtc), signal)`.
4. Then the old single transaction verbatim: withheld audits, the rejection audit on `invalid_output`, apply with `scopeNoteIds: []` when submitted, transcript and Learned. Also run `recordRollupDay(localDay(turn.capturedAtUtc))` in it. Return written.

`review(ownerId, noteIds, signal)`, step by step:
1. `seedText = [ownerCard(...), '## Notes to review', reviewCards(this.database, this.queue, noteIds, nowUtc)].join('\n\n')`.
2. Run `agent('review', seedText, [], localDay(nowUtc), signal)`.
3. On `invalid_output`, audit only (`targetType: 'vault_review'`, `targetId: noteIds.join(',')`) and return skipped. Nothing is stamped.
4. On submitted, in one transaction: `const result = applier.apply({ ownerId, operations, actor: 'note-writer · review', sourceRef: 'review', summary: 'Review pass', scopeNoteIds: noteIds });`, then for each id `stampValidated(this.database, id, result.flagged.filter((point) => point.noteId === id), this.clock.nowUtc())`. Return written.

- [ ] **Step 12: Run the tests and confirm they pass.** Run: `node ./src/test-runner/run-tests.ts vault-note-writer` and `node ./src/test-runner/run-tests.ts vault-writer-session`. Expected: PASS.

- [ ] **Step 13: Leave uncommitted.**

---

### Task 10: Jobs, maintenance, config, runner, service and the removal

**Files:**
- Create: `src/vault/maintenance.ts`
- Modify: `src/assistant/jobs/job-types.ts`, `src/assistant/storage/job-store.ts`, `src/assistant/jobs/job-runner.ts`, `src/assistant/assistant-service.ts`, `src/state/schema-upgrades/vault-validation.ts`, `packages/contracts/src/config.ts`, `src/config/defaults.ts`, `src/config/normalization.ts`, `dashboard/src/tabs/settings/AssistantSettings.tsx`, `src/assistant/inference/client.ts`, `tests/helpers/assistant-inference-fake.ts`
- Delete: `src/vault/note-writer/capture-writer.ts`, `chat-writer.ts`, `tidy-pass.ts`, `candidates.ts`, `src/assistant/inference/structured-runner.ts`, `tests/vault-capture-writer.test.ts`, `tests/vault-chat-writer.test.ts`, `tests/vault-tidy-pass.test.ts`
- Test: `tests/vault-maintenance.test.ts`, `tests/assistant-job-store.test.ts`, `tests/assistant-job-runner.test.ts`, `tests/assistant-service.test.ts`, `tests/vault-validation-upgrade.test.ts`, `tests/vault-cutover-e2e.test.ts`, `tests/config-normalization.test.ts`, the dashboard settings tests

- [ ] **Step 1: Write the failing job-type and store tests.** In `tests/assistant-job-store.test.ts`, replace the per-type cases with:

```ts
test('vault_write keys and priorities follow the source; maintenance has one key', () => {
  const priorities = { ChatWrite: 800, CaptureWrite: 400, Review: 100, Maintenance: 900 };
  const turn = { sessionId: 's1', sessionTitle: 'T', userMessageId: 'm1', capturedAtUtc: '2026-10-24T09:00:00.000Z', userText: 'u', assistantText: 'a' };
  assert.equal(jobIdempotencyKey({ jobType: 'vault_write', payload: { source: 'capture', attachmentId: 'a1' } }), 'vault_write:capture:a1');
  assert.equal(jobIdempotencyKey({ jobType: 'vault_write', payload: { source: 'chat', turn } }), 'vault_write:chat:s1:m1');
  assert.equal(jobIdempotencyKey({ jobType: 'vault_write', payload: { source: 'review', noteIds: ['n1'] } }), 'vault_write:review');
  assert.equal(jobIdempotencyKey(VAULT_MAINTENANCE_REQUEST), 'vault_maintenance');
  assert.equal(jobPriority(priorities, { jobType: 'vault_write', payload: { source: 'review', noteIds: ['n1'] } }), 100);
  assert.equal(jobPriority(priorities, VAULT_MAINTENANCE_REQUEST), 900);
  assert.equal(isModelBackedJobType('vault_write'), true);
  assert.equal(isModelBackedJobType('vault_maintenance'), false);
});
```

Add a `countQueued` case (enqueue two `vault_write` and one maintenance, expect 2 for `vault_write`) and a `listLiveCaptureNoteAttachmentIds` case for a `vault_write` capture job. Rewrite the remaining cases in the file to the new request shapes.

- [ ] **Step 2: Run them and confirm they fail.** Run: `node ./src/test-runner/run-tests.ts assistant-job-store`. Expected: FAIL.

- [ ] **Step 3: Rewrite `src/assistant/jobs/job-types.ts`.**

```ts
import type { AssistantConfig } from '../../config/types.ts';
import { z } from '../../lib/zod.ts';
import { VaultWriterJobSchema, type VaultWriterJob } from '../../vault/note-writer/agent/writer-job.ts';

export const ASSISTANT_JOB_TYPES = ['vault_write', 'vault_maintenance'] as const;
export const AssistantJobTypeSchema = z.enum(ASSISTANT_JOB_TYPES);
export type AssistantJobType = z.infer<typeof AssistantJobTypeSchema>;

/** §12.1: model-backed jobs wait for the residency and resource gates; maintenance never touches the model. */
export function isModelBackedJobType(jobType: AssistantJobType): boolean {
  return jobType === 'vault_write';
}

export const AssistantJobRequestSchema = z.discriminatedUnion('jobType', [
  z.object({ jobType: z.literal('vault_write'), payload: VaultWriterJobSchema }).strict(),
  z.object({ jobType: z.literal('vault_maintenance'), payload: z.object({}).strict() }).strict(),
]);
export type AssistantJobRequest = z.infer<typeof AssistantJobRequestSchema>;

export const VAULT_MAINTENANCE_REQUEST = { jobType: 'vault_maintenance', payload: {} } as const satisfies AssistantJobRequest;

/** The configured priority of a request; a write's priority follows its source (spec §4.1). */
export function jobPriority(priorities: AssistantConfig['Background']['JobPriorities'], request: AssistantJobRequest): number {
  if (request.jobType === 'vault_maintenance') return priorities.Maintenance;
  switch (request.payload.source) {
    case 'capture': return priorities.CaptureWrite;
    case 'chat': return priorities.ChatWrite;
    case 'review': return priorities.Review;
  }
}

const vaultWriteKey = (job: VaultWriterJob): string => {
  switch (job.source) {
    case 'capture': return `vault_write:capture:${job.attachmentId}`;
    case 'chat': return `vault_write:chat:${job.turn.sessionId}:${job.turn.userMessageId}`;
    case 'review': return 'vault_write:review';
  }
};

/** One live job per key, so re-enqueueing the same work is a no-op. */
export function jobIdempotencyKey(request: AssistantJobRequest): string {
  return request.jobType === 'vault_maintenance' ? 'vault_maintenance' : vaultWriteKey(request.payload);
}
```

`MODEL_BACKED_JOB_TYPES` and its set are deleted. Search for importers (`Grep pattern="MODEL_BACKED_JOB_TYPES"`) and switch them to `isModelBackedJobType`.

In `job-store.ts`: change `enqueue` to `const parsed = AssistantJobRequestSchema.parse(request); const priority = jobPriority(priorities, parsed);` and use `parsed.jobType` / `parsed.payload`. `listLiveCaptureNoteAttachmentIds` filters `request.jobType === 'vault_write' && request.payload.source === 'capture'`. Add:

```ts
  countQueued(ownerId: string, jobType: AssistantJobType): number {
    return z.object({ count: z.number() }).parse(this.database.prepare(
      "SELECT COUNT(*) AS count FROM assistant_jobs WHERE owner_id = ? AND job_type = ? AND status = 'queued'",
    ).get(ownerId, jobType)).count;
  }
```

- [ ] **Step 4: Change the config.** In `packages/contracts/src/config.ts`:

```ts
export const AssistantJobPrioritiesSchema = z.object({
  ChatWrite: z.number().int(),
  CaptureWrite: z.number().int(),
  Review: z.number().int(),
  Maintenance: z.number().int(),
}).strict();
```

Delete `TidyPassEnabled` from the Vault schema. Keep the existing `.strict()` or non-strict choice the schema already has. In `src/config/defaults.ts`: `JobPriorities: { ChatWrite: 800, CaptureWrite: 400, Review: 100, Maintenance: 900 }` and `Vault: { CaptureImageMaxAgeDays: 0 }`. In `normalization.ts`, replace the five `integerOrDefault` lines with four for the new keys and delete the `TidyPassEnabled` line. Update `tests/config-normalization.test.ts` and `tests/config-update-endpoint.e2e.test.ts` only where they name the old keys. These files carry unrelated uncommitted edits; touch only those lines.

In `AssistantSettings.tsx`, delete the Tidy pass toggle and replace the five priority fields with:

```tsx
        <NumberField label="Chat write priority" value={priorities.ChatWrite} onChange={(ChatWrite) => patchPriorities({ ChatWrite })} />
        <NumberField label="Capture write priority" value={priorities.CaptureWrite} onChange={(CaptureWrite) => patchPriorities({ CaptureWrite })} />
        <NumberField label="Review priority" value={priorities.Review} onChange={(Review) => patchPriorities({ Review })} />
        <NumberField label="Maintenance priority" value={priorities.Maintenance} onChange={(Maintenance) => patchPriorities({ Maintenance })} />
```

Update `dashboard/tests/fixtures.ts`'s `JobPriorities`/`TidyPassEnabled` lines only, and any settings-tab test asserting the old labels.

- [ ] **Step 5: Write the failing maintenance test** in `tests/vault-maintenance.test.ts`:

```ts
test('maintenance rebuilds every pending rollup day, then enqueues one review batch only when no write is queued', () => {
  withAssistantVault((context) => { // a vault fixture that also has a JobStore and an owner row; see Step 6
    context.store.create(entityInput('Git', 'VCS.\n\n**Hosts** GitHub'), TEST_META);
    context.database.prepare("INSERT INTO vault_rollup_days (day) VALUES ('2026-10-23'), ('2026-10-24')").run();
    context.jobs.enqueue(OWNER, { jobType: 'vault_write', payload: { source: 'capture', attachmentId: 'a1' } }, PRIORITIES);
    context.maintenance.run(OWNER, CONFIG);
    assert.equal(count(context, 'SELECT COUNT(*) AS count FROM vault_rollup_days'), 0);
    assert.equal(context.jobs.countQueued(OWNER, 'vault_write'), 1, 'a waiting capture blocks the review');
    context.database.prepare("UPDATE assistant_jobs SET status = 'completed'").run();
    context.maintenance.run(OWNER, CONFIG);
    context.maintenance.run(OWNER, CONFIG);
    const reviews = context.jobs.listByStatus(OWNER, 'queued').map((job) => context.jobs.readRequest(job))
      .filter((request) => request.jobType === 'vault_write' && request.payload.source === 'review');
    assert.equal(reviews.length, 1, 'one live review at a time');
  });
});

test('maintenance runs retention with the configured limits', () => {
  // Seed two captures over a 1-byte cap and assert the oldest attachment is removed,
  // mirroring tests/vault-capture-retention.test.ts's capacity case through VaultMaintenance.run.
});
```

Write out the retention case fully by copying the capacity case from `tests/vault-capture-retention.test.ts` and calling `maintenance.run` instead of `retention.run`. `count` is `z.object({ count: z.number() }).parse(context.database.prepare(sql).get()).count`. If `listByStatus` is private, use `countQueued` plus a direct `SELECT payload_json` parse.

- [ ] **Step 6: Create `src/vault/maintenance.ts`.**

```ts
import type { Clock } from '../assistant/clock.ts';
import type { AssistantConfig } from '../config/types.ts';
import type { JobStore } from '../assistant/storage/job-store.ts';
import { z } from '../lib/zod.ts';
import type { RuntimeDatabase } from '../state/runtime-db.ts';
import { captureRetentionLimits, type VaultCaptureRetention } from './capture-retention.ts';
import type { VaultDailyRollup } from './note-writer/daily-rollup.ts';
import type { VaultValidationQueue } from './validation-queue.ts';

export interface VaultMaintenanceOptions {
  readonly database: RuntimeDatabase;
  readonly retention: VaultCaptureRetention;
  readonly rollup: VaultDailyRollup;
  readonly queue: VaultValidationQueue;
  readonly jobs: JobStore;
  readonly clock: Clock;
}

/** The one deterministic vault job (spec §2.1): retention, pending rollups, then the review trigger. */
export class VaultMaintenance {
  private readonly options: VaultMaintenanceOptions;

  constructor(options: VaultMaintenanceOptions) {
    this.options = options;
  }

  run(ownerId: string, config: AssistantConfig): void {
    const { database, retention, rollup, queue, jobs, clock } = this.options;
    retention.run(ownerId, captureRetentionLimits(config));
    for (const { day } of z.array(z.object({ day: z.string() })).parse(database.prepare('SELECT day FROM vault_rollup_days ORDER BY day').all())) {
      database.transaction(() => {
        rollup.run(day);
        database.prepare('DELETE FROM vault_rollup_days WHERE day = ?').run(day);
      })();
    }
    // Captures and chats go first; the review key keeps at most one review live.
    if (jobs.countQueued(ownerId, 'vault_write') > 0) return;
    const noteIds = queue.nextBatch(clock.nowUtc());
    if (noteIds.length > 0) jobs.enqueue(ownerId, { jobType: 'vault_write', payload: { source: 'review', noteIds } }, config.Background.JobPriorities);
  }
}
```


A running review is not counted by `countQueued`. In that case `enqueue` returns `null`, because `vault_write:review` is live, so no second review is created.

- [ ] **Step 7: Rewrite the runner.** In `job-runner.ts`, replace the five writer options with:

```ts
  readonly noteWriter: VaultNoteWriter;
  readonly maintenance: VaultMaintenance;
```

and `execute`:

```ts
  private async execute(ownerId: string, job: JobRow, signal: AbortSignal): Promise<void> {
    const request = this.options.jobs.readRequest(job);
    switch (request.jobType) {
      case 'vault_write': {
        const outcome = await this.options.noteWriter.run(ownerId, request.payload, signal);
        if (outcome.kind === 'written') this.options.jobs.enqueue(ownerId, VAULT_MAINTENANCE_REQUEST, this.config.Background.JobPriorities);
        return;
      }
      case 'vault_maintenance':
        this.options.maintenance.run(ownerId, this.config);
        return;
    }
  }
```

Delete `enqueueFollowUps` and the now-unused imports. Rewrite `tests/assistant-job-runner.test.ts` around the new options. Keep every gate, preemption, residency and lease test, enqueueing `vault_write` capture jobs where they used `capture_note`, and assert that a written job enqueues `vault_maintenance`.

- [ ] **Step 8: Rewire the service.** In `AssistantService`:
- **Constructor:** replace the writer, tidy and retention construction with the following, and pass `noteWriter` and `maintenance` to the runner.

```ts
    const queue = new VaultValidationQueue(database);
    const noteWriter = new VaultNoteWriter({ database, store, attachments, applier, audit, scanner, clock, inference: options.inference, capability: this.imageCapability, queue });
    const maintenance = new VaultMaintenance({
      database, clock, queue, jobs: this.graph.jobs,
      retention: new VaultCaptureRetention({ database, attachments, audit, clock }), rollup: new VaultDailyRollup({ database, store }),
    });
```

- **`performDrain`:** `this.enqueue(VAULT_MAINTENANCE_REQUEST);` replaces the retention enqueue.
- **`ingestCapture`:** `this.enqueue({ jobType: 'vault_write', payload: { source: 'capture', attachmentId: outcome.attachmentId } })`, and over the byte cap `this.enqueue(VAULT_MAINTENANCE_REQUEST)`.
- **`enqueueWaitingCaptures`:** `{ jobType: 'vault_write', payload: { source: 'capture', attachmentId } }`.
- **`ingestChatTurn`:** `{ jobType: 'vault_write', payload: { source: 'chat', turn } }`.
- **Clean-up:** delete the `StructuredOutputRunner` construction and every import of the deleted modules.

- [ ] **Step 9: Finish the upgrade.** Append to `upgradeVaultValidation`:

```ts
  const LIVE = "status IN ('queued', 'running', 'paused')";
  const JobPayloadRowsSchema = z.array(z.object({ id: z.string(), payload_json: z.string() }));
  const convert = database.prepare("UPDATE assistant_jobs SET job_type = 'vault_write', payload_json = ?, idempotency_key = ? WHERE id = ?");
  for (const job of JobPayloadRowsSchema.parse(database.prepare(`SELECT id, payload_json FROM assistant_jobs WHERE job_type = 'chat_note' AND ${LIVE}`).all())) {
    const request = AssistantJobRequestSchema.parse({ jobType: 'vault_write', payload: { source: 'chat', turn: parseJsonObjectText(job.payload_json) } });
    convert.run(JSON.stringify(request.payload), jobIdempotencyKey(request), job.id);
  }
  const insertDay = database.prepare('INSERT OR IGNORE INTO vault_rollup_days (day) VALUES (?)');
  for (const job of JobPayloadRowsSchema.parse(database.prepare(`SELECT id, payload_json FROM assistant_jobs WHERE job_type = 'daily_rollup' AND ${LIVE}`).all())) {
    insertDay.run(z.object({ day: z.string() }).parse(parseJsonObjectText(job.payload_json)).day);
  }
  // Waiting captures re-queue on the next drain; maintenance re-runs retention.
  database.prepare("DELETE FROM assistant_jobs WHERE job_type IN ('chat_note', 'capture_note', 'daily_rollup', 'note_tidy', 'capture_retention')").run();
```

Hoist `LIVE` and the schema to module constants. Add a case to `tests/vault-validation-upgrade.test.ts`. In `seedSchema87`, insert a queued `chat_note` with a valid turn payload, a queued `daily_rollup` `{day:'2026-10-23'}`, a queued `capture_note`, a `note_tidy` and a completed `chat_note`. Assert that exactly one `vault_write` row remains, with key `vault_write:chat:<s>:<m>` and payload `{source:'chat', turn}`, and that `vault_rollup_days` holds `2026-10-23`.

- [ ] **Step 10: Delete the retired code.**
- **Source files:** delete `src/vault/note-writer/capture-writer.ts`, `chat-writer.ts`, `tidy-pass.ts`, `candidates.ts`, `src/assistant/inference/structured-runner.ts`, and their tests.
- **Inference client:** remove `complete`, `AssistantInferenceRequest*`, `AssistantInferenceResult`, `ASSISTANT_MAX_OUTPUT_TOKENS` and the `buildInferenceJsonSchemaResponseFormat` import from `client.ts`, and `complete` from the fake.
- **Leftover references:** run `Grep pattern="capture_note|chat_note|note_tidy|daily_rollup|capture_retention|TidyPassEnabled|CaptureNote|NoteTidy|vault_capture_writer|vault_chat_writer|vault_tidy|StructuredOutputRunner|knownNotesText|\.complete\("`. Every hit outside `src/state/schema-upgrades/` (and outside the `complete` of unrelated classes such as job-store's own `complete(jobId)`) is either converted or deleted.
- **Bench seed:** `scripts/assistant-bench/seed.ts` stays as it is unless typecheck flags it.

- [ ] **Step 11: Update the service, cutover and seam tests.**
- `tests/assistant-service.test.ts`: the capture, chat, capacity and owner tests enqueue `vault_write` and script `FakeAssistantInference` with `submitTurn([...])` instead of JSON strings. Use `queuedTypes` to assert `vault_write` and `vault_maintenance`.
- `tests/vault-cutover-e2e.test.ts`: drive one capture and one chat turn end to end with scripted agent turns, then run maintenance and assert the daily note exists.
- `tests/assistant-chat-seam.test.ts` and `tests/assistant-streaming-chat-memory.test.ts`: expect a `vault_write` chat job.
- `tests/assistant-schema.test.ts` and `tests/vault-schema.test.ts`: include the new tables and indexes in any expected-object lists.

- [ ] **Step 12: Run everything touched.** Run:

```
node ./src/test-runner/run-tests.ts assistant-
node ./src/test-runner/run-tests.ts vault-
node ./src/test-runner/run-tests.ts config-
npm run typecheck
npm run lint
npx vitest run --config dashboard/vitest.config.ts dashboard/tests
```

Expected: all PASS. Fix failures in the code under test, never by weakening a valid assertion.

- [ ] **Step 13: Leave uncommitted.**

---

### Task 11: Documentation

**Files:**
- Modify: `docs/mockups/vault/note-writer-flow.html`, `docs/superpowers/specs/2026-10-24-memory-vault-design.md`

- [ ] **Step 1: Update the HTML diagram** to the new flow. Keep the page's existing styling, SVG wiring and hover tracing, and replace its content:
- **Columns:**
  1. Sources: desktop capture, chat turn, 20 s drain timer.
  2. Jobs: `vault_write` capture/chat/review with keys and priorities, plus `vault_maintenance`.
  3. Gates: idle, heartbeat, model resident, resource/GPU minutes, preemption.
  4. Workers: the note-writer agent (seed → read-only tools → `submit_edits`, 80 turns, forced at 75% of context) and maintenance (retention → rollups from `vault_rollup_days` → review trigger).
  5. Applier: one transaction; guards for near-duplicate, repeated value, unknown fact, set_lead scope and secrets.
  6. Vault: notes, `vault_fact_points`, `vault_rollup_days`, the Review view.
- **Triggers table:** what enqueues each job (§4.1).
- **Timeline:** capture → write → maintenance → rollup → review.
- **Prompt shape:** owner card, 5 candidate cards, 15 titles, source; review cards with ages.
- **Gaps section:** replace with "Validation loop": access stamps from chat retrieval and agent reads, the queue order, and Keep/Drop.

No personal data: use invented example notes ("Neovim", "Pet Safety").

- [ ] **Step 2: Update the memory vault spec.** In `2026-10-24-memory-vault-design.md` §4.2, replace the writer descriptions with a short pointer to the note-writer agent spec and the four writers (agent, maintenance, intake, owner sync). In the phase list, add a phase "Note-writer agent and validation queue", linking `2026-10-27-vault-note-writer-agent-design.md`.

- [ ] **Step 3: Leave uncommitted.**

---

### Task 12: Live validation against the running preset (scratch only)

**Files:**
- Create (scratch, deleted at the end): `.siftkit/tmp/vault-live/run.ts`, `.siftkit/tmp/vault-live/runtime.sqlite`, the copied attachments, `.siftkit/tmp/vault-live/report.md`

- [ ] **Step 1: Copy the live data.**
  1. Check the attachment root in `src/vault/attachments.ts`, the directory under `runtimeRoot` that `VaultAttachments` reads.
  2. Write `.siftkit/tmp/vault-live/copy.ts`. It opens `.siftkit/runtime.sqlite` read-only with better-sqlite3 and calls `.backup('.siftkit/tmp/vault-live/runtime.sqlite')`, which stays consistent while the server runs. It then copies the attachment directory into `.siftkit/tmp/vault-live/` under the same relative layout.
  3. Run it with `node .siftkit/tmp/vault-live/copy.ts`.
  4. Never open the live file read-write.

- [ ] **Step 2: Write the harness** `.siftkit/tmp/vault-live/run.ts`.
  1. **Open the copy.** Use `getRuntimeDatabase` on the copy, which upgrades it to 88 and backfills fact points.
  2. **Load the running preset.** Use the repo's config loader (the same one the status server uses in `src/status-server/index.ts`). Build `DefaultAssistantInferenceClient(config, { getPreset: () => getActiveModelPreset(config) })`.
  3. **Build the writer.** Wire `VaultNoteWriter` like the service does, with `runtimeRoot` set to `.siftkit/tmp/vault-live`, a capability provider that reports the preset as usable, and a `VaultValidationQueue`.
  4. **Record the trace.** Wrap the real client in a scratch `RecordingInference implements AssistantInferenceClient` that delegates `chat` and `contextTokens`, and records each response's `toolCalls` (name and parsed args) under the current job. That yields the tools called, the notes read (`read_note` / `neighbors` titles) and the submitted operations (`submit_edits` args).
  5. **Captures.** For up to 10 captures in state `queued` or `awaiting_image_capability`, oldest first, run `writer.run(LOCAL_OWNER_ID, { source: 'capture', attachmentId }, new AbortController().signal)`.
  6. **Review batch.** Run one review job with `queue.nextBatch(now)`.
  7. **Report per job** to `.siftkit/tmp/vault-live/report.md`:
     - every tool called, with its args;
     - the notes read;
     - the operations submitted;
     - the flags raised;
     - the applier decisions: `vault_edit_dropped` and `vault_edit_merged` audit rows created during the job, read from the copy's audit table;
     - wall time.

- [ ] **Step 3: Run it.** Check the status server is idle (no chat in flight), then run `node .siftkit/tmp/vault-live/run.ts`. The model must be loaded with a vision-capable preset. If it is not, stop and tell the user rather than loading it.

- [ ] **Step 4: Review the report.** Check that the agent searched before creating, used aliases, did not duplicate notes, and that review flags make sense. Summarise the findings to the user **without pasting personal content into any tracked file**. If the agent misbehaves (for example never calls tools, or creates duplicates), fix the prompt or guards with a failing test first, then re-run.

- [ ] **Step 5: Confirm the live vault is untouched.** Compare the `mtime` of `.siftkit/runtime.sqlite` before and after the run; only server activity may change it. The copy is never written back.

---

### Task 13: Final verification and clean-up

- [ ] **Step 1: Run the full suites.**

```
npm test
npm run test:dashboard
npm run typecheck
npm run lint
```

Expected: all PASS. Record any pre-existing failures unrelated to this work separately, with evidence (they fail on a clean checkout of the touched files too).

- [ ] **Step 2: Search for leftovers.** Run the Task 10 Step 10 grep again; there are no hits outside schema upgrades. `git status` shows no deleted-but-imported files and no scratch files outside `.siftkit/tmp`.

- [ ] **Step 3: Delete the scratch files.** `rm -rf .siftkit/tmp/vault-live` (also deleting the copied `runtime.sqlite` and attachments) and any other files this plan created in `.siftkit/tmp`.

- [ ] **Step 4: Report** the result, changed files, validation (commands and outcomes), the live-validation summary, the four spec refinements listed at the top, and the risks. Do not commit.
