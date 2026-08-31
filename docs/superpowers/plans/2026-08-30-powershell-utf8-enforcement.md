# PowerShell UTF-8 Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce UTF-8 on every encoding boundary of the PowerShell `run` shim instead of relying on silent Windows codepage defaults, so unicode text survives inside the pipeline and output filtering stops silently returning nothing.

**Architecture:** A single UTF-8 prelude constant in `src/lib/powershell.ts`, prepended to the `-Command` argument inside both spawn helpers (the only choke point every shim invocation passes through). The model-visible command string, duplicate-command detection, and transcript events are untouched because the engine records `requestedCommand`/`commandToRun` before the spawn layer. A one-sentence addition to the run-tool prompt guidance covers the remaining model-side pitfall (CRLF splitting).

**Tech Stack:** TypeScript, node:test via the repo test runner (`npm run build:test` + `node dist\test-runner\run-tests.js <target>`), powershell.exe 5.1.

---

## Background (why — read before implementing)

Session `8b4b493c` (repo-agent verification run, 2026-08-30) re-ran the full 65-second `npm test` suite **9 times in a row** because its output filters kept silently returning empty results. Root cause: the shim spawns `powershell.exe -NoProfile -Command <cmd>` and Node decodes the child's stdout/stdin as UTF-8 (`src/lib/captured-command.ts:86,153-154`), but nothing sets the PowerShell process's own encodings:

- `[Console]::OutputEncoding` (how PS decodes **native children's stdout**) defaults to the OEM codepage (e.g. CP437). `npm test` writes UTF-8 (`ℹ` = `E2 84 B9`); PS decodes it into three garbage chars, so `Select-String -Pattern '^ℹ'` never matches.
- `$OutputEncoding` (how PS encodes **text piped into native commands**) defaults to ASCII in PS 5.1 — non-ASCII becomes `?`.
- `[Console]::InputEncoding` (how PS decodes **its own stdin**, used by the `stdinData` option) also defaults to the OEM codepage.

The bug is masked: PS re-encodes the garbage chars back to the same bytes on its stdout (single-byte codepages round-trip losslessly), Node decodes them as UTF-8, and the stored transcript shows pristine `ℹ` — so the text *looks* correct everywhere while being garbage *inside* the pipeline where regexes run. That is why the failure must be pinned by an **in-pipeline match** test, not just an output round-trip test.

**Out of scope:** `src/status-server/managed-llama.ts:729` (uses `-File` with a start script, ASCII-only, not routed through the spawn helpers); the engine's output-caching/statelessness improvements (separate plan).

**Repo rules apply:** no commits, no temp files, TypeScript inferred end-to-end, no type assertions. Commit steps are intentionally absent — the primary agent reviews and owns the tree.

## File Structure

- Modify: `src/lib/powershell.ts` — add `POWERSHELL_UTF8_PRELUDE` constant + apply it in `spawnPowerShellSync` and `spawnPowerShellAsync`.
- Modify: `src/repo-search/prompts.ts:230-231` — extend `RUN_SHELL_GUIDANCE` with the UTF-8 guarantee and CRLF split idiom.
- Test: `tests/powershell-async.test.ts` — four encoding-boundary regression tests.
- Test: `tests/repo-search-prompts.test.ts` — one prompt-guidance assertion test.

---

### Task 1: UTF-8 prelude in the shim, driven by the in-pipeline glyph-match test

**Files:**
- Modify: `src/lib/powershell.ts:43-53,72-80`
- Test: `tests/powershell-async.test.ts`

- [ ] **Step 1: Write the failing in-pipeline test**

Append to `tests/powershell-async.test.ts` (existing imports suffice; `process.execPath` quoting follows the file's `powerShellCommandFor` idiom):

```ts
test('native UTF-8 output is decoded correctly inside the PowerShell pipeline', async () => {
  const emitSummary = `& '${process.execPath}' -e "console.log('\\u2139 tests 3413'); console.log('\\u2716 failing tests:')"`;
  const result = await spawnPowerShellAsync(
    `${emitSummary} | Select-String -Pattern '^\\u2139' | ForEach-Object { $_.Line }`,
    { timeoutMs: 30_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'ℹ tests 3413');
});
```

This reproduces the incident exactly: a native command emits a `ℹ`-prefixed summary line, and a `ℹ`-anchored regex must match it *inside* the pipeline.

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test; node dist\test-runner\run-tests.js powershell-async
```

Expected: the new test FAILS — `stdout.trim()` is empty (`''`) because Select-String matched nothing. The three pre-existing tests in the file still pass.

- [ ] **Step 3: Implement the prelude**

In `src/lib/powershell.ts`, insert after line 16 (`RUN_SHELL_LABEL`):

```ts
/**
 * Pins every encoding boundary of the shim to UTF-8. Without this, powershell.exe decodes
 * native children's stdout with the OEM codepage and pipes text into them as ASCII — and the
 * corruption is invisible in captured output because single-byte codepages re-encode the
 * garbage back to the original bytes. Regexes running inside the pipeline see the garbage;
 * transcripts see clean text. Prepended at the spawn layer so the model-visible command,
 * duplicate detection, and transcript events stay clean.
 */
export const POWERSHELL_UTF8_PRELUDE =
  '[Console]::InputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ';
```

Change line 47 (in `spawnPowerShellSync`):

```ts
  return spawnSync(
    POWERSHELL_EXECUTABLE,
    [...POWERSHELL_BASE_ARGS, '-Command', `${POWERSHELL_UTF8_PRELUDE}${command}`],
    {
```

Change line 76 (in `spawnPowerShellAsync`):

```ts
  return runCapturedCommand(
    POWERSHELL_EXECUTABLE,
    [...POWERSHELL_BASE_ARGS, '-Command', `${POWERSHELL_UTF8_PRELUDE}${command}`],
    {
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
npm run build:test; node dist\test-runner\run-tests.js powershell-async
```

Expected: all tests in the file PASS, including the new one.

If instead the new test fails with an `IOException`/"handle is invalid" error surfacing in stderr, the `[Console]::InputEncoding` assignment cannot run in this spawn environment (`windowsHide` / CREATE_NO_WINDOW). **Stop and report** — do not swallow it with try/catch and do not silently drop the assignment; the split between console-attached and console-less behavior is a design decision the primary agent must make.

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```

Expected: passes (it chains lint at the end; that must pass too).

### Task 2: Remaining encoding-boundary regression tests

**Files:**
- Test: `tests/powershell-async.test.ts`

These pin the other two boundaries the prelude fixes, plus a round-trip guard. Written after Task 1, they should pass immediately; each one fails if its corresponding prelude assignment is ever removed.

- [ ] **Step 1: Add the pipe-into-native test (`$OutputEncoding` boundary)**

```ts
test('PowerShell pipes non-ASCII text into native commands as UTF-8', async () => {
  const readStdin = `& '${process.execPath}' -e "process.stdin.setEncoding('utf8'); let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => { process.stdout.write(d); });"`;
  const result = await spawnPowerShellAsync(`'café ℹ' | ${readStdin}`, { timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'café ℹ');
});
```

Without the prelude this returns `caf? ?` (ASCII `$OutputEncoding` replaces non-ASCII with `?`).

- [ ] **Step 2: Add the stdinData test (`[Console]::InputEncoding` boundary)**

Node already writes `stdinData` as UTF-8 (`captured-command.ts:86`, default stream encoding); this asserts PS decodes it as UTF-8:

```ts
test('stdinData with non-ASCII round-trips through the shim', async () => {
  const result = await spawnPowerShellAsync('$input | ForEach-Object { $_ }', {
    timeoutMs: 30_000,
    stdinData: 'café ℹ\n',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'café ℹ');
});
```

- [ ] **Step 3: Add the output round-trip guard**

```ts
test('captured output preserves native UTF-8 glyphs', async () => {
  const emit = `& '${process.execPath}' -e "console.log('\\u2139 \\u2714 \\u2716 caf\\u00e9')"`;
  const result = await spawnPowerShellAsync(emit, { timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'ℹ ✔ ✖ café');
});
```

Note: on single-byte OEM codepages this test passed even *before* the fix (the masking round-trip described in Background) — it is here to guard the full chain on machines with double-byte codepages and against partial removal of the prelude. Do not treat its pre-fix pass as a plan error.

- [ ] **Step 4: Run the test file**

```powershell
npm run build:test; node dist\test-runner\run-tests.js powershell-async
```

Expected: all tests PASS (7 total in the file: 3 pre-existing + 4 new).

### Task 3: Prompt guidance — state the UTF-8 guarantee, warn about CRLF

**Files:**
- Modify: `src/repo-search/prompts.ts:230-231`
- Test: `tests/repo-search-prompts.test.ts` (append near line 291)

The prelude makes unicode matching work; this tells the model it can rely on that, and covers the one genuine model-side mistake from the incident (splitting on `` `n `` leaves a trailing `\r`, so `$`-anchored regexes fail).

- [ ] **Step 1: Write the failing prompt test**

Append to `tests/repo-search-prompts.test.ts` after the test ending at line 291 (uses the file's existing `buildAgentSystemPrompt` / `buildTestContext` helpers):

```ts
test('buildAgentSystemPrompt states the UTF-8 pipeline guarantee and CRLF split idiom', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));
  assert.match(prompt, /UTF-8 end-to-end/u, 'must state the pipeline encoding guarantee');
  assert.ok(prompt.includes('-split "`r?`n"'), 'must show the CRLF-safe split idiom');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```powershell
npm run build:test; node dist\test-runner\run-tests.js repo-search-prompts
```

Expected: the new test FAILS on the first assertion; pre-existing tests pass.

- [ ] **Step 3: Extend RUN_SHELL_GUIDANCE**

Replace `src/repo-search/prompts.ts:230-231` with (the `` \` `` sequences are escaped backticks inside the template literal — they must render as PowerShell backticks in the prompt):

```ts
const RUN_SHELL_GUIDANCE =
  `- \`run\` executes in ${RUN_SHELL_LABEL}: use PowerShell syntax (Select-Object -Last N, Select-String, Get-Content -Tail N). Unix (tail/head/grep) and cmd (\`&\`, \`%ERRORLEVEL%\`) are NOT available. Commands already run inside PowerShell — never wrap them in \`powershell -Command\`. The pipeline is UTF-8 end-to-end, so unicode glyphs in output match regexes directly. Native command output uses CRLF: split captured text with -split "\`r?\`n" — splitting on \`n alone leaves a trailing \`r that makes $-anchored regexes fail.`;
```

- [ ] **Step 4: Run the test to verify it passes**

```powershell
npm run build:test; node dist\test-runner\run-tests.js repo-search-prompts
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Check for other tests that embed the old guidance text**

```powershell
Select-String -Path tests\*.test.ts -Pattern 'never wrap them|Select-Object -Last N' -List
```

Expected: only `tests/repo-search-prompts.test.ts` (assertions there match on `RUN_SHELL_LABEL` and idiom regexes, not the full sentence). If any other test asserts the full old guidance string, update it to the new string in the same way — do not weaken it to a partial match.

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint**

```powershell
npm run typecheck
```

Expected: passes end-to-end (the script chains all subprojects and eslint).

- [ ] **Step 2: Run both touched test targets**

```powershell
npm run build:test; node dist\test-runner\run-tests.js powershell-async; node dist\test-runner\run-tests.js repo-search-prompts
```

Expected: PASS, exit code 0 for each.

- [ ] **Step 3: Run the shim's heaviest consumer test target as a smoke check**

The prelude executes in front of every `run`-tool command, so the engine tests that drive real PowerShell must stay green:

```powershell
node dist\test-runner\run-tests.js runtime-planner-mode
```

Expected: pass/fail counts identical to a pre-change run of the same target. Note: the full `npm test` suite currently has 27 pre-existing environmental failures (verified identical at HEAD on 2026-08-30) — judge this target against its own pre-change baseline, not against zero failures.

- [ ] **Step 4: Confirm tree hygiene**

```powershell
git status --porcelain
```

Expected: only the four planned files changed beyond the modifications that already existed before this plan; no new untracked files.

---

## Self-Review

- Spec coverage: all three PS encoding boundaries (native stdout in, native pipe out, own stdin) are set by one prelude and each is pinned by a dedicated test; the masked-corruption mode is pinned by the in-pipeline test specifically; model-side CRLF pitfall covered by prompt guidance + test. Node-side boundaries were already UTF-8 (verified, `captured-command.ts:86,153-154`) so no change there.
- The `[Console]::InputEncoding` risk (possible IOException without a console) has an explicit stop-and-report instruction rather than a silent fallback.
- No placeholders; all code complete; type surface unchanged (helpers keep their signatures, so callers `dpapi.ts:27`, `repo-tools.ts:845` need no edits).
