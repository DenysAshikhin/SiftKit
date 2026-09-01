# Backend `eos_reason` capture, then removal of SiftKit's streaming runaway detector

**Goal:** Make SiftKit observe the exl3 backend's generation-stop signal (`eos_reason`), then delete
SiftKit's own model-output repetition detector, which duplicates exllamav3's built-in `stop_on_loop`.

**Background (verified 2026-09-01):**
- exllamav3 `1.4.4+unified.1` (`D:\personal\models\elx3\benchmark_tools\exllamav3-dev-qbench`, git `280ac42`)
  has a built-in `LoopDetector` (`exllamav3/generator/loop_detect.py`) wired through
  `ExLlamaV3Job(stop_on_loop=...)` (`generator/job.py:66,136,307`). It has **no DRY sampler**.
- TabbyAPI enables it by default: `loop_detect_window` defaults to `800`, mapping to
  `stop_on_loop = (800, 2)` (`common/sampling.py:294-307`), passed at
  `backends/exllamav3/model.py:1602`. On trigger the job ends with `eos_reason == "loop_detected"`
  (`backends/exllamav3/model.py:1344`).
- Wire shape: `eos_reason` is a field on the **choice** object, emitted only on the final chunk and
  only when `finish_reason` is also set
  (`endpoints/OAI/utils/chat_completion.py:203-204`; `endpoints/OAI/types/chat_completion.py:49,61`).
  Observed values: `max_new_tokens`, `stop_token`, `stop_string`, `loop_detected`.
- SiftKit currently reads **no** stop signal from the backend: `choices[].finish_reason` is never
  read, and the normalized response sets `raw: {}` (`src/llm-protocol/llama-cpp-client.ts:447-481,558`).
  A loop-terminated generation is today indistinguishable from a normal completion.

**Ordering is load-bearing.** Task 3 removes SiftKit's only loop signal. It must not land before
Tasks 1-2 make the backend's signal observable, or loop-stops become silent.

**Out of scope — do not touch:**
- `src/repo-search/repetition-guard.ts` and `applyToolOutputRepetitionGuard`
  (`src/repo-search/engine/task-loop-support.ts:86-99`, called at
  `src/repo-search/engine/tool-action-processor.ts:936`). This guards **tool result text**, which the
  backend never sees. Not redundant.
- Duplicate tool-call detection: `src/tool-loop-governor.ts`,
  `src/repo-search/engine/duplicate-tracker.ts`, `src/repo-search/engine/forced-finish.ts`,
  `src/summary/planner/mode.ts`. Operates on agent actions, not tokens. Not redundant.
- The thinking-budget early stop (`THINKING_BUDGET_EARLY_STOP_REASON`,
  `src/llm-protocol/llama-cpp-client.ts:144,248,268-310,459`) and the `earlyStopReason` /
  `stoppedEarly` mechanism itself. Task 3 removes only the *runaway* producers of `earlyStopReason`.

---

## Task 1: Capture `eos_reason` from the backend stream

**Files:** `src/llm-protocol/types.ts`, `src/llm-protocol/llama-cpp-client.ts`

**Steps (TDD):**
1. Write a failing test in `tests/llm-protocol-streaming.test.ts` that feeds an SSE stream whose
   final frame carries `choices[0].finish_reason = "stop"` and `choices[0].eos_reason = "loop_detected"`,
   and asserts the normalized response exposes `backendEosReason === 'loop_detected'`.
   Add a second case asserting `backendEosReason` is absent when no frame carries `eos_reason`.
2. Add to `NormalizedLlamaCppChatResponse` (`src/llm-protocol/types.ts:107-118`):
   ```ts
   /** Backend-reported generation stop reason (TabbyAPI/exl3 `choices[].eos_reason`). */
   backendEosReason?: string;
   ```
3. In `streamChatAtBaseUrl` (`src/llm-protocol/llama-cpp-client.ts`):
   - Declare `let backendEosReason: string | null = null;` alongside `earlyStopReason` (~line 373).
   - After the existing `const choice = isRecord(firstChoice) ? firstChoice : undefined;` (~line 448),
     capture the last non-empty value:
     ```ts
     const frameEosReason = getString(choice?.eos_reason);
     if (frameEosReason) backendEosReason = frameEosReason;
     ```
   - In the returned object (~line 558-561), add
     `...(backendEosReason ? { backendEosReason } : {}),`

**Acceptance criteria:**
- Both new tests pass; no existing test changes behavior.
- `backendEosReason` is only present when the backend sent one.
- No `any`, no type assertions, no non-null assertions. `choice?.eos_reason` flows through the
  existing `getString(value: OptionalJsonValue)` helper.

---

## Task 2: Surface `eos_reason` to the planner and the run log

**Files:** `src/repo-search/planner-protocol.ts`

**Steps (TDD):**
1. Write a failing test (`tests/repo-search-planner-protocol.test.ts`) asserting that when the client
   returns `backendEosReason: 'loop_detected'`, the resulting `PlannerActionResponse.rawText` is
   prefixed with a notice naming the backend loop stop, and `backendEosReason` is carried on the
   response. Add a case asserting a non-loop `backendEosReason` (e.g. `stop_token`) adds **no**
   prefix but is still carried.
2. Add `backendEosReason?: string;` to `PlannerActionResponse` (`src/repo-search/planner-protocol.ts:31-48`).
3. Add the field to the `provider_request_done` log event (~line 597), beside `earlyTerminationReason`:
   `...(response.backendEosReason ? { backendEosReason: response.backendEosReason } : {}),`
4. Replace the single-notice `effectiveRawText` construction (~lines 605-607) with a notice list, so
   a backend loop stop is visible to the planner the same way a SiftKit early stop is:
   ```ts
   const streamNotices = [
     response.stoppedEarly && response.earlyStopReason
       ? `SiftKit stopped the planner stream early: ${response.earlyStopReason}.`
       : null,
     response.backendEosReason === 'loop_detected'
       ? 'The inference backend stopped this generation early: repetition loop detected.'
       : null,
   ].filter((notice): notice is string => notice !== null);
   const effectiveRawText = streamNotices.length > 0
     ? [...streamNotices, rawChoiceText.trim()].filter(Boolean).join('\n')
     : rawChoiceText;
   ```
5. Carry the field on the returned object beside `thinkingBudgetExhausted` (~line 630):
   `...(response.backendEosReason ? { backendEosReason: response.backendEosReason } : {}),`

**Acceptance criteria:**
- New tests pass. Existing early-stop prefix behavior is byte-identical when `backendEosReason` is absent.
- A `loop_detected` stop produces a visible notice in `rawText`; other `eos_reason` values do not.
- Type predicate used for the filter — no assertions.

---

## Task 3: Remove SiftKit's streaming runaway detector

Only after Tasks 1-2 are green.

**File:** `src/llm-protocol/llama-cpp-client.ts` (+ affected tests)

**Steps:**
1. Delete, as a complete removal (no flag, no shim, no parallel path):
   - `getRunawayStructuralTail` (~lines 593-606)
   - `getRecentTokenRepetition` (~lines 608-631)
   - `RUNAWAY_CHECK_INTERVAL_CHARS` and its doc comment (~lines 582-588)
   - the `detectRunaway` closure (~lines 378-389)
   - `let lastRunawayCheckLength = 0;` (~line 374)
   - the throttled in-loop call site (~lines 483-489)
   - the end-of-stream `if (!earlyStopReason) { detectRunaway(); }` (~lines 494-496)
2. Preserve exactly: `earlyStopReason`, `stoppedEarly`, `THINKING_BUDGET_EARLY_STOP_REASON` and its
   `break streamFrames`, the degenerate-stream detection (`no_frames` / `missing_done_sentinel`,
   ~lines 499-511), and `invalidFrameCount`.
3. Remove or rewrite tests that assert runaway truncation. Search `tests/` for `runaway`,
   `getRecentTokenRepetition`, `arg_value`, and the reason strings
   `recent planner content tokens repeated` / `runaway streamed planner content repeated`.
   Tests covering thinking-budget early stop or degenerate streams must keep passing unchanged.

**Acceptance criteria:**
- No occurrence of `runaway`, `RUNAWAY_CHECK_INTERVAL_CHARS`, `getRecentTokenRepetition`, or
  `getRunawayStructuralTail` remains in `src/`.
- `earlyStopReason` is still produced for the thinking-budget path; its test coverage is unchanged.
- Full suite, `npm run typecheck`, and `npm run lint` all green.

---

## Final validation (primary agent)

```
npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."
npm run typecheck
npm run lint
```
