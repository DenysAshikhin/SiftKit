# Live Chat Token Counters and Queue Rendering Implementation Plan

## Selected drift fixes — 2026-09-10

Implemented the requested findings #1, #2, #4, #5, and #6:

- Missing live display entries now throw through a shared required lookup; persisted turns explicitly use canonical formatting. The parity test supplies the real live display builder.
- Streaming growth assertions use independent expected lengths (400, 800) and complete badges (`~100 tokens`, `~200 tokens`).
- The gated backend accepts only named routes with their expected methods, returns 404/405 otherwise, and supplies endpoint-specific responses.
- Closing the backend rejects pending/future gates, supports pre-start and repeated cleanup, and handles listen errors. Tests register cleanup before startup, carry the test abort signal into HTTP reads, and await provider readiness alongside stream progress. A rejected-route regression verifies prompt failure without a provider request.
- Settlement assertions compare complete per-segment labels against persisted counts and precision flags. Mounted assertions also check exact, estimated, and unavailable aggregate labels.

Observed red failures covered missing live entries, unknown-route success, unresolved closed gates, and cleanup before startup. Final focused suite: 80 passed. Full backend: 3,739 passed, 5 skipped, no failures. Full dashboard: 501 passed, with only the existing unchanged memory-summary expectation failure described below. Build, typecheck, lint, and diff checks passed. No commits were made; temporary logs were removed.

## Execution results — 2026-09-10

Implementation was authorized and completed in the existing checkout. The latest user instruction was to continue without SiftKit. No commits, worktrees, dependencies, or engine accounting changes were made.

- **Task 1:** Canonical counts, precision, timestamps, and promoted answer identity survive text replacement and stopped markers. Usage flushes buffered text and updates the server transcript before forwarding. Initial regressions: 10 failures out of 23 tests, including text-before-usage ordering; focused tests passed after implementation. The HTTP stop test also verifies retained thinking and partial-answer usage in persisted sessions.
- **Task 2:** Operation-scoped prompt/usage maps and one pure display builder provide calibrated estimates, exact-zero settlement, precision flags, explicit unavailability, and answer totals without double counting. The mounted badge regression initially displayed `0 tokens` instead of `~100 tokens`; it passes after implementation. Focused dashboard validation passed 160 tests at this stage. The shared text ID helper accepts only the metadata prefix it actually uses, avoiding fabricated metadata fields.
- **Task 3:** Contiguous grouping identity is separate from the first-message-based React segment key. Thirteen key regressions failed before the fix; all 87 grouping/rendering tests passed afterward. Full-suite validation found and migrated one additional test helper that searched for the old literal `live` key.
- **Task 4:** Real HTTP inference chunks are released only after prior thinking badges are observed. Tests cover baseline growth, pending enqueue without reset, FIFO delivery of two messages, measured-count stability, mid-stream replay parity, normal and forced successor calibration, stop persistence, truncated replay recovery, disabled thinking, stream failure cleanup, and mounted session switching with queued work. Final rendered assistant totals are checked against the separately fetched persisted session. Existing queue/operation transport suites also passed in the full backend run.
- **Regression sensitivity:** Temporarily replacing the display calculation with canonical row counts in the generated test bundle made seven rendering tests fail, including both gated HTTP flows, pending/forced successors, and queued session switching. Restoring the bundle returned all 67 chat-tab tests to green. Production source was not changed for this check.

Final validation:

| Gate | Result |
| --- | --- |
| `npm run build:test` | Passed |
| `npm run test` | 3,736 passed, 5 skipped, 0 failed |
| Full dashboard suite | 500 passed, 1 unrelated failure |
| `npm run typecheck` | Passed, including test projects and lint |
| `npm run lint` | Passed |
| `git diff --check` | Passed |

The remaining dashboard failure is `memory summary reports context, chunk size and KV cache mode` in `dashboard/tests/model-preset-groups.test.ts`: expected `ctx 128k · chunk 512 · KV f16`, actual `ctx 128k · compaction reserve 1k · chunk 512 · KV f16`. That test, its fixture, and `dashboard/src/tabs/settings/model-preset-groups.ts` are unchanged by this work. An initial concurrent full run also hit a watchdog process-exit failure and an interrupted repo-agent test worker; both passed in an isolated 35-test rerun, and the subsequent full backend run passed.

Browser limitation: browser setup reported “No browser is available”; browser discovery returned an empty list. The exact original sequence was not manually reproduced before or after the fix. The gated HTTP/DOM tests provide automated evidence, not a claim of live browser verification.

Changed production files: `packages/contracts/src/chat-transcript-reducer.ts`, `src/status-server/routes/chat.ts`, and dashboard `chat-session-runtime-store.ts`, `chat-live-token-display.ts`, `chatTurns.ts`, `format.ts`, and `ChatTab.tsx`. Tests cover these paths plus `tests/helpers/gated-chat-backend.ts`. Temporary diagnostics were kept together in `.scratch-token-queue` and removed after recording these results. Unrelated user files were preserved.

> **For agentic workers:** Use `superpowers:executing-plans` to execute sequentially after the user authorizes implementation. This document does not authorize implementation. Follow the session instruction not to use SiftKit. Do not spawn implementation agents, create worktrees, or commit without authorization.

**Goal:** Keep the active thinking/answer token counter updating while text streams, including across queued-message delivery, and settle accurately without losing counts or reusing another segment's React state.

**Architecture:** Measured usage remains authoritative in the shared transcript reducer. A dashboard-only display calculation estimates unfinished text using that turn's backend-supplied characters-per-token ratio. The server orders buffered text before usage, and the dashboard separates contiguous grouping identity from React segment identity.

**Tech stack:** TypeScript, Zod contracts, React, SSE, Node test runner, existing dashboard DOM test environment.

**Spec:** The requirements and design decisions below are the specification for this plan. The plan was authored before implementation authorization; execution results are recorded above.

## Evidence and limits

The investigation confirmed these current-source behaviors with in-memory probes:

1. A thinking row with 400 characters displays `0 tokens`; extending it to 800 still displays `0 tokens`. A usage frame changes it to `200 tokens`.
2. A later text delta recreates that row and changes `200 tokens` back to `0 tokens`.
3. Assistant text, delivered queued user message, then more assistant text produces group keys `live`, `user:<id>`, `live`.

Relevant source:

- `packages/contracts/src/chat-transcript-reducer.ts`: `textMessage`, `reduceTextEvent`, `reduceUsageEvent`, `finalizeStoppedChatTranscript`.
- `src/status-server/routes/chat.ts`: `ChatStreamProgressWriter.write` forwards usage without first flushing pending text; unlike prompt/tool/queue events.
- `src/repo-search/engine/task-loop.ts`: `requestModelResponse` publishes usage after the model response resolves.
- `dashboard/src/lib/chat-session-runtime-store.ts`: queue submission preserves the live transcript; text updates use the shared reducer.
- `dashboard/src/lib/chatTurns.ts`: all live assistant groups share `live`; interrupted persisted runs can likewise repeat `run:<sourceRunId>`.
- `dashboard/src/tabs/ChatTab.tsx`: `ChatTurnBubble` uses `turn.key` as its React key.

The no-estimate reducer behavior dates to September 4 and predates queue support. The exact reported browser sequence has not been reproduced. Do not claim queue submission itself disables counters: queue delivery introduces a separate confirmed key collision, while the counter defects exist without a queue.

Seventy-two focused dashboard tests passed during investigation. A direct `tsx` invocation of a backend test failed during module loading with `ERR_PACKAGE_PATH_NOT_EXPORTED`; this was not an assertion failure. Use the supported compiled test runner below before diagnosing a backend test regression.

## Design decisions

### Token meaning and ownership

- While a thinking block is unfinished, display `~ceil(content.length / charsPerToken)` thinking tokens. Empty text contributes zero.
- Use the prompt frame for that model turn to calibrate its estimate. Capture the ratio by turn; a later prompt must not recalibrate earlier blocks.
- Once usage exists for that turn, display its measured thinking count and preserve `thinkingTokensEstimated`. A measured zero is a real value, not a signal to resume estimation.
- For a streaming final answer before its turn's usage, display the latest preceding run-output total plus the estimated current answer text. Once its usage arrives, display `usage.totals.outputTokens` and the corresponding estimated-count flag. Never add the current estimate on top of totals that already include that turn.
- Keep narration/progress accounting unchanged: these rows contribute zero to the canonical token total. Do not separately estimate narration and then count it again through aggregate answer output.
- Tool result counts and image counts retain their existing semantics. Do not change tokenizer calls, engine billing/accounting, database schemas, or persisted token attribution.
- Only the dashboard display layer may create provisional text estimates. Never write them back into `runtime.liveMessages`, shared transcript rows, saved sessions, or engine token records.
- If an incomplete replay contains text but neither its prompt calibration nor its measured usage, display `tokens unavailable` for that text contribution. Do not fabricate an exact zero or introduce a magic fallback ratio. Measured usage restores the display when received.
- A provisional count may decrease when replaced by measured usage. Do not force monotonicity across that correction; growth is required for append-only text within an unfinished block using the same calibration.

### State and interfaces

Add `dashboard/src/lib/chat-live-token-display.ts` for the pure display calculation. Keep the existing transcript reducer as the sole owner of durable message construction.

Add operation-scoped runtime metadata:

```ts
type LiveTokenTurn = {
  prompt: ChatStreamPromptEvent | null;
  usage: ChatStreamUsageEvent | null;
};
// ChatSessionRuntime field:
tokenTurns: ReadonlyMap<number, LiveTokenTurn>;
```

These are compositions of existing validated contract types, not duplicated wire schemas. Update maps immutably through the runtime store. Retain the latest usage snapshot for each turn; repeated usage frames replace that turn's entry rather than accumulate it.

Expose the existing shared `textMessageId` logic as `buildChatTextMessageId(kind, turn, metadata)` and migrate its existing callers. Its spelling/output stays the same. The dashboard display builder uses this helper with the same `live` metadata prefix as the runtime reducer. Do not parse turn numbers out of IDs or independently reconstruct the ID format. Resolve promoted narration/answer rows by checking the resulting row kind, matching the reducer's promotion behavior.

Reuse and export the existing formatter `TokenDisplay` shape, changing its `tokenCount` to `number | null` to represent unavailable data explicitly. The new pure interface is:

```ts
buildLiveTokenDisplays(runtime: ChatSessionRuntime): ReadonlyMap<string, TokenDisplay>
```

It produces one display entry per live message. For non-generated rows, reuse `getLiveMessageTokenDisplay`. For thinking/answer rows, apply the rules above using `tokenTurns`. Do not mutate the messages. Null propagates through aggregate displays; show unavailability rather than a falsely complete total.

`ChatTab` computes the display map once per runtime update. Pass a mandatory `tokenDisplay: TokenDisplay | null` prop to `MessageBubble` (`null` means use its persisted formatter) and the live display map to `ChatTurnBubble`. Update `formatLiveMessageTokenLabel` to consume the resolved display; update `getTurnTokenDisplay` to accept the display map explicitly. Migrate all callers/tests; do not retain old/new parallel APIs. Persisted groups pass an empty display map and continue reading their canonical messages.

Initialize/clear `tokenTurns` on session creation and new operation `begin`/`attach`; clear it with live transcript cleanup on `done`, `failure`, and `detach`. Preserve it on queue state, queued submission/delivery, draft, images, warnings, and approval transitions. Session switching must not copy another session's map.

### Ordering and precision

On every server usage event:

```ts
this.flushPending();
this.transcriptMessages = reduceChatTranscript(
  this.transcriptMessages,
  { kind: 'usage', usage: toChatStreamUsageEvent(event) },
  this.transcriptMetadata,
);
forwardRepoSearchUsageEvent(this.writer, event);
```

Extract a single explicit `toChatStreamUsageEvent(event)` conversion returning `ChatStreamUsageEventSchema.parse` of `{ turn: event.turn, maxTurns: event.maxTurns, record: event.record, totals: event.totals, charsPerToken: event.charsPerToken }`. Its input is `Extract<RepoSearchProgressEvent, { kind: 'usage' }>` and its output is `ChatStreamUsageEvent`. Both transcript reduction and forwarding use that conversion. No dynamic callback plumbing or new transport event.

Text updates must preserve an existing row's measured counts, precision flags, identity, and creation timestamp. Answer promotion preserves relevant prior metadata; it must not erase existing accounting. Usage applies both the number and its precision flag. Stopped-answer marker appending must preserve the existing answer's accounting as well.

### Segment identity

Keep chronological contiguous grouping. A queued user bubble stays between the assistant segments; do not merge nonadjacent groups or move the user message.

Separate the existing grouping identity (`live`, `run:<id>`, or solo identity) from the rendered key. Give every assistant segment a key based on its first message's stable ID, for example `assistant-segment:<firstMessageId>`. User keys remain `user:<messageId>`.

Use grouping identity only to decide whether the next adjacent message belongs in the last group. A segment's React key must not change as text grows, usage arrives, more messages join it, or an answer becomes its main message. Cover live and persisted split runs. Array indexes, token counts, text, and random IDs are not valid key sources.

## Global constraints

- Implementation is authorized for this execution; do not create worktrees or commits.
- When authorized, use TDD for each task: regression fails for the intended reason, minimal implementation, passing regression, refactor and review.
- All code/tests TypeScript; runtime-validate IO and infer contract types. No `any`, type assertions, non-null assertions, unknown laundering, or namespace imports.
- No worktrees, SiftKit, unsolicited dependencies, compatibility shims, unrelated cleanup, or automatic commits.
- Keep any future temporary diagnostics together in one scratch directory and remove them at closeout.
- Do not weaken the existing canonical-no-estimates tests: they remain correct. Add display-layer tests for live estimation.
- Execute tasks sequentially. Review each changed-file diff and run its focused checks before proceeding.

## Task 1: Preserve measured counts and order usage after text

**Files:**

- Modify `packages/contracts/src/chat-transcript-reducer.ts`.
- Modify `src/status-server/routes/chat.ts`.
- Extend `tests/chat-transcript-reducer.test.ts`.
- Extend `tests/chat-usage-stream-frame.test.ts`.
- Extend `tests/status-server-chat-stop.test.ts` for the completed-row preservation case.

**Produces:** Stable canonical counts across text/marker updates; validated usage conversion; text-before-usage wire ordering. No live estimation yet.

- [x] Add reducer regressions for thinking text → usage 200 → appended text, duplicate text snapshot, shorter replacement snapshot, and unrelated-turn delta. The measured thinking value remains 200 in each relevant row. Repeat for answer output and answer promotion.
- [x] Add estimated-usage and exact-zero cases. Assert flags as well as counts. Example core expectations:

```ts
assert.equal(afterLateDelta.thinkingTokens, 200);
assert.equal(afterEstimatedUsage.thinkingTokensEstimated, true);
assert.equal(afterExactZero.thinkingTokens, 0);
assert.equal(afterExactZero.thinkingTokensEstimated, false);
```

- [x] Test `ChatStreamProgressWriter` itself, not just the forwarding helper. Use Node mocked timers to hold the clock constant: write a short thinking snapshot that stays below the 1,024-character flush threshold, then usage, then flush. Assert wire event order `thinking`, `usage`, with no later text frame. Repeat for buffered answer/narration and an already-flushed prefix plus buffered tail. Dispose timers in test cleanup.
- [x] Test its stopped transcript after completed thinking usage and after partial answer usage. Assert completed counts survive `getStoppedMessages`, including the appended stop marker. Do not invent measured counts for an unfinished turn that has no usage.
- [x] Run the focused tests and record the intended assertion failures; resolve module-loading failures using the compiled runner, not package export changes.
- [x] Implement preservation in `reduceTextEvent`/stopped finalization; populate precision flags in `reduceUsageEvent`; flush and reduce usage before forwarding. Reuse the parsed payload conversion.
- [x] Rebuild tests, rerun these files, inspect the diff. Existing canonical rows must still start at zero until usage.

**Acceptance:** Usage cannot overtake buffered text, later text does not erase measured values, server stopped transcripts retain completed usage, and estimated counts never become falsely exact.

## Task 2: Restore live display estimates with operation-scoped metadata

**Files:**

- Modify `packages/contracts/src/chat-transcript-reducer.ts` to export/migrate the text ID helper.
- Modify `dashboard/src/lib/chat-session-runtime-store.ts`.
- Create `dashboard/src/lib/chat-live-token-display.ts`.
- Modify `dashboard/src/lib/format.ts`.
- Modify `dashboard/src/tabs/ChatTab.tsx`.
- Create `dashboard/tests/chat-live-token-display.test.ts`.
- Extend `dashboard/tests/chat-session-runtime-store.test.ts`, `dashboard/tests/chat-tab.test.tsx`, `dashboard/tests/lib/turn-token-parity.test.ts`, and the formatter tests affected by the explicit interface migration.

**Consumes:** Task 1's canonical precision preservation. **Produces:** `tokenTurns`, `buildLiveTokenDisplays`, and live display wiring described above.

- [x] Add a test through the runtime store with prompt ratio 4, then thinking text of 400 and 800 characters. Assert display values 100 then 200, both inexact; canonical `liveMessages` still have zero thinking tokens.
- [x] Apply measured usage 187 and assert the display becomes exact 187. Send another text snapshot and assert 187 remains. Apply estimated usage and assert the `~` survives; apply exact-zero usage and assert zero is exact.
- [x] Include prompt ratio 8, empty text, overlapping/replacement deltas, duplicate usage, usage for a different turn, usage before a row appears, and missing prompt metadata. Estimate from the reducer's reconstructed content length, not the sum of delta lengths.
- [x] Include two turns with different prompt ratios. Confirm earlier provisional displays do not change when the later prompt arrives. For answer tests, prior run output 60 plus 400 current characters at ratio 4 yields provisional 160; current-turn measured run output 155 yields 155, not 215 or 255.
- [x] Add a narration-to-answer promotion case using the shared ID helper, with no duplicated estimate. Assert narration/progress/tool/image accounting remains as specified.
- [x] Add runtime lifecycle tests: queue enqueue/delivery preserve all token metadata; done/detach/failure/new begin/attach clear it; replay rebuilds it; session A and B are isolated. Repeated usage replaces rather than adds.
- [x] Add a mounted `ChatTab` test using the existing `buildProps`, runtime store, and DOM helpers. Rerender after each event and assert the active block's badge changes before usage/completion, including the `~` marker. Assert unavailable replay metadata shows `tokens unavailable` rather than exact zero.
- [x] Run the tests red, then implement the interfaces and calculation above. Keep a single display calculation shared by individual badges and aggregate badges; no tokenizer calls, timers, or network requests in rendering.
- [x] Update all signature callers and fixtures explicitly. Keep canonical-no-estimates assertions intact. Update display-specific tests that intentionally asserted the former zero behavior to the new requirements.
- [x] Rebuild and run focused display/runtime/DOM/parity tests. Compare live-after-usage against independently constructed persisted rows, not the same array passed twice.

**Acceptance:** The active thinking/answer counter grows before completion, usage replaces provisional values exactly once, queue actions preserve it, replay unavailability is explicit, and persisted accounting remains unchanged.

## Task 3: Give queued assistant segments stable unique keys

**Files:**

- Modify `dashboard/src/lib/chatTurns.ts`.
- Update `dashboard/src/tabs/ChatTab.tsx` only where key consumption requires it.
- Extend `dashboard/tests/lib/chatTurns.test.ts`.
- Extend `dashboard/tests/chat-tab.test.tsx`.

**Consumes:** Existing grouping and Task 2's display wiring. **Produces:** Unique stable keys without changing chronological grouping or message identities.

- [x] Add grouping fixtures for assistant A → queued user → assistant B, and two queued deliveries. Assert keys are unique and message order is unchanged:

```ts
assert.equal(new Set(turns.map((turn) => turn.key)).size, turns.length);
assert.deepEqual(turns.flatMap((turn) => turn.messages.map((message) => message.id)), inputIds);
```

- [x] Repeat with persisted rows sharing one `sourceRunId`. Append text, usage, tool results, and an answer; assert each existing segment retains its key. Test insertion/removal of an earlier independent user group so index-based keys would fail.
- [x] Add a mounted DOM test with two assistant segments separated by a delivered user bubble. Expand the first segment's Internal Logic; update only the second segment's streaming text and tokens. Assert the first disclosure stays expanded and the second segment's content/badge updates in place. Capture React duplicate-key warnings with a scoped test mock and require none.
- [x] Run regressions red, separate grouping identity from segment key, then run green. Preserve the existing grouping rules, thinking-stack depth, tool ring, and user bubble position.
- [x] Migrate tests that assert the literal key `live` or `run:<id>` to the new segment identity. Retain their grouping/ordering assertions.

**Acceptance:** Unique keys in live and persisted split runs; append/usage updates do not remount segments or transfer disclosure state; queued message order remains intact.

## Task 4: Validate queue lifecycle and rendered token settlement end to end

**Files:**

- Extend `dashboard/tests/chat-tab.test.tsx` using its existing server/DOM fixture integration.
- Extend `dashboard/tests/chat-stream-transitions.test.ts` where parser-to-store coverage is needed.
- Extend `tests/chat-message-queue-http.test.ts`, `tests/chat-message-queue-force.test.ts`, and `tests/chat-message-queue-delivery.test.ts` only for the missing transport assertions below.
- Extend `tests/operation-stream.test.ts` if replay order is not already exercised by the queue fixture.
- Update this plan's execution checklist and validation results when implementation is complete.

**Produces:** Regression coverage for the user's sequence rather than only isolated utility functions.

- [x] Use the existing mock inference/server fixture with explicitly gated chunks. Hold response completion until the test has observed at least two token-badge updates. Do not rely on arbitrary sleep durations or test a complete response delivered in one chunk.
- [x] Baseline: start a run, receive prompt/thinking, confirm a provisional badge grows, release usage and completion, and compare final rendered counts with the persisted session response.
- [x] Queue without delivery: enqueue during thinking, then release another thinking chunk. Assert the same active block continues growing while the message is pending; no stream reattachment or metadata reset is induced by enqueue alone.
- [x] Mid-run delivery: allow a tool boundary to consume the queued message, then stream the next thinking block. Assert FIFO user placement, distinct assistant segment keys, previous measured count stability, and new provisional growth. Repeat with two queued messages.
- [x] Successor run: let pending input start a new operation after the first finishes. Assert old usage/ratios are cleared, the successor attaches/replays correctly, and its badge starts from its own text and prompt calibration.
- [x] Force delivery: force-stop an operation with a queued successor. Assert completed usage survives the stopped transcript and successor estimates do not inherit it. Preserve the existing queue-force semantics.
- [x] Reattach mid-stream: rebuild from replayed prompt/text/usage frames and continue live chunks. Assert no double count and the same visible values as an uninterrupted client. Exercise a truncated replay without prompt metadata and later usage recovery.
- [x] Switch between two sessions while one has queued work. Assert token/queue/operation state does not leak between sessions. Include thinking-disabled mode so hidden thinking rows are not recreated by the display builder.
- [x] Inject a stream failure after partial text. Assert existing error/draft recovery remains functional and live token metadata is cleared. Do not add estimation to persisted failed/stopped rows.
- [x] Verify narration/progress and tool-card behavior with the existing rendering tests. Scope any newly found failure to these changed paths; record unrelated problems separately.

**Acceptance:** Tests observe updates before model completion; enqueue, delivery, successor, force, replay, failure, and session switching preserve the defined behavior. Final aggregate totals match canonical persistence; per-segment headers remain sums of the rows in that segment under existing attribution semantics.

## Commands and validation gates

Use the repository's supported compiled test artifacts. Do not reproduce the earlier direct-`tsx` backend loader failure and then treat it as a product regression.

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js tests/chat-transcript-reducer.test.ts tests/chat-usage-stream-frame.test.ts tests/status-server-chat-stop.test.ts
node .\dist\test-runner\run-tests.js dashboard/tests/chat-live-token-display.test.ts dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/chat-tab.test.tsx dashboard/tests/lib/chatTurns.test.ts dashboard/tests/lib/turn-token-parity.test.ts dashboard/tests/lib/format.test.ts dashboard/tests/format.test.ts
node .\dist\test-runner\run-tests.js tests/chat-message-queue-http.test.ts tests/chat-message-queue-force.test.ts tests/chat-message-queue-delivery.test.ts tests/operation-stream.test.ts dashboard/tests/chat-stream-transitions.test.ts
```

Run only the relevant task's existing/new targets until that task is implemented; rebuild after source/test edits so the manifest freshness check is satisfied. Explicit paths disambiguate duplicate formatter test basenames. Do not append `--dashboard` to a focused command: that option selects the full dashboard suite.

Final gates after all tasks:

```powershell
npm run build:test
npm run test
node .\dist\test-runner\run-tests.js --dashboard
npm run typecheck
npm run lint
git diff --check
git status --short
```

Capture potentially large validation output in the single scratch directory and report exit codes, pass/fail counts, failing tests, and diagnostics; do not use SiftKit. Do not assume failures mentioned in older plans are still valid baseline exceptions. Stop and diagnose timeouts, crashes, loader errors, or failed assertions independently.

Perform a final browser smoke check on a test session: stream thinking, enqueue while it is active, observe pre-completion counter growth, observe delivered input/new thinking, then reload during a successor and finish. Record whether the exact originally reported sequence was reproduced before the fix and verified afterward. If live inference or browser access is unavailable, state that limitation; automated DOM/transport evidence is not a claim of a manual browser reproduction.

## Completion criteria and handoff

- [x] All four tasks accepted, with observed red/green evidence for each regression.
- [x] Full applicable suites, typecheck, lint, and diff checks pass, or each remaining failure is specifically reported with scope and evidence.
- [x] No provisional values entered persisted sessions or engine accounting.
- [x] No duplicate assistant segment keys; no queue-induced token-state reset.
- [x] No old signature paths, unused helpers, hardcoded calibration ratios, or temporary artifacts remain.
- [x] Final report lists changed files, validated scenarios, remaining risks, and browser verification limits.
- [x] No commits or deployment unless separately requested.

Planning self-review: the three confirmed defects map to Tasks 1–3; queue/replay uncertainty maps to Task 4. Missing calibration, measured zero, precision flags, answer promotion, stopped markers, multiple queue deliveries, and live/persisted key collisions have explicit behavior and acceptance checks. Implementation and validation results are recorded above.
