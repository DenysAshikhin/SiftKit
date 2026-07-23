# SiftKit Self-Call Drift Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragmented CLI command classification with one typed catalog, replace inline E2E polling with a reusable condition-based harness helper, and mutation-verify the existing self-call regression tests.

**Architecture:** A `CliCommandCatalog` owns command metadata and invocation resolution, so dispatch and argument consumers use one canonical result. The streamed-operation harness owns active-lock owner discovery using named timing constants and `node:timers/promises`. Temporary one-line mutations prove the existing env-marker and self-lineage tests detect broken behavior; those mutations are removed before any commit.

**Tech Stack:** TypeScript, `node:test`, `node:assert/strict`, existing SiftKit test runner.

## Global Constraints

- Follow RED-GREEN-REFACTOR for every permanent code change.
- Do not commit either temporary mutation.
- Remove `KNOWN_COMMANDS`, `BLOCKED_PUBLIC_COMMANDS`, `SERVER_DEPENDENT_COMMANDS`, `MODEL_LOCK_COMMANDS`, `getCommandName`, and `getCommandArgs` completely; do not leave compatibility exports.
- Preserve current CLI behavior, including nested hidden `eval` deadlock errors, ordinary hidden-command errors, `--prompt` shorthand, and implicit summary.
- TypeScript only. No `any`, type-assertion casts, non-null assertions, namespace imports, or compatibility shims.
- Keep functions explicit; use `node:timers/promises` rather than adding Promise callback plumbing.
- Do not use worktrees.
- Run verification commands raw; do not pipe them through SiftKit.
- Do not add or commit temporary logs or test artifacts.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `src/cli/command-catalog.ts` | Single typed source of truth for CLI command metadata and invocation resolution |
| Modify `src/cli/args.ts` | Retain option parsing and internal-op classification; remove public command sets/helpers |
| Modify `src/cli/dispatch.ts` | Resolve once through the catalog and consume command metadata |
| Modify CLI runner files listed in Task 2 | Read resolved arguments from the catalog |
| Create `tests/cli-command-catalog.test.ts` | Catalog resolution and metadata contract |
| Modify `tests/cli-command-surface.test.ts` | Assert public surface through the catalog |
| Modify `tests/helpers/streamed-op-harness.ts` | Reusable condition-based active-owner wait |
| Modify `tests/nested-agent-server-reject.test.ts` | Use harness wait and named request timing |

---

### Task 1: Mutation-verify command env regression coverage

**Files:**
- Temporarily modify, then restore: `src/lib/powershell.ts:62-68`
- Existing tests: `tests/repo-tools.test.ts`
- Existing tests: `tests/engine-command-execution.test.ts`

**Interfaces:**
- Consumes: `PowerShellAsyncOptions.env`
- Produces: verification evidence only; no committed change

- [ ] **Step 1: Add one temporary mutation**

Immediately inside the Promise body, add:

```ts
  return new Promise((resolve) => {
    options.env = {};
    const child = spawn(POWERSHELL_EXECUTABLE, [...POWERSHELL_BASE_ARGS, '-Command', command], {
```

- [ ] **Step 2: Build the mutation**

Run:

```powershell
npm run build:test
```

Expected: PASS. The temporary line is type-correct.

- [ ] **Step 3: Verify the permanent tests go RED**

Run:

```powershell
node .\dist\scripts\run-tests.js repo-tools engine-command-execution
```

Expected: FAIL in:

- `executeRun exposes SIFTKIT_AGENT_RUN_ID to spawned commands`
- `executeRepoCommand sets SIFTKIT_AGENT_RUN_ID in spawned command env`

The observed output must show the expected run IDs are missing. A compile error or unrelated failure is not valid mutation evidence.

- [ ] **Step 4: Remove the temporary mutation**

Delete only:

```ts
    options.env = {};
```

- [ ] **Step 5: Rebuild and verify GREEN**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js repo-tools engine-command-execution
```

Expected: PASS.

- [ ] **Step 6: Confirm no mutation remains**

Run:

```powershell
git diff -- src/lib/powershell.ts
```

Expected: no output.

No commit is created for this task.

---

### Task 2: Replace fragmented command sets with `CliCommandCatalog`

**Files:**
- Create: `src/cli/command-catalog.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/run-capture.ts`
- Modify: `src/cli/run-command.ts`
- Modify: `src/cli/run-config.ts`
- Modify: `src/cli/run-eval.ts`
- Modify: `src/cli/run-find-files.ts`
- Modify: `src/cli/run-install.ts`
- Modify: `src/cli/run-internal.ts`
- Modify: `src/cli/run-preset.ts`
- Modify: `src/cli/run-repo-search.ts`
- Modify: `src/cli/run-summary.ts`
- Modify: `src/cli/stdin-input.ts`
- Create: `tests/cli-command-catalog.test.ts`
- Modify: `tests/cli-command-surface.test.ts`
- Test: `tests/nested-agent-guard.test.ts`

**Interfaces:**
- Produces: `CLI_COMMAND_CATALOG.resolve(argv: string[]): CliCommandInvocation`
- Produces: `CliCommandInvocation.command` with `name`, `exposed`, `serverDependent`, and `modelLock`
- Produces: `CliCommandInvocation.args`
- Removes: all six legacy public-command sets/helpers named in Global Constraints

- [ ] **Step 1: Write failing catalog tests**

Create `tests/cli-command-catalog.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_COMMAND_CATALOG } from '../src/cli/command-catalog.js';

test('explicit hidden command resolves with one canonical definition', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['eval', '--model', 'mock-model']);
  assert.deepEqual(invocation, {
    command: {
      name: 'eval',
      exposed: false,
      serverDependent: true,
      modelLock: true,
    },
    args: ['--model', 'mock-model'],
  });
});

test('--prompt shorthand resolves to repo-search and preserves all tokens', () => {
  const argv = ['--prompt', 'find things'];
  const invocation = CLI_COMMAND_CATALOG.resolve(argv);
  assert.equal(invocation.command.name, 'repo-search');
  assert.deepEqual(invocation.args, argv);
});

test('unknown first token resolves to implicit summary and preserves all tokens', () => {
  const argv = ['raw output'];
  const invocation = CLI_COMMAND_CATALOG.resolve(argv);
  assert.equal(invocation.command.name, 'summary');
  assert.deepEqual(invocation.args, argv);
});

test('registered public command exposes its server and model-lock behavior', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['repo-agent', '--prompt', 'inspect']);
  assert.deepEqual(invocation.command, {
    name: 'repo-agent',
    exposed: true,
    serverDependent: true,
    modelLock: true,
  });
  assert.deepEqual(invocation.args, ['--prompt', 'inspect']);
});
```

- [ ] **Step 2: Run build to verify RED**

Run:

```powershell
npm run build:test
```

Expected: FAIL because `src/cli/command-catalog.ts` does not exist.

- [ ] **Step 3: Create the catalog**

Create `src/cli/command-catalog.ts`:

```ts
export type CliCommandDefinition = {
  name: string;
  exposed: boolean;
  serverDependent: boolean;
  modelLock: boolean;
};

export type CliCommandInvocation = {
  command: CliCommandDefinition;
  args: string[];
};

const CLI_COMMAND_DEFINITIONS: CliCommandDefinition[] = [
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
];

export class CliCommandCatalog {
  private readonly definitionsByName = new Map<string, CliCommandDefinition>();
  private readonly summaryDefinition: CliCommandDefinition;
  private readonly repoSearchDefinition: CliCommandDefinition;

  constructor(definitions: readonly CliCommandDefinition[]) {
    for (const definition of definitions) {
      this.definitionsByName.set(definition.name, definition);
    }
    const summaryDefinition = this.definitionsByName.get('summary');
    if (!summaryDefinition) {
      throw new Error('CLI command catalog requires summary.');
    }
    const repoSearchDefinition = this.definitionsByName.get('repo-search');
    if (!repoSearchDefinition) {
      throw new Error('CLI command catalog requires repo-search.');
    }
    this.summaryDefinition = summaryDefinition;
    this.repoSearchDefinition = repoSearchDefinition;
  }

  resolve(argv: string[]): CliCommandInvocation {
    const firstToken = argv[0];
    if (firstToken === '--prompt' || firstToken === '-prompt') {
      return { command: this.repoSearchDefinition, args: argv };
    }
    if (firstToken !== undefined) {
      const explicitDefinition = this.definitionsByName.get(firstToken);
      if (explicitDefinition) {
        return { command: explicitDefinition, args: argv.slice(1) };
      }
    }
    return { command: this.summaryDefinition, args: argv };
  }
}

export const CLI_COMMAND_CATALOG = new CliCommandCatalog(CLI_COMMAND_DEFINITIONS);
```

- [ ] **Step 4: Migrate `dispatch.ts`**

Replace the removed imports with:

```ts
import { CLI_COMMAND_CATALOG } from './command-catalog.js';
```

After help handling, resolve once:

```ts
  const invocation = CLI_COMMAND_CATALOG.resolve(options.argv);
  const commandName = invocation.command.name;
  const commandArgs = invocation.args;
  const nestedAgentRunId = readNestedAgentRunId();
  if (nestedAgentRunId && invocation.command.modelLock && commandName !== 'summary') {
    stderr.write(
      `siftkit ${commandName} is blocked inside agent run ${nestedAgentRunId}: `
      + 'the status server\'s model lock is held by the parent run, so this call would deadlock. '
      + 'Run the underlying command raw instead of routing it through siftkit.\n',
    );
    return 1;
  }
  if (!invocation.command.exposed) {
    stderr.write(`Command '${options.argv[0]}' is not exposed in this CLI build. Available commands: summary, repo-search, preset, run, help.\n`);
    return 1;
  }
```

Delete the old blocked-command branch and `nestedLockCommand` calculation.

Replace server preflight with:

```ts
    if (invocation.command.serverDependent && !(commandName === 'summary' && nestedAgentRunId)) {
```

Keep the existing validation, help handling, and switch body unchanged except that they consume `commandName` and `commandArgs` from `invocation`.

- [ ] **Step 5: Remove old command classification from `args.ts`**

Delete the complete declarations named:

- `KNOWN_COMMANDS`
- `BLOCKED_PUBLIC_COMMANDS`
- `SERVER_DEPENDENT_COMMANDS`
- `MODEL_LOCK_COMMANDS`
- `getCommandName`
- `getCommandArgs`

Retain `SERVER_DEPENDENT_INTERNAL_OPS`, option schemas, synopsis constants, validators, and `parseArguments`.

- [ ] **Step 6: Migrate every argument consumer**

In each file, import `CLI_COMMAND_CATALOG` from `./command-catalog.js` and replace the exact old call:

```ts
getCommandArgs(options.argv)
```

with:

```ts
CLI_COMMAND_CATALOG.resolve(options.argv).args
```

Apply this replacement in:

- `src/cli/run-capture.ts`
- `src/cli/run-command.ts`
- `src/cli/run-config.ts`
- `src/cli/run-eval.ts`
- `src/cli/run-find-files.ts`
- `src/cli/run-install.ts`
- `src/cli/run-internal.ts`
- `src/cli/run-preset.ts`
- `src/cli/run-repo-search.ts`
- `src/cli/run-summary.ts`

Remove `getCommandArgs` from each `./args.js` import without changing the remaining named imports.

In `src/cli/stdin-input.ts`, replace:

```ts
  const commandName = getCommandName(argv);
```

and:

```ts
  const parsed = parseArguments(getCommandArgs(argv));
```

with:

```ts
  const invocation = CLI_COMMAND_CATALOG.resolve(argv);
  const commandName = invocation.command.name;
```

and:

```ts
  const parsed = parseArguments(invocation.args);
```

Remove both old helper imports and add the catalog import.

- [ ] **Step 7: Update command-surface tests**

In `tests/cli-command-surface.test.ts`, remove the old set imports and add:

```ts
import { CLI_COMMAND_CATALOG } from '../src/cli/command-catalog.js';
```

Replace the backend test with:

```ts
test('global backend command is absent from the public command surface', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['backend']);
  assert.equal(invocation.command.name, 'summary');
  assert.deepEqual(invocation.args, ['backend']);
});
```

Replace the repo-agent set test with:

```ts
test('repo-agent is a public server-dependent command', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['repo-agent']);
  assert.equal(invocation.command.name, 'repo-agent');
  assert.equal(invocation.command.exposed, true);
  assert.equal(invocation.command.serverDependent, true);
});
```

- [ ] **Step 8: Build and verify GREEN**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js cli-command-catalog
node .\dist\scripts\run-tests.js cli-command-surface
node .\dist\scripts\run-tests.js nested-agent-guard
node .\dist\scripts\run-tests.js summary-cli
```

Expected: PASS.

- [ ] **Step 9: Verify legacy classification is gone**

Run:

```powershell
rg -n "KNOWN_COMMANDS|BLOCKED_PUBLIC_COMMANDS|SERVER_DEPENDENT_COMMANDS|MODEL_LOCK_COMMANDS|getCommandName|getCommandArgs" src tests --glob "*.ts"
```

Expected: no output.

- [ ] **Step 10: Commit**

```powershell
git add src/cli/command-catalog.ts src/cli/args.ts src/cli/dispatch.ts src/cli/run-capture.ts src/cli/run-command.ts src/cli/run-config.ts src/cli/run-eval.ts src/cli/run-find-files.ts src/cli/run-install.ts src/cli/run-internal.ts src/cli/run-preset.ts src/cli/run-repo-search.ts src/cli/run-summary.ts src/cli/stdin-input.ts tests/cli-command-catalog.test.ts tests/cli-command-surface.test.ts
git commit -m "refactor: centralize CLI command classification"
```

---

### Task 3: Replace inline owner polling and mutation-verify server rejection

**Files:**
- Modify: `tests/helpers/streamed-op-harness.ts`
- Modify: `tests/nested-agent-server-reject.test.ts`
- Temporarily modify, then restore: `src/status-server/routes/streamed-operation-endpoint.ts`

**Interfaces:**
- Produces: `waitForActiveModelRequestOwner(baseUrl: string): Promise<string>`
- Consumes: `/status` model-request diagnostics

- [ ] **Step 1: Write the failing harness usage**

In `tests/nested-agent-server-reject.test.ts`, import:

```ts
import { startHarness, waitForActiveModelRequestOwner } from './helpers/streamed-op-harness.js';
```

Add named constants:

```ts
const AGENT_LOCK_HOLD_MS = 5_000;
const SSE_REQUEST_TIMEOUT_MS = 30_000;
```

Replace `simulateWorkMs: 5000` and both `timeoutMs: 30_000` values with the constants.

Replace the inline owner polling block with:

```ts
    const ownerRunId = await waitForActiveModelRequestOwner(harness.baseUrl);
```

Remove the now-unused `asObject` and `requestJson` imports.

- [ ] **Step 2: Run build to verify RED**

Run:

```powershell
npm run build:test
```

Expected: FAIL because `waitForActiveModelRequestOwner` is not exported.

- [ ] **Step 3: Implement the condition-based helper**

In `tests/helpers/streamed-op-harness.ts`, add:

```ts
import { setTimeout as delay } from 'node:timers/promises';
```

Extend the dashboard HTTP import:

```ts
import { asObject, getAddressInfo, requestJson } from './dashboard-http.js';
```

Add:

```ts
const MODEL_REQUEST_OWNER_TIMEOUT_MS = 2_000;
const MODEL_REQUEST_OWNER_POLL_INTERVAL_MS = 10;

export async function waitForActiveModelRequestOwner(baseUrl: string): Promise<string> {
  const deadline = Date.now() + MODEL_REQUEST_OWNER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await requestJson(`${baseUrl}/status`);
    const activeRequest = asObject(asObject(status.body.modelRequests).activeRequest);
    const ownerRunId = String(activeRequest.ownerRunId || '').trim();
    if (ownerRunId) {
      return ownerRunId;
    }
    await delay(MODEL_REQUEST_OWNER_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for an active model request owner at ${baseUrl}.`);
}
```

- [ ] **Step 4: Build and verify helper GREEN**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js nested-agent-server-reject
```

Expected: PASS.

- [ ] **Step 5: Add one temporary server mutation**

Immediately before `nestedRunId` is read in `StreamedOperationEndpoint.handle`, add:

```ts
    req.headers[AGENT_RUN_ID_HEADER] = '';
```

Do not change or remove the existing rejection branch.

- [ ] **Step 6: Rebuild and verify the permanent E2E test goes RED**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js nested-agent-server-reject
```

Expected: FAIL because the matching request returns a non-409 result. The failure must be the `409` assertion, not a compile error or harness timeout.

- [ ] **Step 7: Remove the temporary mutation**

Delete only:

```ts
    req.headers[AGENT_RUN_ID_HEADER] = '';
```

- [ ] **Step 8: Rebuild and verify GREEN**

Run:

```powershell
npm run build:test
node .\dist\scripts\run-tests.js nested-agent-server-reject
node .\dist\scripts\run-tests.js streamed-op-endpoints
node .\dist\scripts\run-tests.js streamed-repo-agent-endpoint
node .\dist\scripts\run-tests.js streamed-summary-endpoint
```

Expected: PASS.

- [ ] **Step 9: Confirm the mutation is absent**

Run:

```powershell
git diff -- src/status-server/routes/streamed-operation-endpoint.ts
```

Expected: no output.

- [ ] **Step 10: Commit**

```powershell
git add tests/helpers/streamed-op-harness.ts tests/nested-agent-server-reject.test.ts
git commit -m "test: replace self-call guard polling with condition wait"
```

---

### Task 4: Full verification and directive audit

**Files:** none expected

- [ ] **Step 1: Run the full suite**

Run:

```powershell
npm test
```

Expected: PASS with zero failures.

- [ ] **Step 2: Verify removed APIs remain absent**

Run:

```powershell
rg -n "KNOWN_COMMANDS|BLOCKED_PUBLIC_COMMANDS|SERVER_DEPENDENT_COMMANDS|MODEL_LOCK_COMMANDS|getCommandName|getCommandArgs" src tests --glob "*.ts"
```

Expected: no output.

- [ ] **Step 3: Check prohibited TypeScript constructs in the task diff**

Run:

```powershell
git diff --unified=0 f753b5f..HEAD -- src tests | Select-String -Pattern '^\\+.*(?:\\bas\\s+[A-Za-z<{]|:\\s*any\\b|\\w!\\.|import\\s+\\*\\s+as)' -CaseSensitive
```

Expected: no output. `import { setTimeout as delay }` is a named import rename and is explicitly allowed.

- [ ] **Step 4: Confirm workspace state**

Run:

```powershell
git status --short
```

Expected: only the pre-existing untracked `docs/superpowers/plans/2026-07-23-siftkit-selfcall-guard.md`; no temporary mutations or artifacts.
