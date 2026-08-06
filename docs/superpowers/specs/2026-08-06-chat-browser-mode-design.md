# Chat Browser Mode — fara-style CUA subagent

Date: 2026-08-06
Status: Approved design

## Goal

Add an optional per-chat browser mode. When enabled, the main chat agent can dispatch
browser tasks to a dedicated computer-use subagent that drives a real, headed Chromium
window via screenshots and coordinate actions, matching the Fara 1.5 action space
(microsoft/fara) so a specialized fara model preset is a drop-in later. For now the
subagent uses the same general vision model as chat (27B exl3 4.7bpw on tabby).

## Decisions (locked)

- **Action space:** pure fara — raw screenshots + pixel-coordinate actions. No DOM,
  no accessibility tree, no set-of-marks.
- **Browser mode:** headed Chromium window, plus live screenshots rendered in a
  dashboard sideview.
- **Lifecycle:** agent or user can launch the browser; **only the user can close it**
  (sideview close button).
- **Tool surface:** the subagent sees browser tools only. The main chat agent gains one
  tool, `browser_task`, gated by a per-session toggle like `webSearchEnabled`.
- **Dispatch:** main agent calls `browser_task` in response to a user request or on its
  own initiative when the toggle is on.
- **Persistence:** one browser instance with a persistent on-disk profile; logins and
  page state survive across tasks, chat sessions, and restarts, until the user closes it.
- **Loop:** dedicated `BrowserAgentLoop`, not an extension of the repo-search engine
  task loop.

## New dependency

- `playwright` (Chromium install only). Used for:
  - `chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1440, height: 900 } })`
  - `page.mouse.*` / `page.keyboard.*` for coordinate-based input
  - `page.screenshot()` (PNG) for observations
  - navigation (`page.goto`, `page.goBack`) and page metadata (URL, title)

No other new dependencies. Reused existing infra:

- Image content parts and vision guards: `src/llm-protocol/image-attachments.ts`
  (`buildUserContent`, `assertPresetAcceptsImages`; requires exl3 backend + `VisionEnabled`).
- Tool-call parsing (`<tool_call>` XML from Qwen-family models): `src/llm-protocol/tool-call-parser.ts`.
- SSE streaming to the dashboard: `src/status-server/sse-response-writer.ts` and the chat stream.
- Runtime schemas: `src/lib/zod.ts` for all IO parsing.

## Architecture

New module `src/browser/`:

| Unit | Responsibility |
| --- | --- |
| `browser-session-manager.ts` | Owns the singleton Playwright persistent context. Launch, close, crash detection, state reporting. Keyed globally (one browser at a time), profile at `~/.siftkit/browser-profile/default`. |
| `browser-actions.ts` | Fara action schema (zod) + executor mapping each action to Playwright calls on the fixed 1440×900 viewport. Screenshot after every action. |
| `browser-agent-loop.ts` | The CUA subagent loop: build messages, call the model, parse one action per turn, execute, append observation, enforce screenshot window and max turns, produce the final report. |
| `browser-prompts.ts` | Fara-style CUA system prompt (adapted for the general model now; swapped for fara's official prompt when a fara preset lands). |

### Chat integration

- `ChatSession` gains `browserEnabled: boolean` (default false), persisted like
  `webSearchEnabled` in `src/state/chat-sessions.ts`.
- When enabled, the chat system prompt (built in `src/status-server/chat-prompt-context.ts`)
  appends browser-dispatch instructions, and the `browser_task` tool definition is added
  to the chat agent's tool schema (same mechanism that adds `WEB_RESEARCH_PRESET_TOOLS`
  in `src/status-server/chat-repo-operation-runner.ts`).
- `browser_task` args: `{ goal: string, context?: string }`. Result: a report
  `{ status: 'completed' | 'failed' | 'needs_user' | 'aborted', answer: string,
  facts: string[], finalUrl: string | null, steps: number }` rendered as the tool
  output message. Screenshots are written to run artifacts on disk; they never enter
  the chat agent's context.

### Subagent loop

Per `browser_task` dispatch:

1. Ensure the browser is running (auto-launch via the session manager if not).
2. Build messages: CUA system prompt → user message with the goal (+ optional context
   from the chat agent) → observe/act turns.
3. Each turn: user message containing page URL + title text and the current screenshot
   as an `image_url` content part; assistant responds with exactly one `<tool_call>`
   action; executor runs it; next observation follows.
4. **Screenshot window:** only the most recent 3 screenshots stay in context (fara
   guidance). Older observation messages keep their text (URL/title, action taken,
   memorized facts); the image part is replaced with a short placeholder line.
5. Loop ends on `terminate`, on max turns (config), on browser loss (user closed or
   crash), or on abort.

The subagent is its own request sequence against the same model instance. On tabby
(paged KV cache) only the pages diverging from any shared prefix re-process; the chat
context cache is untouched. On llama the whole cache would break — accepted.

### Action space (fara 1.5 parity)

Mouse (pixel coordinates on the 1440×900 viewport):
`left_click`, `right_click`, `double_click`, `triple_click`, `mouse_move`,
`left_click_drag`.

Keyboard: `type` (text), `key` (key or chord).

Navigation: `scroll`, `hscroll`, `visit_url`, `history_back`.

Utility: `web_search` (navigates the browser to a search-results page — no external
search API), `wait` (bounded seconds), `pause_and_memorize_fact` (appends to the
report's `facts`), `terminate` (`status` + final answer).

`ask_user_question` (fara has it) maps in v1 to terminating with
`status: 'needs_user'` and the question as the answer. Because the browser persists,
the next `browser_task` resumes on the live page after the user replies in chat.

Safety: the system prompt instructs the model to terminate-and-ask before irreversible
actions (purchases, sending messages, deleting data). No hard technical gate in v1 —
the user is watching the headed window and the sideview.

### Status server + dashboard sideview

Endpoints (status server, alongside existing chat routes):

- `POST /browser/launch` — user-initiated launch.
- `POST /browser/close` — user-initiated close; aborts any running task.
- `GET /browser/state` — `{ running, currentUrl, title, activeTask }`.

During a `browser_task`, the existing chat SSE stream carries new event kinds:

- `browser_screenshot` — downscaled JPEG data URL for the sideview.
- `browser_action` — the parsed action + coordinates, for the action log.
- `browser_status` — launched, task started/finished, closed, crashed.

Dashboard (`dashboard/src/tabs/ChatTab.tsx` + new sideview component): toggle for
browser mode on the session, sideview panel showing the live screenshot, action log,
launch button, and the close button (the only way to close the browser).

### Config

New config keys (existing config service, `src/config/`):

- `BrowserProfileDir` (default `~/.siftkit/browser-profile/default`)
- `BrowserViewportWidth` / `BrowserViewportHeight` (default 1440×900)
- `BrowserMaxTurns` (default 25)
- `BrowserScreenshotHistory` (default 3)

Enabling browser mode on a session whose model preset is not exl3 + `VisionEnabled`
fails loudly at dispatch via `assertPresetAcceptsImages`.

## Error handling

- **Launch failure:** `browser_task` returns `status: 'failed'` with the error; sideview
  shows the failure.
- **User closes mid-task:** loop aborts, report `status: 'aborted'` ("browser closed by
  user"); chat agent relays it.
- **Action/navigation failure** (timeout, invalid coordinates, page crash): fed back to
  the model as observation text on the next turn; the loop continues.
- **Max turns:** forced terminate; report includes progress so far.
- **Model emits an invalid action:** observation text explains the parse failure;
  bounded retries before forced terminate.

## Testing

TDD throughout; reuse existing patterns:

- `BrowserAgentLoop` unit tests with a mock browser adapter (interface over the
  Playwright surface) and `mockResponses`-style scripted model output: success,
  terminate statuses, invalid actions, action failures, max turns, abort mid-task.
- Screenshot-window trimming: exactly 3 image parts retained, older text preserved.
- Action schema: zod parse success/failure and executor mapping per action.
- Status-server endpoint + SSE tests via `tests/helpers/sse-http.ts`: launch/close/state,
  screenshot/action/status events during a mocked task.
- Chat integration: `browser_task` exposure gated on `browserEnabled`, system prompt
  swap, report persistence as a tool-call message.
- One optional, gated real-Playwright smoke test (headed launch, navigate, screenshot,
  close) excluded from the default suite.
- Dashboard: sideview state transitions from SSE events.

## Future (out of scope for v1)

- Fara-9B (or 4B/27B) specialized preset: per-operation model selection (pattern:
  `ChatOperationPresetSelector`) routes browser tasks to the fara model with its
  official system prompt. Executor, action schema, transport unchanged.
- Interactive mid-task `ask_user_question` (pause/resume inside one task).
- Multiple browser profiles / concurrent browsers.
- Hard approval gates on irreversible actions.
