# F17 God-Functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break up the F17 god-functions from `ARCHITECTURE-REVIEW.md` while adding tests and a regression guard that prevents touched files from regrowing giant functions.

**Architecture:** Extract behavior into explicit classes and endpoint modules without legacy shims. The summary planner extraction keeps the existing `SummaryPlannerLoopController` interface as the test surface and converts captured locals into cohesive collaborator objects, not lambdas or a 30-parameter constructor. The HTTP route-table mechanism is designed once for `chat`, `core`, `dashboard`, and `llama-passthrough`, so F17 and priority item #4/F7 converge instead of creating parallel mini-frameworks.

**Tech Stack:** TypeScript, Node test runner, existing `AgentLoop`, existing route request normalizers, `better-sqlite3`, source-level contract tests.

---

## Files And Responsibilities

- `src/summary/planner/runtime.ts`: top-level `SummaryPlannerLoopRuntime` class implementing `SummaryPlannerLoopController`.
- `src/summary/planner/runtime-dependencies.ts`: explicit dependency object types and small collaborator classes for planner request state, transcript state, status notifications, provider calls, tool execution, and completion state.
- `src/summary/planner/mode.ts`: orchestration only; validate backend/budget, build dependency objects, run `AgentLoop`, assemble result.
- `tests/summary-planner-runtime.test.ts`: unit tests against `SummaryPlannerLoopController` behavior through `SummaryPlannerLoopRuntime`.
- `tests/runtime-planner-mode*.test.ts`: existing characterization suites; run before and after extraction.
- `src/status-server/route-table.ts`: shared `RouteTable` with method + path matcher + handler dispatch.
- `src/status-server/routes/chat/*.ts`, `core/*.ts`, `dashboard/*.ts`, `llama-passthrough/*.ts`: per-endpoint handlers migrated incrementally.
- `tests/status-route-table.test.ts`: route matching and shared body parsing behavior.
- `tests/god-function-regression.test.ts`: max-function-length/source guard for touched modules.
- `src/summary/core/*.ts`: request normalization, planner/direct strategy selection, chunk orchestration, and status/artifact persistence split from `summary/core.ts`.
- `src/status-server/dashboard-runs/*.ts`: run records, artifact upserts, queries, deletion.

---

### Task 1: Baseline And Regression Guard

**Files:**
- Create: `tests/god-function-regression.test.ts`
- Modify: `tsconfig.test.json`

- [ ] **Step 1: Run planner baseline before extraction**

Run:

```powershell
npm test -- planner-mode
```

Expected: existing planner suites pass before behavior-preserving extraction.

- [ ] **Step 2: Write source guard test**

Add `tests/god-function-regression.test.ts` with explicit touched-file limits:

```ts
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

type FunctionLimit = {
  filePath: string;
  symbol: string;
  maxLines: number;
};

const limits: FunctionLimit[] = [
  { filePath: 'src/summary/planner/mode.ts', symbol: 'invokePlannerMode', maxLines: 180 },
  { filePath: 'src/status-server/routes/chat.ts', symbol: 'handleChatRoute', maxLines: 180 },
  { filePath: 'src/status-server/routes/core.ts', symbol: 'handleCoreRoute', maxLines: 180 },
];

function countFunctionLines(sourceText: string, symbol: string): number {
  const startPattern = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\b|(?:export\\s+)?(?:const|let)\\s+${symbol}\\b`, 'u');
  const startMatch = startPattern.exec(sourceText);
  assert.ok(startMatch, `Expected ${symbol} to exist`);
  const startIndex = startMatch.index;
  const bodyStart = sourceText.indexOf('{', startIndex);
  assert.notEqual(bodyStart, -1, `Expected ${symbol} body`);
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return sourceText.slice(startIndex, index + 1).split(/\r?\n/u).length;
    }
  }
  throw new Error(`Could not find end of ${symbol}`);
}

test('touched route and planner entrypoints stay below god-function limits', () => {
  for (const limit of limits) {
    const absolutePath = path.join(process.cwd(), limit.filePath);
    const lineCount = countFunctionLines(fs.readFileSync(absolutePath, 'utf8'), limit.symbol);
    assert.ok(
      lineCount <= limit.maxLines,
      `${limit.symbol} in ${limit.filePath} has ${lineCount} lines; limit is ${limit.maxLines}`,
    );
  }
});
```

- [ ] **Step 3: Verify guard is red before refactor**

Run:

```powershell
npx tsx --test .\tests\god-function-regression.test.ts
```

Expected: FAIL because current `invokePlannerMode`, `handleChatRoute`, and `handleCoreRoute` exceed limits.

- [ ] **Step 4: Include the guard in test typechecking**

Add `tests/god-function-regression.test.ts` to `tsconfig.test.json`.

---

### Task 2: Extract SummaryPlannerLoopRuntime

**Files:**
- Create: `src/summary/planner/runtime-dependencies.ts`
- Create: `src/summary/planner/runtime.ts`
- Create: `tests/summary-planner-runtime.test.ts`
- Modify: `src/summary/planner/mode.ts`
- Modify: `tsconfig.test.json`

- [ ] **Step 1: Add controller-surface unit tests during extraction**

Add tests for current `SummaryPlannerLoopController` behavior, not a new API:

```ts
import * as assert from 'node:assert/strict';
import test from 'node:test';
import type { SummaryPlannerLoopController } from '../src/summary/planner/agent-loop-adapter.js';
import {
  SummaryPlannerLoopRuntime,
  SummaryPlannerCompletionState,
  SummaryPlannerTranscriptState,
} from '../src/summary/planner/runtime.js';

test('SummaryPlannerLoopRuntime exposes the existing SummaryPlannerLoopController methods', () => {
  assert.equal(typeof SummaryPlannerLoopRuntime, 'function');
  type RuntimeIsController = SummaryPlannerLoopRuntime extends SummaryPlannerLoopController ? true : false;
  const runtimeIsController: RuntimeIsController = true;
  assert.equal(runtimeIsController, true);
});

test('SummaryPlannerCompletionState stores completed decisions explicitly', () => {
  const completion = new SummaryPlannerCompletionState();
  assert.equal(completion.isFinished(), false);
  completion.complete({
    classification: 'summary',
    rawReviewRequired: false,
    output: 'done',
  });
  assert.equal(completion.isFinished(), true);
  assert.deepEqual(completion.getDecision(), {
    classification: 'summary',
    rawReviewRequired: false,
    output: 'done',
  });
});

test('SummaryPlannerTranscriptState owns mutable transcript state', () => {
  const transcript = new SummaryPlannerTranscriptState({
    messages: [],
    toolDefinitions: [],
    inputText: 'a\nb\nc',
  });
  assert.equal(transcript.getToolResultCount(), 0);
  assert.deepEqual(transcript.getInputLines(), ['a', 'b', 'c']);
});
```

- [ ] **Step 2: Add explicit collaborator classes**

Create dependency classes:

```ts
export class SummaryPlannerRequestState {
  constructor(readonly options: InvokePlannerModeOptions, readonly budget: PlannerPromptBudget) {}
}

export class SummaryPlannerTranscriptState {
  constructor(private readonly state: SummaryPlannerTranscriptStateInput) {}
  getMessages(): LlamaCppChatMessage[] { return this.state.messages; }
  getToolDefinitions(): unknown[] { return this.state.toolDefinitions; }
  getInputLines(): string[] { return this.state.inputText.replace(/\r\n/gu, '\n').split('\n'); }
  getToolResultCount(): number { return this.state.toolResults.length; }
}

export class SummaryPlannerCompletionState {
  private finished = false;
  private decision: StructuredModelDecision | null = null;
  complete(decision: StructuredModelDecision): void { this.finished = true; this.decision = decision; }
  fail(): void { this.finished = true; this.decision = null; }
  isFinished(): boolean { return this.finished; }
  getDecision(): StructuredModelDecision | null { return this.decision; }
}
```

The final implementation may add methods needed by the moved runtime, but captured behavior must become methods on collaborators. Do not pass closure lambdas.

- [ ] **Step 3: Move the nested class body into `runtime.ts`**

Move `SummaryPlannerLoopRuntime` out of `invokePlannerMode` unchanged first, then replace free-variable access with the collaborator objects.

- [ ] **Step 4: Reduce `invokePlannerMode` to orchestration**

`mode.ts` should build:

```ts
const requestState = new SummaryPlannerRequestState(options, promptBudget);
const transcriptState = SummaryPlannerTranscriptState.fromInitialPrompt(...);
const completionState = new SummaryPlannerCompletionState();
const runtime = new SummaryPlannerLoopRuntime({
  requestState,
  transcriptState,
  completionState,
  debugRecorder,
});
```

Then run `AgentLoop` and return `new SummaryPlannerResultAssembler(completionState.getDecision()).assemble()` when finished.

- [ ] **Step 5: Verify extracted unit tests and planner characterization**

Run:

```powershell
npx tsx --test .\tests\summary-planner-runtime.test.ts
npm test -- planner-mode
npm run typecheck
```

Expected: all pass. Behavior must be bit-identical in existing planner tests.

- [ ] **Step 6: Commit slice**

Run:

```powershell
git add src/summary/planner/mode.ts src/summary/planner/runtime.ts src/summary/planner/runtime-dependencies.ts tests/summary-planner-runtime.test.ts tests/god-function-regression.test.ts tsconfig.test.json
git commit -m "refactor: extract summary planner loop runtime"
```

---

### Task 3: Shared Route Table For All Server Mega-Handlers

**Files:**
- Create: `src/status-server/route-table.ts`
- Create: `tests/status-route-table.test.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/status-server/routes/dashboard.ts`
- Modify: `src/status-server/routes/llama-passthrough.ts`

- [ ] **Step 1: Write route-table tests first**

Tests cover method/path match, regex param extraction, not-found passthrough, and JSON body parsing through endpoint normalizers.

- [ ] **Step 2: Implement one route-table mechanism**

Use one shared shape:

```ts
export type RouteHandler = (ctx: ServerContext, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch) => Promise<void> | void;

export type RouteDefinition = {
  method: string;
  path: string | RegExp;
  handler: RouteHandler;
};

export class RouteTable {
  constructor(private readonly routes: readonly RouteDefinition[]) {}
  async handle(ctx: ServerContext, req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    const route = this.match(req.method || '', pathname);
    if (!route) return false;
    await route.definition.handler(ctx, req, res, route.match);
    return true;
  }
}
```

- [ ] **Step 3: Migrate `chat.ts` and `core.ts` first**

Keep exported `handleChatRoute` and `handleCoreRoute` as thin route-table adapters during migration. Their function bodies must stay below the regression limit.

- [ ] **Step 4: Migrate `dashboard.ts` and `llama-passthrough.ts` onto the same table**

This closes F7 priority #4 at the same time as the F17 route split. Do not create a second routing abstraction.

- [ ] **Step 5: Validate and commit slice**

Run:

```powershell
npx tsx --test .\tests\status-route-table.test.ts
npx tsx --test .\tests\god-function-regression.test.ts
npm test -- status-server
npm run typecheck
git add src/status-server tests tsconfig.test.json
git commit -m "refactor: introduce shared status route table"
```

---

### Task 4: Decompose `summary/core.ts`

**Files:**
- Create: `src/summary/request-normalization.ts`
- Create: `src/summary/summary-core-runner.ts`
- Create: `src/summary/summary-status-notifier.ts`
- Modify: `src/summary/core.ts`
- Test: focused summary tests plus existing `runtime-summarize` suites.

- [ ] **Step 1: Add characterization tests around `summarizeRequest` paths**

Cover direct fallback, planner path, chunked path, and unsupported-input path.

- [ ] **Step 2: Extract request normalization**

Move request defaults and validation into typed helpers.

- [ ] **Step 3: Extract core runner**

Move `invokeSummaryCore` responsibilities into a class with explicit status/provider/planner collaborators.

- [ ] **Step 4: Validate and commit slice**

Run:

```powershell
npm test -- summarize
npm run typecheck
git add src/summary tests tsconfig.test.json
git commit -m "refactor: split summary core orchestration"
```

---

### Task 5: Partition `dashboard-runs.ts`

**Files:**
- Create: `src/status-server/dashboard-runs/run-records.ts`
- Create: `src/status-server/dashboard-runs/artifact-upserts.ts`
- Create: `src/status-server/dashboard-runs/queries.ts`
- Create: `src/status-server/dashboard-runs/deletion.ts`
- Modify: `src/status-server/dashboard-runs.ts`
- Test: dashboard run deletion/upsert/query tests.

- [ ] **Step 1: Add characterization tests for run records, artifact upserts, queries, and deletion**

Use temporary runtime DBs and assert rows plus linked artifact files are preserved or deleted exactly as current behavior requires.

- [ ] **Step 2: Move each responsibility into a focused module**

Keep `dashboard-runs.ts` as an export barrel plus small compatibility-free orchestration where needed.

- [ ] **Step 3: Validate and commit slice**

Run:

```powershell
npm test -- dashboard
npm run typecheck
git add src/status-server/dashboard-runs.ts src/status-server/dashboard-runs tests tsconfig.test.json
git commit -m "refactor: partition dashboard run storage"
```

---

## Compliance Notes

- `siftkit repo-search` was attempted first for discovery, but the status/config server returned `ECONNREFUSED 127.0.0.1:4765`; direct reads are allowed under the repo fallback rule while it is down.
- Characterization is required for extraction: baseline planner suites before and after the runtime move.
- New unit tests target the existing `SummaryPlannerLoopController` interface.
- No dynamic behavior lambdas in constructor dependencies.
- Commit each slice separately with its tests.
