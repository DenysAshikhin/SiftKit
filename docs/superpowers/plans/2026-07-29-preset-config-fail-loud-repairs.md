# Preset Config Fail-Loud Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an invalid persisted preset catalog fail loudly with an actionable message and remove the silent default-substitution that the previous session introduced.

**Architecture:** `readConfig` is the single entry point every caller uses to load persisted config (status-server boot at [index.ts:216](../../../src/status-server/index.ts#L216), context build at [index.ts:284](../../../src/status-server/index.ts#L284), HTTP config routes). Wrapping the row-read-and-convert step there gives one actionable error for every caller instead of a raw `ZodError`. With that in place, the blank-`presets_json` repair branch in `parsePresetArray` can be deleted so the strict-preset design's "no migration, no repair" rule holds for every invalid catalog shape, blank included.

**Tech Stack:** TypeScript (ESM, strict), Zod v4 via `src/lib/zod.ts`, better-sqlite3, `node:test` run through `npx tsx --test`.

---

## Findings addressed

| # | Finding from the drift review | Task |
|---|---|---|
| 1 | Silent default-substitution on blank catalog, blessed by a new test | Task 2 |
| 2 | Legacy-DB crash surfaces as a raw unhandled `ZodError` with no path/column/recovery | Task 1 |
| 3 | `*.bak-executionfamily` backups scattered across two runtime roots (503 MB + 188 KB) | Task 3 |
| 4 | New test asserts against `PresetCatalog.createDefault().list()`, the same expression production uses | Task 2 (the test becomes an `assert.throws`, so the tautology is gone) |
| 5 | `parsePresetArray` typed as `ReturnType<PresetCatalog['list']>` — indirection instead of a derived type | Task 2 (the function is inlined, so the type disappears) |

**Correction to the review:** the crash site is [index.ts:216](../../../src/status-server/index.ts#L216) (`writeConfig(configPath, readConfig(configPath))`), not line 284. Line 216 runs before `createServer`, so no port is bound when it throws.

**Deliberately out of scope:** adding a `try/catch` at the `isMainModule` entry point to strip the stack trace. Once `readConfig` throws `PersistedConfigInvalidError`, line 1 of the crash output already names the database path, the underlying Zod issue, and the recovery command. Suppressing the stack is cosmetic and would need a process-spawn test to cover; not worth the machinery. Similarly, no `startStatusServer` boot test is added — its first config action *is* `readConfig`, so a boot test would exercise no new code.

---

### Task 1: Actionable error for an invalid persisted config

**Files:**
- Modify: `src/config/errors.ts` (append after line 44)
- Modify: `src/status-server/config-store.ts:284-300` (`readConfig`)
- Test: `tests/presets.test.ts`

- [ ] **Step 1: Write the failing test**

Add these imports to the top of `tests/presets.test.ts`. `PresetCatalog` and `getRuntimeDatabase` are already imported there; add only the error class:

```ts
import { PersistedConfigInvalidError } from '../src/config/errors.js';
```

Append this test at the end of `tests/presets.test.ts`. It reproduces exactly what crashed the dev server: a catalog written by a pre-refactor build, carrying the removed `executionFamily` key on every preset.

```ts
test('config persistence reports a legacy preset catalog as an actionable configuration error', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    writeConfig(configPath, getDefaultConfig());
    const legacyCatalog = PresetCatalog.createDefault().list()
      .map((preset) => ({ ...preset, executionFamily: preset.id }));
    getRuntimeDatabase(configPath).prepare(
      'UPDATE app_config SET presets_json = ? WHERE id = 1',
    ).run(JSON.stringify(legacyCatalog));

    assert.throws(() => readConfig(configPath), (error: unknown): true => {
      assert.ok(error instanceof PersistedConfigInvalidError);
      assert.match(error.message, /is invalid and is never migrated or repaired automatically/u);
      assert.match(error.message, /executionFamily/u);
      assert.match(error.message, /DELETE FROM app_config WHERE id = 1/u);
      assert.ok(error.message.includes(configPath));
      return true;
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test --test-name-pattern "actionable configuration error" .\tests\presets.test.ts`

Expected: FAIL. The thrown value is a bare `ZodError` (message is a JSON dump of `unrecognized_keys` issues), so `error instanceof PersistedConfigInvalidError` is false. The import of `PersistedConfigInvalidError` also fails to resolve until Step 3.

- [ ] **Step 3: Add the error class**

Append to `src/config/errors.ts`, matching the shape of `StatusServerUnavailableError` above it:

```ts
export class PersistedConfigInvalidError extends Error {
  constructor(configPath: string, cause: Error) {
    super([
      `SiftKit persisted configuration in ${configPath} is invalid and is never migrated or repaired automatically.`,
      `Cause: ${cause.message}`,
      'Recover by deleting the stored config row so defaults are rewritten on the next start: '
        + 'DELETE FROM app_config WHERE id = 1;',
    ].join(' '), { cause });
    this.name = 'PersistedConfigInvalidError';
  }
}
```

- [ ] **Step 4: Wrap the persisted read in `readConfig`**

In `src/status-server/config-store.ts`, add two imports next to the existing ones:

```ts
import { toError } from '../lib/errors.js';
import { PersistedConfigInvalidError } from '../config/errors.js';
```

Then replace `readConfig` (currently lines 284-300) with this. The inline IIFE is promoted to a named function so the `??` fallback reads cleanly; no new indirection is introduced.

```ts
function readPersistedConfig(configPath: string): SiftConfig | null {
  try {
    const row = readConfigRow(configPath);
    return row === null ? null : rowToConfig(row);
  } catch (error) {
    throw new PersistedConfigInvalidError(configPath, toError(error));
  }
}

function createAndPersistDefaultConfig(configPath: string): SiftConfig {
  const fallback = normalizeConfig(JsonValueSchema.parse(getDefaultConfigObject()));
  writeConfigRow(configPath, normalizeConfigToRow(fallback));
  return fallback;
}

export function readConfig(configPath: string): SiftConfig {
  const config = readPersistedConfig(configPath) ?? createAndPersistDefaultConfig(configPath);
  // The launch snapshot pins the values the managed server was actually
  // started with (which can diverge from the active preset if the user edits
  // the preset afterwards). Before any launch there is no snapshot, so the
  // active preset is the best available source for the runtime config.
  const snapshot = readRuntimeLaunchSnapshot(configPath) ?? buildRuntimeLaunchSnapshot(config);
  config.Runtime.LlamaCpp = snapshot.LlamaCpp;
  return config;
}
```

Scope note: the `try` covers only `readConfigRow` (row-shape validation) and `rowToConfig` (persisted-value parsing). It deliberately does not cover `readRuntimeLaunchSnapshot` or the default-write path, so a genuine bug in those still surfaces as itself.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test --test-name-pattern "actionable configuration error" .\tests\presets.test.ts`

Expected: PASS, 1 test.

- [ ] **Step 6: Run the whole preset suite for regressions**

Run: `npx tsx --test .\tests\presets.test.ts`

Expected: PASS, 7 tests. In particular `config persistence rejects an invalid stored preset catalog without repair` still passes: its `/Missing built-in preset 'plan'\./u` pattern is now embedded in the `Cause:` segment of the wrapper message, and `assert.throws` matches a regex against the full message.

- [ ] **Step 7: Commit**

```bash
git add src/config/errors.ts src/status-server/config-store.ts tests/presets.test.ts
git commit -m "fix: report invalid persisted config with an actionable error"
```

---

### Task 2: Remove the silent blank-catalog repair

**Files:**
- Modify: `src/status-server/config-store.ts:94-99` (delete `parsePresetArray`) and `:192` (inline the call)
- Test: `tests/presets.test.ts` (replace the test added in the previous session)

Background: [the strict-preset design](../specs/2026-07-28-complete-strict-preset-refactor-design.md) states "No migration translates legacy `executionFamily` records. A persisted legacy catalog fails with the exact Zod/configuration issue path." A blank `presets_json` is an invalid catalog, so substituting built-in defaults for it is exactly the repair the design forbids. The branch is also unreachable through supported paths: a fresh config writes a full catalog via `normalizeConfigToRow`, and the migration column default is `'[]'` (see `tests/helpers/app-config-migration-fixture.ts:34`), never `''`.

- [ ] **Step 1: Replace the existing test with its inverse**

In `tests/presets.test.ts`, delete this test in full (added in the previous session):

```ts
test('config persistence restores built-in presets when the stored catalog is blank', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    writeConfig(configPath, getDefaultConfig());
    getRuntimeDatabase(configPath).prepare(
      "UPDATE app_config SET presets_json = '' WHERE id = 1",
    ).run();

    assert.deepEqual(readConfig(configPath).Presets, PresetCatalog.createDefault().list());
  });
});
```

Replace it with:

```ts
test('config persistence rejects a blank stored preset catalog without repair', () => {
  withTempRepo((repoRoot) => {
    const configPath = path.join(repoRoot, '.siftkit', 'runtime.sqlite');
    writeConfig(configPath, getDefaultConfig());
    getRuntimeDatabase(configPath).prepare(
      "UPDATE app_config SET presets_json = '' WHERE id = 1",
    ).run();

    assert.throws(() => readConfig(configPath), (error: unknown): true => {
      assert.ok(error instanceof PersistedConfigInvalidError);
      assert.match(error.message, /DELETE FROM app_config WHERE id = 1/u);
      return true;
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test --test-name-pattern "blank stored preset catalog" .\tests\presets.test.ts`

Expected: FAIL with `Missing expected exception` — `readConfig` currently returns built-in defaults instead of throwing.

- [ ] **Step 3: Confirm `parsePresetArray` has exactly one caller**

Run: `rg -n "parsePresetArray" src tests`

Expected: exactly two hits — the definition at `src/status-server/config-store.ts:94` and the call at `src/status-server/config-store.ts:192`. If any other caller appears, stop and re-plan; the inline below assumes a single call site.

- [ ] **Step 4: Delete the function and inline the call**

In `src/status-server/config-store.ts`, delete lines 94-99 entirely:

```ts
function parsePresetArray(text: OptionalJsonValue): ReturnType<PresetCatalog['list']> {
  if (typeof text !== 'string' || !text.trim()) {
    return PresetCatalog.createDefault().list();
  }
  return PresetCatalog.parse(parseJsonValueText(text)).list();
}
```

Then in `rowToConfig`, change line 192 from:

```ts
    Presets: parsePresetArray(row.presets_json),
```

to:

```ts
    Presets: PresetCatalog.parse(parseJsonValueText(row.presets_json)).list(),
```

`row.presets_json` is typed `z.string()` by `AppConfigRowSchema` (line 71), so `parseJsonValueText` receives the `string` it requires with no widening and no cast. Nothing is left that only forwards, and the `ReturnType<PresetCatalog['list']>` indirection is gone. A blank column now fails through `JSON.parse` and is wrapped by `PersistedConfigInvalidError` from Task 1, like every other invalid catalog.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test --test-name-pattern "blank stored preset catalog" .\tests\presets.test.ts`

Expected: PASS, 1 test.

- [ ] **Step 6: Run the whole preset suite**

Run: `npx tsx --test .\tests\presets.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 7: Run the config/migration suites that touch `presets_json`**

Run: `npx tsx --test .\tests\config-no-top-level-backend.test.ts .\tests\runtime-db-schema-v26.test.ts .\tests\runtime-db-schema-v33.test.ts`

Expected: PASS. These fixtures use `DEFAULT '[]'`, never `''`, so removing the blank branch changes nothing for them — an empty array already failed with `Missing built-in preset 'summary'.` before this task.

- [ ] **Step 8: Commit**

```bash
git add src/status-server/config-store.ts tests/presets.test.ts
git commit -m "refactor: drop silent repair of a blank persisted preset catalog"
```

---

### Task 3: Remove the scattered repair backups and verify end to end

**Files:**
- Delete: `C:\Users\denys\Documents\GitHub\SiftKit\.siftkit\runtime.sqlite.bak-executionfamily` (503,504,896 bytes)
- Delete: `C:\Users\denys\.siftkit\runtime.sqlite.bak-executionfamily` (192,512 bytes)

No source change here. Nothing in `src` writes these files — they were produced by throwaway repair scripts in the previous session and left beside the live databases, against the directive to keep investigation artifacts in one folder and delete them at the end. The repo already has `.siftkit/backups/` as the convention for retained snapshots; these two are not worth retaining once the live databases are proven good.

- [ ] **Step 1: Rebuild so `dist` reflects Tasks 1 and 2**

Run: `npm run build`

Expected: contracts, `tsc -p tsconfig.json`, `tsc -p tsconfig.scripts.json`, and the dashboard `vite build` all complete. The `NativeCommandError` block PowerShell prints around vite's stderr is cosmetic and not a failure.

- [ ] **Step 2: Prove both live databases load before deleting anything**

```bash
node -e "import('./dist/status-server/config-store.js').then(m=>{for(const p of ['C:/Users/denys/Documents/GitHub/SiftKit/.siftkit/runtime.sqlite','C:/Users/denys/.siftkit/runtime.sqlite'])console.log(p, m.readConfig(p).Presets.map(x=>x.id).join(','));}).catch(e=>{console.error('FAIL',e.message);process.exit(1);})"
```

Expected: two lines, each ending `summary,repo-search,chat,plan,repo-agent`. If either line is missing or `FAIL` prints, restore that database from its `.bak-executionfamily` copy and stop — do not delete the backups.

- [ ] **Step 3: Delete both backups**

```bash
rm -f "C:/Users/denys/Documents/GitHub/SiftKit/.siftkit/runtime.sqlite.bak-executionfamily" "C:/Users/denys/.siftkit/runtime.sqlite.bak-executionfamily"
```

- [ ] **Step 4: Verify they are gone and nothing else was touched**

```bash
ls "C:/Users/denys/Documents/GitHub/SiftKit/.siftkit/" "C:/Users/denys/.siftkit/" | grep -c "bak-executionfamily"
```

Expected: `0`.

- [ ] **Step 5: Run the full suite**

Run: `npm run test`

Expected: PASS across the suite. If a test outside `tests/presets.test.ts` fails, it is a real regression from Task 1 or Task 2 — do not proceed.

- [ ] **Step 6: Boot the status server against the real database**

Run: `npm run start:status:stable`

Expected: the server starts and stays up (no `ZodError`, no exit code 1). `/health` returning `503` with `"startupPending":true` is the normal managed-llama cold start, not a failure. Stop it with Ctrl+C once it is up.

- [ ] **Step 7: Refresh the global install**

Run: `npm run refresh-global`

Expected: `Global siftkit public CLI smoke checks passed.`

- [ ] **Step 8: Commit**

Only the plan document is new in the working tree at this point; the code commits landed in Tasks 1 and 2.

```bash
git add docs/superpowers/plans/2026-07-29-preset-config-fail-loud-repairs.md
git commit -m "docs: plan preset config fail-loud repairs"
```
