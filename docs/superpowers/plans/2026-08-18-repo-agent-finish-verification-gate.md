# Repo-Agent Finish Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a repo-agent run emits a finish action, challenge it once with "are you sure you finished and adhered to the task correctly?" — a reaffirming finish is accepted, backing down lets the loop continue; the model may back down at most twice, and its 3rd distinct finish is accepted unchallenged.

**Architecture:** A new pure `FinishVerificationGate` state machine lives beside the engine's other finish controllers. A third `loopKind` value `'repo-agent'` is threaded from `execute.ts` (which already computes `isAgent`) through the engine so the gate arms only for agent runs. `TaskLoop.handleFinishAction` consults the gate after the existing evidence/grounding gates, reusing the exact finish-rejection transcript mechanics already present (assistant replay + injected user message + `continue`). Finishes emitted while `ForcedFinishController` is active bypass the gate (tool calls are blocked in that mode, so a challenge could never be acted on).

**Tech Stack:** TypeScript (strict, zod-validated IO), node:test via the repo's dist test runner.

**Verified anchors (2026-08-18):**
- `src/tool-loop-governor.ts:4` — `type ToolLoopKind = 'repo-search' | 'planner' | 'chat';`
- `src/tool-loop-governor.ts:224-227` — `evaluateFinishAttempt` returns `{ allowed: true }` for any `loopKind !== 'repo-search'`
- `src/repo-search/execute.ts:287` — `const isAgent = request.taskKind === 'repo-agent';`
- `src/repo-search/execute.ts:397` — `loopKind: taskKind === 'chat' ? 'chat' : 'repo-search',`
- `src/repo-search/engine.ts:179` — `loopKind?: 'repo-search' | 'chat';` (option decl), `:255` passes it through
- `src/repo-search/engine/task-loop-support.ts:164` — `loopKind?: 'repo-search' | 'chat';` in `RunTaskLoopOptions`
- `src/repo-search/engine/task-loop-support.ts:109-143` — `TaskResultSchema`
- `src/repo-search/engine/task-loop.ts:140` — field decl; `:202` — normalization; `:152` — `forcedFinish`; `:644-680` — `handleFinishAction`; `:489` — `executeTools`; `:715-718` — `task_done` log; `:720-729` — result assembly
- `src/repo-search/engine/forced-finish.ts:19` — `ForcedFinishController` (`isActive()`)
- Test pattern: `tests/repo-search-loop.core.test.ts:792-828` (mock loop with `createMockLoopDefaults`, `mockResponses`, `mockCommandResults`, in-memory logger)

**Behavior contract (from the spec):**
1. Finish #1 (agent run, not in forced-finish mode) → challenge injected, loop continues.
2. Next response is a finish → "doubled down" → accepted.
3. Next response is tool actions → model backed down; it keeps working. Its next finish gets challenge #2 (same rules).
4. After 2 challenges have been issued, the next distinct finish is accepted without a challenge ("3rd finish is forced done"). So the model can back down at most 2 times.
5. Non-agent loops (`repo-search` Q&A, `chat`, `summary`) are completely unaffected.
6. A finish emitted while forced-finish mode is active is never challenged.

**Build/test gotcha:** the server and test runner load `dist/`. Bare `tsc` emits to `dist/src/`; the sync step is mandatory. Use `npm run build:test` before running tests, and after the final task run `npx tsc -p tsconfig.json && node --experimental-strip-types scripts/sync-dist-runtime.ts` so the running status-server picks up the change.

**Do not commit any of this work.**

---

## File structure

- Create: `src/repo-search/engine/finish-verification.ts` — the pure gate state machine + constants.
- Create: `tests/finish-verification-gate.test.ts` — unit tests for the state machine.
- Create: `tests/repo-agent-finish-verification.test.ts` — E2E loop tests through `runTaskLoop`.
- Modify: `src/tool-loop-governor.ts:4` — widen `ToolLoopKind`.
- Modify: `src/repo-search/engine/task-loop-support.ts` — widen `loopKind` option; add `finishChallenges` to `TaskResultSchema`.
- Modify: `src/repo-search/engine.ts:179` — widen `loopKind` option type.
- Modify: `src/repo-search/engine/task-loop.ts` — field, normalization, gate wiring in `handleFinishAction`, back-down hook in `executeTools`, result/log fields.
- Modify: `src/repo-search/execute.ts:397` — emit `'repo-agent'` for agent runs.

---

### Task 1: `FinishVerificationGate` state machine

**Files:**
- Create: `src/repo-search/engine/finish-verification.ts`
- Test: `tests/finish-verification-gate.test.ts`

- [ ] **Step 1: Write the failing unit tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FINISH_VERIFICATION_CHALLENGE_MESSAGE,
  FINISH_VERIFICATION_MAX_CHALLENGES,
  FinishVerificationGate,
} from '../src/repo-search/engine/finish-verification.js';

test('disabled gate accepts every finish without challenging', () => {
  const gate = new FinishVerificationGate(false);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(gate.evaluateFinish(), { kind: 'accept', mode: 'gate-disabled' });
  }
  assert.equal(gate.issuedCount, 0);
});

test('first finish is challenged and an immediate second finish is accepted as reaffirmed', () => {
  const gate = new FinishVerificationGate(true);
  const first = gate.evaluateFinish();
  assert.equal(first.kind, 'challenge');
  if (first.kind === 'challenge') {
    assert.equal(first.message, FINISH_VERIFICATION_CHALLENGE_MESSAGE);
    assert.equal(first.challengesIssued, 1);
  }
  assert.deepEqual(gate.evaluateFinish(), { kind: 'accept', mode: 'reaffirmed' });
});

test('backing down with tool actions re-arms the challenge, up to the maximum', () => {
  const gate = new FinishVerificationGate(true);
  assert.equal(gate.evaluateFinish().kind, 'challenge'); // finish #1
  gate.recordNonFinishAction();                           // backs down, works
  const second = gate.evaluateFinish();                   // finish #2
  assert.equal(second.kind, 'challenge');
  if (second.kind === 'challenge') {
    assert.equal(second.challengesIssued, FINISH_VERIFICATION_MAX_CHALLENGES);
  }
  gate.recordNonFinishAction();                           // backs down again
  assert.deepEqual(gate.evaluateFinish(), { kind: 'accept', mode: 'forced' }); // finish #3
  assert.equal(gate.issuedCount, 2);
});

test('an invalid response between challenge and finish does not clear the reaffirmation window', () => {
  const gate = new FinishVerificationGate(true);
  assert.equal(gate.evaluateFinish().kind, 'challenge');
  // No recordNonFinishAction call: only an executed tool action counts as backing down.
  assert.deepEqual(gate.evaluateFinish(), { kind: 'accept', mode: 'reaffirmed' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js finish-verification-gate }`
Expected: FAIL — module `finish-verification.js` not found.

- [ ] **Step 3: Implement the gate**

```ts
export const FINISH_VERIFICATION_MAX_CHALLENGES = 2;
export const FINISH_VERIFICATION_CHALLENGE_MESSAGE =
  'Verification check: are you sure you finished and adhered to the task correctly? '
  + 'Re-read the task requirements. If you are certain the work is complete and verified, '
  + 'return the finish action again. If anything is incomplete, unverified, or was skipped, '
  + 'continue working with tool actions instead.';

export type FinishVerificationDecision =
  | { kind: 'challenge'; message: string; challengesIssued: number }
  | { kind: 'accept'; mode: 'gate-disabled' | 'reaffirmed' | 'forced' };

/**
 * Challenges an agent run's finish before accepting it. A finish emitted while a challenge is
 * outstanding is a reaffirmation and is accepted; an executed tool action withdraws the finish
 * and re-arms the gate. After FINISH_VERIFICATION_MAX_CHALLENGES challenges the next finish is
 * accepted unchallenged, bounding the loop.
 */
export class FinishVerificationGate {
  private challengesIssued = 0;
  private awaitingReaffirmation = false;

  constructor(private readonly enabled: boolean) {}

  get issuedCount(): number {
    return this.challengesIssued;
  }

  evaluateFinish(): FinishVerificationDecision {
    if (!this.enabled) {
      return { kind: 'accept', mode: 'gate-disabled' };
    }
    if (this.awaitingReaffirmation) {
      this.awaitingReaffirmation = false;
      return { kind: 'accept', mode: 'reaffirmed' };
    }
    if (this.challengesIssued >= FINISH_VERIFICATION_MAX_CHALLENGES) {
      return { kind: 'accept', mode: 'forced' };
    }
    this.challengesIssued += 1;
    this.awaitingReaffirmation = true;
    return {
      kind: 'challenge',
      message: FINISH_VERIFICATION_CHALLENGE_MESSAGE,
      challengesIssued: this.challengesIssued,
    };
  }

  recordNonFinishAction(): void {
    this.awaitingReaffirmation = false;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js finish-verification-gate }`
Expected: PASS (4 tests).

---

### Task 2: Thread `loopKind: 'repo-agent'` through the engine

**Files:**
- Modify: `src/tool-loop-governor.ts:4`
- Modify: `src/repo-search/engine/task-loop-support.ts:164`
- Modify: `src/repo-search/engine.ts:179`
- Modify: `src/repo-search/engine/task-loop.ts:140,202`
- Modify: `src/repo-search/execute.ts:397`

No new behavior yet (the gate is wired in Task 3); this task is type threading. The one
intentional behavior change: `evaluateFinishAttempt` (`src/tool-loop-governor.ts:224`) returns
`{ allowed: true }` for any `loopKind !== 'repo-search'`, so agent runs stop passing through the
Q&A citation gate. That gate was designed for repo-search answers with `file:line` anchors and
auto-allowed unanchored agent finishes anyway; the verification gate (Task 3) replaces it for
agent runs. Do not modify `evaluateFinishAttempt` itself.

- [ ] **Step 1: Widen `ToolLoopKind` in `src/tool-loop-governor.ts:4`**

```ts
type ToolLoopKind = 'repo-search' | 'planner' | 'chat' | 'repo-agent';
```

- [ ] **Step 2: Widen the option in `src/repo-search/engine/task-loop-support.ts:164`**

```ts
  loopKind?: 'repo-search' | 'chat' | 'repo-agent';
```

- [ ] **Step 3: Widen the option in `src/repo-search/engine.ts:179`**

```ts
  loopKind?: 'repo-search' | 'chat' | 'repo-agent';
```

- [ ] **Step 4: Widen the field and normalization in `src/repo-search/engine/task-loop.ts`**

Line 140:

```ts
  private readonly loopKind: 'repo-search' | 'chat' | 'repo-agent';
```

Line 202:

```ts
    this.loopKind = options.loopKind === 'chat' || options.loopKind === 'repo-agent'
      ? options.loopKind
      : 'repo-search';
```

The other `loopKind` branches in this file (lines 209, 212, 229, 235, 260) all compare against
`'chat'`; `'repo-agent'` deliberately takes the repo-search side of each (planner budget message,
tool names, no chat grounding, task-style initial prompt). Leave them untouched.

- [ ] **Step 5: Emit the new kind for agent runs in `src/repo-search/execute.ts:397`**

```ts
      loopKind: taskKind === 'chat' ? 'chat' : isAgent ? 'repo-agent' : 'repo-search',
```

- [ ] **Step 6: Typecheck and run the existing engine suite to prove no regression**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-search-loop }`
Expected: PASS — existing repo-search loop tests unaffected (they omit `loopKind`, which still
normalizes to `'repo-search'`).

---

### Task 3: Wire the gate into the task loop

**Files:**
- Modify: `src/repo-search/engine/task-loop.ts` (field + constructor + `handleFinishAction:644` + `executeTools:489` + `task_done` log `:715-718` + result `:720-729`)
- Modify: `src/repo-search/engine/task-loop-support.ts` (`TaskResultSchema:109-143`)
- Test: `tests/repo-agent-finish-verification.test.ts`

- [ ] **Step 1: Write the failing E2E tests**

Model the file on `tests/repo-search-loop.core.test.ts:792-828`. `runTaskLoop` is exported from
`src/repo-search/engine.js`; `createMockLoopDefaults` from `tests/helpers/mock-loop-defaults.js`.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { runTaskLoop } from '../src/repo-search/engine.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-finish-verify-');

const GREP_OK = { exitCode: 0, stdout: 'src\\summary.ts:10:planner hit', stderr: '' };

function collectingLogger(events: JsonObject[]) {
  return {
    path: 'memory',
    write(event: JsonObject) {
      events.push(JSON.parse(JSON.stringify(event)));
    },
  };
}

test('repo-agent finish is challenged once and accepted when the model doubles down', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-reaffirm', question: 'Do the task.', signals: [] },
    {
      ...MOCK_LOOP_DEFAULTS,
      loopKind: 'repo-agent',
      minToolCallsBeforeFinish: 0,
      maxTurns: 6,
      mockResponses: [
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: { 'git grep -n "planner" src': GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.finishChallenges, 1);
  assert.equal(events.filter((e) => e.kind === 'turn_finish_challenged').length, 1);
  const verified = events.find((e) => e.kind === 'turn_finish_verified');
  assert.equal(verified?.mode, 'reaffirmed');
});

test('repo-agent model may back down twice; the third finish is forced done', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-forced', question: 'Do the task.', signals: [] },
    {
      ...MOCK_LOOP_DEFAULTS,
      loopKind: 'repo-agent',
      minToolCallsBeforeFinish: 0,
      maxTurns: 10,
      mockResponses: [
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"v1"}',
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"budget\\\" src\"}",
        '{"action":"finish","output":"v2"}',
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"tokens\\\" src\"}",
        '{"action":"finish","output":"v3"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {
        'git grep -n "planner" src': GREP_OK,
        'git grep -n "budget" src': { exitCode: 0, stdout: 'src\\budget.ts:5:budget hit', stderr: '' },
        'git grep -n "tokens" src': { exitCode: 0, stdout: 'src\\tokens.ts:7:tokens hit', stderr: '' },
      },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'v3');
  assert.equal(result.finishChallenges, 2);
  assert.equal(events.filter((e) => e.kind === 'turn_finish_challenged').length, 2);
  const verified = events.find((e) => e.kind === 'turn_finish_verified');
  assert.equal(verified?.mode, 'forced');
});

test('repo-search loop finishes are never challenged', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'search-untouched', question: 'Find planner tools.', signals: ['done'] },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 4,
      minToolCallsBeforeFinish: 0,
      mockResponses: [
        "{\"action\":\"git\",\"command\":\"git grep -n \\\"planner\\\" src\"}",
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: { 'git grep -n "planner" src': GREP_OK },
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finishChallenges, 0);
  assert.equal(events.some((e) => e.kind === 'turn_finish_challenged'), false);
  assert.equal(events.some((e) => e.kind === 'turn_finish_verified'), false);
});

test('finish during forced-finish mode bypasses the verification gate', async () => {
  // Ten distinct zero-output commands trip ZERO_OUTPUT_FORCE_THRESHOLD
  // (src/repo-search/engine/forced-finish.ts:1), activating forced-finish mode; the
  // following finish must be accepted without a challenge.
  const emptyResult = { exitCode: 0, stdout: '', stderr: '' };
  const commands = Array.from({ length: 10 }, (_, i) => `git grep -n "needle${i}" src`);
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'agent-forced-mode', question: 'Do the task.', signals: [] },
    {
      ...MOCK_LOOP_DEFAULTS,
      loopKind: 'repo-agent',
      minToolCallsBeforeFinish: 0,
      maxTurns: 15,
      mockResponses: [
        ...commands.map((command) => JSON.stringify({ action: 'git', command })),
        '{"action":"finish","output":"nothing found"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: Object.fromEntries(commands.map((command) => [command, emptyResult])),
      logger: collectingLogger(events),
    },
  );

  assert.equal(result.reason, 'finish');
  assert.equal(result.finishChallenges, 0);
  assert.equal(events.some((e) => e.kind === 'turn_finish_challenged'), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-agent-finish-verification }`
Expected: FAIL — `loopKind: 'repo-agent'` is accepted (Task 2) but `result.finishChallenges` is
undefined and no `turn_finish_challenged` events are emitted.

- [ ] **Step 3: Add `finishChallenges` to `TaskResultSchema`**

In `src/repo-search/engine/task-loop-support.ts:116`, directly after `commandFailures`:

```ts
  commandFailures: z.number(),
  /** Verification-gate challenges issued before this task's finish was accepted. Defaults for scorecards persisted before the gate existed. */
  finishChallenges: z.number().default(0),
```

- [ ] **Step 4: Wire the gate into `src/repo-search/engine/task-loop.ts`**

Import (alongside the `ForcedFinishController` import at line 60):

```ts
import { FINISH_VERIFICATION_MAX_CHALLENGES, FinishVerificationGate } from './finish-verification.js';
```

Field (next to `forcedFinish`, line 152). It cannot be initialized inline because it depends on
`loopKind`, which the constructor computes; declare it readonly without an initializer (no
definite-assignment `!` — that is forbidden in this repo) and assign it in the constructor
immediately after `this.loopKind` is set at line 202:

```ts
  private readonly finishVerification: FinishVerificationGate;
```

```ts
    this.loopKind = options.loopKind === 'chat' || options.loopKind === 'repo-agent'
      ? options.loopKind
      : 'repo-search';
    this.finishVerification = new FinishVerificationGate(this.loopKind === 'repo-agent');
```

In `handleFinishAction` (line 644), after the grounding rejection block (line 673) and before
`this.finalOutput = action.output;` (line 674):

```ts
    if (!this.forcedFinish.isActive()) {
      const verification = this.finishVerification.evaluateFinish();
      if (verification.kind === 'challenge') {
        this.toolStats.recordFinishRejection();
        this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
        this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
        this.transcript.pushUser(verification.message);
        this.options.logger?.write({
          kind: 'turn_finish_challenged',
          taskId: this.task.id,
          turn,
          challengesIssued: verification.challengesIssued,
          maxChallenges: FINISH_VERIFICATION_MAX_CHALLENGES,
        });
        return 'continue';
      }
      if (verification.mode !== 'gate-disabled') {
        this.options.logger?.write({
          kind: 'turn_finish_verified',
          taskId: this.task.id,
          turn,
          mode: verification.mode,
        });
      }
    }
```

At the top of `executeTools` (line 489) — the model responded with tool actions, so any
outstanding challenge was answered by backing down:

```ts
  async executeTools(actions: readonly AgentLoopToolAction[], context: AgentLoopResponseContext): Promise<AgentLoopToolExecution> {
    this.finishVerification.recordNonFinishAction();
```

In the `task_done` log (line 715-718), add `finishChallenges` after `commandFailures`:

```ts
      invalidResponses: this.counters.invalidResponses, commandFailures: this.counters.commandFailures,
      finishChallenges: this.finishVerification.issuedCount, passed, missingSignals: signalCheck.missingSignals,
```

In the returned `TaskResult` (line 720-729), add after `commandFailures`:

```ts
      invalidResponses: this.counters.invalidResponses, commandFailures: this.counters.commandFailures,
      finishChallenges: this.finishVerification.issuedCount,
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npm run build:test; if ($?) { node .\dist\test-runner\run-tests.js repo-agent-finish-verification }`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the neighboring suites and gates**

Run: `node .\dist\test-runner\run-tests.js repo-search-loop`
Expected: PASS — the Q&A finish path is untouched.

Run: `node .\dist\test-runner\run-tests.js finish-verification-gate`
Expected: PASS.

Run: `npx tsc -p tsconfig.json --noEmit; if ($?) { npx tsc -p tsconfig.test.json --noEmit }`
Expected: clean.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 7: Sync dist so the running server loads the gate**

Run: `npx tsc -p tsconfig.json; if ($?) { node --experimental-strip-types scripts/sync-dist-runtime.ts }`
Expected: sync completes; `dist/repo-search/engine/finish-verification.js` exists.

---

## Out of scope (deliberately)

- Mutation-aware finish gating (`mutatedPaths` cross-check, `git status` verification) — separate recommendation #1 from the 2026-08-18 handoff, not requested here.
- Surfacing `finishChallenges` in `formatRepoTaskOutput` / repo-agent CLI output.
- Any change to the thinking-budget splice or reviewer-policy placement.
- Challenge-message A/B tuning; the wording ships as a constant and can be revised later.

## Self-review notes

- Spec coverage: challenge-on-finish (Task 3 step 4), double-down acceptance (gate `awaitingReaffirmation`), up-to-2 back-downs with forced 3rd finish (`FINISH_VERIFICATION_MAX_CHALLENGES`), repo-agent-only scoping (loopKind threading, Task 2). All contract points 1-6 have tests.
- Invalid responses between challenge and re-finish keep the reaffirmation window open by design (only `executeTools` clears it); covered by unit test 4.
- Forced-finish interplay: gate bypassed when `forcedFinish.isActive()`; E2E test 4.
- `z.number().default(0)` keeps previously persisted scorecards parseable without a parallel schema.
