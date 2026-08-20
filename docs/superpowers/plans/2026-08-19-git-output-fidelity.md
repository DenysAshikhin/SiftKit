# Git Output Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `buildPromptToolResult` from silently corrupting git output that the model reads — preserve blank context lines in any patch-shaped output, stop re-parsing the exit code out of the output string, and make an empty-but-successful command say so.

**Architecture:** All three defects live in one function, `buildPromptToolResult` in `src/tool-loop-governor.ts`. Task 1 removes the string round-trip (the caller builds `exit_code=N\n<output>`, the function then tries to un-build it), which makes Tasks 2 and 3 single-expression changes on a clean signature. Task 2 replaces the subcommand allow-list gate with an output-shape gate. Task 3 replaces the empty-string return with an explicit marker.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, esbuild test build (`npm run build:test`), custom runner `dist/test-runner/run-tests.js`.

**Evidence this is real:** repo-search run `b3d88c5a-140d-4a8b-8923-991229592088` (stored in `.siftkit/runtime.sqlite` → `run_logs.repo_search_json`) shows two `git diff` results where the model's copy lost blank context lines that the raw capture had:

```
raw:    ...memory_fraction(fraction, device = device)\n \n \n@@ -58,25 +63,6 @@ def free_mem():
prompt: ...memory_fraction(fraction, device = device)\n@@ -58,25 +63,6 @@ def free_mem():
```

**Scope note:** This plan does *not* change `passed = signalCheck.passed && this.counters.commandFailures === 0` at `src/repo-search/engine/task-loop.ts:743`. That is a separate scoring-semantics decision.

**Commit policy:** Repo policy is *no commits unless requested*. Each task ends with a commit step — run it only if commits were asked for. `main` is the default branch; branch before committing.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/tool-loop-governor.ts` | Builds the tool-result text the model sees | Modify: `BuildPromptToolResultOptions` (`:23-28`), `stripLeadingSuccessExitCode` (`:53-55`, deleted), `buildPromptToolResult` (`:181-213`) |
| `src/repo-search/engine/tool-action-processor.ts` | repo-search caller | Modify: `:857-863` |
| `src/summary/planner/mode.ts` | summary-planner callers (non-git tools) | Modify: `:1123-1126`, `:1216-1219` |
| `tests/tool-loop-governor.test.ts` | Unit tests for the above | Modify 8 existing fixtures, add 6 tests |

No new files. All three tasks touch the same function, so they must run in the listed order.

---

### Task 1: Pass the exit code and the output separately

**Why:** `src/repo-search/engine/tool-action-processor.ts:857` builds `exit_code=${executed.exitCode}\n${baseOutput}` and hands that string to `buildPromptToolResult`, which then re-parses it apart. Two bugs fall out: (a) `stripLeadingSuccessExitCode` (`:53`) eats a real first line that happens to be the literal text `exit_code=0`; (b) the `!failed &&` guard at `:191` means a non-zero exit silently disables the verbatim path, so a command that fails *while emitting content* gets blank-line-filtered.

`src/summary/planner/mode.ts:1123` and `:1216` pass no exit code at all and their input comes from `formatPlannerResult` (`src/summary/planner/formatters.ts:63-70`), which never emits an `exit_code=` line — so the strip is dead code on that path and removing it is safe.

**Files:**
- Modify: `src/tool-loop-governor.ts:23-28` (options type), `:53-55` (delete), `:181-213` (rewrite)
- Modify: `src/repo-search/engine/tool-action-processor.ts:857-863`
- Modify: `src/summary/planner/mode.ts:1123-1126`, `src/summary/planner/mode.ts:1216-1219`
- Test: `tests/tool-loop-governor.test.ts`

- [ ] **Step 1: Migrate the 8 existing test fixtures to the new field**

In `tests/tool-loop-governor.test.ts`, rename `rawOutput:` to `output:` in every `buildPromptToolResult` call and drop the now-redundant `exit_code=…\n` prefix from the fixture strings. The expected values do not change. The eight call sites and their new inputs:

`:84` — `output: 'hitCount=0'` (was `rawOutput: 'exit_code=0\nhitCount=0'`)
`:88` — `output: 'pattern not found'` (was `rawOutput: 'exit_code=1\npattern not found'`)
`:99` — `rawOutput: [...]` → `output: [...]`, array contents unchanged (there is no `exit_code` line in it)
`:190` — `output: fileContent` (was `` rawOutput: `exit_code=0\n${fileContent}` ``)
`:202` — `output: body` (was `` rawOutput: `exit_code=0\n${body}` ``)
`:208` — `output: body` (was `` rawOutput: `exit_code=0\n${body}` ``)
`:220` — `output: 'commit abc123\n\n    fix the thing\n\ncommit def456'`
`:230` — `output: "\nfatal: path 'missing.ts' does not exist in 'HEAD'"`

The last one is the important one: it keeps its existing assertion `assert.equal(promptResult, "exit_code=128\nfatal: path 'missing.ts' does not exist in 'HEAD'")`, which must still pass after the `!failed &&` guard is removed.

- [ ] **Step 2: Add the two new failing tests**

Append to `tests/tool-loop-governor.test.ts`:

```ts
test('buildPromptToolResult does not strip an exit_code=0 line that is real file content', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git show HEAD:scripts/expected-output.txt',
    exitCode: 0,
    output: 'exit_code=0\nreal first line',
  });

  assert.equal(promptResult, 'exit_code=0\nreal first line');
});

test('buildPromptToolResult preserves blank lines when a content-bearing command fails', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git show HEAD:src/config.ts',
    exitCode: 128,
    output: 'alpha\n\nbeta',
  });

  assert.equal(promptResult, 'exit_code=128\nalpha\n\nbeta');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tool-loop-governor`

Expected: the build fails first with TypeScript errors — `Object literal may only specify known properties, and 'output' does not exist in type 'BuildPromptToolResultOptions'` — because `output` is not yet a field. That is the failing state for this step; do not proceed to Step 4 until you have seen it.

- [ ] **Step 4: Change the options type**

In `src/tool-loop-governor.ts`, replace lines 23-28:

```ts
type BuildPromptToolResultOptions = {
  toolName: string;
  command?: string;
  exitCode?: number | null;
  /** Command output only. Callers must not prepend an `exit_code=` line — this function adds it. */
  output: string;
};
```

- [ ] **Step 5: Delete `stripLeadingSuccessExitCode`**

In `src/tool-loop-governor.ts`, delete lines 53-55 in full:

```ts
function stripLeadingSuccessExitCode(text: string): string {
  return String(text || '').replace(/^exit_code=0\s*\n?/u, '').trim();
}
```

It must have no remaining references after Step 6. `npm run lint` fails on an unused function, so a missed reference fails loudly.

- [ ] **Step 6: Rewrite `buildPromptToolResult`**

In `src/tool-loop-governor.ts`, replace the whole of lines 181-213 with:

```ts
function filterDecorativeLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => !isHttpClientLogLine(line))
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

export function buildPromptToolResult(options: BuildPromptToolResultOptions): string {
  const body = String(options.output || '').replace(/\r\n/gu, '\n');
  if (!isRepoSearchCommandToolName(options.toolName)) {
    return body.trim();
  }
  const exitCode = Number(options.exitCode);
  const failed = Number.isFinite(exitCode) && exitCode !== 0;
  // Content-bearing commands (git show / cat-file) return the payload verbatim apart from
  // CRLF→LF: interior blank lines are part of the file. Filtering stays for log/status/branch,
  // where blank lines are decoration.
  const visible = isContentBearingGitCommand(String(options.command || ''))
    ? body.trim()
    : filterDecorativeLines(body);
  if (!failed) {
    return visible;
  }
  return visible ? `exit_code=${exitCode}\n${visible}` : `exit_code=${exitCode}`;
}
```

Note what disappeared: the `!failed &&` guard (blank-line semantics do not depend on the exit code), and the `new RegExp(`^exit_code=${exitCode}…`)` de-duplication check at the old `:207` (the body can no longer contain the prefix, so there is nothing to de-duplicate).

- [ ] **Step 7: Update the repo-search caller**

In `src/repo-search/engine/tool-action-processor.ts`, replace lines 857-863:

```ts
    const rawResultText = `exit_code=${executed.exitCode}\n${baseOutput}`.trim();
    let resultText = buildPromptToolResult({
      toolName: normalizedToolName,
      command: commandToRun,
      exitCode: executed.exitCode,
      output: baseOutput,
    });
```

Keep `rawResultText` — it is still consumed by `this.deps.resultBudgeter.fit({ … rawResultText … })` at `:875` for raw token accounting. Only the argument to `buildPromptToolResult` changes.

- [ ] **Step 8: Update the two summary-planner callers**

In `src/summary/planner/mode.ts`, replace lines 1123-1126:

```ts
    const formattedResultText = buildPromptToolResult({
      toolName: effectiveToolAction.tool_name,
      output: rawFormattedResultText,
    });
```

and lines 1216-1219:

```ts
    const promptResultText = buildPromptToolResult({
      toolName: effectiveToolAction.tool_name,
      output: fitResult.visibleText,
    });
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tool-loop-governor`

Expected: PASS, including the pre-existing `keeps the filtered error shape for a failed git show` and `still strips blank lines from git log output`.

- [ ] **Step 10: Typecheck and lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, every TypeScript or ESLint error, and its file:line."`

Expected: pass. A leftover `rawOutput:` call site anywhere in the repo surfaces here as a type error.

- [ ] **Step 11: Commit** *(only if commits were requested)*

```bash
git add src/tool-loop-governor.ts src/repo-search/engine/tool-action-processor.ts src/summary/planner/mode.ts tests/tool-loop-governor.test.ts
git commit -m "fix(tool-loop-governor): pass exit code and output separately instead of re-parsing"
```

---

### Task 2: Preserve blank lines in any patch-shaped output

**Why:** `CONTENT_BEARING_GIT_SUBCOMMANDS` (`src/tool-loop-governor.ts:62`) is `{'show','cat-file'}`, so `git diff`, `git log -p`, and `git format-patch --stdout` all fall through to the blank-line filter. Their blank *context* lines (a line that is a single space) get dropped while blank `+`/`-` lines survive, so the hunk body stops matching its own `@@ -30,8 +30,13 @@` line counts and any `file:line` anchor the model derives from the hunk can be off.

Gating on output shape rather than subcommand fixes all three at once and covers `range-diff`, `stash show -p`, and anything added later, without maintaining an allow-list.

**Files:**
- Modify: `src/tool-loop-governor.ts` (add `containsUnifiedDiff`, use it in `buildPromptToolResult`)
- Test: `tests/tool-loop-governor.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tool-loop-governor.test.ts`:

```ts
test('buildPromptToolResult preserves blank context lines in git diff output', () => {
  const diff = [
    'diff --git a/util/memory.py b/util/memory.py',
    'index 25f6208..5479d59 100644',
    '--- a/util/memory.py',
    '+++ b/util/memory.py',
    '@@ -30,5 +30,6 @@ def set_memory_fraction_reserve(',
    '     touch_device(device)',
    ' ',
    '-    fraction = (free - reserve) / total',
    '+    fraction = (free - reserve - already_reserved) / total',
    ' ',
    '     return fraction',
  ].join('\n');
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git diff origin/dev..siftkit -- util/memory.py',
    exitCode: 0,
    output: diff,
  });

  assert.equal(promptResult, diff);
});

test('buildPromptToolResult preserves diff hunks inside git log -p output', () => {
  const output = [
    'commit abc123',
    '',
    '    fix the thing',
    '',
    'diff --git a/a.py b/a.py',
    '@@ -1,4 +1,4 @@',
    ' import os',
    ' ',
    '-x = 1',
    '+x = 2',
  ].join('\n');
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git log -1 -p -- a.py',
    exitCode: 0,
    output,
  });

  assert.equal(promptResult, output);
});

test('buildPromptToolResult preserves blank context lines in git format-patch output', () => {
  const output = [
    'From abc123 Mon Sep 17 00:00:00 2001',
    'Subject: [PATCH] fix the thing',
    '',
    '---',
    ' a.py | 2 +-',
    '',
    'diff --git a/a.py b/a.py',
    '@@ -1,3 +1,3 @@',
    ' import os',
    ' ',
    '-x = 1',
    '+x = 2',
  ].join('\n');
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git format-patch -1 --stdout',
    exitCode: 0,
    output,
  });

  assert.equal(promptResult, output);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tool-loop-governor`

Expected: all three FAIL on `assert.equal`, with the actual value missing the `' '` context lines (and, for the `log -p` and `format-patch` cases, the empty lines too).

- [ ] **Step 3: Add the shape detector**

In `src/tool-loop-governor.ts`, directly below `CONTENT_BEARING_GIT_SUBCOMMANDS` (`:62`), add:

```ts
/**
 * A unified diff carries blank context lines as payload: dropping them desynchronizes the hunk
 * body from its own `@@ -a,b +c,d @@` line counts, so any file:line the model derives is wrong.
 * Detected by shape rather than by subcommand so `diff`, `log -p`, `format-patch --stdout`,
 * `range-diff`, and `stash show -p` are all covered by one rule.
 */
const UNIFIED_DIFF_MARKER = /^(?:diff --git |@@ .+ @@)/mu;

function containsUnifiedDiff(output: string): boolean {
  return UNIFIED_DIFF_MARKER.test(output);
}
```

- [ ] **Step 4: Use it in `buildPromptToolResult`**

In `src/tool-loop-governor.ts`, replace the `const visible = …` assignment written in Task 1 Step 6 with:

```ts
  const preserveBlankLines = isContentBearingGitCommand(String(options.command || ''))
    || containsUnifiedDiff(body);
  const visible = preserveBlankLines ? body.trim() : filterDecorativeLines(body);
```

Delete the `// Content-bearing commands (git show / cat-file) return the payload verbatim…` comment block above it and put this in its place:

```ts
  // Blank lines are payload for file content (git show / cat-file) and for unified diffs.
  // Everywhere else — log, status, branch — they are decoration and cost tokens.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tool-loop-governor`

Expected: PASS. `still strips blank lines from git log output` (`:219`) must also still pass — its fixture contains no diff marker, so plain `git log` keeps its existing token-saving behavior.

- [ ] **Step 6: Verify against real git output**

Run: `node -e "const {execFileSync}=require('child_process');const {buildPromptToolResult}=require('./dist/tool-loop-governor.js');for(const a of [['diff','HEAD~3','--','src'],['log','-2','-p','--','src'],['format-patch','-1','--stdout'],['log','-3'],['status']]){const o=execFileSync('git',a,{encoding:'utf8',maxBuffer:1<<26}).replace(/\r\n/g,'\n');const p=buildPromptToolResult({toolName:'git',command:'git '+a.join(' '),exitCode:0,output:o});console.log((p===o.trim()?'VERBATIM':'FILTERED')+' git '+a.join(' '))}"`

Note this requires `npm run build` (not `build:test`) to refresh `dist/`. Expected: `VERBATIM` for `diff`, `log -p`, and `format-patch`; `FILTERED` for `log -3` and `status`.

- [ ] **Step 7: Commit** *(only if commits were requested)*

```bash
git add src/tool-loop-governor.ts tests/tool-loop-governor.test.ts
git commit -m "fix(tool-loop-governor): preserve blank context lines in unified-diff output"
```

---

### Task 3: Report empty-but-successful commands explicitly

**Why:** When a command succeeds with no output, `buildPromptToolResult` returns `''`, and `src/repo-search/engine/tool-action-processor.ts:864-866` prepends only the zero-output warning. The model's entire tool result becomes `"Zero-output warning: 9 more zero-output command(s) and you will be forced to answer."` — with nothing saying the command ran and matched nothing. Run `b3d88c5a` hit this three times on legitimate empty `git log --grep` results.

**Files:**
- Modify: `src/tool-loop-governor.ts` (`buildPromptToolResult` success return)
- Test: `tests/tool-loop-governor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/tool-loop-governor.test.ts`:

```ts
test('buildPromptToolResult reports an explicit no-output result for an empty successful command', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: "git log origin/dev --oneline --grep='293'",
    exitCode: 0,
    output: '',
  });

  assert.equal(promptResult, 'exit_code=0 (no output)');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tool-loop-governor`

Expected: FAIL — `Expected values to be strictly equal: '' !== 'exit_code=0 (no output)'`.

- [ ] **Step 3: Return the marker**

In `src/tool-loop-governor.ts`, replace the success return in `buildPromptToolResult`:

```ts
  if (!failed) {
    // An empty result must still say the command ran: on its own, the zero-output warning
    // reads as "nothing happened" rather than "this search legitimately matched nothing".
    return visible || 'exit_code=0 (no output)';
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js tool-loop-governor`

Expected: PASS.

- [ ] **Step 5: Confirm nothing downstream keys off the empty string**

Run: `node .\dist\test-runner\run-tests.js engine-tool-action-processor; node .\dist\test-runner\run-tests.js engine-forced-finish`

Expected: PASS. The zero-output *counter* keys off `baseOutput.length` (`src/repo-search/engine/forced-finish.ts:42-43`), not off this string, so the forced-finish behavior is unchanged — these runs prove it.

- [ ] **Step 6: Full suite, typecheck, lint**

Run: `npm test 2>&1 | siftkit summary --question "Return pass/fail, the names of any failing tests, the root error for each, and file:line anchors."`

Then: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`

Expected: both pass. Investigate any failure directly against the named test rather than re-running the whole suite.

- [ ] **Step 7: Commit** *(only if commits were requested)*

```bash
git add src/tool-loop-governor.ts tests/tool-loop-governor.test.ts
git commit -m "fix(tool-loop-governor): state exit_code=0 (no output) instead of returning empty text"
```

---

## Acceptance Criteria

1. `buildPromptToolResult` takes `output` (command output only) plus `exitCode`; no caller passes a pre-joined `exit_code=…\n…` string, and `stripLeadingSuccessExitCode` no longer exists.
2. Output containing `diff --git ` or a `@@ … @@` hunk header is returned verbatim (modulo CRLF→LF and outer trim), regardless of subcommand or exit code.
3. `git show` / `git cat-file` stay verbatim; plain `git log` and `git status` keep stripping blank lines (`tests/tool-loop-governor.test.ts:219` still passes).
4. A successful command with no output yields `exit_code=0 (no output)`.
5. `npm test`, `npm run typecheck`, and `npm run lint` all pass.
6. The Task 2 Step 6 real-git probe prints `VERBATIM` for `diff` / `log -p` / `format-patch` and `FILTERED` for `log` / `status`.

## Known Risk

`containsUnifiedDiff` is a heuristic: a `git log` whose commit message body contains a line starting with `diff --git ` or `@@ … @@` will be treated as a patch and keep its blank lines. The cost is a few extra tokens on a rare commit message; the alternative (an allow-list) silently corrupts real diffs, which is the strictly worse failure. Accepted deliberately.
