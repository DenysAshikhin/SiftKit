# Chat Composer + Bubble Redesign and Hook Refactor

## Summary

Three coordinated changes to the dashboard chat tab:

1. **Composer-embedded settings**: move the chat-mode/settings strip and the context-usage panel into the composer card, similar to a modern chat input toolbar. Replace the thinking checkbox with a pill button. Replace the verbose text usage block with a color-grading progress bar plus a gear-popover containing the detailed breakdown.
2. **Real chat bubbles**: give `.msg` elements rounded sides + a small tail. Assistant/system bubbles align left with a left-facing tail. User bubbles align right with a right-facing tail.
3. **Logic/UI separation via custom hooks**: extract all non-rendering logic out of `App.tsx` and `ChatTab.tsx` into a new `dashboard/src/hooks/` tree and a new `dashboard/src/lib/chatMessages.ts`. `.tsx` files become render-only.

All work is gated by TDD per `CLAUDE.md`. No legacy shims. Explicit function names only — no dynamic callback passing.

## Order of operations

Do section 3 (refactor) **first**. It makes the surface where sections 1-2 land. Reasons:

- Pulling state and helpers out of `ChatTab.tsx` shrinks it before we add the new composer toolbar, popover, and bubble styling — otherwise the file balloons twice.
- New context-bar logic is a small pure helper in `lib/`, which fits the post-refactor layout naturally.
- Tests created during the refactor anchor behavior so the visual changes in 1 and 2 can't regress wiring.

Then do section 1 (composer redesign), then section 2 (bubbles). Sections 1 and 2 share no state; either order works between them — 1 first because it touches more files.

---

## Section 1 — Composer redesign

### Goal

Mirror modern chat UX: composer is a single card containing the textarea plus a control rail. Above-the-log chat-mode strip and settings panel are removed. Thinking becomes a toggleable pill. Context usage shrinks to a color-grading bar with full breakdown in a gear popover.

### New layout

```
+---------------------------------------------------------------+
| <textarea>                                                    |
|                                                               |
+---------------------------------------------------------------+
| [⚙] [💭 Thinking] [Preset ▾] [plan-root] [turns]              |
|                              ━━━━━━━━━━━━━ ctx bar  [▶ Send]  |
+---------------------------------------------------------------+
```

Card border matches the existing `.usage` border style. Rail is a single flex row with three groups: left controls, center context bar (flex-grow), right send.

### Files

#### `dashboard/src/tabs/ChatTab.tsx`

- Delete the existing `chat-mode-row` block at [ChatTab.tsx:223-254](dashboard/src/tabs/ChatTab.tsx#L223-L254).
- Delete the `showSettings && (...)` panel block at [ChatTab.tsx:255-342](dashboard/src/tabs/ChatTab.tsx#L255-L342).
- Rebuild `.composer` to contain:
  - existing `<textarea>` (unchanged props)
  - new `.composer-toolbar` row with `.composer-toolbar-left`, `.composer-toolbar-context`, `.composer-toolbar-right`
  - Left group: gear `.composer-pill.settings-toggle` (toggles `showSettings`); thinking `.composer-pill.thinking-toggle` (only when `isDirectChatMode`, click invokes `onToggleThinking(!isThinkingEnabledForCurrentSession)`, `.active` class when `isThinkingEnabledForCurrentSession`); preset `<select>` (unchanged); when `isRepoToolMode`, the plan-root input + Save button + max-turns numeric input (same controls as before, just inline in the rail).
  - Center: `renderContextBar(contextUsage)` — see helper below.
  - Right: `.composer-send` button (existing send logic, computed `sendLabel`).
  - Below the toolbar but inside the composer: `showSettings && <SettingsPopover ... />` — absolutely positioned above the composer so it doesn't push the chat log.
- Delete the `settings-summary` hints; the visible pills replace them.

#### `dashboard/src/lib/contextBar.ts` (new)

Pure, no React. Export:

```ts
export type ContextBarVisual = {
  ratio: number;                    // 0..1 clamped
  percent: number;                  // ratio * 100
  fillColor: string;                // hsl string
  titleText: string;                // tooltip
};

export function computeContextBarVisual(
  used: number,
  total: number,
): ContextBarVisual;
```

Algorithm: `ratio = total > 0 ? min(1, max(0, used / total)) : 0`. `fillColor = hsl(${120 - 120*ratio}, 70%, 45%)`. `titleText = \`${formatNumber(used)} / ${formatNumber(total)} (${(ratio*100).toFixed(1)}% used)\``. Return all four fields.

#### `dashboard/src/tabs/ChatTab.tsx` — context bar render

Add a small inline component `ContextBar({ usage }: { usage: ContextUsage | null })`:

```tsx
function ContextBar({ usage }: { usage: ContextUsage | null }) {
  if (!usage) return null;
  const visual = computeContextBarVisual(usage.chatUsedTokens, usage.contextWindowTokens);
  return (
    <div className="context-bar" title={visual.titleText}>
      <div
        className="context-bar-fill"
        style={{ width: `${visual.percent}%`, background: visual.fillColor }}
      />
    </div>
  );
}
```

#### `dashboard/src/tabs/ChatTab.tsx` — settings popover

Add inline `SettingsPopover` that renders the existing detailed context block ([ChatTab.tsx:301-340](dashboard/src/tabs/ChatTab.tsx#L301-L340)) verbatim: `Remaining`, `chatUsedTokens (totalUsedTokens with tools)`, `Warn at`, `Thinking/reasoning`, optional `Live Step Prompt Tokens`, optional `Estimated Fallback`, `Discard Tool Context` button, `Condense Now` button. Element class `.composer-settings-popover`.

#### `dashboard/src/styles.css`

Add:

```css
.composer {
  position: relative;
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--stroke);
  border-radius: 14px;
  padding: 8px;
  background: var(--bg-2);
}
.composer textarea {
  border: none;
  background: transparent;
  resize: none;
  outline: none;
  color: var(--ink);
  padding: 6px 8px;
}
.composer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.composer-toolbar-left,
.composer-toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.composer-toolbar-context {
  flex: 1 1 auto;
  min-width: 120px;
  display: flex;
  align-items: center;
}
.composer-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--stroke);
  border-radius: 999px;
  background: #122436;
  color: var(--ink);
  padding: 4px 10px;
  font-size: 0.85rem;
  cursor: pointer;
}
.composer-pill.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.composer-send {
  border-radius: 999px;
  padding: 6px 14px;
}
.context-bar {
  position: relative;
  height: 8px;
  width: 100%;
  border-radius: 999px;
  background: #122436;
  overflow: hidden;
  cursor: help;
}
.context-bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  transition: width 160ms ease, background 160ms ease;
}
.composer-settings-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 8px;
  right: 8px;
  border: 1px solid var(--stroke);
  border-radius: 12px;
  background: #10202f;
  padding: 12px;
  display: grid;
  gap: 6px;
  z-index: 5;
}
```

Remove dead classes if they have no other references after deletion (grep first; leave if used elsewhere): `.thinking-toggle-row`, `.chat-mode-row`, `.settings-summary`, `.settings-inline-row`, `.plan-root-row`.

#### `dashboard/src/styles/settings.css`

If `.settings-toggle` size override at lines 1-4 conflicts with `.composer-pill`, remove it. `.settings-summary` at lines 6-9 likely becomes unused — delete if no remaining grep hits.

### Tests

Add to `dashboard/tests/tab-components.test.tsx` (or split into `dashboard/tests/chat-composer.test.tsx`). All red-then-green:

1. `chat tab renders composer toolbar with settings, preset, send` — `renderChatTab({})` markup contains `.composer .composer-toolbar` with `.settings-toggle`, the preset `<select>`, and the send button.
2. `chat tab removes old chat-mode-row above chat log` — `.chat-mode-row` does not appear in markup.
3. `chat tab renders thinking pill in direct chat mode when enabled` — `isDirectChatMode=true`, `isThinkingEnabledForCurrentSession=true` → markup contains `thinking-toggle active`. Repeat with `false` → no `active`.
4. `chat tab hides thinking pill outside direct chat mode` — `isDirectChatMode=false` → no `.thinking-toggle`.
5. `chat tab renders context bar with fill width matching usage ratio` — pass `chatUsedTokens=2500, contextWindowTokens=10000` → markup contains `width:25%` (or `width: 25%`) and title attr contains `25.0% used`.
6. `chat tab context bar color shifts toward red as ratio grows` — render twice (ratio 0.1 and 0.9); assert different `background` substrings (different HSL hue values).
7. `chat tab gear popover shows context details when showSettings is true` — `showSettings=true` → markup contains `Remaining:` and `Discard Tool Context`. With `false` → neither appears.
8. Existing `chat tab renders context usage thinking breakdown` test moves under the `showSettings=true` umbrella; keep assertions.

Add `dashboard/tests/lib/contextBar.test.ts`:

1. `computeContextBarVisual clamps used > total to 100%`.
2. `computeContextBarVisual returns 0% for zero total`.
3. `computeContextBarVisual ramps hue from green at 0 to red at 1`.
4. `computeContextBarVisual title text contains used/total and percent with one decimal`.

### Verification

- `npm --prefix dashboard test` green.
- Launch dashboard via the `/run` skill. Visually confirm:
  - composer toolbar appears below textarea with the pills, preset, context bar, and Send
  - thinking pill toggles `.active` on click
  - hovering context bar shows `x/y (z% used)` tooltip
  - color shifts green → yellow → red as ratio grows (seed by sending messages, or temporarily reduce `contextWindowTokens`)
  - gear popover opens with the detailed context block + Condense button

### Out of scope

- Plus button (`+`) from the reference screenshot. We have no attachments feature today; do not add a stub. If attachments land later, a `.composer-pill.attach` slot is the natural home.
- Microphone icon and other right-side controls from the screenshot. Not implemented today.

---

## Section 2 — Chat bubble redesign

### Goal

Bubbles read like a chat thread. Assistant/system align left with a left-facing tail. User aligns right with a right-facing tail.

### Files

#### `dashboard/src/styles.css`

Replace the `.msg` block at [styles.css:848-865](dashboard/src/styles.css#L848-L865) with:

```css
.chat-log {
  display: grid;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
}
.msg {
  position: relative;
  border: 1px solid var(--stroke);
  border-radius: 14px;
  padding: 10px 12px;
  max-width: 80%;
}
.msg.user {
  background: #193349;
  align-self: end;
  border-bottom-right-radius: 4px;
}
.msg.assistant {
  background: #173a35;
  align-self: start;
  border-bottom-left-radius: 4px;
}
.msg.system {
  background: #202433;
  border-color: #3d4863;
  align-self: start;
  border-bottom-left-radius: 4px;
}
.msg.user::after {
  content: '';
  position: absolute;
  right: -6px;
  bottom: 6px;
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-left: 8px solid #193349;
}
.msg.assistant::after,
.msg.system::after {
  content: '';
  position: absolute;
  left: -6px;
  bottom: 6px;
  width: 0;
  height: 0;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-right: 8px solid var(--bubble-tail-bg, #173a35);
}
.msg.system::after {
  border-right-color: #202433;
}
@media (max-width: 720px) {
  .msg { max-width: 92%; }
}
```

### Tests

Add to `dashboard/tests/tab-components.test.tsx`:

1. `chat tab user message bubble carries .msg.user class` — render `selectedSession` with one user message; assert `<article class="msg user ...">` present.
2. `chat tab assistant message bubble carries .msg.assistant class` — same for assistant.
3. `chat tab tool-call bubble carries assistant class for left alignment` — render with one `assistant_tool_call` message; assert its `<article>` has `msg assistant assistant_tool_call`.

(Visual tail rendering verified via `/run`; classnames are the only programmatic contract.)

### Verification

- `npm --prefix dashboard test` green.
- Launch dashboard. Confirm in a session with both user and assistant messages: user hugs right with right-facing tail, assistant hugs left with left-facing tail, tool/thinking bubbles also left.
- Verify max-width keeps a visible gutter on long messages.

---

## Section 3 — Logic/UI separation via custom hooks

### Goal

`.tsx` files become render-only. All chat state, effects, and helper functions move into a new `dashboard/src/hooks/` tree plus `dashboard/src/lib/chatMessages.ts`. Each hook returns an object of explicitly named methods; consumers call methods by name (per `CLAUDE.md`: no dynamic function passing).

### Audit (current mixing)

- [ChatTab.tsx:75-142](dashboard/src/tabs/ChatTab.tsx#L75-L142) — 4 module-level helpers: `compareMessageCreatedAt`, `hashFnv1a32`, `buildLiveMessageScrollSignature`, `buildFallbackPromptContext`.
- [ChatTab.tsx:185-201](dashboard/src/tabs/ChatTab.tsx#L185-L201) — sort/merge of messages, scroll signature derivation, `useRef` + scroll-on-change `useEffect`.
- [App.tsx:156-187](dashboard/src/App.tsx#L156-L187) — 30+ chat-related `useState` declarations.
- [App.tsx:235-291](dashboard/src/App.tsx#L235-L291) — `createLiveMessage`, `upsertLiveMessage`, `appendLiveToolMessage`, `completeLiveToolMessage`.
- [App.tsx:637-685, 810-857](dashboard/src/App.tsx#L637-L857) — session refresh, detail fetch, plan-input sync, auto-append preview effects.
- [App.tsx:859-1130](dashboard/src/App.tsx#L859-L1130) — `onSendMessage`, `onSendPlan`, `onSendRepoSearch`, `onToggleThinking`, `onCondense`, `onUpdateSessionPreset`, `onSavePlanRepoRoot`, `onClearToolContext`, `onDeleteChatMessage`, `onCreateSession`.
- No `dashboard/src/hooks/` directory exists. No custom hooks anywhere.

### Target tree

```
dashboard/src/
  lib/
    chatMessages.ts            // pure helpers moved out of ChatTab.tsx
    contextBar.ts              // computeContextBarVisual (from Section 1)
  hooks/
    useChatSessions.ts
    useChatComposer.ts
    useLiveMessages.ts
    useChatScroll.ts
    useContextUsage.ts
    usePlanInputs.ts
    useRepoSearchAutoAppend.ts
```

### Hook contracts

Each hook has an explicit `UseXxxResult` return type. No `any`/`unknown`.

#### `useChatScroll`

```ts
type UseChatScrollResult = { chatLogRef: React.RefObject<HTMLDivElement | null> };
function useChatScroll(
  visibleMessageIdsKey: string,
  liveMessageScrollSignature: string,
): UseChatScrollResult;
```

Internally runs the existing scroll-to-bottom `useEffect` keyed on the two string args.

#### `useLiveMessages`

```ts
type UseLiveMessagesResult = {
  liveMessages: ChatMessage[];
  resetLive(): void;
  createLiveMessage(id: string, kind: ChatMessageKind, role: ChatRole, content: string): ChatMessage;
  upsertLiveMessage(message: ChatMessage): void;
  appendLiveToolMessage(toolEvent: ToolEvent): void;
  completeLiveToolMessage(toolEvent: ToolEvent): void;
};
function useLiveMessages(): UseLiveMessagesResult;
```

`appendLiveToolMessage` and `completeLiveToolMessage` throw if invoked with a tool event that lacks the required ID — fail loud, no silent skips.

#### `useChatSessions`

```ts
type UseChatSessionsResult = {
  sessions: ChatSession[];
  selectedSessionId: string;
  selectedSession: ChatSession | null;
  selectSession(id: string): void;
  refreshSessions(): Promise<void>;
  createSession(): Promise<void>;
  deleteSession(): Promise<void>;
};
function useChatSessions(options: { onError(err: unknown): void }): UseChatSessionsResult;
```

Owns the URL search-param read/write effect. Auto-selects first session on initial load. Throws if `selectSession` is called with an ID not present in `sessions` (fail loud).

#### `useChatComposer`

```ts
type UseChatComposerResult = {
  chatInput: string;
  chatBusy: boolean;
  chatError: string | null;
  setChatInput(value: string): void;
  sendMessage(): Promise<void>;
  sendPlan(): Promise<void>;
  sendRepoSearch(): Promise<void>;
};
function useChatComposer(deps: {
  selectedSession: ChatSession | null;
  selectedChatPreset: DashboardPreset | null;
  live: UseLiveMessagesResult;
  context: UseContextUsageResult;
  refreshSessions(): Promise<void>;
}): UseChatComposerResult;
```

Each `send*` method is explicit. ChatTab calls `composer.sendMessage()` directly — no dispatcher table.

#### `useContextUsage`

```ts
type UseContextUsageResult = {
  contextUsage: ContextUsage | null;
  setContextUsage(value: ContextUsage | null): void;
  liveToolPromptTokenCount: number | null;
  setLiveToolPromptTokenCount(value: number | null): void;
};
function useContextUsage(): UseContextUsageResult;
```

#### `usePlanInputs`

```ts
type UsePlanInputsResult = {
  planRepoRootInput: string;
  planMaxTurnsInput: string;
  setPlanRepoRootInput(value: string): void;
  setPlanMaxTurnsInput(value: string): void;
};
function usePlanInputs(deps: {
  selectedSession: ChatSession | null;
  selectedChatPreset: DashboardPreset | null;
}): UsePlanInputsResult;
```

Internally runs the two sync `useEffect`s from [App.tsx:810-821](dashboard/src/App.tsx#L810-L821).

#### `useRepoSearchAutoAppend`

```ts
type UseRepoSearchAutoAppendResult = {
  preview: RepoSearchAutoAppendPreview | null;
  selection: RepoSearchAutoAppendSelection;
  previewLoading: boolean;
  setSelection(value: RepoSearchAutoAppendSelection): void;
};
function useRepoSearchAutoAppend(deps: {
  selectedSession: ChatSession | null;
  chatMode: DashboardPresetExecutionFamily;
}): UseRepoSearchAutoAppendResult;
```

### `lib/chatMessages.ts`

Move verbatim out of [ChatTab.tsx:75-142](dashboard/src/tabs/ChatTab.tsx#L75-L142):

- `compareMessageCreatedAt`
- `hashFnv1a32`
- `buildLiveMessageScrollSignature`
- `buildFallbackPromptContext`

Update existing test import in `dashboard/tests/tab-components.test.tsx` to load `buildLiveMessageScrollSignature` from the new path. Move that specific test into a new `dashboard/tests/lib/chatMessages.test.ts`.

### `App.tsx` after refactor

Replace the chat-state section (roughly lines 156-291 and the handler bodies at 859-1130) with hook instantiations:

```ts
const sessions = useChatSessions({ onError: setGlobalError });
const live = useLiveMessages();
const context = useContextUsage();
const planInputs = usePlanInputs({
  selectedSession: sessions.selectedSession,
  selectedChatPreset,
});
const autoAppend = useRepoSearchAutoAppend({
  selectedSession: sessions.selectedSession,
  chatMode,
});
const composer = useChatComposer({
  selectedSession: sessions.selectedSession,
  selectedChatPreset,
  live,
  context,
  refreshSessions: sessions.refreshSessions,
});
```

Then wire those values into `<ChatTab {...} />`. The existing free-standing handlers (`onSendMessage`, `onSendPlan`, `onSendRepoSearch`, `onToggleThinking`, `onCondense`, etc.) reduce to one-line wrappers that call hook methods, or are passed as `composer.sendMessage` etc. directly. Delete every state declaration and effect moved into a hook — no shims.

### Tests

Create `dashboard/tests/hooks/` with one file per hook. Each red-then-green:

1. `useChatScroll.test.tsx` — render a stub component with the hook + a fake scroll container; assert `scrollTop` updates to `scrollHeight` after the signature args change.
2. `useLiveMessages.test.tsx` — `upsertLiveMessage` with duplicate ID replaces the existing entry. `appendLiveToolMessage` then `completeLiveToolMessage` mutates `status`, `output`, `exitCode` on the same ID. `appendLiveToolMessage` with missing ID throws.
3. `useChatSessions.test.tsx` — mock the sessions fetch; first call auto-selects first session. `selectSession` with unknown ID throws. URL search-param reflects current selection.
4. `useChatComposer.test.tsx` — mock send transports. `chatBusy` flips during a send. `chatError` set on failure. `chatInput` cleared on success. `sendPlan` throws when `selectedSession` null. `sendRepoSearch` requires repo-tool mode preset.
5. `useContextUsage.test.tsx` — trivial: setters update state.
6. `usePlanInputs.test.tsx` — changing `selectedSession.planRepoRoot` syncs `planRepoRootInput`. Changing `selectedChatPreset.maxTurns` syncs `planMaxTurnsInput`. User-typed input is not clobbered until the source changes.
7. `useRepoSearchAutoAppend.test.tsx` — preview fetch fires only on first turn of a repo-search session. Skips for non-repo-search modes.

Also: move the existing `buildLiveMessageScrollSignature` test out of `dashboard/tests/tab-components.test.tsx` into `dashboard/tests/lib/chatMessages.test.ts`. Add tests for `compareMessageCreatedAt` (ties on equal times return 0; invalid dates return 0) and `hashFnv1a32` (stable output for a fixed input).

### Rules

- Each hook return type is explicit and exported. No `any` / `unknown`.
- Hook methods are explicit named fields. ChatTab/App call them by name — no dispatch tables, no function-arg passing.
- Fail-loud: hooks throw on contract violation (unknown session ID, missing tool event ID, etc.). Per `CLAUDE.md`, no silent fallbacks.
- No legacy: delete every state declaration and helper that moved into a hook. Do not keep shim wrappers.
- One responsibility per hook. If a hook starts needing > 5 returned methods, split it.

### Out of scope

- `BenchmarkTab.tsx` and `SettingsTab.tsx` also embed logic. Call this out; do not refactor here. A follow-up PR can mirror the chat treatment if requested.

### Verification

- `npm --prefix dashboard test` green for the new hook test files and the moved `chatMessages.test.ts`.
- `App.tsx` chat section is ≤ ~30 lines (hook instantiations + `<ChatTab />` JSX).
- `ChatTab.tsx` has no `useState` / `useEffect` other than the one consumed via `useChatScroll`. All helpers imported from `lib/chatMessages`.
- Launch dashboard. Send messages, switch sessions, toggle thinking, edit plan inputs — confirm parity with pre-refactor behavior.

---

## Files Touched

### New

- `dashboard/src/lib/chatMessages.ts`
- `dashboard/src/lib/contextBar.ts`
- `dashboard/src/hooks/useChatSessions.ts`
- `dashboard/src/hooks/useChatComposer.ts`
- `dashboard/src/hooks/useLiveMessages.ts`
- `dashboard/src/hooks/useChatScroll.ts`
- `dashboard/src/hooks/useContextUsage.ts`
- `dashboard/src/hooks/usePlanInputs.ts`
- `dashboard/src/hooks/useRepoSearchAutoAppend.ts`
- `dashboard/tests/lib/chatMessages.test.ts`
- `dashboard/tests/lib/contextBar.test.ts`
- `dashboard/tests/hooks/useChatSessions.test.tsx`
- `dashboard/tests/hooks/useChatComposer.test.tsx`
- `dashboard/tests/hooks/useLiveMessages.test.tsx`
- `dashboard/tests/hooks/useChatScroll.test.tsx`
- `dashboard/tests/hooks/useContextUsage.test.tsx`
- `dashboard/tests/hooks/usePlanInputs.test.tsx`
- `dashboard/tests/hooks/useRepoSearchAutoAppend.test.tsx`

### Modified

- `dashboard/src/App.tsx` — chat region collapsed to hook instantiations.
- `dashboard/src/tabs/ChatTab.tsx` — render-only; new composer/toolbar/bubble JSX; helpers and effects gone.
- `dashboard/src/styles.css` — composer card, toolbar pills, context bar, bubble shapes + tails; dead classes removed.
- `dashboard/src/styles/settings.css` — drop `.settings-toggle` size override and `.settings-summary` if unused.
- `dashboard/tests/tab-components.test.tsx` — composer/bubble/thinking-pill/context-bar/popover tests added; `buildLiveMessageScrollSignature` test moved out.

## Compliance Check vs `CLAUDE.md`

- **Succinct, no overengineering**: changes scoped to chat surface; no speculative features (plus button, mic icon explicitly out of scope).
- **Explicit functions**: hook return types list named methods; callers invoke them by name.
- **Re-use**: shared `formatNumber` already in `lib/format`; new `contextBar.ts` is a single pure helper; `chatMessages.ts` centralizes the four existing pure helpers.
- **No legacy / no shims**: state moved into hooks is deleted from `App.tsx`; dead CSS classes removed if unreferenced.
- **TDD**: each section lists failing tests before implementation.
- **Branch coverage**: hook tests cover throw paths (unknown session, missing tool ID) and effect-skipping paths (non-repo-search auto-append).
- **TypeScript / explicit types**: every hook has a named `UseXxxResult` type; `contextBar.ts` exports `ContextBarVisual`.
- **No worktrees**: implementation happens in the current branch.
