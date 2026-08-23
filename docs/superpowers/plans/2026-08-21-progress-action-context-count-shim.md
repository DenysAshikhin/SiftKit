# Progress Action, True Prompt Counting, CLI Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Dispatch policy (per AGENTS.md):** implementation goes through `siftkit repo-agent`, 1-3 tasks per dispatch, dispatched **from PowerShell** (never Git Bash — that is what Task 8 fixes). repo-agent must not commit; the primary agent reviews the diff, runs the tests itself, and commits after each task is green.

**Goal:** Give repo-search/repo-agent a non-terminal `progress` action rendered as a persistent status bar in the dashboard and a log line in the CLI; make prompt preflight count the preserved `reasoning_content` that is actually sent to the exl3/TabbyAPI backend (fixing late compaction and the `context_length_exceeded` 400); fix the CLI shim so Git Bash invocation works.

**Architecture:** The `progress` action flows planner JSON → `ModelJson` validation → `AgentLoop` action dispatch → `TaskLoop.handleProgress` (transcript replay + ack, progress event) → three sinks: CLI progress renderer, status-server console line, chat SSE → dashboard live turn. The counting fix changes only the *counting* render (`renderTaskTranscript` gains a required reasoning option mirroring `serializePlannerMessage`'s keep-condition); everything downstream (compaction trigger, `maxOutputTokens`, budgets, logs) consumes the corrected count automatically. A per-turn drift check compares server-reported prompt tokens against the preflight prediction.

**Tech Stack:** TypeScript (strict, inferred end-to-end, zod for IO), `node:test` + `assert/strict` via the repo test-runner, React 19 dashboard, custom SSE chat stream.

**Explicit scope decisions (from the approved design):**
- The only prompt change is one neutral schema line advertising `progress` in both action lists. No cadence instructions, no changes to finish/verification wording.
- Dashboard bar is Option A (status bar), **text wraps to full height — no clipping/ellipsis**. Each update replaces the previous in place. Live-only: not persisted, disappears when the turn settles. Superseded updates survive only in logs.
- Out of scope: finish-hardening (continuation-text rejection, mutated-path validation), error-label rename, `--task-file`.

---

## Context: the three root causes being fixed

1. **Premature `finish` masking partial work.** The action protocol gives the model no non-terminal prose channel — every turn is a tool action or `finish` (`src/repo-search/prompts.ts:287-289`). Run `b3f9c83a` emitted `finish` with output "…Continuing with implementation now." at turn 10/100 and `status:"completed"` masked partial work. The fix under test: give the model a `progress` action so narration has somewhere else to go.
2. **`context_length_exceeded` 400 at a "119k" prompt.** Preflight counts `renderTaskTranscript(messages)` (`src/repo-search/planner-protocol.ts:922-943`), which omits `reasoning_content`. The request serializes `reasoning_content` per assistant message (`planner-protocol.ts:534-545`) and sends `preserve_thinking: true`, so the server re-injects all preserved thinking (~16.7k tokens at failure). Server allocation = real prompt + `max_tokens` = 151,552 > 150,016 cache → HTTP 400, and compaction (keyed to the undercounted number) never fired.
3. **Git Bash dispatch exit 2.** The installed `dist/cli/main.js` has no shebang; npm's sh-shim executes it with `sh`, which parses ESM `import` as a shell command. Build is plain `tsc`; `scripts/sync-dist-runtime.ts` is the final build step and the right place to prepend the shebang.

## Conventions

- Build + test: `npm run build:test` then `node ./dist/test-runner/run-tests.js <suite>` (suite = test file basename without `.test.ts`/`.test.tsx`; e.g. `agent-loop`, `engine-prompt-preparer`, `chat-tab`). Full suite: `npm test`. Always `npm run typecheck` (includes lint) before calling a task done.
- PowerShell 5.1 runs commands: chain with `;` + `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`, never `&&`.
- Repo rules: no `any`, no type assertions, no non-null `!`, runtime zod schemas for IO, `z.infer` types, `satisfies` allowed. Match surrounding style (single quotes, trailing commas, 2-space indent).
- Tests import from `../src/...` (`.js` suffix) and use `test()` from `node:test` with `assert` from `node:assert/strict`.

## File map

| File | Change |
| --- | --- |
| `src/repo-search/planner-protocol.ts` | `ProgressAction` type; reasoning-aware `renderTaskTranscript`; shared keep-reasoning helper; `serverPromptTokens` on `PlannerActionResponse` |
| `src/lib/model-json.ts` | validate `progress` in `validateRepoSearchPlannerAction` |
| `src/agent-loop/types.ts` | `AgentLoopProgressAction`; `handleProgress` on `AgentLoopActionAdapter` |
| `src/agent-loop/action-parser.ts` | map parsed progress action |
| `src/agent-loop/agent-loop.ts` | dispatch progress actions |
| `src/repo-search/agent-loop-adapter.ts` | delegate `handleProgress` to controller |
| `src/summary/planner/agent-loop-adapter.ts`, `src/summary/planner/mode.ts` | loud `handleProgress` stub |
| `src/repo-search/engine/task-loop.ts` | `handleProgress` implementation; prompt-drift check |
| `src/repo-search/engine/progress-reporter.ts` | `progressUpdate` event |
| `src/repo-search/types.ts` | `progressText` field on `RepoSearchProgressEvent` |
| `src/repo-search/prompts.ts` | one neutral progress line in both action lists |
| `src/cli/progress-renderer.ts` | `progress_update` line |
| `src/status-server/dashboard-runs.ts` | server console `progress` line |
| `src/status-server/routes/chat.ts` | forward `progress_update` on the chat SSE |
| `packages/contracts/src/chat.ts` | `ChatStreamProgressSchema` |
| `dashboard/src/lib/chat-stream-parser.ts`, `chat-stream-transitions.ts`, `chat-session-runtime-store.ts` | parse/route/store the progress frame |
| `dashboard/src/lib/chatTurns.ts`, `dashboard/src/types.ts` (kind union), `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/styles/chat.css` | render the status bar |
| `src/repo-search/prompt-budget.ts`, `src/repo-search/engine/transcript-manager.ts`, `src/repo-search/engine/prompt-preparer.ts` | count-what-you-send |
| `scripts/sync-dist-runtime.ts` | shebang prepend |
| `src/cli/help.ts`, `README.md` | invocation note |
| Tests | `tests/agent-loop.test.ts`, new `tests/progress-action.e2e.test.ts`, `tests/engine-prompt-preparer.test.ts`, new `tests/prompt-drift.test.ts`, new `tests/sync-dist-runtime-shebang.test.ts`, dashboard tests |

---

### Task 1: `progress` action — types, validation, parsing

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:59-64` (action types)
- Modify: `src/lib/model-json.ts:11-17` (imports), `:560-576` (validation)
- Modify: `src/agent-loop/types.ts:5-20` (actions), `:106-111` (adapter interface)
- Modify: `src/agent-loop/action-parser.ts:11-40`
- Test: `tests/agent-loop.test.ts`

- [ ] **Step 1: Write the failing parser tests** — append to `tests/agent-loop.test.ts`:

```ts
test('agent loop action parser maps a progress action', () => {
  const parser = new AgentLoopActionParser();

  const actions = parser.parseRepoSearchActions('{"action":"progress","output":"RED done; starting GREEN"}', ['grep']);

  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action?.kind, 'progress');
  if (action?.kind !== 'progress') {
    throw new Error('expected progress action');
  }
  assert.equal(action.text, 'RED done; starting GREEN');
});

test('progress action validation rejects empty output and extra keys', () => {
  const parser = new AgentLoopActionParser();

  assert.throws(
    () => parser.parseRepoSearchActions('{"action":"progress","output":"  "}', ['grep']),
    /invalid planner progress action/u,
  );
  assert.throws(
    () => parser.parseRepoSearchActions('{"action":"progress","output":"x","extra":1}', ['grep']),
    /accepts only "action" and "output"/u,
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js agent-loop`
Expected: FAIL — `Provider returned an unknown planner action "progress"`.

- [ ] **Step 3: Add the action type** — in `src/repo-search/planner-protocol.ts` after `FinishAction` (line 59-62):

```ts
export type ProgressAction = {
  action: 'progress';
  output: string;
};

export type PlannerAction = ToolAction | ToolBatchAction | FinishAction | ProgressAction;
```

(The `PlannerAction` line replaces the existing one at line 64.)

- [ ] **Step 4: Validate it in `model-json.ts`** — add `ProgressAction as RepoSearchProgressAction,` to the type import block at lines 11-17. In `validateRepoSearchPlannerAction`, insert **before** the `if (action === 'finish')` branch (line 560):

```ts
    if (action === 'progress') {
      const output = typeof parsed.output === 'string' ? parsed.output.trim() : '';
      if (!output) {
        throw new Error('Provider returned an invalid planner progress action: "output" must be a non-empty string');
      }
      const extraKeys = Object.keys(parsed).filter((key) => key !== 'action' && key !== 'output');
      if (extraKeys.length > 0) {
        throw new Error(
          `Provider returned an invalid planner progress action: progress accepts only "action" and "output"; remove: ${extraKeys.join(', ')}`,
        );
      }
      return { action: 'progress', output } satisfies RepoSearchProgressAction;
    }
```

Also extend the unknown-action error (line 574-575) valid-actions list from `[...allowedToolNames, 'tool_batch', 'finish']` to `[...allowedToolNames, 'tool_batch', 'finish', 'progress']`.

Do **not** touch `validateSummaryPlannerAction` — the summary planner has no progress action.

- [ ] **Step 5: Agent-loop action type + adapter hook** — in `src/agent-loop/types.ts`, after `AgentLoopToolAction` (line 18):

```ts
export type AgentLoopProgressAction = {
  kind: 'progress';
  text: string;
};

export type AgentLoopAction = AgentLoopFinishAction | AgentLoopToolAction | AgentLoopProgressAction;
```

(The `AgentLoopAction` line replaces the existing one at line 20.) Add to `AgentLoopActionAdapter` (after `evaluateFinish`, line 110):

```ts
  handleProgress(action: AgentLoopProgressAction, context: AgentLoopResponseContext): Promise<AgentLoopTurnOutcome>;
```

- [ ] **Step 6: Map it in the parser** — in `src/agent-loop/action-parser.ts` `parseRepoSearchActions`, after the `finish` branch (line 23):

```ts
    if (parsed.action === 'progress') {
      return [
        {
          kind: 'progress',
          text: parsed.output,
        },
      ];
    }
```

- [ ] **Step 7: Satisfy the widened interface everywhere.** Typecheck will now fail loudly on every `AgentLoopActionAdapter` implementer — that is the migration guide. Fix each:
  - `src/repo-search/agent-loop-adapter.ts`: add to `RepoSearchLoopController` (after `evaluateFinish`, line 24): `handleProgress(action: AgentLoopProgressAction, context: AgentLoopResponseContext): Promise<AgentLoopTurnOutcome>;` and to `RepoSearchActionAdapter` (after line 64): `async handleProgress(action: AgentLoopProgressAction, context: AgentLoopResponseContext): Promise<AgentLoopTurnOutcome> { return this.controller.handleProgress(action, context); }` (import the two new types).
  - `src/repo-search/engine/task-loop.ts` (implements the controller): temporary minimal implementation returning `'continue'` — Task 2 replaces it with the real one:

```ts
  async handleProgress(action: AgentLoopProgressAction, _context: AgentLoopResponseContext): Promise<AgentLoopTurnOutcome> {
    void action;
    return 'continue';
  }
```

  - `src/summary/planner/agent-loop-adapter.ts` and its controller in `src/summary/planner/mode.ts` (mirror the shape at `mode.ts:741`): the summary parser can never produce a progress action, so fail loudly:

```ts
  async handleProgress(): Promise<AgentLoopTurnOutcome> {
    throw new Error('Summary planner does not support the progress action.');
  }
```

  - Test stubs in `tests/agent-loop.test.ts` (e.g. `StubActionAdapter`, line 75) and `tests/agent-loop-boundary.test.ts`: add a `handleProgress` recording stub returning `'continue'`.

- [ ] **Step 8: Verify green**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js agent-loop; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit** (primary agent, after diff review)

```powershell
git add src/repo-search/planner-protocol.ts src/lib/model-json.ts src/agent-loop/ src/repo-search/agent-loop-adapter.ts src/repo-search/engine/task-loop.ts src/summary/planner/ tests/agent-loop.test.ts tests/agent-loop-boundary.test.ts
git commit -m "feat(agent-loop): add non-terminal progress planner action"
```

**Acceptance criteria:** progress JSON parses into `{kind:'progress', text}`; empty output / extra keys rejected with the exact messages above; summary planner throws on progress; `npm run typecheck` and the `agent-loop` suite pass.

---

### Task 2: Loop dispatch + task-loop handling + prompt line

**Files:**
- Modify: `src/agent-loop/agent-loop.ts:94-110`
- Modify: `src/repo-search/engine/task-loop.ts` (replace Task 1 stub; near `rejectFinish` at line 670)
- Modify: `src/repo-search/engine/progress-reporter.ts:93-95`
- Modify: `src/repo-search/types.ts:21-53`
- Modify: `src/repo-search/prompts.ts:224` and `:289`
- Test: `tests/agent-loop.test.ts`, Create: `tests/progress-action.e2e.test.ts`

- [ ] **Step 1: Failing loop-dispatch test** — append to `tests/agent-loop.test.ts` (extend `StubActionAdapter` so its `handleProgress` records calls into a `progressTexts: string[]` field):

```ts
test('agent loop routes a progress action through handleProgress and continues', async () => {
  const actionAdapter = new StubActionAdapter();
  const loop = new AgentLoop({
    maxTurns: 3,
    promptAdapter: new StubPromptAdapter(),
    actionAdapter,
    toolAdapter: new StubToolAdapter(),
    modelClient: new StubModelClient([
      '{"action":"progress","output":"halfway"}',
      '{"action":"finish","output":"done"}',
    ]),
  });

  const result = await loop.run();

  assert.equal(result.reason, 'finished');
  assert.equal(result.finishText, 'done');
  assert.deepEqual(actionAdapter.progressTexts, ['halfway']);
});
```

(`StubToolAdapter` / `StubModelClient` already exist in this file below line 80 — reuse them; the model client stub replays the given texts as responses.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js agent-loop`
Expected: FAIL — progress action falls through to `toolActions` and breaks (`AgentLoopToolAction` shape mismatch surfaces as a type error at build, or the stub tool adapter receives it).

- [ ] **Step 3: Dispatch in the loop** — in `src/agent-loop/agent-loop.ts`, inside the `for (const action of actions)` loop (line 95), after the `finish` branch closes (line 108):

```ts
        if (action.kind === 'progress') {
          const progressOutcome = await this.options.actionAdapter.handleProgress(action, {
            ...responseContext,
            turns: this.turns,
          });
          if (progressOutcome === 'stop') {
            return this.buildResult('', 'aborted');
          }
          continue;
        }
```

- [ ] **Step 4: Real task-loop handler** — replace the Task 1 stub in `src/repo-search/engine/task-loop.ts` (place next to `evaluateFinish`, line 498). It mirrors `rejectFinish`'s transcript pattern (line 670-675) so the model sees its note landed:

```ts
  async handleProgress(action: AgentLoopProgressAction, context: AgentLoopResponseContext): Promise<AgentLoopTurnOutcome> {
    const turn = context.turnNumber;
    const response = getRepoSearchModelData(context).plannerResponse;
    this.finishVerification.recordNonFinishAction();
    this.transcript.pushAssistant(buildAssistantReplayMessage(response.text, String(response.thinkingText || '').trim()));
    this.transcript.pruneThinking(this.plannerMaintainPerStepThinking);
    this.transcript.pushUser('Progress note recorded. Continue with the next action.');
    this.progress.progressUpdate(turn, action.text);
    this.options.logger?.write({ kind: 'turn_progress', taskId: this.task.id, turn, text: action.text });
    return 'continue';
  }
```

(Imports for `AgentLoopProgressAction` join the existing `agent-loop/types.js` import block; `buildAssistantReplayMessage` is already imported from `task-loop-support.js`.)

- [ ] **Step 5: Progress event** — `src/repo-search/engine/progress-reporter.ts`, after `answer` (line 95):

```ts
  progressUpdate(turn: number, progressText: string): void {
    this.emit({ kind: 'progress_update', taskId: this.taskId, turn, maxTurns: this.maxTurns, progressText, elapsedMs: this.elapsedMs() });
  }
```

Add `progressText?: string;` to `RepoSearchProgressEvent` in `src/repo-search/types.ts` (after `answerText`, line 28).

- [ ] **Step 6: Advertise the action — neutral line only.** In `src/repo-search/prompts.ts` add the identical line to both action lists — after the repo-search `Finish:` line (line 224) and after the repo-agent finish line (line 289):

```ts
    'Progress note (non-terminal): {"action":"progress","output":"<one-line status>"} — records a status line; the run continues with your next action.',
```

No other prompt text changes.

- [ ] **Step 7: Failing E2E through the real engine** — create `tests/progress-action.e2e.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import { ProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { withTestEnvAndServer } from './_test-helpers.js';

class CollectingProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  readonly events: RepoSearchProgressEvent[] = [];

  get enabled(): boolean {
    return true;
  }

  write(event: RepoSearchProgressEvent): void {
    this.events.push(event);
  }
}

test('a progress action emits a progress_update event and the run continues to finish', async () => {
  await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
    const progressWriter = new CollectingProgressWriter();
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      prompt: 'find build scripts',
      repoRoot,
      maxTurns: 3,
      progressWriter,
      mockResponses: [
        '{"action":"progress","output":"scanning scripts next"}',
        '{"action":"git","command":"git status --short"}',
        '{"action":"finish","output":"Found scripts"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '' },
      },
    });

    assert.equal(result.scorecard.verdict, 'pass');
    const progressEvents = progressWriter.events.filter((event) => event.kind === 'progress_update');
    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0]?.progressText, 'scanning scripts next');
    assert.equal(progressEvents[0]?.turn, 1);
  });
});
```

(If `ProgressWriter` is abstract with a different member set, mirror the `SilentProgressWriter` subclass shape in `src/lib/progress-writer.ts`.)

- [ ] **Step 8: Verify green**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js agent-loop; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js progress-action.e2e; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck`
Expected: PASS. Also confirm the transcript ack: the E2E run's turn 2 mock (`git`) executes, proving the loop continued after progress.

- [ ] **Step 9: Commit** (primary agent, after diff review)

```powershell
git add src/agent-loop/agent-loop.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/progress-reporter.ts src/repo-search/types.ts src/repo-search/prompts.ts tests/agent-loop.test.ts tests/progress-action.e2e.test.ts
git commit -m "feat(repo-search): handle progress actions in the task loop"
```

**Acceptance criteria:** progress action → `progress_update` event with `progressText`, transcript gains assistant replay + ack user message, `finishVerification.recordNonFinishAction()` is called (a challenged finish followed by progress re-arms the gate), run continues; both prompts contain exactly one new line each; all listed suites + typecheck pass.

---

### Task 3: Event surfaces — CLI line, server console line, chat SSE frame

**Files:**
- Modify: `src/cli/progress-renderer.ts:38-73`
- Modify: `src/status-server/dashboard-runs.ts:186`, `:192-232`
- Modify: `packages/contracts/src/chat.ts` (after line 75)
- Modify: `src/status-server/routes/chat.ts:320-349` (`ChatStreamProgressWriter.write`)
- Test: existing renderer/server suites (find with `node ./dist/test-runner/run-tests.js --list` or the test file matching `progress-renderer` / `dashboard-runs`; if none exists for the renderer, add cases to `tests/progress-action.e2e.test.ts`'s file as unit tests importing the two builders)

- [ ] **Step 1: Failing unit tests** — append to `tests/progress-action.e2e.test.ts` (the three `import` lines join the import block at the top of the file):

```ts
import { CliProgressRenderer } from '../src/cli/progress-renderer.js';
import { buildRepoSearchProgressLogBody, isServerLoggedProgressEvent } from '../src/status-server/dashboard-runs.js';
import { Writable } from 'node:stream';

test('cli renderer prints one line per progress_update', () => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback): void {
      lines.push(String(chunk));
      callback();
    },
  });
  const renderer = new CliProgressRenderer(sink, 'rs test');

  renderer.render({ kind: 'progress_update', turn: 12, maxTurns: 100, progressText: 'GREEN: wiring render', elapsedMs: 1000 });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /t12\/100 progress "GREEN: wiring render"/u);
});

test('server log body renders progress_update with turn and text', () => {
  const event = { kind: 'progress_update', turn: 12, maxTurns: 100, progressText: 'GREEN: wiring render', elapsedMs: 61_000 };
  assert.equal(isServerLoggedProgressEvent(event), true);
  const body = buildRepoSearchProgressLogBody(event);
  assert.equal(body?.event, 'progress');
  assert.match(body?.fields ?? '', /t12\/100 {2}elapsed=/u);
  assert.match(body?.fields ?? '', /"GREEN: wiring render"/u);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js progress-action.e2e`
Expected: FAIL — CLI falls to the generic `tN/M progress_update` fallback; server body builder returns the `command`-less `null`.

- [ ] **Step 3: CLI renderer branch** — in `src/cli/progress-renderer.ts` `describe()`, after the `tool_result` branch (line 57):

```ts
    if (kind === 'progress_update') {
      return `${turnPrefix}progress "${reader.optionalString('progressText') || ''}"`.trim();
    }
```

- [ ] **Step 4: Server console line** — in `src/status-server/dashboard-runs.ts`: add `'progress_update'` to `SERVER_LOGGED_PROGRESS_KINDS` (line 186). In `buildRepoSearchProgressLogBody`, after the `approval_auto` branch (line 222):

```ts
  if (kind === 'progress_update') {
    const text = normalizeRepoSearchCommandForLog(event?.progressText);
    return {
      event: 'progress',
      fields: `${turnLabel}  elapsed=${formatElapsed(elapsedMs)}  "${text}"`,
      severity: 'normal',
    };
  }
```

- [ ] **Step 5: Contracts frame** — in `packages/contracts/src/chat.ts` after `ChatStreamTextDelta` (line 75):

```ts
export const ChatStreamProgressSchema = z.object({
  turn: z.number().int().nonnegative(),
  text: z.string().min(1),
  elapsedMs: z.number().nonnegative(),
});
export type ChatStreamProgress = z.infer<typeof ChatStreamProgressSchema>;
```

- [ ] **Step 6: Forward on the chat SSE** — in `src/status-server/routes/chat.ts` `ChatStreamProgressWriter.write`, after the `context_warning` branch (line 342-346):

```ts
    if (event.kind === 'progress_update') {
      this.flushPending();
      this.writer.writeEvent('progress', {
        turn: requireProgressTurn(event),
        text: event.progressText || '',
        elapsedMs: Number(event.elapsedMs ?? 0),
      });
      return;
    }
```

- [ ] **Step 7: Verify green**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js progress-action.e2e; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit** (primary agent, after diff review)

```powershell
git add src/cli/progress-renderer.ts src/status-server/dashboard-runs.ts packages/contracts/src/chat.ts src/status-server/routes/chat.ts tests/progress-action.e2e.test.ts
git commit -m "feat(progress): render progress updates on cli, server log, and chat stream"
```

**Acceptance criteria:** CLI line `tN/M progress "<text>"`; server console line `progress  tN/M  elapsed=…  "<text>"`; SSE emits a zod-validated `progress` frame; typecheck passes.

---

### Task 4: Dashboard status bar (Option A, wrapping)

**Files:**
- Modify: `dashboard/src/lib/chat-stream-parser.ts` (frame union at line 18, switch at line 65)
- Modify: `dashboard/src/lib/chat-stream-transitions.ts:20-23`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts:40-51`, `:97-167`
- Modify: `dashboard/src/lib/chatTurns.ts` (message routing), the dashboard `ChatMessage` kind union (declared in `dashboard/src/types.ts` — confirm via the import at `dashboard/src/lib/live-thinking-message.ts:3`)
- Modify: `dashboard/src/tabs/ChatTab.tsx:810-825`
- Modify: `dashboard/src/styles/chat.css:35`
- Test: `dashboard/tests/lib/chatTurns.test.ts`, `dashboard/tests/chat-tab.test.tsx`, `dashboard/tests/chat-session-runtime-store.test.ts`

Data model: one live message with fixed id `'live-progress'`, new kind `'assistant_progress'`, upserted (replaced in place) per event — same pattern as `'live-answer'` (`chat-session-runtime-store.ts:85-95`). `chatTurns` routes it to a dedicated `turn.progress` slot (never `steps`, never the live thinking stack, never `main`). Cleared automatically because `done`/`failure` reset `liveMessages`.

- [ ] **Step 1: Failing store/turns tests** — in `dashboard/tests/chat-session-runtime-store.test.ts` add (the file already has a store/transition harness — reuse its store construction; the assertions below are the contract):

```ts
test('progress transitions upsert a single live-progress message in place', () => {
  const first = applyTransition(createChatSessionRuntime('s1'), {
    kind: 'progress', sessionId: 's1', progress: { turn: 3, text: 'RED done', elapsedMs: 1_000 },
  });
  const second = applyTransition(first, {
    kind: 'progress', sessionId: 's1', progress: { turn: 5, text: 'GREEN wiring', elapsedMs: 2_000 },
  });

  const progressMessages = second.liveMessages.filter((message) => message.id === 'live-progress');
  assert.equal(progressMessages.length, 1);
  assert.equal(progressMessages[0]?.kind, 'assistant_progress');
  assert.equal(progressMessages[0]?.content, 'GREEN wiring');
});
```

(`applyTransition`/`createChatSessionRuntime` are module-internal today; if the existing tests in this file drive the public `ChatSessionRuntimeStore` instead, express the same two-events-one-message assertion through that store API exactly as the neighbouring `thinking` test does.) In `dashboard/tests/lib/chatTurns.test.ts`, using the file's existing `message()` fixture helper (line 8-25) and `groupMessagesIntoTurns(messages, liveIds)`:

```ts
test('an assistant_progress message lands on turn.progress, not steps/stack/main', () => {
  const liveIds = new Set(['t1', 't2', 't3', 'live-progress']);
  const messages = [
    message({ id: 't1', kind: 'assistant_thinking' }),
    message({ id: 't2', kind: 'assistant_thinking' }),
    message({ id: 't3', kind: 'assistant_thinking' }),
    message({ id: 'live-progress', kind: 'assistant_progress', content: 'GREEN wiring' }),
  ];

  const turns = groupMessagesIntoTurns(messages, liveIds);

  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.isLive, true);
  assert.equal(turns[0]?.progress?.id, 'live-progress');
  assert.deepEqual(turns[0]?.liveThinking.map((m) => m.id), ['t1', 't2', 't3']);
  assert.equal(turns[0]?.steps.includes(turns[0]?.progress), false);
  assert.equal(turns[0]?.main, undefined);
});
```

(If `turn.main` is `null` rather than `undefined` for a mainless live turn, match the existing convention in `chatTurns.ts` — the point is: progress is not main.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js chat-session-runtime-store; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js chatTurns`
Expected: FAIL (unknown kind / missing transition).

- [ ] **Step 3: Wire the frame through** —
  - `chat-stream-parser.ts`: add `| { kind: 'progress'; progress: ChatStreamProgress }` to the parsed-frame union (line 18) and a `case 'progress':` in the switch (line 65) that `ChatStreamProgressSchema.safeParse`s the payload (import from `@siftkit/contracts`), returning `null` on failure like the `thinking` case.
  - `chat-stream-transitions.ts`: forward it — `yield { kind: 'progress', sessionId, progress: event.progress };` alongside the `thinking` forwarding (line 20-23).
  - `chat-session-runtime-store.ts`: add `| { kind: 'progress'; sessionId: string; progress: ChatStreamProgress }` to `ChatSessionRuntimeTransition` (line 40-51) and a `case 'progress':` in `applyTransition`:

```ts
    case 'progress': {
      const progressMessage = createLiveMessage('live-progress', 'assistant_progress', 'assistant', transition.progress.text);
      return {
        ...runtime,
        awaitingResponse: false,
        liveMessages: upsertLiveMessageInto(runtime.liveMessages, progressMessage),
      };
    }
```

  - Extend the dashboard `ChatMessage` `kind` union with `'assistant_progress'` where it is declared.

- [ ] **Step 4: Route in `chatTurns.ts`** — add a `progress` slot to the turn type and route `kind === 'assistant_progress'` messages to it (exclude them from the step/stack/main partition at lines 51-81). Settled turns never contain the kind (live-only), so no settled-path change.

- [ ] **Step 5: Render the bar** — in `ChatTab.tsx` between the live thinking stack (line 818-822) and `turn.main` (line 823):

```tsx
      {turn.progress ? (
        <div className="turn-progress-bar" role="status">
          <span className="turn-progress-dot" aria-hidden="true" />
          <span className="turn-progress-label">Progress</span>
          <span className="turn-progress-text">{turn.progress.content}</span>
          <span className="turn-progress-meta">{formatDate(turn.progress.createdAtUtc)}</span>
        </div>
      ) : null}
```

- [ ] **Step 6: CSS — wrap, never clip** — append to `dashboard/src/styles/chat.css` near the live-thinking rules (line 35):

```css
.turn-progress-bar {
  margin-top: 10px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  border: 1px solid var(--line); border-left: 3px solid var(--acc); border-radius: 8px;
  padding: 6px 10px; font-size: 0.76rem;
}
.turn-progress-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--run); flex: none; align-self: center; animation: pulse 1.6s ease-in-out infinite; }
.turn-progress-label { font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--acc); flex: none; }
.turn-progress-text { flex: 1 1 100%; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.turn-progress-meta { margin-left: auto; flex: none; font-family: ui-monospace, Consolas, monospace; font-size: 0.64rem; color: var(--dim); }
```

(`flex: 1 1 100%` + `overflow-wrap: anywhere` + `white-space: pre-wrap` is the no-clip requirement: long text wraps onto additional lines and the bar grows.)

- [ ] **Step 7: Pin the placement in the component test** — extend `dashboard/tests/chat-tab.test.tsx` (mirror the existing live-thinking placement test from commit `058df14d`): a live turn with 3 thinking messages + a progress message renders `.turn-progress-bar` **after** `.live-thinking-stack` and **before** the main message; a second progress event replaces the text (single bar).

- [ ] **Step 8: Verify green**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js chat-session-runtime-store; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js chatTurns; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js chat-tab; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit** (primary agent, after diff review)

```powershell
git add dashboard/src dashboard/tests
git commit -m "feat(dashboard): render live progress updates as a persistent status bar"
```

**Acceptance criteria:** ordering Internal Logic → thinking stack → progress bar → main; one bar, replaced in place; long text wraps fully; bar gone once the turn settles; all dashboard suites + typecheck pass.

---

### Task 5: Count what you send (reasoning_content in preflight)

**Files:**
- Modify: `src/repo-search/planner-protocol.ts:534-546` (extract keep-condition helper), `:922-943` (`renderTaskTranscript`)
- Modify: `src/repo-search/engine/transcript-manager.ts:50-56`
- Modify: `src/repo-search/prompt-budget.ts:106-186`
- Modify: `src/repo-search/engine/prompt-preparer.ts:58-122`, `:142-188`
- Test: `tests/engine-prompt-preparer.test.ts`

Principle: the counted text must include `reasoning_content` **exactly when serialization keeps it** — one shared predicate, no parallel logic. The change is a complete migration: `renderTaskTranscript` and `TranscriptManager.render`/`renderTail` gain a **required** reasoning flag so every caller decides explicitly and missed call sites fail the build.

- [ ] **Step 1: Failing counting tests** — in `tests/engine-prompt-preparer.test.ts` add (reusing `makePreparer` with a thinking-flag parameter — extend the helper to accept `thinking` and pass it through):

```ts
const WITH_PRESERVED_THINKING = { thinkingEnabled: true, reasoningContentEnabled: true, preserveThinking: true };

test('preflight counts preserved reasoning_content toward the prompt', async () => {
  const reasoning = 'R'.repeat(8_000);
  const makeTranscript = () => new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'assistant', content: 'step done', reasoning_content: reasoning }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });

  const withReasoning = makePreparer(new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45, config: null }), makeTranscript(), ['SUMMARY BODY'], [], WITH_PRESERVED_THINKING);
  const withoutReasoning = makePreparer(new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45, config: null }), makeTranscript(), ['SUMMARY BODY'], [], NO_THINKING);

  const counted = await withReasoning.prepareTurn(1, 0);
  const uncounted = await withoutReasoning.prepareTurn(1, 0);

  // ~8k chars of reasoning ≈ 2k estimated tokens; require a decisive gap.
  assert.ok(counted.promptTokenCount > uncounted.promptTokenCount + 1_000);
});

test('preserved reasoning mass triggers compaction that plain content would not', async () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'assistant', content: 'short', reasoning_content: 'R'.repeat(14_000) }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45, config: null }), transcript, ['SUMMARY BODY'], events, WITH_PRESERVED_THINKING);

  const prepared = await preparer.prepareTurn(1, 0);

  assert.equal(prepared.compactionSummary, 'SUMMARY BODY');
  assert.ok(events.some((event) => event.kind === 'turn_preflight_compaction_applied'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js engine-prompt-preparer`
Expected: FAIL — counts are equal / no compaction (reasoning invisible to the counter).

- [ ] **Step 3: Shared predicate** — in `src/repo-search/planner-protocol.ts`, extract the keep-condition from `serializePlannerMessage` (lines 534-546) and reuse it in both places:

```ts
export function plannerMessageKeepsReasoningContent(message: ChatMessage, reasoningContentEnabled: boolean): boolean {
  return reasoningContentEnabled
    && message.role === 'assistant'
    && typeof message.reasoning_content === 'string'
    && message.reasoning_content.trim().length > 0;
}
```

`serializePlannerMessage` becomes:

```ts
function serializePlannerMessage(message: ChatMessage, reasoningContentEnabled: boolean): ChatMessage {
  if (plannerMessageKeepsReasoningContent(message, reasoningContentEnabled)) {
    return message;
  }
  if (!Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) return message;
  const { reasoning_content: _reasoningContent, ...rest } = message;
  return rest;
}
```

- [ ] **Step 4: Reasoning-aware render** — change `renderTaskTranscript` (line 922) to a required-options signature and include a reasoning section per kept message:

```ts
export function renderTaskTranscript(
  messages: ChatMessage[],
  options: { includeReasoningContent: boolean },
): string {
  return messages.map((message) => {
    const sections = [`[${String(message.role || 'unknown')}]`];
    if (options.includeReasoningContent && plannerMessageKeepsReasoningContent(message, true)) {
      sections.push(`[reasoning]\n${String(message.reasoning_content)}`);
    }
    // …existing content/tool_calls/tool_call_id sections unchanged…
    return sections.join('\n');
  }).join('\n\n');
}
```

Update **every** caller explicitly (the build enumerates them): `TranscriptManager.render`/`renderTail` (see step 5), `preflightPlannerPromptBudget`'s messages path (`prompt-budget.ts:120-122` — thread a new required `includeReasoningContent: boolean` option through `preflightPlannerPromptBudget` and pass it here), and any display/synthesis callers (terminal synthesizer tail, compactor summarization input) which pass `{ includeReasoningContent: false }` — display and summarization semantics are unchanged.

- [ ] **Step 5: TranscriptManager** — `render`/`renderTail` take the flag (required):

```ts
  render(includeReasoningContent: boolean): string {
    return renderTaskTranscript(this.messages, { includeReasoningContent });
  }

  renderTail(skipCount: number): string {
    return renderTaskTranscript(this.messages.slice(skipCount), { includeReasoningContent: false });
  }
```

- [ ] **Step 6: PromptPreparer counts the send-shape** — in `prepareTurn` (both the initial render at line 69 and the post-compaction render at line 147): `let prompt = transcript.render(this.options.thinking.reasoningContentEnabled);`. Add the visibility field to the `turn_preflight_budget` log (line 108-122) and the compaction log (line 172-186):

```ts
      reasoningTokenEstimate: estimateReasoningTokens(this.options.config, transcript.getMessages(), this.options.thinking.reasoningContentEnabled),
```

with a small helper in `prompt-preparer.ts` (character-estimate only — no extra tokenize round-trip):

```ts
function estimateReasoningTokens(config: SiftConfig, messages: readonly ChatMessage[], reasoningContentEnabled: boolean): number {
  let tokens = 0;
  for (const message of messages) {
    if (plannerMessageKeepsReasoningContent(message, reasoningContentEnabled)) {
      tokens += estimateTokenCount(config, String(message.reasoning_content));
    }
  }
  return tokens;
}
```

(Match `estimateTokenCount`'s exact signature in `src/lib/token-estimate.ts`.) Incremental counting stays valid: appends keep the prefix property; thinking-pruning rewrites break the prefix and `IncrementalTokenCounter` already falls back to a full recount (`src/repo-search/incremental-token-counter.ts:43`).

- [ ] **Step 7: Verify green + no regressions**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js engine-prompt-preparer; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js engine-transcript-compactor; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js engine-terminal-synthesizer; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit** (primary agent, after diff review)

```powershell
git add src/repo-search/planner-protocol.ts src/repo-search/engine/transcript-manager.ts src/repo-search/prompt-budget.ts src/repo-search/engine/prompt-preparer.ts tests/engine-prompt-preparer.test.ts
git commit -m "fix(repo-search): count preserved reasoning_content in prompt preflight"
```

**Acceptance criteria:** preflight `promptTokenCount` includes kept reasoning; compaction fires on reasoning mass alone; `turn_preflight_budget` logs `reasoningTokenEstimate`; display renders (`renderTail`, synthesizer, compactor) unchanged; no caller of the old signature remains (build proves it); listed suites + typecheck pass.

---

### Task 6: Prompt-drift check (predicted vs server-reported) — REVERTED

Shipped as `b31e97be`; removed in full on 2026-08-21 by
`docs/superpowers/plans/2026-08-21-remove-prompt-drift-warning.md`. The check warned on every turn
because the predicted count included `providerPromptReserveTokenCount`, a request-envelope pad that
never enters the prompt and by itself exceeded the 1,024-token threshold. The steps have been deleted
so they cannot be mistaken for work to do; `git show b31e97be` has the original implementation.

---

### Task 7: CLI shim shebang + invocation note

**Files:**
- Modify: `scripts/sync-dist-runtime.ts:33-53`
- Modify: `src/cli/help.ts` (top-level usage text)
- Modify: `README.md` (installation/usage section)
- Test: Create `tests/sync-dist-runtime-shebang.test.ts`

- [ ] **Step 1: Failing test** — `tests/sync-dist-runtime-shebang.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureCliShebang } from '../scripts/sync-dist-runtime.ts';

test('ensureCliShebang prepends the node shebang exactly once', () => {
  const distRoot = mkdtempSync(join(tmpdir(), 'siftkit-shebang-'));
  mkdirSync(join(distRoot, 'cli'), { recursive: true });
  const mainPath = join(distRoot, 'cli', 'main.js');
  writeFileSync(mainPath, "import { runCli } from './dispatch.js';\n", 'utf8');

  ensureCliShebang(distRoot);
  ensureCliShebang(distRoot);

  const content = readFileSync(mainPath, 'utf8');
  assert.equal(content.startsWith('#!/usr/bin/env node\n'), true);
  assert.equal(content.indexOf('#!/usr/bin/env node', 1), -1);
});
```

(If the test-runner cannot import `scripts/*.ts`, check `tsconfig.scripts.json` inclusion; `scripts/sync-dist-runtime.ts` already exports functions for reuse, and `npm run typecheck` covers the scripts project.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js sync-dist-runtime-shebang`
Expected: FAIL — `ensureCliShebang` not exported.

- [ ] **Step 3: Implement** — in `scripts/sync-dist-runtime.ts` (imports already include `readFileSync`? if not, add it):

```ts
const CLI_SHEBANG = '#!/usr/bin/env node\n';

/** npm's sh-shim executes dist/cli/main.js directly; without a shebang, sh parses ESM as shell. */
export function ensureCliShebang(distRoot: string): void {
  const mainPath = join(distRoot, 'cli', 'main.js');
  if (!existsSync(mainPath)) {
    throw new Error(`Expected CLI entry point at ${mainPath}; build layout changed.`);
  }
  const content = readFileSync(mainPath, 'utf8');
  if (content.startsWith(CLI_SHEBANG)) {
    return;
  }
  writeFileSync(mainPath, `${CLI_SHEBANG}${content}`, 'utf8');
}
```

Call it in `main()` after `writeRuntimePackageMarkers(distRoot);` (line 52): `ensureCliShebang(distRoot);`

- [ ] **Step 4: Invocation note** — add one line to the top of the CLI help text in `src/cli/help.ts` and a short subsection to `README.md`:

> On Windows, invoke `siftkit` from PowerShell or cmd. Git Bash works once the CLI is built with its shebang (v-next), but embedded double quotes in task prompts are mangled by shell argv splitting on every Windows shell — avoid embedded `"` in prompts.

- [ ] **Step 5: Verify green + real-world check**

Run: `npm run build:test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node ./dist/test-runner/run-tests.js sync-dist-runtime-shebang; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run typecheck`
Then from Git Bash: `bash -lc 'head -1 dist/cli/main.js'` → `#!/usr/bin/env node`, and `bash -lc './node_modules/.bin/siftkit --help'` (or the globally installed shim) → help text, exit 0.
Expected: PASS.

- [ ] **Step 6: Commit** (primary agent, after diff review)

```powershell
git add scripts/sync-dist-runtime.ts src/cli/help.ts README.md tests/sync-dist-runtime-shebang.test.ts
git commit -m "fix(cli): prepend node shebang to dist entry so the sh shim works"
```

**Acceptance criteria:** built `dist/cli/main.js` starts with the shebang (idempotent); missing entry point fails the build loudly; Git Bash invocation exits 0; help/README carry the note; suite + typecheck pass.

---

### Task 8: Live compaction validation (one-off) + full verification

**Files:**
- Create (temporary, delete at completion): `C:\tmp\siftkit-scratch\compaction-live-check.ts`
- No permanent source changes.

This is the user-requested **one real test** against the running tabby/exl3 backend with the active preset. Run it manually with the model server up; it is not part of the committed suite.

- [ ] **Step 1: Build first** — `npm run build` so `dist/` reflects Tasks 5-6. The script imports from `dist` with absolute file URLs; `REPO` below is `C:/Users/denys/Documents/GitHub/SiftKit`.

- [ ] **Step 2: Write the script** — `C:\tmp\siftkit-scratch\compaction-live-check.ts`:

```ts
// One-off live check: preserved reasoning must be counted, compaction must fire
// before the server 400s. Run: node --experimental-strip-types compaction-live-check.ts
const REPO = 'C:/Users/denys/Documents/GitHub/SiftKit';
const { TranscriptManager } = await import(`file://${REPO}/dist/repo-search/engine/transcript-manager.js`);
const { TurnBudget } = await import(`file://${REPO}/dist/repo-search/engine/turn-budget.js`);
const { preflightPlannerPromptBudget } = await import(`file://${REPO}/dist/repo-search/prompt-budget.js`);
const { resolvePlannerThinkingFlags } = await import(`file://${REPO}/dist/repo-search/engine/task-loop-support.js`);
const { getConfiguredLlamaNumCtx } = await import(`file://${REPO}/dist/config/index.js`);
const { loadConfig } = await import(`file://${REPO}/dist/config/config-service.js`);

const config = await loadConfig();
const flags = resolvePlannerThinkingFlags(config);
const numCtx = getConfiguredLlamaNumCtx(config);
const budget = new TurnBudget({ totalContextTokens: numCtx, maxTurns: 45, config });

// A transcript whose visible content fits the budget but whose preserved
// reasoning pushes the true prompt over it — the exact 14:20:52 failure shape.
const history = Array.from({ length: 40 }, (_, index) => ({
  role: 'assistant' as const,
  content: `step ${index}: ${'c'.repeat(2_000)}`,
  reasoning_content: 'r'.repeat(6_000),
}));
const transcript = new TranscriptManager({
  systemPromptContent: 'SYSTEM',
  historyMessages: history,
  initialUserContent: 'question',
  initialUserImages: [],
  liveImagePathKeys: new Set<string>(),
});

const counted = await preflightPlannerPromptBudget({
  config,
  prompt: transcript.render(flags.reasoningContentEnabled),
  totalContextTokens: budget.totalContextTokens,
  responseReserveTokens: budget.responseReserveTokens,
});
const displayOnly = await preflightPlannerPromptBudget({
  config,
  prompt: transcript.render(false),
  totalContextTokens: budget.totalContextTokens,
  responseReserveTokens: budget.responseReserveTokens,
});

console.log(JSON.stringify({
  numCtx,
  countedPromptTokens: counted.promptTokenCount,
  displayOnlyPromptTokens: displayOnly.promptTokenCount,
  reasoningDelta: counted.promptTokenCount - displayOnly.promptTokenCount,
  wouldCompact: !counted.ok,
  tokenCountSource: counted.tokenCountSource,
}, null, 2));

if (counted.tokenCountSource === 'estimate') throw new Error('server tokenizer unreachable — result not real');
if (counted.promptTokenCount - displayOnly.promptTokenCount < 10_000) throw new Error('reasoning not counted');
```

- [ ] **Step 3: Run it live** — with the model server running: `npm run build`, then `node --experimental-strip-types C:\tmp\siftkit-scratch\compaction-live-check.ts`.
Expected: `tokenCountSource` is `exl3` (real tokenizer), `reasoningDelta` ≥ ~10k (40 × 6k chars of reasoning counted), and `wouldCompact` true when the counted total exceeds the budget — proving compaction now keys off the true send size for the **current preset**.

- [ ] **Step 4: End-to-end drift sanity** — *removed; see the revert note on Task 6. No drift record is emitted any more, so there is nothing to grep for.*

- [ ] **Step 5: Full verification + cleanup**

Run: `npm run typecheck; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test`
Expected: PASS (full suite). Then delete `C:\tmp\siftkit-scratch\` and confirm `git status` shows no stray artifacts.

**Acceptance criteria:** live script proves real-tokenizer counting of reasoning and correct compaction trigger under the active preset; full suite, typecheck, lint green; scratch dir removed.

---

## Risks

- **Prompt-prefix cache churn:** the ack user message per progress note grows the transcript slightly; negligible next to tool results.
- **Model may ignore or overuse `progress`:** deliberately unmitigated — the design decision is to observe whether mere availability stops finish-abuse. Turn limits bound overuse.
- **`renderTaskTranscript` signature change** touches display call sites; the required-flag migration makes misses a compile error, but reviewers should eyeball synthesizer/compactor output in one run.
- **Drift check depends on TabbyAPI returning `usage.prompt_tokens`** on streams; if absent, drift silently reports nothing per turn (by design `null` → no record) — Task 8 step 4 verifies it is actually present.
