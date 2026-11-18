# Tool Line Counts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every repository tool and orchestrator check counts file lines by one rule, `find`/`ls` report per-file line counts, `edit`/`write` report resulting lines, and the orchestrator prompt stops it from sizing files or tailing checks through `run_check`.

**Architecture:** A new `src/lib/source-lines.ts` owns line splitting, file classification (text, binary, too large), and count wording. `repo-tools.ts` (`read`, `find`, `ls`, `edit`, `write`) and `orchestrator/verification.ts` use it; no other code counts file lines. The spec is `docs/superpowers/specs/2026-11-17-tool-line-counts-design.md`.

**Tech Stack:** TypeScript on Node 26 (native type stripping), `node:test`, ripgrep for `grep`.

**Rules for every task:**
- TDD: failing test, then the minimum code, then a passing test.
- No `any`, type assertions, or non-null assertions. Comments stay at 1–2 lines.
- Run tests with `node .\src\test-runner\run-tests.ts <name filters>`.
- Never run `--process` tests while a real SiftKit or Tabby is up (see `docs/superpowers/specs/2026-11-17-run-c16a9829-followups.md` item 1).
- Do not commit.

**Fixture facts** (`tests/helpers/repo-tools-fixtures.ts` `makeRepo()`): `src/a.ts` has 5 lines; `src/nested/b.ts`, `src/notes.md`, and `.dotfile` have 1 line each; `node_modules/` is ignored.

---

### Task 1: The shared line module

**Files:**
- Create: `src/lib/source-lines.ts`
- Modify: `src/lib/text-encoding.ts:83-85`
- Test: `tests/source-lines.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/source-lines.test.ts`)

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describeFileLines, formatFileLines, formatLineCount, READ_MAX_BYTES, splitSourceLines } from '../src/lib/source-lines.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

test('splitSourceLines ends the last line at a trailing newline and gives an empty text no lines', () => {
  assert.deepEqual(splitSourceLines(''), []);
  assert.deepEqual(splitSourceLines('\n'), ['']);
  assert.deepEqual(splitSourceLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitSourceLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitSourceLines('a\n\n'), ['a', '']);
  assert.deepEqual(splitSourceLines('a\rb\n'), ['a\rb']);
});

test('describeFileLines decodes like read and classifies binary and oversized files', () => {
  const root = createManagedTempDir('siftkit-source-lines-');
  const write = (name: string, content: string | Buffer) => {
    fs.writeFileSync(path.join(root, name), content);
    return path.join(root, name);
  };
  assert.deepEqual(describeFileLines(write('crlf.txt', 'a\r\nb\r\n')), { kind: 'text', lines: ['a', 'b'] });
  assert.deepEqual(describeFileLines(write('empty.txt', '')), { kind: 'text', lines: [] });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\nb\nc\n', 'utf16le')]);
  assert.deepEqual(describeFileLines(write('utf16.txt', utf16)), { kind: 'text', lines: ['a', 'b', 'c'] });
  assert.deepEqual(describeFileLines(write('bin.dat', Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]))), { kind: 'binary' });
  const big = write('big.log', Buffer.alloc(READ_MAX_BYTES + 1, 0x61));
  assert.deepEqual(describeFileLines(big), { kind: 'too_large', bytes: READ_MAX_BYTES + 1 });
});

test('file line wording is shared by every tool', () => {
  assert.equal(formatLineCount(0), '0 lines');
  assert.equal(formatLineCount(1), '1 line');
  assert.equal(formatLineCount(2), '2 lines');
  assert.equal(formatFileLines({ kind: 'text', lines: ['a'] }), '(1 line)');
  assert.equal(formatFileLines({ kind: 'binary' }), '(binary)');
  assert.equal(formatFileLines({ kind: 'too_large', bytes: 2_400_000 }), '(2,400,000 bytes; too large to read)');
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node .\src\test-runner\run-tests.ts source-lines`
Expected: FAIL, because the module `../src/lib/source-lines.ts` does not exist.

- [ ] **Step 3: Implement**

In `src/lib/text-encoding.ts`, split the decode-and-normalize step out of `readSourceText` so a caller holding a buffer shares it:

```ts
/** Decodes source bytes and normalizes CRLF to LF, as `readSourceText` does for a path. */
export function decodeSourceText(buffer: Buffer): string {
  return decodeTextBuffer(buffer).replace(/\r\n/gu, '\n');
}

export function readSourceText(filePath: string): string {
  return decodeSourceText(readFileSync(filePath));
}
```

Keep the existing doc comment on `readSourceText`.

Create `src/lib/source-lines.ts`:

```ts
import { readFileSync, statSync } from 'node:fs';
import { decodeSourceText, detectEncoding } from './text-encoding.ts';

/** Largest file `read` opens; line counts stop at the same limit. */
export const READ_MAX_BYTES = 2_000_000;

/** What a file holds for line purposes: decoded lines, unreadable bytes, or a size over the read limit. */
export type FileLines =
  | { kind: 'text'; lines: string[] }
  | { kind: 'binary' }
  | { kind: 'too_large'; bytes: number };

/** A trailing newline ends the last line rather than starting an empty one; empty text has no lines. */
export function splitSourceLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

export function describeFileLines(absolutePath: string): FileLines {
  const bytes = statSync(absolutePath).size;
  if (bytes > READ_MAX_BYTES) return { kind: 'too_large', bytes };
  const buffer = readFileSync(absolutePath);
  if (detectEncoding(buffer) === 'utf8' && buffer.includes(0)) return { kind: 'binary' };
  return { kind: 'text', lines: splitSourceLines(decodeSourceText(buffer)) };
}

export function formatLineCount(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`;
}

/** The suffix `find` and `ls` put after a file name. */
export function formatFileLines(fileLines: FileLines): string {
  if (fileLines.kind === 'binary') return '(binary)';
  if (fileLines.kind === 'too_large') return `(${fileLines.bytes.toLocaleString('en-US')} bytes; too large to read)`;
  return `(${formatLineCount(fileLines.lines.length)})`;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node .\src\test-runner\run-tests.ts source-lines text-encoding`
Expected: PASS.

---

### Task 2: `read` on the shared module

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts` (the `READ_MAX_BYTES` export at line 38, `splitSourceLines` at lines 455-459, `planRead`, the two `(end of file: …)` / past-end wordings)
- Test: `tests/repo-tools.test.ts:757-763`, plus any `READ_MAX_BYTES` import in `tests/`

- [ ] **Step 1: Write the failing test.** Replace `planRead rejects an offset past the end of an empty file` with:

```ts
test('a read of an empty file says it is empty at any offset', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'empty.txt'), '', 'utf8');
  for (const offset of [1, 2]) {
    const plan = planRead({ path: 'empty.txt', offset }, root, buildIgnorePolicy(root));
    assert.ok(!isFailedReadPlan(plan));
    const execution = buildReadExecution('read', plan);
    assert.ok(execution.ok);
    assert.equal(execution.output, 'empty.txt is empty (0 lines).');
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node .\src\test-runner\run-tests.ts repo-tools`
Expected: FAIL. Offset 1 returns `1: ` with `(end of file: 1 line)`, and offset 2 is rejected.

- [ ] **Step 3: Implement**
  - Delete `export const READ_MAX_BYTES = 2_000_000;` and the local `splitSourceLines` from `repo-tools.ts`. Import `READ_MAX_BYTES`, `splitSourceLines`, and `formatLineCount` from `../../lib/source-lines.ts`, and update every `tests/` import of `READ_MAX_BYTES` to the new module. No re-export.
  - In `planRead`, after `const lines = splitSourceLines(sourceText);`, replace the empty-file rejection (`if (pastEnd && sourceText === '') { … }`) with:

```ts
  if (lines.length === 0) {
    const displayPath = resolvedPath.relativePath;
    return {
      requestedCommand, commandPath, requestedStartLine: 1, requestedEndLine: 0, effectiveStartLine: 1,
      effectiveEndLineExclusive: 1, totalEndLineExclusive: 1, pathKey: buildReadPathKey(displayPath), displayPath,
      lines, hasUnread: false, noUnreadOutput: `${displayPath} is empty (0 lines).`, notice: null,
    };
  }
```

  - Make `sourceText` a plain argument: `const lines = splitSourceLines(readSourceText(resolvedPath.absolutePath));`.
  - Replace both `${lines.length} line${lines.length === 1 ? '' : 's'}` wordings and the `lineCount` wording in `buildReadExecution` with `formatLineCount(...)`.

- [ ] **Step 4: Run and see it pass**

Run: `node .\src\test-runner\run-tests.ts repo-tools`
Expected: PASS. That includes `planRead does not count a trailing newline as an extra line` and the past-end tests.

---

### Task 3: `find` and `ls` line counts

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts` (`executeFind`, `executeLs`)
- Test: `tests/repo-tools.test.ts` (find and ls sections)

- [ ] **Step 1: Write the failing tests.** Update the expected output in every `find`/`ls` test to carry the suffix. These are the exact replacements:
  - `['src/a.ts', 'src/nested/b.ts']` becomes `['src/a.ts (5 lines)', 'src/nested/b.ts (1 line)']`. This appears in the recursive-glob, mid-pattern `**/`, and omitted-limit tests.
  - `'b.ts'` becomes `'b.ts (1 line)'`.
  - `'architecture_overview.md'` becomes `'architecture_overview.md (1 line)'`.
  - `['root.ts', 'src/a.ts', 'src/nested/b.ts']` becomes `['root.ts (1 line)', 'src/a.ts (5 lines)', 'src/nested/b.ts (1 line)']`.
  - `['src/a.ts', 'src/nested/b.ts', 'src/notes.md']` becomes `['src/a.ts (5 lines)', 'src/nested/b.ts (1 line)', 'src/notes.md (1 line)']`.
  - `'src/nested/b.ts'` (basename test) becomes `'src/nested/b.ts (1 line)'`; `'src/a.ts'` (`?` test) becomes `'src/a.ts (5 lines)'`; `'src/notes.md'` becomes `'src/notes.md (1 line)'`.
  - `'eval/results/keep.ts'` becomes `'eval/results/keep.ts (1 line)'`, and the from-root list becomes `['src/a.ts (5 lines)', 'src/nested/b.ts (1 line)', 'sub/eval/results/keep.ts (1 line)']`.
  - ls: `['.dotfile', 'src/']` becomes `['.dotfile (1 line)', 'src/']` (both occurrences), and `['a.ts', 'nested/', 'notes.md']` becomes `['a.ts (5 lines)', 'nested/', 'notes.md (1 line)']`.
  - The `find and ls order the same names the same way` test stays as written; both outputs now end in ` (1 line)`.

  Then add:

```ts
test('find and ls mark binary and oversized files instead of counting them', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d, 0x49]));
  fs.writeFileSync(path.join(root, 'assets', 'big.log'), Buffer.alloc(READ_MAX_BYTES + 1, 0x61));
  const found = await executeRepoTool(nativeCall('find', { pattern: '*', path: 'assets' }), makeContext(root));
  const listed = await executeRepoTool(nativeCall('ls', { path: 'assets' }), makeContext(root));
  const expected = [`big.log (${(READ_MAX_BYTES + 1).toLocaleString('en-US')} bytes; too large to read)`, 'logo.png (binary)'];
  assert.ok(found.ok && listed.ok);
  assert.deepEqual(found.output.split('\n'), expected);
  assert.deepEqual(listed.output.split('\n'), expected);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node .\src\test-runner\run-tests.ts repo-tools`
Expected: the updated find/ls tests and the new test FAIL, because the outputs have no suffix.

- [ ] **Step 3: Implement.** Import `describeFileLines` and `formatFileLines` from `../../lib/source-lines.ts`.
  - In `executeFind`, label the shown paths after the limit is applied:

```ts
  const label = (searchRelativePath: string) => `${searchRelativePath} ${formatFileLines(describeFileLines(join(resolvedPath.absolutePath, searchRelativePath)))}`;
  const shown = filtered.slice(0, limit).map(label);
  const output = filtered.length === 0
    ? 'No files matched.'
    : truncated
      ? `${shown.join('\n')}\n... ${filtered.length - limit} more files beyond limit=${limit}; narrow the pattern or path.`
      : shown.join('\n');
```

  - In `executeLs`, sort by name, then label. Directories keep `name/`, and other non-files keep the bare name:

```ts
  const entries: { name: string; display: string }[] = [];
  for (const entry of readdirSync(resolvedPath.absolutePath, { withFileTypes: true })) {
    const entryRelativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (isRepoRelativePathIgnored(entryRelativePath, context.ignorePolicy)) {
      continue;
    }
    const display = entry.isDirectory() ? `${entry.name}/`
      : entry.isFile() ? `${entry.name} ${formatFileLines(describeFileLines(join(resolvedPath.absolutePath, entry.name)))}` : entry.name;
    entries.push({ name: entry.isDirectory() ? `${entry.name}/` : entry.name, display });
  }
  entries.sort((left, right) => compareDisplayNames(left.name, right.name));
  const limit = args.limit ?? LS_DEFAULT_LIMIT;
  const truncated = entries.length > limit;
  const shown = entries.slice(0, limit).map((entry) => entry.display);
  const output = entries.length === 0
    ? 'Directory is empty.'
    : truncated
      ? `${shown.join('\n')}\n... ${entries.length - limit} more entries beyond limit=${limit}.`
      : shown.join('\n');
```

- [ ] **Step 4: Run and see them pass**

Run: `node .\src\test-runner\run-tests.ts repo-tools`
Expected: PASS.

---

### Task 4: `edit` and `write` report lines

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts` (`executeWrite` output, `executeEdit` apply loop and output)
- Test: `tests/repo-tools.test.ts` (write/edit section)

- [ ] **Step 1: Write the failing tests**

```ts
test('write reports the byte size and the line count it left the file with', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(nativeCall('write', { path: 'gen/new.ts', content: 'a\nb\nc\n' }), makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'Wrote 6 bytes to gen/new.ts (3 lines).');
});

test('edit reports where each new text now sits and the new file length', async () => {
  const root = makeRepo();
  // src/a.ts: line1 / alpha / line3 / alpha / line5
  const replaced = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line5', newText: 'five\nsix\nseven' }, { oldText: 'line1', newText: 'first' }],
  }), makeContext(root));
  assert.ok(replaced.ok, replaced.ok ? '' : replaced.reason);
  assert.equal(replaced.output, 'Applied 2 edit(s) to src/a.ts: lines 1, 5-7; file now 7 lines.');
  const removed = await executeRepoTool(nativeCall('edit', {
    path: 'src/a.ts', edits: [{ oldText: 'line3\n', newText: '' }],
  }), makeContext(root));
  assert.ok(removed.ok, removed.ok ? '' : removed.reason);
  assert.equal(removed.output, 'Applied 1 edit(s) to src/a.ts: line 3 (removed); file now 6 lines.');
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node .\src\test-runner\run-tests.ts repo-tools`
Expected: FAIL. The outputs are `Wrote 6 bytes to gen/new.ts.` and `Applied 2 edit(s) to src/a.ts.`

- [ ] **Step 3: Implement**
  - `executeWrite`: ``output: `Wrote ${Buffer.byteLength(finalContent, 'utf8')} bytes to ${resolvedPath.relativePath} (${formatLineCount(splitSourceLines(args.content).length)}).` ``. The count uses the model's LF content, which has the same lines as the CRLF write-back.
  - `executeEdit`: record each edit's start in the updated text while applying, then describe the ranges.

```ts
  let updatedText = '';
  let cursor = 0;
  const placed: { start: number; length: number }[] = [];
  for (const edit of resolved) {
    updatedText += originalText.slice(cursor, edit.start);
    placed.push({ start: updatedText.length, length: edit.newText.length });
    updatedText += edit.newText;
    cursor = edit.end;
  }
  updatedText += originalText.slice(cursor);
  writeFileSync(resolvedPath.absolutePath, applyEolStyle(updatedText, eolStyle), 'utf8');
  const totalLines = splitSourceLines(updatedText).length;
  // A removal names the line its gap now sits on, clamped into the file.
  const describePlaced = ({ start, length }: { start: number; length: number }) => {
    const first = Math.min(lineNumberAt(updatedText, start), Math.max(totalLines, 1));
    if (length === 0) return `line ${first} (removed)`;
    const last = lineNumberAt(updatedText, start + length - 1);
    return first === last ? `${first}` : `${first}-${last}`;
  };
  const ranges = placed.map(describePlaced);
  const rangeText = placed.every((entry) => entry.length === 0) ? ranges.join(', ') : `lines ${ranges.join(', ')}`;
  return {
    ok: true, requestedCommand: command, command, exitCode: 0,
    output: `Applied ${resolved.length} edit(s) to ${resolvedPath.relativePath}: ${rangeText}; file now ${formatLineCount(totalLines)}.`,
    toolType: 'edit', outputUnit: 'lines',
    mutatedPath: resolvedPath.relativePath,
  };
```

  `resolved` is already sorted by start (`resolveEdits` returns `ordered`), so the ranges are in file order.

- [ ] **Step 4: Run and see them pass**

Run: `node .\src\test-runner\run-tests.ts repo-tools`
Expected: PASS.

---

### Task 5: Orchestrator evidence and citation checks

**Files:**
- Modify: `src/orchestrator/verification.ts:51-70`
- Test: `tests/orchestrator-verification.test.ts`

- [ ] **Step 1: Write the failing test.** Read the top of `tests/orchestrator-verification.test.ts` for its temp-repo helper, and use it (or `createManagedTempDir`) as `root`:

```ts
test('evidence and citation checks count lines as read does', () => {
  const root = createManagedTempDir('siftkit-verification-lines-');
  fs.writeFileSync(path.join(root, 'two.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'wide.ts'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('const wide = 1;\n', 'utf16le')]));
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x04, 0x05, 0x06, 0x07]));
  assert.equal(findCitationProblem(root, { path: 'two.ts', line: 2 }), null);
  assert.equal(findCitationProblem(root, { path: 'two.ts', line: 3 }), 'two.ts:3 is past the end of the file');
  assert.equal(findEvidenceProblem(root, { path: 'wide.ts', line: 1, snippet: 'const wide = 1;' }), null);
  assert.equal(findCitationProblem(root, { path: 'blob.bin', line: 1 }), 'blob.bin is not a text file the checks can read');
  assert.equal(findEvidenceProblem(root, { path: 'blob.bin', line: 1, snippet: 'x' }), 'blob.bin is not a text file the checks can read');
});
```

  If `OrchestratorCodeEvidence` needs more fields than `path`, `line`, and `snippet`, add the required ones with the values the file's existing evidence tests use.

- [ ] **Step 2: Run and see it fail**

Run: `node .\src\test-runner\run-tests.ts orchestrator-verification`
Expected: FAIL. `two.ts:3` passes today because of the phantom line, the UTF-16 snippet is not found, and binary files are read as text.

- [ ] **Step 3: Implement.** Import `describeFileLines` from `../lib/source-lines.ts`:

```ts
/** A cited file's lines as read counts them, or a problem when the checks cannot read it as text. */
function readCitedLines(absolutePath: string, path: string): string[] | string {
  const fileLines = describeFileLines(absolutePath);
  return fileLines.kind === 'text' ? fileLines.lines : `${path} is not a text file the checks can read`;
}
```

  In `findEvidenceProblem`, replace `const lines = readFileSync(...).split(/\r?\n/u);` with `const lines = readCitedLines(resolved.absolutePath, evidence.path); if (typeof lines === 'string') return lines;`. In `findCitationProblem`, use the same call and compare `citation.line > lines.length`. Remove the `readFileSync` import if nothing else uses it.

- [ ] **Step 4: Run and see it pass**

Run: `node .\src\test-runner\run-tests.ts orchestrator-verification`
Expected: PASS.

---

### Task 6: Prompts and tool descriptions

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:107,112`, `src/repo-search/prompts.ts:366-367`, `src/orchestrator/prompts.ts:91-92`
- Test: `tests/repo-search-planner-protocol.test.ts`, `tests/repo-search-prompts.test.ts`, `tests/orchestrator-prompts.test.ts`

- [ ] **Step 1: Write the failing tests**
  - `tests/orchestrator-prompts.test.ts`: assert that `buildOrchestratorPrompt(brief())` includes:
    - `find and ls report each file's line count; use them to size files, not run_check.`
    - `Run checks as plain commands, with no tail pipelines (Select-Object -Last, | tail) or redirection; run_check already keeps a digest of the whole output and its final lines.`

    Use the file's existing `brief()` helper.
  - `tests/repo-search-prompts.test.ts`: assert that `buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true))` includes `- find: locate files by glob, each with its line count.` and `- ls: list a directory one level deep, with each file's line count.`
  - `tests/repo-search-planner-protocol.test.ts`: find the tool-definitions lookup the file already uses, then assert that the `find` description includes `Each path ends with its line count` and the `ls` description includes `Files end with their line count; directories do not.`

- [ ] **Step 2: Run and see them fail**

Run: `node .\src\test-runner\run-tests.ts orchestrator-prompts repo-search-prompts repo-search-planner-protocol`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**
  - **`find` description:** append ` Each path ends with its line count, or (binary) or a byte size for files read cannot open.`
  - **`ls` description:** append ` Files end with their line count; directories do not.`
  - **Agent tool list:** `'- find: locate files by glob, each with its line count.'` and `'- ls: list a directory one level deep, with each file\'s line count.'`
  - **Orchestrator prompt:** after the `Read and search code with your read tools, not run_check.` line, add the two strings from Step 1 as their own array entries.

- [ ] **Step 4: Run and see them pass**

Run: `node .\src\test-runner\run-tests.ts orchestrator-prompts repo-search-prompts repo-search-planner-protocol`
Expected: PASS.

---

### Task 7: Cross-tool agreement

**Files:**
- Create: `tests/line-count-agreement.test.ts`

- [ ] **Step 1: Write the test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildIgnorePolicy } from '../src/repo-search/command-safety.ts';
import { buildReadExecution, executeRepoTool, isFailedReadPlan, planRead } from '../src/repo-search/engine/repo-tools.ts';
import { findCitationProblem } from '../src/orchestrator/verification.ts';
import { makeContext, makeRepo, nativeCall } from './helpers/repo-tools-fixtures.ts';

const FIXTURES: { name: string; content: string | Buffer; lines: number; lastLineBlank: boolean }[] = [
  { name: 'lf.txt', content: 'a\nb\n', lines: 2, lastLineBlank: false },
  { name: 'crlf.txt', content: 'a\r\nb\r\n', lines: 2, lastLineBlank: false },
  { name: 'nofinal.txt', content: 'a\nb', lines: 2, lastLineBlank: false },
  { name: 'empty.txt', content: '', lines: 0, lastLineBlank: true },
  { name: 'newline.txt', content: '\n', lines: 1, lastLineBlank: true },
  { name: 'blanklast.txt', content: 'a\n\n', lines: 2, lastLineBlank: true },
  { name: 'lonecr.txt', content: 'a\rb\n', lines: 1, lastLineBlank: false },
  { name: 'utf16.txt', content: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\nb\nc\n', 'utf16le')]), lines: 3, lastLineBlank: false },
];

const countIn = (output: string, name: string): number => {
  const line = output.split('\n').find((entry) => entry.startsWith(`${name} (`));
  const match = line === undefined ? null : /\((\d+) lines?\)$/u.exec(line);
  if (match === null) throw new Error(`no line count for ${name} in:\n${output}`);
  return Number(match[1]);
};

test('find, ls, read, grep, and the citation check agree on every file\'s line count', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'lines'));
  for (const fixture of FIXTURES) fs.writeFileSync(path.join(root, 'lines', fixture.name), fixture.content);
  const context = makeContext(root);
  const found = await executeRepoTool(nativeCall('find', { pattern: '*', path: 'lines' }), context);
  const listed = await executeRepoTool(nativeCall('ls', { path: 'lines' }), context);
  assert.ok(found.ok && listed.ok);
  for (const fixture of FIXTURES) {
    const relative = `lines/${fixture.name}`;
    assert.equal(countIn(found.output, fixture.name), fixture.lines, `find ${fixture.name}`);
    assert.equal(countIn(listed.output, fixture.name), fixture.lines, `ls ${fixture.name}`);
    const plan = planRead({ path: relative, offset: 1 }, root, buildIgnorePolicy(root));
    assert.ok(!isFailedReadPlan(plan));
    const read = buildReadExecution('read', plan);
    assert.ok(read.ok);
    assert.ok(read.output.endsWith(fixture.lines === 0 ? 'is empty (0 lines).' : `(end of file: ${fixture.lines} line${fixture.lines === 1 ? '' : 's'})`), `read ${fixture.name}: ${read.output}`);
    if (!fixture.lastLineBlank) {
      const grep = await executeRepoTool(nativeCall('grep', { pattern: '.', path: relative }), context);
      assert.ok(grep.ok);
      const numbers = grep.output.split('\n').map((entry) => Number(/:(\d+):/u.exec(entry)?.[1] ?? Number.NaN));
      assert.equal(Math.max(...numbers), fixture.lines, `grep ${fixture.name}: ${grep.output}`);
    }
    if (fixture.lines > 0) assert.equal(findCitationProblem(root, { path: relative, line: fixture.lines }), null, `citation ${fixture.name}`);
    assert.equal(findCitationProblem(root, { path: relative, line: fixture.lines + 1 }), `${relative}:${fixture.lines + 1} is past the end of the file`);
  }
});
```

- [ ] **Step 2: Run it**

Run: `node .\src\test-runner\run-tests.ts line-count-agreement`
Expected: PASS after Tasks 1–5.
- A `grep` mismatch on `lonecr.txt` or `utf16.txt` is a real disagreement between `rg` and the line rule. Investigate it; do not weaken the test.
- If `grep` with a file `path` is rejected, use the directory path `lines` and pick that file's entries by name.

---

### Task 8: Spec touch-up and final checks

- [ ] **Step 1:** In the spec's testing section, drop "`edit` appending one line reports `file now N+1 lines`" from the agreement test, because Task 4 covers the edit total. Then confirm no other spec line is unimplemented.
  - As built: the default suite forbids spawning `rg` (`src/test-runner/live-instance-guard.ts`), so Task 7's grep check moved to `tests/process/repo-tools.test.ts`. The fixtures moved to `tests/helpers/line-count-fixtures.ts`, shared by both tests.
- [ ] **Step 2:** With SiftKit and Tabby stopped, run `npm run typecheck`, `npm run lint`, the touched test files, `npm test`, and `npx vitest run --config ./dashboard/vitest.config.ts`. Fix any test elsewhere that asserted the old `find`/`ls`/`edit`/`write` output.
