# Run status updates and side-by-side orchestrator layout

## Goal

1. **Status updates:** while a command runs, the model writes one or two plain sentences saying what it is doing and why. Dashboard runs only.
2. **Orchestrator layout:** the orchestrator on the left, its tasks on the right, neither growing without limit.

Approved mockup: `status-updates.html`, to be copied to `docs/superpowers/specs/assets/` with this spec.

## Why

- In 75 repo-agent runs since 2026-11-10, 1,097 of 4,399 model turns (25%) said anything to the user. The rest show only tool names and paths.
- The orchestrator panel is one 900 px column. Tasks, then up to 12 full conversation turns, stack into one long scroll, and the newest turn's thinking opens by itself.
- Every task row repeats its id and worker name and says nothing about why the task exists.

Measured tool durations from the same runs set the trigger rules:

| Tool | Typical | p90 |
|---|---|---|
| Test, lint, build and type-check commands (895) | 3.5 s; 421 took over 4 s | 43.7 s |
| `read`, `grep`, `edit`, `write` | 8 to 41 ms | 9 to 126 ms |

Reads leave no idle time, so an update cannot be free during them. About half of the checks end before an update could.

## Status updates

### When one is written

A run is eligible when it was started from the dashboard: a chat repo-agent run, or an orchestrator run whose request has a `sessionId`, and that run's children. `startOrchestratorChild` passes the parent's eligibility on. CLI runs never write updates.

`StatusUpdateScheduler` (`src/repo-search/engine/status-updates.ts`, new) decides:

1. An update becomes **due** when a test, lint, build or type-check command starts (activity kind `validate`), or when 10 tool calls have completed since the last update.
2. A due update is **written** once a `run` or `job wait` call has been executing for 3 seconds. (`job` comes from the background jobs spec; until it exists, only `run` counts.)
3. At least 60 seconds pass between the starts of two updates.
4. At most one update request is in flight per run.

A due update waits for the next window. Reads alone never trigger a request. If no window comes, no update is written. Without the spacing, these triggers would give about 19 updates per run in the runs above.

### The request

`requestStatusUpdate` in `planner-protocol.ts`, beside `requestApprovalVerdict`:

- **Messages:** the executing planner request's serialized messages (`ExecutingPlannerRequest.serializedMessageJson`), byte-identical, plus one user message. That message states the running command, the last few tool activities, the previous update and the writing rules.
- **Tools:** the same tool definitions, so the prompt prefix is unchanged. A response with a tool call is discarded.
- **Flags:** the planner's, unchanged, because turning thinking off changes the head of the prompt. While the planner thinks, a response prefix closes the thinking block, so the reply does not think.
- **Limits:** 60 generated tokens. The request is cancelled when the command ends.
- **Never in the transcript:** neither the request nor the response enters the run's model history, token usage or prompt-cache-break baseline. Its usage is logged under stage `status_update`.

Before the next planner request, the loop awaits the cancelled request's settlement for at most 1 second. It then continues whether or not the request has settled.

### Acceptance gate

The approval verdict is a separate short prompt, so its cost (3.8 s typical) does not predict this one. Before the feature is enabled, 40 updates are measured on `exl3-3-8-27b-5bpw` with context between 20k and 120k tokens:

| Measure | Required |
|---|---|
| Time to complete, p90 | 6 s or less |
| Extra prompt tokens re-read by the next planner turn, p90, against turns without an update | 500 or fewer more |
| Delay from command end to the next planner request, p90, against runs without updates | 250 ms or less more |
| `prompt_cache_break` events caused by updates | 0 |

If the prefix diverges with thinking off, or recurrent checkpoints make the branch re-read large parts of the prompt, the gate fails. The feature then stays off and the result is reported. It is not shipped with a weaker gate.

### Writing rules

Stated in the request; the response check below enforces only what code can tell:

- One or two short sentences, at most 30 words: the goal, why it matters now, and progress if it is clear.
- No file names, paths, commands, tool names, code or test names.
- Nothing unconfirmed: "checking a suspected problem", not "found a bug".

`parseStatusUpdate` trims the response and rejects it when it is empty, over 45 words, spans paragraphs, or contains a path, backticks, or a tool name that has an underscore (`run_check`; "run" and "read" are ordinary words). A rejected, failed or cancelled update shows nothing. There is no retry, and the run never fails because of one.

### Delivery

- New progress event `status_update`: task fields, `turn`, `updateId`, `text`, `createdAtUtc`.
- **Chat:** journalled as a `display` event, so it is restored after a reload. It produces no context event. `ChatTranscriptEventSchema` gains the kind; the projection keeps it out of message history.
- **Orchestrator child:** `OrchestratorChildActivity` gains `updates`, bounded to the last 10. It is in memory and dropped when the child settles, like the rest of that view. The run transcript keeps the event.

## Run-wide line

The orchestrator states where the whole run is each time it dispatches, so this costs no request:

- `dispatch` gains a required `update` string of at most 240 characters, under the same writing rules and the same check, with its own length limit. A failed check refuses the call with the reason, like any other bad argument.
- Run state gains `statusLines: { text, atUtc }[]`, oldest first. One is appended when the child is reserved, and the list is published with the state.
- The newest 100 are kept (`ORCHESTRATOR_STATUS_LINE_LIMIT`), above the default budget of 80 dispatches. At 240 characters each, that bounds the stored list to 24,000 characters of text.
- The last entry is the current line. Until the first dispatch it shows the plan's goal, or nothing before a plan exists.

## Task purpose

- A plan task gains `why`: one sentence, at most 160 characters, saying why the task exists. `save_plan` and `update_tasks` require it for a new task. A patch may change it.
- A child's instruction includes it, so the worker knows the purpose too.

## Schema 98 to 99

Two stored shapes change:

| Field | Backfill |
|---|---|
| Plan task `why` | `null` |
| Run `statusLines` | `[]` |

Stored tasks allow `why: null`; the tool arguments do not. The upgrade must rewrite **every** stored copy: `state_json.plan.tasks`, each attempt's `attempt_json.work.task`, and any plan held in an approach. `model_admitted` journal events were missed by earlier preset changes, and 13 of 44 chats can no longer restore a run because of it. A test therefore loads a schema-98 database with a copy in each place and parses every row with current schemas.

## Orchestrator layout

`OrchestratorRunPanel` becomes a header over two panes.

**Header, full width:** status, task count, Stop, the meta line and the phase bar. Its title is "Run".

**Left pane, "Orchestrator"** (`OrchestratorConversation`):

- The last 3 turns. Thinking is always closed, including the newest.
- At most 3 calls per turn; the rest fold under "N earlier calls".
- "Earlier turns (N)": the rest of the 12 turns the server keeps, one line each ("turn 27 · 3 calls"), each opening on its own, inside a box with its own scroll.
- "Full transcript (N older turns)" links to the latest parent run's log (`runLogsHref`).
- The run-wide updates are pinned at the bottom: the current one at full strength, and the last 3 past ones above it, oldest at the top, one line each, fading with age (opacity 0.75, 0.55, 0.4). Full text is in each line's tooltip.
- "Show all N updates" expands it to every kept update, unfaded and in full, in a box of at most 230 px with its own scroll, opened at the newest. "Show fewer" folds it. The button appears only when some updates are hidden or a past line is cut. Collapsed, the bar never grows past 4 updates.

**Right pane, "Tasks"** (`OrchestratorTaskRow`):

- Title, then `why`. A null `why` shows the title alone. The task id and worker preset leave the row.
- The row's right side shows activity kind and turn ("validate · turn 26"), not the raw command.
- The running task's agent line names the worker preset. Below it, in order: "Earlier updates (N)", oldest first, closed; the current update; "Latest calls (N)", closed, holding today's tool rows; the write paths.
- An update is current while its command runs, and dimmed with "N tool calls ago" afterwards.

**Sizes:** the panel uses the chat column's full width, and the 900 px cap goes. Panes share the space left and scroll on their own. Under 640 px of panel width (container query) they stack, orchestrator first. Each pane follows its newest content unless the user has scrolled away.

**Fold state** is kept per run and survives updates. A new frame never opens or closes what the user set.

**Repo-agent chat:** the same update block appears at the top of the live turn, with earlier updates above the current one. A finished turn keeps all its updates under "Updates (N)".

Nothing animates, as elsewhere in the chat (`chat.css`).

## Panel repaint glitch

Screenshots from run `bdaa258c` show rows cut mid-text and the header repeated inside the list, which looks like stale painting. Element positions measured on the live page did not overlap, and headless Chrome did not reproduce it on CPU or GPU (589 frames). The cause is **not established**. The main suspect is `content-visibility: auto` on `.msgs-content > *`, which covers this panel.

The panel is excluded from that rule in this work: with bounded panes it no longer needs it. This is not claimed as a fix until it has held on a live run. If the glitch returns, it is investigated separately.

## Testing

- **Scheduler:** due by validate and by 10 calls; no request under 3 s; 60 s spacing; one in flight; no request for CLI runs; children inherit eligibility.
- **Request:** the first messages are byte-identical to the planner request; tools and the two kept flags unchanged; cancelled at command end; the next planner request starts within the 1 s bound even when the status request hangs.
- **Isolation:** transcript, usage totals and cache-watch baseline are identical with and without an update; request failure, timeout, tool call and rule violation leave the run unchanged.
- **Rules:** accepted and rejected examples for each checked rule, including "read" and "run" in ordinary prose.
- **Run state:** 101 dispatches keep the newest 100 lines; a refused dispatch appends nothing.
- **Journal:** update restored after reload; absent from the model history; schema-98 database upgraded in every stored place.
- **Dashboard:** run-wide bar with 0, 1, 3 and 100 past updates, expanded, folded, and receiving a new update while expanded; 3 turns and 3 calls; folding; 200 added turns leave the pane's height unchanged; fold state across frames; stacking under 640 px; null `why`; current and dimmed updates; order of updates.
- **Browser:** one headless check that both panes scroll independently and the run-wide bar stays visible, folded and expanded.
- **Gate:** the acceptance table above, on the live engine.

## Out of scope

- Updates for CLI runs, repo-search, summary and plain chat
- Updates during reads, or a second engine lane for them
- Showing more than the last 12 orchestrator turns in the panel
- Repairing the 13 chats with old `model_admitted` events
