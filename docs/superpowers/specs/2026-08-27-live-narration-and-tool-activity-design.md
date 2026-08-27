# Live Narration and Tool Activity Design

## Goal

Keep the interface visibly active throughout an agent turn without exposing model-control syntax.

- Stream reasoning and safe narration continuously in the live narration area.
- Keep textual and native tool-control payloads out of the default-visible UI; retain diagnostics only inside closed Internal Logic.
- Show the newest three user-friendly tool activities until the final answer starts.
- Promote an already-streamed final draft into the answer bubble instead of making the answer appear all at once.
- Render activity rows as subtle, present-tense text with useful targets and no success icon or token count.

## Current failure

The provider's ordinary `content` stream is ambiguous while generation is in progress. It may become:

- narration accompanying a tool call;
- a textual Qwen `<tool_call>` payload; or
- the final answer.

The current engine sends accumulated content as `progress_update`, which the dashboard keeps inside collapsed Internal Logic. This prevents tool markup from leaking, but a normal accepted finish is not identified until the full model response has completed. The engine then emits the complete answer immediately before `done`, so the screen looks frozen during generation and the answer appears at once.

Completed tool rows also expose implementation metadata (`✓`, prompt-token count, and past-tense completion wording) instead of a lightweight description of current activity.

## Architecture

### 1. Provider stream classification

Introduce one stream classifier adjacent to `LlamaCppClient`, where both ordinary content deltas and native `tool_calls` deltas are available.

The classifier maintains one state per model response:

- `undecided`: only an incomplete control prefix or no content has arrived;
- `narration`: ordinary user-readable prose or Markdown is available;
- `tool_control`: a native tool-call delta or bare textual tool-call opener has been observed.

The classifier produces two projections from the same provider stream:

- the existing raw accumulated content, retained for Internal Logic and diagnostics;
- a safe narration projection that never contains executable tool-call markup.

Rules:

- Native `tool_calls` deltas immediately classify the response as `tool_control`.
- A leading partial prefix that could still become `<tool_call>` remains buffered and invisible.
- A bare `<tool_call>` opener outside Markdown code regions classifies the response as `tool_control`; the opener and everything after it are excluded from safe narration.
- Prose before a later bare opener is safe narration, but is reclassified as internal narration when the tool call is confirmed.
- Literal tool syntax inside a completed fenced or inline code region remains ordinary visible content. Until the code region is unambiguous, its potentially executable prefix stays buffered.
- Malformed or incomplete control markup is never promoted to the final answer.

The existing `LlamaCppToolCallParser` remains the single authority for identifying Qwen textual tool markup. The classifier may expose an incremental projection API, but it must not duplicate the parser's dialect patterns.

### 2. Semantic progress events

Add a distinct `narration` progress event. Do not overload `thinking`, `progress_update`, or `answer`.

- `thinking`: provider `reasoning_content`; uses existing smoothing.
- `narration`: safe ordinary-content projection while the response remains unclassified as final.
- `progress_update`: raw accumulated model content for collapsed Internal Logic only.
- `tool_start` / `tool_result`: structured tool lifecycle.
- `answer`: accepted final-answer content only.

Shared contracts validate narration deltas at the SSE boundary. Tool markup stays in `progress_update`; safe narration alone is sent as `narration`.

### 3. Dashboard narration lifecycle

Add a live-only `assistant_narration` message kind with an ID scoped to its model turn.

- A narration delta creates or updates the visible narration box using the current smoothing behavior.
- A `tool_start` for that turn demotes its narration message to `assistant_progress`, placing it inside closed Internal Logic while leaving the activity ring visible.
- An accepted `answer` for that turn promotes the same narration message to `assistant_answer` and applies the authoritative answer delta. The stable identity and already-visible text prevent an all-at-once appearance.
- If no narration message exists, answer streaming follows the existing answer path.
- `done` replaces live state with the persisted session as it does today.

Only `assistant_answer` ends the live activity ring. Thinking, narration, progress, and tool events do not.

### 4. Structured activity subjects

Extend the existing tool activity contract with a validated subject derived once from `RepoNativeToolCall` arguments at ingestion.

Subjects are data, not presentation strings:

- `{ kind: "file", value: "ChatTab.tsx" }`
- `{ kind: "host", value: "example.com" }`
- `{ kind: "none" }`

File subjects use a concise display path chosen by the engine from the validated repository-relative path. Hosts come from validated web-fetch arguments. Commands without a safe, meaningful target use `none`.

The subject travels with `tool_start`, `tool_result`, scorecard command records, persisted tool messages, and dashboard live messages. Historical persisted tool rows migrate to an explicit `none` subject.

### 5. Activity grouping and wording

Build the visible ring from structured live tool messages, newest last, capped at three display rows.

Tool messages from the same model turn and activity kind form one display group. This lets a parallel read batch render as one row:

- one distinct file: `Reading file ChatTab.tsx…`
- multiple distinct files: `Reading multiple files…`

Other examples:

- `Editing file chatTurns.ts…`
- `Editing multiple files…`
- `Searching code…`
- `Validating project…`
- `Searching the web…`
- `Loading example.com…`
- `Running command…`

Normal running and successful rows use the same neutral-gray, present-tense wording. They contain no checkmark, success color, prompt-token count, or completion wording. Failed groups use the same phrase with `failed` appended and subtle red styling.

Raw command, output, exit code, and token details remain available only in the collapsed Internal Logic/tool details view.

## Data flow

1. `LlamaCppClient` receives reasoning, content, and native tool-call deltas.
2. The stream classifier retains raw content and emits a safe narration projection.
3. `ProgressReporter` publishes semantic `thinking`, `narration`, raw `progress_update`, tool, and accepted `answer` events.
4. `ChatStreamProgressWriter` converts those events into strictly validated SSE packets without remapping event kinds.
5. The dashboard runtime updates live narration, Internal Logic, the activity ring, or the final answer according to event semantics.
6. Tool activity subjects persist with the completed session so settled Internal Logic uses the same labels.

## Failure handling

- Invalid narration or tool SSE payloads are rejected at the shared schema boundary.
- Once tool-control syntax is detected, no subsequent content from that model response is eligible for visible narration.
- If an accepted answer differs from the candidate narration, the authoritative answer delta replaces it using the existing offset-aware delta logic.
- A failed tool remains in the activity ring until answer/done and is subtly red.
- Missing required activity subjects fail validation; historical rows receive an explicit migrated `none` value.

## Testing

Use TDD at each boundary.

- Provider classifier: plain prose, partial `<tool_call>` prefixes, complete textual tool calls, native tool-call deltas, prose followed by a tool call, malformed markup, and literal fenced examples.
- Engine progress: raw content remains internal while safe narration streams; accepted finish emits answer; tool turns never emit visible control syntax.
- SSE integration: narration, tool, answer, and done ordering for chat, plan, and repo-search.
- Runtime store: narration creation, tool demotion, answer promotion, delta offsets, and done cleanup.
- Turn grouping/UI: ring remains through thinking and narration, hides on answer, raw markup stays in closed Internal Logic, and promoted text is already present.
- Activity subjects: file/host/none derivation, same-turn multi-file grouping, neutral successful rows, subtle-red failures, and absence of icons/token counts.
- Persistence: schema migration and round-trip of activity subjects.
- Final validation: focused suites, complete test suite, production build, typecheck, and lint.

## Non-goals

- Changing thinking or answer smoothing speed.
- Showing raw commands or model-control syntax in the activity ring.
- Changing CLI progress rendering.
- Adding compatibility paths for old SSE payloads.
- Adding a second model request solely for answer presentation.
