# Edit Tool Not-Found Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a rejected `edit` call tell the model *which* edit failed and *where* its `oldText` stops matching the file, so a hallucinated `oldText` is corrected in one turn instead of many.

**Architecture:** `resolveEdits` in `src/repo-search/engine/repo-tools.ts` keeps its offset-against-original matching, but on failure it now validates every edit, prefixes each message with `edits[i]`, and for a not-found `oldText` reports the longest line-prefix that does exist in the file plus the first differing line. The rejected-call elision marker is reworded to point the model at the tool result. No new files, no schema changes, no change to the success path.

**Tech Stack:** TypeScript (strict, inferred), `node:test`, existing repo test runner.

---

## Evidence (why this is worth fixing)

Run `4a68b4d3` (repo-agent, 2026-09-16), turn 26. The raw arguments survived in `chat_run_events` (`tool_proposed`, sequence 5302). `edits[0].oldText` was:

```text
import { installRejectingTriggerOnFile, withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.js';
import { JsonRecordReader } from '../src/utils/json-record-reader.js';
```

Line 1 exists (file line 19). Line 2 does not exist anywhere: the real import is at file line 10 with a `lib` path, and file line 20 is the temp-dirs import. The matcher was right to reject. What the harness told the model was:

```text
Rejected command: oldText not found in file: "import { installRejectingTriggerOnFile, withRuntimeDatabaseC"
```

Three defects in that message, each observable in the model's next turns:

1. **No edit index.** The model believed "the second oldText" failed. It was `edits[0]`.
2. **60-char prefix only.** The prefix shown *does* exist in the file, so the model grepped for it, found it, and concluded the matcher was broken.
3. **Arguments elided.** `buildRejectedTranscriptAction` replaced the 4,384-char arguments with `{"elided":"rejected edit call; 4,384 chars of arguments discarded"}`. The model could no longer see its own `oldText`, misremembered edit 0 as having an empty `newText`, and paraphrased the marker as a "tool budget" notice. Turns 27 through 40 were spent re-reading the file; the edit landed at turn 41.

The elision itself is a deliberate token-cost trade and stays. The fix is to make the rejection message self-sufficient so the elided arguments are not needed.

Out of scope (separate finding, not planned here): `screenRejection` in `tool-action-processor.ts:938-956` counts every native execution failure (`oldText not found`, `path is not a readable file`, `offset past end`) as `rejectionKind: 'safety'` and increments `counters.safetyRejects`. That skews safety telemetry but does not change model behaviour.

---

## File Structure

- Modify: `src/repo-search/engine/repo-tools.ts` — `resolveEdits` (lines 781-803) and `REJECTED_ARGS_ELISION_LIMIT` / `buildRejectedTranscriptAction` (lines 326-341). Two new private helpers next to `resolveEdits`: `lineNumberAt` and `describeMissingOldText`.
- Modify: `tests/repo-tools.test.ts` — extend the edit tests around lines 702-728; update the elision assertion at line 175.
- Modify: `tests/repo-search-loop.core.test.ts:1260` — regex on the elision marker.

Test fixture already in place (`makeRepo`, `tests/repo-tools.test.ts:39-51`): `src/a.ts` is `line1\nalpha\nline3\nalpha\nline5\n`.

Test commands (repo convention, from `package.json`):

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools
npm run build:test; node .\dist\test-runner\run-tests.js repo-search-loop.core
```

---

### Task 1: Index every edit failure and report the divergence point for a missing oldText

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:781-803`
- Test: `tests/repo-tools.test.ts` (after the test ending at line 728)

- [x] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts` directly after `edit rejects a missing oldText and overlapping edits`:

```ts
test('edit failure names the failing edit index', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1', newText: 'first' }, { oldText: 'not-present', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /^edits\[1\]\.oldText not found in file/u);
  assert.doesNotMatch(result.reason, /edits\[0\]/u);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8'), 'line1\nalpha\nline3\nalpha\nline5\n');
});

test('edit failure reports the first line of a missing oldText when no line-prefix matches', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'nowhere\nline3', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /edits\[0\]\.oldText not found in file; its first line does not occur anywhere: "nowhere"/u);
  assert.match(result.reason, /Re-read the file and copy oldText verbatim\./u);
});

test('edit failure reports where a partially matching oldText diverges from the file', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line3\nalpha\nWRONG', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /edits\[0\]\.oldText not found in file; oldText lines 1-2 match at file line 3, but oldText line 3 is "WRONG" while the file has "line5"\./u);
});

test('edit failure reports end of file when the matching prefix ends the file', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line5\nafter-eof', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /oldText lines 1-1 match at file line 5, but oldText line 2 is "after-eof" while the file has "" \(end of file\)\./u);
});

test('edit reports every failing edit in one rejection', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [
      { oldText: 'missing-a', newText: 'x' },
      { oldText: 'alpha', newText: 'y' },
      { oldText: 'line5', newText: 'z' },
    ],
  }), makeContext(root));
  assert.ok(!result.ok);
  const lines = result.reason.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^edits\[0\]\.oldText not found in file/u);
  assert.match(lines[1], /^edits\[1\]\.oldText is not unique in file: "alpha"$/u);
});
```

Also tighten the existing test at lines 714-728 so the uniqueness message carries the index:

```ts
  assert.match(result.reason, /^edits\[0\]\.oldText is not unique in file: "alpha"$/u);
```

(replace the `assert.match(result.reason, /unique/u);` line in `edit rejects a non-unique oldText and leaves the file untouched`).

- [x] **Step 2: Run the tests to verify they fail**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools 2>&1 | Select-String -Pattern "^(ℹ|✖|not ok)|AssertionError" | Select-Object -First 30
```

Expected: the five new tests and the tightened uniqueness test fail with `AssertionError` on the `reason` regexes. All other `repo-tools` tests pass.

- [x] **Step 3: Implement the diagnostics in `resolveEdits`**

Replace `resolveEdits` (`src/repo-search/engine/repo-tools.ts:783-803`) with:

```ts
/** 1-based line number of a character offset in LF-normalized text. */
function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

const RECOPY_HINT = 'Re-read the file and copy oldText verbatim.';

/**
 * Names the longest line-prefix of oldText that does occur in the file and the first line after
 * it that does not, so the model sees where its copy diverged instead of a prefix that matches.
 */
function describeMissingOldText(originalText: string, oldText: string, index: number): string {
  const label = `edits[${index}].oldText not found in file`;
  const lines = oldText.split('\n');
  for (let count = lines.length - 1; count >= 1; count -= 1) {
    const start = originalText.indexOf(lines.slice(0, count).join('\n'));
    if (start < 0) continue;
    const fileLine = lineNumberAt(originalText, start);
    const nextFileLine = originalText.split('\n')[fileLine - 1 + count];
    const actual = nextFileLine === undefined ? '"" (end of file)' : JSON.stringify(nextFileLine);
    return `${label}; oldText lines 1-${count} match at file line ${fileLine}, but oldText line ${count + 1} is ${JSON.stringify(lines[count])} while the file has ${actual}. ${RECOPY_HINT}`;
  }
  return `${label}; its first line does not occur anywhere: ${JSON.stringify(lines[0])}. ${RECOPY_HINT}`;
}

function resolveEdits(originalText: string, rawEdits: EditToolArgs['edits']): ResolvedEdit[] | string {
  const resolved: ResolvedEdit[] = [];
  const failures: string[] = [];
  rawEdits.forEach(({ oldText, newText }, index) => {
    const start = originalText.indexOf(oldText);
    if (start < 0) {
      failures.push(describeMissingOldText(originalText, oldText, index));
      return;
    }
    if (originalText.indexOf(oldText, start + 1) >= 0) {
      failures.push(`edits[${index}].oldText is not unique in file: ${JSON.stringify(oldText.slice(0, 60))}`);
      return;
    }
    resolved.push({ start, end: start + oldText.length, newText });
  });
  if (failures.length > 0) {
    return failures.join('\n');
  }
  const ordered = [...resolved].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      return 'edits[] entries overlap; merge nearby changes into one edit';
    }
  }
  return ordered;
}
```

Notes for the implementer:
- The loop in `describeMissingOldText` starts at `lines.length - 1` because the full `oldText` is already known not to match; a single-line `oldText` skips the loop and reaches the "first line does not occur" branch.
- The file's trailing `\n` means `split('\n')` yields a final `''` element; a prefix that ends on the file's last real line therefore has `nextFileLine === ''`, and the message prints `"" (end of file)` via the `undefined` check only when the file has no trailing newline. To make both cases read the same, treat `''` at the last index as end of file too:

```ts
    const fileLines = originalText.split('\n');
    const nextIndex = fileLine - 1 + count;
    const nextFileLine = fileLines[nextIndex];
    const atEnd = nextFileLine === undefined || (nextIndex === fileLines.length - 1 && nextFileLine === '');
    const actual = atEnd ? '"" (end of file)' : JSON.stringify(nextFileLine);
```

Use this four-line form in place of the two-line `nextFileLine`/`actual` pair above. Compute `fileLines` once, before the loop.

- [x] **Step 4: Run the tests to verify they pass**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools 2>&1 | Select-String -Pattern "^(ℹ|✖|not ok)|AssertionError" | Select-Object -First 30
```

Expected: `ℹ fail 0`; the five new tests and the tightened uniqueness test pass.

- [x] **Step 5: Confirm the tool description still matches behaviour**

Read `src/repo-search/planner-protocol.ts:119-123` and `src/repo-search/repo-tool-arguments.ts:76-81`. Neither promises a message format, so no text change is needed. Do not add one.

---

### Task 2: Make the elision marker point at the tool result

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:326-341` (`buildRejectedTranscriptAction`)
- Test: `tests/repo-tools.test.ts:175`, `tests/repo-search-loop.core.test.ts:1260`

- [x] **Step 1: Update the assertions to the new wording**

`tests/repo-tools.test.ts:175` becomes:

```ts
  assert.match(String(action.args.elided), /^rejected edit call; 51,3\d\d chars of arguments discarded — the tool result states why; re-issue the call with fresh arguments$/u);
```

`tests/repo-search-loop.core.test.ts:1260` becomes:

```ts
    assert.match(duplicateArguments, /chars of arguments discarded — the tool result states why/u);
```

- [x] **Step 2: Run both suites to verify they fail**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools repo-search-loop.core 2>&1 | Select-String -Pattern "^(ℹ|✖|not ok)|AssertionError" | Select-Object -First 20
```

Expected: exactly the two updated assertions fail.

- [x] **Step 3: Change the marker text**

In `buildRejectedTranscriptAction` (`src/repo-search/engine/repo-tools.ts:336-340`) replace the `elided` value:

```ts
    args: {
      elided: `rejected ${effective.toolName} call; ${serializedLength.toLocaleString('en-US')} chars of arguments discarded — the tool result states why; re-issue the call with fresh arguments`,
    },
```

Check the length guard still holds: the marker for a 5-digit count is under 140 chars, far below `REJECTED_ARGS_ELISION_LIMIT` (512), so the existing `tests/repo-tools.test.ts:176` assertion `JSON.stringify(action.args).length < REJECTED_ARGS_ELISION_LIMIT` keeps passing.

- [x] **Step 4: Run both suites to verify they pass**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools repo-search-loop.core 2>&1 | Select-String -Pattern "^(ℹ|✖|not ok)|AssertionError" | Select-Object -First 20
```

Expected: `ℹ fail 0` for both files.

---

### Task 3: Full validation

**Files:** none modified.

- [ ] **Step 1: Typecheck and lint**

```powershell
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and any error file:line."
```

Expected: pass (`npm run typecheck` already runs `npm run lint` as its last step).

- [ ] **Step 2: Broader suite**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools repo-search-loop repo-tool-arguments text-encoding 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and relevant file:line anchors."
```

Expected: all pass.

- [ ] **Step 3: Check the tree**

```powershell
git status --short
```

Expected: only `src/repo-search/engine/repo-tools.ts`, `tests/repo-tools.test.ts`, `tests/repo-search-loop.core.test.ts`, and this plan are modified. No temp files. Do not commit unless asked.

---

## Self-review

- **Coverage:** defect 1 (index) → Task 1 tests "names the failing edit index" and the tightened uniqueness test; defect 2 (misleading prefix) → Task 1 "partially matching" and "no line-prefix" tests; defect 3 (elided arguments leave the model blind) → Task 1 makes the message self-sufficient, Task 2 tells the model where to look. Multi-failure reporting saves the turn-per-failure loop observed in the run.
- **Types:** `describeMissingOldText(originalText: string, oldText: string, index: number): string`, `lineNumberAt(text: string, offset: number): number`; `resolveEdits` return type unchanged (`ResolvedEdit[] | string`). No `any`, assertions, or non-null operators; `fileLines[nextIndex]` is handled via the explicit `undefined` check.
- **Placeholders:** none.
