# Edit Diagnostics Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the three drift findings from the 2026-09-21 edit-diagnostics work: a kind-specific hint in the generic elision marker, a diagnostic format applied to only one edit-failure branch, and a single-caller helper heavier than the value it computes.

**Architecture:** All changes are inside `src/repo-search/engine/repo-tools.ts`. The elision marker loses its remediation clause. `resolveEdits` gets one message convention for all three failure kinds (not-found, not-unique, overlap), each naming `edits[i]` and file lines. `lineNumberAt` becomes a one-line expression reused by the not-found and not-unique branches. Success path unchanged.

**Tech Stack:** TypeScript (strict, inferred), `node:test`, existing repo test runner.

Test commands:

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools repo-search-loop.core
```

Fixture (`makeRepo`, `tests/repo-tools.test.ts:39-51`): `src/a.ts` is `line1\nalpha\nline3\nalpha\nline5\n`, so `alpha` sits on file lines 2 and 4.

---

### Task 1: Kind-neutral elision marker

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:339`
- Test: `tests/repo-tools.test.ts:175`

- [ ] **Step 1: Update the assertion**

`tests/repo-tools.test.ts:175` becomes:

```ts
  assert.match(String(action.args.elided), /^rejected edit call; 51,3\d\d chars of arguments discarded — the tool result states why$/u);
```

`tests/repo-search-loop.core.test.ts:1260` already matches `/chars of arguments discarded — the tool result states why/u` and needs no change.

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools 2>&1 | Select-String -Pattern "^(ℹ|✖|not ok)|AssertionError" | Select-Object -First 10
```

Expected: exactly `buildRejectedTranscriptAction elides an oversized argument payload` fails.

- [ ] **Step 3: Drop the remediation clause**

In `buildRejectedTranscriptAction` (`src/repo-search/engine/repo-tools.ts:339`):

```ts
      elided: `rejected ${effective.toolName} call; ${serializedLength.toLocaleString('en-US')} chars of arguments discarded — the tool result states why`,
```

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: `ℹ fail 0`.

---

### Task 2: One message convention for every edit failure

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:781-838`
- Test: `tests/repo-tools.test.ts` (existing edit tests at 702-788)

- [ ] **Step 1: Update and add tests**

In `edit rejects a non-unique oldText and leaves the file untouched` replace the reason assertion with:

```ts
  assert.match(result.reason, /^edits\[0\]\.oldText is not unique in file; it matches at file lines 2 and 4\. Extend oldText with neighbouring lines so it matches once\.$/u);
```

In `edit rejects a missing oldText and overlapping edits` replace `assert.match(overlapping.reason, /overlap/u);` with:

```ts
  assert.match(overlapping.reason, /^edits\[0\] and edits\[1\] overlap; merge nearby changes into one edit$/u);
```

In `edit reports every failing edit in one rejection` replace the `lines[1]` assertion with:

```ts
  assert.match(lines[1], /^edits\[1\]\.oldText is not unique in file; it matches at file lines 2 and 4\./u);
```

Append after `edit reports every failing edit in one rejection`:

```ts
test('edit overlap names the edits in file order using their original indices', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha\nline3', newText: 'y' }, { oldText: 'line1\nalpha', newText: 'x' }],
  }), makeContext(root));
  assert.ok(!result.ok);
  assert.match(result.reason, /^edits\[1\] and edits\[0\] overlap; merge nearby changes into one edit$/u);
});
```

- [ ] **Step 2: Run to verify they fail**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools 2>&1 | Select-String -Pattern "^(ℹ|✖|not ok)|AssertionError" | Select-Object -First 20
```

Expected: the three updated assertions and the new test fail; nothing else.

- [ ] **Step 3: Replace the edit-resolution block**

Replace everything from `type ResolvedEdit = ...` through the end of `resolveEdits` in `src/repo-search/engine/repo-tools.ts` with:

```ts
type ResolvedEdit = { index: number; start: number; end: number; newText: string };

/** 1-based line number of a character offset in LF-normalized text. */
function lineNumberAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
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
    const fileLines = originalText.split('\n');
    const nextIndex = fileLine - 1 + count;
    const nextFileLine = fileLines[nextIndex];
    const atEnd = nextFileLine === undefined || (nextIndex === fileLines.length - 1 && nextFileLine === '');
    const actual = atEnd ? '"" (end of file)' : JSON.stringify(nextFileLine);
    return `${label}; oldText lines 1-${count} match at file line ${fileLine}, but oldText line ${count + 1} is ${JSON.stringify(lines[count])} while the file has ${actual}. ${RECOPY_HINT}`;
  }
  return `${label}; its first line does not occur anywhere: ${JSON.stringify(lines[0])}. ${RECOPY_HINT}`;
}

function resolveEdits(originalText: string, rawEdits: EditToolArgs['edits']): ResolvedEdit[] | string {
  const resolved: ResolvedEdit[] = [];
  const failures: string[] = [];
  for (const [index, { oldText, newText }] of rawEdits.entries()) {
    const start = originalText.indexOf(oldText);
    if (start < 0) {
      failures.push(describeMissingOldText(originalText, oldText, index));
      continue;
    }
    const second = originalText.indexOf(oldText, start + 1);
    if (second >= 0) {
      failures.push(`edits[${index}].oldText is not unique in file; it matches at file lines ${lineNumberAt(originalText, start)} and ${lineNumberAt(originalText, second)}. Extend oldText with neighbouring lines so it matches once.`);
      continue;
    }
    resolved.push({ index, start, end: start + oldText.length, newText });
  }
  if (failures.length > 0) {
    return failures.join('\n');
  }
  const ordered = [...resolved].sort((left, right) => left.start - right.start);
  for (let position = 1; position < ordered.length; position += 1) {
    if (ordered[position].start < ordered[position - 1].end) {
      return `edits[${ordered[position - 1].index}] and edits[${ordered[position].index}] overlap; merge nearby changes into one edit`;
    }
  }
  return ordered;
}
```

This block also delivers Task 3 (one-line `lineNumberAt`, `fileLines` split only inside the matched branch, `for...of` instead of `forEach`). `executeEdit` reads only `start`, `end`, `newText` from `ResolvedEdit`, so the added `index` field needs no other change.

- [ ] **Step 4: Run to verify they pass**

```powershell
npm run build:test; node .\dist\test-runner\run-tests.js repo-tools repo-search-loop.core 2>&1 | Select-String -Pattern "^(ℹ|✖|not ok)|AssertionError" | Select-Object -First 20
```

Expected: `ℹ fail 0` for both files.

---

### Task 3: Confirm the helper simplification landed

**Files:** none beyond Task 2.

- [ ] **Step 1: Verify by inspection**

```powershell
Select-String -Path src\repo-search\engine\repo-tools.ts -Pattern "lineNumberAt|forEach\(\(\{ oldText|charCodeAt\(index\) === 10"
```

Expected: `lineNumberAt` appears as the one-line function and in three call sites; no `charCodeAt(index) === 10` loop; no `forEach(({ oldText`.

- [ ] **Step 2: Typecheck and lint**

```powershell
npm run typecheck 2>&1 | Select-Object -Last 5; "exit: $LASTEXITCODE"
```

Expected: `exit: 0`.
