# Output digests for test and type-check output: design

**Status:** approved 2026-11-02.

## Problem

When a test or type-check command produces long output, SiftKit cuts it to its tail before a model reads it. A failed `run` command keeps at most 1,024 tokens. Orchestrator checks keep the last 1,500 to 4,000 characters. For most tools the tail is the wrong part:

- node:test prints the failing test names and the counts first, then a long "failing tests" section. The tail is the last failure's stack trace, with no names and no counts.
- Process tests interleave about 50 server log lines per test. In a real run, the result lines were about 2% of 137 KB of output.
- A worker that tried to work around this with `| Select-Object -Last 45` (which the shell guidance suggested) lost the names and counts too, and had to run the suite a second time.

The reader needs one of two answers, from any common tool: everything passed, or what failed and at which file and line.

## Goals

1. SiftKit recognises the console output of 12 tools and turns it into a **digest**. The digest says either that everything passed, or which tests or diagnostics failed, each with its `file:line` location and its message.
   - Tests: node:test, vitest, jest, pytest, dotnet test, go test, cargo test.
   - Type checkers and compilers: tsc, mypy, pyright, MSBuild (`dotnet build`), eslint.
2. Each tool is recognised from markers in the output itself, never from the command line. Wrappers such as `npm test` and `npm run check` work.
3. Output that no parser recognises passes through exactly as today.
4. Every place that cuts command output for a model leads with the digest, then shows as much raw tail as still fits:
   - the worker's `run` tool;
   - the orchestrator's checks;
   - `siftkit summary`.

## Non-goals

- Structured report files (JUnit, TRX, JSON reporters) and any injection of reporter flags or environment variables.
- Rewriting or wrapping the commands a worker runs.
- Tools beyond the 12 above.
- Changing what the dashboard shows.

## 1. The digest module: `src/output-digest/`

### 1.1 Shape

```ts
type DigestFailure = { name: string; location: string | null; message: string[] };
type ToolDigest = {
  tool: DigestTool;                 // 'node:test' | 'vitest' | 'jest' | 'pytest' | 'dotnet test' | 'go test' | 'cargo test'
                                    // | 'tsc' | 'mypy' | 'pyright' | 'msbuild' | 'eslint'
  counts: { label: string; value: number }[];   // as the tool reports them, e.g. tests/pass/fail/skipped, or errors/warnings
  failed: boolean;
  failures: DigestFailure[];        // empty when failed is false
};
```

- `location` is `path:line` or `path:line:col`, exactly as the tool prints the path.
- `message` holds the failure's message lines: the error line, plus an assertion diff where there is one.
- There is no stack trace beyond the location.

### 1.2 API

`src/output-digest/digest.ts` exports:

- `digestToolOutput(text: string): ToolDigest[]`
  - Calls every parser explicitly, in a fixed order, and returns each one that recognised the output.
  - Combined output (for example tsc, then eslint) yields one digest per tool.
  - Unrecognised output yields `[]`.
- `renderDigests(digests: ToolDigest[]): string | null`
  - Returns the text a model reads, or null for `[]`.
  - The text begins with the heading `Digest of the whole output:`.

There is no registry or plugin interface. Adding a tool means one new parser module and one line in `digestToolOutput`.

### 1.3 Parsers

Each parser is one module, `src/output-digest/<tool>.ts`. It exports one function, `parse<Tool>(lines: readonly string[]): ToolDigest | null`, which returns null unless the tool's markers are present. Parsers are pure, never throw, and read lines only.

| Tool | Recognised by | Failure name and location |
|---|---|---|
| node:test | `ℹ tests N` and `ℹ pass N` lines | the `✖ failing tests:` section: `test at <file:line:col>`, the `✖ name` line, the message up to the first stack frame, the first frame outside `node:` and `node_modules` as the failing location. A file that fails to load reports the error printed before its result line (e.g. `SyntaxError: …` with its `file:///…:N`), not node's bare `'test failed'`. |
| vitest | `Test Files … (N)` and `Tests … (N)` summary lines | each `FAIL  <file> > <name>` block, its error line, and its `❯ <file:line:col>` frame |
| jest | `Tests:` and `Test Suites:` summary lines | each `● <suite> › <name>` block, its message, and its first `at … (<file:line:col>)` frame in the project |
| pytest | the final `=== … passed/failed … in …s ===` line | the `short test summary info` lines (`FAILED path::name - message`), plus the `path:line:` line in each failure's section |
| dotnet test | the `Passed!`/`Failed!  - Failed: N, Passed: N, …` summary, or the .NET 10 summary form | each `Failed <name> [ms]` block, its `Error Message:`, and the `in <file>:line N` stack frame |
| go test | `--- FAIL:`/`--- PASS:` lines, or `ok`/`FAIL` package result lines | each `--- FAIL: <name>` and the indented `<file>:<line>: <message>` lines under it |
| cargo test | `test result: ok/FAILED. N passed; N failed; …`, or rustc `error[E…]` diagnostics | each `---- <name> stdout ----` block with its `panicked at <file:line:col>`, and each rustc error with its `--> <file:line:col>` |
| tsc | `<file>(line,col): error TSnnnn:` or `<file>:line:col - error TSnnnn:` lines | each error line |
| mypy | `<file>:<line>: error:` lines, or `Success: no issues found` | each error line |
| pyright | `N errors, N warnings, N informations` | each `<file>:<line>:<col> - error:` line |
| msbuild | `Build succeeded.`/`Build FAILED.`, or the terminal logger's `… failed with N error(s)` line | each `<file>(line,col): error <code>:` line, de-duplicated (MSBuild repeats errors in its summary) |
| eslint | the `✖ N problems (N errors, N warnings)` line | each `line:col  error  message  rule` row under its file path line |

- The markers listed are the expected forms. Each one is confirmed against captured real output (§4) before its parser is written.
- Warnings count, but only errors are listed as failures.
- Tools that print nothing on success (tsc, eslint) produce no digest when they pass. Their output then passes through raw, which is empty.

### 1.4 Rendering

```
Digest of the whole output:
node:test: 2 of 25 failed (23 pass, 0 skipped)
✖ one conversation plans, dispatches a writer … — tests/process/orchestrator-run.e2e.test.ts:188:12
✖ while a child awaits a decision … — tests/process/orchestrator-run.e2e.test.ts:459:10
Details:
✖ one conversation plans, dispatches a writer …
  AssertionError [ERR_ASSERTION]: the parent on A, its child on B, then the parent resumes on A
  …
```

- A passing tool renders as one line, for example `node:test: all 29 passed (0 skipped)` or `mypy: no errors in 3 files`.
- Every failure's name and location is listed before any details, so cutting the digest from its end keeps the complete list.
- Each failure's message is capped at 12 lines, followed by `… N more lines`.

## 2. Consumers

### 2.1 The worker's `run` tool

`ToolResultBudgeter.fit` (in `src/repo-search/engine/tool-result-budgeter.ts`) renders the digest of the command's output and leads the tool result with it. This applies whether the command passed or failed.

- **The output fits:** the result is the digest, then the whole output.
- **It doesn't fit:**
  - the digest is fitted from its head into half the result budget;
  - the truncation notice follows it;
  - the raw tail fills what remains.
- **No digest:** behaviour is unchanged.

This replaces the interim `TEST_RESULT_LINE` header and its tests. The unfinished `node-test-failures` module and its tests are removed, and their node:test cases become fixtures.

The `run` shell guidance in `src/repo-search/prompts.ts` keeps its rule:

> Do not cut test output yourself with `Select-Object -Last` or `Get-Content -Tail`.

Its explanation changes to say that the result starts with a digest of recognised test and type-check output.

### 2.2 Orchestrator checks

- **New field:** `OrchestratorCheckResultSchema` gains `digest: z.string().nullable()`.
  - `runVerificationCheck` computes it from the **full** output, before the stored output is cut to its last 20,000 characters.
  - Evidence and unexecuted checks have `digest: null`.
- **One renderer:** `renderCheckOutput(result, tailChars)` in `src/orchestrator/verification.ts` returns the digest followed by the output's last `tailChars` characters. It is the only renderer used by:
  - the submission gate's failing-check feedback to the child (`submission.ts`);
  - the check lines in the attempt report the orchestrator reads (`handoff.ts`);
  - the `run_check` tool result (`run.ts`);
  - the final-verification rejection (`run.ts`).
- **Upgrade:** `src/state/schema-upgrades/orchestrator-check-digests.ts` is registered as `{ from: 89, apply }`, with `CURRENT_SCHEMA_VERSION = 90`.
  - It sets `digest: null` on every stored check result.
  - It parses only the fields it reads, as the earlier orchestrator upgrades do.

### 2.3 `siftkit summary`

The deterministic fast path in `src/summary/request-runner.ts` (`tryDeterministicTestOutput`) uses `digestToolOutput` in place of the Jest-only `parseDeterministicTestOutput`. It still runs only for command output with a pass/fail question.

- **Verdict:** FAIL when any digest failed or the command's exit code is non-zero; otherwise PASS.
- **Summary:** the rendered digest.
- **Cleanup:** `src/summary/test-output.ts` is deleted. Its tests move to the jest parser's fixtures.

## 3. Error handling

- **Parsers never throw.** A parser that finds its tool's markers but cannot extract a failure's details still reports the counts and the failure names it found.
- **A digest never replaces output.** Each consumer keeps the raw tail after the digest, so anything a parser misses can still be read.
- **The upgrade fails loudly.** A stored check result that does not parse makes it throw, naming the run, before it writes any row for that run.

## 4. Testing

- **Fixtures:** `tests/fixtures/output-digest/<tool>/` holds the tool's real console output, captured from real runs.
  - At least one passing and one failing run per tool; node:test also has a file that fails to load.
  - A `README.md` in that directory records each tool's version.
  - jest, mypy, pyright and Go are installed only into a scratch directory to capture their fixtures, and are removed afterwards.
- **Parsers:** each parser's digest of its own fixtures is checked exactly: tool, counts, every failure's name, location and message.
- **Cross-detection:** every parser returns null for every other tool's fixtures.
- **Combined output:** tsc output followed by eslint output yields two digests, in order.
- **Rendering:** every failure is listed before any details; messages are capped at 12 lines; a passing tool renders as one line.
- **`run` tool:**
  - a fitting result is the digest plus the whole output;
  - an oversized failed result is the digest, the notice and then the tail, within `FAILED_COMMAND_TAIL_CAP_TOKENS`;
  - unrecognised output behaves exactly as today.
- **Orchestrator:**
  - `runVerificationCheck` stores the digest computed from output longer than 20,000 characters;
  - each of the four renderers leads with the digest;
  - the 89 → 90 upgrade sets `digest: null`, and a real schema-89 file reopens at 90.
- **`siftkit summary`:** a pytest failure and a dotnet test failure each produce a FAIL verdict whose summary names the failing test and its location, with no model call.
