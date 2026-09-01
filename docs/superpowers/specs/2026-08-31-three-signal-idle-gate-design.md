# Three-signal idle gate — design

Date: 2026-08-31
Status: approved for planning
Supersedes the idle portion of `docs/handoff-2026-08-31-assistant-idle-and-capture-backlog.md` §6.

## 1. Problem

Assistant background work never runs. Queued work grows without bound: 31 queued jobs (all
`attempts = 0`, never claimed) and 1,065 pending captures at time of writing.

`AssistantJobRunner.drain()` calls `idleGate.evaluate()` at `src/assistant/jobs/job-runner.ts:114`,
*before* `claimNext`, and `break`s the entire drain when blocked. Nothing is claimed and nothing
executes. Capture intake is unaffected — `src/assistant/observation/capture-intake.ts` never
references the gate — so captures accumulate while nothing drains them.

The persisted decision history (`runtime_metadata` key `assistant.background_work_decisions.v1`,
owner-keyed, 100 entries) shows two blockers over a 33-minute window:

| Reason | Count | Detail |
| --- | --- | --- |
| `server_busy` | 74 | `isIdle(ctx)` false |
| `input_idle_below_threshold` | 26 | `inputIdleSeconds: 0` on every sample |

`server_busy` is self-clearing (it reflects genuine SiftKit model work). The idle failure is not.

### Root cause, measured

`WindowsActivityProvider::idle_seconds` (`desktop/src-tauri/src/platform/windows/activity.rs:145-155`)
uses `GetLastInputInfo`, which reports time since *any* session input, including all HID devices.

A Raw Input + low-level-hook probe run on this machine, 20 seconds with no physical input:

- `GetLastInputInfo`: reset on 97 of 97 samples, idle 0–16 ms continuously
- Raw Input (usages `0x02` mouse, `0x06` keyboard): **0 events**
- `WH_KEYBOARD_LL` / `WH_MOUSE_LL`: **0 events**, physical or injected
- Raw Input registered across every HID usage page: **4,996 events in 20 s (~250/s)** from a single
  device — `VID_045E&PID_028E&IG_00`, an Xbox 360 controller (XInput)

A second 15-second run with deliberate physical input recorded 197 raw mouse events, 22 raw keyboard
events, 285/22 hook events, and 0 injected events, from
`VID_1038&PID_184C` (mouse) and `VID_1038&PID_161A` (keyboard).

The controller emits input continuously with nobody touching it. `GetLastInputInfo` therefore can
never rise above 0 on this machine, so the `0 >= 180` comparison never passes. The arithmetic at
`activity.rs:154` is correct; the signal is wrong.

A separate defect: `GetLastInputInfo` returning `FALSE` silently returns `0` (`activity.rs:150-152`),
conflating unavailable telemetry with immediate user activity.

### Not the cause

Image capability was ruled out. The live applied preset — read from
`ctx.appliedModelPresetState.getPreset()` via `GET /runtime/inference`
(`src/status-server/routes/server-admin.ts:317`), not from config — is id `exl3-3-6-27b-2`
(label `EXL3 3.8_27B`, model `3.8_27b_4.9bpw`), backend `exl3`, `VisionEnabled: true`, process and
model both `ready`. `presetAcceptsImages` passes, and `image_capability_unavailable` appears zero
times in the last 100 decisions. The 8 captures in `awaiting_image_capability` (newest 18:35 today,
oldest 2026-08-30) are stale rows from earlier windows when the model was not ready; they clear on
the first successful drain via `enqueueWaitingCaptures` (`assistant-service.ts:745-767`), which
iterates both `queued` and `awaiting_image_capability`.

Note for future readers: preset id `exl3-3-6-27b-2` loads the 3.8/4.9bpw model, not a 3.6 model. The
id is misleading; trust the label and `Model` path.

## 2. Requirements

Background work is admitted only when all three signals have been quiet for
`Background.IdleSecondsBeforeProcessing` (currently 180 s):

1. No active or queued model request, and ≥ threshold since the last model request finished.
2. ≥ threshold since the last **mouse** input.
3. ≥ threshold since the last **keyboard** input.

Approved decisions:

- **Gamepad input is ignored entirely.** Only mouse and keyboard gate background work. Accepted
  consequence: controller-only gaming with no mouse/keyboard use for 180 s reads as idle.
- **Physical input only**, via Raw Input. Injected input is excluded by construction — `SendInput`
  events do not generate `WM_INPUT`.
- **Model quiet uses the full 180 s threshold**, the same value as mouse and keyboard.
- **Server startup requires one full threshold** before model-quiet can be satisfied.

## 3. Architecture

### 3.1 Desktop shell — long-lived input tracker (Rust)

New module `desktop/src-tauri/src/platform/windows/input_tracker.rs`.

`WindowsInputTracker::start() -> Result<WindowsInputTracker, String>` spawns a dedicated thread that:

1. Creates a message-only window (`HWND_MESSAGE`).
2. Calls `RegisterRawInputDevices` for usage page `0x01`, usages `0x02` (mouse) and `0x06`
   (keyboard), with `RIDEV_INPUTSINK` so input is received without foreground focus.
3. Runs a `GetMessageW` loop. On `WM_INPUT`, reads the `RAWINPUTHEADER` and stores `GetTickCount()`
   into `last_mouse_tick` or `last_keyboard_tick` (`AtomicU32`, `Ordering::Relaxed`) based on
   `header.dwType`.

No other usage page is registered, so the Xbox controller and every other non-mouse/keyboard HID
device is invisible to the tracker by construction.

`snapshot() -> InputIdleSnapshot { mouse_seconds: u32, keyboard_seconds: u32 }` computes
`GetTickCount().wrapping_sub(stored) / 1000` per signal. Both timestamps seed to the tracker's start
tick, so idle time counts from shell start rather than reporting a spurious large value.

**Failure is loud.** Window creation or `RegisterRawInputDevices` failure returns `Err` from
`start()`, and the worker loop propagates it. There is no fallback to `GetLastInputInfo`, no
zero-on-failure branch, and no parallel path. `GetLastInputInfo` is removed from the codebase.

### 3.2 Ownership change

`WindowsActivityProvider` is a zero-state unit struct reconstructed on every tick
(`desktop/src-tauri/src/main.rs:295`, once per second per `main.rs:435`). The tracker is stateful and
must outlive ticks, so:

- `fn idle_seconds(&self) -> u32` is **removed** from `NativeActivityProvider`
  (`desktop/src-tauri/src/platform/mod.rs:34-42`). That trait keeps only its stateless OS queries
  (`foreground`, `session_locked`, `secure_desktop_active`).
- The tracker is created once in the Tauri `setup` closure alongside the worker thread spawn
  (`main.rs:681`) and passed explicitly into `worker_loop` and `observation_tick`
  (`main.rs:294-308`). No globals, no `OnceLock`.
- `ObservationTick.idle_seconds: u32` becomes `mouse_idle_seconds: u32` and
  `keyboard_idle_seconds: u32`.

### 3.3 Wire contract — full field replacement

No combined input field survives on the wire. Both DTOs carry the two signals separately.

| Location | Before | After |
| --- | --- | --- |
| `desktop/src-tauri/src/contracts.rs:76` | `seconds_since_input: u32` | `seconds_since_mouse_input: u32`, `seconds_since_keyboard_input: u32` |
| `desktop/src-tauri/src/contracts.rs:51` | `idle_seconds: u32` | `mouse_idle_seconds: u32`, `keyboard_idle_seconds: u32` |
| `packages/contracts/src/assistant-desktop.ts:51` | `secondsSinceInput` | `secondsSinceMouseInput`, `secondsSinceKeyboardInput` |
| `packages/contracts/src/assistant-desktop.ts:31` | `idleSeconds` | `mouseIdleSeconds`, `keyboardIdleSeconds` |

Both DTOs remain `#[serde(deny_unknown_fields)]` / `.strict()`, so a stale shell sending the old
field fails validation loudly at `src/status-server/routes/assistant/ingest-routes.ts:35`.

Golden fixtures updated: `desktop/contract-fixtures/environment-state.json` and
`desktop/contract-fixtures/activity-event.json`. Both are round-tripped by
`desktop/src-tauri/src/contracts.rs:239` and `tests/assistant-desktop-contracts.test.ts:27`.

Emission sites: `desktop/src-tauri/src/observation/heartbeat.rs:91` and `:111`.

### 3.4 TypeScript consumers

- `src/assistant/observation/environment-cache.ts:48` — `readInputIdleSeconds(): number | null`
  becomes `readInputIdle(): { mouse: number; keyboard: number } | null`. One method returning both
  keeps the staleness check (`:83-87`, 60 s per `assistant-desktop.ts:41`) in a single place.
- `src/assistant/observation/environment-cache.ts:69` — `read()` copies both fields into
  `QuestionEnvironmentState`; `src/assistant/questions/environment-state.ts:12` gains both.
- `src/assistant/assistant-service.ts:497-499` — `desktopInputIdleSeconds()` becomes
  `desktopInputIdle()`, returning the pair.
- `src/assistant/questions/policy-engine.ts:150` — question suppression keeps its current combined
  meaning by deriving `Math.min(mouse, keyboard)` at the comparison site. This is a derivation, not
  a retained contract field.

### 3.5 Idle gate

`src/status-server/assistant-idle-gate.ts` — `evaluateIdleDecision` becomes an ordered truth table
evaluated top to bottom, first match wins:

| # | Condition | Result |
| --- | --- | --- |
| 1 | `!isIdle(ctx)` | blocked `server_busy` |
| 2 | input idle unavailable (stale/missing heartbeat) | blocked `environment_heartbeat_missing` |
| 3 | `now - lastModelActivityMs < threshold` | blocked `model_recently_active` |
| 4 | `mouse < threshold` | blocked `mouse_idle_below_threshold` |
| 5 | `keyboard < threshold` | blocked `keyboard_idle_below_threshold` |
| 6 | otherwise | `allowed` |

Ordering rationale: cheap synchronous server state first, then data availability, then the three
quiet conditions. Each blocked branch persists its own `details` so the dashboard history identifies
which signal is holding.

Reason enum changes in `packages/contracts/src/assistant.ts:18-32`:

- **Removed:** `input_idle_below_threshold` (deleted, not deprecated — no parallel path)
- **Added:** `model_recently_active`, `mouse_idle_below_threshold`, `keyboard_idle_below_threshold`

Details payloads:

- `model_recently_active`: `{ secondsSinceModelActivity, requiredIdleSeconds }`
- `mouse_idle_below_threshold`: `{ mouseIdleSeconds, requiredIdleSeconds }`
- `keyboard_idle_below_threshold`: `{ keyboardIdleSeconds, requiredIdleSeconds }`

### 3.6 Model quiet and startup semantics

`isIdle(ctx)` (`src/status-server/server-ops.ts:168-172`) already covers `hasActiveRuns`,
`activeModelRequests.size === 0`, and `modelRequestQueue.length === 0`. Condition 3 adds only the
elapsed-time requirement.

`ServerContext.terminalMetadata` gains `serverStartedAtMs: number`
(`src/status-server/server-types.ts`), set once at context construction. Condition 3 evaluates
against `lastModelRequestFinishedAtMs ?? serverStartedAtMs`, which yields the approved "one full
threshold after startup" with no null branch in the gate.

`lastModelRequestFinishedAtMs` is **not** seeded to a non-null value. Its null-ness is load-bearing
at `src/status-server/server-ops.ts:329`, and changing it would alter unrelated behavior. It
continues to be written only by `releaseModelRequest` (`server-ops.ts:592`).

### 3.7 Dashboard

`dashboard/src/tabs/settings/AssistantSettings.tsx` and `dashboard/src/assistant-api.ts` render the
three new reasons and drop the removed one. Reason labels state which signal is blocking and for how
long.

## 4. Error handling

| Failure | Behavior |
| --- | --- |
| Tracker window creation or registration fails | `start()` returns `Err`; shell startup fails loudly. No fallback. |
| Heartbeat stale (> 60 s) | `readInputIdle()` returns `null` → `environment_heartbeat_missing`. Unchanged semantics. |
| Shell sends old field name | Zod `.strict()` / serde `deny_unknown_fields` rejects at ingest. |
| `GetTickCount` 32-bit wrap | `wrapping_sub` yields correct elapsed time across the wrap. |
| Gate blocked mid-drain | Existing behavior retained: `break`, record decision, jobs stay `queued`, nothing requeued or failed (`job-runner.ts:115-118`, `192-198`). |

## 5. Testing

TDD: each test below is written failing before the corresponding implementation.

**Rust**

- `snapshot()` reports mouse and keyboard independently; stamping one does not move the other.
- Elapsed arithmetic across a `GetTickCount` wrap boundary.
- Seeded start: a tracker with no observed input reports elapsed-since-start, not zero and not a
  garbage value.
- `start()` failure returns `Err` rather than a tracker reporting zero.
- Golden fixture round-trip for both updated fixtures (`contracts.rs:239`).

**TypeScript**

- `EnvironmentStateDtoSchema` and `ActivityEventDtoSchema` reject the old field names and require
  both new ones.
- `environment-cache`: fresh heartbeat returns both values; stale (> 60 s) returns `null`.
- `evaluateIdleDecision`: all six branches, including exact-threshold boundaries
  (`seconds === threshold` is allowed, `threshold - 1` is blocked) and correct precedence when
  several conditions fail at once.
- Startup: with `lastModelRequestFinishedAtMs === null`, blocked before
  `serverStartedAtMs + threshold` and allowed after.
- `policy-engine`: suppression uses `min(mouse, keyboard)`.

Existing tests to update: `tests/assistant-idle-gate.test.ts:71`,
`tests/assistant-environment-cache.test.ts:28,48,56`, `tests/assistant-gate-d-e2e.test.ts:156,437`,
`tests/assistant-question-policy.test.ts:30,132`, `tests/assistant-question-scheduler.test.ts:74`,
`tests/assistant-service.test.ts:244`, `tests/assistant-desktop-contracts.test.ts`,
`tests/helpers/assistant-gates.ts`, `dashboard/tests/assistant-settings.test.tsx`.

**Live acceptance**

With the Xbox controller still connected, leave mouse and keyboard untouched for more than 180 s
while no model work runs. Expect: `secondsSinceMouseInput` and `secondsSinceKeyboardInput` both rise
past 180, the gate returns `allowed`, queued jobs begin claiming (`attempts` > 0), and the pending
capture count falls.

## 6. Out of scope

- **Drain throughput.** This gate fix unblocks execution but does not clear the backlog.
  `MaxJobsPerIdleSession = 20` is not the constraint: despite its name it is `maxJobsPerDrain`
  (`assistant-service.ts:190,345`), applied per drain, and drains run every 20 s on a fixed timer
  (`ASSISTANT_DRAIN_INTERVAL_MS = 20_000`, `index.ts:146,398`) — a ceiling of 60 jobs/min.

  The binding constraint is `MaxGpuMinutesPerDay = 60`, enforced by `canStartModelWork()` with
  reason `daily_gpu_limit` (`resource-policy.ts:87-89`) and tracked per local date in
  `runtime_metadata` key `assistant.gpu_usage.v1`. Measured on 2026-08-28: 1,085,343 ms (18.1 min)
  across 99 completed `image_extraction` jobs, ≈ 11 s GPU per capture. A 60-minute daily budget
  therefore affords ≈ 327 captures/day against a measured inflow of 1.15 captures/min (≈ 1,650/day)
  — roughly a 5× deficit, growing the backlog ~1,300/day regardless of this fix.

  Resolving it requires raising the GPU budget, reducing capture inflow, or reducing per-extraction
  cost. That is a separate design conversation and is not addressed here.
- **Job list endpoint.** The dashboard's "Pending validation" count is not the job queue, and no
  general job-list endpoint exists.
- **The controller itself.** Whether to fix the drifting device is the user's call, not a code
  change. The design makes the assistant immune to it either way.
- Non-Windows platforms. `WindowsActivityProvider` is the only implementation of
  `NativeActivityProvider` in the tree; no macOS, Linux, or fake implementation exists.

## 7. Uncommitted work this builds on

The persisted background-decision diagnostics feature is present in the working tree and uncommitted.
This design extends its reason enum and details payloads. Files listed in
`docs/handoff-2026-08-31-assistant-idle-and-capture-backlog.md` §8 must be preserved.
