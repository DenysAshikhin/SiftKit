# Repo-Tool and Command-Gate Harness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every validated defect in the repo-search tool harness — wrong glob semantics, wrong ignore frames, broken duplicate/novelty/stall accounting, a leaky command-safety gate, crash-on-throw native tools, misaligned per-action results, path-key and symlink containment holes, inconsistent grep/find/ls behavior — and amend the typed-git design spec with the security gaps found in review.

**Architecture:** Every defect lives on the path from a planner tool call to its result. The native tools (`read`/`grep`/`find`/`ls`/`write`/`edit`/`run`) live in `src/repo-search/engine/repo-tools.ts`; the per-call pipeline (validation → duplicate screening → execution → novelty → transcript) lives in `src/repo-search/engine/tool-action-processor.ts` with state helpers (`duplicate-tracker.ts`, `read-overlap.ts`, `transcript-manager.ts`) beside it; the `git` command string gate is `src/repo-search/command-safety.ts`. Each task is independently testable and independently committable.

**Tech Stack:** TypeScript (ESM, strict), `node:test` + `node:assert/strict`, tsx loader, eslint.

---

## Defect catalog

Each defect below is independently reproduced against the current tree. "Task" is where this plan fixes it.

| ID  | Defect (one line)                                                                  | Where                                            | Task  |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------ | ----- |
| D1  | `**/` in `find` globs never matches zero directories                               | `repo-tools.ts` `globToRegExp`                   | 1–4   |
| D2  | `find` applies root-relative ignore paths in search-relative coordinates           | `repo-tools.ts` `executeFind`                    | 5     |
| D3  | Duplicate detector remembers only the immediately preceding call                   | `duplicate-tracker.ts`                           | 6     |
| D4  | An empty tool output is counted as *new evidence*                                  | `tool-action-processor.ts`                       | 7     |
| D5  | `git` safety gate rejects valid commands on substrings; allows `$(...)`            | `command-safety.ts`                              | 8     |
| D6  | `find` and `ls` sort the same names differently                                    | `repo-tools.ts`                                  | 9     |
| D7  | `limit: 0` silently becomes the tool's *maximum* default                           | `repo-tools.ts`                                  | 10    |
| D8  | `read` counts a trailing newline as an extra phantom line                          | `repo-tools.ts` `planRead`                       | 11    |
| D9  | A thrown fs error in a native tool crashes the whole run                           | `repo-tools.ts` `executeRepoTool`                | 12    |
| D10 | Invalid actions skip the `commands` array, misaligning results to actions          | `tool-action-processor.ts` / `task-loop.ts`      | 13    |
| D11 | Read path keys are always lowercased — distinct files collide on Linux             | `read-overlap.ts` `buildReadPathKey`             | 14    |
| D12 | An in-repo symlink to an outside target defeats repo-root containment             | `repo-tools.ts` `resolveRepoScopedPath`          | 15    |
| D13 | grep's ignore globs disagree with the native ignore check (case, file-vs-dir)      | `repo-tools.ts` `buildGrepArgs`                  | 16    |
| D14 | grep's `limit` counts output lines (incl. context/separators), not matches         | `repo-tools.ts` `executeGrep`                    | 17    |
| D15 | `run`'s `timeout` silently drops non-positive values and is absent from dedup key  | `repo-tools.ts` `executeRun`                     | 18    |
| D16 | Duplicate replay anchor survives transcript compaction and rewrites wrong message  | `duplicate-tracker.ts` / `transcript-manager.ts` | 19    |
| D17 | Empty results: grep says "No matches found.", find/ls return `''` — different stall accounting | `repo-tools.ts`                       | 20    |
| D18 | `read` loads unbounded files into memory; offset past EOF silently returns last line | `repo-tools.ts` `planRead`                     | 21    |
| D19 | Typed-git design spec: config-driven execution, pattern injection, env contract    | spec + `lib/command-spawn.ts`                    | 22    |

**Background:** D1–D4 observed in repo-search run `29e8ec87-f4ef-4eee-a8d6-f039bf506d50`. The planner issued `find pattern="**/architecture_overview.md" path=".worktrees/damage-opposite-side"` three times (turns 2, 3, 5) against a file that exists at that path's root. Each call returned empty output and tripped the zero-output countdown. Turn 18's `find pattern="architecture_overview.md"` — same file, no `**/` — returned it immediately. D9–D19 come from the design-review pass over `docs/superpowers/specs/2026-08-02-typed-native-git-tool-design.md` (2026-08-02).

**Verified against the current tree** (scratch harness, since deleted):

```
find **/architecture_overview.md   => []                                   (Task 2)
find **/*.ts                       => ["src/a.ts","src/nested/b.ts","sub/eval/results/keep.ts"]   root.ts missing
find src/**/*.ts                   => ["src/nested/b.ts"]                  src/a.ts missing
find path=eval  **/*.ts            => ["results/leak.ts"]                  ignored path LEAKED (Task 5)
find path=sub   **/*.ts            => []                                   non-ignored file DROPPED (Task 5)
grep path=eval  leak               => "No matches found."                  grep is correct
ls   path=eval                     => []                                   ls is correct
git log --oneline -- docs/rm.md    => BLOCK "destructive, file-writing..." (Task 8)
git grep -n "export-default"       => BLOCK "destructive, file-writing..." (Task 8)
git log --format="%h <%an>"        => BLOCK "file redirection is not allowed" (Task 8)
```

**Out of scope:** reporting an exact character/byte count for a file with *unstaged* modifications. `Measure-Object` is in `READ_ONLY_PIPE_COMMANDS`, so `git show HEAD:<path> | Measure-Object -Character` (committed blob) and `git show :<path> | Measure-Object -Character` (index blob, identical to the working tree for an unmodified file) both already work, as does `git cat-file -s HEAD:<path>`. Only a dirty working-tree file is unreachable. That is a narrower gap than first assessed and needs its own plan.

---

### Task 1: Failing tests for zero-directory `**/`

**What:** Add tests proving that a `**/` glob segment should match *zero* directories as well as many.

**Why:** In every mainstream glob dialect (gitignore, ripgrep, VS Code), `**/name.md` matches a root-level `name.md`. Our compiler emits `.*` + a mandatory `/`, so it silently requires at least one directory. The planner burned three turns (run `29e8ec87`, turns 2/3/5) on a file that was there the whole time:

| Pattern                        | File on disk                | Should match | Currently matches |
| ------------------------------ | --------------------------- | ------------ | ----------------- |
| `**/architecture_overview.md`  | `architecture_overview.md`  | ✅           | ❌                |
| `**/architecture_overview.md`  | `docs/architecture_overview.md` | ✅       | ✅                |
| `**/*.ts`                      | `root.ts`                   | ✅           | ❌                |
| `src/**/*.ts`                  | `src/a.ts`                  | ✅           | ❌                |
| `src/**/*.ts`                  | `src/nested/b.ts`           | ✅           | ✅                |

**How:** TDD — write the three failing tests first (this task), then fix the compiler (Task 2).

**Files:**
- Modify: `tests/repo-tools.test.ts` (append after the existing `find` block, which ends at line 323)

The shared `makeRepo()` fixture at `tests/repo-tools.test.ts:20-32` deliberately has **no** root-level `.ts` or `.md` file, and several existing assertions depend on that exact tree. Do **not** add files to `makeRepo()`. Each new test writes the file it needs into the returned root.

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts`, immediately after the `find requires a pattern and rejects escapes` test (currently ends at line 323) and before the `// ls` banner comment at line 325:

```ts
test('find matches a search-root file through a leading **/ segment', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'architecture_overview.md'), 'notes\n', 'utf8');
  const result = await executeRepoTool('find', { pattern: '**/architecture_overview.md' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'architecture_overview.md');
});

test('find with a leading **/ returns root-level and nested matches together', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'root.ts'), 'alpha root\n', 'utf8');
  const result = await executeRepoTool('find', { pattern: '**/*.ts' }, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['root.ts', 'src/a.ts', 'src/nested/b.ts']);
});

test('find with a mid-pattern **/ spans zero directories as well as many', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: 'src/**/*.ts' }, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
});
```

`fs`, `path`, `executeRepoTool`, `makeRepo`, and `makeContext` are already imported/defined in this file (lines 3-4, 12, 20, 43). Add no imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test --test-name-pattern "find .*\*\*" .\tests\repo-tools.test.ts
```

Expected: 3 tests run, 3 fail.
- `find matches a search-root file through a leading **/ segment` → `AssertionError: '' !== 'architecture_overview.md'`
- `find with a leading **/ returns root-level and nested matches together` → actual `['src/a.ts', 'src/nested/b.ts']`, missing `root.ts`
- `find with a mid-pattern **/ spans zero directories as well as many` → actual `['src/nested/b.ts']`, missing `src/a.ts`

If any of the three passes, stop — the fix has already landed and this plan is stale.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/repo-tools.test.ts
git commit -m "test: cover zero-directory **/ matching in the find repo tool"
```

---

### Task 2: Compile `**/` as a zero-or-more-directory token

**What:** Rewrite `globToRegExp` so `**/` compiles to an *optional* directory-run group instead of a mandatory one.

**Why:** The current compiler turns `**/name.md` into `^.*\/name\.md$` — the `/` is unconditional, so at least one directory is required. The correct regex is `^(?:.*\/)?name\.md$`, where the whole "directories plus slash" chunk is optional:

```
   pattern:   **/name.md
   old regex: ^ .*  /  name\.md $     "something, then a slash, then name.md"
                └──┬──┘
                mandatory → root-level name.md can never match

   new regex: ^ (?: .* / )?  name\.md $   "optionally: something then a slash"
                └────┬─────┘
                optional → root-level name.md matches too
```

**How:** Inspect `**` *before* the single-`*` branch so the `**/` lookahead can fire; emit `(?:.*/)?` for `**/` and keep bare `**` as a cross-separator wildcard.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:280-305`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Replace `globToRegExp`**

Replace the whole function at `src/repo-search/engine/repo-tools.ts:280-305` with:

```ts
function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      // `**/` spans zero or more directories, so `**/name.md` also matches a
      // search-root `name.md`. A bare `**` stays a cross-separator wildcard.
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
        continue;
      }
      pattern += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    if ('\\.[]{}()+^$|'.includes(char)) {
      pattern += `\\${char}`;
      continue;
    }
    pattern += char;
  }
  pattern += '$';
  return new RegExp(pattern, 'iu');
}
```

Three things changed from the original:
1. `**` is now inspected before the single-`*` branch so the `**/` lookahead can fire.
2. `**/` consumes three characters (`index += 2` plus the loop's `+= 1`) and emits `(?:.*/)?` — the optional group is what allows zero directories. `(?:.*/)?` and `(?:[^/]*/)*` accept the same language (any string that is empty or ends in `/`); the optional form is chosen because it is one group with one quantifier instead of a quantified group, which is simpler to read and cheaper to match. It is **not** chosen for ReDoS reasons: the body of `(?:[^/]*/)*` is `[^/]*/`, which must consume the `/` and therefore cannot match empty, so that form has no nullable-body backtracking hazard either.
3. The trailing statement is now `pattern += char;`. The old `pattern += char === '\\' ? '/' : char;` was dead: `'\\.[]{}()+^$|'` is the string `\.[]{}()+^$|`, whose first character is a literal backslash, so `.includes('\\')` is `true` and a backslash is always consumed by the escape branch above. `matchesGlob` (line 307-315) also runs `toPosixPath` over the glob before calling this function, so no backslash arrives here in the first place.

The compiled patterns after this change, confirmed against a scratch replica:

```
**/architecture_overview.md  -> ^(?:.*\/)?architecture_overview\.md$
**/*.ts                      -> ^(?:.*\/)?[^/]*\.ts$
src/**/*.ts                  -> ^src\/(?:.*\/)?[^/]*\.ts$
src/**                       -> ^src\/.*$
src/?.ts                     -> ^src\/[^/]\.ts$
**/notes.md                  -> ^(?:.*\/)?notes\.md$
**                           -> ^.*$
```

- [ ] **Step 2: Run the new tests to verify they pass**

Run:

```
npx tsx --test --test-name-pattern "find .*\*\*" .\tests\repo-tools.test.ts
```

Expected: 3 tests run, 3 pass, 0 fail.

- [ ] **Step 3: Run the whole repo-tools suite to verify nothing regressed**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass. Pay particular attention to these pre-existing ones, which pin the surrounding glob semantics:
- `find matches a recursive glob and honours the ignore policy` (line 298) — `**/*.ts` on the untouched fixture still yields exactly `['src/a.ts', 'src/nested/b.ts']`, because `makeRepo()` has no root-level `.ts`.
- `find scopes to a subdirectory and caps at limit` (line 305) — `*.ts` scoped to `src/nested` still yields `b.ts`, and `**/*` with `limit: 1` still truncates.
- `grep glob filters to matching files only` (line 246) — unaffected; `grep` passes its glob to ripgrep, not to `globToRegExp`.

- [ ] **Step 4: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts
git commit -m "fix: make **/ in find globs span zero or more directories"
```

---

### Task 3: Guard tests for the glob constructs left unchanged

**What:** Pin the glob behaviors the Task 2 rewrite must *not* have altered: bare `**`, basename matching for slash-free patterns, `?`, and dot-escaping.

**Why:** A rewrite of a character-by-character compiler can silently change neighbors of the edited branch. These guards make any such drift fail loudly instead of surfacing weeks later as a wrong search result.

| Construct        | Meaning that must survive                          | Example                          |
| ---------------- | -------------------------------------------------- | -------------------------------- |
| bare `**`        | cross-separator wildcard                           | `src/**` → everything under src  |
| slash-free glob  | matches the *basename* at any depth                | `b.ts` → `src/nested/b.ts`       |
| `?`              | exactly one non-separator character                | `src/?.ts` → `src/a.ts` only     |
| literal `.`      | escaped, not "any character"                       | `notes.md` must not match `notesXmd` |

**How:** Regression guards, not TDD drivers — they are expected to pass both before and after Task 2, so there is no "verify it fails" step.

**Files:**
- Modify: `tests/repo-tools.test.ts` (append after the tests added in Task 1)

- [ ] **Step 1: Write the guard tests**

Append to `tests/repo-tools.test.ts`, after the three tests added in Task 1 and still before the `// ls` banner comment:

```ts
test('find treats a trailing ** as a cross-separator wildcard', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: 'src/**' }, makeContext(root));
  assert.ok(result.ok);
  assert.deepEqual(result.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts', 'src/notes.md']);
});

test('find matches a slash-free pattern against the basename at any depth', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: 'b.ts' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'src/nested/b.ts');
});

test('find treats ? as a single non-separator character', async () => {
  const root = makeRepo();
  const single = await executeRepoTool('find', { pattern: 'src/?.ts' }, makeContext(root));
  assert.ok(single.ok);
  assert.equal(single.output, 'src/a.ts');
});

test('find escapes a literal . in a glob instead of compiling it to any-character', async () => {
  const root = makeRepo();
  // A near-miss filename that only an unescaped `.` would match.
  fs.writeFileSync(path.join(root, 'notesXmd'), 'decoy\n', 'utf8');
  const result = await executeRepoTool('find', { pattern: '**/notes.md' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'src/notes.md');
});
```

The last test is the one that actually pins dot-escaping: the decoy file `notesXmd` exists at the search root, and after Task 2 the pattern `**/notes.md` compiles to `^(?:.*\/)?notes\.md$`, which can reach a root-level file. If the `.` were not escaped the decoy would appear in the output. (A test asserting that pattern `**/notesXmd` returns nothing would prove nothing — it contains no `.` at all.)

- [ ] **Step 2: Run the guard tests**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass, including the four new guards.

- [ ] **Step 3: Commit**

```bash
git add tests/repo-tools.test.ts
git commit -m "test: guard find glob semantics left unchanged by the globstar fix"
```

---

### Task 4: Tell the planner what `**/` now means

**What:** State the zero-directory `**/` semantics in the `find` tool description the planner reads.

**Why:** The planner in run `29e8ec87` burned three turns on `**/architecture_overview.md` partly because the tool description gave it no reason to suspect the pattern could not match a root-level file. Tool descriptions are the planner's only documentation — semantics that live only in code are invisible to it.

**How:** One-line description change in the planner protocol.

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:125`

- [ ] **Step 1: Update the `find` tool description**

In `src/repo-search/planner-protocol.ts`, replace line 125:

```ts
      description: 'Find files by glob pattern. Returns matching paths relative to the search directory. Ignored paths are excluded automatically. Output is capped at limit results (default 1000).',
```

with:

```ts
      description: 'Find files by glob pattern. Returns matching paths relative to the search directory. A `**/` segment spans zero or more directories, so `**/name.md` also matches `name.md` sitting directly in the search directory. Ignored paths are excluded automatically. Output is capped at limit results (default 1000).',
```

Leave line 129 (`pattern` property description) as it is — its examples are still accurate.

- [ ] **Step 2: Run typecheck**

Run:

```
npm run typecheck
```

Expected: exits 0. This chain also runs `npm run lint` (eslint) as its last step, so a lint failure surfaces here.

- [ ] **Step 3: Commit**

```bash
git add src/repo-search/planner-protocol.ts
git commit -m "docs: state zero-directory **/ semantics in the find tool description"
```

---

### Task 5: Resolve `find`'s ignore policy against the repository root

**What:** Make `find` test ignore rules against repository-root-relative paths, like every other tool, instead of search-directory-relative paths.

**Why:** `executeFind` seeds the tree walk with an empty relative path (`src/repo-search/engine/repo-tools.ts:545`), so every descendant is tested by `isRepoRelativePathIgnored` against a path relative to the **search directory**, while `ignorePolicy.paths` are **repository-root-relative**. The two frames disagree in both directions:

```
repo root
├── eval/results/leak.ts     ← ignore rule: "eval/results"
└── sub/eval/results/keep.ts ← NOT ignored (rule is root-anchored)

find path=eval  **/*.ts   walk sees "results/leak.ts"      ≠ "eval/results"  → LEAKS ignored file
find path=sub   **/*.ts   walk sees "eval/results/keep.ts" = prefix match    → DROPS good file
```

`find` is the only tool that gets it wrong: `ls` builds `basePath ? \`${basePath}/${entry.name}\` : entry.name` (line 575) and `grep` hands its ignore globs to ripgrep with `cwd` set to the repository root.

**How:** Walk with repository-root-relative paths (the frame the ignore rules are written in), then strip the base prefix before glob-matching and output (the frame the planner asked in).

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:544-546`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts`, after the guard tests added in Task 3 and still before the `// ls` banner comment. `eval/results` is one of the `BASELINE_IGNORED_PATHS` in `src/repo-search/command-safety.ts:31-35`.

```ts
test('find applies the ignore policy relative to the repository root when scoped into a parent of an ignored path', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'eval', 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'eval', 'results', 'leak.ts'), 'leak\n', 'utf8');
  const scoped = await executeRepoTool('find', { pattern: '**/*.ts', path: 'eval' }, makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, '');
});

test('find keeps files whose search-relative path only looks like an ignored path', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'sub', 'eval', 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'eval', 'results', 'keep.ts'), 'keep\n', 'utf8');
  const scoped = await executeRepoTool('find', { pattern: '**/*.ts', path: 'sub' }, makeContext(root));
  assert.ok(scoped.ok);
  assert.equal(scoped.output, 'eval/results/keep.ts');
  const fromRoot = await executeRepoTool('find', { pattern: '**/*.ts' }, makeContext(root));
  assert.ok(fromRoot.ok);
  assert.deepEqual(
    fromRoot.output.split('\n').sort(),
    ['src/a.ts', 'src/nested/b.ts', 'sub/eval/results/keep.ts'],
  );
});
```

(Note: Task 20 later changes the empty-result convention and updates the first test's `assert.equal(scoped.output, '')` expectation to `'No files matched.'`. Write it as shown here for now — the current empty-output behavior is what exists at this point in the plan.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test --test-name-pattern "find (applies|keeps)" .\tests\repo-tools.test.ts
```

Expected: 2 tests run, 2 fail.
- `find applies the ignore policy relative to the repository root...` → `AssertionError: 'results/leak.ts' !== ''`
- `find keeps files whose search-relative path only looks like an ignored path` → `AssertionError: '' !== 'eval/results/keep.ts'`

- [ ] **Step 3: Walk with repository-root-relative paths and strip the prefix for output**

In `src/repo-search/engine/repo-tools.ts`, replace lines 544-546:

```ts
  const matches: string[] = [];
  listFilesRecursive(resolvedPath.absolutePath, '', context.ignorePolicy, matches);
  const filtered = matches.filter((relativePath) => matchesGlob(relativePath, pattern)).sort();
```

with:

```ts
  // The walk must carry repository-root-relative paths, because that is the frame
  // ignorePolicy.paths is written in. The glob and the output are search-directory
  // relative, so the base prefix comes back off before matching.
  const basePath = resolvedPath.relativePath;
  const repoRelativeFiles: string[] = [];
  listFilesRecursive(resolvedPath.absolutePath, basePath, context.ignorePolicy, repoRelativeFiles);
  const basePrefixLength = basePath ? basePath.length + 1 : 0;
  const filtered = repoRelativeFiles
    .map((repoRelativePath) => repoRelativePath.slice(basePrefixLength))
    .filter((searchRelativePath) => matchesGlob(searchRelativePath, pattern))
    .sort();
```

`resolveRepoScopedPath` returns `relativePath: ''` when the search directory is the repository root itself (`relative(root, root)` is `''`), so `basePrefixLength` is `0` for an unscoped `find` and nothing is stripped.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass, including the two new ones and the Task 1/Task 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: resolve find's ignore policy against the repository root, not the search directory"
```

---

### Task 6: Give the duplicate detector a run-wide memory

**What:** Replace the duplicate detector's single-slot memory with run-wide sets of successful keys/fingerprints, cleared only when the tree actually changes.

**Why:** `DuplicateTracker.classify` compares against one slot, `lastSuccessfulNormalizedKey`, which `recordSuccess` overwrites on every accepted call (`src/repo-search/engine/duplicate-tracker.ts:19-20, 31-40, 68-74`). One interleaved tool call clears the record, so an identical zero-result command can be reissued indefinitely. That is exactly what run `29e8ec87` did:

| Turn | Call                                          | One-slot memory holds        | Verdict     |
| ---- | --------------------------------------------- | ---------------------------- | ----------- |
| 2    | `find **/architecture_overview.md`            | (empty)                      | executes    |
| 3    | `find **/architecture_overview.md` (repeat)   | the same find                | **caught**  |
| 4    | `ls path=...`                                 | the find                     | executes → slot now holds `ls` |
| 5    | `find **/architecture_overview.md` (repeat)   | the `ls`                     | **escapes** |

With a run-wide set, turn 5 is caught no matter what ran in between.

**How:** Two `Set`s (exact keys, semantic fingerprints) plus a `forgetSuccesses()` escape hatch invoked when a tree-mutating tool (`run`/`write`/`edit`) completes — after a mutation, an earlier query may legitimately have a new answer. `git` is deliberately **not** a clearing trigger: `evaluateCommandSafety` rejects every mutating git command, so a git call cannot change the tree. That is a different risk posture from `MUTATING_COMMAND_TOOL_NAMES`, which stays as it is because read-window invalidation is conservative by design.

**Files:**
- Modify: `src/repo-search/engine/duplicate-tracker.ts:18-75`
- Modify: `src/repo-search/planner-protocol.ts:270-283`
- Modify: `src/repo-search/engine/tool-action-processor.ts:9-15, 850, 869-886`
- Test: `tests/engine-duplicate-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/engine-duplicate-tracker.test.ts`, rename the first test (line 6) from `classify flags exact duplicates of the last successful normalized key` to `classify flags exact duplicates of an earlier successful normalized key` — its body is unchanged and still passes. Then append these three tests to the end of the file:

```ts
test('classify flags an exact duplicate even after other tools succeeded in between', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('find pattern="**/architecture_overview.md"', 'fp-find');
  tracker.recordSuccess('ls path="src"', 'fp-ls');
  const repeat = tracker.classify({
    toolName: 'find',
    normalizedKey: 'find pattern="**/architecture_overview.md"',
    fingerprint: 'fp-find',
    rejected: false,
  });
  assert.equal(repeat.isExactDuplicate, true);
});

test('classify flags a semantic duplicate of any earlier success, not only the last', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('grep pattern="alpha"', 'fp-grep');
  tracker.recordSuccess('ls path="src"', 'fp-ls');
  const repeat = tracker.classify({
    toolName: 'grep',
    normalizedKey: 'grep pattern="alpha" limit=50',
    fingerprint: 'fp-grep',
    rejected: false,
  });
  assert.equal(repeat.isExactDuplicate, false);
  assert.equal(repeat.isSemanticDuplicate, true);
});

test('forgetSuccesses clears the run-wide memory so a post-mutation repeat is allowed', () => {
  const tracker = new DuplicateTracker();
  tracker.recordSuccess('grep pattern="alpha"', 'fp-grep');
  tracker.forgetSuccesses();
  const after = tracker.classify({
    toolName: 'grep',
    normalizedKey: 'grep pattern="alpha"',
    fingerprint: 'fp-grep',
    rejected: false,
  });
  assert.equal(after.isExactDuplicate, false);
  assert.equal(after.isSemanticDuplicate, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test .\tests\engine-duplicate-tracker.test.ts
```

Expected: the two `classify flags ...` additions fail (`true !== false` / `false !== true`, because the interleaved `ls` success displaced the earlier record), and `forgetSuccesses clears the run-wide memory` fails to compile/run with `tracker.forgetSuccesses is not a function`.

- [ ] **Step 3: Replace the one-slot memory with run-wide sets**

In `src/repo-search/engine/duplicate-tracker.ts`, replace the class body at lines 18-75 with:

```ts
export class DuplicateTracker {
  private readonly successfulNormalizedKeys = new Set<string>();
  private readonly successfulFingerprints = new Set<string>();
  private replayFingerprint: string | null = null;
  private replayCount = 0;
  private replayToolMessageIndex = -1;

  classify(options: {
    toolName: string;
    normalizedKey: string;
    fingerprint: string;
    rejected: boolean;
  }): DuplicateClassification {
    const isExactDuplicate = this.successfulNormalizedKeys.has(options.normalizedKey);
    const isSemanticDuplicate = Boolean(
      !isExactDuplicate
      && !options.rejected
      && options.fingerprint
      && this.successfulFingerprints.has(options.fingerprint),
    );
    return {
      isExactDuplicate,
      isSemanticDuplicate,
      duplicateFingerprint: buildDuplicateFingerprint(options.toolName, options.normalizedKey, options.fingerprint),
    };
  }

  registerDuplicate(duplicateFingerprint: string, messageCount: number): DuplicateRegistration {
    const isActiveReplay = this.replayFingerprint === duplicateFingerprint
      && this.replayToolMessageIndex >= 0
      && this.replayToolMessageIndex < messageCount;
    this.replayFingerprint = duplicateFingerprint;
    this.replayCount = isActiveReplay ? this.replayCount + 1 : 2;
    return {
      count: this.replayCount,
      activeReplayMessageIndex: isActiveReplay ? this.replayToolMessageIndex : null,
    };
  }

  setReplayToolMessageIndex(index: number): void {
    this.replayToolMessageIndex = index;
  }

  shouldForceFinish(): boolean {
    return this.replayCount >= DUPLICATE_FORCE_THRESHOLD;
  }

  recordSuccess(normalizedKey: string, fingerprint: string | null): void {
    this.replayFingerprint = null;
    this.replayCount = 0;
    this.replayToolMessageIndex = -1;
    this.successfulNormalizedKeys.add(normalizedKey);
    if (fingerprint) {
      this.successfulFingerprints.add(fingerprint);
    }
  }

  /**
   * A tool that changed the working tree makes every earlier query answerable differently, so the
   * accumulated successes stop being evidence that a repeat is pointless.
   */
  forgetSuccesses(): void {
    this.successfulNormalizedKeys.clear();
    this.successfulFingerprints.clear();
  }
}
```

(Note: Task 19 later adds a `transcriptGeneration` parameter to `registerDuplicate` and `setReplayToolMessageIndex`. Implement them as shown here for now.)

- [ ] **Step 4: Add the tree-mutating tool predicate**

In `src/repo-search/planner-protocol.ts`, immediately after the `MUTATING_COMMAND_TOOL_NAMES` declaration (line 275), add:

```ts
/**
 * Tools that can change the working tree, so an identical earlier query may now have a different
 * answer and must not be rejected as a repeat. `git` is deliberately absent: evaluateCommandSafety
 * rejects every mutating git command, so a git call cannot change the tree. That is narrower than
 * MUTATING_COMMAND_TOOL_NAMES above, which stays conservative because a stale read window is worse
 * than a redundant one.
 */
const TREE_MUTATING_TOOL_NAMES = new Set<string>(['run', 'write', 'edit']);
```

and immediately after `isMutatingCommandToolName` (lines 281-283), add:

```ts
export function isTreeMutatingToolName(toolName: string): boolean {
  return TREE_MUTATING_TOOL_NAMES.has(normalizeToolName(toolName));
}
```

- [ ] **Step 5: Clear the memory on mutation**

In `src/repo-search/engine/tool-action-processor.ts`, add `isTreeMutatingToolName` to the existing `planner-protocol.js` import block (lines 9-15), so it reads:

```ts
import {
  getRepoSearchCommandTokenForToolName,
  isMutatingCommandToolName,
  isRepoSearchCommandToolName,
  isRepoSearchNativeToolName,
  isTreeMutatingToolName,
  type ToolAction,
} from '../planner-protocol.js';
```

Replace the call site at line 850:

```ts
    this.invalidateReadWindows(context, commandSucceeded);
```

with:

```ts
    this.invalidateAfterMutation(context, commandSucceeded);
```

Then replace the method and its doc comment at lines 869-886 with:

```ts
  /**
   * A mutation makes prior read windows stale — the same line numbers now hold different content.
   * Clearing them restores the model's ability to re-read what changed. This touches bookkeeping
   * only; the transcript keeps every earlier read result.
   *
   * Command-shaped tools do not report which paths they touched and can rewrite the tree, so any
   * completion clears everything — a non-zero exit can still have mutated.
   *
   * A tool that can actually change the tree also clears the duplicate memory, so a re-query after
   * a write is not rejected as a repeat of the pre-write answer.
   */
  private invalidateAfterMutation(context: ExecutedToolContext, commandSucceeded: boolean): void {
    const { normalizedToolName, nativeExecution } = context;
    if (isTreeMutatingToolName(normalizedToolName)) {
      this.deps.duplicates.forgetSuccesses();
    }
    if (isMutatingCommandToolName(normalizedToolName)) {
      this.deps.readWindows.invalidateAll();
      return;
    }
    if (commandSucceeded && nativeExecution && nativeExecution.ok && nativeExecution.mutatedPathKey) {
      this.deps.readWindows.invalidatePath(nativeExecution.mutatedPathKey);
    }
  }
```

The call order at lines 850-853 is unchanged and load-bearing: `invalidateAfterMutation` runs first, then `duplicates.recordSuccess(...)` re-adds the call that just executed. Clearing after recording would erase it.

- [ ] **Step 6: Run the tracker tests to verify they pass**

Run:

```
npx tsx --test .\tests\engine-duplicate-tracker.test.ts
```

Expected: all tests pass, including the pre-existing `classify returns no duplicate before a success and when the prior success has no fingerprint` (line 29) — `recordSuccess('rg -n foo', null)` adds the key but no fingerprint, so a later different key with fingerprint `fp-1` is still neither kind of duplicate — and `shouldForceFinish fires at DUPLICATE_FORCE_THRESHOLD and recordSuccess resets everything` (line 61), whose replay state handling is untouched.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/duplicate-tracker.ts src/repo-search/planner-protocol.ts src/repo-search/engine/tool-action-processor.ts tests/engine-duplicate-tracker.test.ts
git commit -m "fix: give repo-search duplicate detection a run-wide memory cleared only on mutation"
```

---

### Task 7: Stop counting an empty tool result as new evidence

**What:** Classify a zero-length tool output as *no new evidence* instead of unconditionally-new.

**Why:** `src/repo-search/engine/tool-action-processor.ts:798-800` short-circuits a zero-length output to `{ evidenceKeys: [], hasNewEvidence: true }`. An empty result is the least novel outcome possible, and feeding `true` into `toolStats.recordNovelty` inflates `newEvidenceCalls` exactly when the planner is stalling:

| Tool result           | Old `hasNewEvidence` | Correct | Effect of the old value                        |
| --------------------- | -------------------- | ------- | ---------------------------------------------- |
| output with new lines | `true`               | `true`  | —                                              |
| repeated output       | `false`              | `false` | —                                              |
| **empty output**      | **`true`**           | `false` | stalling planner looks productive in the stats |

**How:** The branch is an inline ternary inside a 90-line method, which is why it is untestable and why the inversion survived. Move the whole decision — including the empty case — into one exported function next to `classifyToolResultNovelty`, and call that.

**Files:**
- Modify: `src/tool-loop-governor.ts:142-148`
- Modify: `src/repo-search/engine/tool-action-processor.ts:19-24, 798-803`
- Test: `tests/tool-loop-governor.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/tool-loop-governor.test.ts`:

```ts
test('classifyToolOutputNovelty treats an empty tool output as no new evidence', () => {
  const novelty = classifyToolOutputNovelty({
    baseOutput: '',
    promptResultText: 'exit_code=0',
    recentEvidenceKeys: new Set<string>(),
  });
  assert.deepEqual(novelty.evidenceKeys, []);
  assert.equal(novelty.hasNewEvidence, false);
});

test('classifyToolOutputNovelty defers to the evidence keys when output is present', () => {
  const recentEvidenceKeys = new Set<string>();
  const first = classifyToolOutputNovelty({
    baseOutput: 'src/a.ts:2:alpha',
    promptResultText: 'exit_code=0\nsrc/a.ts:2:alpha',
    recentEvidenceKeys,
  });
  assert.equal(first.hasNewEvidence, true);
  for (const key of first.evidenceKeys) {
    recentEvidenceKeys.add(key);
  }
  const repeat = classifyToolOutputNovelty({
    baseOutput: 'src/a.ts:2:alpha',
    promptResultText: 'exit_code=0\nsrc/a.ts:2:alpha',
    recentEvidenceKeys,
  });
  assert.equal(repeat.hasNewEvidence, false);
});
```

Add `classifyToolOutputNovelty` to the existing import from `../src/tool-loop-governor.js` at the top of that file (line 8 already imports `classifyToolResultNovelty` from it).

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test --test-name-pattern "classifyToolOutputNovelty" .\tests\tool-loop-governor.test.ts
```

Expected: both fail — `classifyToolOutputNovelty is not a function` (and a typecheck error on the import, since the symbol does not exist yet).

- [ ] **Step 3: Add the function**

In `src/tool-loop-governor.ts`, insert immediately after `classifyToolResultNovelty` (which ends at line 148):

```ts
/**
 * The novelty of one executed tool call. An empty output carries no anchors and so cannot be
 * novel — reporting it as new evidence hides a stalling planner from the no-new-evidence counter.
 */
export function classifyToolOutputNovelty(options: {
  baseOutput: string;
  promptResultText: string;
  recentEvidenceKeys: Set<string>;
}): ToolResultNovelty {
  if (options.baseOutput.length === 0) {
    return { evidenceKeys: [], hasNewEvidence: false };
  }
  return classifyToolResultNovelty({
    promptResultText: options.promptResultText,
    recentEvidenceKeys: options.recentEvidenceKeys,
  });
}
```

- [ ] **Step 4: Call it from the processor**

In `src/repo-search/engine/tool-action-processor.ts`, change the `../../tool-loop-governor.js` import block (lines 19-24) from `classifyToolResultNovelty` to `classifyToolOutputNovelty`, so it reads:

```ts
import {
  buildRepeatedToolCallSummary,
  buildPromptToolResult,
  classifyToolOutputNovelty,
  fingerprintToolCall,
} from '../../tool-loop-governor.js';
```

Then replace lines 798-803:

```ts
    const novelty = baseOutput.length === 0
      ? { evidenceKeys: [], hasNewEvidence: true }
      : classifyToolResultNovelty({
        promptResultText: resultText,
        recentEvidenceKeys,
      });
```

with:

```ts
    const novelty = classifyToolOutputNovelty({
      baseOutput,
      promptResultText: resultText,
      recentEvidenceKeys,
    });
```

- [ ] **Step 5: Run the affected suites**

Run:

```
npx tsx --test .\tests\tool-loop-governor.test.ts .\tests\engine-tool-stats.test.ts
```

Expected: all tests pass, including the pre-existing `classifyToolResultNovelty detects repeated evidence with no new anchors` (line 138) and `recordNovelty splits new vs no-new evidence calls` (`tests/engine-tool-stats.test.ts:62`). If a repo-search task-loop test asserts a `newEvidenceCalls` figure that counted an empty result, update that expectation — the new number is the correct one.

- [ ] **Step 6: Commit**

```bash
git add src/tool-loop-governor.ts src/repo-search/engine/tool-action-processor.ts tests/tool-loop-governor.test.ts
git commit -m "fix: count an empty repo-tool result as no-new-evidence"
```

---

### Task 8: Scope the command-safety gate to command positions and unquoted syntax

**What:** Make the `git` command gate scan only the shell syntax that can actually execute — not quoted strings and path operands — and close the `$(...)` hole it currently leaves open.

**Why:** `evaluateCommandSafety` runs `WRITE_OR_NETWORK_COMMAND_PATTERN` and the redirection check over the raw command string, including quoted spans and path operands. Confirmed outcomes on the current gate:

| Command                                  | Current verdict | Correct verdict | Why the gate is wrong                        |
| ---------------------------------------- | --------------- | --------------- | -------------------------------------------- |
| `git log --oneline -- docs/rm.md`        | ❌ BLOCK        | ✅ allow        | `\brm\b` matched inside a *path operand*     |
| `git log --oneline -- src/cp/index.ts`   | ❌ BLOCK        | ✅ allow        | `\bcp\b` inside a path operand               |
| `git grep -n "export-default"`           | ❌ BLOCK        | ✅ allow        | `export-*` inside a *quoted pattern*         |
| `git log --grep="remove-item"`           | ❌ BLOCK        | ✅ allow        | cmdlet name inside a quoted pattern          |
| `git log --format="%h <%an>"`            | ❌ BLOCK        | ✅ allow        | `<` `>` are inert inside double quotes       |
| ``git log --grep='back`tick'``           | ❌ BLOCK        | ✅ allow        | backtick checked before quote state          |
| `git log --grep=$(whoami)`               | ✅ **allow**    | ❌ BLOCK        | nothing checks `$(` at all — a real hole     |

The whole-command scan is also redundant at command positions: segment 0 must already be `git` and every later pipeline segment must already be in `READ_ONLY_PIPE_COMMANDS`. The only place a write command can actually hide is inside a `{ ... }` script block passed to a filter cmdlet, plus a `$(...)` subexpression — and `$(...)` is **not** currently blocked at all, so removing the blanket scan without adding it would open a real hole.

**How:** PowerShell quoting decides which checks apply where:
- **single quotes** are fully literal — nothing inside can execute, so blank them for every scan;
- **double quotes** still expand `$(...)` and honour the backtick escape, but redirection operators inside them are inert text.

Blank quoted spans before each scan (with the right blanking per scan), scan `{ ... }` script-block bodies for write commands, block `$(` and `` ` `` outside single quotes, and keep the producer/pipe allow-lists as the command-position gate.

**Files:**
- Modify: `src/repo-search/command-safety.ts:83-152, 212-251`
- Test: `tests/command-safety.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/command-safety.test.ts`, replace the test at lines 49-53:

```ts
test('evaluateCommandSafety rejects a ForEach-Object stage that writes', () => {
  const result = evaluateCommandSafety('git log --oneline | ForEach-Object { Rename-Item $_ }');
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'ForEach-Object must be read-only');
});
```

with:

```ts
test('evaluateCommandSafety rejects a script block that writes, whichever cmdlet takes it', () => {
  for (const command of [
    'git log --oneline | ForEach-Object { Rename-Item $_ }',
    'git ls-files | Where-Object { Remove-Item $_ }',
    'git ls-files | Select-Object -Property @{ n = "x"; e = { Out-File $_ } }',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.equal(result.reason, 'destructive, file-writing, or network command is not allowed');
  }
});
```

Then append:

```ts
test('evaluateCommandSafety allows write-command substrings in path operands and quoted arguments', () => {
  for (const command of [
    'git log --oneline -- docs/rm.md',
    'git log --oneline -- src/cp/index.ts',
    'git grep -n "export-default"',
    'git log --grep="remove-item"',
    'git log --format="%h <%an>"',
    "git log --grep='back`tick'",
    'git show HEAD:package.json | Measure-Object -Character',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, true, `expected ${command} to be allowed, got ${result.reason}`);
  }
});

test('evaluateCommandSafety rejects command substitution and escapes outside single quotes', () => {
  for (const command of [
    'git log --grep="$(Remove-Item x)"',
    'git log --grep=$(whoami)',
    'git log --grep="a`nb"',
  ]) {
    const result = evaluateCommandSafety(command);
    assert.equal(result.safe, false, `expected ${command} to be rejected`);
    assert.equal(result.reason, 'command substitution and escape characters are not allowed');
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test .\tests\command-safety.test.ts
```

Expected: 3 failures.
- `rejects a script block that writes...` → the `Where-Object` and `Select-Object` cases currently fail with reason `destructive, file-writing, or network command is not allowed` only by accident of the whole-command scan, and the `ForEach-Object` case returns `ForEach-Object must be read-only`.
- `allows write-command substrings...` → first failing entry is `git log --oneline -- docs/rm.md`.
- `rejects command substitution...` → `git log --grep=$(whoami)` is currently **allowed** (nothing checks for `$(`).

- [ ] **Step 3: Replace the scanning helpers**

In `src/repo-search/command-safety.ts`, replace lines 83-152 — that is `WRITE_OR_NETWORK_COMMAND_PATTERN`, `FOREACH_WRITE_COMMAND_PATTERN`, `hasBlockedOperator`, `hasFileRedirection`, and `splitTopLevelPipes` — with:

```ts
// The one list of commands that write, delete, rename, or reach the network. It is applied to
// script-block bodies only; command positions are already governed by the allow-lists below.
const WRITE_OR_NETWORK_COMMAND_PATTERN = /\b(rm|del|mv|cp|move-item|copy-item|remove-item|rename-item|set-content|add-content|out-file|export-[a-z0-9_-]+|tee-object|curl|wget|invoke-webrequest|invoke-restmethod|start-process)\b/iu;

type QuoteBlanking = { single: boolean; double: boolean };

/**
 * Replaces the interior of selected quoted spans with spaces, preserving length and quote
 * characters, so a scan sees only the shell syntax that can actually execute. Single-quoted spans
 * are literal in PowerShell; double-quoted spans still expand `$(...)` and honour the backtick
 * escape, but redirection and chaining operators inside them are inert text.
 */
function blankQuotedSpans(command: string, blanking: QuoteBlanking): string {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      result += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      result += char;
      continue;
    }
    const shouldBlank = (inSingle && blanking.single) || (inDouble && blanking.double);
    result += shouldBlank ? ' ' : char;
  }
  return result;
}

function hasBlockedOperator(operatorScan: string): boolean {
  for (let index = 0; index < operatorScan.length; index += 1) {
    const char = operatorScan[index];
    if (char === ';') {
      return true;
    }
    if (char === '&' && operatorScan[index + 1] === '&') {
      return true;
    }
    if (char === '|' && operatorScan[index + 1] === '|') {
      return true;
    }
  }
  return false;
}

function hasFileRedirection(operatorScan: string): boolean {
  // Strip safe stderr-to-stdout merges (2>&1) before checking for real file redirects
  return /[<>]/u.test(operatorScan.replace(/\s*2>&1\s*/gu, ' '));
}

function hasShellExpansion(expansionScan: string): boolean {
  return expansionScan.includes('`') || expansionScan.includes('$(');
}

/** Bodies of `{ ... }` blocks — the one place a cmdlet invocation can hide behind an allow-listed stage. */
function extractScriptBlockBodies(expansionScan: string): string[] {
  const bodies: string[] = [];
  const openIndexes: number[] = [];
  for (let index = 0; index < expansionScan.length; index += 1) {
    if (expansionScan[index] === '{') {
      openIndexes.push(index);
      continue;
    }
    if (expansionScan[index] === '}') {
      const start = openIndexes.pop();
      if (start !== undefined) {
        bodies.push(expansionScan.slice(start + 1, index));
      }
    }
  }
  return bodies;
}

function splitTopLevelPipes(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === '|' && !inSingle && !inDouble) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}
```

`splitTopLevelPipes` is reproduced verbatim — it is inside the replaced line range and must survive unchanged.

- [ ] **Step 4: Rewrite `evaluateCommandSafety`**

Replace lines 212-251 (the whole `evaluateCommandSafety` function) with:

```ts
export function evaluateCommandSafety(command: string, repoRoot = ''): SafetyResult {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return { safe: false, reason: 'empty command' };
  }

  if (referencesPathOutsideRepo(trimmed, repoRoot)) {
    return { safe: false, reason: 'command must stay within the caller repository scope' };
  }

  // Chaining and redirection are inert inside quotes of either kind.
  const operatorScan = blankQuotedSpans(trimmed, { single: true, double: true });
  if (hasBlockedOperator(operatorScan)) {
    return { safe: false, reason: 'shell chaining/redirection is not allowed' };
  }
  if (hasFileRedirection(operatorScan)) {
    return { safe: false, reason: 'file redirection is not allowed' };
  }

  // Subexpressions and escapes still fire inside double quotes; only single quotes neutralize them.
  const expansionScan = blankQuotedSpans(trimmed, { single: true, double: false });
  if (hasShellExpansion(expansionScan)) {
    return { safe: false, reason: 'command substitution and escape characters are not allowed' };
  }

  for (const scriptBlockBody of extractScriptBlockBodies(expansionScan)) {
    if (WRITE_OR_NETWORK_COMMAND_PATTERN.test(scriptBlockBody)) {
      return { safe: false, reason: 'destructive, file-writing, or network command is not allowed' };
    }
  }

  const segments = splitTopLevelPipes(trimmed);
  const producerToken = getFirstCommandToken(segments[0] || '');
  if (producerToken !== PRODUCER_COMMAND) {
    return { safe: false, reason: `command '${producerToken || '<empty>'}' is not in the allow-list` };
  }

  for (const segment of segments.slice(1)) {
    const pipeToken = getFirstCommandToken(segment);
    if (!READ_ONLY_PIPE_COMMANDS.has(pipeToken)) {
      return { safe: false, reason: `command '${pipeToken || '<empty>'}' is not in the allow-list` };
    }
  }

  return { safe: true, reason: null };
}
```

The `ForEach-Object`-specific branch is gone: script-block scanning covers every cmdlet that takes a block, so the narrower rule and its separate `FOREACH_WRITE_COMMAND_PATTERN` list are redundant. `rm -rf .` and `curl http://...` are still rejected — their first token is not `git`, so the allow-list catches them with reason `command 'rm' is not in the allow-list`.

- [ ] **Step 5: Run the safety tests**

Run:

```
npx tsx --test .\tests\command-safety.test.ts
```

Expected: all tests pass, including the pre-existing ones at lines 55-69, which only assert `safe === false` (the reasons for `rm -rf .`, `curl ...` and ``git log `whoami` `` change, the verdicts do not) and lines 16-19, whose `git status --short | Where-Object { $_ -match "src" }` script block contains no write command.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/command-safety.ts tests/command-safety.test.ts
git commit -m "fix: scope the git safety gate to command positions and unquoted syntax"
```

---

### Task 9: Give `find` and `ls` one ordering

**What:** Use one shared comparator for `find` and `ls` output.

**Why:** `executeFind` sorts with the default `.sort()` (UTF-16 code unit order) while `executeLs` sorts with `localeCompare` (`src/repo-search/engine/repo-tools.ts:546, 581`). The same directory comes back in two different orders depending on which tool asked:

| Files on disk                             | `find` order (code units)                | `ls` order (locale)                      |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `Alpha.ts` `Beta.ts` `alpha.ts` `beta.ts` | `Alpha.ts, Beta.ts, alpha.ts, beta.ts`   | `alpha.ts, Alpha.ts, beta.ts, Beta.ts`   |

A planner comparing the two outputs sees phantom differences.

**How:** One `compareDisplayNames` function; both call sites use it.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:276-278, 546, 581`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-tools.test.ts`, after the tests added in Task 5:

```ts
test('find and ls order the same names the same way', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'order'), { recursive: true });
  for (const name of ['Beta.ts', 'alpha.ts', 'Alpha.ts', 'beta.ts']) {
    fs.writeFileSync(path.join(root, 'order', name), 'x\n', 'utf8');
  }
  const found = await executeRepoTool('find', { pattern: '*.ts', path: 'order' }, makeContext(root));
  const listed = await executeRepoTool('ls', { path: 'order' }, makeContext(root));
  assert.ok(found.ok);
  assert.ok(listed.ok);
  assert.deepEqual(found.output.split('\n'), listed.output.split('\n'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "order the same names" .\tests\repo-tools.test.ts
```

Expected: FAIL. `find` returns `['Alpha.ts', 'Beta.ts', 'alpha.ts', 'beta.ts']` (uppercase first, code-unit order); `ls` returns `['alpha.ts', 'Alpha.ts', 'beta.ts', 'Beta.ts']` (locale order).

- [ ] **Step 3: Share one comparator**

In `src/repo-search/engine/repo-tools.ts`, insert this above the `// Glob matching` banner comment at line 276:

```ts
// ---------------------------------------------------------------------------
// Output ordering — find and ls must agree on it
// ---------------------------------------------------------------------------

function compareDisplayNames(left: string, right: string): number {
  return left.localeCompare(right);
}

```

Change the `find` sort (line 546, or its Task 5 successor `.sort();`) to:

```ts
    .sort(compareDisplayNames);
```

Change the `ls` sort at line 581 from:

```ts
  entries.sort((left, right) => left.localeCompare(right));
```

to:

```ts
  entries.sort(compareDisplayNames);
```

- [ ] **Step 4: Run the repo-tools suite**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass. The Task 1/3/5 assertions either sort in the test or assert a single path, so none of them is order-sensitive.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: order find and ls output with one shared comparator"
```

---

### Task 10: Reject a non-positive `limit` instead of silently defaulting

**What:** Make `grep`, `find`, and `ls` reject a present-but-invalid `limit` instead of substituting the tool's default.

**Why:** `readPositiveInteger(args.limit, DEFAULT)` (`src/repo-search/engine/repo-tools.ts:101-104`) maps `limit: 0` and `limit: -5` to the tool's default. A caller that asked for *none* gets the *maximum*, and it fails silently:

| Caller sends | Old behavior            | New behavior                        |
| ------------ | ----------------------- | ----------------------------------- |
| (omitted)    | tool default (100/500/1000) | tool default — unchanged        |
| `limit: 25`  | 25                      | 25 — unchanged                      |
| `limit: 0`   | **tool default**        | rejected: `limit must be a positive integer` |
| `limit: -5`  | **tool default**        | rejected: `limit must be a positive integer` |
| `limit: "x"` | **tool default**        | rejected: `limit must be a positive integer` |

**How:** A `resolveLimit` helper that distinguishes *absent* (use fallback) from *present and invalid* (fail loudly). `readPositiveInteger` stays as it is for `offset`, where clamping to 1 is the correct reading of "line 0".

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:101-134, 483-521, 527-553, 559-588`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts`, after the test added in Task 9:

```ts
test('grep, find and ls reject a non-positive limit instead of defaulting to the maximum', async () => {
  const root = makeRepo();
  for (const [toolName, args] of [
    ['grep', { pattern: 'alpha', limit: 0 }],
    ['find', { pattern: '**/*.ts', limit: 0 }],
    ['ls', { limit: -1 }],
  ] as const) {
    const result = await executeRepoTool(toolName, args, makeContext(root));
    assert.equal(result.ok, false, `expected ${toolName} to reject limit`);
    assert.equal(result.ok === false ? result.reason : '', 'limit must be a positive integer');
  }
});

test('an omitted limit still falls back to the tool default', async () => {
  const root = makeRepo();
  const found = await executeRepoTool('find', { pattern: '**/*.ts' }, makeContext(root));
  assert.ok(found.ok);
  assert.deepEqual(found.output.split('\n').sort(), ['src/a.ts', 'src/nested/b.ts']);
  const listed = await executeRepoTool('ls', {}, makeContext(root));
  assert.ok(listed.ok);
  assert.deepEqual(listed.output.split('\n'), ['.dotfile', 'src/']);
});
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run:

```
npx tsx --test --test-name-pattern "limit" .\tests\repo-tools.test.ts
```

Expected: `grep, find and ls reject a non-positive limit...` fails on the first entry (`grep` returns `ok: true` with a full result set). `an omitted limit still falls back to the tool default` passes — it pins behaviour that must not change.

- [ ] **Step 3: Add an explicit limit resolver**

In `src/repo-search/engine/repo-tools.ts`, add after `optionalString` (line 143):

```ts
/**
 * `limit` is optional, but a present non-positive or non-numeric value is a caller error, not a
 * request for the default — silently returning the maximum is the opposite of what was asked.
 * Returns the resolved limit, or the failure reason as a string (same shape as `resolveEdits`).
 */
function resolveLimit(value: OptionalJsonValue, fallback: number): number | string {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 'limit must be a positive integer';
}
```

- [ ] **Step 4: Use it in all three tools**

In `executeGrep`, add the check immediately after the `existsSync` guard (currently lines 495-497) and before the `rg` spawn, then use the resolved value at line 515. Replace:

```ts
  const searchPath = resolvedPath.relativePath === '' ? '.' : resolvedPath.relativePath;
```

with:

```ts
  const limit = resolveLimit(args.limit, GREP_DEFAULT_LIMIT);
  if (typeof limit === 'string') {
    return failure('grep', command, limit);
  }
  const searchPath = resolvedPath.relativePath === '' ? '.' : resolvedPath.relativePath;
```

and delete the now-duplicate declaration at line 515:

```ts
  const limit = readPositiveInteger(args.limit, GREP_DEFAULT_LIMIT);
```

In `executeFind`, replace line 547:

```ts
  const limit = readPositiveInteger(args.limit, FIND_DEFAULT_LIMIT);
```

with:

```ts
  const limit = resolveLimit(args.limit, FIND_DEFAULT_LIMIT);
  if (typeof limit === 'string') {
    return failure('find', command, limit);
  }
```

In `executeLs`, replace line 582:

```ts
  const limit = readPositiveInteger(args.limit, LS_DEFAULT_LIMIT);
```

with:

```ts
  const limit = resolveLimit(args.limit, LS_DEFAULT_LIMIT);
  if (typeof limit === 'string') {
    return failure('ls', command, limit);
  }
```

- [ ] **Step 5: Run the repo-tools suite**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass. `readPositiveInteger` is still used by `planRead` and `buildRepoToolRequestedCommand` for `offset`, so it must not be deleted; `npm run typecheck` in Task 23 will catch it if it became unused.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: reject a non-positive limit in grep, find and ls"
```

---

### Task 11: Stop `read` reporting a phantom trailing line

**What:** Split file content so a trailing newline terminates the last line instead of creating an empty extra one.

**Why:** `planRead` splits the file on `\n` (`src/repo-search/engine/repo-tools.ts:369`), so a 5-line file ending in a newline yields 6 entries — the last one empty — and `totalEndLineExclusive` becomes 7:

```
file bytes:  "line1\nline2\nline3\nline4\nline5\n"
                                              └─ terminator of line 5, not a 6th line

split('\n'): ["line1","line2","line3","line4","line5",""]   ← 6 entries, last is phantom
correct:     ["line1","line2","line3","line4","line5"]      ← 5 lines
```

The read output is trimmed so the phantom line is invisible to the model, but the read-window bookkeeping counts a line that does not exist and `read` can be asked to return it.

**How:** A `splitSourceLines` helper that removes exactly one terminator-created trailing empty entry.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:339-345, 369`
- Test: `tests/repo-tools.test.ts:169-201`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-tools.test.ts`, after the tests added in Task 10:

```ts
test('planRead does not count a trailing newline as an extra line', () => {
  const root = makeRepo();
  // src/a.ts is 'line1\nalpha\nline3\nalpha\nline5\n' — five lines, one trailing newline.
  const plan = planRead({ path: 'src/a.ts', offset: 1 }, root, buildIgnorePolicy(root));
  assert.ok(!isFailedReadPlan(plan));
  assert.equal(plan.lines.length, 5);
  assert.equal(plan.totalEndLineExclusive, 6);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "trailing newline as an extra line" .\tests\repo-tools.test.ts
```

Expected: FAIL with `AssertionError: 6 !== 5` on `plan.lines.length`.

- [ ] **Step 3: Drop the trailing empty entry**

In `src/repo-search/engine/repo-tools.ts`, add above `formatNumberedTextBlock` (line 343):

```ts
/** A trailing newline terminates the last line; it does not start an empty one after it. */
function splitSourceLines(text: string): string[] {
  const lines = text.split('\n');
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

```

Replace line 369:

```ts
  const lines = readSourceText(resolvedPath.absolutePath).split('\n');
```

with:

```ts
  const lines = splitSourceLines(readSourceText(resolvedPath.absolutePath));
```

- [ ] **Step 4: Update the two expectations that encoded the phantom line**

In `tests/repo-tools.test.ts`, in `planRead with expandReads=true skips returned lines and runs to end of file` (line 169), change line 176 from:

```ts
  assert.equal(plan.effectiveEndLineExclusive, 7);
```

to:

```ts
  assert.equal(plan.effectiveEndLineExclusive, 6);
```

In `planRead reports a fully covered window as exhausted in both modes` (line 190), change the expanded-mode range at line 197 from `stateWithReturnedRange('src/a.ts', 1, 7)` to `stateWithReturnedRange('src/a.ts', 1, 6)`. Both files now describe a 5-line file honestly; the `hasUnread === false` assertions are unchanged.

- [ ] **Step 5: Run the repo-tools suite**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass, including `planRead returns a numbered window and honours limit as a line count` (line 127) and `planRead decodes a UTF-16LE (BOM) file` (line 219), neither of which reads past the real last line.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: stop planRead counting a trailing newline as an extra line"
```

---

### Task 12: Convert thrown native-tool errors into failed tool results

**What:** Wrap the native tool dispatch in one guard that converts any thrown error into an `ok: false` result.

**Why:** Nothing between `executeRepoTool` and the agent loop catches. `executeFind`/`executeLs` call `readdirSync`, `planRead`/`executeEdit` call `statSync` + file reads, `executeWrite` calls `mkdirSync`/`writeFileSync` — all synchronous, all throwing on EPERM, EISDIR, ENOTDIR, or a delete-between-check-and-use race. `runNativeExecution` (`tool-action-processor.ts:515-540`) awaits the promise without try/catch, `processToolAction` doesn't either, and `executeTools` in `task-loop.ts:438` doesn't either:

```
executeRepoTool ──throw──> runNativeExecution ──> processToolAction ──> executeBatch
      │                        (no catch)             (no catch)          (no catch)
      └─ readdirSync EPERM                                                   │
                                                                             ▼
                                                              whole task run dies
```

One unreadable directory should cost one failed tool result — the same price as any other tool failure — not the entire run.

**How:** Keep the existing dispatch as a private function; export a guarded wrapper. One choke point, every tool covered, no per-tool try/catch duplication.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:746-800`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-tools.test.ts`:

```ts
test('a native tool that throws returns a failed result instead of crashing the run', async () => {
  const root = makeRepo();
  // src/a.ts is a file; using it as a directory segment makes mkdirSync/writeFileSync throw.
  const result = await executeRepoTool('write', { path: 'src/a.ts/nested/file.txt', content: 'x' }, makeContext(root));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.startsWith('tool error:'), `unexpected result: ${JSON.stringify(result)}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "native tool that throws" .\tests\repo-tools.test.ts
```

Expected: FAIL — the test itself rejects with an fs error (`ENOTDIR`/`EEXIST`/`ENOENT` depending on platform) instead of resolving to a result, which is exactly the defect.

- [ ] **Step 3: Add the guard**

In `src/repo-search/engine/repo-tools.ts`, rename the current exported `executeRepoTool` (line 746) to a private `executeRepoToolUnguarded` (remove the `export` keyword), leaving its body unchanged. Then add below it:

```ts
/**
 * Native tools run synchronous fs calls that can throw (EPERM, ENOTDIR, delete races). A throw
 * must cost one failed tool result — the same price as any other failure — not the whole run:
 * nothing above this function catches.
 */
export async function executeRepoTool(
  toolName: string,
  args: JsonObject,
  context: RepoToolContext,
): Promise<RepoToolExecution> {
  try {
    return await executeRepoToolUnguarded(toolName, args, context);
  } catch (error) {
    return failure(
      toolName,
      buildRepoToolRequestedCommand(toolName, args),
      `tool error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: convert thrown native repo-tool errors into failed tool results"
```

---

### Task 13: Record one command entry per tool action so results stay aligned

**What:** Make every processed tool action — including invalid ones — append exactly one entry to the `commands` array.

**Why:** `executeTools` in `task-loop.ts:453-472` pairs command results back to tool actions **by array index**. But the four invalid-action branches in `validateToolAction` (`tool-action-processor.ts:302-346`) push a transcript outcome and *skip* `commands`. With a batch of `[invalid, grep]`, grep's result lands at index 0 and gets paired with the invalid action's toolName/args/callId:

```
actions:      [ frobnicate(invalid) , grep("alpha") ]
                      │                    │
commands:     [ grep result ]  ← only grep pushed an entry
                      │
pairing by index:     ▼
  actions[0] frobnicate  ←→  commands[0] grep result     ✗ WRONG attribution
  actions[1] grep        ←→  (nothing)                   ✗ result lost
```

**How:** Extract one `recordInvalidToolCall` helper that pushes both the `commands` entry (`safe: false, reason: 'invalid action'`) and the transcript outcome, and use it in all four branches. The invariant becomes: *every processed action appends exactly one `commands` entry, in order; a `stop_batch` only truncates the tail.*

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts:297-348`
- Test: `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/mock-repo-search-loop.test.ts`:

```ts
test('runTaskLoop records one command entry per tool action so results stay aligned', async () => {
  const result = await runTaskLoop(
    {
      id: 'task-invalid-batch-alignment',
      question: 'Any question.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 3,
      maxInvalidResponses: 3,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        '{"action":"tool_batch","tool_calls":[{"tool_name":"frobnicate","args":{}},{"tool_name":"ls","args":{"path":"."}}]}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
    }
  );
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].safe, false);
  assert.equal(result.commands[0].reason, 'invalid action');
  assert.equal(result.commands[1].safe, true);
});
```

Contingency: if `ModelJson.parseRepoSearchPlannerAction` rejects the unknown `frobnicate` tool at parse time (the test then sees the invalid-*response* path and `commands.length === 0` with `reason` never reaching `'invalid action'`), replace `"tool_name":"frobnicate"` with `"tool_name":"write","args":{"path":"x.txt","content":"y"}` — `write` parses but is not in the default allowed planner tools, so it exercises the disallowed-tool branch of `validateToolAction` instead. Either branch pins the same invariant.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "one command entry per tool action" .\tests\mock-repo-search-loop.test.ts
```

Expected: FAIL with `AssertionError: 1 !== 2` — only the `ls` produced a commands entry.

- [ ] **Step 3: Add the helper and use it in all four branches**

In `src/repo-search/engine/tool-action-processor.ts`, add this private method immediately after `logInvalidAction` (which ends at line 402):

```ts
  /**
   * An invalid action must still append exactly one entry to `commands`: the task loop pairs
   * command results back to tool actions by index, so a skipped entry shifts every later result
   * onto the wrong action.
   */
  private recordInvalidToolCall(
    turn: number,
    toolAction: ToolAction,
    state: TurnBatchState,
    displayToolName: string,
    message: string,
  ): ToolActionOutcome {
    const { counters, commands } = this.deps;
    counters.invalidResponses += 1;
    commands.push({
      command: displayToolName,
      turn,
      safe: false,
      reason: 'invalid action',
      exitCode: null,
      output: message,
    });
    state.batchOutcomes.push({
      action: { tool_name: displayToolName, args: toolAction.args },
      toolCallId: `invalid_call_${counters.invalidResponses}`,
      toolContent: message,
    });
    return this.logInvalidAction(turn, toolAction, message);
  }
```

Then replace the four invalid branches inside `validateToolAction` (lines 302-346) with calls to it:

```ts
    if (!isCommandTool && !isNativeTool) {
      const unsupportedToolMessage = `Invalid action: unsupported planner tool "${toolAction.tool_name}" for repo-search. Use one of: ${this.deps.allowedPlannerToolNames.join(', ')}.`;
      return this.recordInvalidToolCall(turn, toolAction, state, String(toolAction.tool_name || '').trim() || 'invalid_tool_call', unsupportedToolMessage);
    }
    if (!this.deps.allowedPlannerToolNames.includes(normalizedToolName)) {
      const disallowedToolMessage = `Invalid action: tool "${normalizedToolName}" is not enabled for this run. Use one of: ${this.deps.allowedPlannerToolNames.join(', ')}.`;
      return this.recordInvalidToolCall(turn, toolAction, state, normalizedToolName, disallowedToolMessage);
    }
    const command = isCommandTool
      ? (typeof toolAction.args.command === 'string' ? toolAction.args.command : '')
      : buildRepoToolRequestedCommand(normalizedToolName, toolAction.args);
    if (isCommandTool && !command.trim()) {
      return this.recordInvalidToolCall(turn, toolAction, state, normalizedToolName, `Invalid action: ${normalizedToolName} requires args.command.`);
    }
    const expectedCommandToken = isCommandTool ? getRepoSearchCommandTokenForToolName(normalizedToolName) : null;
    const actualCommandToken = isCommandTool ? getFirstCommandToken(command) : null;
    if (isCommandTool && (!expectedCommandToken || actualCommandToken !== expectedCommandToken)) {
      return this.recordInvalidToolCall(turn, toolAction, state, normalizedToolName, `Invalid action: ${normalizedToolName} only allows commands starting with '${expectedCommandToken || '<unknown>'}'.`);
    }
    return { normalizedToolName, isCommandTool, isNativeTool, command };
```

Note the `counters.invalidResponses += 1` lines that used to sit inside each branch are gone — the helper does the increment, so the toolCallId numbering (`invalid_call_${counters.invalidResponses}`) is unchanged.

- [ ] **Step 4: Run the affected suites**

Run:

```
npx tsx --test .\tests\mock-repo-search-loop.test.ts .\tests\repo-search-loop.core.test.ts
```

Expected: all tests pass. If a pre-existing test asserts `result.commands.length` for a run that contained invalid actions, its expected count grows by the number of invalid actions — the new count is the correct one; update the expectation.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/tool-action-processor.ts tests/mock-repo-search-loop.test.ts
git commit -m "fix: record one command entry per tool action so results stay index-aligned"
```

---

### Task 14: Fold read-path-key case only on case-insensitive filesystems

**What:** Stop lowercasing read-window path keys on platforms whose filesystems are case-sensitive.

**Why:** `buildReadPathKey` (`src/repo-search/engine/read-overlap.ts:83-85`) always lowercases. On Windows/macOS that is correct — `Src/App.ts` and `src/app.ts` are the same file and must share one read-state. On Linux they are **two different files**, and folding them onto one key makes reading one mark the other's lines as already returned:

| Platform | Files                     | Keys after folding | Consequence                                    |
| -------- | ------------------------- | ------------------ | ---------------------------------------------- |
| Windows  | `README.md` (one file)    | `readme.md`        | correct — dedupe across spellings              |
| Linux    | `README.md`, `readme.md` (two files) | `readme.md` (collision!) | second file wrongly rejected as "exhausted read" |

**How:** Parameterize the fold on filesystem case-sensitivity; the production entry point derives the flag from `process.platform` once. Both callers (`buildReadPathKey` used by readers *and* mutators, per the comment at line 79-82) go through the same function, so invalidation still can't miss its window.

**Files:**
- Modify: `src/repo-search/engine/read-overlap.ts:79-85`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-tools.test.ts`:

```ts
test('read path keys fold case only on case-insensitive filesystems', () => {
  assert.equal(buildReadPathKeyForCaseSensitivity('Src/App.ts', true), 'src/app.ts');
  assert.equal(buildReadPathKeyForCaseSensitivity('Src/App.ts', false), 'Src/App.ts');
});
```

Add `buildReadPathKeyForCaseSensitivity` to the imports at the top of the file:

```ts
import { buildReadPathKeyForCaseSensitivity } from '../src/repo-search/engine/read-overlap.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "fold case only on" .\tests\repo-tools.test.ts
```

Expected: FAIL — `buildReadPathKeyForCaseSensitivity` does not exist yet.

- [ ] **Step 3: Implement the platform-aware fold**

In `src/repo-search/engine/read-overlap.ts`, replace lines 79-85:

```ts
/**
 * Sole derivation of the key used for the read-state map. Readers and mutating tools must both go
 * through it, or an invalidation silently misses the window it was meant to clear.
 */
export function buildReadPathKey(relativePath: string): string {
  return relativePath.toLowerCase();
}
```

with:

```ts
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Sole derivation of the key used for the read-state map. Readers and mutating tools must both go
 * through it, or an invalidation silently misses the window it was meant to clear.
 */
export function buildReadPathKey(relativePath: string): string {
  return buildReadPathKeyForCaseSensitivity(relativePath, CASE_INSENSITIVE_PATHS);
}

/**
 * Case folding is a property of the filesystem, not of the tool: on Windows/macOS `Src/App.ts`
 * and `src/app.ts` are one file and must share one key; on Linux they are two files and folding
 * them together marks lines of one as already returned by the other.
 */
export function buildReadPathKeyForCaseSensitivity(relativePath: string, caseInsensitivePaths: boolean): string {
  return caseInsensitivePaths ? relativePath.toLowerCase() : relativePath;
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass. On a Windows dev machine every existing read-window test already exercises the `true` branch; the new test pins the `false` branch that only manifests on Linux CI.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/read-overlap.ts tests/repo-tools.test.ts
git commit -m "fix: fold read path keys only on case-insensitive filesystems"
```

---

### Task 15: Close the symlink escape out of the repository root

**What:** Reject any path whose *real* (symlink-resolved) location is outside the repository root.

**Why:** `resolveRepoScopedPath` (`repo-tools.ts:256-270`) is purely lexical — it checks the string `relative(repoRoot, absolutePath)`. But `read`/`write`/`edit` then use `statSync`/`writeFileSync`, which **follow symlinks**. An in-repo symlink pointing outside the root defeats containment entirely:

```
repo root: C:\repo
C:\repo\escape  ──symlink──►  C:\secrets

read path="escape/creds.txt"
   lexical check:  relative("C:\repo", "C:\repo\escape\creds.txt") = "escape\creds.txt"  ✓ inside
   actual fs read: C:\secrets\creds.txt                                                  ✗ OUTSIDE
```

The typed-git design spec claims out-of-repository access is prevented "by construction" via this resolver — that claim is false until this fix lands.

**How:** After the lexical check, resolve the deepest *existing* ancestor of the target through `realpathSync` and require it to still sit under `realpathSync(repoRoot)`. Comparing realpath-to-realpath also keeps things correct when the repo root itself lives behind a symlink (macOS `/tmp` → `/private/tmp`). Walking to the deepest existing ancestor covers `write` targets whose leaf directories don't exist yet.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:1, 256-270`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-tools.test.ts`. Add `import os from 'node:os';` to the imports at the top of the file if it is not already there.

```ts
test('read refuses to follow an in-repo symlink that resolves outside the repository root', async () => {
  const root = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n', 'utf8');
  // 'junction' works without elevation on Windows and degrades to a plain dir symlink on POSIX.
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  const result = await executeRepoTool('read', { path: 'escape/secret.txt' }, makeContext(root));
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && /repository root/u.test(result.reason), `unexpected: ${JSON.stringify(result)}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "symlink that resolves outside" .\tests\repo-tools.test.ts
```

Expected: FAIL — the read currently succeeds and returns `1: top secret`.

- [ ] **Step 3: Add the realpath containment check**

In `src/repo-search/engine/repo-tools.ts`, add `realpathSync` to the `node:fs` import on line 1:

```ts
import { existsSync, statSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
```

Then insert these two helpers immediately above `resolveRepoScopedPath` (line 256):

```ts
/** The deepest ancestor of the path that exists on disk — the whole path, for read targets. */
function firstExistingAncestor(absolutePath: string): string {
  let current = absolutePath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * The lexical check above only constrains the path *string*. Symlinks are resolved by the
 * filesystem afterwards, so an in-repo link to an outside target passes the string check and
 * still escapes. Comparing realpaths closes that; realpathing the root too keeps a symlinked
 * repo root (macOS /tmp) working.
 */
function escapesRepoRootViaSymlink(repoRoot: string, absolutePath: string): boolean {
  const realRoot = realpathSync(repoRoot);
  const realTarget = realpathSync(firstExistingAncestor(absolutePath));
  const relativePath = relative(realRoot, realTarget);
  return relativePath.startsWith('..') || isAbsolute(relativePath);
}
```

Then in `resolveRepoScopedPath`, after the existing lexical rejection:

```ts
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
```

add:

```ts
  if (escapesRepoRootViaSymlink(repoRoot, absolutePath)) {
    return null;
  }
```

`realpathSync` can itself throw on a permissions race; Task 12's guard converts that into a failed tool result, so no extra handling is needed here.

- [ ] **Step 4: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass — the new symlink test and every existing path test (normal in-repo paths realpath to themselves, so nothing else changes).

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: reject repo-tool paths that escape the repository root through symlinks"
```

---

### Task 16: Make grep's ignore rules agree with the native ignore check

**What:** Emit ripgrep ignore globs that match `isRepoRelativePathIgnored`'s semantics: case-insensitive, and covering ignored *names* both as directories and as plain files.

**Why:** `buildGrepArgs` (`repo-tools.ts:473-478`) emits `--glob '!**/name/**'` per ignored name. That disagrees with the native check (`isRepoRelativePathIgnored`, lines 242-254) in two ways:

| Case                                        | Native check (`find`/`ls`/`read`) | grep today                        |
| ------------------------------------------- | --------------------------------- | --------------------------------- |
| dir `Node_Modules/` (case variant)          | ignored (`namesLower`)            | **searched** (rg globs are case-sensitive) |
| file literally named `vendor` (not a dir)   | ignored (every segment checked)   | **searched** (`!**/vendor/**` needs a dir) |
| `find` glob `*.TS` vs grep `--glob '*.TS'`  | matches `.ts` (regex flag `iu`)   | matches nothing                   |

The planner-visible symptom is a dead end: grep returns a hit inside a file that `read` then refuses to open with "path is ignored by runtime policy".

**How:** Use `--iglob` (ripgrep's case-insensitive glob) for the ignore rules and the planner's `glob` argument, and emit both the bare-name and the dir-contents form for every ignored name and path.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:459-481`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-tools.test.ts`. `node_modules` and `vendor` are both in `BASELINE_IGNORED_NAMES` (`src/repo-search/command-safety.ts:5-28`).

```ts
test('grep excludes ignored names case-insensitively and as plain files, like the native ignore check', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'Node_Modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Node_Modules', 'dep.ts'), 'alpha dep\n', 'utf8');
  fs.writeFileSync(path.join(root, 'vendor'), 'alpha vendored\n', 'utf8');
  const result = await executeRepoTool('grep', { pattern: 'alpha' }, makeContext(root));
  assert.ok(result.ok);
  assert.ok(!result.output.includes('dep.ts'), `case-variant ignored dir leaked: ${result.output}`);
  assert.ok(!result.output.includes('vendored'), `ignored file name leaked: ${result.output}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "excludes ignored names case-insensitively" .\tests\repo-tools.test.ts
```

Expected: FAIL — at least the `vendor` file leaks on every platform; `Node_Modules` additionally leaks wherever rg's glob matching is case-sensitive.

- [ ] **Step 3: Emit parity globs**

In `src/repo-search/engine/repo-tools.ts`, in `buildGrepArgs`, replace:

```ts
  const glob = optionalString(args.glob);
  if (glob !== undefined) {
    argv.push('--glob', glob);
  }
  for (const name of ignorePolicy.names) {
    argv.push('--glob', `!**/${name}/**`);
  }
  for (const ignoredPath of ignorePolicy.paths) {
    argv.push('--glob', `!${ignoredPath}/**`);
  }
```

with:

```ts
  const glob = optionalString(args.glob);
  if (glob !== undefined) {
    // --iglob matches find's case-insensitive glob regex, so one planner glob means one thing.
    argv.push('--iglob', glob);
  }
  // Parity with isRepoRelativePathIgnored: names are ignored case-insensitively and whether the
  // segment is a directory or a plain file; paths exclude the entry itself and its contents.
  for (const name of ignorePolicy.names) {
    argv.push('--iglob', `!**/${name}`, '--iglob', `!**/${name}/**`);
  }
  for (const ignoredPath of ignorePolicy.paths) {
    argv.push('--iglob', `!${ignoredPath}`, '--iglob', `!${ignoredPath}/**`);
  }
```

- [ ] **Step 4: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass, including the pre-existing `grep glob filters to matching files only` (line 246) — `--iglob` accepts the same glob strings `--glob` did.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: align grep ignore globs with the native ignore check"
```

---

### Task 17: Make grep's limit count matches, not output lines

**What:** Apply `limit` to *match lines* only, and make the "more matches" figure count matches.

**Why:** `executeGrep` (`repo-tools.ts:508-519`) counts every output line. With `context` set, ripgrep interleaves context lines (`path-12-text`) and `--` group separators with match lines (`path:12:text`), so the cap fires early and the overflow message lies:

```
6 matches, context=1, limit=5

rg output (12 lines):          old accounting:           new accounting:
  haystack.txt-1-pad0            line 1  ← counted         context, not counted
  haystack.txt:2:needle 0        line 2  ← counted         match 1
  haystack.txt-3-pad1            line 3  ← counted         context
  haystack.txt:4:needle 1        line 4  ← counted         match 2
  haystack.txt-5-pad2            line 5  ← CUT HERE        context
  ...                            "7 more matches"  ✗       ...cut after match 5
                                 (only 2 matches shown)    "1 more matches"  ✓
```

**How:** One `truncateGrepOutput` helper that identifies match lines by their `path:line:` prefix, cuts at the first line of the `(limit+1)`-th match, and reports the true remaining-match count. (A context line whose *text* happens to contain `:12:` after the first colon can be miscounted by the prefix regex; that is a rare cosmetic miscount, accepted to avoid changing rg's output format with field-separator flags.)

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:504-521`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/repo-tools.test.ts`:

```ts
test('grep limit counts matches, not context lines', async () => {
  const root = makeRepo();
  const body = Array.from({ length: 6 }, (unused, index) => `pad${index}\nneedle ${index}\n`).join('');
  fs.writeFileSync(path.join(root, 'haystack.txt'), body, 'utf8');
  const result = await executeRepoTool('grep', { pattern: 'needle', path: 'haystack.txt', context: 1, limit: 5 }, makeContext(root));
  assert.ok(result.ok);
  const matchLines = result.output.split('\n').filter((line) => /^haystack\.txt:\d+:/u.test(line));
  assert.equal(matchLines.length, 5);
  assert.ok(result.output.includes('1 more matches beyond limit=5'), `unexpected output: ${result.output}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```
npx tsx --test --test-name-pattern "counts matches, not context lines" .\tests\repo-tools.test.ts
```

Expected: FAIL — the old line-based cut leaves ~3 visible matches and reports `7 more matches`.

- [ ] **Step 3: Add the match-aware truncation**

In `src/repo-search/engine/repo-tools.ts`, insert above `executeGrep`:

```ts
const GREP_MATCH_LINE_PATTERN = /^.+?:\d+:/u;

/**
 * Applies `limit` to match lines only. With context enabled, rg interleaves `path-12-text`
 * context lines and `--` group separators; counting those as matches made the cap fire early and
 * the "more matches" figure wrong.
 */
function truncateGrepOutput(outputLines: string[], limit: number): string {
  let totalMatches = 0;
  let cutIndex = -1;
  for (let index = 0; index < outputLines.length; index += 1) {
    if (!GREP_MATCH_LINE_PATTERN.test(outputLines[index])) {
      continue;
    }
    totalMatches += 1;
    if (totalMatches === limit + 1 && cutIndex === -1) {
      cutIndex = index;
    }
  }
  if (cutIndex === -1) {
    return outputLines.join('\n');
  }
  return `${outputLines.slice(0, cutIndex).join('\n')}\n... ${totalMatches - limit} more matches beyond limit=${limit}; narrow the pattern, glob, or path.`;
}
```

Then in `executeGrep`, replace the tail (post-Task-10 state):

```ts
  const truncated = matchLines.length > limit;
  const output = truncated
    ? `${matchLines.slice(0, limit).join('\n')}\n... ${matchLines.length - limit} more matches beyond limit=${limit}; narrow the pattern, glob, or path.`
    : matchLines.join('\n');
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'grep', outputUnit: 'lines' };
```

with:

```ts
  const output = truncateGrepOutput(matchLines, limit);
  return { ok: true, requestedCommand: command, command, exitCode: 0, output, toolType: 'grep', outputUnit: 'lines' };
```

- [ ] **Step 4: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass, including the pre-existing grep limit test — without `context`, every output line is a match line, so behavior there is identical.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: apply grep limit to matches instead of raw output lines"
```

---

### Task 18: Validate `run`'s timeout and include it in the dedup key

**What:** Reject a present non-positive `timeout` on `run`, and put `timeout` into `run`'s synthetic command string.

**Why:** Two instances of the same defect class Task 10 fixed for `limit`:
1. `executeRun` uses `optionalPositive(args.timeout)` (`repo-tools.ts:701`), so `timeout: 0` silently becomes *no timeout at all* — the opposite of what was asked.
2. `buildRepoToolRequestedCommand('run', ...)` (lines 185-190) omits `timeout`, and that string is the duplicate-detection key. Two runs differing only in timeout collapse onto one key:

| Call                                   | Dedup key today                  | Verdict         |
| -------------------------------------- | -------------------------------- | --------------- |
| `run "npm test" timeout=60` (times out)| `run command="npm test"`         | executes        |
| `run "npm test" timeout=600` (retry)   | `run command="npm test"`         | **rejected as exact duplicate** |

**How:** Explicit validation in `executeRun`; one more `CommandArg` entry in the key builder.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:185-190, 687-707`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts`. Add `buildRepoToolRequestedCommand` to the existing import from `../src/repo-search/engine/repo-tools.js` if it is not already imported.

```ts
test('run rejects a non-positive timeout', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('run', { command: 'echo hi', timeout: 0 }, makeContext(root));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : '', 'timeout must be a positive integer (seconds)');
});

test('run includes timeout in its requested command so differing timeouts are not duplicates', () => {
  assert.equal(
    buildRepoToolRequestedCommand('run', { command: 'echo hi', timeout: 30 }),
    'run command="echo hi" timeout=30',
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test --test-name-pattern "run (rejects a non-positive|includes timeout)" .\tests\repo-tools.test.ts
```

Expected: 2 failures — `run` with `timeout: 0` currently executes (spawns PowerShell with no timeout), and the requested command currently omits `timeout`.

- [ ] **Step 3: Implement both**

In `src/repo-search/engine/repo-tools.ts`, in `buildRepoToolRequestedCommand`, replace the `run` block:

```ts
  if (toolName === 'run') {
    return formatToolCommand('run', [
      ['command', readString(args.command)],
      ['outputMode', optionalString(args.outputMode)],
    ]);
  }
```

with:

```ts
  if (toolName === 'run') {
    return formatToolCommand('run', [
      ['command', readString(args.command)],
      ['outputMode', optionalString(args.outputMode)],
      ['timeout', optionalPositive(args.timeout)],
    ]);
  }
```

In `executeRun`, replace:

```ts
  const timeoutSeconds = optionalPositive(args.timeout);
```

with:

```ts
  const rawTimeout = args.timeout;
  let timeoutSeconds: number | undefined;
  if (rawTimeout !== undefined && rawTimeout !== null) {
    const parsed = Math.trunc(Number(rawTimeout));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return failure('run', command, 'timeout must be a positive integer (seconds)');
    }
    timeoutSeconds = parsed;
  }
```

- [ ] **Step 4: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: validate run timeout and include it in the run dedup key"
```

---

### Task 19: Invalidate the duplicate replay anchor when the transcript is compacted

**What:** Tag the replay anchor with a transcript *generation* number and refuse to reuse an anchor from a previous generation.

**Why:** When a duplicate is replayed, the tracker stores an **absolute message index** and later `replaceToolMessage(index, ...)` rewrites that slot in place. But context compaction (`prompt-preparer.ts:121` → `transcript.replaceWith(...)`) rebuilds the whole message array between turns. `registerDuplicate` only bounds-checks (`index < messageCount`), so a stale index that is still in range rewrites **whatever message now sits there** — possibly a real tool result:

```
before compaction:            after compaction:
  [0] system                    [0] system
  [1] user                      [1] user (summary inserted)
  ...                           [2] assistant
  [14] tool  ◄─ anchor #14      [3] tool   ← real evidence
  [15] user                     [4] tool   ◄─ stale anchor #14? out of range — OK
                                ...
                                [14] tool  ◄─ if array is still ≥15 long, anchor #14
                                             REWRITES this unrelated message
```

Task 6 makes duplicate state run-wide (longer-lived), so the odds of an active replay crossing a compaction go *up* — this fix belongs with it.

**How:** `TranscriptManager` gets a `generation` counter bumped by `replaceWith`. The tracker stores the generation alongside the index and treats a generation mismatch like an expired anchor (pushes a fresh outcome instead of replacing). Explicit value passing — no callbacks.

**Files:**
- Modify: `src/repo-search/engine/transcript-manager.ts:12-52`
- Modify: `src/repo-search/engine/duplicate-tracker.ts` (the Task 6 version)
- Modify: `src/repo-search/engine/tool-action-processor.ts:182-184, 468`
- Test: `tests/engine-duplicate-tracker.test.ts`, `tests/engine-transcript-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine-duplicate-tracker.test.ts`:

```ts
test('registerDuplicate ignores an anchor set before a transcript compaction', () => {
  const tracker = new DuplicateTracker();
  tracker.registerDuplicate('fp', 10, 0);
  tracker.setReplayToolMessageIndex(4, 0);
  const sameGeneration = tracker.registerDuplicate('fp', 10, 0);
  assert.equal(sameGeneration.activeReplayMessageIndex, 4);
  tracker.setReplayToolMessageIndex(4, 0);
  const afterCompaction = tracker.registerDuplicate('fp', 10, 1);
  assert.equal(afterCompaction.activeReplayMessageIndex, null);
});
```

Append to `tests/engine-transcript-manager.test.ts`:

```ts
test('replaceWith bumps the transcript generation', () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'sys',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
  });
  assert.equal(transcript.generation, 0);
  transcript.replaceWith([{ role: 'user', content: 'compacted' }]);
  assert.equal(transcript.generation, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test .\tests\engine-duplicate-tracker.test.ts .\tests\engine-transcript-manager.test.ts
```

Expected: both new tests fail — the tracker methods do not take a generation argument yet (typecheck/arity error) and `transcript.generation` is `undefined`.

- [ ] **Step 3: Add the generation counter to TranscriptManager**

In `src/repo-search/engine/transcript-manager.ts`, add a field and getter inside the class (after `lastLoggedMessageCount`, line 14):

```ts
  private generationCounter = 0;

  /** Incremented whenever compaction rewrites the message array, invalidating absolute indexes. */
  get generation(): number {
    return this.generationCounter;
  }
```

And in `replaceWith` (lines 49-52), add the bump:

```ts
  replaceWith(compactedMessages: ChatMessage[]): void {
    this.messages.splice(0, this.messages.length, ...compactedMessages);
    this.lastLoggedMessageCount = 0;
    this.generationCounter += 1;
  }
```

- [ ] **Step 4: Thread the generation through DuplicateTracker**

In `src/repo-search/engine/duplicate-tracker.ts` (the Task 6 version), add a field next to `replayToolMessageIndex`:

```ts
  private replayTranscriptGeneration = -1;
```

Change `registerDuplicate` to:

```ts
  registerDuplicate(duplicateFingerprint: string, messageCount: number, transcriptGeneration: number): DuplicateRegistration {
    const isActiveReplay = this.replayFingerprint === duplicateFingerprint
      && this.replayToolMessageIndex >= 0
      && this.replayToolMessageIndex < messageCount
      && this.replayTranscriptGeneration === transcriptGeneration;
    this.replayFingerprint = duplicateFingerprint;
    this.replayCount = isActiveReplay ? this.replayCount + 1 : 2;
    return {
      count: this.replayCount,
      activeReplayMessageIndex: isActiveReplay ? this.replayToolMessageIndex : null,
    };
  }
```

Change `setReplayToolMessageIndex` to:

```ts
  setReplayToolMessageIndex(index: number, transcriptGeneration: number): void {
    this.replayToolMessageIndex = index;
    this.replayTranscriptGeneration = transcriptGeneration;
  }
```

- [ ] **Step 5: Update the two call sites and any older tests**

In `src/repo-search/engine/tool-action-processor.ts`:

Line 468 (inside `rejectAsDuplicate`), change:

```ts
    const registration = duplicates.registerDuplicate(options.duplicateFingerprint, transcript.length);
```

to:

```ts
    const registration = duplicates.registerDuplicate(options.duplicateFingerprint, transcript.length, transcript.generation);
```

Lines 182-184 (inside `executeBatch`), change:

```ts
    if (state.batchDuplicateAnchorIndex !== null && state.batchOutcomes.length > 0) {
      duplicates.setReplayToolMessageIndex(preAppendMessagesLength + 1 + state.batchDuplicateAnchorIndex);
    }
```

to:

```ts
    if (state.batchDuplicateAnchorIndex !== null && state.batchOutcomes.length > 0) {
      duplicates.setReplayToolMessageIndex(preAppendMessagesLength + 1 + state.batchDuplicateAnchorIndex, transcript.generation);
    }
```

In `tests/engine-duplicate-tracker.test.ts`, update every pre-existing call to `registerDuplicate(fp, n)` to `registerDuplicate(fp, n, 0)` and every `setReplayToolMessageIndex(i)` to `setReplayToolMessageIndex(i, 0)` — passing generation `0` preserves each test's original meaning.

- [ ] **Step 6: Run the suites to verify they pass**

Run:

```
npx tsx --test .\tests\engine-duplicate-tracker.test.ts .\tests\engine-transcript-manager.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/duplicate-tracker.ts src/repo-search/engine/transcript-manager.ts src/repo-search/engine/tool-action-processor.ts tests/engine-duplicate-tracker.test.ts tests/engine-transcript-manager.test.ts
git commit -m "fix: invalidate the duplicate replay anchor across transcript compaction"
```

---

### Task 20: Give find and ls explicit empty-result messages like grep

**What:** Return `'No files matched.'` from an empty `find` and `'Directory is empty.'` from an empty `ls`, mirroring grep's existing `'No matches found.'`.

**Why:** The three search tools currently answer "nothing found" in two different dialects, and the difference feeds straight into stall accounting:

| Tool  | Empty result today   | Ticks zero-output countdown? | Counts as evidence?         |
| ----- | -------------------- | ---------------------------- | --------------------------- |
| grep  | `No matches found.`  | no                           | yes (message has anchors)   |
| find  | `''`                 | **yes**                      | no (after Task 7)           |
| ls    | `''`                 | **yes**                      | no (after Task 7)           |

Same logical outcome, opposite stagnation signals. After this task all three behave like grep: an explicit answer, no countdown tick, with stall pressure supplied by the duplicate tracker (Task 6) and no-new-evidence accounting (Task 7) when the planner repeats itself.

**How:** One conditional in each tool's output assembly, plus updating the Task 5 assertion that pinned the old `''` convention.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts` (`executeFind`, `executeLs` output assembly)
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts`:

```ts
test('find reports an explicit no-match result instead of empty output', async () => {
  const root = makeRepo();
  const result = await executeRepoTool('find', { pattern: '**/*.zig' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'No files matched.');
});

test('ls reports an explicit empty-directory result instead of empty output', async () => {
  const root = makeRepo();
  fs.mkdirSync(path.join(root, 'hollow'), { recursive: true });
  const result = await executeRepoTool('ls', { path: 'hollow' }, makeContext(root));
  assert.ok(result.ok);
  assert.equal(result.output, 'Directory is empty.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test --test-name-pattern "explicit (no-match|empty-directory)" .\tests\repo-tools.test.ts
```

Expected: 2 failures — both currently return `''`.

- [ ] **Step 3: Emit the messages**

In `src/repo-search/engine/repo-tools.ts`, in `executeFind`, replace the output assembly (post-Task-10 state):

```ts
  const truncated = filtered.length > limit;
  const output = truncated
    ? `${filtered.slice(0, limit).join('\n')}\n... ${filtered.length - limit} more files beyond limit=${limit}; narrow the pattern or path.`
    : filtered.join('\n');
```

with:

```ts
  const truncated = filtered.length > limit;
  const output = filtered.length === 0
    ? 'No files matched.'
    : truncated
      ? `${filtered.slice(0, limit).join('\n')}\n... ${filtered.length - limit} more files beyond limit=${limit}; narrow the pattern or path.`
      : filtered.join('\n');
```

In `executeLs`, replace (post-Task-10 state):

```ts
  const truncated = entries.length > limit;
  const output = truncated
    ? `${entries.slice(0, limit).join('\n')}\n... ${entries.length - limit} more entries beyond limit=${limit}.`
    : entries.join('\n');
```

with:

```ts
  const truncated = entries.length > limit;
  const output = entries.length === 0
    ? 'Directory is empty.'
    : truncated
      ? `${entries.slice(0, limit).join('\n')}\n... ${entries.length - limit} more entries beyond limit=${limit}.`
      : entries.join('\n');
```

- [ ] **Step 4: Update the Task 5 assertion that pinned the old convention**

In `tests/repo-tools.test.ts`, in `find applies the ignore policy relative to the repository root when scoped into a parent of an ignored path` (added in Task 5), change:

```ts
  assert.equal(scoped.output, '');
```

to:

```ts
  assert.equal(scoped.output, 'No files matched.');
```

- [ ] **Step 5: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass. If a task-loop test asserted the zero-output countdown ticking on an empty `find`/`ls`, update it — an explicit no-match answer is not a zero-output stall anymore.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: report explicit empty results from find and ls like grep does"
```

---

### Task 21: Guard read against huge files and offsets past EOF

**What:** Reject a `read` of a file larger than a fixed byte budget, and reject an `offset` beyond the last line instead of silently clamping to it.

**Why:** Two silent behaviors in `planRead` (`repo-tools.ts:365-376`):
1. The whole file is loaded and split regardless of `limit` — a 500 MB artifact costs full memory and decode time to return 100 lines.
2. `clampedStart = Math.min(offset, lines.length || 1)` maps any offset past EOF onto the last line. The planner asks for line 999 of a 5-line file and gets line 5 back, numbered `5:` — it looks like the file has content there:

| Request                       | Old result                       | New result                                        |
| ----------------------------- | -------------------------------- | ------------------------------------------------- |
| `read offset=999` (5 lines)   | line 5, silently                 | rejected: `offset 999 is past the end of ... (5 lines)` |
| `read` 500 MB file            | loads it all                     | rejected: use grep to extract lines               |
| `read offset=3` (5 lines)     | lines 3-5                        | unchanged                                         |

**How:** A `READ_MAX_BYTES` constant checked from the already-available `statSync` result, and an explicit past-EOF failure. Depends on Task 11's `splitSourceLines` for honest line counts.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:21-23, 365-376`
- Test: `tests/repo-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/repo-tools.test.ts`:

```ts
test('planRead rejects an offset past the end of the file', () => {
  const root = makeRepo();
  const plan = planRead({ path: 'src/a.ts', offset: 6 }, root, buildIgnorePolicy(root));
  assert.ok(isFailedReadPlan(plan));
  assert.match(plan.reason, /past the end/u);
});

test('planRead rejects a file larger than READ_MAX_BYTES', () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'big.txt'), `${'x'.repeat(1024)}\n`.repeat(2048), 'utf8');
  const plan = planRead({ path: 'big.txt', offset: 1 }, root, buildIgnorePolicy(root));
  assert.ok(isFailedReadPlan(plan));
  assert.match(plan.reason, /read supports files up to/u);
});
```

(`'x'.repeat(1024) + '\n'` × 2048 ≈ 2.1 MB, just over the 2 MB budget below.)

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```
npx tsx --test --test-name-pattern "planRead rejects" .\tests\repo-tools.test.ts
```

Expected: 2 failures — offset 6 currently clamps to line 5 and succeeds; the big file currently loads and succeeds.

- [ ] **Step 3: Implement both guards**

In `src/repo-search/engine/repo-tools.ts`, add next to the other exported limits (lines 21-23):

```ts
export const READ_MAX_BYTES = 2_000_000;
```

In `planRead`, replace:

```ts
  if (!existsSync(resolvedPath.absolutePath) || !statSync(resolvedPath.absolutePath).isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }

  const lines = splitSourceLines(readSourceText(resolvedPath.absolutePath));
  const displayPath = resolvedPath.relativePath;
  const pathKey = buildReadPathKey(displayPath);
  const totalEndLineExclusive = (lines.length || 0) + 1;
  const clampedStart = Math.min(offset, lines.length || 1);
```

with:

```ts
  if (!existsSync(resolvedPath.absolutePath)) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }
  const fileStat = statSync(resolvedPath.absolutePath);
  if (!fileStat.isFile()) {
    return { ok: false, command: requestedCommand, reason: 'path is not a readable file' };
  }
  if (fileStat.size > READ_MAX_BYTES) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `file is ${fileStat.size} bytes; read supports files up to ${READ_MAX_BYTES} bytes — use grep to extract the lines you need`,
    };
  }

  const lines = splitSourceLines(readSourceText(resolvedPath.absolutePath));
  if (offset > lines.length) {
    return {
      ok: false,
      command: requestedCommand,
      reason: `offset ${offset} is past the end of ${resolvedPath.relativePath} (${lines.length} line${lines.length === 1 ? '' : 's'})`,
    };
  }
  const displayPath = resolvedPath.relativePath;
  const pathKey = buildReadPathKey(displayPath);
  const totalEndLineExclusive = (lines.length || 0) + 1;
  const clampedStart = offset;
```

The `Math.min` clamp is gone because the past-EOF guard now makes `offset <= lines.length` an invariant. A zero-byte file has zero lines, so any read of it is rejected with `offset 1 is past the end of ... (0 lines)` — consistent with the zero-lines representation from Task 11.

- [ ] **Step 4: Run the suite to verify it passes**

Run:

```
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass — existing `planRead` tests use offsets within their 5-line fixture.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: guard read against oversized files and offsets past end of file"
```

---

### Task 22: Amend the typed-git design spec and add env support to spawnDirectCommand

**What:** Fold the three security gaps found in review into `docs/superpowers/specs/2026-08-02-typed-native-git-tool-design.md`, and implement the `env` option the spec's execution step already assumes.

**Why:** The spec's "cannot be expressed" defense stops the *planner* from enabling dangerous options — it does not stop the *repository configuration* from enabling them, and it does not cover planner text landing in an option position:

| Gap | Attack/failure path                                                                  | Spec today            |
| --- | ------------------------------------------------------------------------------------ | --------------------- |
| G1  | `diff.external` / `diff.*.textconv` / `core.fsmonitor` in repo config execute a configured command on plain `git diff` / `git status` | silent — only bans the *flags* |
| G2  | `grep` pattern `--open-files-in-pager=<cmd>` is parsed as an option and executes a command | ref rules only cover *refs* |
| G3  | Inherited `GIT_DIR` / `GIT_EXTERNAL_DIFF` / `GIT_PAGER` env redirect or execute; `spawnDirectCommand` has no `env` option at all (`src/lib/command-spawn.ts:10-14`) | assumes `env` exists |

**How:** Three surgical spec edits (exact old→new text below) plus a typed `env` option on `spawnDirectCommand` with the explicit contract *"when provided, this is the child's entire environment"* — full replacement, because scrubbing by merge cannot *remove* inherited variables.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-typed-native-git-tool-design.md`
- Modify: `src/lib/command-spawn.ts:10-26`
- Create: `tests/command-spawn.test.ts`

- [ ] **Step 1: Amend the spec — config-driven execution**

In `docs/superpowers/specs/2026-08-02-typed-native-git-tool-design.md`, replace:

```
Every argv begins with `--no-optional-locks`. Only fixed read operations and fixed flags are emitted. Options such as `--output`, `--ext-diff`, pager configuration, hooks, aliases, `-C`, `--git-dir`, and `--work-tree` cannot be expressed.
```

with:

```
Every argv begins with `-c core.fsmonitor=false -c diff.external= --no-optional-locks`, and the diff-family operations (`diff`, `show`, `log` with patches, `blame`) additionally pass `--no-ext-diff --no-textconv`. This is deliberate belt-and-braces: options such as `--output`, `--ext-diff`, pager configuration, hooks, aliases, `-C`, `--git-dir`, and `--work-tree` cannot be expressed by the planner, but `diff.external`, `diff.*.textconv`, and `core.fsmonitor` are honoured from repository/user configuration *by default*, so unexpressible is not the same as disabled. The `-c` overrides and `--no-*` flags force them off regardless of what any config file says.

The child environment is constructed, not inherited: `spawnDirectCommand`'s `env` option replaces the entire environment, and the git tool passes a copy of `process.env` with every `GIT_*` variable removed (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_CONFIG_*`, ...), so an inherited variable can neither redirect the repository nor execute a configured program.
```

- [ ] **Step 2: Amend the spec — positional-argument anchoring**

In the same file, in the "Path and ref rules" section, replace:

```
Refs are passed as argv values, never concatenated with a path. A ref must be non-empty, must not begin with `-`, and must not contain NUL or ASCII control characters. `show` uses separate `ref` and `path` fields and constructs the object expression only after both fields pass validation.
```

with:

```
Refs are passed as argv values, never concatenated with a path. A ref must be non-empty, must not begin with `-`, and must not contain NUL or ASCII control characters. `show` uses separate `ref` and `path` fields and constructs the object expression only after both fields pass validation.

The same option-injection rule extends to every planner-supplied positional, not only refs: `grep` passes its pattern behind `-e` (a pattern like `--open-files-in-pager=<cmd>` must arrive as a pattern, never as an option), and every path list is separated from options by a literal `--`. No planner string is ever placed where git could parse it as an option name.
```

- [ ] **Step 3: Amend the spec — execution step 4**

In the same file, replace the execution-architecture list item:

```
4. The tool invokes `spawnDirectCommand('git', argv, { cwd, abortSignal, env })`.
```

with:

```
4. The tool invokes `spawnDirectCommand('git', argv, { cwd, abortSignal, env })`, where `env` is the scrubbed full-replacement environment described above (`spawnDirectCommand` treats a provided `env` as the child's entire environment).
```

- [ ] **Step 4: Write the failing tests for the env option**

Create `tests/command-spawn.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnDirectCommand } from '../src/lib/command-spawn.js';

// Windows child processes need SystemRoot for some node internals; pass it through
// explicitly since a provided env is a full replacement.
function baseEnv(): Record<string, string> {
  const systemRoot = process.env.SystemRoot;
  return systemRoot === undefined ? {} : { SystemRoot: systemRoot };
}

test('spawnDirectCommand with env provides the entire child environment', async () => {
  process.env.SIFT_SPAWN_LEAK_PROBE = 'leaked';
  try {
    const result = await spawnDirectCommand(process.execPath, [
      '-e',
      'process.stdout.write(String(process.env.SIFT_SPAWN_MARKER || "") + "|" + String(process.env.SIFT_SPAWN_LEAK_PROBE || ""))',
    ], { env: { ...baseEnv(), SIFT_SPAWN_MARKER: 'yes' } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'yes|');
  } finally {
    delete process.env.SIFT_SPAWN_LEAK_PROBE;
  }
});

test('spawnDirectCommand without env inherits the parent environment', async () => {
  process.env.SIFT_SPAWN_INHERIT_PROBE = 'inherited';
  try {
    const result = await spawnDirectCommand(process.execPath, [
      '-e',
      'process.stdout.write(String(process.env.SIFT_SPAWN_INHERIT_PROBE || ""))',
    ], {});
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'inherited');
  } finally {
    delete process.env.SIFT_SPAWN_INHERIT_PROBE;
  }
});
```

- [ ] **Step 5: Run the tests to verify the first fails**

Run:

```
npx tsx --test .\tests\command-spawn.test.ts
```

Expected: the first test fails — `env` is not in `DirectCommandOptions`, so typecheck rejects it (or, if run loosely, the option is ignored and `stdout` is `yes|leaked`). The second passes (pins current behavior).

- [ ] **Step 6: Implement the env option**

In `src/lib/command-spawn.ts`, replace:

```ts
export type DirectCommandOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
};
```

with:

```ts
export type DirectCommandOptions = {
  cwd?: string;
  windowsHide?: boolean;
  abortSignal?: AbortSignal;
  /**
   * When provided, this is the child's ENTIRE environment — nothing is inherited implicitly.
   * Full replacement (not merge) because scrubbing dangerous inherited variables (GIT_DIR,
   * GIT_EXTERNAL_DIFF, ...) requires removal, which a merge cannot express.
   */
  env?: Record<string, string>;
};
```

and pass it to `spawn`:

```ts
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: options.windowsHide ?? true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    });
```

(`env: undefined` means "inherit" to `child_process.spawn`, so the no-env behavior is unchanged.)

- [ ] **Step 7: Run the tests to verify they pass**

Run:

```
npx tsx --test .\tests\command-spawn.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-08-02-typed-native-git-tool-design.md src/lib/command-spawn.ts tests/command-spawn.test.ts
git commit -m "feat: add full-replacement env to spawnDirectCommand and harden the typed-git spec"
```

---

### Task 23: Full verification

**What:** Prove the whole plan holds together: typecheck, lint, full suite, and one live smoke run of the original failure case.

**Why:** Tasks 5/9/10/17/20 edit overlapping regions of `executeFind`/`executeGrep`/`executeLs`, and Tasks 6/13/19 all touch `tool-action-processor.ts` — only the full gate proves the composition, not just each diff.

- [ ] **Step 1: Run typecheck and lint**

Run:

```
npm run typecheck
```

Expected: exits 0. This chain ends with `npm run lint` (eslint), so a lint failure surfaces here. Watch specifically for an unused-symbol error on `readPositiveInteger` — if Task 10 left it with no callers, that is a signal the `offset` call sites were changed by mistake and must be restored.

- [ ] **Step 2: Run the full test suite**

Run:

```
npm test
```

Expected: exits 0, no failing tests. Suites this plan touched directly: `repo-tools`, `command-safety`, `command-spawn`, `engine-duplicate-tracker`, `engine-transcript-manager`, `tool-loop-governor`, `engine-tool-stats`, `mock-repo-search-loop`, `repo-search-loop.core`. If an unrelated suite fails, confirm it also fails on a `git stash`-ed working tree before attributing it to this plan.

- [ ] **Step 3 (optional smoke test): Confirm the original failure case end to end**

The bug was reported against a live repo-search run, so exercise the shipped path once. The `siftkit` bin runs `dist/`, which `npm test` does not refresh (`build:test` only builds the test tree), so a full build is required first:

```
npm run build
siftkit repo-search --prompt "Run find with pattern **/package.json limited to 5 results and report the exact paths returned, verbatim."
```

Expected: the reported paths include a bare `package.json` (this repo's root) alongside nested ones such as `dashboard/package.json`. Before Task 2 the root-level entry is absent.

This step needs a running SiftKit status server. If it reports `ECONNREFUSED 127.0.0.1:4765`, skip it and say so in the task report — Steps 1 and 2 are the binding gate, this is confirmation only.

- [ ] **Step 4: Commit any expectation updates the full suite forced**

```bash
git add -A
git commit -m "test: update expectations affected by the repo-tool and command-gate fixes"
```

If the suite was already green and nothing changed, skip this step rather than creating an empty commit.
