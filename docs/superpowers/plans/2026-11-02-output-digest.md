# Output Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SiftKit recognises the console output of 12 test runners, type checkers and compilers. It turns that output into a digest: each tool's verdict, then every failure with its `file:line` and message. The digest leads the worker's `run` results, the orchestrator's check output, and `siftkit summary`'s pass/fail answers.

**Architecture:**
- `src/output-digest/` holds one pure parser module per tool, `parse<Tool>(lines): ToolDigest | null`.
  - `digest.ts` calls every parser explicitly, in a fixed order, and renders their digests.
  - There is no registry.
- Each consumer computes the digest from the **whole** output before cutting anything, then shows it ahead of the raw tail it already shows. Output no parser recognises behaves exactly as today.
- Spec: `docs/superpowers/specs/2026-11-02-output-digest-design.md`.

**Tech Stack:** TypeScript (Node ≥ 26, `node:test`), Zod contracts in `packages/contracts`, SQLite runtime DB with explicit schema upgrades, React dashboard (vitest).

**Rules for every task:**
- TDD: a failing test, then the minimum code, then a passing test.
- Do not commit.
- No `any`, type assertions or non-null assertions.
- Comments stay at 1–2 lines.
- No shims or compatibility paths.
- Do not create temporary files.
- Copy every code block exactly. All parser code and every expected digest below were run against the real fixtures before this plan was written: 39 tests passed and `tsc` reported no errors under the repo's compiler options.

**Commands used below**
- One test file: `node .\src\test-runner\run-tests.ts tests\<file>.test.ts`
- Process (e2e) file: `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts`
- Dashboard: `npm run test:dashboard`
- Gates: `npm run typecheck`, `npm run lint`, `npm test`

## Design decisions (owned by the primary agent)

1. **One headline format for every tool:** `<tool>: passed|FAILED (<value> <label>, …)`, with the counts in the order the tool prints them, for example `pytest: FAILED (2 failed, 1 passed)`. The spec's example headlines were illustrative. One generic format keeps rendering in one function.
2. **Failure names.**
   - For a test, the name is the test's name.
   - For a diagnostic, the name is `<code>: <message>` (tsc, MSBuild, rustc) or the message itself (mypy, pyright, eslint, which adds its rule in parentheses).
   - Diagnostics carry no detail lines, except pyright's indented explanation.
3. **Tighter markers than the spec's table**, each checked against the fixtures:
   - **mypy** needs its closing `Found N errors…`/`Success: no issues found…` line, so a compiler's `file:line: error:` lines are not read as mypy.
   - **MSBuild** reads only coded diagnostics (`CS0029`, `MSB3073`, `NU1101`). `dotnet test`'s `TESTERROR` lines are test failures, which the dotnet test parser reads. A `dotnet test` run under the terminal logger therefore also yields `msbuild: passed (0 errors, 0 warnings)` for its build. That is true, and the fixture test pins it.
4. **The `run` tool.**
   - When the result fits, it is `digest + "\n" + result`.
   - Otherwise, the digest is fitted from its head into half the result budget by the existing `ToolOutputFitter`, which, when it cuts, targets half of the budget it is given. That fitted digest is the header of the usual tail fit.
5. **Orchestrator.** `runVerificationCheck` digests the full output before the 20,000-character cut. `renderCheckOutput(result, tailChars)` is the one renderer for all four sites. The final-verification rejection is a finish rejection that the scripted e2e engine does not expose, so that site is covered by the shared renderer's unit test and by code review, not by its own e2e assertion.
6. **Upgrade 89 → 90.**
   - It parses every stored attempt before it writes any row.
   - It throws naming the run whose attempt does not parse.
   - The whole upgrade chain already runs in one transaction.
7. **`siftkit summary`** keeps its `PASS: `/`FAIL: ` prefix, followed by the rendered digest. FAIL when any digest failed or the exit code is a non-zero number.
8. **`run` guidance.** The prompt drops the interim `| Select-String '^(✖|ℹ)'` advice: filtering would hand the parsers a fragment of the output.
9. **Validation shaping is a cut site the spec missed.** For a repo-agent, `ValidationCommandOutputPolicy` cuts every test, build, lint and typecheck command's output to its last 50 lines **before** the budgeter sees it. Its only test awareness is a node-only rule that reserves `ℹ` and `✖ failing tests:` lines.
   - The digest is therefore computed in the processor from the raw execution output, before `applyRunOutput`, and carried on the execution as `digest`.
   - The policy becomes a plain last-50-lines tail, and its summary-line reservation and gap markers are deleted: the digest supersedes them, for every tool.
   - Output no parser recognises keeps the plain tail, which is what it got before; the reservation only ever matched node:test lines.
10. **Interim work removed:**
   - the `TEST_RESULT_LINE` header in the budgeter;
   - `tests/node-test-failures.test.ts`, which imports a module that was never written;
   - the three red tests appended to `tests/engine-tool-result-budgeter.test.ts`.

## File map

| File | Change |
|---|---|
| `src/output-digest/types.ts` | new: `DigestTool`, `DigestCount`, `DigestFailure`, `ToolDigest` |
| `src/output-digest/lines.ts` | new: shared line helpers (terminal-code stripping, dedent, stack-frame location, count pairs, first/last match, unique failures) |
| `src/output-digest/digest.ts` | new: `digestToolOutput`, `renderDigests`, `DIGEST_HEADING` |
| `src/output-digest/{node-test,vitest,jest,pytest,dotnet-test,msbuild,go-test,cargo-test,tsc,mypy,pyright,eslint}.ts` | new: one parser each |
| `tests/fixtures/output-digest/**` | new: 33 captured outputs + `README.md` |
| `tests/helpers/output-digest-fixtures.ts` | new: `digestFixturePath`, `readDigestFixture`, `listDigestFixtures` |
| `tests/output-digest-parsers.test.ts`, `tests/output-digest-render.test.ts` | new |
| `src/repo-search/engine/tool-result-budgeter.ts` | `fit` takes `digest`; interim header removed |
| `src/repo-search/engine/tool-action-processor.ts` | digests raw `run` output before validation shaping; passes it to the budgeter |
| `src/repo-search/engine/repo-tools.ts` | `RepoToolExecution` gains `digest` |
| `src/repo-search/engine/validation-command-output-policy.ts` | plain last-50-lines tail; node summary-line reservation deleted |
| `src/repo-search/prompts.ts`, `src/repo-search/repo-tool-arguments.ts` | `run` guidance and `outputMode` description mention the digest |
| `packages/contracts/src/orchestrator.ts` | `OrchestratorCheckResultSchema.digest` |
| `src/orchestrator/verification.ts` | digest in `runVerificationCheck`/`unexecutedCheck`; `renderCheckOutput` |
| `src/orchestrator/{handoff,submission,run}.ts` | the four output sites use `renderCheckOutput` |
| `src/state/schema-upgrades/orchestrator-check-digests.ts`, `src/state/runtime-db.ts` | upgrade 89 → 90 |
| `src/summary/request-runner.ts` | deterministic path uses the digest |
| `src/summary/test-output.ts`, `tests/node-test-failures.test.ts` | deleted |

---

### Task 1: Remove the interim run-tool digest attempt

**Files:**
- Delete: `tests/node-test-failures.test.ts`
- Modify: `tests/engine-tool-result-budgeter.test.ts` (delete from line 115 to the end)

- [ ] **Step 1: Delete the test of the module that was never written**

Run: `Remove-Item tests\node-test-failures.test.ts`

- [ ] **Step 2: Delete the three appended budgeter tests**

The file ends with the test `'failed output tail is clamped by the remaining allowance when it is smaller'`, whose closing `});` is line 114. Delete everything after it:
- the blank lines;
- the `failingTestOutput` helper (its comment starts `/** A failing node:test run: noisy progress…`);
- the tests `'a failed node:test run leads with its failure digest…'`, `'a successful command and a failed command with no failing-tests section keep only their tail'` and `'a digest too long for half the failed-command cap…'`.

The file then ends with:

```ts
  assert.ok(fitted.resultTokenCount <= 20);
  assert.match(fitted.resultText, /lines truncated due to per-tool context limit\./u);
});
```

followed by one newline.

- [ ] **Step 3: Verify the tree is green**

Run: `node .\src\test-runner\run-tests.ts tests\engine-tool-result-budgeter.test.ts`
Expected: PASS, 6 tests.
Run: `npm run typecheck`
Expected: exit 0. It failed before this task, because the deleted test imported a missing module.

---

### Task 2: Captured fixtures and their reader

**Files:**
- Create: `tests/fixtures/output-digest/**` (copied from the capture scratch directory)
- Create: `tests/helpers/output-digest-fixtures.ts`

- [ ] **Step 1: Copy the captured outputs**

Run: `Copy-Item -Recurse C:\tmp\rsx\output-digest-capture\proto\tests\fixtures\output-digest tests\fixtures\output-digest`
Run: `(Get-ChildItem tests\fixtures\output-digest -Recurse -File).Count`
Expected: `34` (33 captured outputs and `README.md`).

Do not edit the files. Some hold CRLF line endings, ANSI colour codes and OSC sequences exactly as the tools printed them. `.gitattributes` (`* text=auto eol=lf`) normalises line endings at commit, and the parsers read both forms. `README.md` must read:

```markdown
# Output digest fixtures

Real console output, captured on Windows 11 from small scratch projects on 2026-11-02, one directory per parser in `src/output-digest/`. `tests/output-digest-parsers.test.ts` checks each file's exact digest. Paths inside the files are the capture machine's paths; keep them, since parsers report locations as the tool printed them.

| Directory | Tool and version | Cases |
|---|---|---|
| `node-test` | Node.js v26.7.0 `node --test`, spec reporter | `pass`; `fail` (assertion diff, thrown error, subtest, file that fails to load); `bad-path` (a directory passed as a test file); `noisy-e2e-fail` (a SiftKit orchestrator e2e run with server logs between results) |
| `vitest` | vitest 4.1.11 | `pass`, `fail` |
| `jest` | jest 30.5.2 (ANSI colour codes kept) | `pass`, `fail` |
| `pytest` | pytest 9.1.1 on Python 3.14.7 | `pass`, `fail`, `collection-error` |
| `dotnet-test` | .NET SDK 10.0.301 `dotnet test`, xUnit adapter 3.1.4 | `pass`, `fail` (classic logger), `fail-terminal-logger` (`--tl:on`) |
| `msbuild` | .NET SDK 10.0.301 `dotnet build` | `pass`, `fail` (classic logger), `fail-terminal-logger` (ANSI and OSC codes kept) |
| `go-test` | go 1.27.3 `go test ./...` | `pass`, `pass-verbose`, `fail`, `fail-verbose`, `build-error` |
| `cargo-test` | cargo and rustc 1.99.0 `cargo test` | `pass`, `fail`, `compile-error` |
| `tsc` | TypeScript 5.9.3 | `fail` (`--pretty false`), `fail-pretty` |
| `mypy` | mypy 2.4.1 | `pass`, `fail` |
| `pyright` | pyright 1.1.414 | `pass`, `fail` |
| `eslint` | ESLint 9.39.4, stylish formatter | `fail`, `warn-only` (a passing eslint or tsc run prints nothing, so there is no pass file) |
```

- [ ] **Step 2: Write the fixture reader**

Create `tests/helpers/output-digest-fixtures.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE_ROOT = path.join(process.cwd(), 'tests', 'fixtures', 'output-digest');

/** The absolute path of one captured console output, named `<tool>/<case>.txt`. */
export function digestFixturePath(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}

export function readDigestFixture(name: string): string {
  return fs.readFileSync(digestFixturePath(name), 'utf8');
}

/** Every captured output as `<tool>/<case>.txt`, sorted; the README beside them is not one. */
export function listDigestFixtures(): string[] {
  return fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(FIXTURE_ROOT, entry.name)).map((file) => `${entry.name}/${file}`))
    .sort();
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: exit 0.

---

### Task 3: Digest core and the JavaScript test runners (node:test, vitest, jest)

**Files:**
- Create: `src/output-digest/types.ts`, `src/output-digest/lines.ts`, `src/output-digest/digest.ts`
- Create: `src/output-digest/node-test.ts`, `src/output-digest/vitest.ts`, `src/output-digest/jest.ts`
- Test: `tests/output-digest-render.test.ts`, `tests/output-digest-parsers.test.ts`

- [ ] **Step 1: Write the failing render test**

Create `tests/output-digest-render.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { digestToolOutput, renderDigests } from '../src/output-digest/digest.ts';
import type { ToolDigest } from '../src/output-digest/types.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';

const PYTEST: ToolDigest = { tool: 'pytest', failed: true, counts: [{ label: 'failed', value: 2 }, { label: 'passed', value: 1 }], failures: [
  { name: 'test_compares_lists', location: 'test_math.py:4', message: ['AssertionError: assert 1 == 2', '  Use -v to get more diff'] },
  { name: 'test_imports', location: null, message: [] },
] };
const ESLINT: ToolDigest = { tool: 'eslint', failed: true, counts: [{ label: 'errors', value: 1 }, { label: 'warnings', value: 0 }], failures: [
  { name: "'x' is not defined (no-undef)", location: 'src/a.js:3:29', message: [] },
] };

test('a passing tool renders as its verdict and counts on one line', () => {
  assert.equal(renderDigests(digestToolOutput(readDigestFixture('node-test/pass.txt'))),
    'Digest of the whole output:\nnode:test: passed (5 tests, 4 pass, 0 fail, 0 cancelled, 1 skipped, 0 todo)');
});

test('every failure of every tool is listed with its location before any details', () => {
  assert.equal(renderDigests([PYTEST, ESLINT]), [
    'Digest of the whole output:',
    'pytest: FAILED (2 failed, 1 passed)',
    '✖ test_compares_lists — test_math.py:4',
    '✖ test_imports',
    'eslint: FAILED (1 errors, 0 warnings)',
    "✖ 'x' is not defined (no-undef) — src/a.js:3:29",
    'Details:',
    '✖ test_compares_lists',
    '  AssertionError: assert 1 == 2',
    '    Use -v to get more diff',
  ].join('\n'));
});

test('a failure message is capped at 12 lines and says how many it left out', () => {
  const message = Array.from({ length: 40 }, (unused, index) => `diff line ${index}`);
  const rendered = renderDigests([{ ...PYTEST, failures: [{ name: 'big diff', location: 'x.py:1', message }] }]) ?? '';
  const details = rendered.split('\nDetails:\n')[1]?.split('\n') ?? [];
  assert.deepEqual(details, ['✖ big diff', ...message.slice(0, 12).map((line) => `  ${line}`), '  … 28 more lines']);
});

test('output no parser recognises has no digest', () => {
  assert.deepEqual(digestToolOutput('Compiling 3 files...\nerror: something odd happened\nDone in 2.1s.'), []);
  assert.equal(renderDigests([]), null);
});
```

- [ ] **Step 2: Write the failing parser test**

Create `tests/output-digest-parsers.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { digestToolOutput } from '../src/output-digest/digest.ts';
import type { DigestTool, ToolDigest } from '../src/output-digest/types.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';

type FailureRow = readonly [name: string, location: string | null, message: readonly string[]];

function digest(tool: DigestTool, failed: boolean, counts: readonly (readonly [string, number])[], failures: readonly FailureRow[]): ToolDigest {
  return {
    tool, failed,
    counts: counts.map(([label, value]) => ({ label, value })),
    failures: failures.map(([name, location, message]) => ({ name, location, message: [...message] })),
  };
}

/** Each captured fixture's exact digests: one per tool whose output it holds, in `digestToolOutput` order. */
const EXPECTED: Record<string, ToolDigest[]> = {
  'node-test/bad-path.txt': [
    digest('node:test', true, [['tests', 1], ['pass', 0], ['fail', 1], ['cancelled', 0], ['skipped', 0], ['todo', 0]], [
      ['fail', 'fail:1:1', ["Error: Cannot find module 'C:\\tmp\\rsx\\output-digest-capture\\node\\fail'"]],
    ]),
  ],
  'node-test/fail.txt': [
    digest('node:test', true, [['tests', 7], ['pass', 2], ['fail', 5], ['cancelled', 0], ['skipped', 0], ['todo', 0]], [
      ['fail\\load.test.mjs', 'C:/tmp/rsx/output-digest-capture/node/fail/load.test.mjs:1', ["SyntaxError: The requested module './nothing-here.mjs' does not provide an export named 'missing'"]],
      ['compares arrays', 'C:/tmp/rsx/output-digest-capture/node/fail/math.test.mjs:4:40', ['AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:', '+ actual - expected', '  [', "    'model-a',", "    'model-b',", "+   'model-a'", '  ]']],
      ['counts attempts', 'C:/tmp/rsx/output-digest-capture/node/fail/math.test.mjs:5:40', ['AssertionError [ERR_ASSERTION]: the refused dispatch started no child', '1 !== 2']],
      ['inner throws', 'C:/tmp/rsx/output-digest-capture/node/fail/math.test.mjs:8:46', ["TypeError: Cannot read properties of undefined (reading 'runId')"]],
    ]),
  ],
  'node-test/noisy-e2e-fail.txt': [
    digest('node:test', true, [['tests', 25], ['pass', 23], ['fail', 2], ['cancelled', 0], ['skipped', 0], ['todo', 0]], [
      ['one conversation plans, dispatches a writer, reviews it, and finishes; the parent releases its model while the child works', 'C:/Users/denys/Documents/GitHub/SiftKit/tests/process/zz-fit-demo.e2e.test.ts:188:12', ['AssertionError [ERR_ASSERTION]: the parent on A, its child on B, then the parent resumes on A', '+ actual - expected', '  [', "    'model-a',", "    'model-b',", "+   'model-a'", '  ]']],
      ['while a child awaits a decision, code refuses a check, a second dispatch, and a plan change, and decide resumes it', 'C:/Users/denys/Documents/GitHub/SiftKit/tests/process/zz-fit-demo.e2e.test.ts:459:10', ['AssertionError [ERR_ASSERTION]: the refused dispatch started no child', '1 !== 2']],
    ]),
  ],
  'node-test/pass.txt': [
    digest('node:test', false, [['tests', 5], ['pass', 4], ['fail', 0], ['cancelled', 0], ['skipped', 1], ['todo', 0]], []),
  ],
  'vitest/fail.txt': [
    digest('vitest', true, [['tests', 4], ['failed', 3], ['passed', 1]], [
      ['broken.test.ts > never runs', 'broken.test.ts:3:24', ['TypeError: missing is not a function']],
      ['math.test.ts > math > compares arrays', 'math.test.ts:4:75', ["AssertionError: expected [ 'model-a', 'model-b', 'model-a' ] to deeply equal [ 'model-a', 'model-b' ]", '- Expected', '+ Received', '  [', '    "model-a",', '    "model-b",', '+   "model-a",', '  ]']],
      ['math.test.ts > math > throws', 'math.test.ts:5:30', ["TypeError: Cannot read properties of undefined (reading 'runId')"]],
    ]),
  ],
  'vitest/pass.txt': [
    digest('vitest', false, [['tests', 3], ['passed', 2], ['skipped', 1]], []),
  ],
  'jest/fail.txt': [
    digest('jest', true, [['tests', 4], ['failed', 3], ['passed', 1]], [
      ['math › compares arrays', 'math.test.js:3:77', ['expect(received).toEqual(expected) // deep equality', '- Expected  - 0', '+ Received  + 1', '  Array [', '    "model-a",', '    "model-b",', '+   "model-a",', '  ]']],
      ['math › throws', 'math.test.js:4:32', ["TypeError: Cannot read properties of undefined (reading 'runId')"]],
      ['never runs', 'broken.test.js:2:26', ['TypeError: missing is not a function']],
    ]),
  ],
  'jest/pass.txt': [
    digest('jest', false, [['tests', 3], ['skipped', 1], ['passed', 2]], []),
  ],
};

for (const [fixture, expected] of Object.entries(EXPECTED)) {
  test(`${fixture} digests to exactly its tools, counts and failures`, () => {
    assert.deepEqual(digestToolOutput(readDigestFixture(fixture)), expected);
  });
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-render.test.ts tests\output-digest-parsers.test.ts`
Expected: FAIL. `Cannot find module …/src/output-digest/digest.ts`.

- [ ] **Step 4: Write the shared types**

Create `src/output-digest/types.ts`:

```ts
export type DigestTool = 'node:test' | 'vitest' | 'jest' | 'pytest' | 'dotnet test' | 'go test' | 'cargo test'
  | 'tsc' | 'mypy' | 'pyright' | 'msbuild' | 'eslint';
export type DigestCount = { label: string; value: number };
/** One failing test or error diagnostic; `location` is `path:line[:col]` as the tool prints the path. */
export type DigestFailure = { name: string; location: string | null; message: string[] };
export type ToolDigest = { tool: DigestTool; counts: DigestCount[]; failed: boolean; failures: DigestFailure[] };
```

- [ ] **Step 5: Write the shared line helpers**

Create `src/output-digest/lines.ts`:

```ts
import type { DigestCount, DigestFailure } from './types.ts';

// CSI colour codes and OSC sequences (MSBuild's progress and hyperlink codes) end with BEL or ESC \.
const TERMINAL_CODE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]/gu;
const STACK_FRAME = /^\s*at (?:.+ \()?(?:file:\/\/\/)?(.+?:\d+:\d+)\)?(?: \{)?$/u;
const COUNT_PAIR = /(\d+) ([a-z]+)/gu;

export function stripTerminalCodes(text: string): string {
  return text.replace(TERMINAL_CODE, '');
}

/** Drops blank lines and the indentation every remaining line shares. */
export function dedent(lines: readonly string[]): string[] {
  const kept = lines.filter((line) => line.trim().length > 0);
  const indent = Math.min(...kept.map((line) => line.length - line.trimStart().length));
  return kept.map((line) => line.slice(indent));
}

/** The `file:line:col` of a JS stack frame outside node internals and node_modules, or null. */
export function projectFrameLocation(line: string): string | null {
  const location = STACK_FRAME.exec(line)?.[1];
  if (location === undefined || location.startsWith('node:') || location.includes('node_modules')) return null;
  return location;
}

export function firstMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | null {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match !== null) return match;
  }
  return null;
}

/** The last line matching `pattern`; a summary line printed twice counts once, as its final form. */
export function lastMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]);
    if (match !== null) return match;
  }
  return null;
}

/** `3 failed, 1 passed` or `3 failed | 1 passed` as counts, in printed order. */
export function countPairs(text: string): DigestCount[] {
  return [...text.matchAll(COUNT_PAIR)].map((match) => ({ label: match[2], value: Number(match[1]) }));
}

export function countOf(counts: readonly DigestCount[], label: string): number {
  return counts.filter((count) => count.label === label).reduce((sum, count) => sum + count.value, 0);
}

/** One failure per name and location; reporters such as MSBuild and Jest repeat them in a summary. */
export function uniqueFailures(failures: readonly DigestFailure[]): DigestFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.name}\n${failure.location ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 6: Write the node:test parser**

How it works:
- **Recognition:** the `ℹ tests N` and `ℹ pass N` count lines.
- **Failures:** read from the `✖ failing tests:` section. Each `test at <file:line:col>` line starts one failure, and its `✖ name (ms)` line follows.
- **Message:** runs up to the first stack frame.
- **Location:** the first frame outside `node:` and `node_modules`; failing that, the `test at` declaration.
- **Load failures:** a file that fails to load says only `'test failed'` there. Its real error is printed before the file's first result line, so the parser reads it from there.

Create `src/output-digest/node-test.ts`:

```ts
import { dedent, projectFrameLocation } from './lines.ts';
import type { DigestCount, DigestFailure, ToolDigest } from './types.ts';

const COUNT_LABELS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const COUNT_LINE = /^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u;
const FAILING_HEADING = '✖ failing tests:';
const DECLARED_AT = /^test at (.+)$/u;
const RESULT_LINE = /^✖ (.+) \(\d+(?:\.\d+)?ms\)$/u;
const ANY_RESULT_LINE = /^\s*(?:✔|✖|﹣|▶|ℹ) /u;
const STACK_LINE = /^\s+at /u;
const LOAD_ERROR = /^(?:[A-Z]\w*)?Error\b/u;
const FILE_URL = /^file:\/\/\/(.+:\d+)$/u;
const BARE_FAILURE = "'test failed'";

/** node prints a file that fails to load as `'test failed'`; its real error comes before the file's first result line. */
function loadError(lines: readonly string[], resultLine: string): { location: string | null; message: string[] } | null {
  const end = lines.indexOf(resultLine);
  let start = end;
  while (start > 0 && !ANY_RESULT_LINE.test(lines[start - 1])) start -= 1;
  const block = lines.slice(start, end);
  const error = block.find((line) => LOAD_ERROR.test(line));
  if (error === undefined) return null;
  const location = block.map((line) => FILE_URL.exec(line)?.[1]).find((match) => match !== undefined) ?? null;
  return { location, message: [error] };
}

function readFailure(lines: readonly string[], body: readonly string[], resultLine: string, name: string, declared: string | null): DigestFailure {
  const stackStart = body.findIndex((line) => STACK_LINE.test(line));
  const message = dedent(stackStart === -1 ? body : body.slice(0, stackStart));
  const frame = body.map(projectFrameLocation).find((location) => location !== null) ?? null;
  const loaded = message.length === 1 && message[0] === BARE_FAILURE ? loadError(lines, resultLine) : null;
  if (loaded !== null) return { name, location: loaded.location ?? declared, message: loaded.message };
  return { name, location: frame ?? declared, message };
}

export function parseNodeTest(lines: readonly string[]): ToolDigest | null {
  const values = new Map<string, number>();
  for (const line of lines) {
    const match = COUNT_LINE.exec(line);
    if (match !== null) values.set(match[1], Number(match[2]));
  }
  if (!values.has('tests') || !values.has('pass')) return null;
  const counts: DigestCount[] = COUNT_LABELS.flatMap((label) => {
    const value = values.get(label);
    return value === undefined ? [] : [{ label, value }];
  });
  const failures: DigestFailure[] = [];
  const section = lines.lastIndexOf(FAILING_HEADING);
  let declared: string | null = null;
  for (let index = section === -1 ? lines.length : section + 1; index < lines.length; index += 1) {
    const declaredMatch = DECLARED_AT.exec(lines[index]);
    if (declaredMatch !== null) declared = declaredMatch[1];
    const result = RESULT_LINE.exec(lines[index]);
    if (result === null) continue;
    let end = index + 1;
    while (end < lines.length && !DECLARED_AT.test(lines[end])) end += 1;
    failures.push(readFailure(lines, lines.slice(index + 1, end), lines[index], result[1], declared));
    index = end - 1;
  }
  const failed = (values.get('fail') ?? 0) > 0 || (values.get('cancelled') ?? 0) > 0;
  return { tool: 'node:test', counts, failed, failures };
}
```

- [ ] **Step 7: Write the vitest parser**

How it works:
- **Recognition:** the closing `Test Files  …` line.
- **Failures:** each ` FAIL  <file> > <name>` block, up to the next `⎯` separator.
- **Location:** the block's ` ❯ <file:line:col>` frame.

Create `src/output-digest/vitest.ts`:

```ts
import { countOf, countPairs, dedent, lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const FILES_LINE = /^\s*Test Files {2}(.+?)(?: \((\d+)\))?$/u;
const TESTS_LINE = /^\s*Tests {2}(.+?)(?: \((\d+)\))?$/u;
const FAIL_LINE = /^ FAIL {2}(.+)$/u;
const FRAME_LINE = /^ ❯ (\S+:\d+:\d+)$/u;
const SEPARATOR = /^⎯/u;

function readFailure(lines: readonly string[], start: number, name: string): DigestFailure {
  let end = start;
  while (end < lines.length && !SEPARATOR.test(lines[end]) && !FAIL_LINE.test(lines[end])) end += 1;
  const block = lines.slice(start, end);
  const frameIndex = block.findIndex((line) => FRAME_LINE.test(line));
  const location = frameIndex === -1 ? null : FRAME_LINE.exec(block[frameIndex])?.[1] ?? null;
  return { name, location, message: dedent(frameIndex === -1 ? block : block.slice(0, frameIndex)) };
}

export function parseVitest(lines: readonly string[]): ToolDigest | null {
  const files = lastMatch(lines, FILES_LINE);
  if (files === null) return null;
  const tests = lastMatch(lines, TESTS_LINE);
  const testCounts = tests === null ? [] : countPairs(tests[1]);
  const total = tests?.[2];
  const counts = total === undefined ? testCounts : [{ label: 'tests', value: Number(total) }, ...testCounts];
  const failures = lines.flatMap((line, index) => {
    const name = FAIL_LINE.exec(line)?.[1];
    return name === undefined ? [] : [readFailure(lines, index + 1, name)];
  });
  const failed = countOf(testCounts, 'failed') > 0 || countOf(countPairs(files[1]), 'failed') > 0;
  return { tool: 'vitest', counts, failed, failures };
}
```

- [ ] **Step 8: Write the jest parser**

How it works:
- **Recognition:** the `Tests:` and `Test Suites:` summary lines.
- **Failures:** each `● <suite> › <name>` block.
- **Message:** runs up to the code frame or the first `at` line.
- **Location:** the first project frame, else the `FAIL <file>` suite path.
- **Repeats:** jest prints failures again under "Summary of all failing tests"; those repeats are de-duplicated.

Create `src/output-digest/jest.ts`:

```ts
import { countOf, countPairs, dedent, lastMatch, projectFrameLocation, uniqueFailures } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const TESTS_LINE = /^Tests:\s+(?:(.+), )?(\d+) total$/u;
const SUITES_LINE = /^Test Suites:\s+(?:(.+), )?(\d+) total$/u;
const SUITE_HEADER = /^(?:FAIL|PASS) (\S.*)$/u;
const FAILURE_HEADER = /^\s+● (.+)$/u;
const CODE_OR_STACK = /^\s*>?\s*\d+ \||^\s+\||^\s+at /u;

function endsBlock(line: string): boolean {
  return FAILURE_HEADER.test(line) || SUITE_HEADER.test(line) || SUITES_LINE.test(line) || TESTS_LINE.test(line);
}

function readFailure(lines: readonly string[], start: number, name: string, suite: string | null): DigestFailure {
  let end = start;
  while (end < lines.length && !endsBlock(lines[end])) end += 1;
  const block = lines.slice(start, end);
  const detailEnd = block.findIndex((line) => CODE_OR_STACK.test(line));
  const frame = block.map(projectFrameLocation).find((location) => location !== null) ?? null;
  return { name, location: frame ?? suite, message: dedent(detailEnd === -1 ? block : block.slice(0, detailEnd)) };
}

export function parseJest(lines: readonly string[]): ToolDigest | null {
  const tests = lastMatch(lines, TESTS_LINE);
  const suites = lastMatch(lines, SUITES_LINE);
  if (tests === null || suites === null) return null;
  const testCounts = countPairs(tests[1] ?? '');
  const failures: DigestFailure[] = [];
  let suite: string | null = null;
  lines.forEach((line, index) => {
    suite = SUITE_HEADER.exec(line)?.[1] ?? suite;
    const name = FAILURE_HEADER.exec(line)?.[1];
    if (name !== undefined) failures.push(readFailure(lines, index + 1, name, suite));
  });
  const failed = countOf(testCounts, 'failed') > 0 || countOf(countPairs(suites[1] ?? ''), 'failed') > 0;
  return { tool: 'jest', counts: [{ label: 'tests', value: Number(tests[2]) }, ...testCounts], failed, failures: uniqueFailures(failures) };
}
```

- [ ] **Step 9: Write the digest entry point and renderer**

Create `src/output-digest/digest.ts`:

```ts
import { parseJest } from './jest.ts';
import { stripTerminalCodes } from './lines.ts';
import { parseNodeTest } from './node-test.ts';
import type { DigestFailure, ToolDigest } from './types.ts';
import { parseVitest } from './vitest.ts';

export const DIGEST_HEADING = 'Digest of the whole output:';
const MESSAGE_LINE_CAP = 12;

/** One digest per tool whose output markers appear in `text`, in a fixed order; none for unrecognised output. */
export function digestToolOutput(text: string): ToolDigest[] {
  const lines = stripTerminalCodes(text).split(/\r?\n/u);
  return [
    parseNodeTest(lines), parseVitest(lines), parseJest(lines),
  ].flatMap((digest) => digest ?? []);
}

function headline(digest: ToolDigest): string {
  const counts = digest.counts.map((count) => `${count.value} ${count.label}`).join(', ');
  return `${digest.tool}: ${digest.failed ? 'FAILED' : 'passed'}${counts.length > 0 ? ` (${counts})` : ''}`;
}

function failureLine(failure: DigestFailure): string {
  return failure.location === null ? `✖ ${failure.name}` : `✖ ${failure.name} — ${failure.location}`;
}

function detailLines(failure: DigestFailure): string[] {
  if (failure.message.length === 0) return [];
  const hidden = failure.message.length - MESSAGE_LINE_CAP;
  return [
    `✖ ${failure.name}`,
    ...failure.message.slice(0, MESSAGE_LINE_CAP).map((line) => `  ${line}`),
    ...(hidden > 0 ? [`  … ${hidden} more lines`] : []),
  ];
}

/** Every tool's verdict and failure list come before any details, so cutting the text from its end keeps them. */
export function renderDigests(digests: readonly ToolDigest[]): string | null {
  if (digests.length === 0) return null;
  const details = digests.flatMap((digest) => digest.failures.flatMap(detailLines));
  return [
    DIGEST_HEADING,
    ...digests.flatMap((digest) => [headline(digest), ...digest.failures.map(failureLine)]),
    ...(details.length > 0 ? ['Details:', ...details] : []),
  ].join('\n');
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-render.test.ts tests\output-digest-parsers.test.ts`
Expected: PASS, 4 render tests and 8 fixture tests.

- [ ] **Step 11: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 4: pytest, dotnet test and MSBuild parsers

**Files:**
- Create: `src/output-digest/pytest.ts`, `src/output-digest/dotnet-test.ts`, `src/output-digest/msbuild.ts`
- Modify: `src/output-digest/digest.ts`
- Test: `tests/output-digest-parsers.test.ts`

- [ ] **Step 1: Add the failing expectations**

In `tests/output-digest-parsers.test.ts`, insert these entries at the end of `EXPECTED`, immediately before the `};` that closes it:

```ts
  'pytest/collection-error.txt': [
    digest('pytest', true, [['error', 1]], [
      ['ERROR collecting test_broken.py', 'test_broken.py:1', ["ModuleNotFoundError: No module named 'nothing_here'"]],
    ]),
  ],
  'pytest/fail.txt': [
    digest('pytest', true, [['failed', 2], ['passed', 1]], [
      ['test_compares_lists', 'test_math.py:4', ["AssertionError: assert ['model-a', '...b', 'model-a'] == ['model-a', 'model-b']", "  Left contains one more item: 'model-a'", '  Use -v to get more diff']],
      ['TestSuite.test_throws', 'test_math.py:7', ["TypeError: Cannot read properties of None (reading 'run_id')"]],
    ]),
  ],
  'pytest/pass.txt': [
    digest('pytest', false, [['passed', 2], ['skipped', 1]], []),
  ],
  'dotnet-test/fail-terminal-logger.txt': [
    digest('dotnet test', true, [['tests', 3], ['failed', 2], ['passed', 1], ['skipped', 0]], [
      ['MathTests.UnitTest1.Throws', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:12', ['System.InvalidOperationException : The store is closed.']],
      ['MathTests.UnitTest1.Compares', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:9', ['Assert.Equal() Failure: Collections differ', 'Expected: ["model-a", "model-b"]', 'Actual:   ["model-a", "model-b", "model-a"]', '↑ (pos 2)']],
    ]),
    digest('msbuild', false, [['errors', 0], ['warnings', 0]], []),
  ],
  'dotnet-test/fail.txt': [
    digest('dotnet test', true, [['tests', 3], ['failed', 2], ['passed', 1], ['skipped', 0]], [
      ['MathTests.UnitTest1.Throws', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:12', ['System.InvalidOperationException : The store is closed.']],
      ['MathTests.UnitTest1.Compares', 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:9', ['Assert.Equal() Failure: Collections differ', 'Expected: ["model-a", "model-b"]', 'Actual:   ["model-a", "model-b", "model-a"]', '↑ (pos 2)']],
    ]),
  ],
  'dotnet-test/pass.txt': [
    digest('dotnet test', false, [['tests', 3], ['failed', 0], ['passed', 2], ['skipped', 1]], []),
  ],
  'msbuild/fail-terminal-logger.txt': [
    digest('msbuild', true, [['errors', 2], ['warnings', 0]], [
      ["CS0029: Cannot implicitly convert type 'string' to 'int'", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:41', []],
      ["CS0103: The name 'y' does not exist in the current context", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:56', []],
    ]),
  ],
  'msbuild/fail.txt': [
    digest('msbuild', true, [['errors', 2], ['warnings', 0]], [
      ["CS0029: Cannot implicitly convert type 'string' to 'int'", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:41', []],
      ["CS0103: The name 'y' does not exist in the current context", 'C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\Broken.cs:5:56', []],
    ]),
  ],
  'msbuild/pass.txt': [
    digest('msbuild', false, [['errors', 0], ['warnings', 0]], []),
  ],
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-parsers.test.ts`
Expected: FAIL. The 9 new fixtures digest to `[]`.

- [ ] **Step 3: Write the pytest parser**

How it works:
- **Recognition:** the closing `=== … in Ns ===` line.
- **Failures:** each `___ title ___` section under the `FAILURES` or `ERRORS` heading.
- **Message:** the section's `E` lines.
- **Location:** the section's last `path.py:N:` line.
- **Without tracebacks:** with `--tb=no` there are no sections, so failures come from the short summary's `FAILED`/`ERROR` lines instead.

Create `src/output-digest/pytest.ts`:

```ts
import { countOf, countPairs, dedent, lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const FINAL_LINE = /^=+ (.+) in [\d.]+s(?: \([^)]*\))? =+$/u;
const BLOCK_HEADING = /^=+ (.+?) =+$/u;
const SECTION_TITLE = /^_{3,} (.+?) _{3,}$/u;
const ERROR_LINE = /^E(?: |$)/u;
const LOCATION_LINE = /^(\S.*?\.py:\d+): /u;
const SUMMARY_LINE = /^(?:FAILED|ERROR) (\S+)(?: - (.*))?$/u;

function readSection(lines: readonly string[], name: string): DigestFailure {
  const location = lastMatch(lines, LOCATION_LINE)?.[1] ?? null;
  return { name, location, message: dedent(lines.filter((line) => ERROR_LINE.test(line)).map((line) => line.slice(1))) };
}

/** Each failure section under the FAILURES and ERRORS headings, named by its title. */
function readSections(lines: readonly string[]): DigestFailure[] {
  const failures: DigestFailure[] = [];
  let inFailures = false;
  let title: string | null = null;
  let body: string[] = [];
  const close = (): void => {
    if (title !== null) failures.push(readSection(body, title));
    title = null;
    body = [];
  };
  for (const line of lines) {
    const heading = BLOCK_HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      close();
      inFailures = heading === 'FAILURES' || heading === 'ERRORS';
      continue;
    }
    if (!inFailures) continue;
    const sectionTitle = SECTION_TITLE.exec(line)?.[1];
    if (sectionTitle === undefined) {
      body.push(line);
      continue;
    }
    close();
    title = sectionTitle;
  }
  close();
  return failures;
}

export function parsePytest(lines: readonly string[]): ToolDigest | null {
  const final = lastMatch(lines, FINAL_LINE);
  if (final === null) return null;
  const counts = countPairs(final[1]);
  const sections = readSections(lines);
  // With `--tb=no` there are no sections; the short summary still names each failure.
  const failures = sections.length > 0 ? sections : lines.flatMap((line) => {
    const match = SUMMARY_LINE.exec(line);
    return match === null ? [] : [{ name: match[1], location: null, message: match[2] === undefined ? [] : [match[2]] }];
  });
  const failed = countOf(counts, 'failed') + countOf(counts, 'error') + countOf(counts, 'errors') > 0;
  return { tool: 'pytest', counts, failed, failures };
}
```

- [ ] **Step 4: Write the dotnet test parser**

How it works:
- **Recognition:** the classic `Passed!`/`Failed!  - Failed: …` summary, or .NET 10's `Test summary: total: …`. Counts are summed across test projects.
- **Failures:** classic `  Failed <name> [ms]` blocks, or terminal-logger `<name> (ms): Error Message: …` blocks.
- **Message:** the error message.
- **Location:** the first `in <file>:line N` frame.

Create `src/output-digest/dotnet-test.ts`:

```ts
import { countOf, firstMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

// The classic logger and .NET 10's terminal logger print different summaries and failure headers.
const CLASSIC_SUMMARY = /^(?:Passed|Failed)!\s+- Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)/u;
const TERMINAL_SUMMARY = /^Test summary: total: (\d+), failed: (\d+), succeeded: (\d+), skipped: (\d+)/u;
const CLASSIC_FAILED = /^ {2}Failed (.+?) \[[^\]]*\]$/u;
const TERMINAL_FAILED = /^\s+(\S+) \([^)]*\): Error Message: (.*)$/u;
const TERMINAL_ERROR = /: error TESTERROR:/u;
const SOURCE_LINE = /\bin (.+):line (\d+)$/u;
const COUNT_LABELS = ['tests', 'failed', 'passed', 'skipped'] as const;

type Summary = Record<(typeof COUNT_LABELS)[number], number>;

function readSummary(line: string): Summary | null {
  const classic = CLASSIC_SUMMARY.exec(line);
  if (classic !== null) return { tests: Number(classic[4]), failed: Number(classic[1]), passed: Number(classic[2]), skipped: Number(classic[3]) };
  const terminal = TERMINAL_SUMMARY.exec(line);
  if (terminal !== null) return { tests: Number(terminal[1]), failed: Number(terminal[2]), passed: Number(terminal[3]), skipped: Number(terminal[4]) };
  return null;
}

function endsBlock(line: string): boolean {
  return line.trim().length === 0 || CLASSIC_FAILED.test(line) || TERMINAL_FAILED.test(line) || TERMINAL_ERROR.test(line);
}

/** The message runs to `Stack Trace:`; the first `in <file>:line N` frame below it is the location. */
function readFailure(lines: readonly string[], start: number, name: string, firstMessageLine: string | null): DigestFailure {
  let end = start;
  while (end < lines.length && !endsBlock(lines[end])) end += 1;
  const block = lines.slice(start, end).map((line) => line.trim());
  const stackStart = block.indexOf('Stack Trace:');
  const messageLines = (stackStart === -1 ? block : block.slice(0, stackStart)).filter((line) => line !== 'Error Message:');
  const source = firstMatch(block, SOURCE_LINE);
  return {
    name,
    location: source === null ? null : `${source[1]}:${source[2]}`,
    message: firstMessageLine === null ? messageLines : [firstMessageLine, ...messageLines],
  };
}

export function parseDotnetTest(lines: readonly string[]): ToolDigest | null {
  const summaries = lines.flatMap((line) => readSummary(line) ?? []);
  if (summaries.length === 0) return null;
  const counts = COUNT_LABELS.map((label) => ({ label, value: summaries.reduce((sum, summary) => sum + summary[label], 0) }));
  const failures = lines.flatMap((line, index) => {
    const classic = CLASSIC_FAILED.exec(line);
    if (classic !== null) return [readFailure(lines, index + 1, classic[1], null)];
    const terminal = TERMINAL_FAILED.exec(line);
    return terminal === null ? [] : [readFailure(lines, index + 1, terminal[1], terminal[2])];
  });
  return { tool: 'dotnet test', counts, failed: countOf(counts, 'failed') > 0, failures };
}
```

- [ ] **Step 5: Write the MSBuild parser**

How it works:
- **Recognition:** `Build succeeded.`/`Build FAILED.`, or the terminal logger's `Build failed with N error(s) in Ns`.
- **Failures:** coded `error` diagnostics, de-duplicated, since MSBuild repeats them in its closing summary.

Create `src/output-digest/msbuild.ts`:

```ts
import { uniqueFailures } from './lines.ts';
import type { ToolDigest } from './types.ts';

// The classic logger ends `Build succeeded.`/`Build FAILED.`; the terminal logger ends `Build failed with N error(s) in 0.9s`.
const MARKER = /^Build (?:succeeded|FAILED)\.$|^Build (?:succeeded|failed)(?: with .+)? in [\d.]+s$/u;
// A coded diagnostic; `dotnet test`'s TESTERROR lines are test failures, which the dotnet test parser reads.
const DIAGNOSTIC = /^\s*(.+?)(?:\((\d+)(?:,(\d+))?\))?\s?: (error|warning) ([A-Z]+\d+): (.*?)(?: \[[^\]]+\])?$/u;

export function parseMsbuild(lines: readonly string[]): ToolDigest | null {
  if (!lines.some((line) => MARKER.test(line))) return null;
  const diagnostics = lines.flatMap((line) => {
    const match = DIAGNOSTIC.exec(line);
    if (match === null) return [];
    const location = match[2] === undefined ? match[1] : `${match[1]}:${match[2]}${match[3] === undefined ? '' : `:${match[3]}`}`;
    return [{ severity: match[4], failure: { name: `${match[5]}: ${match[6]}`, location, message: [] } }];
  });
  // MSBuild repeats every diagnostic in its closing summary.
  const errors = uniqueFailures(diagnostics.filter((entry) => entry.severity === 'error').map((entry) => entry.failure));
  const warnings = uniqueFailures(diagnostics.filter((entry) => entry.severity === 'warning').map((entry) => entry.failure));
  const counts = [{ label: 'errors', value: errors.length }, { label: 'warnings', value: warnings.length }];
  return { tool: 'msbuild', counts, failed: errors.length > 0, failures: errors };
}
```

- [ ] **Step 6: Call the new parsers**

Replace the whole of `src/output-digest/digest.ts` with:

```ts
import { parseDotnetTest } from './dotnet-test.ts';
import { parseJest } from './jest.ts';
import { stripTerminalCodes } from './lines.ts';
import { parseMsbuild } from './msbuild.ts';
import { parseNodeTest } from './node-test.ts';
import { parsePytest } from './pytest.ts';
import type { DigestFailure, ToolDigest } from './types.ts';
import { parseVitest } from './vitest.ts';

export const DIGEST_HEADING = 'Digest of the whole output:';
const MESSAGE_LINE_CAP = 12;

/** One digest per tool whose output markers appear in `text`, in a fixed order; none for unrecognised output. */
export function digestToolOutput(text: string): ToolDigest[] {
  const lines = stripTerminalCodes(text).split(/\r?\n/u);
  return [
    parseNodeTest(lines), parseVitest(lines), parseJest(lines), parsePytest(lines), parseDotnetTest(lines), parseMsbuild(lines),
  ].flatMap((digest) => digest ?? []);
}

function headline(digest: ToolDigest): string {
  const counts = digest.counts.map((count) => `${count.value} ${count.label}`).join(', ');
  return `${digest.tool}: ${digest.failed ? 'FAILED' : 'passed'}${counts.length > 0 ? ` (${counts})` : ''}`;
}

function failureLine(failure: DigestFailure): string {
  return failure.location === null ? `✖ ${failure.name}` : `✖ ${failure.name} — ${failure.location}`;
}

function detailLines(failure: DigestFailure): string[] {
  if (failure.message.length === 0) return [];
  const hidden = failure.message.length - MESSAGE_LINE_CAP;
  return [
    `✖ ${failure.name}`,
    ...failure.message.slice(0, MESSAGE_LINE_CAP).map((line) => `  ${line}`),
    ...(hidden > 0 ? [`  … ${hidden} more lines`] : []),
  ];
}

/** Every tool's verdict and failure list come before any details, so cutting the text from its end keeps them. */
export function renderDigests(digests: readonly ToolDigest[]): string | null {
  if (digests.length === 0) return null;
  const details = digests.flatMap((digest) => digest.failures.flatMap(detailLines));
  return [
    DIGEST_HEADING,
    ...digests.flatMap((digest) => [headline(digest), ...digest.failures.map(failureLine)]),
    ...(details.length > 0 ? ['Details:', ...details] : []),
  ].join('\n');
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-parsers.test.ts tests\output-digest-render.test.ts`
Expected: PASS, 17 fixture tests and 4 render tests.

- [ ] **Step 8: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 5: go test and cargo test parsers

**Files:**
- Create: `src/output-digest/go-test.ts`, `src/output-digest/cargo-test.ts`
- Modify: `src/output-digest/digest.ts`
- Test: `tests/output-digest-parsers.test.ts`

- [ ] **Step 1: Add the failing expectations**

In `tests/output-digest-parsers.test.ts`, insert these entries at the end of `EXPECTED`, immediately before the `};` that closes it:

```ts
  'go-test/build-error.txt': [
    digest('go test', true, [['packages', 2], ['ok', 0], ['failed', 2]], [
      ['TestAdd', 'calc_test.go:7', ['Add(2, 2) = 4, want 4']],
      ['TestTable/neg', 'calc_test.go:15', ['got -2, want -3']],
      ['cannot use "one" (untyped string constant) as int value in return statement', 'other\\other.go:3:25', []],
    ]),
  ],
  'go-test/fail-verbose.txt': [
    digest('go test', true, [['packages', 2], ['ok', 1], ['failed', 1]], [
      ['TestAdd', 'calc_test.go:7', ['Add(2, 2) = 4, want 4']],
      ['TestTable/neg', 'calc_test.go:15', ['got -2, want -3']],
    ]),
  ],
  'go-test/fail.txt': [
    digest('go test', true, [['packages', 2], ['ok', 1], ['failed', 1]], [
      ['TestAdd', 'calc_test.go:7', ['Add(2, 2) = 4, want 4']],
      ['TestTable/neg', 'calc_test.go:15', ['got -2, want -3']],
    ]),
  ],
  'go-test/pass-verbose.txt': [
    digest('go test', false, [['packages', 2], ['ok', 2], ['failed', 0]], []),
  ],
  'go-test/pass.txt': [
    digest('go test', false, [['packages', 2], ['ok', 2], ['failed', 0]], []),
  ],
  'cargo-test/compile-error.txt': [
    digest('cargo test', true, [['errors', 2], ['warnings', 0]], [
      ['E0425: cannot find value `undefined_value` in this scope', 'src\\lib.rs:3:27', []],
      ['E0308: mismatched types', 'src\\lib.rs:2:26', []],
    ]),
  ],
  'cargo-test/fail.txt': [
    digest('cargo test', true, [['passed', 1], ['failed', 2], ['ignored', 0]], [
      ['tests::unwraps', 'src\\lib.rs:11:49', ['value must be present']],
      ['tests::adds', 'src\\lib.rs:7:17', ['assertion `left == right` failed', '  left: 4', ' right: 5']],
    ]),
  ],
  'cargo-test/pass.txt': [
    digest('cargo test', false, [['passed', 2], ['failed', 0], ['ignored', 1]], []),
  ],
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-parsers.test.ts`
Expected: FAIL. The 8 new fixtures digest to `[]`.

- [ ] **Step 3: Write the go test parser**

How it works:
- **Recognition:** `ok`/`FAIL` package result lines, or `--- FAIL:` lines.
- **Messages:** a test's `file.go:N: message` lines belong to the latest `=== RUN` or `--- FAIL` name. `-v` prints them before the result line, the default output after it.
- **Failures:** only leaf tests are listed, because a parent test fails with its subtests. Compile errors under a `# package` heading are failures too.

Create `src/output-digest/go-test.ts`:

```ts
import type { DigestFailure, ToolDigest } from './types.ts';

const PACKAGE_LINE = /^(ok|FAIL)\s+\S+\s+(?:\(cached\)|[\d.]+s|\[(?:build|setup) failed\])/u;
const RUN_LINE = /^=== (?:RUN|CONT|PAUSE)\s+(\S+)$/u;
const RESULT_LINE = /^\s*--- (FAIL|PASS|SKIP): (\S+) \(/u;
const MESSAGE_LINE = /^\s+(\S+\.go:\d+): (.*)$/u;
const BUILD_HEADING = /^# \S+/u;
const COMPILE_ERROR = /^(\S+\.go:\d+:\d+): (.*)$/u;

/**
 * A test's `file:line: message` lines belong to the latest `=== RUN` or `--- FAIL` name: `-v` prints them
 * before the result line, the default output after it. A parent fails with its subtests, so only leaves are listed.
 */
export function parseGoTest(lines: readonly string[]): ToolDigest | null {
  let ok = 0;
  let failedPackages = 0;
  let current: string | null = null;
  let inBuild = false;
  const failedTests: string[] = [];
  const messages = new Map<string, { location: string; text: string }[]>();
  const buildErrors: DigestFailure[] = [];
  for (const line of lines) {
    const pkg = PACKAGE_LINE.exec(line);
    if (pkg !== null) {
      if (pkg[1] === 'ok') ok += 1;
      else failedPackages += 1;
    }
    const compile: RegExpExecArray | null = inBuild ? COMPILE_ERROR.exec(line) : null;
    if (compile !== null) buildErrors.push({ name: compile[2], location: compile[1], message: [] });
    inBuild = BUILD_HEADING.test(line) || compile !== null;
    const run = RUN_LINE.exec(line);
    const result = RESULT_LINE.exec(line);
    current = run?.[1] ?? result?.[2] ?? current;
    if (result?.[1] === 'FAIL' && !failedTests.includes(result[2])) failedTests.push(result[2]);
    const message = MESSAGE_LINE.exec(line);
    if (message !== null && current !== null) messages.set(current, [...(messages.get(current) ?? []), { location: message[1], text: message[2] }]);
  }
  if (ok + failedPackages === 0 && failedTests.length === 0) return null;
  const leaves = failedTests.filter((name) => !failedTests.some((other) => other.startsWith(`${name}/`)));
  const failures = [...leaves.map((name) => {
    const own = messages.get(name) ?? [];
    return { name, location: own[0]?.location ?? null, message: own.map((entry) => entry.text) };
  }), ...buildErrors];
  const counts = [{ label: 'packages', value: ok + failedPackages }, { label: 'ok', value: ok }, { label: 'failed', value: failedPackages }];
  return { tool: 'go test', counts, failed: failedPackages > 0 || failures.length > 0, failures };
}
```

- [ ] **Step 4: Write the cargo test parser**

How it works:
- **Recognition:** `test result:` lines, summed across unit and doc tests, or rustc diagnostics.
- **Test failures:** each `---- name stdout ----` block. Its location and message come from the block's `panicked at <file:line:col>:` line.
- **Compile errors:** rustc `error[E…]` diagnostics count only when a `-->` location line follows, so cargo's own `error:` lines are not counted.

Create `src/output-digest/cargo-test.ts`:

```ts
import { dedent } from './lines.ts';
import type { DigestCount, DigestFailure, ToolDigest } from './types.ts';

const RESULT_LINE = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/u;
const STDOUT_HEADING = /^---- (\S+) stdout ----$/u;
const PANIC_LINE = /^thread '.*?' (?:\(\d+\) )?panicked at (.+:\d+:\d+):$/u;
const PANIC_END = /^(?:note: |---- |failures:$|\s*$)/u;
const RUSTC_DIAGNOSTIC = /^(error|warning)(?:\[(E\d+)\])?: (.*)$/u;
const RUSTC_LOCATION = /^\s*--> (.+:\d+:\d+)$/u;

/** A failing test's panic location and message, which runs to a blank line or rustc's backtrace note. */
function readPanic(lines: readonly string[], start: number, name: string): DigestFailure {
  let index = start;
  while (index < lines.length && !PANIC_LINE.test(lines[index]) && !STDOUT_HEADING.test(lines[index])) index += 1;
  const panic = index < lines.length ? PANIC_LINE.exec(lines[index]) : null;
  if (panic === null) return { name, location: null, message: [] };
  let end = index + 1;
  while (end < lines.length && !PANIC_END.test(lines[end])) end += 1;
  return { name, location: panic[1], message: dedent(lines.slice(index + 1, end)) };
}

export function parseCargoTest(lines: readonly string[]): ToolDigest | null {
  const totals = { passed: 0, failed: 0, ignored: 0 };
  let results = 0;
  const failures: DigestFailure[] = [];
  let errors = 0;
  let warnings = 0;
  lines.forEach((line, index) => {
    const result = RESULT_LINE.exec(line);
    if (result !== null) {
      results += 1;
      totals.passed += Number(result[1]);
      totals.failed += Number(result[2]);
      totals.ignored += Number(result[3]);
    }
    const heading = STDOUT_HEADING.exec(line);
    if (heading !== null) failures.push(readPanic(lines, index + 1, heading[1]));
    // Only a diagnostic with a `-->` location is rustc's; cargo's own `error:` lines have none.
    const diagnostic = RUSTC_DIAGNOSTIC.exec(line);
    const location = diagnostic === null ? null : RUSTC_LOCATION.exec(lines[index + 1] ?? '');
    if (diagnostic === null || location === null) return;
    if (diagnostic[1] === 'warning') {
      warnings += 1;
      return;
    }
    errors += 1;
    failures.push({ name: diagnostic[2] === undefined ? diagnostic[3] : `${diagnostic[2]}: ${diagnostic[3]}`, location: location[1], message: [] });
  });
  if (results === 0 && errors + warnings === 0) return null;
  const counts: DigestCount[] = [
    ...(results === 0 ? [] : Object.entries(totals).map(([label, value]) => ({ label, value }))),
    ...(errors + warnings === 0 ? [] : [{ label: 'errors', value: errors }, { label: 'warnings', value: warnings }]),
  ];
  return { tool: 'cargo test', counts, failed: totals.failed > 0 || errors > 0, failures };
}
```

- [ ] **Step 5: Call the new parsers**

Replace the whole of `src/output-digest/digest.ts` with:

```ts
import { parseCargoTest } from './cargo-test.ts';
import { parseDotnetTest } from './dotnet-test.ts';
import { parseGoTest } from './go-test.ts';
import { parseJest } from './jest.ts';
import { stripTerminalCodes } from './lines.ts';
import { parseMsbuild } from './msbuild.ts';
import { parseNodeTest } from './node-test.ts';
import { parsePytest } from './pytest.ts';
import type { DigestFailure, ToolDigest } from './types.ts';
import { parseVitest } from './vitest.ts';

export const DIGEST_HEADING = 'Digest of the whole output:';
const MESSAGE_LINE_CAP = 12;

/** One digest per tool whose output markers appear in `text`, in a fixed order; none for unrecognised output. */
export function digestToolOutput(text: string): ToolDigest[] {
  const lines = stripTerminalCodes(text).split(/\r?\n/u);
  return [
    parseNodeTest(lines), parseVitest(lines), parseJest(lines), parsePytest(lines), parseDotnetTest(lines), parseGoTest(lines), parseCargoTest(lines), parseMsbuild(lines),
  ].flatMap((digest) => digest ?? []);
}

function headline(digest: ToolDigest): string {
  const counts = digest.counts.map((count) => `${count.value} ${count.label}`).join(', ');
  return `${digest.tool}: ${digest.failed ? 'FAILED' : 'passed'}${counts.length > 0 ? ` (${counts})` : ''}`;
}

function failureLine(failure: DigestFailure): string {
  return failure.location === null ? `✖ ${failure.name}` : `✖ ${failure.name} — ${failure.location}`;
}

function detailLines(failure: DigestFailure): string[] {
  if (failure.message.length === 0) return [];
  const hidden = failure.message.length - MESSAGE_LINE_CAP;
  return [
    `✖ ${failure.name}`,
    ...failure.message.slice(0, MESSAGE_LINE_CAP).map((line) => `  ${line}`),
    ...(hidden > 0 ? [`  … ${hidden} more lines`] : []),
  ];
}

/** Every tool's verdict and failure list come before any details, so cutting the text from its end keeps them. */
export function renderDigests(digests: readonly ToolDigest[]): string | null {
  if (digests.length === 0) return null;
  const details = digests.flatMap((digest) => digest.failures.flatMap(detailLines));
  return [
    DIGEST_HEADING,
    ...digests.flatMap((digest) => [headline(digest), ...digest.failures.map(failureLine)]),
    ...(details.length > 0 ? ['Details:', ...details] : []),
  ].join('\n');
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-parsers.test.ts`
Expected: PASS, 25 fixture tests.

- [ ] **Step 7: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 6: tsc, mypy, pyright and eslint parsers; every fixture covered

**Files:**
- Create: `src/output-digest/tsc.ts`, `src/output-digest/mypy.ts`, `src/output-digest/pyright.ts`, `src/output-digest/eslint.ts`
- Modify: `src/output-digest/digest.ts`
- Test: `tests/output-digest-parsers.test.ts`

- [ ] **Step 1: Add the failing expectations and the coverage tests**

In `tests/output-digest-parsers.test.ts`, change the fixture-reader import to:

```ts
import { listDigestFixtures, readDigestFixture } from './helpers/output-digest-fixtures.ts';
```

Insert these entries at the end of `EXPECTED`, immediately before the `};` that closes it:

```ts
  'tsc/fail-pretty.txt': [
    digest('tsc', true, [['errors', 3], ['warnings', 0]], [
      ["TS2322: Type 'string' is not assignable to type 'number'.", 'src/a.ts:1:14', []],
      ["TS2551: Property 'toUpperCas' does not exist on type 'string'. Did you mean 'toUpperCase'?", 'src/a.ts:3:15', []],
      ["TS2322: Type 'number' is not assignable to type 'string'.", 'src/b.ts:2:14', []],
    ]),
  ],
  'tsc/fail.txt': [
    digest('tsc', true, [['errors', 3], ['warnings', 0]], [
      ["TS2322: Type 'string' is not assignable to type 'number'.", 'src/a.ts:1:14', []],
      ["TS2551: Property 'toUpperCas' does not exist on type 'string'. Did you mean 'toUpperCase'?", 'src/a.ts:3:15', []],
      ["TS2322: Type 'number' is not assignable to type 'string'.", 'src/b.ts:2:14', []],
    ]),
  ],
  'mypy/fail.txt': [
    digest('mypy', true, [['errors', 3], ['source files checked', 4]], [
      ['Incompatible types in assignment (expression has type "int", variable has type "str")  [assignment]', 'pkg\\a.py:4', []],
      ['Argument 1 to "add" has incompatible type "str"; expected "int"  [arg-type]', 'pkg\\a.py:5', []],
      ['Module has no attribute "missing_name"  [attr-defined]', 'pkg\\b.py:3', []],
    ]),
  ],
  'mypy/pass.txt': [
    digest('mypy', false, [['errors', 0], ['source files checked', 1]], []),
  ],
  'pyright/fail.txt': [
    digest('pyright', true, [['errors', 3], ['warnings', 0]], [
      ['Type "int" is not assignable to declared type "str"', 'c:\\tmp\\rsx\\output-digest-capture\\pyc\\pkg\\a.py:4:15', ['"int" is not assignable to "str" (reportAssignmentType)']],
      ['Argument of type "Literal[\'x\']" cannot be assigned to parameter "a" of type "int" in function "add"', 'c:\\tmp\\rsx\\output-digest-capture\\pyc\\pkg\\a.py:5:5', ['"Literal[\'x\']" is not assignable to "int" (reportArgumentType)']],
      ['"missing_name" is not a known attribute of module "pkg.a" (reportAttributeAccessIssue)', 'c:\\tmp\\rsx\\output-digest-capture\\pyc\\pkg\\b.py:3:20', []],
    ]),
  ],
  'pyright/pass.txt': [
    digest('pyright', false, [['errors', 0], ['warnings', 0]], []),
  ],
  'eslint/fail.txt': [
    digest('eslint', true, [['errors', 3], ['warnings', 2]], [
      ["'unused' is assigned a value but never used (no-unused-vars)", 'C:\\tmp\\rsx\\output-digest-capture\\eslint\\src\\a.js:1:5', []],
      ["Expected '===' and instead saw '==' (eqeqeq)", 'C:\\tmp\\rsx\\output-digest-capture\\eslint\\src\\a.js:3:13', []],
      ["'missingName' is not defined (no-undef)", 'C:\\tmp\\rsx\\output-digest-capture\\eslint\\src\\a.js:3:29', []],
    ]),
  ],
  'eslint/warn-only.txt': [
    digest('eslint', false, [['errors', 0], ['warnings', 1]], []),
  ],
```

Append these tests at the end of the file:

```ts
test('every captured fixture has an exact expectation', () => {
  assert.deepEqual(listDigestFixtures(), Object.keys(EXPECTED).sort());
});

test('tsc output followed by eslint output yields a digest for each, in order', () => {
  const combined = `${readDigestFixture('tsc/fail.txt')}\n${readDigestFixture('eslint/fail.txt')}`;
  assert.deepEqual(digestToolOutput(combined), [...(EXPECTED['tsc/fail.txt'] ?? []), ...(EXPECTED['eslint/fail.txt'] ?? [])]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-parsers.test.ts`
Expected: FAIL. The 8 new fixtures and the combined test digest to `[]`.

- [ ] **Step 3: Write the tsc parser**

Create `src/output-digest/tsc.ts`:

```ts
import type { DigestFailure, ToolDigest } from './types.ts';

// `--pretty false` prints `file(line,col): error`; the default pretty form prints `file:line:col - error`.
const PLAIN = /^(.+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/u;
const PRETTY = /^(.+):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/u;

export function parseTsc(lines: readonly string[]): ToolDigest | null {
  const diagnostics = lines.flatMap((line) => {
    const match = PLAIN.exec(line) ?? PRETTY.exec(line);
    return match === null ? [] : [{ severity: match[4], failure: { name: `${match[5]}: ${match[6]}`, location: `${match[1]}:${match[2]}:${match[3]}`, message: [] } }];
  });
  if (diagnostics.length === 0) return null;
  const failures: DigestFailure[] = diagnostics.filter((entry) => entry.severity === 'error').map((entry) => entry.failure);
  const counts = [{ label: 'errors', value: failures.length }, { label: 'warnings', value: diagnostics.length - failures.length }];
  return { tool: 'tsc', counts, failed: failures.length > 0, failures };
}
```

- [ ] **Step 4: Write the mypy parser**

Create `src/output-digest/mypy.ts`:

```ts
import { lastMatch } from './lines.ts';
import type { ToolDigest } from './types.ts';

// mypy always ends with one of these; requiring it keeps compilers' `file:line: error:` lines out.
const SUMMARY = /^(?:Found (\d+) errors? in \d+ files? \(checked (\d+) source files?\)|Success: no issues found in (\d+) source files?)$/u;
const ERROR_LINE = /^(.+?:\d+(?::\d+)?): error: (.*)$/u;

export function parseMypy(lines: readonly string[]): ToolDigest | null {
  const summary = lastMatch(lines, SUMMARY);
  if (summary === null) return null;
  const failures = lines.flatMap((line) => {
    const match = ERROR_LINE.exec(line);
    return match === null ? [] : [{ name: match[2], location: match[1], message: [] }];
  });
  const checked = Number(summary[2] ?? summary[3]);
  const counts = [{ label: 'errors', value: Number(summary[1] ?? 0) }, { label: 'source files checked', value: checked }];
  return { tool: 'mypy', counts, failed: summary[1] !== undefined, failures };
}
```

- [ ] **Step 5: Write the pyright parser**

Create `src/output-digest/pyright.ts`:

```ts
import { dedent, lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const SUMMARY = /^(\d+) errors?, (\d+) warnings?, (\d+) informations?\s*$/u;
const DIAGNOSTIC = /^(\s+)(.+:\d+:\d+) - (error|warning|information): (.*)$/u;

/** Each error with the lines indented under it, which carry the explanation and the rule. */
export function parsePyright(lines: readonly string[]): ToolDigest | null {
  const summary = lastMatch(lines, SUMMARY);
  if (summary === null) return null;
  const failures: DigestFailure[] = [];
  lines.forEach((line, index) => {
    const diagnostic = DIAGNOSTIC.exec(line);
    if (diagnostic === null || diagnostic[3] !== 'error') return;
    let end = index + 1;
    while (end < lines.length && lines[end].length - lines[end].trimStart().length > diagnostic[1].length && !DIAGNOSTIC.test(lines[end])) end += 1;
    failures.push({ name: diagnostic[4], location: diagnostic[2], message: dedent(lines.slice(index + 1, end)) });
  });
  const counts = [{ label: 'errors', value: Number(summary[1]) }, { label: 'warnings', value: Number(summary[2]) }];
  return { tool: 'pyright', counts, failed: Number(summary[1]) > 0, failures };
}
```

- [ ] **Step 6: Write the eslint parser**

Create `src/output-digest/eslint.ts`:

```ts
import { lastMatch } from './lines.ts';
import type { DigestFailure, ToolDigest } from './types.ts';

const SUMMARY = /^✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)$/u;
const ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/u;

/** The stylish formatter: a file path line, then one `line:col  severity  message  rule` row per problem. */
export function parseEslint(lines: readonly string[]): ToolDigest | null {
  const summary = lastMatch(lines, SUMMARY);
  if (summary === null) return null;
  const failures: DigestFailure[] = [];
  let file = '';
  for (const line of lines) {
    const row = ROW.exec(line);
    if (row === null) {
      if (line.length > 0 && !/^\s/u.test(line)) file = line;
      continue;
    }
    if (row[3] !== 'error') continue;
    failures.push({ name: row[5] === undefined ? row[4] : `${row[4]} (${row[5]})`, location: `${file}:${row[1]}:${row[2]}`, message: [] });
  }
  const counts = [{ label: 'errors', value: Number(summary[1]) }, { label: 'warnings', value: Number(summary[2]) }];
  return { tool: 'eslint', counts, failed: Number(summary[1]) > 0, failures };
}
```

- [ ] **Step 7: Call every parser**

Replace the whole of `src/output-digest/digest.ts` with:

```ts
import { parseCargoTest } from './cargo-test.ts';
import { parseDotnetTest } from './dotnet-test.ts';
import { parseEslint } from './eslint.ts';
import { parseGoTest } from './go-test.ts';
import { parseJest } from './jest.ts';
import { stripTerminalCodes } from './lines.ts';
import { parseMsbuild } from './msbuild.ts';
import { parseMypy } from './mypy.ts';
import { parseNodeTest } from './node-test.ts';
import { parsePyright } from './pyright.ts';
import { parsePytest } from './pytest.ts';
import { parseTsc } from './tsc.ts';
import type { DigestFailure, ToolDigest } from './types.ts';
import { parseVitest } from './vitest.ts';

export const DIGEST_HEADING = 'Digest of the whole output:';
const MESSAGE_LINE_CAP = 12;

/** One digest per tool whose output markers appear in `text`, in a fixed order; none for unrecognised output. */
export function digestToolOutput(text: string): ToolDigest[] {
  const lines = stripTerminalCodes(text).split(/\r?\n/u);
  return [
    parseNodeTest(lines), parseVitest(lines), parseJest(lines), parsePytest(lines), parseDotnetTest(lines), parseGoTest(lines),
    parseCargoTest(lines), parseTsc(lines), parseMypy(lines), parsePyright(lines), parseMsbuild(lines), parseEslint(lines),
  ].flatMap((digest) => digest ?? []);
}

function headline(digest: ToolDigest): string {
  const counts = digest.counts.map((count) => `${count.value} ${count.label}`).join(', ');
  return `${digest.tool}: ${digest.failed ? 'FAILED' : 'passed'}${counts.length > 0 ? ` (${counts})` : ''}`;
}

function failureLine(failure: DigestFailure): string {
  return failure.location === null ? `✖ ${failure.name}` : `✖ ${failure.name} — ${failure.location}`;
}

function detailLines(failure: DigestFailure): string[] {
  if (failure.message.length === 0) return [];
  const hidden = failure.message.length - MESSAGE_LINE_CAP;
  return [
    `✖ ${failure.name}`,
    ...failure.message.slice(0, MESSAGE_LINE_CAP).map((line) => `  ${line}`),
    ...(hidden > 0 ? [`  … ${hidden} more lines`] : []),
  ];
}

/** Every tool's verdict and failure list come before any details, so cutting the text from its end keeps them. */
export function renderDigests(digests: readonly ToolDigest[]): string | null {
  if (digests.length === 0) return null;
  const details = digests.flatMap((digest) => digest.failures.flatMap(detailLines));
  return [
    DIGEST_HEADING,
    ...digests.flatMap((digest) => [headline(digest), ...digest.failures.map(failureLine)]),
    ...(details.length > 0 ? ['Details:', ...details] : []),
  ].join('\n');
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\output-digest-parsers.test.ts tests\output-digest-render.test.ts`
Expected: PASS: 33 fixture tests, the coverage test, the combined test and 4 render tests.

- [ ] **Step 9: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 7: The `run` tool leads with the digest

**Files:**
- Modify: `src/repo-search/engine/tool-result-budgeter.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts:994-1001,1185-1196`
- Modify: `src/repo-search/engine/repo-tools.ts:64`
- Modify: `src/repo-search/engine/validation-command-output-policy.ts:27-156`
- Modify: `src/repo-search/prompts.ts:252,378`, `src/repo-search/repo-tool-arguments.ts:100`
- Test: `tests/engine-tool-result-budgeter.test.ts`, `tests/engine-tool-action-processor.test.ts`, `tests/validation-command-output-policy.test.ts`, `tests/repo-search-prompts.test.ts`

- [ ] **Step 1: Give every existing budgeter call `digest: null`**

In `tests/engine-tool-result-budgeter.test.ts`, every `budgeter.fit({ … })` call ends its options with one of these lines. Replace each everywhere (`replace_all`):

| Old line ending | New line ending |
|---|---|
| `commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head',` | `commandSucceededForFitting: true, outputUnit: 'lines', keep: 'head', digest: null,` |
| `commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head',` | `commandSucceededForFitting: false, outputUnit: 'lines', keep: 'head', digest: null,` |
| `commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail',` | `commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest: null,` |

That is seven calls in all.

- [ ] **Step 2: Write the failing budgeter tests**

Add these imports below the existing ones in `tests/engine-tool-result-budgeter.test.ts`:

```ts
import { digestToolOutput, renderDigests } from '../src/output-digest/digest.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';
```

Append at the end of the file:

```ts
const ROOMY = { kind: 'available', perToolCapTokens: 100_000, remainingTokenAllowance: 100_000 } as const;

test('a result that fits leads with its digest, then the whole output', async () => {
  const resultText = 'exit_code=0\nℹ tests 1\nℹ pass 1';
  const digest = 'Digest of the whole output:\nnode:test: passed (1 tests, 1 pass)';
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: ROOMY,
    commandSucceededForFitting: true, outputUnit: 'lines', keep: 'tail', digest,
  });
  assert.equal(fitted.resultText, `${digest}\n${resultText}`);
  assert.equal(fitted.fittedReturnedSegmentCount, null);
});

test('an oversized failed run is its whole digest, the truncation notice, then the tail, within the failed-command cap', async () => {
  const output = readDigestFixture('node-test/noisy-e2e-fail.txt');
  const resultText = `exit_code=1\n${output}`;
  const digest = renderDigests(digestToolOutput(output));
  assert.ok(digest !== null);
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: ROOMY,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest,
  });
  assert.ok(fitted.resultTokenCount <= FAILED_COMMAND_TAIL_CAP_TOKENS);
  assert.ok(fitted.resultText.startsWith(`${digest}\n`), fitted.resultText);
  assert.match(fitted.resultText.slice(digest.length), /^\n\d+ lines truncated due to per-tool context limit\.\n/u);
  assert.ok(fitted.resultText.endsWith(output.trimEnd().split(/\r?\n/u).at(-1) ?? ''), 'the tail still ends the result');
});

test('a digest longer than half the failed-command cap is cut from its end, ahead of the tail', async () => {
  const digest = ['Digest of the whole output:', 'node:test: FAILED (300 tests, 0 pass, 300 fail)',
    ...Array.from({ length: 300 }, (unused, index) => `✖ broken test number ${index} — tests/x.test.ts:${index + 1}:1`)].join('\n');
  const resultText = Array.from({ length: 400 }, (unused, index) => `fail-line-${index}`).join('\n');
  const fitted = await makeBudgeter().fit({
    taskId: 't1', turn: 1, toolName: 'run', resultText, rawResultText: resultText, capacity: ROOMY,
    commandSucceededForFitting: false, outputUnit: 'lines', keep: 'tail', digest,
  });
  assert.ok(fitted.resultTokenCount <= FAILED_COMMAND_TAIL_CAP_TOKENS);
  assert.ok(fitted.resultText.startsWith('Digest of the whole output:\nnode:test: FAILED (300 tests, 0 pass, 300 fail)\n'
    + '✖ broken test number 0 — tests/x.test.ts:1:1\n'), fitted.resultText);
  assert.doesNotMatch(fitted.resultText, /broken test number 299 /u);
  assert.ok(fitted.resultText.endsWith('fail-line-399'));
});
```

- [ ] **Step 3: Write the failing processor test**

In `tests/engine-tool-action-processor.test.ts`, add these imports below the existing ones:

```ts
import { digestToolOutput, renderDigests } from '../src/output-digest/digest.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';
```

Append at the end of the file:

```ts
// The failures end the raw output's first lines; validation shaping keeps only the 100 noise lines' last 50.
test('a validation run leads with the digest of its raw output, taken before shaping keeps its last 50 lines', async () => {
  const root = createManagedTempDir('siftkit-run-digest-');
  const noise = Array.from({ length: 100 }, (unused, index) => `noise line ${index} of the test log`);
  const output = [readDigestFixture('pytest/fail.txt').trimEnd(), ...noise].join('\n');
  const npmTest = buildRepoToolRequestedCommand('run', { command: 'npm test' });
  const { processor, commands } = makeProcessor(root, ['run'], 'repo-agent', null, {
    [npmTest]: { exitCode: 1, stdout: output, stderr: '' },
    [STABLE_COMMAND]: { exitCode: 0, stdout: 'stable\n', stderr: '' },
  });
  await processor.executeBatch(1, [{ kind: 'tool', callId: 'test_call_digest_1', toolName: 'run', args: { command: 'npm test' } }], '', 0, false);
  await processor.executeBatch(2, [{ kind: 'tool', callId: 'test_call_digest_2', toolName: 'run', args: { command: 'Write-Output stable' } }], '', 0, false);
  const digest = renderDigests(digestToolOutput(output));
  assert.ok(digest !== null);
  assert.match(digest, /^Digest of the whole output:\npytest: FAILED \(2 failed, 1 passed\)\n/u);
  const shown = commands[0]?.promptOutput ?? '';
  assert.ok(shown.startsWith(`${digest}\n`), shown);
  assert.match(shown, /\d+ lines omitted from validation command output\./u);
  assert.doesNotMatch(shown, /short test summary info/u, 'the shaped tail itself holds none of the failures');
  assert.doesNotMatch(commands[1]?.promptOutput ?? '', /Digest of the whole output/u);
});
```

- [ ] **Step 3b: Delete the summary-line reservation tests**

In `tests/validation-command-output-policy.test.ts`, delete these, which pin the node-only reservation this task removes:
- the `buildSpecReporterOutput` helper;
- the five tests after it: `'retains spec-reporter summary lines that fall outside the tail window'`, `'does not duplicate a summary line that already falls inside the tail window'`, `'caps reserved summary lines at the line limit and keeps the last ones'`, `'charges gap markers against the line limit'` and `'marks interior gaps and emits retained lines in original order'`.

The next remaining test is `'gate downgrades first full validation run, grants one retry, then rejects repeats'`. Then append:

```ts
test('output over the limit keeps exactly its last lines, with no summary lines reserved from earlier', () => {
  const output = ['ℹ tests 1', '✖ failing tests:', ...Array.from({ length: 60 }, (_, index) => `line-${index + 1}`)].join('\n');
  const retained = policy.apply({ command: 'npm test', output, outputMode: 'auto' }).split('\n');
  assert.deepEqual(retained, ['12 lines omitted from validation command output.', ...Array.from({ length: 50 }, (_, index) => `line-${index + 11}`)]);
});
```

- [ ] **Step 4: Write the failing prompt test**

In `tests/repo-search-prompts.test.ts`, replace the whole test `'buildAgentSystemPrompt steers test output to result-line filtering, never to trimming it to its last lines'` with:

```ts
test('buildAgentSystemPrompt says recognised test output leads with a digest, and never steers to trimming or filtering it', () => {
  const prompt = buildAgentSystemPrompt(buildTestContext(process.cwd(), false, true));
  assert.doesNotMatch(prompt, /PowerShell syntax \([^)]*(?:-Last|-Tail)/u, 'trimming idioms are not offered as the syntax to use');
  assert.match(prompt, /starts with a digest of the whole output: each tool's verdict, then every failure with its file:line and message/u);
  assert.match(prompt, /Do not cut test output yourself with `Select-Object -Last` or `Get-Content -Tail`, and do not filter it with `Select-String`/u);
  assert.doesNotMatch(prompt, /Select-String '\^\(✖\|ℹ\)'/u, 'the interim result-line filter is gone');
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `node .\src\test-runner\run-tests.ts tests\engine-tool-result-budgeter.test.ts tests\engine-tool-action-processor.test.ts tests\validation-command-output-policy.test.ts tests\repo-search-prompts.test.ts`
Expected: FAIL:
- the three new budgeter tests: no digest in the result;
- the processor digest test;
- the new policy test: the `ℹ`/`✖` lines are still reserved;
- the prompt test.

- [ ] **Step 6: Take the digest in the budgeter and drop the interim header**

In `src/repo-search/engine/tool-result-budgeter.ts`:

1. Delete these lines and the blank line after them:

```ts
/** A node:test failed-test or count line; a failed command's tail is details, so these are kept from the whole output. */
const TEST_RESULT_LINE = /^(?:✖ (?!failing tests:)|ℹ (?:tests|pass|fail|cancelled|skipped|todo) )/u;
const TEST_RESULTS_HEADING = 'Test results from the whole output:';
```

2. In the `fit` options type, after `keep: ToolOutputKeep;`, add:

```ts
    /** A rendered digest of the whole command output, which leads the result; null when no parser recognised it. */
    digest: string | null;
```

3. Replace:

```ts
    const promptToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_prompt', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: options.resultText.length,
    });
    const candidateResultTokenResult = await this.countTokens(options.resultText);
```

with:

```ts
    const candidateText = options.digest === null ? options.resultText : `${options.digest}\n${options.resultText}`;
    const promptToolTokenSpan = this.timingRecorder?.start('repo.tool.tokenize_prompt', {
      taskId: options.taskId, turn: options.turn, toolName: options.toolName, inputChars: candidateText.length,
    });
    const candidateResultTokenResult = await this.countTokens(candidateText);
```

4. Replace `    let resultText = options.resultText;` with `    let resultText = candidateText;`.

5. Replace `      const segments = resultText.split(/\r?\n/u).filter((line) => line.length > 0);` with `      const segments = options.resultText.split(/\r?\n/u).filter((line) => line.length > 0);`.

6. Replace:

```ts
      // A failed command keeps its test result lines in up to half its budget, ahead of the tail.
      const resultLines = options.commandSucceededForFitting ? [] : [...new Set(segments.filter((line) => TEST_RESULT_LINE.test(line)))];
      const headerText = resultLines.length === 0 ? undefined : (await fitter.fitSegments({
        segments: [TEST_RESULTS_HEADING, ...resultLines], separator: '\n', maxTokens: maxResultTokens / 2, unit: 'lines', keep: 'head',
      })).visibleText;
```

with:

```ts
      // The digest keeps at most half the budget, cut from its end so every verdict and failure name survives first.
      const headerText = options.digest === null ? undefined : (await fitter.fitSegments({
        segments: options.digest.split('\n'), separator: '\n', maxTokens: maxResultTokens / 2, unit: 'lines', keep: 'head',
      })).visibleText;
```

- [ ] **Step 7: Carry the digest of the raw `run` output on the execution**

In `src/repo-search/engine/repo-tools.ts`, in the successful `RepoToolExecution` shape, after the `outputKeep?: ToolOutputKeep;` line, add:

```ts
    /** `run` only: the digest of the raw output, taken before validation shaping cuts it; absent when no parser recognised it. */
    digest?: string;
```

In `src/repo-search/engine/tool-action-processor.ts`, add this import after `import { ToolResultBudgeter } from './tool-result-budgeter.ts';`:

```ts
import { digestToolOutput, renderDigests } from '../../output-digest/digest.ts';
```

At the end of the native `run` execution (line 994), replace:

```ts
    const output = this.deps.runtimeProfile.applyRunOutput({
      call: nativeCall.args,
      output: execution.output,
      decision: runFullOutputDecision,
    });
    return {
      ...execution,
      output,
    };
```

with:

```ts
    const output = this.deps.runtimeProfile.applyRunOutput({
      call: nativeCall.args,
      output: execution.output,
      decision: runFullOutputDecision,
    });
    // Digested before validation shaping keeps only the last lines, so the failures it drops still lead the result.
    const digest = renderDigests(digestToolOutput(execution.output));
    return {
      ...execution,
      output,
      ...(digest === null ? {} : { digest }),
    };
```

In the `this.deps.resultBudgeter.fit({ … })` call (line 1185), after the `keep:` line, add:

```ts
      digest: nativeExecution && nativeExecution.ok && nativeExecution.digest !== undefined ? nativeExecution.digest : null,
```

`ToolResultBudgeter.fit` has no other caller: `tests/helpers/tool-action-processor.ts` only constructs the class. Confirm this with `rg -n "\.fit\(\{" src tests`, which must list only this call and the budgeter tests.

- [ ] **Step 7b: Make validation shaping a plain tail**

In `src/repo-search/engine/validation-command-output-policy.ts`, replace everything from the comment `/** Node's spec reporter prints its counts before an unbounded …` down to the closing `}` of `class ValidationCommandOutputPolicy` with the following. That span is:
- the `SUMMARY_LINE_PATTERNS` constant;
- `pluralizeLines`;
- the class with `apply`, `selectRetainedIndices`, `mergeTail`, `renderedLineCount`, `trimToLineLimit` and `tailIndices`.

```ts
function pluralizeLines(count: number): string {
  return count === 1 ? 'line' : 'lines';
}

export class ValidationCommandOutputPolicy {
  private readonly lineLimit: number;

  constructor(lineLimit: number) {
    this.lineLimit = Math.max(1, Math.trunc(lineLimit));
  }

  isValidationCommand(command: string): boolean {
    return isValidationCommand(command);
  }

  /** Keeps the last `lineLimit` lines; the run's digest, taken from the whole output first, carries its verdict and failures. */
  apply(options: {
    command: string;
    output: string;
    outputMode: RunOutputMode;
  }): string {
    if (options.outputMode === 'full' || !this.isValidationCommand(options.command)) {
      return options.output;
    }
    const lines = options.output.split(/\r\n|\r|\n/u);
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length <= this.lineLimit) {
      return options.output;
    }
    const omittedLineCount = lines.length - this.lineLimit;
    return [
      `${omittedLineCount} ${pluralizeLines(omittedLineCount)} omitted from validation command output.`,
      ...lines.slice(-this.lineLimit),
    ].join('\n');
  }
}
```

In `src/repo-search/prompts.ts` line 378, replace `retain a curated final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines (summary and failure lines survive) under` with `keep their final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines, after the digest of their whole output, under`.

In `src/repo-search/repo-tool-arguments.ts` line 100, replace `auto (default) keeps a curated final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines for test/build/lint/typecheck commands - use it for those.` with `auto (default) keeps the final ${REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT} lines of test/build/lint/typecheck commands, after a digest of their whole output - use it for those.`.

- [ ] **Step 8: Update the `run` guidance**

In `src/repo-search/prompts.ts` line 252 (`RUN_SHELL_GUIDANCE`), replace this exact text:

```
Long output reaches you as its tail; a failing command also keeps its test result lines (✖ names, ℹ counts). Do not cut test output yourself with \`Select-Object -Last\` or \`Get-Content -Tail\`: the names and counts print before the failure details, so the last lines drop them. To narrow test output, filter it: \`| Select-String '^(✖|ℹ)'\`.
```

with:

```
Long output reaches you as its tail. Test and type-check output SiftKit recognises (node:test, vitest, jest, pytest, dotnet test, go test, cargo test, tsc, mypy, pyright, MSBuild, eslint) also starts with a digest of the whole output: each tool's verdict, then every failure with its file:line and message. Do not cut test output yourself with \`Select-Object -Last\` or \`Get-Content -Tail\`, and do not filter it with \`Select-String\`: the digest is built from the whole output, so run test commands unfiltered.
```

The backslash-backtick pairs are the template literal's escapes. Keep them exactly as in the surrounding text.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\engine-tool-result-budgeter.test.ts tests\engine-tool-action-processor.test.ts tests\validation-command-output-policy.test.ts tests\repo-search-prompts.test.ts tests\repo-search-runtime-profile.test.ts tests\tool-output-fit.test.ts`
Expected: PASS.
Run: `node .\src\test-runner\run-tests.ts --process tests\process\repo-search-agent-execute.test.ts`
Expected: PASS. It still finds `lines omitted from validation command output.`.

- [ ] **Step 10: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 8: Orchestrator checks carry and show the digest

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts:114-118`
- Modify: `src/orchestrator/verification.ts`
- Modify: `src/orchestrator/handoff.ts:108`, `src/orchestrator/submission.ts:80`, `src/orchestrator/run.ts:695,777`
- Test: `tests/orchestrator-verification.test.ts`, `tests/orchestrator-handoff.test.ts`, `tests/orchestrator-submission.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`
- Modify (fixtures gain `digest: null`): `tests/contracts-orchestrator.test.ts:140,145`, `tests/process/chat-overflow.test.ts:25`, `dashboard/tests/orchestrator-run-panel.test.tsx:31,40`

- [ ] **Step 1: Write the failing verification tests**

In `tests/orchestrator-verification.test.ts`, replace the import of `findEvidenceProblem` with:

```ts
import { findEvidenceProblem, renderCheckOutput, runVerificationCheck } from '../src/orchestrator/verification.ts';
import { digestToolOutput, renderDigests } from '../src/output-digest/digest.ts';
import { digestFixturePath, readDigestFixture } from './helpers/output-digest-fixtures.ts';
```

Append:

```ts
test('a check is digested from its whole output before the stored output is cut to its last 20,000 characters', async () => {
  const command = `Get-Content -Raw -Encoding UTF8 '${digestFixturePath('pytest/fail.txt')}'; `
    + '1..2000 | ForEach-Object { "noise line $_ of the check log" }; exit 1';
  const result = await runVerificationCheck({ repoRoot: repo(), check: { ...COMMAND, command }, abortSignal: new AbortController().signal });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.length <= 20_000);
  assert.doesNotMatch(result.output, /short test summary info/u, 'the stored tail no longer holds the failures');
  assert.equal(result.digest, renderDigests(digestToolOutput(readDigestFixture('pytest/fail.txt'))));
});

test('a check renders as its digest, then its output tail; without a digest, as the tail alone', () => {
  const result = { check: COMMAND, executed: true, exitCode: 1, timedOut: false, output: `${'x'.repeat(50)}END`,
    digest: 'Digest of the whole output:\npytest: FAILED (1 failed)' };
  assert.equal(renderCheckOutput(result, 10), 'Digest of the whole output:\npytest: FAILED (1 failed)\nxxxxxxxEND');
  assert.equal(renderCheckOutput({ ...result, digest: null }, 10), 'xxxxxxxEND');
});
```

- [ ] **Step 2: Write the failing handoff and submission assertions**

In `tests/orchestrator-handoff.test.ts`:
- Give `passing` the field `digest: null`.
- Replace the `failing` constant with:

```ts
const failing: OrchestratorCheckResult = { check: { kind: 'command', command: 'npm run lint', cwd: '.', expectedExitCode: 0 },
  executed: true, exitCode: 1, timedOut: false, output: `${'noise '.repeat(400)}src/store.ts:4 unused import`,
  digest: 'Digest of the whole output:\neslint: FAILED (1 errors, 0 warnings)\n✖ unused import (no-unused-vars) — src/store.ts:4:1' };
```

- In the first test, replace `assert.match(text, /- FAIL \`npm run lint\` exited 1[^\n]*\n[^]*src\/store\.ts:4 unused import/u);` with:

```ts
  assert.match(text, /- FAIL `npm run lint` exited 1\nDigest of the whole output:\neslint: FAILED \(1 errors, 0 warnings\)\n✖ unused import \(no-unused-vars\) — src\/store\.ts:4:1\n[^]*src\/store\.ts:4 unused import/u);
```

- In the test `'an attempt names empty changes and lists only command checks'`, give the `evidence` constant `digest: null`.

In `tests/orchestrator-submission.test.ts`, replace `checkResult` with:

```ts
function checkResult(exitCode: number): OrchestratorCheckResult {
  return { check: CHECK, executed: true, exitCode, timedOut: false, output: exitCode === 0 ? 'ok' : 'FAIL greeting.test.ts',
    digest: exitCode === 0 ? null : 'Digest of the whole output:\nnode:test: FAILED (1 tests, 0 pass, 1 fail)\n✖ greets — tests/greeting.test.ts:3:5' };
}
```

In the test `'failing checks return their real output to the same child until the resubmits run out'`, replace the `assert.match(…)` line with:

```ts
    assert.match(verdict.kind === 'reject' ? verdict.message : '', new RegExp(`submission ${submitted} of 3[\\s\\S]*Output of [^\\n]*\\n`
      + 'Digest of the whole output:\\nnode:test: FAILED \\(1 tests, 0 pass, 1 fail\\)\\n✖ greets — tests/greeting\\.test\\.ts:3:5\\nFAIL greeting\\.test\\.ts', 'u'));
```

- [ ] **Step 3: Write the failing `run_check` e2e test**

In `tests/process/orchestrator-run.e2e.test.ts`, add this import below the existing ones:

```ts
import { digestFixturePath } from '../helpers/output-digest-fixtures.ts';
```

Add this test after `'a final verification that fails on every finish fails the run after the last one'`:

```ts
test('run_check leads its result with the digest of the whole check output', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-check-digest-');
  const { engine } = context;
  const command = `Get-Content -Raw -Encoding UTF8 '${digestFixturePath('pytest/fail.txt')}'; exit 1`;
  engine.parent.push([savePlan(), tool('run_check', { command, cwd: '.' }), dispatch({ taskId: 'greeting' }), review('greeting', 'pass'), COMPLETE]);
  engine.children.push(WRITER);

  const { state } = await followRun(context, (await startRun(context, 'off')).runId);

  assertCompleted(state, engine);
  const [, check] = engine.parentToolOutputs();
  assert.match(check ?? '', /exit 1\nDigest of the whole output:\npytest: FAILED \(2 failed, 1 passed\)\n✖ test_compares_lists — test_math\.py:4\n/u);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-verification.test.ts tests\orchestrator-handoff.test.ts tests\orchestrator-submission.test.ts`
Expected: FAIL. `renderCheckOutput` is not exported; `digest` is undefined; the digest is missing from the rendered text.

- [ ] **Step 5: Add `digest` to the contract**

In `packages/contracts/src/orchestrator.ts`, replace the `OrchestratorCheckResultSchema` declaration and its comment with:

```ts
/** One declared check and what happened when it ran; `executed` false means it never ran, and `digest` digests its whole output. */
export const OrchestratorCheckResultSchema = z.object({
  check: OrchestratorVerificationCheckSchema,
  executed: z.boolean(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), output: z.string(),
  digest: z.string().nullable(),
}).strict();
```

- [ ] **Step 6: Digest and render checks in `verification.ts`**

In `src/orchestrator/verification.ts`, add this import after the `resolveRepoScopedPath` import:

```ts
import { digestToolOutput, renderDigests } from '../output-digest/digest.ts';
```

Replace `unexecutedCheck` and the `return` of `runVerificationCheck`:

```ts
/** A check recorded without running: an evidence check awaiting review, or a denied command. */
export function unexecutedCheck(check: OrchestratorVerificationCheck, output: string): OrchestratorCheckResult {
  return { check, executed: false, exitCode: null, timedOut: false, output, digest: null };
}
```

```ts
  // The digest reads the whole output; only the stored output is cut to its tail.
  return { check, executed: true, exitCode: result.exitCode, timedOut: result.exitCode === TIMEOUT_EXIT_CODE,
    output: result.output.slice(-CHECK_OUTPUT_MAX_CHARS), digest: renderDigests(digestToolOutput(result.output)) };
}

/** A check's output for a model: its digest, then the output's last `tailChars` characters. */
export function renderCheckOutput(result: OrchestratorCheckResult, tailChars: number): string {
  const tail = result.output.slice(-tailChars);
  return result.digest === null ? tail : `${result.digest}\n${tail}`;
}
```

- [ ] **Step 7: Use `renderCheckOutput` at the four sites**

1. In `src/orchestrator/handoff.ts`, add `import { renderCheckOutput } from './verification.ts';` after the `import type { DiffstatEntry } from './workspace.ts';` line. In `renderCheck`, replace `    + check.output.slice(-CHECK_OUTPUT_TAIL_CHARS);` with `    + renderCheckOutput(check, CHECK_OUTPUT_TAIL_CHARS);`.
2. In `src/orchestrator/submission.ts`, add `import { renderCheckOutput } from './verification.ts';` after the `./handoff.ts` import. Replace `.map((check) => \`Output of ${orchestratorCheckFailure(check) ?? ''}\n${check.output.slice(-CHECK_OUTPUT_TAIL_CHARS)}\`),` with `.map((check) => \`Output of ${orchestratorCheckFailure(check) ?? ''}\n${renderCheckOutput(check, CHECK_OUTPUT_TAIL_CHARS)}\`),`.
3. In `src/orchestrator/run.ts`, change line 67 to `import { renderCheckOutput, runVerificationCheck, unexecutedCheck } from './verification.ts';`.
   - In `runCheck` (line 695), replace `` output: `${status}\n${result.output.slice(-COMMAND_OUTPUT_TAIL_CHARS)}` `` with `` output: `${status}\n${renderCheckOutput(result, COMMAND_OUTPUT_TAIL_CHARS)}` ``.
   - In the final-verification rejection (line 777), replace `` ...failing.map((check) => `${orchestratorCheckFailure(check) ?? ''}\n${check.output.slice(-COMMAND_OUTPUT_TAIL_CHARS)}`), `` with `` ...failing.map((check) => `${orchestratorCheckFailure(check) ?? ''}\n${renderCheckOutput(check, COMMAND_OUTPUT_TAIL_CHARS)}`), ``.

Then run `rg -n "output\.slice\(-" src/orchestrator`. Expected: only `verification.ts` (the stored-output cut and `renderCheckOutput`) and the `handoff.ts` final-answer tail (`workerOutput.slice(-FINAL_ANSWER_TAIL_CHARS)`).

- [ ] **Step 8: Give the remaining check fixtures `digest: null`**

- `tests/contracts-orchestrator.test.ts:140`:
  - becomes `const result = { executed: true, exitCode: 0, timedOut: false, output: '', digest: null };`;
  - in line 145, add `digest: null` after `output: ''`.
- `tests/process/chat-overflow.test.ts:25`: in the `checks: [{ check: CHECK, … output: UNBROKEN }]` object, add `digest: null` after `output: UNBROKEN`.
- `dashboard/tests/orchestrator-run-panel.test.tsx`:
  - line 31 becomes `const UNREVIEWED_EVIDENCE = { check: EVIDENCE, executed: false, exitCode: null, timedOut: false, output: '', digest: null };`;
  - in line 40, add `digest: null` after `output: 'boom'`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\orchestrator-verification.test.ts tests\orchestrator-handoff.test.ts tests\orchestrator-submission.test.ts tests\contracts-orchestrator.test.ts`
Expected: PASS.
Run: `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts tests\process\chat-overflow.test.ts`
Expected: PASS, including `'run_check leads its result with the digest of the whole check output'`.
Run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 10: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 9: Schema upgrade 89 → 90 for stored check results

**Files:**
- Create: `src/state/schema-upgrades/orchestrator-check-digests.ts`
- Modify: `src/state/runtime-db.ts:26,39,72`
- Test: `tests/runtime-db-schema-orchestrator-check-digests.test.ts`

- [ ] **Step 1: Write the failing upgrade test**

Create `tests/runtime-db-schema-orchestrator-check-digests.test.ts`:

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import type { JsonValue } from '../src/lib/json-types.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import { CURRENT_SCHEMA_VERSION, closeAllRuntimeDatabases, getRuntimeDatabase, getSchemaVersion } from '../src/state/runtime-db.ts';
import { writeConfig } from '../src/status-server/config-store.ts';
import { getDefaultServerConfig } from './helpers/mock-config.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { withRuntimeDatabaseConnection } from './helpers/runtime-database-probe.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;
const WRITE = makeOrchestratorTask({ id: 'greeting', workerPresetId: 'repo-agent', writePaths: ['src/greeting.ts'], verification: [CHECK] });
const STORED_CHECK = { check: CHECK, executed: true, exitCode: 1, timedOut: false, output: 'FAIL greeting.test.ts' };

/** A schema-89 file holding one settled attempt whose stored result has `checks`. */
function seedSchema89(checks: JsonValue): { dbPath: string; runId: string } {
  const dbPath = path.join(createManagedTempDir('siftkit-check-digests-'), 'runtime.sqlite');
  writeConfig(dbPath, getDefaultServerConfig());
  const store = new OrchestratorRunStore(getRuntimeDatabase(dbPath));
  const created = store.create({ submissionId: randomUUID(), sessionId: null, repoRoot: createManagedTempDir('siftkit-check-digests-repo-'),
    presetId: 'orchestrator', approval: 'off', task: 'Add greeting.', planPath: null });
  const state = store.savePlan(created.runId, created.revision, makeOrchestratorPlan([WRITE]), 'docs/plan.md', 'hash');
  const attempt = store.reserveAttempt(state.runId, state.revision, 'greeting',
    { kind: 'implementation', planPath: 'docs/plan.md', planHash: 'hash', task: WRITE, instruction: 'Write it.' });
  closeAllRuntimeDatabases();
  withRuntimeDatabaseConnection(dbPath, (database) => {
    database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?').run(JSON.stringify({ ...attempt, status: 'settled', result: {
      taskId: 'greeting', purpose: 'implementation', attempt: 1, childRunId: attempt.childRunId, workerStatus: 'completed',
      workerOutput: 'done', report: null, outcome: 'checks_failed', submissions: 3, passed: false, checks,
      findings: ['Check `npm test` exited 1; expected 0.'], changedPaths: ['src/greeting.ts'], changeDigest: 'd',
    } }), attempt.childRunId);
    database.exec('UPDATE runtime_schema SET version = 89 WHERE id = 1');
  });
  return { dbPath, runId: state.runId };
}

test('the 89 to 90 upgrade gives every stored check result a null digest', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema89([STORED_CHECK]);
  const database = getRuntimeDatabase(dbPath);
  assert.equal(CURRENT_SCHEMA_VERSION, 90);
  assert.equal(getSchemaVersion(database), CURRENT_SCHEMA_VERSION);
  assert.deepEqual(new OrchestratorRunStore(database).read(runId).attempts[0]?.result?.checks, [{ ...STORED_CHECK, digest: null }]);
});

test('the 89 to 90 upgrade fails loudly on an unreadable stored attempt, naming its run, and leaves the file at 89', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, runId } = seedSchema89('not a list of checks');
  assert.throws(() => getRuntimeDatabase(dbPath), new RegExp(`Orchestrator run ${runId} has an unreadable stored attempt`, 'u'));
  assert.equal(withRuntimeDatabaseConnection(dbPath, (database) => getSchemaVersion(database)), 89);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node .\src\test-runner\run-tests.ts tests\runtime-db-schema-orchestrator-check-digests.test.ts`
Expected: FAIL. `CURRENT_SCHEMA_VERSION` is 89, so the stored check has no `digest`; the second test opens without throwing.

- [ ] **Step 3: Write the upgrade**

Create `src/state/schema-upgrades/orchestrator-check-digests.ts`:

```ts
import { parseJsonObjectText } from '../../lib/json.ts';
import { JsonValueSchema } from '../../lib/json-types.ts';
import { z } from '../../lib/zod.ts';
import type { RuntimeDatabase } from '../database-handle.ts';

const AttemptRowsSchema = z.array(z.object({ run_id: z.string(), child_run_id: z.string(), attempt_json: z.string() }));
// Pins only what this step reads from schema-89 attempts: each settled result's check list.
const Stored89AttemptSchema = z.object({
  result: z.object({ checks: z.array(z.object({}).catchall(JsonValueSchema)) }).catchall(JsonValueSchema).nullable(),
}).catchall(JsonValueSchema);

/** Schema 89 -> 90: check results gain `digest`; output stored before digests existed has none, so it is null. */
export function upgradeOrchestratorCheckDigests(database: RuntimeDatabase): void {
  const rows = AttemptRowsSchema.parse(database.prepare('SELECT run_id, child_run_id, attempt_json FROM orchestrator_attempts').all());
  const updates = rows.flatMap((row) => {
    const parsed = Stored89AttemptSchema.safeParse(parseJsonObjectText(row.attempt_json));
    if (!parsed.success) throw new Error(`Orchestrator run ${row.run_id} has an unreadable stored attempt: ${parsed.error.message}`);
    const { result } = parsed.data;
    if (result === null) return [];
    const checks = result.checks.map((check) => ({ ...check, digest: null }));
    return [{ childRunId: row.child_run_id, json: JSON.stringify({ ...parsed.data, result: { ...result, checks } }) }];
  });
  const update = database.prepare('UPDATE orchestrator_attempts SET attempt_json = ? WHERE child_run_id = ?');
  for (const row of updates) update.run(row.json, row.childRunId);
}
```

- [ ] **Step 4: Register it**

In `src/state/runtime-db.ts`:
- add `import { upgradeOrchestratorCheckDigests } from './schema-upgrades/orchestrator-check-digests.ts';` after the `orchestrator-attempt-results.ts` import;
- change `export const CURRENT_SCHEMA_VERSION = 89;` to `export const CURRENT_SCHEMA_VERSION = 90;`;
- after `  { from: 88, apply: upgradeOrchestratorSingleWorker },`, add `  { from: 89, apply: upgradeOrchestratorCheckDigests },`.

- [ ] **Step 5: Run the upgrade tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\runtime-db-schema-orchestrator-check-digests.test.ts tests\runtime-db-schema-orchestrator-single-worker.test.ts tests\runtime-db-schema-orchestrator-attempt-results.test.ts tests\runtime-db-schema-orchestrator-search-reports.test.ts tests\runtime-db-schema-orchestrator-single-parent.test.ts tests\runtime-db-schema.test.ts`
Expected: PASS. The older upgrade tests now run through 90 and still hold.

- [ ] **Step 6: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 10: `siftkit summary` answers pass/fail from the digest

**Files:**
- Modify: `src/summary/request-runner.ts:37,161-171,181-182`
- Delete: `src/summary/test-output.ts`
- Test: `tests/summary-request-runner.test.ts`, `tests/runtime-summarize.test.ts:159`

- [ ] **Step 1: Write the failing tests**

In `tests/summary-request-runner.test.ts`, add this import below the existing ones:

```ts
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';
```

Append:

```ts
for (const [fixture, failure] of [
  ['pytest/fail.txt', '✖ test_compares_lists — test_math.py:4'],
  ['dotnet-test/fail.txt', '✖ MathTests.UnitTest1.Compares — C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:9'],
] as const) {
  test(`SummaryRequestRunner answers a pass/fail question about ${fixture} from its digest, with no model call`, async () => {
    const result = await new SummaryRequestRunner({
      repoRoot: process.cwd(),
      question: 'Did the test run pass? Return pass/fail and the failing tests.',
      inputText: readDigestFixture(fixture),
      format: 'text', policyProfile: 'general', sourceKind: 'command-output', commandExitCode: 1,
    }).run();
    assert.equal(result.PolicyDecision, 'deterministic-test-output');
    assert.equal(result.Classification, 'command_failure');
    assert.match(result.Summary, /^FAIL: Digest of the whole output:\n/u);
    assert.ok(result.Summary.includes(failure), result.Summary);
  });
}

test('SummaryRequestRunner fails a pass/fail answer on a non-zero exit even when every recognised tool passed', async () => {
  const result = await new SummaryRequestRunner({
    repoRoot: process.cwd(),
    question: 'Did the test run pass? Return pass/fail.',
    inputText: readDigestFixture('jest/pass.txt'),
    format: 'text', policyProfile: 'general', sourceKind: 'command-output', commandExitCode: 1,
  }).run();
  assert.equal(result.Classification, 'command_failure');
  assert.match(result.Summary, /^FAIL: Digest of the whole output:\njest: passed \(3 tests, 1 skipped, 2 passed\)$/u);
});
```

In `tests/runtime-summarize.test.ts:159`, replace `assert.match(result.Summary, /Test Suites: 1 passed, 1 total/u);` with `assert.match(result.Summary, /jest: passed \(7 tests, 7 passed\)/u);`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node .\src\test-runner\run-tests.ts tests\summary-request-runner.test.ts tests\runtime-summarize.test.ts`
Expected: FAIL. The pytest and dotnet runs fall through to a model call (the dead endpoint rejects it), and the summaries do not start with the digest.

- [ ] **Step 3: Use the digest in the deterministic path**

In `src/summary/request-runner.ts`, replace `import { parseDeterministicTestOutput } from './test-output.ts';` with:

```ts
import { digestToolOutput, renderDigests } from '../output-digest/digest.ts';
```

Replace the start of `tryDeterministicTestOutput`, from its signature down to and including `if (!deterministicTestSummary) { return null; }`, with:

```ts
  private async tryDeterministicTestOutput(): Promise<SummaryResult | null> {
    const sourceKindForFastPath = this.request.sourceKind || 'standalone';
    if (sourceKindForFastPath !== 'command-output' || !isPassFailQuestion(this.request.question)) {
      return null;
    }
    const digests = digestToolOutput(this.inputText);
    const digestText = renderDigests(digests);
    if (digestText === null) {
      return null;
    }
    // A non-zero exit fails the run even when every recognised tool passed.
    const exitCode = this.request.commandExitCode;
    const verdict = digests.some((digest) => digest.failed) || (typeof exitCode === 'number' && exitCode !== 0) ? 'FAIL' : 'PASS';
```

In the `SummaryResult` literal below it, replace the three lines that read `deterministicTestSummary`:

```ts
      Summary: `${verdict}: ${digestText}`,
      Classification: verdict === 'PASS' ? 'summary' : 'command_failure',
      RawReviewRequired: verdict === 'FAIL',
```

- [ ] **Step 4: Delete the Jest-only parser**

Run: `Remove-Item src\summary\test-output.ts`
Run: `rg -n "test-output|parseDeterministicTestOutput|DeterministicTestSummary" src tests dashboard`
Expected: no matches.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node .\src\test-runner\run-tests.ts tests\summary-request-runner.test.ts tests\runtime-summarize.test.ts tests\runtime-planner-mode.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates**

Run: `npm run typecheck`, then `npm run lint`
Expected: both exit 0.

---

### Task 11: Final verification

- [ ] **Step 1: Full gates**

Run: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:dashboard`
Expected: all exit 0.
Run: `node .\src\test-runner\run-tests.ts --process tests\process\orchestrator-run.e2e.test.ts tests\process\chat-overflow.test.ts`
Expected: PASS.

- [ ] **Step 2: No interim artifacts left**

Run: `rg -n "TEST_RESULT_LINE|Test results from the whole output|node-test-failures|digestNodeTestFailures|SUMMARY_LINE_PATTERNS|curated final" src tests`
Expected: no matches.

- [ ] **Step 3: Scratch cleanup (primary agent, after every task is verified)**

Delete `C:\tmp\rsx\output-digest-capture`. It holds the capture projects, the portable Go toolchain, the mypy/pyright venv, jest's `node_modules` and the prototype. The fixtures now live in `tests/fixtures/output-digest`.
