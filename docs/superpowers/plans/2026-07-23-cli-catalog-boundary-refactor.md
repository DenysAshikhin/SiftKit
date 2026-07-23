# Typed CLI Catalog Boundary Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CLI command names literal-typed, resolve command arguments once in dispatch, derive the displayed public surface from the catalog, and remove the nested-agent test's global stderr replacement.

**Architecture:** The literal command-definition tuple produces the `CliCommandName` union and runtime catalog. `runCli` owns resolution and passes resolved `args` to runners; runners never import the catalog. The catalog publishes exposed command names, and dispatch is exhaustive over the derived union.

**Tech Stack:** TypeScript, `node:test`, `node:assert/strict`, existing SiftKit CLI test runner.

## Global Constraints

- Follow RED-GREEN-REFACTOR for permanent production changes.
- Do not preserve runner `argv` compatibility overloads or aliases.
- Do not add type-assertion casts, `any`, non-null assertions, namespace imports, or dynamically-passed functions.
- `as const` and `satisfies` are allowed for literal inference.
- Preserve CLI syntax, command behavior, nested-summary passthrough, and stdin behavior.
- Run verification commands raw because the local SiftKit service is unavailable.
- Preserve the user's untracked `docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| Modify `src/cli/command-catalog.ts` | Literal-derived command types and exposed-command names |
| Modify `src/cli/dispatch.ts` | Single resolution point, derived error output, exhaustive dispatch |
| Modify CLI runner files listed in Task 2 | Consume resolved `args`; no catalog imports |
| Modify `tests/cli-command-catalog.test.ts` | Catalog public-surface and runner-boundary contracts |
| Modify `tests/cli-command-surface.test.ts` | End-to-end exposed-command error output |
| Modify `tests/nested-agent-guard.test.ts` | Remove process-global stderr function replacement |

---

### Task 1: Derive command types and exposed names from the catalog

**Files:**
- Modify: `tests/cli-command-catalog.test.ts`
- Modify: `tests/cli-command-surface.test.ts`
- Modify: `src/cli/command-catalog.ts`
- Modify: `src/cli/dispatch.ts`

**Interfaces:**
- Produces: `CliCommandName`
- Produces: `CLI_COMMAND_CATALOG.exposedCommandNames`
- Preserves: `CLI_COMMAND_CATALOG.resolve(argv): CliCommandInvocation`

- [ ] **Step 1: Add the failing catalog test**

Append to `tests/cli-command-catalog.test.ts`:

```ts
test('catalog lists every exposed command in definition order', () => {
  assert.deepEqual(CLI_COMMAND_CATALOG.exposedCommandNames, [
    'summary',
    'repo-search',
    'repo-agent',
    'preset',
    'run',
    'find-files',
    'internal',
  ]);
});
```

- [ ] **Step 2: Strengthen the end-to-end public-surface assertion**

In `tests/cli-command-surface.test.ts`, capture the error for each blocked command and assert:

```ts
    const errorText = stderr.read();
    assert.match(errorText, /not exposed in this CLI build/u);
    assert.match(
      errorText,
      /Available commands: summary, repo-search, repo-agent, preset, run, find-files, internal, help\./u,
    );
```

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```powershell
npm run typecheck:test
node .\dist\scripts\run-tests.js cli-command-catalog cli-command-surface
```

Expected: TypeScript fails because `exposedCommandNames` does not exist, or the focused runtime test fails on the incomplete hardcoded list. Both failures must point to the new requirements.

- [ ] **Step 4: Implement literal-derived command types**

Replace the widened declarations at the top of `src/cli/command-catalog.ts` with:

```ts
type CliCommandMetadata = {
  exposed: boolean;
  serverDependent: boolean;
  modelLock: boolean;
};

const CLI_COMMAND_DEFINITIONS = [
  { name: 'summary', exposed: true, serverDependent: true, modelLock: true },
  { name: 'repo-search', exposed: true, serverDependent: true, modelLock: true },
  { name: 'repo-agent', exposed: true, serverDependent: true, modelLock: true },
  { name: 'preset', exposed: true, serverDependent: true, modelLock: false },
  { name: 'run', exposed: true, serverDependent: false, modelLock: true },
  { name: 'find-files', exposed: true, serverDependent: false, modelLock: false },
  { name: 'internal', exposed: true, serverDependent: false, modelLock: false },
  { name: 'install', exposed: false, serverDependent: true, modelLock: false },
  { name: 'test', exposed: false, serverDependent: true, modelLock: false },
  { name: 'eval', exposed: false, serverDependent: true, modelLock: true },
  { name: 'codex-policy', exposed: false, serverDependent: false, modelLock: false },
  { name: 'install-global', exposed: false, serverDependent: false, modelLock: false },
  { name: 'config-get', exposed: false, serverDependent: true, modelLock: false },
  { name: 'config-set', exposed: false, serverDependent: true, modelLock: false },
  { name: 'capture-internal', exposed: false, serverDependent: true, modelLock: false },
] as const satisfies readonly ({ name: string } & CliCommandMetadata)[];

export type CliCommandName = (typeof CLI_COMMAND_DEFINITIONS)[number]['name'];
export type CliCommandDefinition = (typeof CLI_COMMAND_DEFINITIONS)[number];

export type CliCommandInvocation = {
  command: CliCommandDefinition;
  args: string[];
};
```

Keep the class, but type its definitions and compute exposed names without callback helpers:

```ts
export class CliCommandCatalog {
  private readonly definitionsByName = new Map<string, CliCommandDefinition>();
  private readonly summaryDefinition: CliCommandDefinition;
  private readonly repoSearchDefinition: CliCommandDefinition;
  readonly exposedCommandNames: readonly CliCommandName[];

  constructor(definitions: readonly CliCommandDefinition[]) {
    const exposedCommandNames: CliCommandName[] = [];
    for (const definition of definitions) {
      this.definitionsByName.set(definition.name, definition);
      if (definition.exposed) {
        exposedCommandNames.push(definition.name);
      }
    }
    this.exposedCommandNames = exposedCommandNames;
    // Retain the existing required summary/repo-search checks.
  }
}
```

- [ ] **Step 5: Derive the public-command error from the catalog**

In `src/cli/dispatch.ts`, add:

```ts
const availableCommands = [...CLI_COMMAND_CATALOG.exposedCommandNames, 'help'].join(', ');
```

Use it in the not-exposed error:

```ts
stderr.write(
  `Command '${options.argv[0]}' is not exposed in this CLI build. Available commands: ${availableCommands}.\n`,
);
```

- [ ] **Step 6: Run focused tests to verify GREEN**

Run:

```powershell
npm run typecheck:test
node .\dist\scripts\run-tests.js cli-command-catalog cli-command-surface
```

Expected: typecheck and both focused test files pass.

- [ ] **Step 7: Commit**

```powershell
git add src/cli/command-catalog.ts src/cli/dispatch.ts tests/cli-command-catalog.test.ts tests/cli-command-surface.test.ts
git commit -m "refactor: derive typed CLI command surface"
```

---

### Task 2: Resolve once and pass args to runners

**Files:**
- Modify: `tests/cli-command-catalog.test.ts`
- Modify: `src/cli/dispatch.ts`
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

**Interfaces:**
- Consumes: `CliCommandInvocation.args`
- Produces: runner options with `args: string[]`
- Removes: catalog imports and raw `argv` resolution from all runners

- [ ] **Step 1: Add the failing runner-boundary test**

Add imports and the runner list to `tests/cli-command-catalog.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

const RESOLVED_ARGS_RUNNERS = [
  'run-capture.ts',
  'run-command.ts',
  'run-config.ts',
  'run-eval.ts',
  'run-find-files.ts',
  'run-install.ts',
  'run-internal.ts',
  'run-preset.ts',
  'run-repo-agent.ts',
  'run-repo-search.ts',
  'run-summary.ts',
] as const;
```

Append:

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

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
node .\dist\scripts\run-tests.js cli-command-catalog
```

Expected: FAIL identifying the first runner that still imports `command-catalog.js` or accepts `argv`.

- [ ] **Step 3: Change runner inputs to resolved args**

For each listed runner:

1. Remove the `CLI_COMMAND_CATALOG` import.
2. Replace `argv: string[]` with `args: string[]` in the runner options.
3. Replace:

```ts
parseArguments(CLI_COMMAND_CATALOG.resolve(options.argv).args)
```

with:

```ts
parseArguments(options.args)
```

For `run-repo-search.ts`, replace:

```ts
const tokens = CLI_COMMAND_CATALOG.resolve(options.argv).args;
```

with:

```ts
const tokens = options.args;
```

Change the `runRepoSearchCli` and `runRepoAgentCli` wrapper option types to `args: string[]` so neither wrapper preserves raw `argv`.

For `run-install.ts`, apply the same `args` contract independently to `runCodexPolicyCli` and `runInstallGlobalCli`.

- [ ] **Step 4: Make dispatch consume the single invocation**

In `src/cli/dispatch.ts`, pass `commandArgs` to every migrated runner:

```ts
args: commandArgs
```

Do not pass `options.argv` to those runners. Keep raw `options.argv` only where it is required for the original error token.

Add an explicit exhaustive helper:

```ts
function failUnknownCommand(commandName: never): never {
  throw new Error(`Unhandled CLI command: ${commandName}`);
}
```

Replace the switch default:

```ts
      default:
        return failUnknownCommand(commandName);
```

This must compile only while every literal `CliCommandName` has a case.

- [ ] **Step 5: Verify focused GREEN**

Run:

```powershell
npm run typecheck:test
node .\dist\scripts\run-tests.js cli-command-catalog cli-command-surface cli-stdin-input cli-run-shell cli-preset cli-internal summary-cli repo-search-cli repo-agent-cli nested-agent-guard
```

Expected: typecheck and all focused CLI tests pass.

- [ ] **Step 6: Confirm catalog resolution is limited to the two boundaries**

Run:

```powershell
rg -n "CLI_COMMAND_CATALOG\.resolve" src\cli
```

Expected output contains only:

- `src/cli/dispatch.ts`
- `src/cli/stdin-input.ts`

- [ ] **Step 7: Commit**

```powershell
git add src/cli/dispatch.ts src/cli/run-capture.ts src/cli/run-command.ts src/cli/run-config.ts src/cli/run-eval.ts src/cli/run-find-files.ts src/cli/run-install.ts src/cli/run-internal.ts src/cli/run-preset.ts src/cli/run-repo-agent.ts src/cli/run-repo-search.ts src/cli/run-summary.ts tests/cli-command-catalog.test.ts
git commit -m "refactor: resolve CLI commands at dispatch boundary"
```

---

### Task 3: Remove the global stderr replacement

**Files:**
- Modify: `tests/nested-agent-guard.test.ts`

**Interfaces:**
- Preserves: nested `eval` fail-fast behavior
- Removes: `runGuardedCliWithProcessStderr` and assignment to `process.stderr.write`

- [ ] **Step 1: Establish the GREEN refactor baseline**

Run:

```powershell
node .\dist\scripts\run-tests.js nested-agent-guard
```

Expected: all nested-agent guard tests pass before test-only refactoring.

- [ ] **Step 2: Remove the global replacement**

Delete `runGuardedCliWithProcessStderr` entirely. Change:

```ts
const result = await runGuardedCliWithProcessStderr(['eval', '--model', 'mock-model']);
```

to:

```ts
const result = await runGuardedCli(['eval', '--model', 'mock-model']);
```

Delete:

```ts
assert.doesNotMatch(result.processStderr, /http_client\b/);
```

Keep the exit code, deadlock message, and empty stdout assertions. The dead status-server URLs in `runGuardedCli` make accidental HTTP contact fail the test.

- [ ] **Step 3: Verify the refactor stays GREEN**

Run:

```powershell
node .\dist\scripts\run-tests.js nested-agent-guard nested-agent-server-reject
```

Expected: all focused nested-agent tests pass.

- [ ] **Step 4: Confirm no global function replacement remains**

Run:

```powershell
rg -n "process\.stderr\.write\s*=|runGuardedCliWithProcessStderr|patchedWrite" tests\nested-agent-guard.test.ts
```

Expected: no output.

- [ ] **Step 5: Commit**

```powershell
git add tests/nested-agent-guard.test.ts
git commit -m "test: remove global stderr replacement"
```

---

### Task 4: Full verification and review

**Files:**
- Verify all committed changes
- Preserve: `docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md`

- [ ] **Step 1: Run the full suite**

Run:

```powershell
npm test
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Audit directive compliance**

Run:

```powershell
rg -n "CLI_COMMAND_CATALOG\.resolve" src\cli
rg -n "process\.stderr\.write\s*=|runGuardedCliWithProcessStderr|patchedWrite" tests\nested-agent-guard.test.ts
rg -n "KNOWN_COMMANDS|BLOCKED_PUBLIC_COMMANDS|SERVER_DEPENDENT_COMMANDS|MODEL_LOCK_COMMANDS|getCommandName|getCommandArgs" src tests --glob "*.ts"
git diff --check 56365c6..HEAD
```

Expected:

- Catalog resolution appears only in dispatch and stdin-input.
- The dynamic stderr replacement scan has no output.
- Removed legacy classifier scan has no output.
- Diff check has no output.

- [ ] **Step 3: Audit prohibited TypeScript additions**

Run:

```powershell
git diff --unified=0 56365c6..HEAD -- src tests | Select-String -Pattern '^\+.*(?:\bas\s+[A-Za-z<{]|:\s*any\b|\w!\.|import\s+\*\s+as)' -CaseSensitive
```

Expected: only allowed named import renames or `as const`, if any. Inspect every match; no prohibited construct may remain.

- [ ] **Step 4: Request code review**

Review `56365c6..HEAD` against:

- `docs/superpowers/specs/2026-07-23-cli-catalog-boundary-design.md`
- this plan
- active `AGENTS.md` directives

Fix all Critical and Important findings with TDD before proceeding.

- [ ] **Step 5: Verify final workspace state**

Run:

```powershell
git status --short
```

Expected: only the preserved user-owned untracked file:

```text
?? docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md
```
