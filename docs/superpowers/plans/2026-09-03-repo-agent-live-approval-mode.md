# Repo-Agent Live Approval Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the web UI pick the repo-agent approval mode (Manual / Auto / Approve all) before a run and change it while the run is streaming, with the new mode taking effect on the next tool call and an "Approve all" switch releasing a parked approval.

**Architecture:** The approval mode becomes live state on the human `ApprovalGate` (`mode` + `setMode`). The task loop always wraps a present gate in a `ModeSwitchedApprovalRequester` that reads `gate.mode` per tool call: `off` approves, `interactive` asks the human gate, `auto` asks the LLM reviewer (which still escalates to the human gate). `RepoAgentSession` always owns a gate, exposes `setApprovalMode()` / `getApprovalMode()`, and takes an explicit `approvalDelivery` (`progress` for chat, `boundary` for the standalone CLI route) instead of deriving delivery from the mode. A new chat endpoint `POST /dashboard/chat/sessions/:id/repo-agent/approval-mode` updates a running session. The dashboard stores the mode per session runtime, sends it with every repo-agent start, and syncs changes to the server while it owns a running repo-agent operation.

**Tech Stack:** TypeScript 5.9, zod 4, Node HTTP/SSE, React dashboard, node:test.

## Design decisions (fixed)

- **UI labels → wire values:** Manual = `interactive`, Auto = `auto`, Approve all = `off`. No new enum value. `off` already means "never ask".
- **Default mode in the UI:** `auto` (matches the CLI default in `src/cli/repo-agent-args.ts:79`). Held in one constant `DEFAULT_REPO_AGENT_APPROVAL_MODE` in the dashboard runtime store.
- **Chat stream request must carry `approval`.** The route no longer defaults an omitted value to `interactive`; omission is a 400. That is the current bug the user observed (`src/status-server/routes/chat-repo-agent.ts:79`).
- **Switch semantics on a parked approval:** switching to `off` approves the parked request immediately and records an `approve` audit row. Switching to `auto` or `interactive` leaves the parked request waiting for the human.
- **Delivery vs. mode:** today `RepoAgentSession` forwards `approval_request` to the subscriber only in `interactive` mode and turns `approval_required` into a boundary result otherwise (`src/status-server/repo-agent-sessions.ts:281,458`). That is a transport concern. A chat run in `auto` mode whose reviewer answers `unsure` currently ends the stream with `approval_required is not terminal for interactive chat runs.` (`src/status-server/chat.ts:~822`). The session gets an explicit `approvalDelivery: 'progress' | 'boundary'`; chat always uses `progress`.
- **Canonical `ApprovalModeSchema` moves to `@siftkit/contracts`** (`packages/contracts/src/chat.ts`), replacing the local enum in `approval-gate.ts` and the inline duplicate in `ChatRepoAgentStreamRequestSchema`.
- **Run store record:** `RepoAgentRunRequestSchema.approval` keeps the *initial* mode. Live switches are not persisted to the run record.
- **Persistence of the UI choice:** per-session in-memory runtime state only. On reload, the mode is restored from the active-run endpoint when a run is in flight; otherwise it returns to the default.

## Global constraints

- TDD per task: failing test → minimal implementation → passing test → refactor.
- No `any`, type assertions, non-null assertions, namespace imports, schema-duplicating types, unvalidated IO, compatibility fallbacks, or parallel paths.
- Do not use a worktree. Do not commit. Preserve unrelated changes.
- Tests: build once with `npm run build:test`, then run a single file with `node .\dist\test-runner\run-tests.js <basename>` (Node suite) or `node .\dist\test-runner\run-tests.js --dashboard <basename>` (dashboard suite). Rebuild with `npm run build:test` after every source change before re-running.
- Before declaring done: `npm run test`, `npm run test:dashboard`, `npm run typecheck` (includes lint).

## File map

| File | Change |
| --- | --- |
| `packages/contracts/src/chat.ts` | Add `ApprovalModeSchema`; make `approval` required in `ChatRepoAgentStreamRequestSchema`; add `approvalMode` to `ActiveChatRepoAgentResponseSchema`; add approval-mode request/response schemas |
| `src/repo-search/engine/approval-gate.ts` | Remove local enum; gate gains `mode`, `setMode`; `HumanApprovalRequester` gains `mode` |
| `src/repo-search/engine/approval-mode-requester.ts` | New `ModeSwitchedApprovalRequester` |
| `src/repo-search/engine/task-loop.ts` | `buildApprovalRequester` uses the dispatcher; drop `approvalMode` |
| `src/repo-search/engine/task-loop-support.ts`, `src/repo-search/engine.ts`, `src/repo-search/types.ts`, `src/repo-search/execute.ts` | Drop `approvalMode` option |
| `src/status-server/routes/repo-search.ts` | Gate constructed with `mode: 'interactive'` |
| `src/status-server/repo-agent-sessions.ts` | Always-present gate, `approvalDelivery`, `setApprovalMode`, `getApprovalMode` |
| `src/status-server/routes/repo-agent.ts` | Pass `approvalDelivery` |
| `src/status-server/routes/chat-repo-agent.ts` | Required `approval`, `approvalDelivery: 'progress'`, new `ChatRepoAgentApprovalModeEndpoint`, active response includes `approvalMode` |
| `src/status-server/routes/chat.ts` | Register the new route |
| `src/cli/repo-agent-args.ts`, `src/cli/repo-agent-request.ts`, `src/repo-agent/api-schemas.ts`, `src/repo-agent/run-schemas.ts` | Import `ApprovalModeSchema`/`ApprovalMode` from `@siftkit/contracts` |
| `dashboard/src/lib/chat-session-runtime-store.ts` | `repoAgentApprovalMode` field + transition |
| `dashboard/src/api.ts` | `updateRepoAgentApprovalMode` |
| `dashboard/src/hooks/useChatSessions.ts` | Send mode on start; `setRepoAgentApprovalMode`; restore from active run |
| `dashboard/src/hooks/useChatController.ts` | Wire props |
| `dashboard/src/components/RepoAgentApprovalModeControl.tsx` | New segmented control |
| `dashboard/src/tabs/ChatTab.tsx` | Render control in the repo-tool row |
| `dashboard/src/styles/chat.css` | `.approval-mode` group style |
| Tests | `tests/contracts-chat-repo-agent.test.ts`, `tests/approval-gate.test.ts`, `tests/helpers/approval-gate-harness.ts`, `tests/approval-mode-requester.test.ts` (new), `tests/llm-auto-approval.test.ts`, `tests/repo-agent-sessions.test.ts`, `tests/status-server-chat-repo-agent.test.ts`, `dashboard/tests/chat-session-runtime-store.test.ts`, `dashboard/tests/chat-tab.test.tsx` |

---

### Task 1: Canonical approval-mode contract

**Files:**
- Modify: `packages/contracts/src/chat.ts:229-236` (stream request), `:278-287` (active response)
- Modify: `src/repo-search/engine/approval-gate.ts:31-32`
- Modify imports: `src/cli/repo-agent-args.ts`, `src/cli/repo-agent-request.ts`, `src/repo-agent/api-schemas.ts`, `src/repo-agent/run-schemas.ts`, `src/repo-search/engine/task-loop-support.ts`, `src/repo-search/engine.ts`, `src/repo-search/types.ts`, `src/status-server/routes/chat-repo-agent.ts`, `src/status-server/routes/repo-agent.ts`, `src/status-server/repo-agent-sessions.ts`, `tests/repo-agent-sessions.test.ts`
- Test: `tests/contracts-chat-repo-agent.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Append to `tests/contracts-chat-repo-agent.test.ts` (extend the import list with `ApprovalModeSchema`, `ChatRepoAgentApprovalModeRequestSchema`, `ChatRepoAgentApprovalModeResponseSchema`):

```ts
test('approval mode is one shared enum', () => {
  assert.deepEqual(ApprovalModeSchema.options, ['interactive', 'auto', 'off']);
  assert.throws(() => ApprovalModeSchema.parse('manual'));
});

test('chat repo-agent stream requests require an approval mode', () => {
  assert.throws(() => ChatRepoAgentStreamRequestSchema.parse({
    content: 'update the repository',
    repoRoot: 'C:\\repo',
    operationId: OPERATION_ID,
  }));
  assert.equal(
    ChatRepoAgentStreamRequestSchema.parse({ content: 'x', approval: 'off', operationId: OPERATION_ID }).approval,
    'off',
  );
});

test('active repo-agent responses report the live approval mode', () => {
  const running = ActiveChatRepoAgentResponseSchema.parse({
    runId: OPERATION_ID, status: 'running', approvalMode: 'auto',
  });
  assert.equal(running.approvalMode, 'auto');
  assert.throws(() => ActiveChatRepoAgentResponseSchema.parse({ runId: OPERATION_ID, status: 'running' }));
  const parked = ActiveChatRepoAgentResponseSchema.parse({
    runId: OPERATION_ID, status: 'approval_required', approvalMode: 'interactive',
    approval: { approvalId: '4f9c1f9a-0000-4000-8000-000000000001', toolName: 'write', command: 'write x', reviewPayload: null },
  });
  assert.equal(parked.approvalMode, 'interactive');
});

test('approval-mode update contracts are strict', () => {
  assert.deepEqual(ChatRepoAgentApprovalModeRequestSchema.parse({ approval: 'off' }), { approval: 'off' });
  assert.throws(() => ChatRepoAgentApprovalModeRequestSchema.parse({ approval: 'off', extra: 1 }));
  const response = ChatRepoAgentApprovalModeResponseSchema.parse({
    ok: true, runId: OPERATION_ID, approval: 'off', approvedApprovalId: null,
  });
  assert.equal(response.approvedApprovalId, null);
  assert.throws(() => ChatRepoAgentApprovalModeResponseSchema.parse({ ok: true, runId: OPERATION_ID, approval: 'off' }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js contracts-chat-repo-agent.test.ts`
Expected: build/type failure on the missing exports (`ApprovalModeSchema`, `ChatRepoAgentApprovalMode*Schema`).

- [ ] **Step 3: Add the contract**

In `packages/contracts/src/chat.ts`, above `ChatRepoAgentStreamRequestSchema`:

```ts
export const ApprovalModeSchema = z.enum(['interactive', 'auto', 'off']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
```

Change `ChatRepoAgentStreamRequestSchema.approval` to `approval: ApprovalModeSchema,` (required).

Replace the active response block:

```ts
const ChatStreamApprovalWithoutRunIdSchema = ChatStreamApprovalSchema.omit({ runId: true });
export const ActiveChatRepoAgentResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ runId: z.string().uuid(), status: z.literal('running'), approvalMode: ApprovalModeSchema }),
  z.strictObject({
    runId: z.string().uuid(),
    status: z.literal('approval_required'),
    approvalMode: ApprovalModeSchema,
    approval: ChatStreamApprovalWithoutRunIdSchema,
  }),
]);
export type ActiveChatRepoAgentResponse = z.infer<typeof ActiveChatRepoAgentResponseSchema>;

export const ChatRepoAgentApprovalModeRequestSchema = z.strictObject({ approval: ApprovalModeSchema });
export type ChatRepoAgentApprovalModeRequest = z.infer<typeof ChatRepoAgentApprovalModeRequestSchema>;
export const ChatRepoAgentApprovalModeResponseSchema = z.strictObject({
  ok: z.literal(true),
  runId: z.string().uuid(),
  approval: ApprovalModeSchema,
  /** Set when switching to `off` released a parked approval; the client mirrors it as an approve decision. */
  approvedApprovalId: z.string().uuid().nullable(),
});
export type ChatRepoAgentApprovalModeResponse = z.infer<typeof ChatRepoAgentApprovalModeResponseSchema>;
```

- [ ] **Step 4: Delete the local enum and repoint imports**

In `src/repo-search/engine/approval-gate.ts` delete lines 31-32 (`ApprovalModeSchema`, `ApprovalMode`). Add `import type { ApprovalMode } from '@siftkit/contracts';` (the gate needs the type in Task 2).

In each of these files replace the `ApprovalModeSchema` / `ApprovalMode` import from `approval-gate.js` with an import from `@siftkit/contracts` (keep the other named imports from `approval-gate.js` where present):
- `src/cli/repo-agent-args.ts`
- `src/cli/repo-agent-request.ts`
- `src/repo-agent/api-schemas.ts`
- `src/repo-agent/run-schemas.ts`
- `src/repo-search/engine/task-loop-support.ts`
- `src/repo-search/engine.ts`
- `src/repo-search/types.ts`
- `src/status-server/routes/chat-repo-agent.ts`
- `src/status-server/routes/repo-agent.ts`
- `src/status-server/repo-agent-sessions.ts`
- `tests/repo-agent-sessions.test.ts`

- [ ] **Step 5: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js contracts-chat-repo-agent.test.ts`
Expected: PASS. (The chat route still compiles because it only reads `parsedBody.approval` through the schema; its behaviour changes in Task 5. `status-server-chat-repo-agent.test.ts` may fail on `approvalMode` missing in the active response until Task 5; that is expected.)

---

### Task 2: Live `mode` on `ApprovalGate`

**Files:**
- Modify: `src/repo-search/engine/approval-gate.ts` (`HumanApprovalRequester`, `ApprovalGate` constructor/fields)
- Modify: `tests/helpers/approval-gate-harness.ts`
- Modify: `tests/approval-gate.test.ts` (all `new ApprovalGateHarness(...)` and direct `new ApprovalGate({...})` calls), `tests/llm-auto-approval.test.ts` (harness calls at lines 55, 166, 198, 221, 445)

- [ ] **Step 1: Write the failing tests**

Append to `tests/approval-gate.test.ts`:

```ts
test('gate exposes its live mode and setMode replaces it', () => {
  const gate = new ApprovalGateHarness(new CollectingWriter(), { mode: 'interactive' }).gate;
  assert.equal(gate.mode, 'interactive');
  gate.setMode('off');
  assert.equal(gate.mode, 'off');
  gate.setMode('auto');
  assert.equal(gate.mode, 'auto');
});

test('setMode does not settle a parked approval by itself', async () => {
  const writer = new CollectingWriter();
  const gate = new ApprovalGateHarness(writer, { mode: 'interactive' }).gate;
  const pending = gate.request({ turn: 1, toolName: 'write', command: 'write x', reviewPayload: null });
  gate.setMode('off');
  const settled = await Promise.race([pending.then(() => true), delay(20).then(() => false)]);
  assert.equal(settled, false);
  gate.submit(writer.approvals[0].approvalId, { kind: 'approve' });
  assert.deepEqual(await pending, { kind: 'approve' });
});
```

- [ ] **Step 2: Update the harness signature**

Replace `tests/helpers/approval-gate-harness.ts` constructor:

```ts
import type { ApprovalMode } from '@siftkit/contracts';

export type ApprovalGateHarnessOptions = {
  mode: ApprovalMode;
  bypassReadOnlyTools?: boolean;
  decisionTimeoutMs?: number;
};

export class ApprovalGateHarness {
  public readonly controller = new AbortController();
  public readonly gate: ApprovalGate;
  public readonly logLines: string[] = [];

  constructor(progressWriter: ProgressWriter<RepoSearchProgressEvent>, options: ApprovalGateHarnessOptions) {
    this.gate = new ApprovalGate({
      requestId: 'run-1',
      progressWriter,
      abortSignal: this.controller.signal,
      mode: options.mode,
      bypassReadOnlyTools: options.bypassReadOnlyTools ?? false,
      logger: new ServerLogger({
        level: 'debug',
        colour: false,
        write: (text: string) => { this.logLines.push(text); },
      }),
      ...(options.decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs: options.decisionTimeoutMs }),
    });
  }
}
```

Update every caller:
- `tests/approval-gate.test.ts`: `new ApprovalGateHarness(writer)` → `new ApprovalGateHarness(writer, { mode: 'interactive' })`; `new ApprovalGateHarness(writer, true)` → `new ApprovalGateHarness(writer, { mode: 'interactive', bypassReadOnlyTools: true })`; the four direct `new ApprovalGate({...})` calls at lines ~378, 398, 414, 433 gain `mode: 'interactive',`.
- `tests/llm-auto-approval.test.ts`: `new ApprovalGateHarness(writer, false, X)` → `new ApprovalGateHarness(writer, { mode: 'auto', decisionTimeoutMs: X })` (all five sites).

- [ ] **Step 3: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js approval-gate.test.ts`
Expected: type error, `mode` is not a known option / property on `ApprovalGate`.

- [ ] **Step 4: Implement**

In `src/repo-search/engine/approval-gate.ts`:

```ts
export type HumanApprovalRequester = {
  /** Live approval mode; the task loop's dispatcher reads it on every tool call. */
  readonly mode: ApprovalMode;
  request(input: HumanApprovalRequestInput): Promise<ApprovalDecision>;
};
```

In `ApprovalGate`: add `private currentMode: ApprovalMode;`, a constructor option `mode: ApprovalMode;` assigned `this.currentMode = options.mode;`, and:

```ts
  get mode(): ApprovalMode {
    return this.currentMode;
  }

  /** Takes effect on the next request; a parked approval keeps waiting for submit(). */
  setMode(mode: ApprovalMode): void {
    this.currentMode = mode;
  }
```

Fix the two production constructors so the build compiles: `src/status-server/routes/repo-search.ts:89` add `mode: 'interactive',`; `src/status-server/repo-agent-sessions.ts:147` add `mode: options.approvalMode,` (Task 4 restructures this constructor further).

- [ ] **Step 5: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js approval-gate.test.ts`
Expected: PASS, all tests in the file.

---

### Task 3: Mode-switched approval dispatch in the task loop

**Files:**
- Create: `src/repo-search/engine/approval-mode-requester.ts`
- Modify: `src/repo-search/engine/task-loop.ts:361-374` (`buildApprovalRequester`)
- Modify: `src/repo-search/engine/task-loop-support.ts:270-271`, `src/repo-search/engine.ts:158-159,231-232`, `src/repo-search/types.ts:188-189`, `src/repo-search/execute.ts:434-435`, `src/status-server/routes/repo-search.ts:82-96,120-121`
- Create: `tests/approval-mode-requester.test.ts`
- Modify: `tests/llm-auto-approval.test.ts` (remove `approvalMode` from `makeAutoLoopOptions` and the HTTP test; delete the test `auto mode without a human gate fails loudly at construction`)

- [ ] **Step 1: Write the failing unit tests**

Create `tests/approval-mode-requester.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApprovalMode } from '@siftkit/contracts';
import type {
  ApprovalDecision,
  ApprovalRequestInput,
  ApprovalRequester,
  HumanApprovalRequester,
  HumanApprovalRequestInput,
} from '../src/repo-search/engine/approval-gate.js';
import { ModeSwitchedApprovalRequester } from '../src/repo-search/engine/approval-mode-requester.js';

class FakeHumanGate implements HumanApprovalRequester {
  mode: ApprovalMode;
  readonly calls: HumanApprovalRequestInput[] = [];
  constructor(mode: ApprovalMode) { this.mode = mode; }
  request(input: HumanApprovalRequestInput): Promise<ApprovalDecision> {
    this.calls.push(input);
    return Promise.resolve({ kind: 'deny', reason: 'human' });
  }
}

class FakeLlmGate implements ApprovalRequester {
  readonly calls: ApprovalRequestInput[] = [];
  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    this.calls.push(input);
    return Promise.resolve({ kind: 'deny', reason: 'llm' });
  }
}

const INPUT: ApprovalRequestInput = {
  turn: 1, toolName: 'write', command: 'write x', reviewPayload: null, pendingMessages: [],
};

test('off approves without consulting either gate', async () => {
  const human = new FakeHumanGate('off');
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(human, llm);
  assert.deepEqual(await requester.request(INPUT), { kind: 'approve' });
  assert.equal(human.calls.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('interactive routes to the human gate only', async () => {
  const human = new FakeHumanGate('interactive');
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(human, llm);
  assert.deepEqual(await requester.request(INPUT), { kind: 'deny', reason: 'human' });
  assert.equal(llm.calls.length, 0);
});

test('auto routes to the LLM gate', async () => {
  const human = new FakeHumanGate('auto');
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(human, llm);
  assert.deepEqual(await requester.request(INPUT), { kind: 'deny', reason: 'llm' });
  assert.equal(human.calls.length, 0);
});

test('the mode is read on every call, so a switch mid-run changes the next decision', async () => {
  const human = new FakeHumanGate('interactive');
  const llm = new FakeLlmGate();
  const requester = new ModeSwitchedApprovalRequester(human, llm);
  assert.equal((await requester.request(INPUT)).kind, 'deny');
  human.mode = 'off';
  assert.deepEqual(await requester.request(INPUT), { kind: 'approve' });
  human.mode = 'auto';
  assert.deepEqual(await requester.request(INPUT), { kind: 'deny', reason: 'llm' });
  assert.equal(human.calls.length, 1);
  assert.equal(llm.calls.length, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js approval-mode-requester.test.ts`
Expected: build failure, module `approval-mode-requester.js` not found.

- [ ] **Step 3: Implement the dispatcher**

Create `src/repo-search/engine/approval-mode-requester.ts`:

```ts
import type {
  ApprovalDecision,
  ApprovalRequestInput,
  ApprovalRequester,
  HumanApprovalRequester,
} from './approval-gate.js';

/**
 * Reads the human gate's live mode on every tool call so a run can switch between
 * off / interactive / auto while it is executing.
 */
export class ModeSwitchedApprovalRequester implements ApprovalRequester {
  constructor(
    private readonly humanGate: HumanApprovalRequester,
    private readonly llmGate: ApprovalRequester,
  ) {}

  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    switch (this.humanGate.mode) {
      case 'off':
        return Promise.resolve({ kind: 'approve' });
      case 'interactive':
        return this.humanGate.request(input);
      case 'auto':
        return this.llmGate.request(input);
    }
  }
}
```

- [ ] **Step 4: Rewire the task loop and remove `approvalMode` everywhere**

`src/repo-search/engine/task-loop.ts` — replace `buildApprovalRequester`:

```ts
  private buildApprovalRequester(options: RunTaskLoopOptions): ApprovalRequester | null {
    if (!options.approvalGate) {
      return null;
    }
    return new ModeSwitchedApprovalRequester(
      options.approvalGate,
      new LlmApprovalGate({
        requestId: options.approvalGate.getRequestId(),
        humanGate: options.approvalGate,
        verdictRequester: this,
        progressWriter: options.progressWriter ?? new SilentProgressWriter(),
        logger: options.logger ?? null,
      }),
    );
  }
```

Add `import { ModeSwitchedApprovalRequester } from './approval-mode-requester.js';`.

Delete the `approvalMode` option/field and its pass-through in:
- `src/repo-search/engine/task-loop-support.ts:271` (`RunTaskLoopOptions.approvalMode`) and drop `ApprovalMode` from its import.
- `src/repo-search/engine.ts:159` and `:232`; drop the `ApprovalMode` import.
- `src/repo-search/types.ts:189`; drop the `ApprovalMode` import.
- `src/repo-search/execute.ts:435`.
- `src/status-server/routes/repo-search.ts`: delete lines 82-83 (`approvalMode`, `approvalOn`), build the gate when `interactive` with `mode: 'interactive'`, delete `approvalMode,` at line 121.

`tests/llm-auto-approval.test.ts`: remove `approvalMode: 'auto' as const,` from `makeAutoLoopOptions` (line 156) and from the HTTP test (line 465); delete the whole test `auto mode without a human gate fails loudly at construction` (lines 530-553). The "without a gate mutating tools stay invalid" behaviour is already covered by `tests/tool-action-approval.test.ts:227`.

- [ ] **Step 5: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js approval-mode-requester.test.ts; node .\dist\test-runner\run-tests.js llm-auto-approval.test.ts; node .\dist\test-runner\run-tests.js tool-action-approval.test.ts`
Expected: all PASS. The read-only exemption behaviour in `llm-auto-approval` is unchanged because `LlmApprovalGate.request` still short-circuits exempt tools before any verdict call.

---

### Task 4: `RepoAgentSession` owns a switchable gate and an explicit delivery

**Files:**
- Modify: `src/status-server/repo-agent-sessions.ts`
- Modify: `src/status-server/routes/repo-agent.ts:56-66,73-77,111-125`
- Modify: `src/status-server/routes/chat-repo-agent.ts:107-120` (pass `approvalDelivery: 'progress'`)
- Modify: `tests/repo-agent-sessions.test.ts`

- [ ] **Step 1: Write the failing session tests**

In `tests/repo-agent-sessions.test.ts`:

1. Extend the harness option types with a required `approvalDelivery`:

```ts
type SessionTestHarnessOptions = {
  engine: RepoAgentEngine;
  approvalMode: ApprovalMode;
  approvalDelivery: RepoAgentApprovalDelivery;
  locks?: RepoAgentModelLockAdapter;
  decisionTimeoutMs?: number;
};
```

Import `RepoAgentApprovalDelivery` from `../src/status-server/repo-agent-sessions.js`. Thread `approvalDelivery` through the private constructor, the `readonly approvalDelivery` field, and the `manager.start({...})` call at line ~496 (`approvalDelivery: this.approvalDelivery`).

2. Update every existing `SessionTestHarness.create({ ... approvalMode: X ... })` call: add `approvalDelivery: 'progress'` where `approvalMode: 'interactive'`, and `approvalDelivery: 'boundary'` for `'auto'` and `'off'`. Rename the test at line 893 to `Boundary delivery: subscriber never sees approval_request, waitForBoundary resolves approval_required` and the one at line 853 to `Progress delivery: subscriber receives approval_request, waitForBoundary stays pending`.

3. Add a two-step engine and the new tests:

```ts
class TwoStepParkingEngine implements RepoAgentEngine {
  async executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    const gate = request.approvalGate;
    if (!gate) {
      throw new Error('TwoStepParkingEngine requires an approval gate.');
    }
    const modes: ApprovalMode[] = [];
    for (const command of ['write a.txt', 'write b.txt']) {
      modes.push(gate.mode);
      const decision = await gate.request({ turn: modes.length, toolName: 'write', command, reviewPayload: null });
      if (decision.kind !== 'approve') {
        throw new Error(`unexpected ${decision.kind}`);
      }
    }
    return makeEngineResult(`modes=${modes.join(',')}`);
  }
}

test('setApprovalMode off releases a parked approval, reports it, and the run completes', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(), approvalMode: 'interactive', approvalDelivery: 'progress',
  }, t);
  const session = harness.start();
  const subscriber = new RecordingSubscriber();
  session.attach(subscriber);
  await waitWithTimeout(
    (async () => { while (session.getState().status !== 'approval_required') { await delay(5); } })(),
    'approval park',
  );
  const parked = session.getState();
  assert.equal(parked.status, 'approval_required');
  const released = session.setApprovalMode('off');
  assert.equal(session.getApprovalMode(), 'off');
  assert.ok(released);
  if (parked.status === 'approval_required' && released) {
    assert.equal(released.approvalId, parked.approval.approvalId);
  }
  const result = await session.waitForBoundary(0);
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    assert.ok(result.output.includes('installed'));
  }
  await session.settled;
});

test('setApprovalMode auto or interactive leaves a parked approval waiting and returns null', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(), approvalMode: 'interactive', approvalDelivery: 'progress',
  }, t);
  const session = harness.start();
  session.attach(new RecordingSubscriber());
  await waitWithTimeout(
    (async () => { while (session.getState().status !== 'approval_required') { await delay(5); } })(),
    'approval park',
  );
  assert.equal(session.setApprovalMode('auto'), null);
  assert.equal(session.getApprovalMode(), 'auto');
  assert.equal(session.getState().status, 'approval_required');
  assert.equal(session.setApprovalMode('interactive'), null);
  assert.equal(session.getState().status, 'approval_required');
  session.submitDecision({ runId: harness.runId, decision: 'abort' });
  await session.settled;
});

test('setApprovalMode while running is visible to the engine on its next gate call', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new TwoStepParkingEngine(), approvalMode: 'interactive', approvalDelivery: 'progress',
  }, t);
  const session = harness.start();
  const subscriber = new RecordingSubscriber();
  session.attach(subscriber);
  await waitWithTimeout(
    (async () => { while (subscriber.events.filter((e) => e.kind === 'approval_request').length < 1) { await delay(5); } })(),
    'first approval',
  );
  session.setApprovalMode('off');
  const result = await session.waitForBoundary(0);
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    assert.equal(result.output.includes('modes=interactive,off'), true);
  }
  await session.settled;
});

test('an off-mode session still registers its gate so a later switch can park', async (t) => {
  const harness = await SessionTestHarness.create({
    engine: new ParkingEngine(), approvalMode: 'off', approvalDelivery: 'progress',
  }, t);
  const session = harness.start();
  assert.equal(session.getApprovalMode(), 'off');
  // ParkingEngine calls the human gate directly, so the run parks regardless of mode; abort it.
  await waitWithTimeout(
    (async () => { while (session.getState().status !== 'approval_required') { await delay(5); } })(),
    'approval park',
  );
  assert.ok(harness.approvalGates.get(harness.requestId));
  session.submitDecision({ runId: harness.runId, decision: 'abort' });
  await session.settled;
});
```

Note: with the gate always present, `ParkingEngine` in `off` mode no longer throws `ParkingEngine requires an approval gate.`; the session tests at lines 662-700 that use `approvalMode: 'off'` with `CompletingEngine`/`NonFinishEngine` are unaffected.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js repo-agent-sessions.test.ts`
Expected: type errors for `RepoAgentApprovalDelivery`, `approvalDelivery`, `setApprovalMode`, `getApprovalMode`.

- [ ] **Step 3: Implement the session changes**

In `src/status-server/repo-agent-sessions.ts`:

```ts
/** Where a parked approval surfaces: as a progress frame to the attached client, or as a boundary result. */
export type RepoAgentApprovalDelivery = 'progress' | 'boundary';
```

`RepoAgentEngineRequest` becomes `Omit<RepoSearchExecutionRequest, 'progressWriter' | 'approvalGate' | 'abortSignal'>`.

`RepoAgentSessionOptions`: keep `approvalMode: ApprovalMode` (initial mode), add `approvalDelivery: RepoAgentApprovalDelivery`.

`RepoAgentSession`:
- Replace `private readonly approvalMode: ApprovalMode;` with `private readonly approvalDelivery: RepoAgentApprovalDelivery;`.
- Change `private readonly gate: ApprovalGate | undefined;` to `private readonly gate: ApprovalGate;` and construct it unconditionally:

```ts
    this.approvalDelivery = options.approvalDelivery;
    this.gate = new ApprovalGate({
      requestId: options.requestId,
      progressWriter: this.progressWriter,
      abortSignal: this.abortController.signal,
      mode: options.approvalMode,
      bypassReadOnlyTools: true,
      observer: this,
      ...(options.decisionTimeoutMs === undefined ? {} : { decisionTimeoutMs: options.decisionTimeoutMs }),
    });
```

- Add:

```ts
  getApprovalMode(): ApprovalMode {
    return this.gate.mode;
  }

  /**
   * Switches the live mode. Switching to `off` also approves a parked request and returns it so the
   * caller can record the decision; every other switch leaves a parked request waiting.
   */
  setApprovalMode(mode: ApprovalMode): RepoAgentApproval | null {
    this.gate.setMode(mode);
    if (mode !== 'off' || this.state.status !== 'approval_required') {
      return null;
    }
    const approval = this.state.approval;
    return this.gate.submit(approval.approvalId, { kind: 'approve' }) ? approval : null;
  }
```

Import `type RepoAgentApproval` from `../repo-agent/run-schemas.js`.

- `submitDecision`: replace `if (!this.gate || this.state.status !== 'approval_required')` with `if (this.state.status !== 'approval_required')`.
- `handleProgressEvent`: replace `if (this.approvalMode !== 'interactive') { return; }` with `if (this.approvalDelivery === 'boundary') { return; }`.
- `run()`: replace `if (this.gate) { this.approvalGates.set(...) }` with the unconditional set; replace the engine call's `...(this.gate ? { approvalGate: this.gate } : {}), approvalMode: this.approvalMode,` with `approvalGate: this.gate,`; in `finally` replace `if (this.gate) { delete }` with the unconditional delete.
- `boundaryResultFor`: replace `this.approvalMode !== 'interactive'` with `this.approvalDelivery === 'boundary'`.

`src/status-server/routes/repo-agent.ts`:
- `StartRepoAgentRunInput` gains `approvalDelivery: RepoAgentApprovalDelivery;` (import the type from `../repo-agent-sessions.js`).
- `RepoAgentStartEndpoint.handle`: compute `const approvalMode = input.approval ?? 'auto';` and pass `approvalMode, approvalDelivery: approvalMode === 'interactive' ? 'progress' : 'boundary',` (this preserves the standalone CLI behaviour exactly: interactive prompts through progress frames, auto/off exit at the boundary).
- `startRepoAgentRun`: pass `approvalDelivery: input.approvalDelivery,` into `ctx.repoAgentSessions.start({...})`.

`src/status-server/routes/chat-repo-agent.ts` `run()`: add `approvalDelivery: 'progress',` to the `startRepoAgentRun` call.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js repo-agent-sessions.test.ts; node .\dist\test-runner\run-tests.js status-server-chat-stop.test.ts`
Expected: PASS.

---

### Task 5: Chat route — required mode, live-switch endpoint, mode in active response

**Files:**
- Modify: `src/status-server/routes/chat-repo-agent.ts`
- Modify: `src/status-server/routes/chat.ts:129-132,1699-1701`
- Test: `tests/status-server-chat-repo-agent.test.ts`

- [ ] **Step 1: Write the failing E2E tests**

Append to `tests/status-server-chat-repo-agent.test.ts` (extend imports with `ChatRepoAgentApprovalModeResponseSchema`):

```ts
test('chat repo-agent stream rejects a request without an approval mode', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-no-mode-', t);
  const sessionId = await createSession(harness, 'No mode');
  const response = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: 'write a file', repoRoot: process.cwd(), operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('never'), mockCommandResults: {},
      }),
    },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'approval must be one of: interactive, auto, off.');
});

test('approval-mode endpoint rejects sessions without an active run and invalid modes', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-mode-409-', t);
  const sessionId = await createSession(harness, 'Mode without run');
  const idle = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'off' }) },
  );
  assert.equal(idle.statusCode, 409);
  const invalid = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'manual' }) },
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error, 'approval must be one of: interactive, auto, off.');
});

test('switching a parked chat run to off approves the pending command and skips later approvals', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-switch-off-', t);
  const sessionId = await createSession(harness, 'Switch to off');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write two files',
        repoRoot: process.cwd(),
        approval: 'interactive',
        operationId: OPERATION_A,
        maxTurns: 6,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: 'first.txt', content: 'one' } }] },
          { toolCalls: [{ name: 'write', arguments: { path: 'second.txt', content: 'two' } }] },
          ...repoAgentFinishResponses('wrote both'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  const active = await waitForApproval(harness, sessionId);
  const parsedActive = ActiveChatRepoAgentResponseSchema.parse(active);
  assert.equal(parsedActive.approvalMode, 'interactive');
  assert.equal(parsedActive.status, 'approval_required');
  const parkedApprovalId = parsedActive.status === 'approval_required' ? parsedActive.approval.approvalId : null;

  const switched = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'off' }) },
  );
  assert.equal(switched.statusCode, 200);
  const switchedBody = ChatRepoAgentApprovalModeResponseSchema.parse(switched.body);
  assert.equal(switchedBody.approval, 'off');
  assert.equal(switchedBody.approvedApprovalId, parkedApprovalId);

  const response = await stream;
  assert.equal(response.statusCode, 200);
  // Exactly one approval frame: the second write ran under `off` without parking.
  assert.equal(response.events.filter((event) => event.event === 'approval').length, 1);
  const completed = readDoneResponse(response);
  const approvals = completed.session.messages.filter((message) => message.kind === 'repo_agent_approval');
  assert.equal(approvals.length, 1);
  const approval = approvals[0];
  assert.equal(approval?.kind === 'repo_agent_approval' ? approval.approvalDecision : null, 'approve');
  assert.equal(completed.session.messages.at(-1)?.content.includes('wrote both'), true);
});

test('active endpoint reports the live mode and a running chat run switches modes without parking', async (t) => {
  const gate = new EngineGate();
  const harness = await startHarness('siftkit-chat-repo-agent-mode-running-', t, {
    engineService: new GatedEngineService(gate),
  });
  const sessionId = await createSession(harness, 'Mode while running');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'hold generation', repoRoot: process.cwd(), approval: 'auto', operationId: OPERATION_A,
        mockResponses: repoAgentFinishResponses('held then done'), mockCommandResults: {},
      }),
    },
  );
  await waitForRunStatus(harness, sessionId, 'running');
  const before = ActiveChatRepoAgentResponseSchema.parse(
    (await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`)).body,
  );
  assert.equal(before.approvalMode, 'auto');
  const switched = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/approval-mode`,
    { method: 'POST', body: JSON.stringify({ approval: 'interactive' }) },
  );
  assert.equal(switched.statusCode, 200);
  assert.equal(ChatRepoAgentApprovalModeResponseSchema.parse(switched.body).approvedApprovalId, null);
  const after = ActiveChatRepoAgentResponseSchema.parse(
    (await requestJson(`${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/active`)).body,
  );
  assert.equal(after.approvalMode, 'interactive');
  gate.release();
  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal(readDoneResponse(response).session.messages.filter((m) => m.kind === 'repo_agent_approval').length, 0);
});

test('an auto-mode chat run whose reviewer is unsure surfaces an approval frame instead of ending the stream', async (t) => {
  const harness = await startHarness('siftkit-chat-repo-agent-auto-unsure-', t);
  const sessionId = await createSession(harness, 'Auto unsure');
  const stream = requestSse(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/stream`,
    {
      method: 'POST',
      timeoutMs: 20_000,
      body: JSON.stringify({
        content: 'write a file',
        repoRoot: process.cwd(),
        approval: 'auto',
        operationId: OPERATION_A,
        maxTurns: 4,
        mockResponses: [
          { toolCalls: [{ name: 'write', arguments: { path: 'unsure.txt', content: 'x' } }] },
          { content: '{"verdict":"unsure","reason":"cannot judge"}' },
          ...repoAgentFinishResponses('escalated and approved'),
        ],
        mockCommandResults: {},
      }),
    },
  );
  const active = ActiveChatRepoAgentResponseSchema.parse(await waitForApproval(harness, sessionId));
  assert.equal(active.status, 'approval_required');
  assert.equal(active.approvalMode, 'auto');
  const decide = await requestJson(
    `${harness.baseUrl}/dashboard/chat/sessions/${sessionId}/repo-agent/decide`,
    { method: 'POST', body: JSON.stringify({ decision: 'approve' }) },
  );
  assert.equal(decide.statusCode, 200);
  const response = await stream;
  assert.equal(response.statusCode, 200);
  assert.equal(response.events.some((event) => event.event === 'approval'), true);
  assert.equal(response.events.some((event) => event.event === 'error'), false);
  assert.equal(readDoneResponse(response).session.messages.at(-1)?.content.includes('escalated and approved'), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js status-server-chat-repo-agent.test.ts`
Expected: the new tests fail (404 for the unknown route, 200 instead of 400 for the missing mode, `approvalMode` missing in the active response).

- [ ] **Step 3: Implement the route changes**

`src/status-server/routes/chat-repo-agent.ts`:

Imports: replace the `ApprovalModeSchema` import with
```ts
import {
  ApprovalModeSchema,
  ChatRepoAgentApprovalModeRequestSchema,
  ChatRepoAgentApprovalModeResponseSchema,
} from '@siftkit/contracts';
```

`parseRequest`: replace the optional parse and the `?? 'interactive'` default:

```ts
    const approval = ApprovalModeSchema.safeParse(parsedBody.approval);
    if (!approval.success) {
      sendJson(res, 400, { error: 'approval must be one of: interactive, auto, off.' });
      return null;
    }
    ...
    const extras = ChatRepoAgentRequestExtrasSchema.parse({
      approval: approval.data,
      maxTurns: maxTurns.data,
      mockResponses: mockResponses.data,
      mockCommandResults: mockCommandResults.data,
    });
```

Add the endpoint after `ChatRepoAgentDecideEndpoint`:

```ts
export class ChatRepoAgentApprovalModeEndpoint implements RouteEndpoint {
  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> {
    const sessionId = decodeURIComponent(match.captures[0] ?? '');
    let parsedBody: JsonObject;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch (error) {
      sendBodyReadError(res, toError(error), { error: 'Expected valid JSON object.' });
      return;
    }
    const parsed = ChatRepoAgentApprovalModeRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'approval must be one of: interactive, auto, off.' });
      return;
    }
    const binding = ctx.chatRepoAgentRuns.get(sessionId);
    if (!binding) {
      sendJson(res, 409, { error: `Session ${sessionId} has no active repo-agent run.` });
      return;
    }
    const session = ctx.repoAgentSessions.get(binding.runId);
    if (!session) {
      sendJson(res, 404, { error: `Unknown repo-agent run ${binding.runId}.` });
      return;
    }
    const released = session.setApprovalMode(parsed.data.approval);
    if (released) {
      binding.decisions.push({
        decision: { decision: 'approve' },
        approval: released,
        decidedAtUtc: new Date().toISOString(),
      });
    }
    sendJson(res, 200, ChatRepoAgentApprovalModeResponseSchema.parse({
      ok: true,
      runId: binding.runId,
      approval: session.getApprovalMode(),
      approvedApprovalId: released ? released.approvalId : null,
    }));
  }
}
```

`GetChatRepoAgentActiveEndpoint.handle`: add `approvalMode: session.getApprovalMode(),` to both 200 payloads.

`src/status-server/routes/chat.ts`: import `ChatRepoAgentApprovalModeEndpoint` alongside the other three and register:

```ts
  { method: 'POST', path: /^\/dashboard\/chat\/sessions\/([^/]+)\/repo-agent\/approval-mode$/u, endpoint: new ChatRepoAgentApprovalModeEndpoint() },
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js status-server-chat-repo-agent.test.ts; node .\dist\test-runner\run-tests.js status-server-chat-routes.test.ts; node .\dist\test-runner\run-tests.js status-server-chat-stop.test.ts`
Expected: PASS.

---

### Task 6: Dashboard runtime state and API call

**Files:**
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Modify: `dashboard/src/api.ts` (after `decideRepoAgent`)
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

- [ ] **Step 1: Write the failing store tests**

Append to `dashboard/tests/chat-session-runtime-store.test.ts` (import `DEFAULT_REPO_AGENT_APPROVAL_MODE` from the store):

```ts
test('a fresh runtime uses the default repo-agent approval mode', () => {
  const store = new ChatSessionRuntimeStore().ensureSession('session-a');
  assert.equal(DEFAULT_REPO_AGENT_APPROVAL_MODE, 'auto');
  assert.equal(store.get('session-a').repoAgentApprovalMode, 'auto');
});

test('repo-agent-approval-mode replaces only that field for its own session and survives a run', () => {
  const store = new ChatSessionRuntimeStore()
    .ensureSession('session-a')
    .ensureSession('session-b')
    .apply({ kind: 'draft', sessionId: 'session-a', draft: 'keep me' })
    .apply({ kind: 'repo-agent-approval-mode', sessionId: 'session-a', approval: 'off' });
  assert.equal(store.get('session-a').repoAgentApprovalMode, 'off');
  assert.equal(store.get('session-a').draft, 'keep me');
  assert.equal(store.get('session-b').repoAgentApprovalMode, 'auto');
  const afterRun = store
    .apply({ kind: 'begin', sessionId: 'session-a', operationKind: 'repo-agent', operationId: OPERATION_ID })
    .apply({ kind: 'done', sessionId: 'session-a', response: SAMPLE_RESPONSE });
  assert.equal(afterRun.get('session-a').repoAgentApprovalMode, 'off');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chat-session-runtime-store.test.ts`
Expected: type errors for `repoAgentApprovalMode`, the transition kind, and the missing export.

- [ ] **Step 3: Implement**

`dashboard/src/lib/chat-session-runtime-store.ts`:
- Import `type ApprovalMode` from `@siftkit/contracts`.
- `export const DEFAULT_REPO_AGENT_APPROVAL_MODE: ApprovalMode = 'auto';`
- Add `repoAgentApprovalMode: ApprovalMode;` to `ChatSessionRuntime`.
- Add `| { kind: 'repo-agent-approval-mode'; sessionId: string; approval: ApprovalMode }` to `ChatSessionRuntimeTransition`.
- In `createChatSessionRuntime` add `repoAgentApprovalMode: DEFAULT_REPO_AGENT_APPROVAL_MODE,`.
- In the reducer `switch`, add:

```ts
    case 'repo-agent-approval-mode':
      return { ...runtime, repoAgentApprovalMode: transition.approval };
```

Confirm the `done`, `failure`, and `remote-clear` branches spread `...runtime` so the field persists (they do today).

`dashboard/src/api.ts` — add after `decideRepoAgent` (import `ChatRepoAgentApprovalModeResponseSchema`, `type ApprovalMode`, `type ChatRepoAgentApprovalModeResponse` from `@siftkit/contracts`):

```ts
export function updateRepoAgentApprovalMode(
  sessionId: string,
  approval: ApprovalMode,
): Promise<ChatRepoAgentApprovalModeResponse> {
  return fetchJson(
    `/dashboard/chat/sessions/${encodeURIComponent(sessionId)}/repo-agent/approval-mode`,
    ChatRepoAgentApprovalModeResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval }),
    },
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chat-session-runtime-store.test.ts`
Expected: PASS.

---

### Task 7: Hook and controller wiring

**Files:**
- Modify: `dashboard/src/hooks/useChatSessions.ts` (imports, load effect at lines ~121-146, `sendRepoAgent` at ~552-567, return object)
- Modify: `dashboard/src/hooks/useChatController.ts` (`tabProps`)
- Modify: `dashboard/src/tabs/ChatTab.tsx:60-100` (`ChatTabProps`)
- Test: `dashboard/tests/chat-tab.test.tsx` (`buildProps` defaults)

There is no hook-level test harness in the dashboard suite; the behaviour is covered by the server E2E tests (Task 5) and the component tests (Task 8). Keep this task to wiring and typecheck.

- [ ] **Step 1: Add the props**

`dashboard/src/tabs/ChatTab.tsx` `ChatTabProps`: add

```ts
  onChangeRepoAgentApprovalMode(mode: ApprovalMode): Promise<void>;
```

with `import type { ApprovalMode } from '@siftkit/contracts';`. The current mode itself is read from `selectedRuntime.repoAgentApprovalMode`, so no value prop is needed.

`dashboard/tests/chat-tab.test.tsx` `buildProps`: add `onChangeRepoAgentApprovalMode: async () => {},` to the defaults.

- [ ] **Step 2: Implement the hook**

`dashboard/src/hooks/useChatSessions.ts`:

Import `updateRepoAgentApprovalMode` from `../api` and `type ApprovalMode` from `@siftkit/contracts`.

In the load effect, inside `if (activeRun?.status === 'approval_required') { ... } else { ... }`, add before it:

```ts
          if (activeRun) {
            setRuntimeStore((previous) => previous.apply({
              kind: 'repo-agent-approval-mode',
              sessionId: response.session.id,
              approval: activeRun.approvalMode,
            }));
          }
```

`readRuntimeInputs`: add `repoAgentApprovalMode: runtime.repoAgentApprovalMode,` to the returned object and its type.

`sendRepoAgent`: add `approval: inputs.repoAgentApprovalMode,` to the `streamRepoAgentMessage` payload.

Add next to `submitRepoAgentDecision`:

```ts
  async function setRepoAgentApprovalMode(approval: ApprovalMode): Promise<void> {
    const session = requireSelectedSession(selectedSession);
    const runtime = runtimeStore.get(session.id);
    const previous = runtime.repoAgentApprovalMode;
    const pending = runtime.pendingApproval;
    setRuntimeStore((store) => store.apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval }));
    if (runtime.activity.kind !== 'local' || runtime.activity.operationKind !== 'repo-agent') {
      return;
    }
    try {
      const response = await updateRepoAgentApprovalMode(session.id, approval);
      if (pending && response.approvedApprovalId === pending.approvalId) {
        setRuntimeStore((store) => store.apply({
          kind: 'approval-decision',
          sessionId: session.id,
          resolution: { approval: pending, decision: { decision: 'approve' }, decidedAtUtc: new Date().toISOString() },
        }));
      }
    } catch (error) {
      setRuntimeStore((store) => store
        .apply({ kind: 'repo-agent-approval-mode', sessionId: session.id, approval: previous })
        .apply({ kind: 'control-error', sessionId: session.id, message: toError(error).message }));
    }
  }
```

Export `setRepoAgentApprovalMode` from the hook's return object.

`dashboard/src/hooks/useChatController.ts` `tabProps`: add `onChangeRepoAgentApprovalMode: chatSessionsHook.setRepoAgentApprovalMode,`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p .\dashboard\tsconfig.json --noEmit; npx tsc -p .\dashboard\tsconfig.test.json --noEmit`
Expected: no errors (ChatTab does not yet use the prop; that is Task 8).

---

### Task 8: Approval-mode control in the composer

**Files:**
- Create: `dashboard/src/components/RepoAgentApprovalModeControl.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx` (repo-tool row at ~497-511)
- Modify: `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Append to `dashboard/tests/chat-tab.test.tsx`:

```ts
test('repo-agent composer shows the approval mode control with Auto selected by default', () => {
  renderComponent(<ChatTab {...buildProps({ chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false })} />);
  const group = screen.getByRole('group', { name: 'Approval mode' });
  const buttons = ['Manual', 'Auto', 'Approve all'].map((name) => screen.getByRole('button', { name }));
  assert.equal(buttons.length, 3);
  assert.equal(group.contains(buttons[1] ?? null), true);
  assert.equal(buttons[0]?.getAttribute('aria-pressed'), 'false');
  assert.equal(buttons[1]?.getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[2]?.getAttribute('aria-pressed'), 'false');
});

test('non-repo-agent modes do not render the approval mode control', () => {
  renderComponent(<ChatTab {...buildProps({ chatMode: 'repo-search', isRepoToolMode: true, isDirectChatMode: false })} />);
  assert.equal(screen.queryByRole('group', { name: 'Approval mode' }), null);
});

test('clicking an approval mode reports the wire value and reflects the stored mode', async () => {
  const changes: string[] = [];
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'repo-agent-approval-mode', sessionId: SESSION_A.id, approval: 'off' });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll(),
    onChangeRepoAgentApprovalMode: async (mode) => { changes.push(mode); },
  })} />);
  assert.equal(screen.getByRole('button', { name: 'Approve all' }).getAttribute('aria-pressed'), 'true');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Manual' })); });
  assert.deepEqual(changes, ['interactive']);
});

test('the approval mode control stays enabled while this client owns a running repo-agent', () => {
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'begin', sessionId: SESSION_A.id, operationKind: 'repo-agent', operationId: OPERATION_ID });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll(),
  })} />);
  assert.equal(screen.getByRole('button', { name: 'Auto' }).hasAttribute('disabled'), false);
  assert.equal(screen.getByRole('textbox').hasAttribute('disabled'), true);
});

test('the approval mode control is disabled when another client owns the run', () => {
  const store = buildDefaultStore(SESSION_A.id)
    .apply({ kind: 'remote-begin', sessionId: SESSION_A.id, operationKind: 'repo-agent' });
  renderComponent(<ChatTab {...buildProps({
    chatMode: 'repo-agent', isRepoToolMode: true, isDirectChatMode: false,
    selectedRuntime: store.get(SESSION_A.id), sessionRuntimes: store.getAll(),
  })} />);
  for (const name of ['Manual', 'Auto', 'Approve all']) {
    assert.equal(screen.getByRole('button', { name }).hasAttribute('disabled'), true);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx`
Expected: the five new tests fail (`Unable to find role="group"`).

- [ ] **Step 3: Implement the control**

Create `dashboard/src/components/RepoAgentApprovalModeControl.tsx`:

```tsx
import React from 'react';
import type { ApprovalMode } from '@siftkit/contracts';

const APPROVAL_MODE_OPTIONS = [
  { value: 'interactive', label: 'Manual', title: 'Every mutating tool call waits for your approval' },
  { value: 'auto', label: 'Auto', title: 'The model reviews each mutating call; unsure calls wait for you' },
  { value: 'off', label: 'Approve all', title: 'No approvals; a pending approval is released immediately' },
] as const satisfies readonly { value: ApprovalMode; label: string; title: string }[];

export function RepoAgentApprovalModeControl({ value, disabled, onChange }: {
  value: ApprovalMode;
  disabled: boolean;
  onChange(mode: ApprovalMode): void;
}) {
  return (
    <div className="approval-mode" role="group" aria-label="Approval mode">
      {APPROVAL_MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'hchip on' : 'hchip'}
          aria-pressed={option.value === value}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
```

`dashboard/src/tabs/ChatTab.tsx`:
- Import `RepoAgentApprovalModeControl`.
- Destructure the new prop `onChangeRepoAgentApprovalMode`.
- Inside the `isRepoToolMode` row, after the `Directory` button:

```tsx
                  {chatMode === 'repo-agent' && selectedRuntime ? (
                    <RepoAgentApprovalModeControl
                      value={selectedRuntime.repoAgentApprovalMode}
                      disabled={selectedRuntime.activity.kind === 'remote'}
                      onChange={(mode) => { void onChangeRepoAgentApprovalMode(mode); }}
                    />
                  ) : null}
```

`dashboard/src/styles/chat.css`, after `.composer-plan-row`:

```css
.approval-mode { display: inline-flex; gap: 4px; margin-left: auto; }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build:test; node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx`
Expected: PASS, including the pre-existing repo-agent tests (`Run Agent` label, pending approval card, Stop button).

---

### Task 9: Full verification and cleanup

- [ ] **Step 1: Search for leftovers**

Run: `rg -n "approvalMode" src dashboard/src packages/contracts/src`
Expected: matches only in `src/status-server/repo-agent-sessions.ts` (option name `approvalMode` for the initial mode), `src/status-server/routes/repo-agent.ts` / `chat-repo-agent.ts` (`approvalMode:` passed to `startRepoAgentRun`), `GetChatRepoAgentActiveEndpoint` (`approvalMode:` response field), `dashboard/src/hooks/useChatSessions.ts` (`activeRun.approvalMode`), and `packages/contracts/src/chat.ts` (`approvalMode` response field). No `approvalMode` in `task-loop*.ts`, `engine.ts`, `types.ts`, `execute.ts`, or `routes/repo-search.ts`.

Run: `rg -n "z.enum\(\['interactive', 'auto', 'off'\]\)" src packages dashboard/src`
Expected: exactly one match, in `packages/contracts/src/chat.ts`.

- [ ] **Step 2: Run everything**

Run in order:
```text
npm run build:test
npm run test
npm run test:dashboard
npm run typecheck
```
Expected: all green. `npm run typecheck` includes `npm run lint`.

- [ ] **Step 3: Manual smoke (dashboard)**

Start the server and dashboard (`npm run start`), open a repo-agent session:
1. Confirm the row shows Manual / Auto / Approve all with Auto selected.
2. Select Manual, run a task that writes a file, confirm the approval card appears, click Approve all, confirm the card resolves to a green `approve` row and the run continues without further cards.
3. Start a run in Approve all, switch to Manual mid-stream, confirm the next mutating tool parks.
4. Reload the page during a run; confirm the control shows the server's live mode.

- [ ] **Step 4: Report**

State result, changed files, validation commands run with outcomes, and the known limitation that the chosen mode is not persisted across reloads for idle sessions.
