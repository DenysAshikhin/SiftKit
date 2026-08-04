# Repo-Tool Drift Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strictly validate every positive-integer repo-tool argument, make grep context truncation group-aware, and prove root-relative grep ignore paths with real execution tests.

**Architecture:** Keep the change inside the existing repo-tool boundary. One local Zod schema supplies strict positive integers to explicit resolver functions; execution methods reject present invalid values and command builders format only normalized values. Grep output remains text-based, with a small group-boundary correction rather than a new parser or `rg --json` migration.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js test runner through `tsx`, ripgrep, c8.

**Design:** `docs/superpowers/specs/2026-08-03-repo-tools-drift-fixes-design.md`

## Global Constraints

- Follow TDD: prove every production behavior change RED before implementation, then GREEN, then refactor.
- Prefer real repo-tool execution tests; do not mock ripgrep or child processes.
- TypeScript only. Runtime-boundary types come from Zod through `z.infer`.
- No type-assertion casts, `any`, non-null assertions, or namespace imports. `as const` and `satisfies` remain allowed.
- Do not pass functions dynamically. Calls and dependencies remain explicit.
- No compatibility shims or retained coercion path. Numeric strings and fractions must fail.
- Reuse existing repo-tool helpers and managed test directories. Do not create a new class or module for one schema.
- Keep production changes limited to `src/repo-search/engine/repo-tools.ts` unless a RED test proves another file must change.
- Keep temporary and mutation-check artifacts in one scratch directory and remove them before completion.
- Do not create a worktree.
- If implementation occurs in a later session under the repository's repo-agent policy, dispatch exactly one sequential `siftkit repo-agent` run per task and independently review its JSON status, diff, tests, typecheck, banned patterns, and cleanup. Do not dispatch during a session where the user has disabled SiftKit.

---

### Task 1: Replace all positive-integer coercion with strict schema validation

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:1-210, 415-430, 540-620, 660-715, 817-845`
- Modify: `tests/repo-tools.test.ts:1-85, 430-455, 785-805`

**Interfaces:**
- Produces: `PositiveIntegerSchema`, the only runtime source for positive integers in repo tools.
- Produces: `PositiveInteger = z.infer<typeof PositiveIntegerSchema>`.
- Produces: `parsePositiveInteger`, `resolvePositiveInteger`, and `resolveOptionalPositiveInteger` as explicit local functions.
- Changes: `buildReadCommand` formats normalized `offset` and `limit` values without clamping or truncating.
- Changes: `buildGrepArgs` consumes a validated optional context value instead of parsing `args.context`.
- Preserves: existing field-specific failure strings from the approved design.

- [ ] **Step 1: Add the failing end-to-end validation table**

Add the existing `JsonObject` type as a named type import in `tests/repo-tools.test.ts`, then add:

```ts
test('repo tools reject present positive-integer arguments instead of coercing them', async () => {
  const root = makeRepo();
  const invalidCases: Array<{ toolName: string; args: JsonObject; expectedReason: string }> = [
    {
      toolName: 'read',
      args: { path: 'src/a.ts', offset: 1.5 },
      expectedReason: 'offset must be a positive integer',
    },
    {
      toolName: 'read',
      args: { path: 'src/a.ts', limit: '2' },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'grep',
      args: { pattern: 'alpha', context: 1.5 },
      expectedReason: 'context must be a positive integer',
    },
    {
      toolName: 'grep',
      args: { pattern: 'alpha', context: null },
      expectedReason: 'context must be a positive integer',
    },
    {
      toolName: 'grep',
      args: { pattern: 'alpha', limit: '2' },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'find',
      args: { pattern: '**/*.ts', limit: 1.5 },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'ls',
      args: { limit: '2' },
      expectedReason: 'limit must be a positive integer',
    },
    {
      toolName: 'run',
      args: { command: 'throw "must not execute"', timeout: 1.5 },
      expectedReason: 'timeout must be a positive integer (seconds)',
    },
  ];

  for (const invalidCase of invalidCases) {
    const result = await executeRepoTool(invalidCase.toolName, invalidCase.args, makeContext(root));
    assert.equal(result.ok, false, `${invalidCase.toolName} accepted ${JSON.stringify(invalidCase.args)}`);
    assert.equal(result.ok === false ? result.reason : '', invalidCase.expectedReason);
  }
});
```

This test catches reintroduction of `Number()` or `Math.trunc()` coercion. Existing tests already cover omitted defaults, valid integers, and non-positive limits.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx tsx --test --test-name-pattern "reject present positive-integer arguments" .\tests\repo-tools.test.ts
```

Expected: FAIL for every table row. The current code truncates fractions and accepts numeric strings; the run case executes instead of returning the timeout validation failure.

- [ ] **Step 3: Add the shared runtime schema and explicit resolvers**

Add the named Zod import and replace `readPositiveInteger`, `optionalPositive`, and `resolveLimit` with:

```ts
import { z } from 'zod';

const PositiveIntegerSchema = z.number().int().positive().finite();
type PositiveInteger = z.infer<typeof PositiveIntegerSchema>;

function parsePositiveInteger(value: OptionalJsonValue): PositiveInteger | undefined {
  const parsed = PositiveIntegerSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function resolvePositiveInteger(
  value: OptionalJsonValue,
  fallback: PositiveInteger,
  reason: string,
): PositiveInteger | string {
  if (value === undefined) {
    return fallback;
  }
  return parsePositiveInteger(value) ?? reason;
}

function resolveOptionalPositiveInteger(
  value: OptionalJsonValue,
  reason: string,
): PositiveInteger | undefined | string {
  if (value === undefined) {
    return undefined;
  }
  return parsePositiveInteger(value) ?? reason;
}
```

Only `undefined` means absent. A present `null` is invalid and follows the field-specific failure path.

- [ ] **Step 4: Remove coercion from command builders**

Replace `buildReadCommand` with:

```ts
export function buildReadCommand(pathText: string, offset: PositiveInteger, limit?: PositiveInteger): string {
  return formatToolCommand('read', [
    ['path', pathText],
    ['offset', offset],
    ['limit', limit],
  ]);
}
```

In `buildRepoToolRequestedCommand`, use `parsePositiveInteger` for displayed optional values and default only an absent/invalid read offset for diagnostic formatting:

```ts
if (toolName === 'read') {
  return buildReadCommand(
    readString(args.path),
    parsePositiveInteger(args.offset) ?? 1,
    parsePositiveInteger(args.limit),
  );
}
```

Replace every remaining `optionalPositive(...)` in the command formatter with `parsePositiveInteger(...)`. This ensures command identity never truncates a fraction or converts a numeric string.

- [ ] **Step 5: Validate `read.offset` and `read.limit` before reading**

At the start of `planRead`, use the common command formatter and explicit validation:

```ts
const commandPath = readString(args.path);
const requestedCommand = buildRepoToolRequestedCommand('read', args);
const offset = resolvePositiveInteger(args.offset, 1, 'offset must be a positive integer');
if (typeof offset === 'string') {
  return { ok: false, command: requestedCommand, reason: offset };
}
const limit = resolveOptionalPositiveInteger(args.limit, 'limit must be a positive integer');
if (typeof limit === 'string') {
  return { ok: false, command: requestedCommand, reason: limit };
}
```

Keep the remainder of `planRead` unchanged. Its `offset` and `limit` variables are now inferred numbers from the runtime schema.

- [ ] **Step 6: Validate grep context and limits before spawning ripgrep**

Change the builder signature and context block:

```ts
function buildGrepArgs(
  args: JsonObject,
  ignorePolicy: IgnorePolicy,
  searchPath: string,
  contextLines: PositiveInteger | undefined,
): string[] {
  const argv = ['--no-ignore', '--line-number', '--with-filename', '--color', 'never'];
  argv.push(readBoolean(args.ignoreCase, true) ? '--ignore-case' : '--case-sensitive');
  if (readBoolean(args.literal, false)) {
    argv.push('--fixed-strings');
  }
  if (contextLines !== undefined) {
    argv.push('--context', String(contextLines));
  }
```

In `executeGrep`, resolve both arguments before process execution:

```ts
const contextLines = resolveOptionalPositiveInteger(
  args.context,
  'context must be a positive integer',
);
if (typeof contextLines === 'string') {
  return failure('grep', command, contextLines);
}
const limit = resolvePositiveInteger(
  args.limit,
  GREP_DEFAULT_LIMIT,
  'limit must be a positive integer',
);
if (typeof limit === 'string') {
  return failure('grep', command, limit);
}
```

Pass `contextLines` as the fourth argument to `buildGrepArgs`.

- [ ] **Step 7: Validate find, ls, and run through the same resolvers**

Replace `resolveLimit` in `executeFind` with:

```ts
const limit = resolvePositiveInteger(
  args.limit,
  FIND_DEFAULT_LIMIT,
  'limit must be a positive integer',
);
```

Replace it in `executeLs` with:

```ts
const limit = resolvePositiveInteger(
  args.limit,
  LS_DEFAULT_LIMIT,
  'limit must be a positive integer',
);
```

Preserve each existing `typeof limit === 'string'` failure branch.

Replace the timeout parsing block in `executeRun` with:

```ts
const timeoutSeconds = resolveOptionalPositiveInteger(
  args.timeout,
  'timeout must be a positive integer (seconds)',
);
if (typeof timeoutSeconds === 'string') {
  return failure('run', command, timeoutSeconds);
}
```

Keep `timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000` unchanged.

- [ ] **Step 8: Remove the obsolete builder compatibility assertion**

Rename the builder test to `buildReadCommand serializes normalized offset and optional limit`, then replace:

```ts
assert.equal(buildReadCommand('src/a.ts', 0), 'read path="src/a.ts" offset=1');
```

with a valid normalized-input assertion:

```ts
assert.equal(buildReadCommand('src/a.ts', 1), 'read path="src/a.ts" offset=1');
```

Do not retain a wrapper or overload accepting invalid numbers.

- [ ] **Step 9: Verify GREEN and regressions**

Run:

```powershell
npx tsx --test --test-name-pattern "positive-integer|non-positive limit|omitted limit|includes timeout" .\tests\repo-tools.test.ts
npx tsx --test .\tests\repo-tools.test.ts
npm run typecheck
```

Expected: all focused tests pass; the complete repo-tools suite passes; typecheck and lint exit 0. Search the changed files and confirm there is no positive-integer `Number()` or `Math.trunc()` path left in `repo-tools.ts`.

- [ ] **Step 10: Commit**

```powershell
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: validate repo-tool positive integers without coercion"
```

---

### Task 2: Truncate grep output at context-group boundaries

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:569-592`
- Modify: `tests/repo-tools.test.ts:245-275`

**Interfaces:**
- Consumes: strict positive `limit` from Task 1.
- Preserves: `truncateGrepOutput(outputLines: string[], limit: number): string`.
- Produces: output containing complete retained match groups and no leading context from a detached omitted group.

- [ ] **Step 1: Add a failing separated-group integration test**

Add:

```ts
test('grep limit removes the detached context group of the first omitted match', async () => {
  const root = makeRepo();
  fs.writeFileSync(
    path.join(root, 'separated.txt'),
    [
      'before first',
      'needle first',
      'after first',
      'gap one',
      'gap two',
      'before second',
      'needle second',
      'after second',
    ].join('\n'),
    'utf8',
  );

  const result = await executeRepoTool(
    'grep',
    { pattern: 'needle', path: 'separated.txt', context: 1, limit: 1 },
    makeContext(root),
  );

  assert.ok(result.ok);
  assert.match(result.output, /needle first/u);
  assert.match(result.output, /after first/u);
  assert.doesNotMatch(result.output, /\n--\n/u);
  assert.doesNotMatch(result.output, /before second/u);
  assert.doesNotMatch(result.output, /needle second/u);
  assert.match(result.output, /1 more matches beyond limit=1/u);
});
```

In the existing `grep limit counts matches, not context lines` test, also assert:

```ts
assert.ok(result.output.includes('pad5'), `shared trailing context was removed: ${result.output}`);
```

This protects the no-separator branch: `pad5` is valid trailing context for the fifth retained match even though it also precedes the sixth omitted match.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx tsx --test --test-name-pattern "grep limit (removes|counts)" .\tests\repo-tools.test.ts
```

Expected: the new test fails because current output contains `--` and `before second`; the overlapping-group assertion passes.

- [ ] **Step 3: Make the truncation boundary group-aware**

Replace `truncateGrepOutput` with:

```ts
function truncateGrepOutput(outputLines: string[], limit: number): string {
  let totalMatches = 0;
  let lastRetainedMatchIndex = -1;
  let cutIndex = -1;
  for (let index = 0; index < outputLines.length; index += 1) {
    if (!GREP_MATCH_LINE_PATTERN.test(outputLines[index])) {
      continue;
    }
    totalMatches += 1;
    if (totalMatches <= limit) {
      lastRetainedMatchIndex = index;
      continue;
    }
    if (cutIndex === -1) {
      const separatorIndex = outputLines.lastIndexOf('--', index - 1);
      cutIndex = separatorIndex > lastRetainedMatchIndex ? separatorIndex : index;
    }
  }
  if (cutIndex === -1) {
    return outputLines.join('\n');
  }
  return `${outputLines.slice(0, cutIndex).join('\n')}\n... ${totalMatches - limit} more matches beyond limit=${limit}; narrow the pattern, glob, or path.`;
}
```

Do not add a second parser, class, or `rg --json` path.

- [ ] **Step 4: Verify GREEN and regressions**

Run:

```powershell
npx tsx --test --test-name-pattern "grep limit (removes|counts)" .\tests\repo-tools.test.ts
npx tsx --test .\tests\repo-tools.test.ts
npm run typecheck
```

Expected: both grep-limit branches pass; the complete repo-tools suite and typecheck pass.

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/repo-tools.ts tests/repo-tools.test.ts
git commit -m "fix: truncate grep context at match-group boundaries"
```

---

### Task 3: Prove root-relative grep ignore paths

**Files:**
- Modify: `tests/repo-tools.test.ts:290-315`
- Mutation-check only, restored before commit: `src/repo-search/engine/repo-tools.ts:562-564`

**Interfaces:**
- Consumes: the existing `ignorePolicy.paths` loop in `buildGrepArgs`.
- Produces: real ripgrep coverage for exact ignored entries, ignored descendants, and case-insensitive root-relative matching.
- Preserves: production behavior unless the restored implementation fails the new test.

- [ ] **Step 1: Add the ignored-path integration test**

Add:

```ts
test('grep excludes ignored root-relative paths as exact files and case-insensitive descendants', async () => {
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'tmp-find'), 'alpha exact ignored path\n', 'utf8');
  fs.mkdirSync(path.join(root, 'Eval', 'Results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Eval', 'Results', 'leak.ts'), 'alpha ignored descendant\n', 'utf8');

  const result = await executeRepoTool('grep', { pattern: 'alpha' }, makeContext(root));

  assert.ok(result.ok);
  assert.match(result.output, /src[\\/]a\.ts/u);
  assert.ok(!result.output.includes('tmp-find'), `exact ignored path leaked: ${result.output}`);
  assert.ok(!result.output.includes('leak.ts'), `case-variant ignored descendant leaked: ${result.output}`);
});
```

- [ ] **Step 2: Run the focused test against the restored implementation**

Run:

```powershell
npx tsx --test --test-name-pattern "ignored root-relative paths" .\tests\repo-tools.test.ts
```

Expected: PASS because Task 16 already implemented both exclusion forms. This is a coverage-only task, so the next two mutation steps prove that the test detects each regression.

- [ ] **Step 3: Mutation-check the ignored-path branch**

Temporarily remove the entire `ignorePolicy.paths` loop:

```ts
// Mutation check only: the ignorePolicy.paths loop is intentionally absent.
```

Run the focused test again.

Expected: FAIL with `exact ignored path leaked` and/or `case-variant ignored descendant leaked`. Restore the original two-glob loop immediately:

```ts
for (const ignoredPath of ignorePolicy.paths) {
  argv.push('--iglob', `!${ignoredPath}`, '--iglob', `!${ignoredPath}/**`);
}
```

- [ ] **Step 4: Verify the restored implementation and clean diff**

Run:

```powershell
npx tsx --test --test-name-pattern "ignored root-relative paths" .\tests\repo-tools.test.ts
npx tsx --test .\tests\repo-tools.test.ts
npm run typecheck
git diff -- src/repo-search/engine/repo-tools.ts
```

Expected: tests and typecheck pass; `git diff -- src/repo-search/engine/repo-tools.ts` is empty for this task. Only the test file remains modified.

- [ ] **Step 5: Commit**

```powershell
git add tests/repo-tools.test.ts
git commit -m "test: cover grep root-relative ignore paths"
```

---

### Task 4: Full verification and cleanup

**Files:**
- No planned source changes.
- Remove: task-owned scratch directory and all temporary mutation artifacts.

**Interfaces:**
- Consumes: commits from Tasks 1-3.
- Produces: final evidence for type safety, complete tests, coverage, build, and the original globstar live behavior.

- [ ] **Step 1: Verify the focused repo-tool suite**

Run:

```powershell
npx tsx --test .\tests\repo-tools.test.ts
```

Expected: all tests pass with 0 failures and no warnings.

- [ ] **Step 2: Verify typecheck and lint**

Run:

```powershell
npm run typecheck
```

Expected: all TypeScript projects and ESLint exit 0. Explicitly scan the Task 1 diff for casts, `any`, non-null assertions, namespace imports, dynamic function passing, compatibility paths, and duplicate numeric parsing.

- [ ] **Step 3: Verify coverage**

Run the project coverage gate:

```powershell
npm run test:coverage
```

Then run focused coverage for the changed production file:

```powershell
npx c8 --include="src/repo-search/engine/repo-tools.ts" --reporter=text --reporter=text-summary npx tsx --test .\tests\repo-tools.test.ts
```

Expected: both commands exit 0. Confirm the new branches are all exercised:

- positive-integer argument absent, valid, and invalid;
- grep truncation with no overflow, same-group overflow, and separated-group overflow;
- ignored root-relative exact entry and case-insensitive descendant.

- [ ] **Step 4: Verify the complete suite**

Run:

```powershell
npm test
```

Expected: 0 failures. If `tests/package-artifact.test.ts` receives a sandbox-only npm-cache `EPERM`, rerun the same command with approved npm-cache access; do not classify that environmental failure as green without the successful rerun.

- [ ] **Step 5: Build**

Run:

```powershell
npm run build
```

Expected: all package, TypeScript, dashboard, and runtime-sync build stages exit 0.

- [ ] **Step 6: Run the original live globstar smoke when allowed**

If the execution session permits SiftKit and the status server is available, run:

```powershell
siftkit repo-search --prompt "Run find with pattern **/package.json limited to 5 results and report the exact paths returned, verbatim."
```

Expected: `package.json` appears with nested package files. If the current session still has an explicit no-SiftKit override, record the smoke as deferred rather than violating the override; the focused and full automated tests remain mandatory.

- [ ] **Step 7: Clean task-owned artifacts and verify repository state**

Remove only the exact scratch directory created for this plan. Then run:

```powershell
git status --short
git diff --check
git log --oneline -4
```

Expected: no scratch artifacts, no unstaged source changes, no whitespace errors, and three implementation commits following the design commit.

- [ ] **Step 8: Commit only if verification required a tracked correction**

Normally skip this step. If a tracked expectation or test fixture required a legitimate correction discovered by the full gate, follow TDD for that correction, rerun its covering test and the full gate, then commit only the affected files:

```powershell
git commit -m "test: finalize repo-tool drift fix coverage"
```

Do not use `git add -A`; scratch or unrelated user files must never enter the commit.
