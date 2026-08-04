# Repo-Agent Harness Tool-Call Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four harness defects found in the 2026-08-04 repo-agent transcript audit: `grep context:0` rejection loops, content-blind duplicate fingerprints for `edit`/`write`, junk entries in the model inventory, and the non-TTY approval flow's missing answer contract / infinite decision wait / stale dead-worker state.

**Architecture:** All four fixes are localized. Task 1 relaxes one integer guard in the grep executor. Task 2 makes the synthetic command string (the single source for transcript display, exact-duplicate keys, and loop-governor fingerprints) content-sensitive by appending a short sha256 digest for `edit`/`write`. Task 3 intersects the inference server's `/v1/models` listing with preset-declared model names before it reaches the inventory. Task 4 extends the `approval_required` CLI result with an explicit decide-command contract, gives the worker-side approval wait a timeout that resolves to a deny, and makes `repo-agent status` reconcile dead worker pids to `failed`.

**Tech Stack:** TypeScript (strict), zod runtime schemas, node:test + node:assert/strict, node:crypto.

**Background evidence (from the audit of runs 3067e4fb / bd2b7b02 / 40fbbaf8 / 7796c692 / 71dd82a6):**
- Run 7796c692 (task 3b) burned 87 of 91 turns re-sending `grep ... context:0`; the executor rejects 0 while the planner schema (`src/repo-search/planner-protocol.ts:114`) documents `default: 0`.
- Run 40fbbaf8 (task 3a) died in forced-finish because a second, *different* single-edit to `src/summary/chunking.ts` rendered the identical command `edit path="src/summary/chunking.ts" edits=1` and was rejected as an exact duplicate on first issuance.
- `model_inventory.availableModels` contained `.git`, `node_modules`, `datasets`, etc. — TabbyAPI lists every subdirectory of ModelRoot.
- Run 71dd82a6 (task 6) emitted `approval_required` correctly, but the JSON carries no answer schema, the worker polls for a decision forever (a worker survived 32 hours until manually killed), and `repo-agent status` parrots stale `running`/`approval_required` state for dead pids (three such records exist under `.siftkit/repo-agent/runs`).

**Repo rules that bind every task:** TDD (write the failing test, watch it fail, then implement); no type-assertion casts (`x as T`, `<T>x`), no `any`, no non-null `!`, no namespace imports (`import * as X`); no back-compat shims — dependent tests get updated, not aliased; DRY; typed end-to-end with zod at IO boundaries.

---

### Task 1: `grep` accepts `context: 0`

The planner tool schema advertises `context` with "default: 0" but `executeGrep` rejects 0 via `resolveOptionalPositiveInteger`. Treat 0 exactly like an omitted `context` (ripgrep gets no `--context` flag) and reword the rejection for genuinely invalid values.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:637-640` (the `contextLines` resolution inside `executeGrep`)
- Test: `tests/repo-tools.test.ts` (two new tests; two updated expectations at lines 897-905)

- [ ] **Step 1: Write the failing tests**

In `tests/repo-tools.test.ts`, insert immediately before the existing test `'grep limit removes the detached context group of the first omitted match'`:

```ts
test('grep accepts context 0 as matches-only output', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'grep',
    { pattern: 'alpha', path: 'src/a.ts', context: 0 },
    makeContext(root),
  );
  assert.ok(result.ok, `grep context 0 rejected: ${result.ok ? '' : result.reason}`);
  const lines = result.output.split(/\r\n|\r|\n/u).filter((line) => line.trim() !== '');
  assert.deepEqual(lines, ['src/a.ts:2:alpha', 'src/a.ts:4:alpha']);
});

test('grep rejects a negative context', async () => {
  const root = makeRepo();
  const result = await executeRepoTool(
    'grep',
    { pattern: 'alpha', path: 'src/a.ts', context: -1 },
    makeContext(root),
  );
  assert.ok(!result.ok);
  assert.match(result.reason, /context must be a non-negative integer/u);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- repo-tools`
Expected: exactly these two failures —
- `grep accepts context 0 as matches-only output` fails with `grep context 0 rejected: context must be a positive integer`
- `grep rejects a negative context` fails because the actual reason is `'context must be a positive integer'`, not the new non-negative wording

- [ ] **Step 3: Implement the fix**

In `src/repo-search/engine/repo-tools.ts`, inside `executeGrep`, replace:

```ts
  const contextLines = resolveOptionalPositiveInteger(
    args.context,
    'context must be a positive integer',
  );
```

with:

```ts
  // The planner tool schema documents context's default as 0, so 0 must parse as "matches only".
  const contextLines = resolveOptionalPositiveInteger(
    args.context === 0 ? undefined : args.context,
    'context must be a non-negative integer',
  );
```

No change to `buildGrepArgs` — `contextLines === undefined` already omits `--context`, which is byte-identical rg behavior to `--context 0`.

- [ ] **Step 4: Update the two dependent table entries**

In `tests/repo-tools.test.ts`, test `'repo tools reject present positive-integer arguments instead of coercing them'` (invalid-cases table around lines 896-905), update both grep entries:

```ts
    {
      toolName: 'grep',
      args: { pattern: 'alpha', context: 1.5 },
      expectedReason: 'context must be a non-negative integer',
    },
    {
      toolName: 'grep',
      args: { pattern: 'alpha', context: null },
      expectedReason: 'context must be a non-negative integer',
    },
```

- [ ] **Step 5: Run the suite to verify green**

Run: `npm test -- repo-tools`
Expected: PASS, zero failures.

- [ ] **Step 6: Commit**

```bash
git add tests/repo-tools.test.ts src/repo-search/engine/repo-tools.ts
git commit -m "fix: accept grep context 0 as matches-only per the planner schema default"
```

---

### Task 2: content-sensitive duplicate keys for `edit` and `write`

The synthetic command string is the single source for the transcript label, the exact-duplicate key (`successfulNormalizedKeys`), and the loop-governor fingerprint (`normalizeRepoSearchFingerprint(command)` in `src/tool-loop-governor.ts:96-99`). For `edit` it renders only `edit path="X" edits=N` and for `write` only `write path="X" bytes=N`, so two different mutations of the same file collide. Append a 10-hex sha256 digest of the mutation content so distinct mutations get distinct keys while identical re-issues still collapse.

**Files:**
- Modify: `src/repo-search/engine/repo-tools.ts:198-209` (the `write`/`edit` branches of `buildRepoToolRequestedCommand`) plus two small helpers and one import
- Test: `tests/repo-tools.test.ts` (two new tests; updated expectations at lines 76-80)

- [ ] **Step 1: Write the failing tests**

In `tests/repo-tools.test.ts`, insert after the test `'buildRepoToolRequestedCommand covers every tool'`:

```ts
test('edit command strings differ when edit content differs', () => {
  const first = buildRepoToolRequestedCommand('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha', newText: 'beta' }],
  });
  const second = buildRepoToolRequestedCommand('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'line1', newText: 'line0' }],
  });
  const repeat = buildRepoToolRequestedCommand('edit', {
    path: 'src/a.ts',
    edits: [{ oldText: 'alpha', newText: 'beta' }],
  });
  assert.notEqual(first, second);
  assert.equal(first, repeat);
});

test('write command strings differ when content differs at equal byte length', () => {
  const first = buildRepoToolRequestedCommand('write', { path: 'src/w.ts', content: 'AAAA' });
  const second = buildRepoToolRequestedCommand('write', { path: 'src/w.ts', content: 'BBBB' });
  assert.notEqual(first, second);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- repo-tools`
Expected: both new tests FAIL on `assert.notEqual` — today both renderings collapse to `edit path="src/a.ts" edits=1` and `write path="src/w.ts" bytes=4`.

- [ ] **Step 3: Implement the digests**

In `src/repo-search/engine/repo-tools.ts`:

Add to the imports at the top of the file:

```ts
import { createHash } from 'node:crypto';
```

Add these helpers next to `formatToolCommand` (the "Synthetic command strings" section):

```ts
function shortSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 10);
}

/** Order-stable digest over the (oldText, newText) pairs so key order in the model's JSON cannot split fingerprints. */
function editContentDigest(edits: OptionalJsonValue): string {
  const pairs = Array.isArray(edits)
    ? edits.map((edit) => (
      edit !== null && typeof edit === 'object' && !Array.isArray(edit)
        ? [readString(edit.oldText), readString(edit.newText)]
        : []
    ))
    : [];
  return shortSha256(JSON.stringify(pairs));
}
```

Replace the `write` and `edit` branches of `buildRepoToolRequestedCommand` (currently lines 198-209):

```ts
  if (toolName === 'write') {
    const content = typeof args.content === 'string' ? args.content : '';
    return formatToolCommand('write', [
      ['path', readString(args.path)],
      ['bytes', Buffer.byteLength(content, 'utf8')],
      ['sha', shortSha256(content)],
    ]);
  }
  if (toolName === 'edit') {
    return formatToolCommand('edit', [
      ['path', readString(args.path)],
      ['edits', Array.isArray(args.edits) ? args.edits.length : 0],
      ['sha', editContentDigest(args.edits)],
    ]);
  }
```

- [ ] **Step 4: Update the rendering expectations**

In `tests/repo-tools.test.ts`, test `'buildRepoToolRequestedCommand covers every tool'` (lines 76-80), replace:

```ts
  assert.equal(buildRepoToolRequestedCommand('write', { path: 'x.ts', content: 'abc' }), 'write path="x.ts" bytes=3');
  assert.equal(
    buildRepoToolRequestedCommand('edit', { path: 'x.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
    'edit path="x.ts" edits=1',
  );
```

with (digests precomputed: sha256 of the raw string `abc` starts `ba7816bf8f`; sha256 of `JSON.stringify([['a','b']])` starts `db8992cf94`):

```ts
  assert.equal(
    buildRepoToolRequestedCommand('write', { path: 'x.ts', content: 'abc' }),
    'write path="x.ts" bytes=3 sha="ba7816bf8f"',
  );
  assert.equal(
    buildRepoToolRequestedCommand('edit', { path: 'x.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
    'edit path="x.ts" edits=1 sha="db8992cf94"',
  );
```

(Other test files contain literals like `edit path=src/example.ts edits=1`, e.g. `tests/repo-agent-command.test.ts:153` — those are opaque fixture strings fed into stores, not renderer output, and must NOT be changed.)

- [ ] **Step 5: Run the affected suites to verify green**

Run: `npm test -- repo-tools mock-repo-search-loop repo-search-loop.core`
Expected: PASS. The loop suites exercise the duplicate tracker end-to-end; they must show no new duplicate-rejection behavior for identical repeats (identical commands still collapse — the digest is deterministic).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/repo-tools.test.ts src/repo-search/engine/repo-tools.ts
git commit -m "fix: include content digests in edit/write command keys so distinct mutations are not duplicates"
```

---

### Task 3: filter non-model junk out of the model inventory

`listLlamaCppModels` forwards the inference server's `/v1/models` listing verbatim; TabbyAPI answers with every subdirectory of ModelRoot (`.git`, `node_modules`, `datasets`, `archive`, ...). Intersect the server list with the model names declared by config presets (`config.Server.ModelPresets.Presets[].Model`) — the inventory's only consumers are `assertConfiguredModelPresent` (whose needle is itself a preset `Model`) and the `model_inventory` log line, so nothing is lost.

**Files:**
- Modify: `src/providers/llama-cpp.ts:364-373` (`listLlamaCppModels`) plus one new exported pure function
- Test: create `tests/model-inventory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/model-inventory.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { filterModelInventory } from '../src/providers/llama-cpp.js';

test('filterModelInventory keeps only preset-backed model names', () => {
  assert.deepEqual(
    filterModelInventory(
      ['.git', 'node_modules', '3.6_27b_4.7bpw', 'datasets', 'transformers'],
      ['3.6_27b_4.7bpw', null],
    ),
    ['3.6_27b_4.7bpw'],
  );
});

test('filterModelInventory ignores blank and null preset entries', () => {
  assert.deepEqual(filterModelInventory(['a', 'b'], [null, '  ', 'b']), ['b']);
});

test('filterModelInventory with no presets yields an empty inventory', () => {
  assert.deepEqual(filterModelInventory(['.git', 'archive'], []), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- model-inventory`
Expected: FAIL at build/typecheck with `Module '"../src/providers/llama-cpp.js"' has no exported member 'filterModelInventory'` (the repo's `npm test` runs typecheck first — a compile failure is the expected RED here).

- [ ] **Step 3: Implement the filter**

In `src/providers/llama-cpp.ts`, add above `listLlamaCppModels`:

```ts
/**
 * The inference server lists every directory under its model root (TabbyAPI includes
 * .git/node_modules/datasets), so the inventory only trusts names a preset declares.
 */
export function filterModelInventory(
  serverModels: readonly string[],
  presetModels: readonly (string | null)[],
): string[] {
  const allowed = new Set(
    presetModels.filter((model): model is string => typeof model === 'string' && model.trim() !== ''),
  );
  return serverModels.filter((model) => allowed.has(model));
}
```

Then change `listLlamaCppModels` (lines 364-373) to route through it:

```ts
export async function listLlamaCppModels(config: SiftConfig): Promise<string[]> {
  const baseUrl = getConfiguredLlamaBaseUrl(config);
  try {
    const serverModels = await llamaCppClient.listModelsAtBaseUrl(baseUrl, 5000);
    return filterModelInventory(
      serverModels,
      config.Server.ModelPresets.Presets.map((preset) => preset.Model),
    );
  } catch (error) {
    const message = formatProviderHttpError('llama.cpp model list failed', getErrorMessage(error));
    logLlamaCppError('model_list', message);
    throw new Error(message);
  }
}
```

- [ ] **Step 4: Run the tests to verify green**

Run: `npm test -- model-inventory repo-search-loop.core`
Expected: PASS. (`repo-search-loop.core` covers `assertConfiguredModelPresent` behavior; the configured model is always a preset `Model`, so the assertion semantics are unchanged.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/model-inventory.test.ts src/providers/llama-cpp.ts
git commit -m "fix: restrict model inventory to preset-declared model names"
```

---

### Task 4: non-TTY approval flow — answer contract, decision timeout, dead-worker status

The non-TTY boundary itself already works and is covered E2E (`tests/repo-agent-cli.test.ts` — `'non-TTY start and decide resume one real detached worker'` spawns the real binary, asserts one `approval_required` JSON line with exit 0, then `decide approve` resumes to `completed`). Three gaps remain: (a) the emitted JSON does not say how to answer; (b) the worker waits for a decision forever (`src/repo-agent/run-approval-prompter.ts:91-115` — this produced a 32-hour zombie process); (c) `repo-agent status` parrots stale non-terminal state when the worker pid is dead, even though the boundary waiter already knows how to reconcile that case.

**Files:**
- Modify: `src/repo-agent/run-schemas.ts:100-104` (approval_required result variant)
- Modify: `src/repo-agent/boundary-waiter.ts` (`repoAgentStateToResult`, extract `reconcileOnce` from `waitForBoundary`)
- Modify: `src/repo-agent/run-approval-prompter.ts` (decision timeout)
- Modify: `src/cli/repo-agent-command.ts:137-144` (`runStatus` reconciles dead workers)
- Modify: `src/cli/repo-agent-help.ts:94` (answer contract in help text)
- Test: `tests/repo-agent-boundary-waiter.test.ts`, `tests/repo-agent-run-approval-prompter.test.ts`, `tests/repo-agent-command.test.ts`, `tests/repo-agent-cli.test.ts`, `tests/cli-help.test.ts:294`

- [ ] **Step 1: Confirm the existing boundary E2E is green before touching anything**

Run: `npm test -- repo-agent-cli`
Expected: PASS, including `'non-TTY start and decide resume one real detached worker'`. This is the direct proof that a non-TTY `start` prints the `approval_required` JSON and exits 0 instead of freezing.

- [ ] **Step 2: Write the failing test for the decide contract**

In `tests/repo-agent-boundary-waiter.test.ts`, add (extend the existing imports from `../src/repo-agent/run-schemas.js` with `RepoAgentRunStateSchema` and from `../src/repo-agent/boundary-waiter.js` with `repoAgentStateToResult` if not already imported):

```ts
test('approval_required results carry the decide command contract', () => {
  const runId = randomUUID();
  const result = repoAgentStateToResult(RepoAgentRunStateSchema.parse({
    runId,
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
    status: 'approval_required',
    pid: process.pid,
    approval: {
      approvalId: randomUUID(),
      toolName: 'run',
      command: 'run command="npm test"',
      reviewPayload: null,
    },
  }));
  assert.ok(result.status === 'approval_required');
  assert.deepEqual(result.decide, {
    approve: `siftkit repo-agent decide ${runId} approve`,
    deny: `siftkit repo-agent decide ${runId} deny --reason "<why>"`,
    abort: `siftkit repo-agent decide ${runId} abort`,
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- repo-agent-boundary-waiter`
Expected: FAIL at typecheck — property `decide` does not exist on the approval_required result variant. (A compile-stage RED is expected because `npm test` typechecks first.)

- [ ] **Step 4: Implement the decide contract**

In `src/repo-agent/run-schemas.ts`, replace the approval_required variant of `RepoAgentRunResultSchema` (lines 100-104):

```ts
  z.strictObject({
    status: z.literal('approval_required'),
    runId: RunIdSchema,
    approval: RepoAgentApprovalSchema,
    decide: z.strictObject({
      approve: z.string().min(1),
      deny: z.string().min(1),
      abort: z.string().min(1),
    }),
  }),
```

In `src/repo-agent/boundary-waiter.ts`, replace the approval_required case of `repoAgentStateToResult` (lines 35-40):

```ts
    case 'approval_required':
      return RepoAgentRunResultSchema.parse({
        status: 'approval_required',
        runId: state.runId,
        approval: state.approval,
        decide: {
          approve: `siftkit repo-agent decide ${state.runId} approve`,
          deny: `siftkit repo-agent decide ${state.runId} deny --reason "<why>"`,
          abort: `siftkit repo-agent decide ${state.runId} abort`,
        },
      });
```

In `src/cli/repo-agent-help.ts:94`, replace:

```ts
    { status: 'approval_required', exitCode: 0, meaning: 'A decision is required.' },
```

with:

```ts
    {
      status: 'approval_required',
      exitCode: 0,
      meaning: 'A decision is required; the decide field of the result carries the exact approve/deny/abort commands.',
    },
```

- [ ] **Step 5: Update the dependent assertions**

In `tests/cli-help.test.ts:294`, update the expected entry to the new meaning string:

```ts
      {
        status: 'approval_required',
        exitCode: 0,
        meaning: 'A decision is required; the decide field of the result carries the exact approve/deny/abort commands.',
      },
```

In `tests/repo-agent-cli.test.ts`, inside `'non-TTY start and decide resume one real detached worker'`, directly after the existing `assert.equal(approval.status, 'approval_required');`, add:

```ts
    assert.ok(approval.status === 'approval_required');
    assert.deepEqual(approval.decide, {
      approve: `siftkit repo-agent decide ${approval.runId} approve`,
      deny: `siftkit repo-agent decide ${approval.runId} deny --reason "<why>"`,
      abort: `siftkit repo-agent decide ${approval.runId} abort`,
    });
```

- [ ] **Step 6: Run the contract suites to verify green**

Run: `npm test -- repo-agent-boundary-waiter repo-agent-command repo-agent-cli cli-help`
Expected: PASS (the `strictObject` change makes any builder that forgets `decide` fail loudly at parse time — `repoAgentStateToResult` is the only result builder in `src/`).

- [ ] **Step 7: Write the failing test for the decision timeout**

In `tests/repo-agent-run-approval-prompter.test.ts`, add (the file's existing helpers `makeRunsRoot`, `makeRequest`, `makeApproval`, `makeApprovalEvent`, `moveToRunning` are reused):

```ts
test('an undecided approval times out into a deny and resumes the run', async () => {
  const runsRoot = makeRunsRoot();
  const store = new RepoAgentRunStore(runsRoot);
  const request = makeRequest();
  store.create(request);
  moveToRunning(store, request);

  const waiter = new RepoAgentBoundaryWaiter({ store, runId: request.runId, pollIntervalMs: 5 });
  const prompter = new RepoAgentRunApprovalPrompter({
    store,
    waiter,
    runId: request.runId,
    decisionTimeoutMs: 100,
  });
  const decision = await prompter.promptDecision(makeApprovalEvent(makeApproval()));
  assert.deepEqual(decision, {
    kind: 'deny',
    reason: 'No approval decision was received within 100ms; the command was not executed.',
  });
  assert.equal(store.readState(request.runId).status, 'running');
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npm test -- repo-agent-run-approval-prompter`
Expected: FAIL at typecheck — `decisionTimeoutMs` is not a known constructor option.

- [ ] **Step 9: Implement the timeout**

In `src/repo-agent/run-approval-prompter.ts`:

Add below `DEFAULT_DECISION_POLL_MS`:

```ts
export const DEFAULT_DECISION_TIMEOUT_MS = 600_000;
```

Extend the class fields and constructor:

```ts
  private readonly decisionTimeoutMs: number;

  constructor(options: {
    store: RepoAgentRunStore;
    waiter: RepoAgentBoundaryWaiter;
    runId: string;
    decisionTimeoutMs?: number;
  }) {
    this.store = options.store;
    this.waiter = options.waiter;
    this.runId = options.runId;
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    if (!Number.isFinite(this.decisionTimeoutMs) || this.decisionTimeoutMs <= 0) {
      throw new Error('Approval decision timeout must be a positive number of milliseconds.');
    }
  }
```

Change `pollDecision` to return `RepoAgentDecision | null` with a deadline:

```ts
  private async pollDecision(
    approvalId: string,
    revision: number,
  ): Promise<RepoAgentDecision | null> {
    const deadline = Date.now() + this.decisionTimeoutMs;
    for (;;) {
      const decision = this.store.consumeDecision(this.runId, approvalId, revision);
      if (decision) {
        return decision;
      }

      const state = this.store.readState(this.runId);
      if (state.status === 'aborted') {
        throw new Error('Run was aborted during approval wait.');
      }
      if (state.status === 'failed') {
        throw new Error(`Run failed during approval wait: ${state.error}`);
      }
      if (Date.now() >= deadline) {
        return null;
      }

      await this.sleep(DEFAULT_DECISION_POLL_MS);
    }
  }
```

And in `promptDecision`, replace the tail

```ts
    const decision = await this.pollDecision(
      approval.approvalId,
      approvalState.revision,
    );

    return this.handleDecision(decision, approvalState);
```

with:

```ts
    const decision = await this.pollDecision(
      approval.approvalId,
      approvalState.revision,
    );
    if (decision === null) {
      this.store.clearPendingApproval(this.runId, approvalState.revision, 'running');
      return {
        kind: 'deny',
        reason: `No approval decision was received within ${this.decisionTimeoutMs}ms; the command was not executed.`,
      };
    }

    return this.handleDecision(decision, approvalState);
```

The deny path deliberately mirrors an auto-reviewer denial: the engine reports the rejection to the model, the run continues, and the worker exits at the natural end of the task — no more immortal workers, and no partial work thrown away.

- [ ] **Step 10: Run the prompter suite to verify green**

Run: `npm test -- repo-agent-run-approval-prompter`
Expected: PASS, including all pre-existing prompter tests (the default timeout of 600000ms is far above any test's runtime).

- [ ] **Step 11: Write the failing test for dead-worker status**

In `tests/repo-agent-command.test.ts`, extend the import from `../src/repo-agent/run-schemas.js` with `RepoAgentRunStateSchema`, then add:

```ts
test('status reports a dead worker as failed instead of stale running state', async () => {
  const harness = makeHarness('completed');
  const request: RepoAgentWorkerRequest = {
    runId: randomUUID(),
    task: 'stale task',
    repoRoot: process.cwd(),
    approval: 'auto',
    progress: false,
    images: [],
  };
  harness.store.create(request);
  harness.store.transition(request.runId, 0, {
    runId: request.runId,
    revision: 1,
    updatedAtUtc: new Date().toISOString(),
    status: 'running',
    pid: 999999999,
  });
  const capture = makeStreams();
  const code = await harness.command.run(
    parseRepoAgentInvocation(['status', request.runId]),
    capture.streams,
  );

  assert.equal(code, 0);
  const reported = RepoAgentRunStateSchema.parse(
    parseJsonValueText(capture.stdout.read()),
  );
  assert.ok(reported.status === 'failed');
  assert.match(reported.error, /worker process 999999999 died/iu);
  assert.equal(harness.store.readState(request.runId).status, 'failed');
});
```

- [ ] **Step 12: Run it to verify it fails**

Run: `npm test -- repo-agent-command`
Expected: FAIL — `reported.status` is `'running'` (stale state is parroted).

- [ ] **Step 13: Implement dead-worker reconciliation**

In `src/repo-agent/boundary-waiter.ts`, add a public one-shot reconcile and rewrite `waitForBoundary` to use it (this replaces the inline dead-pid block, lines 82-132 — same semantics, one owner):

```ts
  /** Reads current state; if the recorded worker pid is dead on a non-terminal state, records the failure first. */
  reconcileOnce(): RepoAgentRunState {
    const state = this.store.readState(this.runId);
    if (isActiveStatus(state.status)) {
      const pid = 'pid' in state ? state.pid : undefined;
      if (pid !== undefined && !this.processInspector.isAlive(pid)) {
        try {
          this.store.transition(this.runId, state.revision, {
            runId: this.runId,
            revision: state.revision + 1,
            updatedAtUtc: new Date().toISOString(),
            status: 'failed',
            pid,
            error: `Worker process ${pid} died unexpectedly.`,
          });
        } catch {
          // Another writer advanced the state first; the fresh read below wins.
        }
        return this.store.readState(this.runId);
      }
    }
    return state;
  }

  async waitForBoundary(fromRevision: number): Promise<RepoAgentRunResult> {
    if (!Number.isInteger(fromRevision) || fromRevision < 0) {
      throw new Error('Boundary revision must be a non-negative integer.');
    }
    for (;;) {
      let state: RepoAgentRunState;
      try {
        state = this.reconcileOnce();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read state for run ${this.runId}: ${msg}`);
      }

      if (state.revision <= fromRevision) {
        await this.sleep();
        continue;
      }
      if (isTerminalStatus(state.status) || state.status === 'approval_required') {
        return repoAgentStateToResult(state);
      }
      await this.sleep();
    }
  }
```

(The `isBoundaryStatus` helper becomes unused by `waitForBoundary`; delete it if nothing else references it — verify with `rg isBoundaryStatus src/`.)

In `src/cli/repo-agent-command.ts`, replace `runStatus` (lines 137-144):

```ts
  private runStatus(
    invocation: Extract<RepoAgentInvocation, { kind: 'status' }>,
    streams: RepoAgentCommandStreams,
  ): number {
    const state = new RepoAgentBoundaryWaiter({
      store: this.store,
      runId: invocation.runId,
    }).reconcileOnce();
    streams.stdout.write(`${JSON.stringify(state)}\n`);
    return 0;
  }
```

- [ ] **Step 14: Run the full repo-agent sweep to verify green**

Run: `npm test -- repo-agent-command repo-agent-boundary-waiter repo-agent-run-approval-prompter repo-agent-worker repo-agent-cli repo-agent-run-store repo-agent-foreground`
Expected: PASS. Pay attention to `repo-agent-boundary-waiter` (the `waitForBoundary` rewrite must keep every existing test green) and to `'status returns current state without mutation'` in `repo-agent-command` — a `starting` state has no pid, so reconcile leaves it untouched and that test stays green.

- [ ] **Step 15: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/repo-agent/run-schemas.ts src/repo-agent/boundary-waiter.ts src/repo-agent/run-approval-prompter.ts src/cli/repo-agent-command.ts src/cli/repo-agent-help.ts tests/repo-agent-boundary-waiter.test.ts tests/repo-agent-run-approval-prompter.test.ts tests/repo-agent-command.test.ts tests/repo-agent-cli.test.ts tests/cli-help.test.ts
git commit -m "fix: approval results carry the decide contract; approval waits time out; status reconciles dead workers"
```

---

### Post-plan notes (operator, not tasks)

- The `~/.claude/CLAUDE.md` Repo-Agent Delegation Policy documents the resumable-json contract; after Task 4 the `approval_required` line additionally carries `decide.{approve,deny,abort}`. Worth adding one sentence there so orchestrating agents use the in-band commands.
- Three stale run records under `.siftkit/repo-agent/runs` (`7dcab1cb…`, `b296ccfa…`, `ce9f4645…`) sit at `running` with dead pids from before this fix; after Task 4, `siftkit repo-agent status <run-id>` reconciles each to `failed` on first query. No migration needed.
- Deliberately out of scope: counting *rejected* commands toward forced-finish stagnation pressure (the other half of the task-3b loop), appending rather than substituting the zero-output warning, and jsonrepair truncation hardening for `edit` payloads. Each deserves its own plan if wanted.
