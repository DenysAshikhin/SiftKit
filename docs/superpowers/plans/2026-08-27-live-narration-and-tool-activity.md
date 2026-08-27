# Live Narration and Tool Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream safe model narration without exposing tool-control markup, promote that narration into the accepted answer, and keep a three-row ring of concise, target-aware tool activity visible until answer streaming begins.

**Architecture:** Classify the provider's accumulated content once beside `LlamaCppClient`, preserving raw content for Internal Logic while exposing a safe narration projection. Carry narration and validated tool subjects through typed progress/SSE contracts, then let the dashboard promote or demote one stable live message and render grouped activity rows from structured data.

**Tech Stack:** TypeScript 5.9, Zod 4, Node test runner, React 19, SQLite (`better-sqlite3`), SSE.

**Spec:** `docs/superpowers/specs/2026-08-27-live-narration-and-tool-activity-design.md`

## Global Constraints

- Preserve the existing thinking and answer smoothing logic; do not impose a fixed token rate.
- Tool-control XML and native tool payloads must never appear in default-visible narration or answer UI.
- Keep raw content, commands, output, exit codes, and token metadata only in collapsed Internal Logic/details.
- The activity ring contains at most the newest three grouped statuses, remains visible through thinking/narration/tool events, and disappears only when `assistant_answer` begins.
- Running and successful activity rows use identical neutral-gray, present-tense copy; only failures use subtle red and the word `failed`.
- Derive tool activity subjects once from validated `RepoNativeToolCall` arguments and require the subject everywhere a structured tool event/message is validated.
- Historical tool messages migrate to `{ kind: 'none' }`; missed current-schema subjects fail validation.
- Refactors are complete replacements: remove superseded callbacks/helpers and do not add compatibility branches, shims, or parallel event paths.
- TypeScript remains inferred from runtime schemas. Do not add `any`, assertions, non-null assertions, unknown laundering, namespace imports, schema-duplicating types, or unvalidated IO.
- Use TDD for every task. Preserve unrelated working-tree changes.
- Do not use a worktree. Do not commit; the user has not authorized commits.
- Do not change CLI progress rendering.

---

## File Structure

### New files

- `src/llm-protocol/live-content-classifier.ts` — one stateful classifier per provider response; combines parser-owned textual control detection with native tool-call state and returns raw/safe projections.
- `tests/live-content-classifier.test.ts` — provider-boundary cases for prose, partial/open control markup, native tool calls, malformed markup, and Markdown literals.
- `dashboard/src/lib/live-narration-message.ts` — stable-ID creation, delta application, demotion, and answer promotion for live narration.
- `dashboard/src/lib/tool-activity-ring.ts` — pure grouping, three-row truncation, status reduction, and present-tense label generation.
- `dashboard/src/components/ToolActivityRow.tsx` — the lightweight neutral/failure ring row; it never renders command/token/output details.
- `dashboard/tests/live-narration-message.test.ts` — narration identity and lifecycle tests.
- `dashboard/tests/tool-activity-ring.test.ts` — grouping, targets, copy, cap, and failure tests.
- `dashboard/tests/tool-activity-row.test.tsx` — visible metadata/style assertions.
- `tests/runtime-db-schema-v52.test.ts` — migration and fresh-schema activity-subject coverage.

### Existing files with focused responsibility changes

- `src/llm-protocol/tool-call-parser.ts` — expose the parser-owned incremental text projection needed by the classifier; keep all Qwen tag/code-region rules here.
- `src/llm-protocol/llama-cpp-client.ts` — feed content/native-tool deltas into the classifier and emit typed content snapshots.
- `src/repo-search/planner-protocol.ts` — carry the typed snapshot through planner and terminal-synthesis callbacks.
- `src/repo-search/types.ts`, `src/repo-search/engine/progress-reporter.ts`, `src/repo-search/engine/task-loop.ts`, `src/repo-search/engine/terminal-synthesizer.ts` — add semantic narration and keep raw progress separate.
- `packages/contracts/src/chat.ts` — validate tool subjects and the live-only `assistant_narration` message kind; continue reusing `ChatStreamTextDeltaSchema` for text packets.
- `src/status-server/routes/chat.ts`, `src/status-server/live-text-delta.ts` — emit narration SSE without remapping event kinds.
- `dashboard/src/lib/chat-stream-parser.ts`, `dashboard/src/lib/chat-stream-transitions.ts`, `dashboard/src/lib/chat-session-runtime-store.ts`, `dashboard/src/lib/chat-live-messages.ts` — parse narration and apply its lifecycle.
- `src/repo-search/tool-activity.ts`, `src/repo-search/engine/tool-action-processor.ts`, `src/repo-search/engine.ts`, `src/status-server/repo-search-scorecard-types.ts` — derive and propagate one structured activity descriptor.
- `src/state/migrations/registry.ts`, `src/state/runtime-db.ts`, `src/state/chat-sessions.ts`, `src/status-server/chat.ts` — persist and restore required subjects at schema version 52.
- `dashboard/src/lib/chatTurns.ts`, `dashboard/src/lib/tool-status.ts`, `dashboard/src/components/ToolCallCard.tsx`, `dashboard/src/tabs/ChatTab.tsx` — use grouped activity rows and keep diagnostics collapsed.

---

### Task 1: Classify provider content into raw and safe projections

**Files:**
- Create: `src/llm-protocol/live-content-classifier.ts`
- Create: `tests/live-content-classifier.test.ts`
- Modify: `src/llm-protocol/tool-call-parser.ts`
- Modify: `src/llm-protocol/llama-cpp-client.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Test: `tests/llm-protocol.test.ts`
- Test: `tests/llm-protocol-streaming.test.ts`
- Test: `tests/llm-protocol-no-blocking-chat.test.ts`

**Interfaces:**
- Consumes: `LlamaCppToolCallParser.scanFromText(text: string): TextToolCallScan` and the parser's existing Markdown code-region rules.
- Produces:

```ts
export const LIVE_CONTENT_CLASSIFICATIONS = ['undecided', 'narration', 'tool_control'] as const;
export type LiveContentClassification = typeof LIVE_CONTENT_CLASSIFICATIONS[number];

export type LiveContentSnapshot = {
  classification: LiveContentClassification;
  rawText: string;
  narrationText: string;
};

export class LiveContentClassifier {
  observeContent(accumulatedContent: string): LiveContentSnapshot;
  observeNativeToolCall(): LiveContentSnapshot;
  finish(): LiveContentSnapshot;
}
```

- Replaces every `onContentDelta?: (accumulatedContent: string) => void` with `onContentDelta?: (snapshot: LiveContentSnapshot) => void` in client/planner request options and consumers.
- `NormalizedLlamaCppChatResponse.text` becomes the classifier's final safe `narrationText`; textual tool extraction still scans `snapshot.rawText`.

- [ ] **Step 1: Write failing classifier tests**

Add table-driven tests with exact expectations:

```ts
const cases = [
  { chunks: ['I will inspect', 'I will inspect the files.'], kind: 'narration', visible: 'I will inspect the files.' },
  { chunks: ['<', '<tool_', '<tool_call>'], kind: 'tool_control', visible: '' },
  { chunks: ['Checking first. ', 'Checking first. <tool_call>{"name":"read"}'], kind: 'tool_control', visible: 'Checking first. ' },
  { chunks: ['`<tool_call>` is literal.'], kind: 'narration', visible: '`<tool_call>` is literal.' },
] satisfies Array<{ chunks: string[]; kind: LiveContentClassification; visible: string }>;
```

Also assert that `observeNativeToolCall()` freezes the current narration prefix, later content cannot extend it, and `finish()` keeps incomplete control prefixes invisible.

- [ ] **Step 2: Run the new test and verify red**

Run: `npm run build:test`

Run: `npm test -- live-content-classifier`

Expected: FAIL because `live-content-classifier.ts` and its exports do not exist.

- [ ] **Step 3: Add a parser-owned incremental projection**

In `tool-call-parser.ts`, add a public method whose implementation reuses the existing tag constants and code-region calculation:

```ts
export type TextToolCallProjection = {
  classification: 'undecided' | 'narration' | 'tool_control';
  narrationText: string;
};

projectStreamText(text: string): TextToolCallProjection;
```

The method must buffer a suffix that is a prefix of the parser's opener, ignore openers inside completed inline/fenced code, return prose before the first bare opener, and classify EOF partial control syntax as `undecided`. Do not export or repeat the opener/code-region regexes in the new classifier.

- [ ] **Step 4: Implement the stateful classifier and client integration**

Implement `LiveContentClassifier` with stored `rawText`, `narrationText`, and a permanent native/tool-control flag. Create exactly one classifier inside `streamChatAtBaseUrl`, call `observeNativeToolCall()` when a native `tool_calls` delta arrives, and pass snapshots to `onContentDelta`. At response completion, scan the final raw text for textual calls and return only `finish().narrationText` as response text.

- [ ] **Step 5: Replace callback types end-to-end**

Import `LiveContentSnapshot` into `llama-cpp-client.ts` and `planner-protocol.ts`; update `PlannerRequestOptions` and `requestTerminalSynthesis` to accept the new callback. Remove the old string callback signatures rather than supporting both.

- [ ] **Step 6: Prove provider behavior is green**

Run: `npm run build:test`

Run: `npm test -- live-content-classifier llm-protocol llm-protocol-streaming llm-protocol-no-blocking-chat`

Expected: PASS; streamed callbacks receive snapshots, ordinary response text remains intact, native/textual calls remain parsed, and no blocking-chat regression appears.

- [ ] **Step 7: Refactor once green**

Remove duplicate prefix/control checks from the classifier, keep all dialect-specific logic in `LlamaCppToolCallParser`, and rerun the Task 1 test command.

---

### Task 2: Publish semantic narration separately from raw progress and accepted answers

**Files:**
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/engine/progress-reporter.ts`
- Modify: `src/repo-search/engine/task-loop.ts`
- Modify: `src/repo-search/engine/terminal-synthesizer.ts`
- Test: `tests/repo-search-chat-types.test.ts`
- Test: `tests/engine-progress-reporter.test.ts`
- Test: `tests/repo-search-chat-loop.test.ts`
- Test: `tests/engine-terminal-synthesizer.test.ts`

**Interfaces:**
- Consumes: `LiveContentSnapshot` from Task 1.
- Produces:

```ts
z.object({ ...turnScopedFields, kind: z.literal('narration'), narrationText: z.string() })

narration(turn: number, narrationText: string): void;
```

- Event semantics: every non-empty `snapshot.rawText` goes to `progressUpdate`; only `classification === 'narration'` goes to `narration`; only an accepted finish or terminal synthesis goes to `answer`.

- [ ] **Step 1: Add failing progress-schema and reporter tests**

Assert `RepoSearchProgressEventSchema` accepts `{ kind: 'narration', taskId, turn, maxTurns, elapsedMs, narrationText }`, rejects `answerText` on narration, and that `ProgressReporter.narration(2, 'Inspecting files…')` writes the exact validated event.

- [ ] **Step 2: Add failing task-loop regressions**

In `repo-search-chat-loop.test.ts`, cover these exact sequences:

```ts
['thinking', 'progress_update', 'narration', 'answer']
['progress_update', 'narration', 'tool_start', 'tool_result']
```

Assert no `narrationText` contains `<tool_call>` and a tool-control response emits no narration after classification changes to `tool_control`.

- [ ] **Step 3: Run the focused tests and verify red**

Run: `npm run build:test`

Run: `npm test -- repo-search-chat-types engine-progress-reporter repo-search-chat-loop engine-terminal-synthesizer`

Expected: FAIL because `narration` is absent and callback consumers still expect strings.

- [ ] **Step 4: Add the narration event and reporter method**

Extend the discriminated union once and implement:

```ts
narration(turn: number, narrationText: string): void {
  this.write({ ...this.turnFields(turn), kind: 'narration', narrationText });
}
```

Use the reporter's existing event construction helpers; do not create a second writer.

- [ ] **Step 5: Route snapshots in the task loop**

Replace the accumulated-string callback with explicit projection routing:

```ts
onContentDelta: this.progress.liveTextEnabled
  ? (snapshot) => {
      if (snapshot.rawText) this.progress.progressUpdate(turn, snapshot.rawText);
      if (snapshot.classification === 'narration' && snapshot.narrationText) {
        this.progress.narration(turn, snapshot.narrationText);
      }
    }
  : undefined,
```

Remove the completed-response block that republishes narration as `progress_update`; the raw callback is now authoritative. Keep `progress.answer` only at accepted finish.

- [ ] **Step 6: Update terminal synthesis without changing smoothing**

Map only `snapshot.narrationText` to the existing accumulated `answer` event and retain the final authoritative answer emission. Do not add throttling or a second request.

- [ ] **Step 7: Run the focused tests and verify green**

Run: `npm run build:test`

Run: `npm test -- repo-search-chat-types engine-progress-reporter repo-search-chat-loop engine-terminal-synthesizer`

Expected: PASS with raw/internal and safe/visible streams separated.

---

### Task 3: Carry narration through validated chat SSE

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/live-text-delta.ts`
- Test: `tests/live-text-delta.test.ts`
- Test: `tests/dashboard-status-server.test.ts`
- Test: `tests/status-server-chat.test.ts`

**Interfaces:**
- Consumes: repo-search `{ kind: 'narration'; narrationText: string }` events from Task 2.
- Produces: SSE event `narration` with payload validated by the existing `ChatStreamTextDeltaSchema`:

```ts
{ turn: number; offset: number; text: string }
```

- [ ] **Step 1: Write failing SSE-ordering and payload tests**

Add chat, plan, and repo-search cases asserting `narration` packets parse with `ChatStreamTextDeltaSchema`, raw `progress` packets remain separate, and event order is `narration` → optional tool events → `answer` → `done`. Add an invalid offset/text payload rejection case.

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm run build:test`

Run: `npm test -- live-text-delta dashboard-status-server status-server-chat`

Expected: FAIL because `ChatStreamProgressWriter` has no narration branch/tracker.

- [ ] **Step 3: Add an independent narration delta channel**

Give `ChatStreamProgressWriter` a narration `LiveTextDeltaTracker`, then handle the event without remapping:

```ts
case 'narration':
  this.writeTextDelta('narration', event.turn, event.narrationText, this.narrationDeltaTracker);
  return;
```

Validate the resulting payload with `ChatStreamTextDeltaSchema` immediately before SSE write. Keep the existing thinking and answer trackers/behavior unchanged.

- [ ] **Step 4: Keep event resets turn-scoped**

Reset narration offset state at the same response/turn boundary as answer/thinking state. Do not share an offset tracker between event kinds.

- [ ] **Step 5: Run focused tests and verify green**

Run: `npm run build:test`

Run: `npm test -- live-text-delta dashboard-status-server status-server-chat`

Expected: PASS; narration is validated and never serialized as answer or generic progress.

---

### Task 4: Create, demote, and promote one stable live narration message

**Files:**
- Create: `dashboard/src/lib/live-narration-message.ts`
- Create: `dashboard/tests/live-narration-message.test.ts`
- Modify: `packages/contracts/src/chat.ts`
- Modify: `dashboard/src/lib/chat-stream-parser.ts`
- Modify: `dashboard/src/lib/chat-stream-transitions.ts`
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Modify: `dashboard/src/lib/chat-live-messages.ts`
- Test: `dashboard/tests/chat-stream-parser.test.ts`
- Test: `dashboard/tests/chat-stream-transitions.test.ts`
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`
- Test: `dashboard/tests/chat-live-messages.test.ts`

**Interfaces:**
- Consumes: SSE `narration`, `tool_start`, `answer`, and `done` packets.
- Produces:

```ts
export function liveNarrationMessageId(turn: number): string;
export function applyNarrationDelta(messages: ChatMessage[], delta: ChatStreamTextDelta): ChatMessage[];
export function demoteNarrationForTurn(messages: ChatMessage[], turn: number): ChatMessage[];
export function promoteNarrationToAnswer(messages: ChatMessage[], delta: ChatStreamTextDelta): ChatMessage[];
```

- `ChatMessageSchema` adds `assistant_narration` to the non-tool kind enum. Persisted session construction must never write this live-only kind.

- [ ] **Step 1: Write failing parser and lifecycle tests**

Assert that narration packets parse to a typed transition; repeated offsets update one message with ID `assistant-narration-turn-${turn}`; `tool_start` changes that same object's kind to `assistant_progress`; and `answer` changes it to `assistant_answer` while preserving ID and applying the authoritative offset delta.

- [ ] **Step 2: Add ring-lifetime regression tests**

In runtime/turn tests, assert thinking, progress, and narration leave live tool messages present; the first answer transition hides the ring; `done` clears live messages and installs the persisted session.

- [ ] **Step 3: Run dashboard tests and verify red**

Run: `npm run build:test`

Run: `npm test -- dashboard/tests/chat-stream-parser.test.ts dashboard/tests/chat-stream-transitions.test.ts dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/chat-live-messages.test.ts dashboard/tests/live-narration-message.test.ts`

Expected: FAIL because narration is not a packet/message/transition kind.

- [ ] **Step 4: Add the typed parser and transition cases**

Parse `event: narration` with `ChatStreamTextDeltaSchema`; add a narration runtime transition and exhaustively handle it in the store. No default branch may silently discard an unknown event.

- [ ] **Step 5: Implement stable message lifecycle helpers**

Build the initial narration message with the same timestamps/token defaults as other live assistant messages. Apply existing offset-aware text-delta logic. On tool start, demote only the matching turn. On answer, prefer promotion; if no narration exists, call the existing answer-message path.

- [ ] **Step 6: Preserve current smoothing ownership**

Feed narration text through the same dashboard smoothing queue used by current live text. Do not add intervals, rate constants, or token-per-second calculations. Make event kind/lifecycle the only new behavior.

- [ ] **Step 7: Run dashboard tests and verify green**

Run: `npm run build:test`

Run: `npm test -- dashboard/tests/chat-stream-parser.test.ts dashboard/tests/chat-stream-transitions.test.ts dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/chat-live-messages.test.ts dashboard/tests/live-narration-message.test.ts`

Expected: PASS; candidate text is visible before completion and becomes the answer without a new bubble.

---

### Task 5: Derive and propagate validated tool activity subjects

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `src/repo-search/tool-activity.ts`
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/engine/progress-reporter.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Modify: `src/repo-search/engine.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/repo-search-scorecard-types.ts`
- Modify: `dashboard/src/lib/live-tool-message.ts`
- Test: `tests/tool-activity.test.ts`
- Test: `tests/engine-progress-reporter.test.ts`
- Test: `tests/repo-search-chat-types.test.ts`
- Test: `tests/dashboard-status-server.test.ts`
- Test: `dashboard/tests/live-tool-message.test.ts`

**Interfaces:**
- Consumes: validated `RepoNativeToolCall` discriminated union from `src/repo-search/repo-tool-arguments.ts`.
- Produces schema-derived contracts:

```ts
export const ToolActivitySubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), value: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('host'), value: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type ToolActivitySubject = z.infer<typeof ToolActivitySubjectSchema>;

export const ToolActivitySchema = z.strictObject({
  activityKind: ToolActivityKindSchema,
  activitySubject: ToolActivitySubjectSchema,
});
export type ToolActivity = z.infer<typeof ToolActivitySchema>;

export function getToolActivity(call: RepoNativeToolCall): ToolActivity;
```

- Replaces `getToolActivityKind`; `activitySubject` is required on tool start/result events, scorecard command records, SSE tool events, and live dashboard tool messages.

- [ ] **Step 1: Write failing derivation tests**

Cover exact mappings: `read/write/edit` path `dashboard/src/tabs/ChatTab.tsx` → `{ kind: 'file', value: 'ChatTab.tsx' }`; valid `web_fetch` URL → `{ kind: 'host', value: 'example.com' }`; `grep/find/ls/git/run/web_search` → `{ kind: 'none' }`. Verify validation commands still map to `validate` and ordinary runs to `command`.

- [ ] **Step 2: Write failing propagation tests**

Require `activitySubject` in progress/SSE/live-message fixtures, assert omission fails the relevant Zod schema, and verify the same object reaches start, result, and scorecard records unchanged.

- [ ] **Step 3: Run focused tests and verify red**

Run: `npm run build:test`

Run: `npm test -- tool-activity engine-progress-reporter repo-search-chat-types dashboard-status-server dashboard/tests/live-tool-message.test.ts`

Expected: FAIL because the subject schema/function/event fields do not exist.

- [ ] **Step 4: Add schema and complete derivation replacement**

Create `ToolActivitySubjectSchema`, derive its type, and replace `getToolActivityKind` with `getToolActivity`. Normalize file separators and select the last non-empty validated path segment. Parse `web_fetch.args.url` with `URL`; return `none` if it has no HTTP(S) host. Do not parse raw JSON here—the call is already `RepoNativeToolCallSchema` output.

- [ ] **Step 5: Propagate one descriptor through the engine**

Compute `const activity = getToolActivity(call)` once in `tool-action-processor.ts`, then pass both fields through `ProgressReporter.toolStart`, `ProgressReporter.toolResult`, scorecard command construction, SSE validation, and `createLiveToolMessage`. Remove independent kind/subject re-derivation downstream.

- [ ] **Step 6: Run focused tests and verify green**

Run: `npm run build:test`

Run: `npm test -- tool-activity engine-progress-reporter repo-search-chat-types dashboard-status-server dashboard/tests/live-tool-message.test.ts`

Expected: PASS; missing subjects fail and validated subjects remain identical across boundaries.

---

### Task 6: Persist required subjects and migrate schema 51 to 52

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Modify: `src/state/migrations/registry.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `src/status-server/chat.ts`
- Create: `tests/runtime-db-schema-v52.test.ts`
- Test: `tests/runtime-db-schema-v51.test.ts`
- Test: `tests/chat-sessions-db.test.ts`
- Test: `tests/status-server-chat.test.ts`

**Interfaces:**
- Consumes: `ToolActivitySubjectSchema` and structured tool events from Task 5.
- Produces: current DB schema version `52` with columns:

```sql
tool_call_activity_subject_kind TEXT
tool_call_activity_subject_value TEXT
```

- `ChatToolCallMessageSchema` requires `toolCallActivitySubject`; non-tool messages omit it.

- [ ] **Step 1: Write failing migration tests**

Create a version-51 database containing a historical `assistant_tool_call`, run migrations, and assert version 52 plus `{ kind: 'none' }` on read. Assert a fresh version-52 database round-trips file and host subjects and rejects an invalid kind/value pair.

- [ ] **Step 2: Write failing session persistence tests**

Persist one file-subject tool result and assert the returned `ChatSessionSchema` message contains exactly the same subject. Add a direct current-schema row missing `subject_kind` and assert loading fails loudly rather than defaulting.

- [ ] **Step 3: Run focused tests and verify red**

Run: `npm run build:test`

Run: `npm test -- runtime-db-schema-v51 runtime-db-schema-v52 chat-sessions-db status-server-chat`

Expected: FAIL because schema version 52 and subject columns do not exist.

- [ ] **Step 4: Add migration 52 and fresh-schema columns**

Append one registry migration that adds both columns and sets historical tool rows to `subject_kind = 'none'` with a null value. Update fresh-table creation to include the same columns. Keep version 51 tests as upgrade-source coverage; version 52 becomes the asserted current version.

- [ ] **Step 5: Parse row data into the shared schema**

Map `file`/`host` rows to `{ kind, value }` only when value is non-empty, map `none` to `{ kind: 'none' }`, and throw a descriptive error for missing/invalid current-schema values. Use `ToolActivitySubjectSchema.parse` rather than a local duplicate union.

- [ ] **Step 6: Write subjects on every tool-message insert/update**

Update chat/session persistence parameters and scorecard-to-message conversion so both subject columns are written together. Do not insert `assistant_narration` into persistent sessions.

- [ ] **Step 7: Run focused tests and verify green**

Run: `npm run build:test`

Run: `npm test -- runtime-db-schema-v51 runtime-db-schema-v52 chat-sessions-db status-server-chat`

Expected: PASS for historical migration, fresh schema, round trip, and loud invalid-row failure.

---

### Task 7: Render the three-row grouped activity ring and collapsed diagnostics

**Files:**
- Create: `dashboard/src/lib/tool-activity-ring.ts`
- Create: `dashboard/src/components/ToolActivityRow.tsx`
- Create: `dashboard/tests/tool-activity-ring.test.ts`
- Create: `dashboard/tests/tool-activity-row.test.tsx`
- Modify: `dashboard/src/lib/chatTurns.ts`
- Modify: `dashboard/src/lib/tool-status.ts`
- Modify: `dashboard/src/components/ToolCallCard.tsx`
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Test: `dashboard/tests/tool-call-card.test.tsx`
- Test: `dashboard/tests/chat-tab.test.tsx`

**Interfaces:**
- Consumes: `ChatToolCallMessage[]` with required `toolCallActivityKind`, `toolCallActivitySubject`, `toolCallTurn`, status, and exit code.
- Produces:

```ts
export type ToolActivityGroup = {
  key: string;
  turn: number;
  activityKind: ToolActivityKind;
  subjects: ToolActivitySubject[];
  state: 'active' | 'failed';
  messages: ChatToolCallMessage[];
};

export function buildToolActivityRing(messages: readonly ChatToolCallMessage[]): ToolActivityGroup[];
export function getToolActivityLabel(group: ToolActivityGroup): string;
```

- `buildToolActivityRing` groups by `toolCallTurn + toolCallActivityKind`, retains chronological order with newest last, and returns `groups.slice(-3)`.

- [ ] **Step 1: Write failing pure grouping/label tests**

Assert one read file renders `Reading file ChatTab.tsx…`; two distinct same-turn read files render `Reading multiple files…`; same-turn edits group independently; four groups return only the newest three; a nonzero completed result appends ` failed`; successful completion does not change the active phrase.

- [ ] **Step 2: Write failing component tests for forbidden visible metadata**

Render success, running, and failure rows. Assert visible text contains no `✓`, token count, `completed`, raw command, output snippet, or exit code. Assert running/success share the neutral class and failure alone receives the subtle-red class.

- [ ] **Step 3: Write failing ChatTab integration tests**

Assert the ring survives thinking, narration, progress, tool start/result, and contains at most three rows. Assert it disappears on the first `assistant_answer`. Assert `<tool_call>` raw content exists only under a closed `Internal Logic` disclosure.

- [ ] **Step 4: Run dashboard tests and verify red**

Run: `npm run build:test`

Run: `npm test -- dashboard/tests/tool-activity-ring.test.ts dashboard/tests/tool-activity-row.test.tsx dashboard/tests/tool-call-card.test.tsx dashboard/tests/chat-tab.test.tsx`

Expected: FAIL because grouping/row components and target-aware labels do not exist.

- [ ] **Step 5: Implement pure grouping and copy**

Deduplicate subjects by `kind:value`, mark a group failed if any done message has a nonzero exit code, and implement these exact base phrases:

```ts
const genericLabels = {
  search: 'Searching code…',
  validate: 'Validating project…',
  web_search: 'Searching the web…',
  command: 'Running command…',
} satisfies Partial<Record<ToolActivityKind, string>>;
```

Use `Reading file X…` / `Reading multiple files…`, `Editing file X…` / `Editing multiple files…`, and `Loading host…` / `Loading multiple pages…`. Append ` failed` only for failed groups.

- [ ] **Step 6: Render lightweight rows and keep details collapsed**

Render `ToolActivityRow` in the ring with text only. Keep individual `ToolCallCard` diagnostics under Internal Logic and default its details disclosure closed. Remove the check icon, green success class, prompt-token suffix, and past-tense completion label from default-visible headers.

- [ ] **Step 7: Make answer presence the sole ring stop condition**

In `ChatTab`, compute the visible groups from the current live turn until an `assistant_answer` exists. Do not hide the ring for `assistant_narration`, `assistant_thinking`, `assistant_progress`, `tool_result`, or a `done` tool status.

- [ ] **Step 8: Run dashboard tests and verify green**

Run: `npm run build:test`

Run: `npm test -- dashboard/tests/tool-activity-ring.test.ts dashboard/tests/tool-activity-row.test.tsx dashboard/tests/tool-call-card.test.tsx dashboard/tests/chat-tab.test.tsx`

Expected: PASS with a neutral, target-aware, three-row ring and closed diagnostics.

---

### Task 8: Remove obsolete paths and validate the complete behavior

**Files:**
- Modify only files already listed above when cleanup is required.
- Test: all root and dashboard suites.

**Interfaces:**
- Consumes: completed Tasks 1–7.
- Produces: one classifier path, one narration event path, one subject derivation path, schema version 52, and one grouped ring renderer.

- [ ] **Step 1: Scan for obsolete identifiers and forbidden presentation copy**

Run: `rg -n "getToolActivityKind|onContentDelta\?: \(accumulatedContent|✓|completed|promptTokenCount.*tool|assistant_narration" src packages dashboard tests`

Expected: only deliberate negative-test text remains for removed identifiers/copy; `assistant_narration` appears only in the new contract/runtime/tests and never in persistence inserts.

- [ ] **Step 2: Run all focused feature suites**

Run: `npm run build:test`

Run: `npm test -- live-content-classifier llm-protocol repo-search-chat engine-progress-reporter engine-terminal-synthesizer live-text-delta dashboard-status-server status-server-chat tool-activity runtime-db-schema-v52 chat-sessions-db dashboard/tests/chat-stream-parser.test.ts dashboard/tests/chat-stream-transitions.test.ts dashboard/tests/chat-session-runtime-store.test.ts dashboard/tests/live-narration-message.test.ts dashboard/tests/tool-activity-ring.test.ts dashboard/tests/tool-activity-row.test.tsx dashboard/tests/chat-tab.test.tsx`

Expected: PASS.

- [ ] **Step 3: Run the complete test suite with compact result routing**

Run: `npm test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."`

Expected: PASS with zero failing tests.

- [ ] **Step 4: Run production build**

Run: `npm run build 2>&1 | siftkit summary --question "Return pass/fail, compiler or bundler errors with file:line anchors, and warnings."`

Expected: PASS; the existing Vite chunk-size warning is informational unless it changes.

- [ ] **Step 5: Run typecheck and lint independently**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every TypeScript or ESLint error with file:line anchors."`

Run: `npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every lint error with file:line anchors."`

Expected: both PASS with zero errors.

- [ ] **Step 6: Review the final diff without changing unrelated work**

Verify each changed hunk maps to this plan, no generated scratch files remain, and no status/dashboard server was started by validation. Report changed files, exact validation results, remaining risks, and any pre-existing failures; do not commit.

---

## Acceptance Criteria

- Ordinary prose/Markdown begins appearing during generation using current smoothing.
- Partial/bare tool-control markup never appears outside closed Internal Logic.
- Tool turns demote prior narration; accepted answers promote the same live message identity.
- The final answer streams rather than appearing only at `done`.
- The newest three grouped tool activities remain visible until answer streaming begins.
- Activity rows use target-aware present-tense copy, neutral success styling, subtle-red failure styling, and no visible icons/tokens/commands/output.
- Tool subjects are schema-validated through live events, scorecards, persistence, migration, and settled dashboard messages.
- Historical rows become explicit `none`; malformed current rows fail loudly.
- Focused tests, full tests, production build, typecheck, and lint pass without changing smoothing or CLI rendering.
