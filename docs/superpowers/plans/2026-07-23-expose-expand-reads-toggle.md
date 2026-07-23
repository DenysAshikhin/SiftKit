# Repo-Search/Agent Read+Edit Tooling: CRLF Fix + Expand-Reads Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the repo-agent `read`/`edit` CRLF asymmetry that makes multi-line edits fail and pollutes commits with mixed line endings (Part A), and turn the already-declared-but-unwired "Expand reads" dashboard field into a real `ExpandReads` config toggle wired end-to-end (Part B).

**Architecture:**
- **Part A (CRLF):** The `read` tool normalizes CRLF→LF so the model only ever sees LF; the `edit` tool reads raw bytes and byte-matches `oldText`. On Windows (`core.autocrlf=true`, no `.gitattributes`) the working tree is CRLF, so a model-authored multi-line `oldText` (LF) never `indexOf`-matches the CRLF file → thrash. The fix routes both `read` and `edit` through one shared `readSourceText` normalization helper, so `edit` matches on LF and writes back uniform-LF text; a root `.gitattributes` (`* text=auto eol=lf`) makes the repo's EOL deterministic regardless of any tool or contributor's `core.autocrlf`.
- **Part B (ExpandReads):** `ExpandReads` is a global `SiftConfig` boolean (defaults `true`, preserving today's always-on behavior), persisted as a new `app_config.expand_reads` SQLite column, resolved by a single getter `isReadExpansionEnabled(config)`. Two read planners consult it — `planRead` (repo-search `read`) and the summary planner's `read_lines`. When disabled, a repeated read runs the exact requested window unchanged while overlap is still tracked. The dashboard General section renders a checkbox bound to `dashboardConfig.ExpandReads`.

**Tech Stack:** TypeScript, Zod (`@siftkit/contracts`), better-sqlite3, React (dashboard), `node:test`.

**Source of both fixes:**
- Part A handoff: [docs/superpowers/handoffs/2026-07-23-repo-agent-crlf-edit-matching.md](../handoffs/2026-07-23-repo-agent-crlf-edit-matching.md).
- Part B: the "Expand reads" descriptor + tooltip test already exist ([dashboard/src/settings-sections.ts:49](../../../dashboard/src/settings-sections.ts#L49), [tests/settings-sections.test.ts:28](../../../tests/settings-sections.test.ts#L28)) but nothing renders/reads it and no schema key exists.

**Current-state facts (verified in code):**
- `read` normalizes: `readTextFileWithEncoding(...).replace(/\r\n/gu, '\n')` ([repo-tools.ts:354](../../../src/repo-search/engine/repo-tools.ts#L354)). `edit` does not: `readTextFileWithEncoding(...)` raw ([repo-tools.ts:644](../../../src/repo-search/engine/repo-tools.ts#L644)), matched byte-exact via `originalText.indexOf(oldText)` ([:609](../../../src/repo-search/engine/repo-tools.ts#L609)), spliced + written utf8 ([:652](../../../src/repo-search/engine/repo-tools.ts#L652), [:656](../../../src/repo-search/engine/repo-tools.ts#L656)). `readTextFileWithEncoding` is used at exactly these two sites in `repo-tools.ts` (import at [:8](../../../src/repo-search/engine/repo-tools.ts#L8)).
- `write` already writes the model's LF content directly ([repo-tools.ts:588](../../../src/repo-search/engine/repo-tools.ts#L588)) — no CRLF exposure, no change needed.
- Expansion is unconditional today: on a *repeated* read, `planRead` widens `totalEnd` to EOF and skips returned ranges ([repo-tools.ts:362-368](../../../src/repo-search/engine/repo-tools.ts#L362-L368)); identical mechanism in the summary planner ([mode.ts:1025-1030](../../../src/summary/planner/mode.ts#L1025-L1030)). First reads are unaffected.
- `DashboardConfig = SiftConfig` ([packages/contracts/src/config.ts:183](../../../packages/contracts/src/config.ts#L183)); adding the schema key propagates the type to backend + dashboard.
- `ToolActionProcessorDeps.config` and `SummaryPlannerLoopRuntime.options.config` already carry the config at both call sites — no new threading of `config` itself is needed.

**File Structure:**
- Modify `src/lib/text-encoding.ts` — add `readSourceText` (single CRLF→LF normalization point).
- Modify `src/repo-search/engine/repo-tools.ts` — route `read` + `edit` through `readSourceText`; add `ExpandReads` gating + `expandReads` param/context field.
- Create `.gitattributes` (repo root) — `* text=auto eol=lf`.
- Modify `packages/contracts/src/config.ts`, `src/config/defaults.ts`, `src/config/getters.ts`, `src/config/index.ts` — schema key, default, getter.
- Modify `src/state/runtime-db.ts`, `src/status-server/config-store.ts` — persistence.
- Modify `src/repo-search/engine/tool-action-processor.ts`, `src/summary/planner/mode.ts` — consult the getter.
- Modify `dashboard/src/tabs/SettingsTab.tsx` — render the toggle.
- Modify `dashboard/tests/fixtures.ts`, `tests/helpers/runtime-config.ts` — add `ExpandReads` to the two strictly-typed full-config literals.
- Tests: `tests/repo-tools.test.ts`, `tests/gitattributes.test.ts` (new), `tests/presets.test.ts`, `tests/config-normalization.test.ts`, `tests/mock-repo-search-loop.test.ts`, `tests/summary-read-lines-expansion.test.ts` (new), `dashboard/tests/settings-tab.test.tsx`.

**User directives:** No worktree (CLAUDE.md: AVOID worktrees). No backward-compat shims — the CRLF fix is a complete, symmetric refactor through one helper, not a patch at each call site. `ExpandReads` default `true` is the intended default (expansion on unless the operator opts out), matching `IncludeAgentsMd`/`IncludeRepoFileListing`.

**Out of scope (explicit):** The handoff's second Task-1 symptom — the agent emitting malformed actions after a successful terminal commit and dying on `invalid_response_limit` instead of recognizing completion — is an independent agent-behavior/prompt problem. It is NOT addressed here and needs its own plan (completion checkpoint after a successful commit, and/or a system-prompt rule that once acceptance criteria are met the next action must be `finish`).

---

## Part A — CRLF edit-matching fix

### Task 1: Normalize `read` and `edit` through one `readSourceText` helper

**Files:**
- Modify: `src/lib/text-encoding.ts:73-75`
- Modify: `src/repo-search/engine/repo-tools.ts:8` (import), `:354` (read), `:644` (edit read)
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/repo-tools.test.ts`, after the `edit applies multiple disjoint replacements against the original file` test (ends ~line 305), add:

```typescript
test('edit matches a model-authored multi-line LF oldText against a CRLF-on-disk file', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'line1\r\nalpha\r\nline3\r\nline5\r\n', 'utf8');
  // The model read the file normalized (LF), so its oldText uses \n.
  const result = await executeRepoTool('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'line1\nalpha', newText: 'first\nbeta' }],
  }, makeContext(root));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const after = fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8');
  assert.equal(after, 'first\nbeta\nline3\nline5\n');
  assert.equal(after.includes('\r'), false);
});

test('edit rewrites a CRLF file as uniform LF (no mixed endings)', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'keep1\r\ntarget\r\nkeep3\r\n', 'utf8');
  const result = await executeRepoTool('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }, makeContext(root));
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const after = fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8');
  assert.equal(after.includes('\r'), false);
  assert.equal(after, 'keep1\nchanged\nkeep3\n');
});
```

(The existing LF-file edit tests at lines 297-340 remain as the regression guard.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/repo-tools.test.ts`
Expected: the multi-line CRLF test FAILS with `oldText not found in file` (byte-exact match against CRLF bytes); the mixed-endings test FAILS because the surviving `keep1`/`keep3` lines are still CRLF.

- [ ] **Step 3: Add the shared normalization helper**

In `src/lib/text-encoding.ts`, after `readTextFileWithEncoding` (lines 73-75), add:

```typescript
/**
 * Reads a text file and normalizes CRLF → LF. This is the single source-text
 * normalization point: `read`, `edit`, and any future consumer must go through
 * it so the model always sees — and matches against — LF, regardless of the
 * working tree's on-disk line endings.
 */
export function readSourceText(filePath: string): string {
  return readTextFileWithEncoding(filePath).replace(/\r\n/gu, '\n');
}
```

- [ ] **Step 4: Route `read` and `edit` through the helper**

In `src/repo-search/engine/repo-tools.ts`, change the import (line 8) — `readTextFileWithEncoding` is used only at the two sites below, so replace it:

```typescript
import { readSourceText } from '../../lib/text-encoding.js';
```

`planRead` (line 354):

```typescript
  const lines = readSourceText(resolvedPath.absolutePath).split('\n');
```

`executeEdit` (line 644):

```typescript
  const originalText = readSourceText(resolvedPath.absolutePath);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/repo-tools.test.ts`
Expected: PASS — new CRLF tests green; existing `read`/`edit` LF tests (including the UTF-16LE `planRead` decode test) still green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/text-encoding.ts src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix(repo-agent): normalize read+edit through readSourceText to fix CRLF edit matching"
```

---

### Task 2: Add repo-root `.gitattributes` to pin LF

**Files:**
- Create: `.gitattributes`
- Test: `tests/gitattributes.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/gitattributes.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('repo root pins line endings to LF via .gitattributes', () => {
  assert.equal(fs.existsSync('.gitattributes'), true);
  const contents = fs.readFileSync('.gitattributes', 'utf8');
  assert.match(contents, /^\*\s+text=auto\s+eol=lf\s*$/mu);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/gitattributes.test.ts`
Expected: FAIL — `.gitattributes` does not exist.

- [ ] **Step 3: Create `.gitattributes`**

Create `.gitattributes` at the repo root with exactly:

```
* text=auto eol=lf
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/gitattributes.test.ts`
Expected: PASS.

- [ ] **Step 5: Renormalize existing tracked files to LF**

Run: `git add --renormalize .`
Then inspect: `git status --short` — expect only line-ending renormalizations (if any) staged, no content changes. Review with `git diff --cached --stat` to confirm the scope is line-endings only.

- [ ] **Step 6: Commit**

```bash
git add .gitattributes tests/gitattributes.test.ts
git commit -m "chore: pin repo line endings to LF via .gitattributes"
```

> If Step 5 staged renormalized files, commit them separately: `git commit -m "chore: renormalize tracked files to LF"`.

---

## Part B — Expand-reads toggle

### Task 3: Add `ExpandReads` to the config schema, default, and typed fixtures

**Files:**
- Modify: `packages/contracts/src/config.ts:156`
- Modify: `src/config/defaults.ts:80`
- Modify: `dashboard/tests/fixtures.ts:34`
- Modify: `tests/helpers/runtime-config.ts:85`
- Test: `tests/config-normalization.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the end of `tests/config-normalization.test.ts`:

```typescript
test('default config exposes ExpandReads enabled and normalization preserves an explicit false', () => {
  const defaults = getDefaultConfig();
  assert.equal(defaults.ExpandReads, true);

  const disabled = normalizeConfig({ ...defaults, ExpandReads: false });
  assert.equal(disabled.ExpandReads, false);

  const reEnabled = normalizeConfig({ ...defaults, ExpandReads: true });
  assert.equal(reEnabled.ExpandReads, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="ExpandReads enabled"`
Expected: FAIL — `defaults.ExpandReads` is `undefined`; the build may also error that `ExpandReads` is not on `SiftConfig`.

- [ ] **Step 3: Add the schema key**

In `packages/contracts/src/config.ts`, in `SiftConfigSchema` (line 156):

```typescript
  IncludeAgentsMd: z.boolean(), IncludeRepoFileListing: z.boolean(), ExpandReads: z.boolean(),
```

- [ ] **Step 4: Add the default**

In `src/config/defaults.ts`, after `IncludeRepoFileListing: true,` (line 80):

```typescript
    IncludeRepoFileListing: true,
    ExpandReads: true,
```

- [ ] **Step 5: Update the two strictly-typed full-config literals**

In `dashboard/tests/fixtures.ts` (line 34):

```typescript
  RawLogRetention: true, IncludeAgentsMd: true, IncludeRepoFileListing: true, ExpandReads: true, PromptPrefix: '',
```

In `tests/helpers/runtime-config.ts`, in `getDefaultConfig(): SiftConfig`, after `IncludeRepoFileListing: true,` (line 85):

```typescript
    IncludeRepoFileListing: true,
    ExpandReads: true,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="ExpandReads enabled"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/config.ts src/config/defaults.ts dashboard/tests/fixtures.ts tests/helpers/runtime-config.ts tests/config-normalization.test.ts
git commit -m "feat(config): add ExpandReads schema key defaulting to true"
```

---

### Task 4: Persist `ExpandReads` in SQLite (`app_config.expand_reads`)

**Files:**
- Modify: `src/state/runtime-db.ts:36` (version), `:135` (DDL), `:1304` (migration)
- Modify: `src/status-server/config-store.ts:57` (row schema), `:142` (write map), `:175` (read map), `:224` (SELECT), `:256` (write columns)
- Test: `tests/presets.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/presets.test.ts`, after the `config persistence stores global agents.md auto-append setting in sqlite` test (ends ~line 200), add:

```typescript
test('config persistence stores global ExpandReads setting in sqlite', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    const defaultConfig = getDefaultConfig();

    assert.equal(defaultConfig.ExpandReads, true);

    writeConfig(configPath, {
      ...defaultConfig,
      ExpandReads: false,
    });
    const loaded = readConfig(configPath);

    assert.equal(loaded.ExpandReads, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="stores global ExpandReads"`
Expected: FAIL — `loaded.ExpandReads` is `true` (value not persisted; normalization fills the `true` default).

- [ ] **Step 3: Add the column to the base DDL**

In `src/state/runtime-db.ts`, `applyBaseSchema` `CREATE TABLE IF NOT EXISTS app_config` (after the `include_repo_file_listing` line, line 135):

```sql
      include_repo_file_listing INTEGER NOT NULL DEFAULT 1 CHECK (include_repo_file_listing IN (0, 1)),
      expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1)),
```

- [ ] **Step 4: Bump the schema version and add the migration**

Change the constant (line 36):

```typescript
export const CURRENT_SCHEMA_VERSION = 35;
```

After the `if (currentVersion < 34) { ... }` block (ends at `currentVersion = 34;`, ~line 1304) and before `ensureChatMessageTimelineSchema(database);`:

```typescript
  if (currentVersion < 35) {
    if (!tableHasColumn(database, 'app_config', 'expand_reads')) {
      database.exec('ALTER TABLE app_config ADD COLUMN expand_reads INTEGER NOT NULL DEFAULT 1 CHECK (expand_reads IN (0, 1));');
    }
    setSchemaVersion(database, 35);
    currentVersion = 35;
  }
```

- [ ] **Step 5: Map the column in config-store**

In `src/status-server/config-store.ts`:

(a) `AppConfigRowSchema` (after `include_repo_file_listing: z.number(),`, line 57):

```typescript
  include_repo_file_listing: z.number(),
  expand_reads: z.number(),
```

(b) `normalizeConfigToRow` (after the `include_repo_file_listing:` mapping, line 142):

```typescript
    include_repo_file_listing: normalized.IncludeRepoFileListing === false ? 0 : 1,
    expand_reads: normalized.ExpandReads === false ? 0 : 1,
```

(c) `rowToConfig` (after `IncludeRepoFileListing:`, line 175):

```typescript
    IncludeRepoFileListing: row.include_repo_file_listing !== 0,
    ExpandReads: row.expand_reads !== 0,
```

(d) `readConfigRow` SELECT (after `include_repo_file_listing,`, line 224):

```sql
      include_repo_file_listing,
      expand_reads,
```

(e) `writeConfigRow` `columns` array (after `'include_repo_file_listing',`, line 256):

```typescript
    'include_repo_file_listing',
    'expand_reads',
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="stores global ExpandReads"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/state/runtime-db.ts src/status-server/config-store.ts tests/presets.test.ts
git commit -m "feat(config-store): persist ExpandReads via app_config.expand_reads (schema v35)"
```

---

### Task 5: Add the `isReadExpansionEnabled` getter

**Files:**
- Modify: `src/config/getters.ts` (end of file)
- Modify: `src/config/index.ts:62`
- Test: `tests/config-normalization.test.ts`

- [ ] **Step 1: Write the failing test**

At the top of `tests/config-normalization.test.ts`, add the import:

```typescript
import { isReadExpansionEnabled } from '../src/config/index';
```

Then add:

```typescript
test('isReadExpansionEnabled defaults on and honors an explicit false', () => {
  const enabled = getDefaultConfig();
  assert.equal(isReadExpansionEnabled(enabled), true);
  assert.equal(isReadExpansionEnabled({ ...enabled, ExpandReads: false }), false);
  assert.equal(isReadExpansionEnabled(undefined), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="isReadExpansionEnabled defaults"`
Expected: FAIL — `isReadExpansionEnabled` is not exported.

- [ ] **Step 3: Implement the getter**

Append to `src/config/getters.ts`:

```typescript
export function isReadExpansionEnabled(config: SiftConfig | undefined): boolean {
  return config?.ExpandReads !== false;
}
```

- [ ] **Step 4: Re-export it**

In `src/config/index.ts`, add to the `from './getters.js'` block (line 51-63):

```typescript
  getMissingRuntimeFields,
  isReadExpansionEnabled,
} from './getters.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="isReadExpansionEnabled defaults"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/getters.ts src/config/index.ts tests/config-normalization.test.ts
git commit -m "feat(config): add isReadExpansionEnabled getter"
```

---

### Task 6: Gate repo-search `planRead` on `expandReads`

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:53` (`RepoToolContext`), `:333` (signature), `:362-368` (gating), `:710` (`executeRepoTool` read branch)
- Modify: `tests/repo-tools.test.ts:42` (`makeContext`)
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/repo-tools.test.ts`, after the `read skips already-returned ranges instead of re-reading them` test (ends ~line 147), add:

```typescript
test('planRead with expandReads=false runs the requested window unchanged despite prior ranges', () => {
  const root = makeRepo();
  const stateByPath = new Map();
  const first = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root), stateByPath, false);
  assert.ok(!isFailedReadPlan(first));
  const state = stateByPath.get('src\\a.ts') ?? stateByPath.get('src/a.ts');
  assert.ok(state);
  state.mergedReturnedRanges = [{ start: 1, end: 3 }];
  const second = planRead({ path: 'src/a.ts', offset: 1, limit: 2 }, root, buildIgnorePolicy(root), stateByPath, false);
  assert.ok(!isFailedReadPlan(second));
  assert.equal(second.effectiveStartLine, 1);
  assert.equal(second.effectiveEndLineExclusive, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="expandReads=false runs the requested window"`
Expected: FAIL — the 5th argument is ignored; `effectiveStartLine` is `3` (it still skips the returned range).

- [ ] **Step 3: Add `expandReads` to the signature and gate the range math**

In `src/repo-search/engine/repo-tools.ts`, change `planRead`'s signature (lines 333-338):

```typescript
export function planRead(
  args: JsonObject,
  repoRoot: string,
  ignorePolicy: IgnorePolicy,
  fileReadStateByPath?: Map<string, FileReadState>,
  expandReads: boolean = true,
): ReadPlan | FailedPlan {
```

Change the range computation (currently lines 362-368):

```typescript
  const state = fileReadStateByPath ? getOrCreateFileReadState(fileReadStateByPath, pathKey) : null;
  const hasReturnedRanges = Boolean(state && state.mergedReturnedRanges.length > 0);
  const unreadRange = findContiguousUnreadRange({
    requestedStart: clampedStart,
    totalEnd: expandReads && hasReturnedRanges ? totalEndLineExclusive : requestedEndExclusive,
    returnedRanges: expandReads ? (state?.mergedReturnedRanges ?? []) : [],
  });
```

- [ ] **Step 4: Carry `expandReads` on `RepoToolContext` and pass it through `executeRepoTool`**

`RepoToolContext` (lines 53-59):

```typescript
export type RepoToolContext = {
  repoRoot: string;
  ignorePolicy: IgnorePolicy;
  webTools: WebResearchTools;
  fileReadStateByPath?: Map<string, FileReadState>;
  expandReads: boolean;
  abortSignal?: AbortSignal;
};
```

`executeRepoTool` read branch (line 710):

```typescript
  if (toolName === 'read') {
    const plan = planRead(args, context.repoRoot, context.ignorePolicy, context.fileReadStateByPath, context.expandReads);
    return isFailedReadPlan(plan)
      ? failure('read', plan.command, plan.reason)
      : buildReadExecution('read', plan);
  }
```

- [ ] **Step 5: Update the test helper `makeContext`**

`tests/repo-tools.test.ts` (lines 42-48):

```typescript
function makeContext(root: string) {
  return {
    repoRoot: root,
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeWebTools(),
    expandReads: true,
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/repo-tools.test.ts`
Expected: PASS (new test green; existing `planRead`/`executeRepoTool` tests — including the Part A CRLF tests — still green because `expandReads` defaults `true` / `makeContext` supplies `true`).

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "feat(repo-search): gate planRead window expansion on expandReads"
```

---

### Task 7: Thread `ExpandReads` from config into the repo-search loop

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts:1` (import), `:467` (direct `planRead`), `:485-491` (`executeRepoTool` context)
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/mock-repo-search-loop.test.ts`, after the `runTaskLoop tracks per-file overlap telemetry and isolates histories across files` test (ends ~line 1674), add:

```typescript
test('runTaskLoop re-reads overlapping windows when ExpandReads is disabled', async () => {
  const repoRoot = createTempRepoRoot();
  fs.writeFileSync(
    path.join(repoRoot, 'a.ts'),
    Array.from({ length: 200 }, (_, index) => `a.ts-line-${index + 1}`).join('\n'),
    'utf8',
  );
  const result = await runTaskLoop(
    {
      id: 'task-expand-reads-disabled',
      question: 'Read a file twice.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      config: mockLoopConfig({ ...modelPresetReasoning('off'), ExpandReads: false }),
      maxTurns: 6,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      includeRepoFileListing: false,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        '{"action":"read","path":"a.ts","offset":100,"limit":20}',
        '{"action":"read","path":"a.ts","offset":110,"limit":20}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
    }
  );

  assert.equal(result.reason, 'finish');
  const overlapSummary = result.readOverlapSummary;
  // Second read (110-129) overlaps the first (100-119) by 10 lines; with expansion
  // off the window runs unchanged, so overlap is recorded rather than skipped.
  assert.equal(Number(overlapSummary?.totalOverlapLines), 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="re-reads overlapping windows when ExpandReads is disabled"`
Expected: FAIL — `totalOverlapLines` is `0` (loop still skips returned ranges; config not consulted).

- [ ] **Step 3: Import the getter**

In `src/repo-search/engine/tool-action-processor.ts`, extend the config import (line 1):

```typescript
import { isReadExpansionEnabled, type SiftConfig } from '../../config/index.js';
```

- [ ] **Step 4: Pass `expandReads` at both read call sites**

`runNativeExecution` direct read plan (line 467):

```typescript
    if (normalizedToolName === 'read') {
      const readPlan = planRead(
        toolAction.args,
        this.deps.repoRoot,
        this.deps.ignorePolicy,
        this.deps.readWindows.stateMap,
        isReadExpansionEnabled(this.deps.config),
      );
      return isFailedReadPlan(readPlan)
        ? { ok: false, command: readPlan.command, reason: readPlan.reason, toolType: normalizedToolName }
        : buildReadExecution(normalizedToolName, readPlan);
    }
```

`executeRepoTool` context (lines 485-491):

```typescript
    return executeRepoTool(normalizedToolName, toolAction.args, {
      repoRoot: this.deps.repoRoot,
      ignorePolicy: this.deps.ignorePolicy,
      webTools: this.deps.webTools,
      fileReadStateByPath: this.deps.readWindows.stateMap,
      expandReads: isReadExpansionEnabled(this.deps.config),
      abortSignal: this.deps.abortSignal,
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/mock-repo-search-loop.test.ts`
Expected: PASS (new test green; the existing `tracks per-file overlap` test still green — its config defaults `ExpandReads` to `true`).

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine/tool-action-processor.ts tests/mock-repo-search-loop.test.ts
git commit -m "feat(repo-search): consult ExpandReads config in the task loop"
```

---

### Task 8: Gate summary planner `read_lines` expansion

**Files:**
- Modify: `src/summary/planner/mode.ts:81` (import), add static helper + `:1022-1030` (delegate/gate)
- Test: `tests/summary-read-lines-expansion.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/summary-read-lines-expansion.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { SummaryPlannerLoopRuntime } from '../src/summary/planner/mode.js';

test('summary read_lines expansion is inert when ExpandReads is disabled', () => {
  const inputLineCount = 50;
  const returnedRanges = [{ start: 1, end: 11 }];

  const expanded = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount,
    returnedRanges,
    expandReads: true,
  });
  // With expansion on, a re-read past the returned block advances to the next unread line.
  assert.equal(expanded.start, 11);

  const unchanged = SummaryPlannerLoopRuntime.computeReadLinesRange({
    startLine: 1,
    endLine: 10,
    inputLineCount,
    returnedRanges,
    expandReads: false,
  });
  // With expansion off, the requested window is honored verbatim.
  assert.equal(unchanged.start, 1);
  assert.equal(unchanged.end, 11);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/summary-read-lines-expansion.test.ts`
Expected: FAIL — `SummaryPlannerLoopRuntime.computeReadLinesRange` does not exist.

- [ ] **Step 3: Add the import**

In `src/summary/planner/mode.ts`, after the `findContiguousUnreadRange` import (line 81):

```typescript
import { findContiguousUnreadRange, ToolOutputFitter, type ToolOutputTruncationUnit } from '../../tool-output-fit.js';
import { isReadExpansionEnabled } from '../../config/index.js';
```

- [ ] **Step 4: Extract the pure helper and gate it**

Add this static method to `SummaryPlannerLoopRuntime` (near the top of the class body, after the constructor):

```typescript
  static computeReadLinesRange(input: {
    startLine: number;
    endLine: number;
    inputLineCount: number;
    returnedRanges: ReadonlyArray<{ start: number; end: number }>;
    expandReads: boolean;
  }): { hasUnread: boolean; start: number; end: number } {
    const requestedStart = Math.max(1, Math.trunc(input.startLine || 1));
    const requestedEnd = Math.max(requestedStart, Math.trunc(input.endLine || requestedStart));
    const requestedEndExclusive = Math.min(requestedEnd + 1, input.inputLineCount + 1);
    const hasReturnedRanges = input.returnedRanges.length > 0;
    return findContiguousUnreadRange({
      requestedStart: Math.min(requestedStart, input.inputLineCount || 1),
      totalEnd: input.expandReads && hasReturnedRanges ? input.inputLineCount + 1 : requestedEndExclusive,
      returnedRanges: input.expandReads ? input.returnedRanges : [],
    });
  }
```

Replace the inline range computation in `resolveEffectiveToolAction` (currently lines 1022-1030) so it delegates to the helper:

```typescript
    const unreadRange = SummaryPlannerLoopRuntime.computeReadLinesRange({
      startLine: Number(toolAction.args.startLine) || 1,
      endLine: Number(toolAction.args.endLine) || (Number(toolAction.args.startLine) || 1),
      inputLineCount: this.inputLines.length,
      returnedRanges: this.readLinesReturnedRanges,
      expandReads: isReadExpansionEnabled(this.options.config),
    });
```

(Keep the existing lines below that consume `unreadRange.hasUnread` / `.start` / `.end` unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/summary-read-lines-expansion.test.ts`
Expected: PASS.

- [ ] **Step 6: Run existing summary planner tests to confirm no regression**

Run: `npm test -- tests/summary-core-runner.test.ts`
Expected: PASS (default `ExpandReads` is `true`, so summary behavior is unchanged for existing runs).

- [ ] **Step 7: Commit**

```bash
git add src/summary/planner/mode.ts tests/summary-read-lines-expansion.test.ts
git commit -m "feat(summary): gate read_lines window expansion on ExpandReads"
```

---

### Task 9: Render the "Expand reads" toggle in the dashboard

**Files:**
- Modify: `dashboard/src/tabs/SettingsTab.tsx:161`
- Test: `dashboard/tests/settings-tab.test.tsx`

- [ ] **Step 1: Write the failing test**

In `dashboard/tests/settings-tab.test.tsx`, add:

```typescript
test('general section renders an Expand reads toggle bound to config', () => {
  const enabled = render();
  assert.match(enabled, /Expand reads/);

  const disabledConfig = { ...DASHBOARD_CONFIG, ExpandReads: false };
  const disabled = render({ dashboardConfig: disabledConfig });
  assert.match(disabled, /Disabled/);
});
```

(`DASHBOARD_CONFIG` is already imported from `./fixtures`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npm test -- --test-name-pattern="Expand reads toggle"`
Expected: FAIL — the markup contains no "Expand reads" text.

- [ ] **Step 3: Render the toggle**

In `dashboard/src/tabs/SettingsTab.tsx`, insert after the "Initial repo file scan" block (ends line 161) and before "Prompt prefix":

```tsx
        {renderField('general', 'Expand reads', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={dashboardConfig.ExpandReads}
              onChange={(event) => updateSettingsDraft((next) => { next.ExpandReads = event.target.checked; })}
            />
            <span>{dashboardConfig.ExpandReads ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npm test -- --test-name-pattern="Expand reads toggle"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/tabs/SettingsTab.tsx dashboard/tests/settings-tab.test.tsx
git commit -m "feat(dashboard): render the Expand reads toggle in General settings"
```

---

### Task 10: Full build + test verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check / build the backend**

Run: `npm run build`
Expected: exits 0. (If the compiler flags any remaining full-config literal missing `ExpandReads`, add `ExpandReads: true` to it and re-run.)

- [ ] **Step 2: Build the dashboard**

Run: `cd dashboard && npm run build`
Expected: exits 0.

- [ ] **Step 3: Run the full backend test suite**

Run: `npm test`
Expected: all tests pass, including the new tests from Tasks 1-8.

- [ ] **Step 4: Run the dashboard test suite**

Run: `cd dashboard && npm test`
Expected: all tests pass, including `settings-tab` and `settings-sections`.

- [ ] **Step 5: Manual sanity check (optional)**

- CRLF: on Windows, run a `repo-agent` task that reads then multi-line-`edit`s a source file; confirm the edit applies on the first attempt and `git diff` shows a targeted, pure-LF change (no 1500-line EOL blowup).
- ExpandReads: toggle "Expand reads" off in the dashboard, save, run a repo-search that re-reads a large file; confirm via the transcript that the repeated `read` returns the requested window unchanged (does not jump to EOF). Toggle on → repeated read advances past already-returned lines.

- [ ] **Step 6: Commit any verification fixups**

```bash
git add -A
git commit -m "chore: repo tooling CRLF fix + ExpandReads toggle verification fixups"
```

---

## Self-Review

**Spec coverage:**
- Part A — CRLF `read`/`edit` asymmetry → Task 1 (shared `readSourceText`) ✓; `.gitattributes` defense-in-depth → Task 2 ✓; TDD tests (multi-line CRLF match, uniform-LF write, LF regression guard) → Task 1 ✓.
- Part B — schema key → Task 3 ✓; persistence → Task 4 ✓; getter → Task 5 ✓; `planRead` gating → Task 6 ✓; loop threading → Task 7 ✓; summary parity → Task 8 ✓; dashboard render → Task 9 ✓; full verification → Task 10 ✓.

**Handoff items explicitly handled:** CRLF matching failure (Task 1), mixed-EOL commit pollution (Task 1 — same fix, since the splice is now LF-on-LF), `.gitattributes` (Task 2), single-normalization-point suggestion (Task 1 hoists into `readSourceText`). The "ragged ending / malformed-actions-after-commit" symptom is documented as out of scope with a pointer to its own follow-up plan.

**Type consistency:** `readSourceText` is defined once and called at both read sites; `ExpandReads` (config key) vs `expandReads` (param/context/field) used consistently; getter is `isReadExpansionEnabled` everywhere; `computeReadLinesRange` defined and called with one object shape.

**Interaction check:** Part A and Part B both edit `planRead` in `repo-tools.ts` but different lines — Part A changes the file-read line (354) and `executeEdit`; Part B changes the range-math (362-368), signature, and `RepoToolContext`. Doing Part A first means `readSourceText` and the CRLF tests are already green before Part B touches the same function; the Part B `makeContext` change adds `expandReads: true`, which the Part A `executeRepoTool` CRLF tests rely on.

**Default choice:** `true` throughout (schema default, DDL `DEFAULT 1`, migration `DEFAULT 1`, getter `!== false`, param default `= true`), so every pre-existing run and test preserves today's always-on expansion; only an explicit `false` disables it.
