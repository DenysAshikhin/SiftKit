# CLI Resolved Arguments Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded runner source scan with a shared `ResolvedCliArgs` TypeScript contract and existing behavior-level CLI coverage.

**Architecture:** `src/cli/args.ts` owns the shared resolved-arguments type already consumed conceptually by every runner. Runner option signatures use that type, while runtime command resolution remains in dispatch and stdin detection. The test suite validates the type contract and CLI behavior without reading production source files.

**Tech Stack:** TypeScript, `node:test`, `node:assert/strict`, existing SiftKit test runner.

## Global Constraints

- Do not change runtime CLI behavior or public syntax.
- Do not reintroduce raw `argv` runner options.
- Do not add source parsing, lint dependencies, compatibility aliases, casts, `any`, non-null assertions, namespace imports, or dynamically-passed functions.
- Do not modify duplicate-command handling or exhaustive-dispatch validation.
- Follow RED-GREEN-REFACTOR.
- Run verification commands raw because the local SiftKit service is unavailable.
- Preserve the user-owned untracked `docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| Modify `src/cli/args.ts` | Define `ResolvedCliArgs` |
| Modify runner files listed in Task 1 | Reuse the shared contract in runner option signatures |
| Modify `tests/cli-command-catalog.test.ts` | Replace source scanning with a compile-time contract fixture |

---

### Task 1: Replace source scanning with the shared args contract

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `src/cli/run-capture.ts`
- Modify: `src/cli/run-command.ts`
- Modify: `src/cli/run-config.ts`
- Modify: `src/cli/run-eval.ts`
- Modify: `src/cli/run-find-files.ts`
- Modify: `src/cli/run-install.ts`
- Modify: `src/cli/run-internal.ts`
- Modify: `src/cli/run-preset.ts`
- Modify: `src/cli/run-repo-agent.ts`
- Modify: `src/cli/run-repo-search.ts`
- Modify: `src/cli/run-summary.ts`
- Modify: `tests/cli-command-catalog.test.ts`

**Interfaces:**
- Produces: `ResolvedCliArgs = { args: string[] }`
- Consumes: runner option intersections with `ResolvedCliArgs`
- Removes: filesystem imports, `RESOLVED_ARGS_RUNNERS`, and production-source regex assertions

- [ ] **Step 1: Add the failing type-contract fixture**

In `tests/cli-command-catalog.test.ts`, add:

```ts
import type { ResolvedCliArgs } from '../src/cli/args.js';

const RESOLVED_ARGS_FIXTURE = {
  args: ['--question', 'did it pass?'],
} satisfies ResolvedCliArgs;
```

Append:

```ts
test('resolved CLI arguments contain only command argument tokens', () => {
  assert.deepEqual(RESOLVED_ARGS_FIXTURE.args, ['--question', 'did it pass?']);
});
```

Do not remove the existing source scan yet.

- [ ] **Step 2: Run typecheck to verify RED**

Run:

```powershell
npm run typecheck:test
```

Expected: FAIL with `TS2305` because `ResolvedCliArgs` is not exported by `src/cli/args.ts`.

- [ ] **Step 3: Add the minimal shared type**

In `src/cli/args.ts`, immediately after `CliRunOptions`, add:

```ts
export type ResolvedCliArgs = {
  args: string[];
};
```

- [ ] **Step 4: Migrate runner signatures to the shared contract**

For runners that already import values from `args.ts`, add `type ResolvedCliArgs` to the named import:

```ts
import { parseArguments, type ResolvedCliArgs } from './args.js';
```

Change each runner signature from:

```ts
options: {
  args: string[];
  // existing fields
}
```

to:

```ts
options: ResolvedCliArgs & {
  // existing fields
}
```

Apply that exact contract to:

- `runCaptureInternalCli` in `src/cli/run-capture.ts`
- `runCommandCli` in `src/cli/run-command.ts`
- `runConfigSet` in `src/cli/run-config.ts`
- `runEvalCli` in `src/cli/run-eval.ts`
- `runFindFiles` in `src/cli/run-find-files.ts`
- `runCodexPolicyCli` and `runInstallGlobalCli` in `src/cli/run-install.ts`
- `runInternal` in `src/cli/run-internal.ts`
- `runPresetCli` in `src/cli/run-preset.ts`
- `runRepoTaskCli` and `runRepoSearchCli` in `src/cli/run-repo-search.ts`
- `runSummary` in `src/cli/run-summary.ts`

In `src/cli/run-repo-agent.ts`, add:

```ts
import type { ResolvedCliArgs } from './args.js';
```

and change:

```ts
export async function runRepoAgentCli(options: ResolvedCliArgs & {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
}): Promise<number> {
```

Do not change any parsing or runtime logic.

- [ ] **Step 5: Run typecheck and focused behavior tests to verify GREEN**

Run:

```powershell
npm run typecheck:test
node .\dist\scripts\run-tests.js cli-command-catalog cli-command-surface cli-stdin-input cli-run-shell cli-preset cli-internal summary-cli repo-search-cli repo-agent-cli nested-agent-guard
```

Expected: typecheck passes and all focused CLI tests pass.

- [ ] **Step 6: Remove the brittle source scan**

From `tests/cli-command-catalog.test.ts`, delete:

```ts
import fs from 'node:fs';
import path from 'node:path';
```

Delete the complete `RESOLVED_ARGS_RUNNERS` constant and:

```ts
test('CLI runners consume resolved args without resolving the command again', () => {
  for (const fileName of RESOLVED_ARGS_RUNNERS) {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', fileName), 'utf8');
    assert.doesNotMatch(source, /command-catalog\.js/u, fileName);
    assert.doesNotMatch(source, /\bargv:\s*string\[\]/u, fileName);
    assert.doesNotMatch(source, /CLI_COMMAND_CATALOG\.resolve/u, fileName);
  }
});
```

- [ ] **Step 7: Verify the refactor remains GREEN**

Run:

```powershell
npm run typecheck:test
node .\dist\scripts\run-tests.js cli-command-catalog cli-command-surface cli-stdin-input cli-run-shell cli-preset cli-internal summary-cli repo-search-cli repo-agent-cli nested-agent-guard
```

Expected: typecheck and all focused CLI tests pass without source inspection.

- [ ] **Step 8: Confirm the hardcoded architecture test is gone**

Run:

```powershell
rg -n "RESOLVED_ARGS_RUNNERS|readFileSync|doesNotMatch" tests\cli-command-catalog.test.ts
```

Expected: no output.

- [ ] **Step 9: Commit**

```powershell
git add src/cli/args.ts src/cli/run-capture.ts src/cli/run-command.ts src/cli/run-config.ts src/cli/run-eval.ts src/cli/run-find-files.ts src/cli/run-install.ts src/cli/run-internal.ts src/cli/run-preset.ts src/cli/run-repo-agent.ts src/cli/run-repo-search.ts src/cli/run-summary.ts tests/cli-command-catalog.test.ts
git commit -m "refactor: share resolved CLI args contract"
```

---

### Task 2: Full verification and review

**Files:**
- Verify all Task 1 changes
- Preserve: `docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md`

- [ ] **Step 1: Run the full suite**

Run:

```powershell
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Audit the requested fix**

Run:

```powershell
rg -n "ResolvedCliArgs" src\cli tests\cli-command-catalog.test.ts
rg -n "RESOLVED_ARGS_RUNNERS|readFileSync|doesNotMatch\\(source" tests\cli-command-catalog.test.ts
rg -n "CLI_COMMAND_CATALOG\.resolve" src\cli
git diff --check e7613ae..HEAD
```

Expected:

- The shared contract appears in `args.ts`, all affected runners, and the contract fixture.
- The removed source-scan patterns have no output.
- Catalog resolution remains only in `dispatch.ts` and `stdin-input.ts`.
- Diff check has no output.

- [ ] **Step 3: Audit prohibited TypeScript additions**

Run:

```powershell
git diff --unified=0 e7613ae..HEAD -- src tests | Select-String -Pattern '^\+.*(?:\bas\s+[A-Za-z<{]|:\s*any\b|\w!\.|import\s+\*\s+as)' -CaseSensitive
```

Expected: only allowed `satisfies`/named-import syntax, if any; no prohibited construct.

- [ ] **Step 4: Request read-only code review**

Review `e7613ae..HEAD` against:

- `docs/superpowers/specs/2026-07-23-cli-resolved-args-contract-design.md`
- this plan
- supplied `AGENTS.md` directives

Fix all Critical and Important findings before proceeding.

- [ ] **Step 5: Verify workspace state**

Run:

```powershell
git status --short
```

Expected: only:

```text
?? docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md
```
