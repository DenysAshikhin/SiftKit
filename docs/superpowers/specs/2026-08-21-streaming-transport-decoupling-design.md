# Streaming Transport Decoupling Design

**Date:** 2026-08-21
**Status:** Approved

## Problem

Repo-search run `82616c85-656c-4474-b8ae-b060852f93db` failed after 8m50s with:

```
Terminal synthesis produced no usable output after 3 attempts
(reason=max_turns, last=provider request failed stage=terminal_synthesis
 error=Request timed out after 120000 ms.)
```

The exl3 server was healthy throughout and served the next task 100ms later. The
failure was entirely client-side.

### Root cause

`stream` is chosen by whether a **progress UI is attached**, and the two transports
have **incompatible timeout semantics and unequal safety guards**. Presentation
decides transport.

`terminal-synthesizer.ts:74` ANDs in a presentation flag that the equivalent normal
path (`task-loop.ts:610`) does not:

```ts
// terminal-synthesizer.ts:74  (fallback path)
stream: this.options.streamFinishAsAnswer && this.options.progress.enabled,
// task-loop.ts:610            (normal path)
stream: this.progress.enabled,
```

`streamFinishAsAnswer` is `taskKind === 'chat'` (`execute.ts:407`) and is otherwise
only a *display* selector (`task-loop.ts:618-628`: render partial finish output as
answer vs. thinking). Using it as a transport flag made repo-search terminal
synthesis non-streaming.

The same 120 000 ms constant then means two different things:

| transport | meaning | anchor | fires? |
|---|---|---|---|
| streaming | idle gap **between SSE frames** | `llama-cpp-client.ts:443-447` | no — frames arrive every ~12 ms |
| non-streaming | **total** wall clock | `llama-cpp-client.ts:303-307` | yes, at 120 s |

Measured throughput for `3.8_27b_4.6bpw` in this run: 72–106 tok/s. 120 s buys
~9 600 tokens; `getDynamicMaxOutputTokens` grants 15 000
(`response-reserve.ts:8`). **Any synthesis longer than ~9 600 tokens could not
complete.** The retry loop reuses an identical prompt and budget with no backoff
(`terminal-synthesizer.ts:36-49`, prompt built once before the loop, passed
unchanged at `:67`), so all three attempts failed identically.

### Evidence

Transcript (`run_logs.repo_search_transcript_jsonl`):

```
17:07:23.104  task_terminal_synthesis_requested  promptTokenCount=42170  maxOutputTokens=15000
17:09:23.109  provider_request_error  stage=terminal_synthesis  elapsedMs=120005
17:11:23.120  provider_request_error  stage=terminal_synthesis  elapsedMs=120010
17:13:23.130  provider_request_error  stage=terminal_synthesis  elapsedMs=120010
```

exl3 engine log, same window (local = UTC-4) — note the wording change and the
absent `Metrics` lines:

```
13:07:22.969  Metrics (98c53e81): 142 tokens in 2.28s        <- turn 45, "streaming request"
13:07:23.109  Received chat completion request 37f4c49b      <- NOT "streaming"
13:09:23.220  ERROR: Request disconnected
13:09:23.223  Received chat completion request c85ac237
13:11:23.228  ERROR: Request disconnected
13:11:23.232  Received chat completion request f2068b86
13:13:23.204  ERROR: Request disconnected
13:13:25.026  Metrics (57d630f7): 96 tokens in 1.73s         <- next task, server fine
```

All 45 planner turns logged `Received chat completion **streaming** request` plus an
immediate `200`. The three synthesis requests logged neither a `200` nor a `Metrics`
line: generation never finished, the client hung up.

## Scope

Six call sites currently run non-streamed:

| caller | anchor | mechanism |
|---|---|---|
| Terminal synthesis | `terminal-synthesizer.ts:74` | the `&&` bug |
| Summary / structured output | `providers/llama-cpp.ts:483` | hardcoded `stream: false` |
| Assistant inference | `assistant/inference/client.ts:96` | hardcoded `stream: false` |
| Approval verdict probe | `planner-protocol.ts:828-850` | no `stream` key, so `=== true` is false at `:650` |
| Context compaction | `planner-protocol.ts:891-922` | same |
| AgentLoop `stream` param | `agent-loop.ts:56` | dead: `agent-loop-adapter.ts:86` never reads it |

### Guards that exist only in the streaming path

Lost today by any non-streamed caller (`streamChatAtBaseUrl`, `:397-570`):

- Runaway detection `detectRunaway` `:421-431`, throttled every
  `RUNAWAY_CHECK_INTERVAL_CHARS = 256` `:636` at `:513-519`, plus once at stream end
  `:524-526`. Detectors: `getRunawayStructuralTail` `:638-651`,
  `getRecentTokenRepetition` `:653-676`.
- Reasoning-budget early stop `:434-440`, `:489-493`, and its continuation
  `continueAfterThinkingBudget` `:332-359`.
- `FirstJsonObjectScanner` reasoning-action recovery `:432`, `:482-488`.
- `stoppedEarly` / `earlyStopReason` reporting `:567-568`.

### Guards that exist only in the NON-streaming path

These would be lost by a naive "always stream" change, so parity work is mandatory:

- zod `RawChatResponseSchema` validation `:303-309`. The streaming path parses frames
  with `parseJsonObjectText` and `continue`s past malformed frames `:452-457` — no
  schema, silent drops.
- `retryProviderRequest` client-level retry `:315-320`. The streaming branch has none.

## Goals

1. Transport is never chosen by presentation.
2. A non-streamed chat response becomes impossible to express, and any attempt fails
   loudly.
3. Streaming reaches parity with the non-streaming path on response validation and
   retry, so nothing is traded away.
4. An output budget and its deadline can never contradict each other.

## Non-goals

- Changing why the run exhausted 45 turns. Non-convergence is the trigger, not the
  defect; the fallback must simply work when it happens.
- Improving synthesis prompt quality or the retry loop's identical-attempt behaviour
  beyond what streaming fixes.
- Server-to-client SSE (`streamed-operation-endpoint.ts` and friends). That is a
  different channel and is out of scope.

## Architecture

### 1. Transport always streams

Remove `stream` from `LlamaCppChatOptions` (`llama-cpp-client.ts:170`). Delete the
non-streaming branch of `chatAtBaseUrl` (`:294-325`) along with `requestOnce`, and
drop the `stream` field from `buildChatRequest` (`:380`) and
`inference-request-builder.ts:46`. `chat()` always streams internally.

Callers keep their existing blocking `await chat(...)` shape: `streamChatAtBaseUrl`
already returns a fully assembled `NormalizedLlamaCppChatResponse`. Callers that want
incremental output pass `onContentDelta` / `onThinkingDelta`; callers that do not,
do not. **Delta callbacks become the only thing presentation controls.**

`stream_options: { include_usage: true }` (`inference-request-builder.ts:47`) becomes
unconditional. Usage now arrives on every request, including summary and assistant
paths that previously read usage from the non-streaming JSON body; those readers must
be verified.

### 2. Presentation flags keep only presentation

- `progress.enabled` / `liveTextEnabled` gate whether delta callbacks are supplied.
- `streamFinishAsAnswer` keeps its sole legitimate job: choosing whether streamed
  finish output renders as answer or as thinking (`task-loop.ts:618-628`,
  `terminal-synthesizer.ts:75`).
- The dead `stream: boolean` on `AgentLoopModelClient.chat` (`agent-loop.ts:13-21`,
  `:56`) and `AgentLoopOptions.stream` (`:26`) are deleted.

### 3. Loud failure, in four layers

1. **Compile time.** With `stream` gone from `LlamaCppChatOptions`, all six call sites
   become type errors. Missed migrations fail loudly, for free.
2. **Degenerate stream.** The client counts frames. A chat response completing with
   zero content frames, or a stream ending without `[DONE]`, throws a named error and
   logs `provider_stream_degenerate`. This catches a proxy or server that buffers
   instead of streaming — the one way a "streaming" request can still behave like a
   blocking one.
3. **Frame level.** Malformed frames are zod-validated rather than silently skipped;
   each failure logs `provider_stream_frame_invalid` with the raw frame text.
4. **Regression guard.** A test asserts no code path sends `requestJsonFull` to
   `/v1/chat/completions`, so the bypass cannot be reintroduced.

### 4. Budget and deadline cannot contradict

Rename `requestTimeoutSeconds` to name what it is: an **idle** timeout between frames.
Add a separate `totalDeadlineMs`.

`totalDeadlineMs` is derived from the output budget and a throughput floor:

```
requiredMs = (maxTokens / MIN_EXPECTED_TOKENS_PER_SECOND) * 1000
```

Request construction throws when `totalDeadlineMs < requiredMs`. The contradiction
that killed this run becomes unexpressible rather than merely unlikely.

`MIN_EXPECTED_TOKENS_PER_SECOND = 20`, deliberately conservative against the 72–106
tok/s observed. At `maxTokens = 15 000` that is a 750 s ceiling: generous, bounded,
and never smaller than what the granted budget legitimately needs.

## Error handling

| condition | behaviour |
|---|---|
| Idle gap exceeds idle timeout | existing timeout error, unchanged |
| Total duration exceeds `totalDeadlineMs` | abort, named error naming budget and deadline |
| Budget cannot fit deadline | throw at request construction |
| Zero frames / no `[DONE]` | throw, log `provider_stream_degenerate` |
| Malformed frame | log `provider_stream_frame_invalid`, continue; surface count in the response |
| Transient HTTP | `retryProviderRequest`, now available on the streaming path |

## Testing

Existing fakes cover the seam. `LlamaCppHttpClient` is
`Pick<typeof httpClient, 'requestJsonFull' | 'streamSse'>` (`:36`), injected at
`:196`.

- `tests/llm-protocol.test.ts:122-147` — `CapturingHttpClient` currently throws from
  `streamSse` ("should not be called by non-streaming tests"). These tests invert:
  the non-streaming assertions become streaming assertions, and `requestJsonFull`
  becomes the forbidden call for chat.
- `tests/llm-protocol-streaming.test.ts:15-39` — `StreamingHttpClient` is the model
  for every migrated test.
- New coverage: degenerate stream (zero frames, missing `[DONE]`), invalid frame
  logging, retry on the streaming path, budget-vs-deadline construction failure, and
  a test asserting terminal synthesis streams regardless of `streamFinishAsAnswer`.
- Migration coverage for each newly-streaming caller: summary
  (`tests/engine-transcript-compactor.test.ts`), approval verdict
  (`tests/approval-verdict-request.test.ts`), assistant inference, compaction.

Validation: `npm run build:test && npm test`, `npm run typecheck`, `npm run lint`.

## Risks

- **Structured output over SSE.** The summary provider
  (`providers/llama-cpp.ts:440`) uses response schemas. Frame reassembly must produce
  byte-identical JSON to the blocking body. Mitigated by layer-3 frame validation and
  by migrating its tests rather than deleting them.
- **Usage accounting.** Streamed usage arrives via `stream_options.include_usage` and
  is summed per frame (`:458-470`) rather than read from one body. Token accounting in
  summary and assistant paths must be re-verified against existing expectations.
- **Retry semantics move.** `retryProviderRequest` wrapping a stream must not replay
  partially-emitted deltas. Retry may only fire before the first frame is delivered.
