# Git Content Fidelity & EOL Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `git show`/`git cat-file` output reach the model with blank lines intact (fix #1), and make `edit`/`write` re-apply a file's original CRLF line endings on write-back so touching one line no longer rewrites every line ending (fix #3).

**Architecture:** Both fixes live entirely in the engine; the model contract is unchanged (it always sees and matches LF). Fix #1 is a branch in `buildPromptToolResult` — it already receives `options.command` but never reads it; when the git subcommand is content-bearing and the call succeeded, skip the blank-line/noise filtering and return the (CRLF-normalized, edge-trimmed) payload verbatim. Fix #3 adds two helpers to `text-encoding.ts` (`detectEolStyle`, `applyEolStyle`); `executeEdit` detects the on-disk style from the raw bytes it already reads and re-applies it on write-back, and `executeWrite` does the same when overwriting an existing file.

**Tech Stack:** TypeScript (Node), `node:test` + `node:assert/strict`, no new dependencies.

---

## Background (verified against the current tree)

| Fact | Anchor |
|---|---|
| The git prompt shaper strips **every** blank line from **all** git subcommands | `src/tool-loop-governor.ts:160-165` (`.filter((line) => line.trim().length > 0)`) |
| The shaper's options include `command?: string` but nothing reads it | `src/tool-loop-governor.ts:23-28`; sole consumer of `command` is `fingerprintToolCall` (`:96-99`) |
| The caller passes the executed command line | `src/repo-search/engine/tool-action-processor.ts:858-863` (`command: commandToRun`) |
| `rawOutput` arrives as `` `exit_code=${exitCode}\n${baseOutput}` `` | `src/repo-search/engine/tool-action-processor.ts:857` |
| Command capture already trims leading/trailing whitespace | `src/lib/captured-command.ts:127,137` — leading/trailing blank lines are unrecoverable regardless of this plan (accepted limitation) |
| `read`/`edit` normalize CRLF→LF at a single point | `src/lib/text-encoding.ts:83-85` (`readSourceText`) |
| `executeEdit` writes the LF-normalized text back, converting CRLF files to LF | `src/repo-search/engine/repo-tools.ts:944-956` |
| `executeWrite` writes model content verbatim | `src/repo-search/engine/repo-tools.ts:887` |
| Two tests pin the LF-conversion behavior this plan replaces | `tests/repo-tools.test.ts:693-705` and `:707-718` |

## Design decisions locked in

1. **Model contract unchanged.** The model still sees LF-only text from `read`, matches LF `oldText` in `edit`, and receives LF-normalized git output. EOL restoration happens on the disk side only.
2. **Content-bearing git subcommands = `show`, `cat-file`.** `diff` stays filtered — its output is structural (headers/hunks), blank-line loss doesn't corrupt round-trips, and it benefits from noise filtering.
3. **The content path applies only on success** (`exitCode` absent or `0`). Failed content commands keep today's filtered + `exit_code=N`-prefixed shape — error text has no fidelity requirement.
4. **The content path also skips the `http_client` filter.** The git tool spawns `git` directly with a scrubbed env (`src/repo-search/engine/command-execution.ts:27,136-145`), so `http_client` lines cannot occur there — while a *file's content* could legitimately contain a line matching that pattern and must not be dropped.
5. **CRLF preservation is all-or-nothing per file:** a file is `'crlf'` only when *every* newline in it is CRLF. Mixed-ending files are written back as uniform LF (deliberate normalization, matching today's behavior for the mixed case).
6. **Out of scope (deferred, recorded in the final section):** a `restore <path>` tool, a `reread` flag on `read`, preserving UTF-16 encodings on write-back (edit of a UTF-16 file still re-encodes as UTF-8, as today), and the capture-stage edge trim.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/tool-loop-governor.ts` | Modify | Git subcommand detection + content-path branch in `buildPromptToolResult`. |
| `src/lib/text-encoding.ts` | Modify | `detectEolStyle` / `applyEolStyle` helpers. Single home for EOL logic. |
| `src/repo-search/engine/repo-tools.ts` | Modify | `executeEdit` and `executeWrite` re-apply the detected style. |
| `tests/tool-loop-governor.test.ts` | Modify | Shaper tests. |
| `tests/text-encoding.test.ts` | Create | Helper unit tests. |
| `tests/repo-tools.test.ts` | Modify | Replace the two LF-conversion tests; add write-overwrite tests. |

## Commands

Run from the repo root (`C:\Users\denys\Documents\GitHub\SiftKit`), PowerShell.

- One node test file: `npm run test -- tool-loop-governor.test.ts` (also works with `text-encoding.test.ts`, `repo-tools.test.ts`)
- By name: `npm run test -- --test-name-pattern "<pattern>"`
- Whole node suite: `npm run test`
- Types + lint: `npm run typecheck` (chains `npm run lint`)

Per the repo's large-output routing rule, pipe broad suites through the summarizer:

```text
npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."
```

---

### Task 1: Content-bearing git commands bypass line filtering

**Files:**
- Modify: `src/tool-loop-governor.ts:156-180` (plus new helpers above `buildPromptToolResult`)
- Test: `tests/tool-loop-governor.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tool-loop-governor.test.ts` (the file already imports `buildPromptToolResult` at line 6):

```ts
test('buildPromptToolResult preserves blank lines for git show file content', () => {
  const fileContent = [
    "import { z } from 'zod';",
    '',
    'export const schema = z.object({',
    '  port: z.number(),',
    '});',
    '',
    'export type Config = z.infer<typeof schema>;',
  ].join('\n');
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git show HEAD:src/config.ts',
    exitCode: 0,
    rawOutput: `exit_code=0\n${fileContent}`,
  });

  assert.equal(promptResult, fileContent);
});

test('buildPromptToolResult recognizes content-bearing git commands through global flags', () => {
  const body = 'alpha\n\nbeta';
  const withPagerFlag = buildPromptToolResult({
    toolName: 'git',
    command: 'git --no-pager show HEAD:a.txt',
    exitCode: 0,
    rawOutput: `exit_code=0\n${body}`,
  });
  const withValueFlag = buildPromptToolResult({
    toolName: 'git',
    command: 'git -C sub cat-file -p HEAD:a.txt',
    exitCode: 0,
    rawOutput: `exit_code=0\n${body}`,
  });

  assert.equal(withPagerFlag, body);
  assert.equal(withValueFlag, body);
});

test('buildPromptToolResult still strips blank lines from git log output', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git log --oneline -n 3',
    exitCode: 0,
    rawOutput: 'exit_code=0\ncommit abc123\n\n    fix the thing\n\ncommit def456',
  });

  assert.equal(promptResult, 'commit abc123\n    fix the thing\ncommit def456');
});

test('buildPromptToolResult keeps the filtered error shape for a failed git show', () => {
  const promptResult = buildPromptToolResult({
    toolName: 'git',
    command: 'git show HEAD:missing.ts',
    exitCode: 128,
    rawOutput: "exit_code=128\n\nfatal: path 'missing.ts' does not exist in 'HEAD'",
  });

  assert.equal(promptResult, "exit_code=128\nfatal: path 'missing.ts' does not exist in 'HEAD'");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- --test-name-pattern "buildPromptToolResult"`

Expected: the two new content-path tests FAIL (blank lines are stripped today, so `promptResult` collapses the empty lines); the `git log` and failed-show tests PASS (they pin existing behavior).

- [ ] **Step 3: Add the subcommand detector**

In `src/tool-loop-governor.ts`, insert directly after `isHttpClientLogLine` (currently `:57-59`):

```ts
/** Subcommands whose stdout is file content: blank lines are payload, not noise. */
const CONTENT_BEARING_GIT_SUBCOMMANDS = new Set(['show', 'cat-file']);

/** Global git flags that consume a separate value token (e.g. `git -C sub show ...`). */
const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--exec-path']);

function isContentBearingGitCommand(command: string): boolean {
  const tokens = normalizeWhitespace(String(command || '')).split(' ');
  if (tokens[0] !== 'git') {
    return false;
  }
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    return CONTENT_BEARING_GIT_SUBCOMMANDS.has(token);
  }
  return false;
}
```

- [ ] **Step 4: Branch in `buildPromptToolResult`**

Replace the git branch of `buildPromptToolResult` (currently `:160-179`) so the whole function reads:

```ts
export function buildPromptToolResult(options: BuildPromptToolResultOptions): string {
  if (!isRepoSearchCommandToolName(options.toolName)) {
    return stripLeadingSuccessExitCode(String(options.rawOutput || '').trim());
  }
  const exitCode = Number(options.exitCode);
  const failed = Number.isFinite(exitCode) && exitCode !== 0;
  // Successful content-bearing commands (git show / cat-file) return the payload
  // verbatim apart from CRLF→LF: interior blank lines are part of the file, and
  // the direct-spawn git tool cannot emit http_client noise. Filtering stays for
  // log/status/branch, where blank lines are decoration.
  if (!failed && isContentBearingGitCommand(String(options.command || ''))) {
    return stripLeadingSuccessExitCode(String(options.rawOutput || '').replace(/\r\n/gu, '\n'));
  }
  const meaningfulLines = String(options.rawOutput || '')
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .filter((line) => !isHttpClientLogLine(line))
    .filter((line) => line.trim().length > 0);
  const trimmed = meaningfulLines.join('\n').trim();
  if (!trimmed) {
    if (failed) {
      return `exit_code=${exitCode}`;
    }
    return '';
  }
  if (failed) {
    if (new RegExp(`^exit_code=${exitCode}(?:\\s|$)`, 'u').test(trimmed)) {
      return trimmed;
    }
    return `exit_code=${exitCode}\n${trimmed}`.trim();
  }
  return stripLeadingSuccessExitCode(trimmed);
}
```

Note `stripLeadingSuccessExitCode` ends with `.trim()` — that removes only leading/trailing whitespace; interior blank lines survive. Edge blank lines were already lost at capture (`captured-command.ts:127`), so this changes nothing there.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- --test-name-pattern "buildPromptToolResult"`

Expected: PASS — all new tests plus the two pre-existing ones (`:83-96` non-zero exit shape, `:98-118` http_client stripping; the latter's command is a gradlew pipeline, not a `git show`, so it stays on the filtered path).

- [ ] **Step 6: Commit**

```bash
git add src/tool-loop-governor.ts tests/tool-loop-governor.test.ts
git commit -m "fix(governor): preserve blank lines in git show/cat-file output"
```

---

### Task 2: EOL style helpers

**Files:**
- Modify: `src/lib/text-encoding.ts` (append after `readSourceText`)
- Create: `tests/text-encoding.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/text-encoding.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEolStyle, detectEolStyle } from '../src/lib/text-encoding.js';

test('detectEolStyle reports crlf only for uniformly CRLF text', () => {
  assert.equal(detectEolStyle('a\r\nb\r\n'), 'crlf');
  assert.equal(detectEolStyle('a\r\nb\r\nno-trailing-newline'), 'crlf');
  assert.equal(detectEolStyle('a\nb\n'), 'lf');
  assert.equal(detectEolStyle('a\r\nb\n'), 'lf'); // mixed endings normalize to LF
  assert.equal(detectEolStyle('no newline at all'), 'lf');
  assert.equal(detectEolStyle(''), 'lf');
});

test('applyEolStyle converts LF text to the requested style', () => {
  assert.equal(applyEolStyle('a\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.equal(applyEolStyle('a\nb\n', 'lf'), 'a\nb\n');
  // Defensive: already-CRLF input must not become \r\r\n.
  assert.equal(applyEolStyle('a\r\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.equal(applyEolStyle('a\r\nb\r\n', 'lf'), 'a\nb\n');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- text-encoding.test.ts`

Expected: FAIL — the module has no `detectEolStyle`/`applyEolStyle` exports (typecheck/build error or import failure).

- [ ] **Step 3: Implement the helpers**

Append to `src/lib/text-encoding.ts`:

```ts
export type SourceEolStyle = 'lf' | 'crlf';

/**
 * 'crlf' only when the text has at least one newline and every newline is CRLF.
 * Mixed-ending files report 'lf', so write-back normalizes them to uniform LF.
 */
export function detectEolStyle(rawText: string): SourceEolStyle {
  const newlines = rawText.match(/\r?\n/gu) ?? [];
  return newlines.length > 0 && newlines.every((newline) => newline === '\r\n') ? 'crlf' : 'lf';
}

/** Re-applies a detected style to LF-normalized text. Idempotent for either input style. */
export function applyEolStyle(text: string, style: SourceEolStyle): string {
  const normalized = text.replace(/\r\n/gu, '\n');
  return style === 'crlf' ? normalized.replace(/\n/gu, '\r\n') : normalized;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- text-encoding.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/text-encoding.ts tests/text-encoding.test.ts
git commit -m "feat(text-encoding): add EOL style detection and re-application helpers"
```

---

### Task 3: `executeEdit` preserves the file's EOL style

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:10`, `:944-956`
- Test: `tests/repo-tools.test.ts:693-718`

- [ ] **Step 1: Update the two pinned tests to the new behavior**

These tests pin exactly the behavior being changed, so they flip first (this is the TDD red step). In `tests/repo-tools.test.ts`, replace the test at `:693-705` in full:

```ts
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
  assert.equal(after, 'first\r\nbeta\r\nline3\r\nline5\r\n');
});
```

And replace the test at `:707-718` in full:

```ts
test('edit preserves CRLF on a uniformly CRLF file and normalizes a mixed-ending file to LF', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'crlf.ts'), 'keep1\r\ntarget\r\nkeep3\r\n', 'utf8');
  const crlfResult = await executeRepoTool('edit', {
    path: 'src/crlf.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }, makeContext(root));
  assert.ok(crlfResult.ok, crlfResult.ok ? '' : crlfResult.reason);
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'crlf.ts'), 'utf8'),
    'keep1\r\nchanged\r\nkeep3\r\n',
  );

  fs.writeFileSync(path.join(root, 'src', 'mixed.ts'), 'keep1\r\ntarget\nkeep3\n', 'utf8');
  const mixedResult = await executeRepoTool('edit', {
    path: 'src/mixed.ts',
    edits: [{ oldText: 'target', newText: 'changed' }],
  }, makeContext(root));
  assert.ok(mixedResult.ok, mixedResult.ok ? '' : mixedResult.reason);
  assert.equal(
    fs.readFileSync(path.join(root, 'src', 'mixed.ts'), 'utf8'),
    'keep1\nchanged\nkeep3\n',
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- --test-name-pattern "edit (matches a model-authored|preserves CRLF)"`

Expected: FAIL — today both files come back uniform LF, so the CRLF expectations don't match.

- [ ] **Step 3: Implement EOL preservation in `executeEdit`**

In `src/repo-search/engine/repo-tools.ts`, extend the import at line 10:

```ts
import { applyEolStyle, detectEolStyle, readSourceText, readTextFileWithEncoding } from '../../lib/text-encoding.js';
```

(`readSourceText` stays imported — the `read` executor in this file still uses it; only `executeEdit`/`executeWrite` switch to the raw + re-apply pattern.)

Then in `executeEdit` (currently `:944-956`), replace the read/write block:

```ts
  const rawText = readTextFileWithEncoding(resolvedPath.absolutePath);
  const eolStyle = detectEolStyle(rawText);
  // The model matches against LF (readSourceText contract); the on-disk style is
  // re-applied on write-back so an edit never rewrites unrelated line endings.
  const originalText = rawText.replace(/\r\n/gu, '\n');
  const resolved = resolveEdits(originalText, rawEdits);
  if (typeof resolved === 'string') {
    return failure('edit', command, resolved);
  }
  let updatedText = '';
  let cursor = 0;
  for (const edit of resolved) {
    updatedText += originalText.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  updatedText += originalText.slice(cursor);
  writeFileSync(resolvedPath.absolutePath, applyEolStyle(updatedText, eolStyle), 'utf8');
```

(Only the first two lines, the `originalText` line, and the final `writeFileSync` line change; the middle is today's code.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- repo-tools.test.ts`

Expected: PASS, including every pre-existing edit/read test — LF files round-trip identically (`detectEolStyle` returns `'lf'`, `applyEolStyle` is a no-op).

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix(repo-tools): edit re-applies the file's original CRLF endings on write-back"
```

---

### Task 4: `executeWrite` preserves EOL when overwriting

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:873-894`
- Test: `tests/repo-tools.test.ts` (after the test at `:666-674`)

- [ ] **Step 1: Write the failing test**

Insert after the `'write creates parent directories and overwrites existing content'` test (currently `:666-674`):

```ts
test('write re-applies CRLF when overwriting a uniformly CRLF file, and writes new files as-is', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'src', 'win.ts'), 'old1\r\nold2\r\n', 'utf8');
  const overwritten = await executeRepoTool('write', { path: 'src/win.ts', content: 'new1\nnew2\n' }, makeContext(root));
  assert.ok(overwritten.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'win.ts'), 'utf8'), 'new1\r\nnew2\r\n');

  const fresh = await executeRepoTool('write', { path: 'src/fresh.ts', content: 'a\nb\n' }, makeContext(root));
  assert.ok(fresh.ok);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'fresh.ts'), 'utf8'), 'a\nb\n');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --test-name-pattern "write re-applies CRLF"`

Expected: FAIL — the overwritten file comes back with LF endings.

- [ ] **Step 3: Implement EOL preservation in `executeWrite`**

In `executeWrite` (currently `:873-894`), replace the two lines from `mkdirSync` through `writeFileSync` and the byte count in the output message:

```ts
  mkdirSync(dirname(resolvedPath.absolutePath), { recursive: true });
  // Overwriting an existing uniformly-CRLF file keeps its endings; new files and
  // mixed/LF files are written exactly as the model composed them (LF).
  const overwriteTarget = existsSync(resolvedPath.absolutePath) && statSync(resolvedPath.absolutePath).isFile()
    ? readTextFileWithEncoding(resolvedPath.absolutePath)
    : null;
  const finalContent = overwriteTarget === null
    ? content
    : applyEolStyle(content, detectEolStyle(overwriteTarget));
  writeFileSync(resolvedPath.absolutePath, finalContent, 'utf8');
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Wrote ${Buffer.byteLength(finalContent, 'utf8')} bytes to ${resolvedPath.relativePath}.`,
    toolType: 'write', outputUnit: 'lines',
    mutatedPath: resolvedPath.relativePath,
  };
```

(`existsSync` and `statSync` are already imported in this file — they are used by `executeEdit` at `:940`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- repo-tools.test.ts`

Expected: PASS, including the pre-existing overwrite test at `:666-674` (its target file is LF, so behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix(repo-tools): write preserves CRLF endings when overwriting an existing file"
```

---

### Task 5: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the node suite**

```text
npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."
```

Expected: pass, zero failures.

- [ ] **Step 2: Typecheck and lint**

```text
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, error categories, and file:line anchors for every diagnostic."
```

Expected: pass, zero diagnostics.

- [ ] **Step 3: Confirm no scope drift**

Run: `git status --short`

Expected changed files: `src/tool-loop-governor.ts`, `src/lib/text-encoding.ts`, `src/repo-search/engine/repo-tools.ts`, `tests/tool-loop-governor.test.ts`, `tests/text-encoding.test.ts`, `tests/repo-tools.test.ts`, and this plan file. (Plus any pre-existing uncommitted live-thinking-stack changes — see the handoff doc — which must be left untouched.)

---

## Deferred — not in this plan

1. **`restore <path>` tool** (wraps `git checkout -- <path>`): the highest-leverage recovery primitive — zero content enters the model context. Needs schema, approval-policy wiring, and read-window invalidation; a separate plan.
2. **`reread: true` flag on `read`** so a model can re-see returned lines without mutating the file (`planner-protocol.ts:108-115` currently exposes only `path`/`offset`/`limit`).
3. **UTF-16 write-back**: `edit` of a UTF-16 file still re-encodes it as UTF-8 (`writeFileSync(..., 'utf8')`), as today.
4. **Capture-stage edge trim** (`captured-command.ts:127,137`): leading/trailing blank lines of any command output are lost before shaping; global change, out of scope.

## Risks

| Risk | Mitigation |
|---|---|
| Two tests pin the exact edit behavior being changed (`repo-tools.test.ts:693-705`, `:707-718`). | Task 3 Step 1 replaces them with stricter expectations covering both the pure-CRLF and mixed cases. |
| A `git show` of a *binary* file now reaches the model less filtered. | Unchanged risk surface: the token budgeter still truncates oversized output, and binary content was never protected by blank-line stripping. |
| Subcommand detection mis-parses exotic global-flag layouts (`git -c key=val show ...`). | The flag-with-value skip list covers the common cases; a miss degrades to today's filtered behavior — never worse than the status quo. |
| `applyEolStyle` corrupting model content containing literal `\r\n`. | The helper normalizes CRLF→LF before re-expansion (idempotent); pinned by the defensive assertions in Task 2 Step 1. |
