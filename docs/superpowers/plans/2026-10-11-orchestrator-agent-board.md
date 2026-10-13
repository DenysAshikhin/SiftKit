# Orchestrator Agent Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Chat tab's orchestrator panel with a live "agent board" that shows the run's phase, scheduler slots, every task, and what each running agent is doing right now. This is mockup option A (`C:\tmp\siftkit-agent-mockups\a-inline-board.html`).

**Architecture:** The parent `OrchestratorRun` subscribes to each child `RepoAgentSession`'s progress events and folds them into an in-memory `OrchestratorActivity` view: task claims, model slots, and per-child turn, context and recent tool calls. It publishes the view through `OrchestratorRunRegistry`, and the existing `/orchestrator/events` SSE stream forwards it as a new `activity` frame. Activity is never persisted; a reconnecting client gets the current snapshot. The dashboard hook keeps the latest activity and the last work phase. The panel renders them through a pure view-model module.

**Tech Stack:** TypeScript (Node 26 native TS), zod contracts in `packages/contracts`, node:test for server tests, React + vitest + Testing Library for dashboard tests.

**Repository rules that apply to every task:**
- Do **not** commit. The user commits manually; each task ends with a test checkpoint instead.
- No `any`, type assertions, non-null assertions, or namespace imports. Parse IO with zod schemas.
- Comments stay 1–2 lines and follow the surrounding style.
- State indicators stay static (no CSS animations). See the comment in `dashboard/src/styles/chat.css`.

**Out of scope (deliberate deviations from the mockup):** run-wide token totals, the "Open plan" and "Diff" buttons, and per-tool durations. No backing data or endpoint exists for these yet.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `packages/contracts/src/orchestrator.ts` | Modify | Activity schemas, `ORCHESTRATOR_ACTIVITY_FRAME`, `ORCHESTRATOR_RECENT_TOOL_LIMIT`, `ORCHESTRATOR_OPEN_TASK_STATUSES` |
| `src/orchestrator/run-store.ts` | Modify | Use the shared open-status list |
| `src/orchestrator/child-activity.ts` | Create | Pure reducer: child progress event → child activity |
| `src/orchestrator/scheduler.ts` | Modify | Export `taskClaim` / `TaskClaim` |
| `src/status-server/orchestrator-runs.ts` | Modify | Activity publish/subscribe; `OrchestratorLiveRun.activitySnapshot()` |
| `src/orchestrator/live-activity.ts` | Create | `OrchestratorLiveActivity`: claims, tracked children, publishing |
| `src/orchestrator/run.ts` | Modify | Owns a live-activity view; tracks children; sets plan claims |
| `src/status-server/routes/orchestrator.ts` | Modify | Events stream writes `activity` frames |
| `dashboard/src/orchestrator-api.ts` | Modify | `followOrchestrator` yields progress and activity items |
| `dashboard/src/hooks/useOrchestratorRun.ts` | Modify | Exposes `activity` and `workPhase` |
| `dashboard/src/hooks/useNow.ts` | Create | Ticking clock while a run is live |
| `dashboard/src/orchestrator-view.ts` | Create | Pure view model: steps, slots, wait reasons, labels, elapsed |
| `dashboard/src/components/OrchestratorTaskRow.tsx` | Create | One task row, agent card, attempt result, drift summary |
| `dashboard/src/components/OrchestratorRunPanel.tsx` | Rewrite | Board header, meta, stepper, slot meter, task list, approval, failure |
| `dashboard/src/styles/orchestrator.css` | Create | Board styles |
| `dashboard/src/styles.css` | Modify | Import `orchestrator.css` |
| `dashboard/src/tabs/ChatTab.tsx` | Modify | Pass `activity` / `workPhase` to the panel |
| Tests | Create/Modify | `tests/contracts-orchestrator.test.ts`, `tests/orchestrator-child-activity.test.ts`, `tests/orchestrator-runs.test.ts`, `tests/orchestrator-live-activity.test.ts`, `tests/process/orchestrator-run.e2e.test.ts`, `dashboard/tests/use-orchestrator-run.test.tsx`, `dashboard/tests/use-now.test.tsx`, `dashboard/tests/orchestrator-view.test.ts`, `dashboard/tests/orchestrator-run-panel.test.tsx` |

**Commands used below:**
- One server test file: `node .\src\test-runner\run-tests.ts <path>` (add `--test-name-pattern "<name>"` to narrow it)
- Server test types: `npm run typecheck:test`
- One dashboard test file: `npx vitest run --config .\dashboard\vitest.config.ts <path>`
- Dashboard test types: `npm run typecheck:dashboard-test`

---

### Task 1: Activity contracts and the shared open-status list

**Files:**
- Modify: `packages/contracts/src/orchestrator.ts`
- Modify: `src/orchestrator/run-store.ts:39-40,246`
- Test: `tests/contracts-orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these names to the existing `@siftkit/contracts` import in `tests/contracts-orchestrator.test.ts`: `ORCHESTRATOR_OPEN_TASK_STATUSES`, `ORCHESTRATOR_RECENT_TOOL_LIMIT`, `OrchestratorActivitySchema`, `OrchestratorChildActivitySchema`, `OrchestratorModelSlotsSchema`. Then append:

```ts
const LIVE_CHILD = {
  childRunId: '00000000-0000-4000-8000-000000000002', taskId: 'greeting', startedAtUtc: '2026-10-11T12:00:00.000Z',
  waitingForModel: false, turn: 3, maxTurns: 40, promptTokens: 1200, contextTokens: 32768, tools: [],
};
const LIVE_TOOL = { toolCallId: 't1', turn: 3, activityKind: 'edit', command: 'write src/greeting.ts', status: 'running' };

test('a live activity snapshot carries claims, model slots, and children with a bounded tool history', () => {
  const activity = OrchestratorActivitySchema.parse({
    runId: LIVE_CHILD.childRunId, claims: [{ taskId: 'greeting', modelId: 'exl3-main', mutating: true }],
    models: [{ modelId: 'exl3-main', slots: 2 }], children: [{ ...LIVE_CHILD, tools: [LIVE_TOOL] }],
  });
  assert.equal(activity.children[0]?.tools[0]?.status, 'running');
  const tooMany = Array.from({ length: ORCHESTRATOR_RECENT_TOOL_LIMIT + 1 }, (_, index) => ({ ...LIVE_TOOL, toolCallId: `t${index}` }));
  assert.equal(OrchestratorChildActivitySchema.safeParse({ ...LIVE_CHILD, tools: tooMany }).success, false);
  assert.equal(OrchestratorChildActivitySchema.safeParse({ ...LIVE_CHILD, extra: true }).success, false);
  assert.equal(OrchestratorChildActivitySchema.safeParse({ ...LIVE_CHILD, maxTurns: null, turn: 0 }).success, true);
  assert.equal(OrchestratorModelSlotsSchema.safeParse({ modelId: 'm', slots: 0 }).success, false);
});

test('open task statuses are exactly the statuses of live work', () => {
  assert.deepEqual([...ORCHESTRATOR_OPEN_TASK_STATUSES], ['running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending']);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node .\src\test-runner\run-tests.ts tests/contracts-orchestrator.test.ts`
Expected: FAIL. The new imports do not exist, so `OrchestratorActivitySchema` is undefined.

- [ ] **Step 3: Add the contracts**

In `packages/contracts/src/orchestrator.ts`, extend the `./chat.ts` import with `ToolActivityKindSchema`:

```ts
import {
  ApprovalModeSchema,
  RepoAgentAbortDecisionSchema,
  RepoAgentApprovalSchema,
  RepoAgentApproveDecisionSchema,
  RepoAgentDenyDecisionSchema,
  ToolActivityKindSchema,
} from './chat.ts';
```

Directly after `export type OrchestratorTaskStatus = ...;` add:

```ts
/** Task statuses that mean live work: the task holds its scheduler claim. */
export const ORCHESTRATOR_OPEN_TASK_STATUSES: readonly OrchestratorTaskStatus[] = [
  'running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending',
];
```

At the end of the file add:

```ts
/** How many of a child's latest tool calls the live view keeps. */
export const ORCHESTRATOR_RECENT_TOOL_LIMIT = 4;
/** SSE frame name for live, unpersisted activity on the orchestrator events stream. */
export const ORCHESTRATOR_ACTIVITY_FRAME = 'activity';

export const OrchestratorToolCallActivitySchema = z.object({
  toolCallId: z.string().min(1), turn: z.number().int().positive(), activityKind: ToolActivityKindSchema,
  command: z.string(), status: z.enum(['running', 'succeeded', 'failed']),
}).strict();
export type OrchestratorToolCallActivity = z.infer<typeof OrchestratorToolCallActivitySchema>;

/** A running child as the parent observes it; in memory only, dropped when the child settles. */
export const OrchestratorChildActivitySchema = z.object({
  childRunId: z.string().uuid(), taskId: z.string().min(1), startedAtUtc: z.string().datetime(),
  waitingForModel: z.boolean(), turn: z.number().int().nonnegative(), maxTurns: z.number().int().positive().nullable(),
  promptTokens: z.number().nonnegative(), contextTokens: z.number().positive(),
  tools: z.array(OrchestratorToolCallActivitySchema).max(ORCHESTRATOR_RECENT_TOOL_LIMIT),
}).strict();
export type OrchestratorChildActivity = z.infer<typeof OrchestratorChildActivitySchema>;

/** What a task claims from the scheduler: one slot of its worker's model, and the writer slot if it mutates. */
export const OrchestratorTaskClaimSchema = z.object({
  taskId: z.string().min(1), modelId: z.string().min(1), mutating: z.boolean(),
}).strict();
export type OrchestratorTaskClaim = z.infer<typeof OrchestratorTaskClaimSchema>;

export const OrchestratorModelSlotsSchema = z.object({ modelId: z.string().min(1), slots: z.number().positive() }).strict();
export type OrchestratorModelSlots = z.infer<typeof OrchestratorModelSlotsSchema>;

/** The parent's live view; claims and models are empty until the plan is saved. */
export const OrchestratorActivitySchema = z.object({
  runId: z.string().uuid(), claims: z.array(OrchestratorTaskClaimSchema), models: z.array(OrchestratorModelSlotsSchema),
  children: z.array(OrchestratorChildActivitySchema),
}).strict();
export type OrchestratorActivity = z.infer<typeof OrchestratorActivitySchema>;
```

- [ ] **Step 4: Use the shared list in the run store**

In `src/orchestrator/run-store.ts`, add `ORCHESTRATOR_OPEN_TASK_STATUSES` to the `@siftkit/contracts` import. Delete these lines (39–40):

```ts
/** Task statuses that mean live work; a stopped parent turns them into `aborted`. */
const OPEN_TASK_STATUSES: readonly OrchestratorTaskStatus[] = ['running', 'verifying', 'reviewing_drift', 'correcting_drift', 'retry_pending'];
```

On line 246, replace `OPEN_TASK_STATUSES.includes(task.status)` with `ORCHESTRATOR_OPEN_TASK_STATUSES.includes(task.status)`. If `OrchestratorTaskStatus` is no longer used in the file, remove it from the import (lint will flag it).

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node .\src\test-runner\run-tests.ts tests/contracts-orchestrator.test.ts`, then `node .\src\test-runner\run-tests.ts tests/orchestrator-run-store.test.ts`, then `npm run typecheck:test`
Expected: all three PASS.

---

### Task 2: Child activity reducer

**Files:**
- Create: `src/orchestrator/child-activity.ts`
- Test: `tests/orchestrator-child-activity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator-child-activity.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ORCHESTRATOR_RECENT_TOOL_LIMIT, type OrchestratorChildActivity } from '@siftkit/contracts';
import { reduceChildActivity } from '../src/orchestrator/child-activity.ts';
import type { OperationProgressEvent } from '../src/repo-search/types.ts';

const START: OrchestratorChildActivity = {
  childRunId: '00000000-0000-4000-8000-000000000002', taskId: 'write', startedAtUtc: '2026-10-11T12:00:00.000Z',
  waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, contextTokens: 4000, tools: [],
};

function toolStart(id: string): OperationProgressEvent {
  return { kind: 'tool_start', turn: 2, maxTurns: 40, toolCallId: id, activityKind: 'command', activitySubject: { kind: 'none' },
    command: `run step ${id}`, promptTokenCount: 900, thinkingTokenCount: 0, elapsedMs: 20 };
}

function toolResult(id: string, exitCode: number): OperationProgressEvent {
  return { kind: 'tool_result', turn: 2, maxTurns: 40, toolCallId: id, activityKind: 'command', activitySubject: { kind: 'none' },
    command: `run step ${id}`, exitCode, outputSnippet: '', outputTokens: 0, outputTokensEstimated: false,
    promptTokenCount: 900, thinkingTokenCount: 0, elapsedMs: 30 };
}

test('waiting for the model is shown once and cleared by the first turn', () => {
  const waiting = reduceChildActivity(START, { kind: 'lock_wait', elapsedMs: 2000 });
  assert.equal(waiting.waitingForModel, true);
  assert.equal(reduceChildActivity(waiting, { kind: 'lock_wait', elapsedMs: 4000 }), waiting, 'a repeated heartbeat is not a change');
  const turn = reduceChildActivity(waiting, { kind: 'llm_start', turn: 1, maxTurns: 40, promptTokenCount: 800, thinkingTokenCount: 0, elapsedMs: 10 });
  assert.deepEqual([turn.waitingForModel, turn.turn, turn.maxTurns, turn.promptTokens], [false, 1, 40, 800]);
});

test('tool calls start running, settle by exit code, and only the most recent are kept', () => {
  assert.equal(ORCHESTRATOR_RECENT_TOOL_LIMIT, 4);
  let activity = START;
  for (const id of ['a', 'b', 'c', 'd', 'e']) activity = reduceChildActivity(activity, toolStart(id));
  assert.deepEqual(activity.tools.map((tool) => tool.toolCallId), ['b', 'c', 'd', 'e']);
  activity = reduceChildActivity(reduceChildActivity(activity, toolResult('d', 0)), toolResult('e', 2));
  assert.deepEqual(activity.tools.map((tool) => tool.status), ['running', 'running', 'succeeded', 'failed']);
  assert.equal(reduceChildActivity(activity, toolResult('a', 0)), activity, 'a result for a dropped call changes nothing');
});

test('events with nothing visible return the same view', () => {
  assert.equal(reduceChildActivity(START, { kind: 'thinking', turn: 1, maxTurns: 40, thinkingText: 'hmm' }), START);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests/orchestrator-child-activity.test.ts`
Expected: FAIL. The module `../src/orchestrator/child-activity.ts` cannot be found.

- [ ] **Step 3: Implement the reducer**

Create `src/orchestrator/child-activity.ts`:

```ts
import { ORCHESTRATOR_RECENT_TOOL_LIMIT, type OrchestratorChildActivity, type OrchestratorToolCallActivity } from '@siftkit/contracts';

import type { OperationProgressEvent } from '../repo-search/types.ts';

/** Folds one child progress event into its live view; the same object back means nothing visible changed. */
export function reduceChildActivity(activity: OrchestratorChildActivity, event: OperationProgressEvent): OrchestratorChildActivity {
  switch (event.kind) {
    case 'lock_wait':
      return activity.waitingForModel ? activity : { ...activity, waitingForModel: true };
    case 'llm_start':
      return { ...activity, waitingForModel: false, turn: event.turn, maxTurns: event.maxTurns, promptTokens: event.promptTokenCount };
    case 'tool_start': {
      const started: OrchestratorToolCallActivity = {
        toolCallId: event.toolCallId, turn: event.turn, activityKind: event.activityKind, command: event.command, status: 'running',
      };
      return { ...activity, waitingForModel: false, tools: [...activity.tools, started].slice(-ORCHESTRATOR_RECENT_TOOL_LIMIT) };
    }
    case 'tool_result': {
      if (!activity.tools.some((tool) => tool.toolCallId === event.toolCallId)) return activity;
      const status: OrchestratorToolCallActivity['status'] = event.exitCode === 0 ? 'succeeded' : 'failed';
      return { ...activity, tools: activity.tools.map((tool) => (tool.toolCallId === event.toolCallId ? { ...tool, status } : tool)) };
    }
    default:
      return activity;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `node .\src\test-runner\run-tests.ts tests/orchestrator-child-activity.test.ts`, then `npm run typecheck:test`
Expected: PASS.

---

### Task 3: Registry activity channel

**Files:**
- Modify: `src/status-server/orchestrator-runs.ts`
- Test: `tests/orchestrator-runs.test.ts`

- [ ] **Step 1: Write the failing test and update the fake**

In `tests/orchestrator-runs.test.ts`, change the contracts import to `import type { OrchestratorActivity, OrchestratorRunState } from '@siftkit/contracts';`. Add this method to `FakeLiveRun`:

```ts
  activitySnapshot(): OrchestratorActivity {
    return { runId: this.runId, claims: [], models: [], children: [] };
  }
```

Search the repository for other implementers: `rg "implements OrchestratorLiveRun|: OrchestratorLiveRun = \{" src tests`. Add the same method to any you find, other than `OrchestratorRun`, which Task 5 handles.

Append the test:

```ts
test('activity reaches only its own run\'s subscribers, until they detach', (t) => {
  const registry = new OrchestratorRunRegistry(openStore(t));
  const runA = randomUUID();
  const runB = randomUUID();
  const seen: string[] = [];
  const detach = registry.subscribeActivity(runA, (activity) => seen.push(activity.runId));
  registry.publishActivity({ runId: runA, claims: [], models: [], children: [] });
  registry.publishActivity({ runId: runB, claims: [], models: [], children: [] });
  detach();
  registry.publishActivity({ runId: runA, claims: [], models: [], children: [] });
  assert.deepEqual(seen, [runA]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests/orchestrator-runs.test.ts`
Expected: FAIL. `registry.subscribeActivity` is not a function.

- [ ] **Step 3: Implement the channel**

In `src/status-server/orchestrator-runs.ts`:

1. Change the contracts import to:
```ts
import { isOrchestratorTerminalPhase, type OrchestratorActivity, type OrchestratorRunState, type RepoAgentDecision } from '@siftkit/contracts';
```
2. Add `activitySnapshot()` to `OrchestratorLiveRun`:
```ts
export type OrchestratorLiveRun = {
  readonly runId: string;
  readonly settled: Promise<void>;
  abort(reason: string): void;
  /** Answers the pending user approval; false when that approval is not the one waiting. */
  decide(approvalId: string, decision: RepoAgentDecision): boolean;
  /** The current live view, for a client that connects mid-run. */
  activitySnapshot(): OrchestratorActivity;
};
```
3. Replace `type StateListener = (state: OrchestratorRunState) => void;` with:
```ts
type StateListener = (state: OrchestratorRunState) => void;
type ActivityListener = (activity: OrchestratorActivity) => void;

function addListener<T>(listeners: Map<string, Set<(value: T) => void>>, runId: string, listener: (value: T) => void): () => void {
  const forRun = listeners.get(runId) ?? new Set<(value: T) => void>();
  forRun.add(listener);
  listeners.set(runId, forRun);
  return () => {
    forRun.delete(listener);
    if (forRun.size === 0) listeners.delete(runId);
  };
}
```
4. In `OrchestratorRunRegistry`, add the field `private readonly activityListeners = new Map<string, Set<ActivityListener>>();`. Replace the body of `subscribe` with `return addListener(this.listeners, runId, listener);`. Add, after `publish`:
```ts
  subscribeActivity(runId: string, listener: ActivityListener): () => void {
    return addListener(this.activityListeners, runId, listener);
  }

  /** Fans the live view out to its subscribers; nothing is stored. */
  publishActivity(activity: OrchestratorActivity): void {
    for (const listener of [...(this.activityListeners.get(activity.runId) ?? [])]) listener(activity);
  }
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `node .\src\test-runner\run-tests.ts tests/orchestrator-runs.test.ts`
Expected: PASS. `npm run typecheck:test` will still fail on `OrchestratorRun` lacking `activitySnapshot`; Task 5 fixes that. Do not stub it here.

---

### Task 4: Live activity view

**Files:**
- Modify: `src/orchestrator/scheduler.ts:17-24`
- Create: `src/orchestrator/live-activity.ts`
- Test: `tests/orchestrator-live-activity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator-live-activity.test.ts`:

```ts
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { OrchestratorActivity } from '@siftkit/contracts';
import { getActiveModelPreset } from '../src/config/getters.ts';
import { OrchestratorLiveActivity } from '../src/orchestrator/live-activity.ts';
import { OrchestratorRunStore } from '../src/orchestrator/run-store.ts';
import type { OperationProgressEvent } from '../src/repo-search/types.ts';
import { getDefaultConfig } from '../src/status-server/config-store.ts';
import { OrchestratorRunRegistry } from '../src/status-server/orchestrator-runs.ts';
import type { RepoAgentSessionSubscriber } from '../src/status-server/repo-agent-sessions.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { makeOrchestratorPlan, makeOrchestratorTask } from './helpers/orchestrator-plan.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';

function openRegistry(t: TestContext): { registry: OrchestratorRunRegistry; published: OrchestratorActivity[] } {
  const dbPath = path.join(createManagedTempDir('siftkit-live-activity-'), 'runtime.sqlite');
  t.after(() => closeAllRuntimeDatabases());
  const registry = new OrchestratorRunRegistry(new OrchestratorRunStore(getRuntimeDatabase(dbPath)));
  const published: OrchestratorActivity[] = [];
  registry.subscribeActivity(RUN_ID, (activity) => published.push(activity));
  return { registry, published };
}

class FakeSession {
  subscriber: RepoAgentSessionSubscriber | null = null;
  detached = false;

  attach(subscriber: RepoAgentSessionSubscriber): () => void {
    this.subscriber = subscriber;
    return () => { this.detached = true; };
  }

  emit(event: OperationProgressEvent): void {
    if (this.subscriber === null) throw new Error('No subscriber attached.');
    this.subscriber.writeProgress(event);
  }
}

test('a saved plan publishes each task claim and the distinct model slots', (t) => {
  const { registry, published } = openRegistry(t);
  const config = getDefaultConfig();
  const model = getActiveModelPreset(config);
  model.ParallelSlots = 2;
  const live = new OrchestratorLiveActivity(RUN_ID, registry);
  live.setPlan(config, makeOrchestratorPlan([
    makeOrchestratorTask({ id: 'read' }),
    makeOrchestratorTask({ id: 'write', workerPresetId: 'repo-agent', writePaths: ['src/a.ts'] }),
  ]));
  assert.deepEqual(published.at(-1), {
    runId: RUN_ID, children: [],
    claims: [{ taskId: 'read', modelId: model.id, mutating: false }, { taskId: 'write', modelId: model.id, mutating: true }],
    models: [{ modelId: model.id, slots: 2 }],
  });
});

test('a tracked child publishes visible progress only; untracking detaches it and drops it from the view', (t) => {
  const { registry, published } = openRegistry(t);
  const live = new OrchestratorLiveActivity(RUN_ID, registry);
  const session = new FakeSession();
  live.track(session, { childRunId: CHILD_ID, taskId: 'write', contextTokens: 4000 });
  assert.deepEqual(published.at(-1)?.children.map((child) => [child.childRunId, child.turn, child.maxTurns]), [[CHILD_ID, 0, null]]);
  session.emit({ kind: 'llm_start', turn: 1, maxTurns: 40, promptTokenCount: 800, thinkingTokenCount: 0, elapsedMs: 10 });
  const count = published.length;
  session.emit({ kind: 'thinking', turn: 1, maxTurns: 40, thinkingText: 'hmm' });
  assert.equal(published.length, count, 'thinking text changes nothing visible');
  assert.deepEqual(live.snapshot().children.map((child) => [child.turn, child.maxTurns, child.promptTokens]), [[1, 40, 800]]);
  live.untrack(CHILD_ID);
  assert.equal(session.detached, true);
  assert.deepEqual(published.at(-1)?.children, []);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests/orchestrator-live-activity.test.ts`
Expected: FAIL. The module `../src/orchestrator/live-activity.ts` cannot be found.

- [ ] **Step 3: Export the scheduler claim**

In `src/orchestrator/scheduler.ts`, change:

```ts
type TaskClaim = { mutating: boolean; modelId: string; slots: number };

function taskClaim(config: SiftConfig, task: OrchestratorTask): TaskClaim {
```

to:

```ts
export type TaskClaim = { mutating: boolean; modelId: string; slots: number };

export function taskClaim(config: SiftConfig, task: OrchestratorTask): TaskClaim {
```

- [ ] **Step 4: Implement the live view**

Create `src/orchestrator/live-activity.ts`:

```ts
import type {
  OrchestratorActivity,
  OrchestratorChildActivity,
  OrchestratorModelSlots,
  OrchestratorPlan,
  OrchestratorTaskClaim,
} from '@siftkit/contracts';

import type { SiftConfig } from '../config/types.ts';
import type { OperationProgressEvent } from '../repo-search/types.ts';
import type { OrchestratorRunRegistry } from '../status-server/orchestrator-runs.ts';
import type { RepoAgentSession } from '../status-server/repo-agent-sessions.ts';
import { reduceChildActivity } from './child-activity.ts';
import { taskClaim } from './scheduler.ts';

/** A parent's in-memory view of its scheduler claims and running children, published on every visible change. */
export class OrchestratorLiveActivity {
  private claims: OrchestratorTaskClaim[] = [];
  private models: OrchestratorModelSlots[] = [];
  private readonly children = new Map<string, OrchestratorChildActivity>();
  private readonly detachers = new Map<string, () => void>();
  private readonly runId: string;
  private readonly registry: OrchestratorRunRegistry;

  constructor(runId: string, registry: OrchestratorRunRegistry) {
    this.runId = runId;
    this.registry = registry;
  }

  setPlan(config: SiftConfig, plan: OrchestratorPlan): void {
    const claimed = plan.tasks.map((task) => ({ taskId: task.id, ...taskClaim(config, task) }));
    this.claims = claimed.map(({ taskId, modelId, mutating }) => ({ taskId, modelId, mutating }));
    this.models = [...new Map(claimed.map((claim) => [claim.modelId, { modelId: claim.modelId, slots: claim.slots }])).values()];
    this.publish();
  }

  /** Subscribes to the child's progress; the parent owns its children, so it is their only subscriber. */
  track(session: Pick<RepoAgentSession, 'attach'>, child: { childRunId: string; taskId: string; contextTokens: number }): void {
    this.children.set(child.childRunId, {
      ...child, startedAtUtc: new Date().toISOString(), waitingForModel: false, turn: 0, maxTurns: null, promptTokens: 0, tools: [],
    });
    this.detachers.set(child.childRunId, session.attach({
      wantsLiveText: false,
      writeProgress: (event) => this.apply(child.childRunId, event),
    }));
    this.publish();
  }

  untrack(childRunId: string): void {
    this.detachers.get(childRunId)?.();
    this.detachers.delete(childRunId);
    if (this.children.delete(childRunId)) this.publish();
  }

  snapshot(): OrchestratorActivity {
    return { runId: this.runId, claims: this.claims, models: this.models, children: [...this.children.values()] };
  }

  private apply(childRunId: string, event: OperationProgressEvent): void {
    const current = this.children.get(childRunId);
    if (current === undefined) return;
    const next = reduceChildActivity(current, event);
    if (next === current) return;
    this.children.set(childRunId, next);
    this.publish();
  }

  private publish(): void {
    this.registry.publishActivity(this.snapshot());
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node .\src\test-runner\run-tests.ts tests/orchestrator-live-activity.test.ts`, then `node .\src\test-runner\run-tests.ts tests/orchestrator-scheduler.test.ts`
Expected: both PASS.

---

### Task 5: Run publishes activity and the events stream forwards it

**Files:**
- Modify: `src/orchestrator/run.ts` (imports, constructor, `preparePlan` after `savePlan`, `superviseChild`)
- Modify: `src/status-server/routes/orchestrator.ts` (`OrchestratorEventsEndpoint`)
- Test: `tests/process/orchestrator-run.e2e.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

In `tests/process/orchestrator-run.e2e.test.ts`, add `ORCHESTRATOR_ACTIVITY_FRAME` and `OrchestratorActivitySchema` to the `@siftkit/contracts` import. Change `import { parseJsonValueText } from '../../src/lib/json.ts';` to `import { parseJsonText, parseJsonValueText } from '../../src/lib/json.ts';`. Append after the parallel-slots test:

```ts
test('the events stream carries live child activity: claims, the child\'s turns and tool calls, and nothing once it settles', async (t) => {
  const context = await startHarness(t, 'siftkit-orchestrator-activity-');
  const { engine } = context;
  engine.parent.push(planAnswer(writePlan()));
  engine.children.push([writeFile('export const greeting = "hi";\n'), ...finalAnswer('Created.')]);
  engine.parent.push(driftReview('clean'));

  const started = await startRun(context, 'off');
  const response = await requestSse(`${context.baseUrl}/orchestrator/events`, {
    body: { runId: started.runId, afterSequence: 0 }, timeoutMs: RUN_TIMEOUT_MS,
  });
  const state = OrchestratorRunStateSchema.parse(response.result);
  const activities = response.frames
    .filter((frame) => frame.event === ORCHESTRATOR_ACTIVITY_FRAME)
    .map((frame) => parseJsonText(frame.data, OrchestratorActivitySchema));

  assert.equal(state.phase, 'completed', JSON.stringify(state.failure));
  const planned = activities.find((activity) => activity.claims.length > 0);
  assert.deepEqual(planned?.claims, [{ taskId: 'greeting', modelId: ALTERNATE_MODEL_PRESET_ID, mutating: true }]);
  assert.deepEqual(planned?.models, [{ modelId: ALTERNATE_MODEL_PRESET_ID, slots: 1 }]);
  const childViews = activities.flatMap((activity) => activity.children);
  assert.ok(childViews.length > 0, 'the running child was published');
  assert.ok(childViews.every((child) => child.childRunId === state.attempts[0]?.childRunId && child.taskId === 'greeting'));
  assert.ok(childViews.some((child) => child.turn >= 1 && child.maxTurns !== null), 'turns are reported');
  const tools = childViews.flatMap((child) => child.tools);
  const written = tools.find((tool) => tool.status === 'running');
  assert.ok(written, 'a tool call was seen while running');
  assert.ok(tools.some((tool) => tool.toolCallId === written.toolCallId && tool.status === 'succeeded'), 'and then settled');
  assert.deepEqual(activities.at(-1)?.children, [], 'a settled child leaves the view');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node .\src\test-runner\run-tests.ts tests/process/orchestrator-run.e2e.test.ts --test-name-pattern "live child activity"`
Expected: FAIL. `planned` is undefined because no `activity` frames are written.

- [ ] **Step 3: Wire the live view into the run**

In `src/orchestrator/run.ts`:

1. Add `type OrchestratorActivity` to the `@siftkit/contracts` import block.
2. Change `import { renderOrchestratorPlan, validateOrchestratorPlan } from './plan.ts';` to `import { renderOrchestratorPlan, requireOrchestratorWorkerPreset, validateOrchestratorPlan } from './plan.ts';`.
3. Add `import { OrchestratorLiveActivity } from './live-activity.ts';` next to the other `./` imports.
4. Add the field after `private readonly children = new Map<string, RepoAgentSession>();`:
```ts
  private readonly activity: OrchestratorLiveActivity;
```
5. In the constructor, after `this.phases = new OrchestratorPhaseRunner(ctx, config);`, add:
```ts
    this.activity = new OrchestratorLiveActivity(state.runId, ctx.orchestratorRuns);
```
6. After the `decide(...)` method add:
```ts
  activitySnapshot(): OrchestratorActivity {
    return this.activity.snapshot();
  }
```
7. In `preparePlan`, directly after the `savePlan` publish line and before `this.commit({ phase: 'executing' }, ...)`, add:
```ts
      this.activity.setPlan(this.config, plan);
```
8. Replace the start of `superviseChild` through `this.children.set(...)`, and its `finally`, so the method reads:
```ts
  private async superviseChild(task: OrchestratorTask, attempt: OrchestratorAttempt, instruction: string): Promise<ChildOutcome> {
    this.signal.throwIfAborted();
    const workerPresetId = attempt.work.kind === 'drift_fix' ? 'repo-agent' : task.workerPresetId;
    const session = startOrchestratorChild(this.ctx, this.config, {
      runId: this.runId, taskId: task.id, attempt: attempt.attempt, childRunId: attempt.childRunId,
      workerPresetId, repoRoot: this.request.repoRoot, work: attempt.work, instruction, approval: this.request.approval,
    });
    this.children.set(attempt.childRunId, session);
    const worker = requireOrchestratorWorkerPreset(this.config, { id: task.id, workerPresetId });
    this.activity.track(session, { childRunId: attempt.childRunId, taskId: task.id,
      contextTokens: workerModelPreset(this.config, worker).NumCtx });
    this.publish(this.ctx.orchestratorRunStore.markAttemptRunning(this.runId, this.state.revision, attempt.childRunId));
    try {
      // (unchanged loop body)
    } catch (error) {
      // (unchanged)
    } finally {
      this.children.delete(attempt.childRunId);
      this.activity.untrack(attempt.childRunId);
    }
  }
```
Leave the `try` and `catch` bodies exactly as they are. Only the lines shown change.

- [ ] **Step 4: Forward activity on the events stream**

In `src/status-server/routes/orchestrator.ts`:

1. Add `ORCHESTRATOR_ACTIVITY_FRAME` to the `@siftkit/contracts` import.
2. In `OrchestratorEventsEndpoint.handle`, replace everything from `let detach: () => void = () => {};` to the end of the method with:
```ts
    let detachState: () => void = () => {};
    let detachActivity: () => void = () => {};
    const detach = (): void => {
      detachState();
      detachActivity();
    };
    const flush = (state: OrchestratorRunState): void => {
      if (finished) return;
      const events = ctx.orchestratorRunStore.readEvents(runId, cursor);
      const last = events.at(-1);
      if (last !== undefined) {
        const progress: OrchestratorProgress = { events, state };
        writer.writeEvent(OPERATION_STREAM_EVENTS.progress, progress);
        cursor = last.sequence;
      }
      // A nonterminal parent with no live owner can never change again; report it as it stands.
      if (isOrchestratorTerminalPhase(state.phase) || ctx.orchestratorRuns.get(runId) === undefined) {
        finished = true;
        detach();
        writer.writeEvent(OPERATION_STREAM_EVENTS.result, state);
        writer.end();
      }
    };
    const writeActivity = (activity: OrchestratorActivity): void => {
      if (!finished) writer.writeEvent(ORCHESTRATOR_ACTIVITY_FRAME, activity);
    };
    detachState = ctx.orchestratorRuns.subscribe(runId, flush);
    detachActivity = ctx.orchestratorRuns.subscribeActivity(runId, writeActivity);
    res.on('close', detach);
    flush(ctx.orchestratorRunStore.read(runId));
    // Activity is never stored, so a client that connects mid-run starts from the live snapshot.
    const live = ctx.orchestratorRuns.get(runId);
    if (live !== undefined) writeActivity(live.activitySnapshot());
```
3. Add `type OrchestratorActivity` to the `@siftkit/contracts` import.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node .\src\test-runner\run-tests.ts tests/process/orchestrator-run.e2e.test.ts`
Expected: the whole file PASSes, including the new test.
Run: `npm run typecheck:test`
Expected: PASS.

---

### Task 6: Dashboard stream items and hook state

**Files:**
- Modify: `dashboard/src/orchestrator-api.ts`
- Modify: `dashboard/src/hooks/useOrchestratorRun.ts`
- Test: `dashboard/tests/use-orchestrator-run.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `dashboard/tests/use-orchestrator-run.test.tsx`, add `type OrchestratorActivity` to the contracts import and append:

```ts
const ACTIVITY: OrchestratorActivity = { runId: RUN_ID, claims: [], models: [], children: [] };

test('activity frames update the live view, and an approval pause keeps the last work phase', async () => {
  const paused = { ...EVENT, sequence: 2, phase: 'approval_required', message: 'Waiting for your approval decision.' };
  const progress = { events: [EVENT, paused], state: runState({ revision: 2, phase: 'approval_required', approval: APPROVAL }) };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`));
      controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(ACTIVITY)}\n\n`));
    },
  });
  const fetches = mockFetch({ '/orchestrator/runs': json({ runs: [runState({})] }), '/orchestrator/events': () => new Response(body) });
  try {
    const { result, unmount } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.deepEqual(result.current.activity, ACTIVITY));
    assert.equal(result.current.workPhase, 'executing');
    assert.equal(result.current.state?.phase, 'approval_required');
    unmount();
  } finally { fetches.restore(); }
});

test('the closing result clears the live view', async () => {
  const completed = runState({ phase: 'completed', revision: 5 });
  const fetches = mockFetch({
    '/orchestrator/runs': json({ runs: [runState({})] }),
    '/orchestrator/events': () => new Response(`event: activity\ndata: ${JSON.stringify(ACTIVITY)}\n\nevent: result\ndata: ${JSON.stringify(completed)}\n\n`),
  });
  try {
    const { result } = renderHook(() => useOrchestratorRun('C:/repo'));
    await waitFor(() => assert.equal(result.current.state?.phase, 'completed'));
    assert.equal(result.current.activity, null);
  } finally { fetches.restore(); }
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/use-orchestrator-run.test.tsx`
Expected: FAIL. The hook throws `Unexpected orchestrator stream frame: activity`, and `result.current.activity` is undefined.

- [ ] **Step 3: Yield typed stream items**

In `dashboard/src/orchestrator-api.ts`:

1. Add `ORCHESTRATOR_ACTIVITY_FRAME`, `OrchestratorActivitySchema` and `type OrchestratorActivity` to the contracts import.
2. Add, above `followOrchestrator`:
```ts
/** One item of a followed run: committed progress, or the live (unstored) activity view. */
export type OrchestratorStreamItem =
  | { kind: 'progress'; progress: OrchestratorProgress }
  | { kind: 'activity'; activity: OrchestratorActivity };
```
3. Change the generator's return type to `AsyncGenerator<OrchestratorStreamItem, OrchestratorRunState>` and its frame loop body to:
```ts
    for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
      // The events route writes progress, activity, and a closing result; anything else is a protocol break.
      if (frame.event === 'progress') {
        yield { kind: 'progress', progress: parseJsonText(frame.data, OrchestratorProgressSchema) };
        continue;
      }
      if (frame.event === ORCHESTRATOR_ACTIVITY_FRAME) {
        yield { kind: 'activity', activity: parseJsonText(frame.data, OrchestratorActivitySchema) };
        continue;
      }
      if (frame.event !== 'result') throw new Error(`Unexpected orchestrator stream frame: ${frame.event}`);
      await reader.cancel();
      return parseJsonText(frame.data, OrchestratorRunStateSchema);
    }
```
4. Update the doc comment to: `/** Replays committed progress after the cursor, then follows live progress and activity; returns the state that ended the stream. */`

- [ ] **Step 4: Track activity and work phase in the hook**

Replace `dashboard/src/hooks/useOrchestratorRun.ts` with:

```ts
import React from 'react';

import {
  isOrchestratorTerminalPhase,
  type ApprovalMode,
  type OrchestratorActivity,
  type OrchestratorPhase,
  type OrchestratorRunState,
  type RepoAgentDecision,
} from '@siftkit/contracts';
import { toError } from '../../../src/lib/errors.ts';
import {
  abortOrchestrator,
  decideOrchestrator,
  followOrchestrator,
  listOrchestratorRuns,
  startOrchestrator,
} from '../orchestrator-api.ts';

export type OrchestratorStartInput = { presetId: string; approval: ApprovalMode; task: string | null; planPath: string | null };

/** Shows the repository's latest parent run, follows it and its live activity, and forwards the user's controls. */
export function useOrchestratorRun(repoRoot: string | null) {
  const [state, setState] = React.useState<OrchestratorRunState | null>(null);
  const [activity, setActivity] = React.useState<OrchestratorActivity | null>(null);
  // The last phase that was real work, so an approval pause or a stop still shows where the run was.
  const [workPhase, setWorkPhase] = React.useState<OrchestratorPhase | null>(null);
  const [lastMessage, setLastMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const follow = React.useRef<AbortController | null>(null);

  const attach = React.useCallback((initial: OrchestratorRunState) => {
    follow.current?.abort();
    const controller = new AbortController();
    follow.current = controller;
    setState(initial);
    setActivity(null);
    setWorkPhase(null);
    setError(null);
    if (isOrchestratorTerminalPhase(initial.phase)) return;
    void (async () => {
      try {
        const stream = followOrchestrator(initial.runId, 0, controller.signal);
        for (;;) {
          const next = await stream.next();
          if (controller.signal.aborted) return;
          if (next.done) {
            setActivity(null);
            setState(next.value);
            return;
          }
          const item = next.value;
          if (item.kind === 'activity') {
            setActivity(item.activity);
            continue;
          }
          // Each frame carries the state its events produced; no status refetch is needed.
          const { events, state: committed } = item.progress;
          setLastMessage(events.at(-1)?.message ?? null);
          const worked = events.filter((event) => event.phase !== 'approval_required' && !isOrchestratorTerminalPhase(event.phase)).at(-1);
          if (worked !== undefined) setWorkPhase(worked.phase);
          setState(committed);
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(toError(caught).message);
      }
    })();
  }, []);

  React.useEffect(() => {
    setState(null);
    setActivity(null);
    setWorkPhase(null);
    setLastMessage(null);
    setError(null);
    if (repoRoot === null) return undefined;
    let cancelled = false;
    listOrchestratorRuns(repoRoot).then((runs) => {
      const latest = runs[0];
      if (!cancelled && latest !== undefined) attach(latest);
    }, (caught) => { if (!cancelled) setError(toError(caught).message); });
    return () => {
      cancelled = true;
      follow.current?.abort();
    };
  }, [repoRoot, attach]);

  return {
    state,
    activity,
    workPhase,
    lastMessage,
    error,
    start(input: OrchestratorStartInput): Promise<void> {
      if (repoRoot === null) throw new Error('An orchestrator run needs a repository folder.');
      setLastMessage(null);
      return startOrchestrator({ submissionId: crypto.randomUUID(), repoRoot, ...input })
        .then(attach, (caught) => setError(toError(caught).message));
    },
    decide(decision: RepoAgentDecision): Promise<void> {
      const pending = state?.approval;
      if (!state || !pending) throw new Error('No orchestrator approval is pending.');
      return decideOrchestrator({ runId: state.runId, approvalId: pending.approvalId, ...decision })
        .then(setState, (caught) => setError(toError(caught).message));
    },
    abort(): Promise<void> {
      if (!state) throw new Error('No orchestrator run to stop.');
      return abortOrchestrator(state.runId).then(setState, (caught) => setError(toError(caught).message));
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/use-orchestrator-run.test.tsx`
Expected: all tests in the file PASS, old and new.

---

### Task 7: Pure board view model

**Files:**
- Create: `dashboard/src/orchestrator-view.ts`
- Test: `dashboard/tests/orchestrator-view.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/orchestrator-view.test.ts`:

```ts
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  OrchestratorAttemptSchema,
  OrchestratorRunStateSchema,
  type OrchestratorActivity,
  type OrchestratorChildActivity,
  type OrchestratorRunState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';
import {
  attemptSummary,
  contextPercent,
  formatElapsed,
  nowDoing,
  orchestratorSteps,
  runElapsedMs,
  slotUsage,
  statusTone,
  waitReason,
} from '../src/orchestrator-view.ts';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const CHILD_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-10-11T12:00:00.000Z';
const CHECK = { kind: 'command', command: 'npm test', cwd: '.', expectedExitCode: 0 } as const;

function planTask(id: string, workerPresetId: string, dependsOn: string[] = []) {
  return { id, title: id, dependsOn, workerPresetId, readPaths: [], writePaths: [], temporaryPaths: [],
    steps: [{ instruction: 'Do it.', expectedResult: 'Done.' }], verification: [CHECK], acceptance: ['Done.'] };
}

function runState(statuses: Record<string, OrchestratorTaskStatus>, overrides: Partial<OrchestratorRunState> = {}): OrchestratorRunState {
  const tasks = [planTask('read', 'repo-search'), planTask('write', 'repo-agent'), planTask('write-2', 'repo-agent'),
    planTask('after', 'repo-search', ['write'])];
  return OrchestratorRunStateSchema.parse({
    runId: RUN_ID,
    request: { submissionId: RUN_ID, repoRoot: 'C:/repo', presetId: 'orchestrator', approval: 'auto', task: 'Go', planPath: null },
    revision: 1, phase: 'executing', planPath: 'plan.md', planHash: 'h',
    plan: { goal: 'Go', constraints: [], tasks, finalVerification: [CHECK] },
    tasks: tasks.map((task) => ({ taskId: task.id, status: statuses[task.id] ?? 'pending', driftReview: null, reviewedDigests: [] })),
    attempts: [], phaseRunIds: [], approval: null, failure: null, createdAtUtc: AT, updatedAtUtc: '2026-10-11T12:14:02.000Z',
    ...overrides,
  });
}

function activity(slots: number): OrchestratorActivity {
  return {
    runId: RUN_ID, children: [],
    claims: [{ taskId: 'read', modelId: 'm', mutating: false }, { taskId: 'write', modelId: 'm', mutating: true },
      { taskId: 'write-2', modelId: 'm', mutating: true }, { taskId: 'after', modelId: 'm', mutating: false }],
    models: [{ modelId: 'm', slots }],
  };
}

const CHILD: OrchestratorChildActivity = {
  childRunId: CHILD_ID, taskId: 'write', startedAtUtc: AT, waitingForModel: false, turn: 3, maxTurns: 40,
  promptTokens: 1000, contextTokens: 4000, tools: [],
};

function taskOf(state: OrchestratorRunState, id: string) {
  const task = state.tasks.find((candidate) => candidate.taskId === id);
  if (task === undefined) throw new Error(`No task ${id}`);
  return task;
}

test('the stepper marks done, current, and failed steps, using the last work phase while paused or stopped', () => {
  const statuses = (phase: Parameters<typeof orchestratorSteps>[0], work: Parameters<typeof orchestratorSteps>[1]) =>
    orchestratorSteps(phase, work).map((step) => step.status);
  assert.deepEqual(orchestratorSteps('executing', null).map((step) => step.label), ['Plan', 'Validate', 'Execute', 'Verify', 'Clean']);
  assert.deepEqual(statuses('executing', null), ['done', 'done', 'now', 'todo', 'todo']);
  assert.deepEqual(statuses('approval_required', 'verifying'), ['done', 'done', 'done', 'now', 'todo']);
  assert.deepEqual(statuses('failed', 'executing'), ['done', 'done', 'failed', 'todo', 'todo']);
  assert.deepEqual(statuses('completed', null), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(statuses('failed', null), ['todo', 'todo', 'todo', 'todo', 'todo']);
});

test('slot usage counts tasks holding a claim, and is unknown until the plan is claimed', () => {
  const state = runState({ write: 'verifying' });
  assert.equal(slotUsage(state, null), null);
  assert.equal(slotUsage(state, { ...activity(2), claims: [], models: [] }), null);
  assert.deepEqual(slotUsage(state, activity(2)), { writerUsed: true, models: [{ modelId: 'm', slots: 2, used: 1 }] });
});

test('a pending task says why it waits', () => {
  const state = runState({ write: 'running' });
  assert.equal(waitReason(taskOf(state, 'after'), state, activity(2)), 'needs write');
  assert.equal(waitReason(taskOf(state, 'write-2'), state, activity(2)), 'waiting for writer slot');
  assert.equal(waitReason(taskOf(state, 'read'), state, activity(1)), 'waiting for m slot');
  assert.equal(waitReason(taskOf(state, 'read'), state, activity(2)), 'starting');
  assert.equal(waitReason(taskOf(state, 'read'), state, null), 'queued');
  assert.equal(waitReason(taskOf(state, 'write'), state, activity(2)), null);
  const stopped = runState({}, { phase: 'failed' });
  assert.equal(waitReason(taskOf(stopped, 'read'), stopped, activity(2)), 'not started');
});

test('attempt summary counts each purpose against the attempt limit', () => {
  const attempt = (purpose: 'implementation' | 'drift_fix', number: 1 | 2) => OrchestratorAttemptSchema.parse({
    taskId: 'write', purpose, attempt: number, childRunId: CHILD_ID, reservedAtUtc: AT, status: 'running', result: null,
    work: { kind: 'implementation', planPath: 'plan.md', planHash: 'h', task: planTask('write', 'repo-agent') },
  });
  assert.equal(attemptSummary('write', []), '—');
  assert.equal(attemptSummary('write', [attempt('implementation', 1), attempt('implementation', 2), attempt('drift_fix', 1)]),
    'impl 2/2 · fix 1/2');
  assert.equal(attemptSummary('read', [attempt('implementation', 1)]), '—');
});

test('now doing prefers the running tool, then the model wait, then the turn, then the task status', () => {
  const running = runState({ write: 'running' });
  const verifying = runState({ write: 'verifying' });
  const tool = { toolCallId: 't1', turn: 3, activityKind: 'command', command: 'npm test', status: 'running' } as const;
  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, tools: [tool] }), 'command npm test');
  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, waitingForModel: true }), 'waiting for model');
  assert.equal(nowDoing(taskOf(running, 'write'), CHILD), 'thinking · turn 3');
  assert.equal(nowDoing(taskOf(running, 'write'), { ...CHILD, turn: 0 }), 'starting');
  assert.equal(nowDoing(taskOf(verifying, 'write'), null), 'verifying checks');
  assert.equal(nowDoing(taskOf(running, 'read'), null), null);
});

test('labels: context percent, elapsed time, run elapsed, and status tone', () => {
  assert.equal(contextPercent(CHILD), 25);
  assert.equal(formatElapsed(47_000), '47s');
  assert.equal(formatElapsed(842_000), '14m 02s');
  assert.equal(formatElapsed(3_780_000), '1h 03m');
  assert.equal(runElapsedMs(runState({}, { phase: 'completed' }), Date.parse(AT) + 1), 842_000);
  assert.equal(runElapsedMs(runState({}), Date.parse(AT) + 5_000), 5_000);
  assert.deepEqual((['completed', 'failed', 'pending', 'running', 'interrupted'] as const).map((status) => statusTone(status)),
    ['ok', 'bad', 'idle', 'run', 'bad']);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/orchestrator-view.test.ts`
Expected: FAIL. `../src/orchestrator-view.ts` cannot be resolved.

- [ ] **Step 3: Implement the view model**

Create `dashboard/src/orchestrator-view.ts`:

```ts
import {
  ORCHESTRATOR_MAX_ATTEMPTS,
  ORCHESTRATOR_OPEN_TASK_STATUSES,
  OrchestratorChildPurposeSchema,
  isOrchestratorTerminalPhase,
  type OrchestratorActivity,
  type OrchestratorAttempt,
  type OrchestratorChildActivity,
  type OrchestratorChildPurpose,
  type OrchestratorPhase,
  type OrchestratorRunState,
  type OrchestratorTaskState,
  type OrchestratorTaskStatus,
} from '@siftkit/contracts';

export type OrchestratorStepStatus = 'done' | 'now' | 'failed' | 'todo';
export type OrchestratorStep = { label: string; status: OrchestratorStepStatus };
export type SlotUsage = { writerUsed: boolean; models: { modelId: string; slots: number; used: number }[] };
export type StatusTone = 'ok' | 'bad' | 'run' | 'idle';

/** The run's work phases in order; approval pauses and terminal phases are not steps. */
const STEPS = [
  { label: 'Plan', phase: 'preparing_plan' },
  { label: 'Validate', phase: 'validating_plan' },
  { label: 'Execute', phase: 'executing' },
  { label: 'Verify', phase: 'verifying' },
  { label: 'Clean', phase: 'cleaning' },
] as const satisfies readonly { label: string; phase: OrchestratorPhase }[];

const PURPOSE_LABELS = { implementation: 'impl', drift_fix: 'fix' } as const satisfies Record<OrchestratorChildPurpose, string>;
const STATUS_ACTIVITY: Partial<Record<OrchestratorTaskStatus, string>> = {
  verifying: 'verifying checks', reviewing_drift: 'reviewing drift', retry_pending: 'retry pending',
};

/** Steps for `phase`; while paused or stopped, `workPhase` (the last work phase seen) marks where the run is. */
export function orchestratorSteps(phase: OrchestratorPhase, workPhase: OrchestratorPhase | null): OrchestratorStep[] {
  if (phase === 'completed') return STEPS.map(({ label }): OrchestratorStep => ({ label, status: 'done' }));
  const current = STEPS.findIndex((step) => step.phase === phase);
  const index = current >= 0 ? current : STEPS.findIndex((step) => step.phase === workPhase);
  const stopped = isOrchestratorTerminalPhase(phase);
  return STEPS.map(({ label }, position): OrchestratorStep => ({
    label,
    status: index < 0 || position > index ? 'todo' : position < index ? 'done' : stopped ? 'failed' : 'now',
  }));
}

/** Which scheduler slots are held; null until the saved plan's claims are known. */
export function slotUsage(state: OrchestratorRunState, activity: OrchestratorActivity | null): SlotUsage | null {
  if (activity === null || activity.claims.length === 0) return null;
  const open = new Set(state.tasks.filter((task) => ORCHESTRATOR_OPEN_TASK_STATUSES.includes(task.status)).map((task) => task.taskId));
  const held = activity.claims.filter((claim) => open.has(claim.taskId));
  return {
    writerUsed: held.some((claim) => claim.mutating),
    models: activity.models.map((model) => ({ ...model, used: held.filter((claim) => claim.modelId === model.modelId).length })),
  };
}

/** Why a pending task has not started, in scheduler order: dependencies, writer slot, model slot. */
export function waitReason(task: OrchestratorTaskState, state: OrchestratorRunState, activity: OrchestratorActivity | null): string | null {
  if (task.status !== 'pending') return null;
  if (isOrchestratorTerminalPhase(state.phase)) return 'not started';
  const status = new Map(state.tasks.map((other) => [other.taskId, other.status]));
  const unmet = (state.plan?.tasks.find((planned) => planned.id === task.taskId)?.dependsOn ?? [])
    .filter((dependency) => status.get(dependency) !== 'completed');
  if (unmet.length > 0) return `needs ${unmet.join(', ')}`;
  const claim = activity?.claims.find((candidate) => candidate.taskId === task.taskId);
  const usage = slotUsage(state, activity);
  if (claim === undefined || usage === null) return 'queued';
  if (claim.mutating && usage.writerUsed) return 'waiting for writer slot';
  const model = usage.models.find((candidate) => candidate.modelId === claim.modelId);
  if (model !== undefined && model.used >= model.slots) return `waiting for ${claim.modelId} slot`;
  return 'starting';
}

/** e.g. "impl 2/2 · fix 1/2"; attempt numbers are sequential, so the count is the latest number. */
export function attemptSummary(taskId: string, attempts: readonly OrchestratorAttempt[]): string {
  const parts = OrchestratorChildPurposeSchema.options.flatMap((purpose) => {
    const count = attempts.filter((attempt) => attempt.taskId === taskId && attempt.purpose === purpose).length;
    return count === 0 ? [] : [`${PURPOSE_LABELS[purpose]} ${count}/${ORCHESTRATOR_MAX_ATTEMPTS}`];
  });
  return parts.length === 0 ? '—' : parts.join(' · ');
}

export function nowDoing(task: OrchestratorTaskState, child: OrchestratorChildActivity | null): string | null {
  if (child === null) return STATUS_ACTIVITY[task.status] ?? null;
  if (child.waitingForModel) return 'waiting for model';
  const running = child.tools.filter((tool) => tool.status === 'running').at(-1);
  if (running !== undefined) return `${running.activityKind} ${running.command}`;
  return child.turn === 0 ? 'starting' : `thinking · turn ${child.turn}`;
}

export function contextPercent(child: OrchestratorChildActivity): number {
  return Math.round((child.promptTokens / child.contextTokens) * 100);
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** A finished run's duration is fixed at its last update; a live one runs to `now`. */
export function runElapsedMs(state: OrchestratorRunState, now: number): number {
  const end = isOrchestratorTerminalPhase(state.phase) ? Date.parse(state.updatedAtUtc) : now;
  return end - Date.parse(state.createdAtUtc);
}

export function statusTone(status: OrchestratorTaskStatus | OrchestratorPhase): StatusTone {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'aborted' || status === 'interrupted') return 'bad';
  return status === 'pending' ? 'idle' : 'run';
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/orchestrator-view.test.ts`, then `npm run typecheck:dashboard-test`
Expected: PASS.

---

### Task 8: Ticking clock hook

**Files:**
- Create: `dashboard/src/hooks/useNow.ts`
- Test: `dashboard/tests/use-now.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/tests/use-now.test.tsx`:

```ts
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from './react-test-environment.ts';
import { useNow } from '../src/hooks/useNow.ts';

afterEach(() => { vi.useRealTimers(); });

test('the clock ticks while live and stands still otherwise', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const { result, rerender } = renderHook(({ live }) => useNow(1000, live), { initialProps: { live: true } });
  assert.equal(result.current, 1_000);
  act(() => { vi.advanceTimersByTime(3_000); });
  assert.equal(result.current, 4_000);
  rerender({ live: false });
  act(() => { vi.advanceTimersByTime(5_000); });
  assert.equal(result.current, 4_000);
});
```

If another dashboard test already imports `act` differently (for example from `@testing-library/react`), use that source instead. Check with `rg "import \{ act" dashboard/tests`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/use-now.test.tsx`
Expected: FAIL. `../src/hooks/useNow.ts` cannot be resolved.

- [ ] **Step 3: Implement the hook**

Create `dashboard/src/hooks/useNow.ts`:

```ts
import React from 'react';

/** The current time, re-read every `intervalMs` while `live`; idle panels never re-render. */
export function useNow(intervalMs: number, live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, live]);
  return now;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/use-now.test.tsx`
Expected: PASS.

---

### Task 9: Board components, styles, and Chat wiring

**Files:**
- Create: `dashboard/src/components/OrchestratorTaskRow.tsx`
- Rewrite: `dashboard/src/components/OrchestratorRunPanel.tsx`
- Create: `dashboard/src/styles/orchestrator.css`
- Modify: `dashboard/src/styles.css:7`
- Modify: `dashboard/src/tabs/ChatTab.tsx:447-453`
- Test: `dashboard/tests/orchestrator-run-panel.test.tsx`

- [ ] **Step 1: Rewrite the panel tests for the board**

In `dashboard/tests/orchestrator-run-panel.test.tsx`:

1. Add `type OrchestratorActivity` and `type OrchestratorChildActivity` to the contracts import.
2. Replace `renderPanel` with:
```tsx
function renderPanel(state: OrchestratorRunState, activity: OrchestratorActivity | null = null, workPhase: OrchestratorRunState['phase'] | null = null) {
  const decisions: RepoAgentDecision[] = [];
  let aborts = 0;
  render(<OrchestratorRunPanel state={state} activity={activity} workPhase={workPhase} lastMessage="Working."
    onDecide={(decision) => decisions.push(decision)} onAbort={() => { aborts += 1; }} />);
  return { decisions, aborts: () => aborts };
}

const LIVE_CHILD: OrchestratorChildActivity = {
  childRunId: CHILD_ID, taskId: TASK.id, startedAtUtc: AT, waitingForModel: false, turn: 9, maxTurns: 40,
  promptTokens: 1240, contextTokens: 4000,
  tools: [
    { toolCallId: 't1', turn: 8, activityKind: 'edit', command: 'write src/a.ts', status: 'succeeded' },
    { toolCallId: 't2', turn: 9, activityKind: 'command', command: 'npm test', status: 'running' },
  ],
};

function liveActivity(children: OrchestratorChildActivity[], slots = 2): OrchestratorActivity {
  return { runId: RUN_ID, claims: [{ taskId: TASK.id, modelId: 'exl3-main', mutating: true }],
    models: [{ modelId: 'exl3-main', slots }], children };
}
```
3. In the first test, replace `screen.getByText('Implementation attempt 2 of 2');` with `screen.getByText('impl 2/2');`. Rename it to `'a running task shows its phase, plan path, and attempts, and Stop aborts'`.
4. In the failed-attempt test, replace `screen.getByText('Implementation attempt 1 of 2');` with `screen.getByText('impl 1/2');`.
5. In the drift test, replace `screen.getByText('Drift correction 1 of 2');` with `screen.getByText('impl 1/2 · fix 1/2');`.
6. In the terminal test, add `updatedAtUtc: '2026-09-23T12:14:02.000Z'` to the overrides and add the assertion `screen.getByText('14m 02s');`.
7. Append the new tests:
```tsx
test('a running task opens its agent card with turn, context, recent tool calls, write scope, and a transcript link', () => {
  renderPanel(runState({ attempts: [attempt('implementation', 1, null)] }), liveActivity([LIVE_CHILD]));
  screen.getByLabelText(`Agent ${CHILD_ID}`);
  screen.getByText('command npm test');
  screen.getByText('write src/a.ts');
  screen.getByText('31%');
  screen.getByText('src/a.ts', { selector: 'code' });
  const transcript = screen.getByRole('link', { name: 'Transcript' });
  assert.ok(transcript instanceof window.HTMLAnchorElement);
  assert.equal(transcript.getAttribute('href'), `?tab=runs&run=${CHILD_ID}`);
  screen.getByText(`${TASK.id} · repo-agent · writer`);
});

test('the slot meter shows held scheduler slots, and a pending task says why it waits', () => {
  const second = { ...TASK, id: 'second', title: 'Second write' };
  const state = runState({
    plan: { goal: 'Greet', constraints: [], tasks: [TASK, second], finalVerification: [CHECK] },
    tasks: [{ taskId: TASK.id, status: 'running', driftReview: null, reviewedDigests: [] },
      { taskId: 'second', status: 'pending', driftReview: null, reviewedDigests: [] }],
  });
  const activity = { ...liveActivity([LIVE_CHILD]), claims: [...liveActivity([]).claims, { taskId: 'second', modelId: 'exl3-main', mutating: true }] };
  renderPanel(state, activity);
  screen.getByTitle('writer slot in use');
  screen.getByTitle('1 of 2 exl3-main slots in use');
  screen.getByText('waiting for writer slot');
});

test('the phase stepper marks where the run is, even while paused for approval', () => {
  renderPanel(runState({ phase: 'approval_required' }), null, 'executing');
  const steps = screen.getAllByRole('listitem', { name: /step$/u });
  assert.deepEqual(steps.map((step) => step.getAttribute('data-status')), ['done', 'done', 'now', 'todo', 'todo']);
});
```
The `31%` value is `Math.round(1240 / 4000 * 100)`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/orchestrator-run-panel.test.tsx`
Expected: FAIL. `impl 2/2` is not found and the `activity` prop is unknown.

- [ ] **Step 3: Create the task row**

Create `dashboard/src/components/OrchestratorTaskRow.tsx`:

```tsx
import React from 'react';

import {
  ORCHESTRATOR_OPEN_TASK_STATUSES,
  orchestratorCheckFailure,
  type OrchestratorActivity,
  type OrchestratorAttempt,
  type OrchestratorChildActivity,
  type OrchestratorDriftReview,
  type OrchestratorRunState,
  type OrchestratorTaskState,
} from '@siftkit/contracts';
import { attemptSummary, contextPercent, formatElapsed, nowDoing, statusTone, waitReason } from '../orchestrator-view.ts';

const VISIBLE_FINDINGS = 3;

function DriftSummary({ review }: { review: OrchestratorDriftReview }) {
  if (review.status !== 'actionable') return <p className="hint orch-drift">No actionable drift</p>;
  const hidden = review.findings.length - VISIBLE_FINDINGS;
  return (
    <ul className="orchestrator-findings">
      {review.findings.slice(0, VISIBLE_FINDINGS).map((finding) => <li key={finding.id}>{finding.title}</li>)}
      {hidden > 0 ? <li className="hint">+{hidden} more findings</li> : null}
    </ul>
  );
}

function AgentCard({ child, writePaths, now }: { child: OrchestratorChildActivity; writePaths: readonly string[]; now: number }) {
  const turnWidth = child.maxTurns === null ? 0 : Math.min(100, (child.turn / child.maxTurns) * 100);
  return (
    <div className="orch-agent" aria-label={`Agent ${child.childRunId}`}>
      <div className="orch-agent-head">
        <span>agent <b>{child.childRunId.slice(0, 8)}</b></span>
        <span>turn <b>{child.turn}</b>/{child.maxTurns ?? '?'}</span>
        <span>ctx <b>{contextPercent(child)}%</b></span>
        <span>{formatElapsed(now - Date.parse(child.startedAtUtc))}</span>
        <a className="mini-btn" href={`?tab=runs&run=${encodeURIComponent(child.childRunId)}`}>Transcript</a>
      </div>
      <div className="orch-turnbar"><i style={{ width: `${turnWidth}%` }} /></div>
      <div className="orch-agent-tools">
        {child.tools.length === 0 ? <div className="hint">{child.waitingForModel ? 'Waiting for the model…' : 'No tool calls yet.'}</div> : null}
        {child.tools.map((tool) => (
          <div key={tool.toolCallId} className={`tcall-summary orch-tool ${tool.status}`}>
            {tool.status === 'running' ? <span className="sp" /> : <span className={`dot ${tool.status === 'failed' ? 'bad' : 'ok'}`} />}
            <span className="orch-tool-kind">{tool.activityKind}</span>
            <span className="orch-tool-command">{tool.command}</span>
          </div>
        ))}
      </div>
      <div className="orch-agent-foot">
        {writePaths.length === 0 ? 'read-only' : <>writes <code>{writePaths.join(' · ')}</code></>}
      </div>
    </div>
  );
}

function AttemptResult({ attempt }: { attempt: OrchestratorAttempt }) {
  const { result } = attempt;
  if (result === null) return null;
  return (
    <div className="orch-checks">
      {result.checks.map((check, index) => {
        if (check.check.kind !== 'command') return null;
        const failure = orchestratorCheckFailure(check);
        return <div key={index} className={failure === null ? 'ok' : 'bad'}>{failure ?? `✓ ${check.check.command}`}</div>;
      })}
      {result.scopeViolations.map((path) => <div key={path} className="bad">Outside write scope: <code>{path}</code></div>)}
      {result.passed ? <div className="ok">Attempt {attempt.attempt} passed · {result.changedPaths.length} files changed</div> : null}
    </div>
  );
}

export function OrchestratorTaskRow({ task, state, activity, now }: {
  task: OrchestratorTaskState;
  state: OrchestratorRunState;
  activity: OrchestratorActivity | null;
  now: number;
}) {
  const planned = state.plan?.tasks.find((candidate) => candidate.id === task.taskId);
  const child = activity?.children.find((candidate) => candidate.taskId === task.taskId) ?? null;
  const claim = activity?.claims.find((candidate) => candidate.taskId === task.taskId);
  const latest = state.attempts.filter((attempt) => attempt.taskId === task.taskId).at(-1);
  const open = ORCHESTRATOR_OPEN_TASK_STATUSES.includes(task.status);
  const tone = statusTone(task.status);
  const role = claim === undefined ? null : claim.mutating ? 'writer' : 'read-only';
  return (
    <li className={open ? 'orch-task open' : 'orch-task'}>
      <details open={open}>
        <summary className="orch-task-summary">
          {open ? <span className="sp" /> : <span className={`dot ${tone}`} />}
          <span className="orch-task-name">
            {planned?.title ?? task.taskId}
            <small>{[task.taskId, planned?.workerPresetId, role].filter((part) => part !== undefined && part !== null).join(' · ')}</small>
          </span>
          <span className="orch-task-doing">{nowDoing(task, child) ?? waitReason(task, state, activity)}</span>
          <span className="orch-task-attempts">{attemptSummary(task.taskId, state.attempts)}</span>
          <span className={`bdg ${tone}`}>{task.status}</span>
        </summary>
        {child !== null ? <AgentCard child={child} writePaths={planned?.writePaths ?? []} now={now} /> : null}
        {child === null && latest !== undefined ? <AttemptResult attempt={latest} /> : null}
        {task.driftReview ? <DriftSummary review={task.driftReview} /> : null}
      </details>
    </li>
  );
}
```

- [ ] **Step 4: Rewrite the panel**

Replace `dashboard/src/components/OrchestratorRunPanel.tsx` with:

```tsx
import React from 'react';

import {
  isOrchestratorTerminalPhase,
  type OrchestratorActivity,
  type OrchestratorPendingApproval,
  type OrchestratorPhase,
  type OrchestratorRunState,
  type RepoAgentDecision,
} from '@siftkit/contracts';
import { useNow } from '../hooks/useNow.ts';
import { formatElapsed, orchestratorSteps, runElapsedMs, slotUsage, statusTone, type SlotUsage } from '../orchestrator-view.ts';
import { OrchestratorTaskRow } from './OrchestratorTaskRow.tsx';

function ApprovalRequest({ pending, onDecide }: { pending: OrchestratorPendingApproval; onDecide(decision: RepoAgentDecision): void }) {
  const [reason, setReason] = React.useState('');
  return (
    <section className="approval-card" aria-label="Orchestrator approval required">
      {pending.kind === 'child'
        ? <div className="approval-card-head">Subagent for {pending.taskId} requests <code>{pending.toolName}</code></div>
        : <div className="approval-card-head">Orchestrator check in {pending.cwd}{pending.taskId === null ? ' (final verification)' : ` for ${pending.taskId}`}</div>}
      <pre className="approval-command">{pending.command}</pre>
      {pending.kind === 'child' && pending.reviewPayload ? <p className="approval-payload">{pending.reviewPayload}</p> : null}
      <input aria-label="Deny reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason to deny…" />
      <div className="approval-actions">
        <button type="button" className="send" onClick={() => onDecide({ decision: 'approve' })}>Approve</button>
        <button type="button" className="approval-reject" disabled={!reason.trim()} onClick={() => onDecide({ decision: 'deny', reason: reason.trim() })}>Deny</button>
        <button type="button" className="mini-btn approval-abort" onClick={() => onDecide({ decision: 'abort' })}>Abort run</button>
      </div>
    </section>
  );
}

function SlotMeter({ usage }: { usage: SlotUsage }) {
  return (
    <div className="orch-slots" aria-label="Scheduler slots">
      <span className="orch-slot-group" title={usage.writerUsed ? 'writer slot in use' : 'writer slot free'}>
        writer <span className={usage.writerUsed ? 'orch-slot writer used' : 'orch-slot writer'} />
      </span>
      {usage.models.map((model) => (
        <span key={model.modelId} className="orch-slot-group" title={`${model.used} of ${model.slots} ${model.modelId} slots in use`}>
          {model.modelId}
          {Array.from({ length: model.slots }, (_, index) => (
            <span key={index} className={index < model.used ? 'orch-slot used' : 'orch-slot'} />
          ))}
        </span>
      ))}
    </div>
  );
}

export function OrchestratorRunPanel({ state, activity, workPhase, lastMessage, onDecide, onAbort }: {
  state: OrchestratorRunState;
  activity: OrchestratorActivity | null;
  workPhase: OrchestratorPhase | null;
  lastMessage: string | null;
  onDecide(decision: RepoAgentDecision): void;
  onAbort(): void;
}) {
  const live = !isOrchestratorTerminalPhase(state.phase);
  const now = useNow(1000, live);
  const usage = slotUsage(state, activity);
  const completed = state.tasks.filter((task) => task.status === 'completed').length;
  return (
    <section className="orchestrator-run" aria-label="Orchestrator run">
      <header className="orch-head">
        {live ? <span className="live-dot" /> : null}
        <span className="orch-title">Orchestrator</span>
        <span className={`bdg ${statusTone(state.phase)}`}>{state.phase}</span>
        {state.tasks.length > 0 ? <span className="hint">{completed} of {state.tasks.length} tasks complete</span> : null}
        {live ? <button type="button" className="send stop orch-stop" onClick={onAbort}>Stop</button> : null}
      </header>
      <div className="orch-meta">
        {state.planPath ? <span>plan <code>{state.planPath}</code></span> : null}
        <span>approval <b>{state.request.approval}</b></span>
        <span>elapsed <b>{formatElapsed(runElapsedMs(state, now))}</b></span>
      </div>
      {lastMessage ? <p className="hint orch-last">{lastMessage}</p> : null}
      <ol className="orch-phases" aria-label="Run phases">
        {orchestratorSteps(state.phase, workPhase).map((step) => (
          <li key={step.label} className={`orch-phase ${step.status}`} data-status={step.status} aria-label={`${step.label} step`}>
            <i />{step.label}
          </li>
        ))}
      </ol>
      {usage !== null ? <SlotMeter usage={usage} /> : null}
      <ol className="orch-tasks">
        {state.tasks.map((task) => <OrchestratorTaskRow key={task.taskId} task={task} state={state} activity={activity} now={now} />)}
      </ol>
      {state.approval ? <ApprovalRequest key={state.approval.approvalId} pending={state.approval} onDecide={onDecide} /> : null}
      {state.failure ? <div className="err-banner"><span>{state.failure.message}</span></div> : null}
    </section>
  );
}
```

- [ ] **Step 5: Add the styles**

Create `dashboard/src/styles/orchestrator.css`:

```css
/* ---- orchestrator agent board; state markers stay static, see chat.css ---- */
.orchestrator-run { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); max-width: 900px; overflow: hidden; }
.orch-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
.orch-title { font-weight: 600; }
.orch-stop { margin-left: auto; padding: 4px 11px; }
.orch-meta { display: flex; flex-wrap: wrap; gap: 14px; padding: 7px 12px; font-size: 0.68rem; color: var(--dim); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; border-bottom: 1px solid var(--line); background: var(--panel2); }
.orch-meta b { color: var(--ink); font-weight: 500; }
.orch-last { margin: 6px 12px 0; }
.orchestrator-run .bdg.ok { border-color: #2f5f47; color: var(--ok); }
.orchestrator-run .bdg.bad { border-color: #8d4b53; color: var(--bad); }
.orchestrator-run .bdg.run { border-color: #5a4a2a; color: var(--run); }
.orchestrator-run .dot.idle { background: #3a4c61; }

.orch-phases { display: flex; gap: 4px; list-style: none; margin: 0; padding: 10px 12px 8px; }
.orch-phase { flex: 1; font-size: 0.62rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.orch-phase i { display: block; height: 3px; border-radius: 999px; background: #1a2634; margin-bottom: 5px; }
.orch-phase.done i { background: var(--ch-teal); }
.orch-phase.now { color: var(--run); }
.orch-phase.now i { background: var(--run); }
.orch-phase.failed { color: var(--bad); }
.orch-phase.failed i { background: var(--ch-red); }

.orch-slots { display: flex; flex-wrap: wrap; gap: 16px; padding: 0 12px 10px; font-size: 0.68rem; color: var(--dim); align-items: center; }
.orch-slot-group { display: inline-flex; align-items: center; gap: 5px; }
.orch-slot { width: 18px; height: 8px; border-radius: 3px; border: 1px solid var(--line); }
.orch-slot.used { background: var(--run); border-color: var(--run); }
.orch-slot.writer.used { background: var(--ch-blue); border-color: var(--ch-blue); }

.orch-tasks { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.orch-task { border-bottom: 1px solid var(--line); }
.orch-task:last-child { border-bottom: none; }
.orch-task.open { background: #101b17; box-shadow: inset 2px 0 0 var(--acc); }
.orch-task-summary { list-style: none; display: grid; grid-template-columns: 14px minmax(0, 1fr) auto auto auto; gap: 10px; align-items: center; padding: 8px 12px; cursor: pointer; }
.orch-task-summary::-webkit-details-marker { display: none; }
.orch-task-summary:hover { background: #141e29; }
.orch-task-name small { display: block; color: var(--dim); font-size: 0.66rem; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
.orch-task-doing { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.68rem; color: var(--ink); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.orch-task-attempts { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.66rem; color: var(--dim); }

.orch-agent { margin: 0 12px 10px 36px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel2); }
.orch-agent-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 0.68rem; color: var(--dim); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; }
.orch-agent-head b { color: var(--ink); font-weight: 500; }
.orch-agent-head .mini-btn { margin-left: auto; }
.orch-turnbar { height: 3px; background: #1a2634; }
.orch-turnbar i { display: block; height: 100%; background: var(--acc); }
.orch-agent-tools { padding: 6px 5px; display: grid; gap: 2px; }
.orch-tool .orch-tool-kind { color: #9cd6ff; min-width: 54px; }
.orch-tool .orch-tool-command { color: #b9cbdd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.orch-tool.running { color: var(--ink); background: #0f1a15; border-radius: 5px; }
.orch-tool.failed .orch-tool-kind { color: var(--bad); }
.orch-agent-foot { padding: 6px 10px; border-top: 1px solid var(--line); font-size: 0.66rem; color: var(--dim); }

.orch-checks { margin: 0 12px 10px 36px; display: grid; gap: 3px; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.68rem; color: var(--dim); }
.orch-checks .ok { color: var(--ok); }
.orch-checks .bad { color: var(--bad); }
.orchestrator-findings { margin: 0 12px 10px 36px; padding-left: 16px; font-size: 0.72rem; }
.orch-drift { margin: 0 12px 10px 36px; }
.orchestrator-run .approval-card, .orchestrator-run .err-banner { margin: 10px 12px; }
```

In `dashboard/src/styles.css`, add after `@import "./styles/assistant.css";`:

```css
@import "./styles/orchestrator.css";
```

- [ ] **Step 6: Wire the Chat tab**

In `dashboard/src/tabs/ChatTab.tsx`, change the panel element (around line 448) to:

```tsx
                <OrchestratorRunPanel
                  state={orchestrator.state}
                  activity={orchestrator.activity}
                  workPhase={orchestrator.workPhase}
                  lastMessage={orchestrator.lastMessage}
                  onDecide={(decision) => { void orchestrator.decide(decision); }}
                  onAbort={() => { void orchestrator.abort(); }}
                />
```

- [ ] **Step 7: Run the dashboard tests and confirm they pass**

Run: `npx vitest run --config .\dashboard\vitest.config.ts dashboard/tests/orchestrator-run-panel.test.tsx dashboard/tests/chat-tab.test.tsx`
Expected: PASS.
Run: `npm run typecheck:dashboard-test`
Expected: PASS.

---

### Task 10: Full verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Server suite**

Run: `npm test`
Expected: PASS. Fix any failure at its root and do not weaken tests.

- [ ] **Step 2: Process suite**

Run: `npm run test:process`
Expected: PASS, including `tests/process/orchestrator-run.e2e.test.ts`.

- [ ] **Step 3: Dashboard suite**

Run: `npm run test:dashboard`
Expected: PASS.

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck`, then `npm run lint`
Expected: both PASS. `typecheck` also runs lint at its end.

- [ ] **Step 5: Manual check in the browser**

1. Start the status server and dashboard as usual and open the Chat tab in Orchestrator mode on a small repository.
2. Start a run with a two-task plan: one writer task and one independent `repo-search` reader. Set the model to two parallel slots.
3. Confirm the following:
   - The stepper moves Plan → Validate → Execute.
   - The slot meter shows the writer and model slots filling.
   - Running rows open automatically and update their turn, context and tool rows live.
   - Pending rows show a wait reason.
   - Finished rows fold to ✓/✗ check lines.
4. Click **Transcript** on a running agent. Confirm the Logs tab opens that child run. The child's request ID is its `childRunId`, as asserted in the existing e2e test `a child approval unloads the child model…`. If the Logs tab keys runs differently, change the link in `OrchestratorTaskRow.tsx` to the Logs key and add a panel-test assertion for it.
5. Reload the page mid-run. Confirm the board reattaches and the live agent card reappears from the snapshot.
6. Report what was verified manually and anything that was not.

---

## Self-review notes

- **Mockup coverage:**
  - Header (live dot, phase badge, task count, Stop): Task 9.
  - Meta (plan, approval, elapsed): Tasks 7 and 9.
  - Phase stepper: Tasks 6, 7 and 9.
  - Slot meter: Tasks 4, 5, 7 and 9.
  - Running row agent card (id, turn/max, ctx %, elapsed, recent tools, write scope, Transcript): Tasks 2, 4, 5 and 9.
  - Finished-row checks: Task 9.
  - Wait reasons: Task 7.
  - The mockup's "Drift" step is dropped because drift is per task, not a run phase (`run.ts` never sets it at run level). Token totals, Open plan, Diff and per-tool durations are listed as out of scope above.
- **Type consistency:** these names are used identically in every task: `OrchestratorActivity`, `OrchestratorChildActivity`, `OrchestratorTaskClaim`, `OrchestratorModelSlots`, `OrchestratorToolCallActivity`, `ORCHESTRATOR_ACTIVITY_FRAME`, `ORCHESTRATOR_RECENT_TOOL_LIMIT`, `ORCHESTRATOR_OPEN_TASK_STATUSES`, `reduceChildActivity`, `OrchestratorLiveActivity.{setPlan,track,untrack,snapshot}`, `OrchestratorRunRegistry.{subscribeActivity,publishActivity}`, `OrchestratorLiveRun.activitySnapshot`, `OrchestratorStreamItem`, the hook's `{activity, workPhase}`, `useNow`, and the view-model exports.
- **Known risks:**
  - `RepoAgentSession.attach` holds a single subscriber. The parent becomes its children's only subscriber; nothing else attaches to orchestrator children today (they use boundary approval delivery).
  - Task 3 leaves `npm run typecheck:test` red until Task 5 adds `OrchestratorRun.activitySnapshot`. Run Tasks 3–5 back to back.
