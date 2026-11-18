# Tool line counts: one rule, reported by every tool

**Status:** approved 2026-11-17.

**Source:** orchestrator run `c16a9829`. The orchestrator ranked `dashboard/src` files by size through `run_check` with `Get-ChildItem … | Measure-Object -Line` (turn 22), listed directories with a `Get-ChildItem` loop that doubled its own path (turn 110), and read `package.json` through `Select-String` (turn 100). No repository tool reports how long a file is. It also piped `run_check` test commands through `Select-Object -Last N` (turns 52–54, 114).

## Problem

1. **`find` and `ls` give no file sizes.** A model that wants to size an area before splitting work falls back to shell commands. `Measure-Object -Line` skips blank lines, so its counts disagree with `read`.
2. **The orchestrator's evidence and citation checks count lines differently from `read`.** `findEvidenceProblem` and `findCitationProblem` (`src/orchestrator/verification.ts:55`, `:68`) use `readFileSync(path, 'utf8').split(/\r?\n/u)`:
   - a trailing newline adds a phantom last line, so a citation one past the end passes;
   - a UTF-16 file is read as UTF-8 noise.
3. **`read` reports an empty file as one empty line** (`1: ` and `(end of file: 1 line)`). `rg`, `git`, and the orchestrator's diffstat treat it as 0 lines.
4. **`edit` reports only `Applied N edit(s) to <path>.`** After an edit, the model has to guess how far later line numbers moved; `write` reports bytes only.
5. **The orchestrator prompt does not forbid tail pipelines.** In `run_check`, `| Select-Object -Last N` gives no saving: `run_check` already keeps the digest plus the last 4,000 characters (`src/orchestrator/run.ts:85`, `src/orchestrator/handoff.ts:113`). It does shrink what the digest sees, while the result is still labelled "Digest of the whole output". When node:test fails, its failure list follows the summary, so a tail can drop the summary and earlier failures.

## The line rule

- Text is decoded as `read` decodes it: `readSourceText` (UTF-8, or UTF-16 LE/BE by BOM or shape, with CRLF normalized to LF).
- Lines are the pieces between `\n`. A trailing `\n` ends the last line; it does not start a new one. A lone `\r` stays inside its line.
- An empty file has 0 lines. Line N is 1-based.
- `rg` line numbers, `git` (blame, grep, numstat), and the orchestrator diffstat already follow this rule; they do not change.

## Design

### Shared module: `src/lib/source-lines.ts`

- `splitSourceLines(text: string): string[]`: moves here from `src/repo-search/engine/repo-tools.ts`. It returns `[]` for `''`.
- `describeFileLines(absolutePath: string): FileLines`, a discriminated union:
  - `{ kind: 'text'; lines: string[] }`;
  - `{ kind: 'binary' }`: the bytes are not UTF-16 and contain a NUL byte;
  - `{ kind: 'too_large'; bytes: number }`: the file is over `READ_MAX_BYTES` (2,000,000). That constant moves here too.
- `formatLineCount(count: number): string` returns `1 line` / `N lines`, so every tool words it the same way.
- Every consumer below goes through this module. No other code counts file lines.

### `find`

Each listed path gets a suffix: `src/a.ts (5 lines)`, `assets/logo.png (binary)`, `logs/big.log (2,400,000 bytes; too large to read)`. Only the paths shown (after the limit) are counted. `No files matched.` and the over-limit notice are unchanged.

### `ls`

Files get the same suffix as `find`. Directories stay `name/` with no count.

### `read`

- An empty file returns `<path> is empty (0 lines).` (`ok: true`) for any offset. The past-end rejection branch for empty files goes away.
- Line selection, `(end of file: N lines)`, and the past-end notice use the shared `splitSourceLines` and `formatLineCount`.

### `edit`

The result becomes `Applied 2 edit(s) to src/a.ts: lines 40-52, 88; file now 310 lines.`

- Each range is where that edit's new text now sits in the updated file, in file order. A one-line range prints as one number.
- An edit whose new text is empty prints `line N (removed)`, where N is the line the removal point now sits on.
- The total comes from `splitSourceLines` on the updated text.

### `write`

The result becomes `Wrote 1,234 bytes to src/a.ts (42 lines).`

### Orchestrator evidence and citation checks

- `findEvidenceProblem` and `findCitationProblem` read through `describeFileLines`.
- A binary or too-large file is a problem: `<path> is not a text file the checks can read`.
- `line > lines.length` is past the end. The snippet window is taken from the same lines.

### Prompts and tool descriptions

- **`find` description** (`src/repo-search/planner-protocol.ts:107`): add "Each path ends with its line count (`(binary)` or a byte size for files `read` cannot open)."
- **`ls` description** (`planner-protocol.ts:112`): add "Files end with their line count; directories do not."
- **Agent tool list** (`src/repo-search/prompts.ts:366-367`): `find: locate files by glob, each with its line count.` and `ls: list a directory one level deep, with each file's line count.`
- **Orchestrator prompt** (`src/orchestrator/prompts.ts:91-92`), after "Read and search code with your read tools, not run_check.":
  - `find and ls report each file's line count; use them to size files, not run_check.`
  - `Run checks as plain commands, with no tail pipelines (Select-Object -Last, | tail) or redirection; run_check already keeps a digest of the whole output and its final lines.`

## Testing (TDD)

- **`tests/source-lines.test.ts`** covers `splitSourceLines` and `describeFileLines` on fixtures: LF, CRLF, no final newline, empty, a single `\n`, UTF-16 LE with BOM, a lone `\r`, binary (NUL byte), and over `READ_MAX_BYTES`.
- **`tests/repo-tools.test.ts`**:
  - `find` and `ls` show counts, binary, and too-large suffixes;
  - an empty-file read;
  - edit ranges for an insert, a multi-line replacement, a removal, and two edits in one call;
  - the write total;
  - the existing `end of file`, `No files matched.`, and past-end tests keep passing, and the "planRead rejects an offset past the end of an empty file" test is replaced by the empty-file notice.
- **`tests/orchestrator-verification.test.ts`**:
  - a trailing-newline file accepts line N and rejects N+1;
  - a UTF-16 file's snippet is found;
  - a binary file is a problem.
- **Cross-tool agreement test**, run on shared text fixtures (`tests/helpers/line-count-fixtures.ts`). For each fixture, these all report the same N:
  - the `find` suffix and the `ls` suffix;
  - `read`'s `(end of file: N …)`, or the empty notice when N is 0;
  - `findCitationProblem` accepts line N and rejects line N+1.

  That is `tests/line-count-agreement.test.ts`. The default suite forbids spawning `rg`, so the grep check lives in `tests/process/repo-tools.test.ts`: the last line number from `grep pattern="."` equals N for fixtures whose last line is not blank. The `edit` total is covered by its own repo-tools test.
- **Prompts:**
  - `tests/orchestrator-prompts.test.ts` asserts both orchestrator lines;
  - `tests/repo-search-prompts.test.ts` asserts the agent tool-list lines;
  - `tests/repo-search-planner-protocol.test.ts` asserts the `find`/`ls` descriptions.

## Out of scope

- The summary tool's `read_lines` (`src/summary/planner/tools.ts`): it numbers command output, not repository files.
- Current-length totals in the orchestrator diffstat.
- Changing `rg` or `git` line numbering.

## Validation

`npm run typecheck`, `npm run lint`, the touched test files, the full `npm test`, and the dashboard tests (`npx vitest run --config ./dashboard/vitest.config.ts`).
