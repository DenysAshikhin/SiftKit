# Three-Signal Idle Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `GetLastInputInfo` idle signal with a Raw Input mouse/keyboard tracker and gate background work on three independent quiet signals: model, mouse, keyboard.

**Architecture:** The Tauri shell gains a long-lived Raw Input tracker thread (message-only window, usages 0x02/0x06, `RIDEV_INPUTSINK`) that stamps `GetTickCount()` per signal into atomics. Both desktop DTOs carry the two signals as separate fields (full replacement, no combined field). The daemon's idle gate becomes a six-branch ordered truth table; question suppression and the activity log derive `min(mouse, keyboard)` at their use sites. Model quiet is measured from `lastModelRequestFinishedAtMs ?? serverStartedAtMs`.

**Tech Stack:** Rust (`windows` 0.61, Tauri 2), TypeScript (zod, node:test), React dashboard.

**Spec:** `docs/superpowers/specs/2026-08-31-three-signal-idle-gate-design.md`. Decisions taken after the spec: the activity-log column `assistant_activity_events.idle_seconds` stays and stores `min(mouse, keyboard)` (user decision); `WM_INPUT` events with a null `hDevice` (injected input) are dropped.

**Commands:**

- Rust tests: `npm run desktop:test` (portable toolchain; `cargo test` on `desktop/src-tauri`).
- One TS test file: `npx tsx --test tests/<file>.test.ts`
- Dashboard tests: `npm run test:dashboard`
- Full TS suite: `npm run build:test && npm run test`
- `npm run typecheck` (includes lint), `npm run lint`

**Cross-language note:** `desktop/contract-fixtures/*.json` is read by both the Rust golden test and `tests/assistant-desktop-contracts.test.ts`. Task 3 updates the fixtures for Rust; the TS contracts test is expected red until Task 4 lands. Do not commit between Task 3 and Task 4.

---

## File structure

| File | Responsibility |
| --- | --- |
| `desktop/src-tauri/src/platform/windows/input_tracker.rs` (new) | `InputIdleTimestamps` (pure tick arithmetic, testable) + `WindowsInputTracker` (Win32 thread) |
| `desktop/src-tauri/src/platform/windows/mod.rs` | export the new module |
| `desktop/src-tauri/Cargo.toml` | add `Win32_UI_Input`, `Win32_System_LibraryLoader` features |
| `desktop/src-tauri/src/platform/mod.rs` | drop `idle_seconds` from `NativeActivityProvider` |
| `desktop/src-tauri/src/platform/windows/activity.rs` | drop `idle_seconds` impl and `GetLastInputInfo` |
| `desktop/src-tauri/src/contracts.rs` | DTO field split |
| `desktop/src-tauri/src/observation/heartbeat.rs` | `ObservationTick` field split, emission |
| `desktop/src-tauri/src/main.rs` | create tracker in `setup`, thread into `worker_loop`/`observation_tick` |
| `desktop/contract-fixtures/environment-state.json`, `activity-event.json` | golden fixtures |
| `packages/contracts/src/assistant-desktop.ts` | zod DTO field split |
| `packages/contracts/src/assistant.ts` | reason enum |
| `src/assistant/observation/environment-cache.ts` | `readInputIdle()` |
| `src/assistant/questions/environment-state.ts` | two fields |
| `src/assistant/assistant-service.ts` | `desktopInputIdle()` |
| `src/assistant/questions/policy-engine.ts` | `min()` at suppression |
| `src/assistant/observation/activity-log.ts` | `min()` into the existing column |
| `src/status-server/assistant-idle-gate.ts` | six-branch truth table |
| `src/status-server/server-types.ts`, `src/status-server/index.ts`, `tests/helpers/server-context-fixture.ts` | `serverStartedAtMs` |
| `dashboard/src/tabs/settings/AssistantSettings.tsx` | reason labels |

---

### Task 1: Pure input-idle timestamps (Rust)

**Files:**
- Create: `desktop/src-tauri/src/platform/windows/input_tracker.rs`
- Modify: `desktop/src-tauri/src/platform/windows/mod.rs`

- [x] **Step 1: Write the failing tests**

Create `desktop/src-tauri/src/platform/windows/input_tracker.rs` with only the test module:

```rust
//! Raw Input mouse/keyboard idle tracking (three-signal idle gate design §3.1). Gamepads and every
//! other HID usage are invisible by construction: only usages 0x02 and 0x06 are registered.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_timestamps_report_elapsed_since_start_for_both_signals() {
        let timestamps = InputIdleTimestamps::seeded(10_000);
        assert_eq!(
            timestamps.snapshot_at(15_999),
            InputIdleSnapshot { mouse_seconds: 5, keyboard_seconds: 5 },
        );
    }

    #[test]
    fn stamping_one_signal_does_not_move_the_other() {
        let timestamps = InputIdleTimestamps::seeded(0);
        timestamps.stamp_mouse(30_000);
        assert_eq!(
            timestamps.snapshot_at(31_000),
            InputIdleSnapshot { mouse_seconds: 1, keyboard_seconds: 31 },
        );
        timestamps.stamp_keyboard(40_000);
        assert_eq!(
            timestamps.snapshot_at(40_500),
            InputIdleSnapshot { mouse_seconds: 10, keyboard_seconds: 0 },
        );
    }

    #[test]
    fn elapsed_is_correct_across_a_tick_count_wrap() {
        let timestamps = InputIdleTimestamps::seeded(u32::MAX - 500);
        assert_eq!(
            timestamps.snapshot_at(1_500),
            InputIdleSnapshot { mouse_seconds: 2, keyboard_seconds: 2 },
        );
    }
}
```

Add `pub mod input_tracker;` to `desktop/src-tauri/src/platform/windows/mod.rs` after `pub mod activity;`.

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run desktop:test 2>&1 | siftkit summary --question "Return pass/fail and the compile errors for input_tracker.rs only."`
Expected: FAIL, `InputIdleTimestamps` and `InputIdleSnapshot` not found.

- [x] **Step 3: Write the minimal implementation**

Insert above the `#[cfg(test)]` module:

```rust
use std::sync::atomic::{AtomicU32, Ordering};

/// Seconds since the last physical input, one value per signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputIdleSnapshot {
    pub mouse_seconds: u32,
    pub keyboard_seconds: u32,
}

/// `GetTickCount` stamps of the last mouse and keyboard input. Pure: callers pass tick values, so
/// the arithmetic (including the 49.7-day wrap) is testable without Win32.
#[derive(Debug)]
pub struct InputIdleTimestamps {
    last_mouse_tick: AtomicU32,
    last_keyboard_tick: AtomicU32,
}

impl InputIdleTimestamps {
    /// Both signals start at `start_tick`, so idle counts from shell start instead of reporting a
    /// spurious large value before the first input arrives.
    pub fn seeded(start_tick: u32) -> Self {
        Self {
            last_mouse_tick: AtomicU32::new(start_tick),
            last_keyboard_tick: AtomicU32::new(start_tick),
        }
    }

    pub fn stamp_mouse(&self, tick: u32) {
        self.last_mouse_tick.store(tick, Ordering::Relaxed);
    }

    pub fn stamp_keyboard(&self, tick: u32) {
        self.last_keyboard_tick.store(tick, Ordering::Relaxed);
    }

    pub fn snapshot_at(&self, now_tick: u32) -> InputIdleSnapshot {
        InputIdleSnapshot {
            mouse_seconds: now_tick.wrapping_sub(self.last_mouse_tick.load(Ordering::Relaxed)) / 1000,
            keyboard_seconds: now_tick.wrapping_sub(self.last_keyboard_tick.load(Ordering::Relaxed))
                / 1000,
        }
    }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run desktop:test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, and any warnings."`
Expected: PASS, three `input_tracker::tests::*` tests green, no warnings.

- [x] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/platform/windows/input_tracker.rs desktop/src-tauri/src/platform/windows/mod.rs
git commit -m "feat(shell): pure mouse/keyboard idle timestamps"
```

---

### Task 2: Raw Input tracker thread (Rust, Win32)

**Files:**
- Modify: `desktop/src-tauri/src/platform/windows/input_tracker.rs`
- Modify: `desktop/src-tauri/Cargo.toml:26-46`

- [x] **Step 1: Write the failing test**

Append inside `mod tests` in `input_tracker.rs`:

```rust
    #[test]
    fn tracker_starts_and_reports_seeded_idle_for_both_signals() {
        let tracker = WindowsInputTracker::start().expect("tracker starts");
        let snapshot = tracker.snapshot().expect("tracker alive");
        assert!(snapshot.mouse_seconds < 5, "mouse idle counts from start: {snapshot:?}");
        assert!(snapshot.keyboard_seconds < 5, "keyboard idle counts from start: {snapshot:?}");
        // One tracker per process: the second class registration fails, and that failure must
        // surface as `Err` rather than a tracker that reports zero.
        assert!(WindowsInputTracker::start().is_err(), "a second tracker must fail loudly");
    }
```

- [x] **Step 2: Run tests to verify it fails**

Run: `npm run desktop:test 2>&1 | siftkit summary --question "Return pass/fail and compile errors for input_tracker.rs only."`
Expected: FAIL, `WindowsInputTracker` not found.

- [x] **Step 3: Add the windows features**

In `desktop/src-tauri/Cargo.toml`, add to the `[dependencies.windows] features` list, keeping alphabetical order:

```toml
  "Win32_System_LibraryLoader",
  "Win32_UI_Input",
```

- [x] **Step 4: Write the tracker**

Replace the `use` line at the top of `input_tracker.rs` and add the tracker above `InputIdleSnapshot`:

```rust
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER,
    RIDEV_INPUTSINK, RID_HEADER, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowLongPtrW,
    RegisterClassW, SetWindowLongPtrW, GWLP_USERDATA, HWND_MESSAGE, MSG, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_INPUT, WNDCLASSW,
};

const CLASS_NAME: PCWSTR = w!("SiftKitInputTracker");
const HID_USAGE_PAGE_GENERIC: u16 = 0x01;
const HID_USAGE_GENERIC_MOUSE: u16 = 0x02;
const HID_USAGE_GENERIC_KEYBOARD: u16 = 0x06;

/// Owns the Raw Input thread. Created once at shell startup and passed explicitly to the worker
/// loop; there is no `GetLastInputInfo` fallback anywhere.
pub struct WindowsInputTracker {
    timestamps: Arc<InputIdleTimestamps>,
    alive: Arc<AtomicBool>,
}

impl WindowsInputTracker {
    /// Spawns the message loop and blocks until Raw Input registration succeeds or fails.
    /// `Err` means the shell cannot report idleness; callers must fail startup, not degrade.
    pub fn start() -> Result<Self, String> {
        let timestamps = Arc::new(InputIdleTimestamps::seeded(unsafe { GetTickCount() }));
        let alive = Arc::new(AtomicBool::new(true));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let loop_timestamps = timestamps.clone();
        let loop_alive = alive.clone();
        std::thread::Builder::new()
            .name("siftkit-input-tracker".into())
            .spawn(move || {
                let outcome = run_message_loop(&loop_timestamps, &ready_tx);
                loop_alive.store(false, Ordering::Relaxed);
                if let Err(error) = outcome {
                    eprintln!("input tracker stopped: {error}");
                }
            })
            .map_err(|error| format!("input tracker thread: {error}"))?;
        ready_rx
            .recv()
            .map_err(|_| "input tracker exited before registering".to_string())??;
        Ok(Self { timestamps, alive })
    }

    /// `Err` once the message loop has died: a stale snapshot would read as ever-growing idleness,
    /// which is exactly the wrong-signal failure this tracker exists to remove.
    pub fn snapshot(&self) -> Result<InputIdleSnapshot, String> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err("input tracker thread has exited".into());
        }
        Ok(self.timestamps.snapshot_at(unsafe { GetTickCount() }))
    }
}

fn run_message_loop(
    timestamps: &Arc<InputIdleTimestamps>,
    ready: &Sender<Result<(), String>>,
) -> Result<(), String> {
    let registered = create_message_window(timestamps).and_then(register_mouse_and_keyboard);
    if let Err(error) = registered {
        let _ = ready.send(Err(error.clone()));
        return Err(error);
    }
    let _ = ready.send(Ok(()));

    let mut message = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if result.0 == -1 {
            return Err(format!("GetMessageW failed: {:?}", unsafe { GetLastError() }));
        }
        if result.0 == 0 {
            return Err("message loop received WM_QUIT".into());
        }
        unsafe { DispatchMessageW(&message) };
    }
}

/// A message-only window whose `GWLP_USERDATA` points at the timestamps. The `Arc` outlives the
/// window because `run_message_loop` holds it for the loop's whole lifetime.
fn create_message_window(timestamps: &Arc<InputIdleTimestamps>) -> Result<HWND, String> {
    let module = unsafe { GetModuleHandleW(None) }
        .map_err(|error| format!("GetModuleHandleW: {error}"))?;
    let instance = HINSTANCE(module.0);
    let class = WNDCLASSW {
        lpfnWndProc: Some(input_window_proc),
        hInstance: instance,
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        return Err(format!("RegisterClassW failed: {:?}", unsafe { GetLastError() }));
    }
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            CLASS_NAME,
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )
    }
    .map_err(|error| format!("CreateWindowExW: {error}"))?;
    unsafe { SetWindowLongPtrW(window, GWLP_USERDATA, Arc::as_ptr(timestamps) as isize) };
    Ok(window)
}

/// Usage page 0x01, usages 0x02 (mouse) and 0x06 (keyboard) only. `RIDEV_INPUTSINK` delivers
/// input without foreground focus.
fn register_mouse_and_keyboard(window: HWND) -> Result<(), String> {
    let device = |usage: u16| RAWINPUTDEVICE {
        usUsagePage: HID_USAGE_PAGE_GENERIC,
        usUsage: usage,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: window,
    };
    let devices = [device(HID_USAGE_GENERIC_MOUSE), device(HID_USAGE_GENERIC_KEYBOARD)];
    let size = u32::try_from(std::mem::size_of::<RAWINPUTDEVICE>()).expect("size fits");
    unsafe { RegisterRawInputDevices(&devices, size) }
        .map_err(|error| format!("RegisterRawInputDevices: {error}"))
}

unsafe extern "system" fn input_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_INPUT {
        let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *const InputIdleTimestamps;
        if let Some(timestamps) = pointer.as_ref() {
            let mut header = RAWINPUTHEADER::default();
            let mut size = u32::try_from(std::mem::size_of::<RAWINPUTHEADER>()).expect("size fits");
            let copied = GetRawInputData(
                HRAWINPUT(lparam.0 as _),
                RID_HEADER,
                Some((&mut header as *mut RAWINPUTHEADER).cast()),
                &mut size,
                size,
            );
            // Injected input (SendInput) arrives with a null device handle; only physical devices
            // count as user activity.
            if copied == size && !header.hDevice.0.is_null() {
                let tick = GetTickCount();
                if header.dwType == RIM_TYPEMOUSE.0 {
                    timestamps.stamp_mouse(tick);
                } else if header.dwType == RIM_TYPEKEYBOARD.0 {
                    timestamps.stamp_keyboard(tick);
                }
            }
        }
    }
    DefWindowProcW(window, message, wparam, lparam)
}
```

If the compiler rejects a signature, fix it against the local crate source at `C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\cargo\registry\src\index.crates.io-1949cf8c6b5b557f\windows-0.61.1\src\Windows\Win32\UI\Input\mod.rs` and `...\UI\WindowsAndMessaging\mod.rs`. Do not change the behavior.

- [x] **Step 5: Run tests to verify they pass**

Run: `npm run desktop:test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, compile errors, and warnings."`
Expected: PASS, four `input_tracker::tests::*` green, no warnings.

- [x] **Step 6: Commit**

```bash
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/src/platform/windows/input_tracker.rs
git commit -m "feat(shell): Raw Input mouse/keyboard tracker thread"
```

---

### Task 3: Shell wire split and tracker ownership (Rust)

**Files:**
- Modify: `desktop/src-tauri/src/contracts.rs:47-54, 68-78`
- Modify: `desktop/contract-fixtures/environment-state.json`, `desktop/contract-fixtures/activity-event.json`
- Modify: `desktop/src-tauri/src/observation/heartbeat.rs:15-25, 91, 111, 140`
- Modify: `desktop/src-tauri/src/platform/mod.rs:34-42`
- Modify: `desktop/src-tauri/src/platform/windows/activity.rs:1, 12, 17, 145-155`
- Modify: `desktop/src-tauri/src/main.rs:24-26, 294-308, 311, 402, 679-681`

- [x] **Step 1: Write the failing tests**

In `desktop/contract-fixtures/environment-state.json` replace `"secondsSinceInput": 4,` with:

```json
  "secondsSinceMouseInput": 4,
  "secondsSinceKeyboardInput": 9,
```

In `desktop/contract-fixtures/activity-event.json` replace `"idleSeconds": 4,` with:

```json
  "mouseIdleSeconds": 4,
  "keyboardIdleSeconds": 9,
```

In `heartbeat.rs` tests, change the `tick` helper's `idle_seconds: 3,` to:

```rust
            mouse_idle_seconds: 3,
            keyboard_idle_seconds: 7,
```

and add this test after `environment_emits_every_interval_and_not_between`:

```rust
    #[test]
    fn both_input_signals_reach_both_dtos_separately() {
        let mut heartbeat = Heartbeat::new();
        let emissions = heartbeat.tick(&tick(0, Some(sample("SiftKit - Code"))));
        let environment = emissions.iter().find_map(|emission| match emission {
            HeartbeatEmission::Environment(env) => Some(env),
            HeartbeatEmission::Activity(_) => None,
        });
        let activity = emissions.iter().find_map(|emission| match emission {
            HeartbeatEmission::Activity(event) => Some(event),
            HeartbeatEmission::Environment(_) => None,
        });
        let environment = environment.expect("environment");
        let activity = activity.expect("activity");
        assert_eq!(environment.seconds_since_mouse_input, 3);
        assert_eq!(environment.seconds_since_keyboard_input, 7);
        assert_eq!(activity.mouse_idle_seconds, 3);
        assert_eq!(activity.keyboard_idle_seconds, 7);
    }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run desktop:test 2>&1 | siftkit summary --question "Return pass/fail and the first compile error per file."`
Expected: FAIL, unknown fields `mouse_idle_seconds` / `seconds_since_mouse_input`.

- [x] **Step 3: Split the DTO fields**

`contracts.rs`, `ActivityEventDto`: replace `pub idle_seconds: u32,` with:

```rust
    pub mouse_idle_seconds: u32,
    pub keyboard_idle_seconds: u32,
```

`contracts.rs`, `EnvironmentStateDto`: replace `pub seconds_since_input: u32,` with:

```rust
    pub seconds_since_mouse_input: u32,
    pub seconds_since_keyboard_input: u32,
```

- [x] **Step 4: Split `ObservationTick` and the emissions**

`heartbeat.rs`, `ObservationTick`: replace `pub idle_seconds: u32,` with:

```rust
    pub mouse_idle_seconds: u32,
    pub keyboard_idle_seconds: u32,
```

Environment emission: replace `seconds_since_input: tick.idle_seconds,` with:

```rust
                seconds_since_mouse_input: tick.mouse_idle_seconds,
                seconds_since_keyboard_input: tick.keyboard_idle_seconds,
```

Activity emission: replace `idle_seconds: tick.idle_seconds,` with:

```rust
                    mouse_idle_seconds: tick.mouse_idle_seconds,
                    keyboard_idle_seconds: tick.keyboard_idle_seconds,
```

- [x] **Step 5: Remove `idle_seconds` from the activity provider**

`platform/mod.rs`: delete the line `fn idle_seconds(&self) -> u32;` from `NativeActivityProvider`.

`activity.rs`: delete the whole `fn idle_seconds(&self) -> u32 { ... }` method (lines 145-155). Delete the import `use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};`. Delete `use windows::Win32::System::SystemInformation::GetTickCount;` if nothing else in the file uses `GetTickCount` (check with `grep -n GetTickCount desktop/src-tauri/src/platform/windows/activity.rs`). Update the module doc on line 1 from `Foreground/idle/lock adapters` to `Foreground/lock adapters`.

- [x] **Step 6: Own the tracker in `main.rs`**

Add the import after the `activity::{...}` import block:

```rust
use siftkit_assistant_shell_lib::platform::windows::input_tracker::WindowsInputTracker;
```

Replace `observation_tick`:

```rust
fn observation_tick(paused: bool, input: &WindowsInputTracker) -> ObservationTick {
    let activity = WindowsActivityProvider;
    let notifications = WindowsNotificationProvider;
    let power = WindowsPowerStateProvider;
    let idle = input.snapshot().unwrap_or_else(|error| {
        // No fallback signal exists; a shell that cannot report idleness must not keep
        // heartbeating a guess.
        eprintln!("input tracker failed: {error}; shell exiting");
        std::process::exit(1);
    });
    ObservationTick {
        now_epoch_seconds: now_epoch_seconds(),
        now_utc: iso8601_now(),
        paused,
        foreground: activity.foreground().ok(),
        mouse_idle_seconds: idle.mouse_seconds,
        keyboard_idle_seconds: idle.keyboard_seconds,
        session_locked: activity.session_locked(),
        notification: notifications.read(),
        power: power.read(),
    }
}
```

Change the `worker_loop` signature to `fn worker_loop(app: AppHandle, state: std::sync::Arc<ShellState>, input: WindowsInputTracker)` and the call at line 402 to `let tick = observation_tick(effective_paused, &input);`.

In the `setup` closure, replace the two lines that spawn the worker with:

```rust
            let input = WindowsInputTracker::start()?;
            let worker_state = state.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || worker_loop(handle, worker_state, input));
```

- [x] **Step 7: Verify no old signal remains**

Run: `grep -rn "GetLastInputInfo\|LASTINPUTINFO\|idle_seconds\b\|seconds_since_input\b" desktop/src-tauri/src`
Expected: no output.

- [x] **Step 8: Run tests to verify they pass**

Run: `npm run desktop:test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, compile errors, and warnings."`
Expected: PASS including `golden_fixtures_parse_and_round_trip` and `both_input_signals_reach_both_dtos_separately`, no warnings.

Run: `npx tsx --test tests/assistant-desktop-contracts.test.ts 2>&1 | tail -5`
Expected: FAIL on the two updated fixtures (resolved in Task 4).

- [x] **Step 9: Do not commit yet** (see cross-language note). Proceed to Task 4.

---

### Task 4: Daemon wire split, consumers, five-branch gate, dashboard (TypeScript)

**Files:**
- Modify: `packages/contracts/src/assistant-desktop.ts:31, 51`
- Modify: `packages/contracts/src/assistant.ts:18-32`
- Modify: `src/assistant/observation/environment-cache.ts:45-49, 60-70`
- Modify: `src/assistant/questions/environment-state.ts:12`
- Modify: `src/assistant/assistant-service.ts:496-499`
- Modify: `src/assistant/questions/policy-engine.ts:150`
- Modify: `src/assistant/observation/activity-log.ts:69`
- Modify: `src/status-server/assistant-idle-gate.ts`
- Modify: `dashboard/src/tabs/settings/AssistantSettings.tsx:44`
- Test: `tests/assistant-desktop-contracts.test.ts`, `tests/assistant-idle-gate.test.ts`, `tests/assistant-environment-cache.test.ts:28,48,56`, `tests/assistant-gate-d-e2e.test.ts:156,164,437`, `tests/assistant-question-policy.test.ts:30,132`, `tests/assistant-question-scheduler.test.ts:74`, `tests/assistant-service.test.ts:232,244`, `tests/assistant-activity-log.test.ts:26,51`, `dashboard/tests/assistant-settings.test.tsx:246-249,267,271`

- [x] **Step 1: Write the failing contract test**

Append to `tests/assistant-desktop-contracts.test.ts`:

```ts
test('desktop DTOs carry mouse and keyboard idleness separately and reject the old combined field', () => {
  const environment = readFixture('environment-state.json');
  const activity = readFixture('activity-event.json');
  assert.ok(environment !== null && typeof environment === 'object' && !Array.isArray(environment));
  assert.ok(activity !== null && typeof activity === 'object' && !Array.isArray(activity));

  const { secondsSinceMouseInput, secondsSinceKeyboardInput, ...environmentRest } = environment;
  assert.equal(secondsSinceMouseInput, 4);
  assert.equal(secondsSinceKeyboardInput, 9);
  assert.equal(EnvironmentStateDtoSchema.safeParse(environmentRest).success, false);
  assert.equal(
    EnvironmentStateDtoSchema.safeParse({ ...environmentRest, secondsSinceInput: 4 }).success,
    false,
  );

  const { mouseIdleSeconds, keyboardIdleSeconds, ...activityRest } = activity;
  assert.equal(mouseIdleSeconds, 4);
  assert.equal(keyboardIdleSeconds, 9);
  assert.equal(ActivityEventDtoSchema.safeParse(activityRest).success, false);
  assert.equal(ActivityEventDtoSchema.safeParse({ ...activityRest, idleSeconds: 4 }).success, false);
});
```

- [x] **Step 2: Write the failing gate tests**

Replace the first test in `tests/assistant-idle-gate.test.ts` with:

```ts
test('idle requires mouse and keyboard quiet for the full threshold, mouse checked first', () => {
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 180, keyboard: 180 }, 180), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 179, keyboard: 500 }, 180), {
    kind: 'blocked',
    reason: 'mouse_idle_below_threshold',
    details: { mouseIdleSeconds: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 500, keyboard: 179 }, 180), {
    kind: 'blocked',
    reason: 'keyboard_idle_below_threshold',
    details: { keyboardIdleSeconds: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 0, keyboard: 0 }, 180), {
    kind: 'blocked',
    reason: 'mouse_idle_below_threshold',
    details: { mouseIdleSeconds: 0, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 500, keyboard: 500 }, 180), { kind: 'allowed' });
});
```

Replace the last test in that file (`the environment cache exposes input idleness only while heartbeats are fresh`) with:

```ts
test('the environment cache exposes both input signals only while heartbeats are fresh', async () => {
  const { DesktopEnvironmentCache } = await import('../src/assistant/observation/environment-cache.js');
  const { FixedClock } = await import('../src/assistant/clock.js');
  const clock = new FixedClock('2026-08-28T09:00:00.000Z');
  const cache = new DesktopEnvironmentCache(clock);

  assert.equal(cache.readInputIdle(), null);

  cache.ingest({
    schemaVersion: 1,
    capturedAtUtc: clock.nowUtc(),
    fullscreen: false,
    locked: false,
    doNotDisturb: false,
    presenting: false,
    excludedApplication: false,
    secondsSinceMouseInput: 240,
    secondsSinceKeyboardInput: 300,
    power: { kind: 'unavailable' },
  });
  assert.deepEqual(cache.readInputIdle(), { mouse: 240, keyboard: 300 });

  clock.advanceSeconds(120);
  assert.equal(cache.readInputIdle(), null);
});
```

Update the other three tests in that file that pass a number: `evaluateIdleDecision(true, 500, 180)` becomes `evaluateIdleDecision(true, { mouse: 500, keyboard: 500 }, 180)`; `evaluateIdleDecision(false, 0, 0)` becomes `evaluateIdleDecision(false, { mouse: 0, keyboard: 0 }, 0)`; `evaluateIdleDecision(true, 0, 0)` becomes `evaluateIdleDecision(true, { mouse: 0, keyboard: 0 }, 0)`. The `null` cases stay `null`.

- [x] **Step 3: Update the remaining test fixtures**

Apply each replacement exactly:

- `tests/assistant-environment-cache.test.ts:28` `secondsSinceInput: 4,` → `secondsSinceMouseInput: 4, secondsSinceKeyboardInput: 9,`
- `tests/assistant-environment-cache.test.ts:48` `secondsSinceInput: 12` → `secondsSinceMouseInput: 12, secondsSinceKeyboardInput: 20`
- `tests/assistant-environment-cache.test.ts:56` `assert.equal(environment.secondsSinceInput, 12);` → two lines: `assert.equal(environment.secondsSinceMouseInput, 12);` and `assert.equal(environment.secondsSinceKeyboardInput, 20);`
- `tests/assistant-gate-d-e2e.test.ts:156` `secondsSinceInput: 4,` → `secondsSinceMouseInput: 4, secondsSinceKeyboardInput: 4,`
- `tests/assistant-gate-d-e2e.test.ts:164` `idleSeconds: 4,` → `mouseIdleSeconds: 4, keyboardIdleSeconds: 4,`
- `tests/assistant-gate-d-e2e.test.ts:437` `secondsSinceInput: 600,` → `secondsSinceMouseInput: 600, secondsSinceKeyboardInput: 600,`
- `tests/assistant-question-policy.test.ts:30` `secondsSinceInput: 1_000,` → `secondsSinceMouseInput: 1_000, secondsSinceKeyboardInput: 1_000,`
- `tests/assistant-question-policy.test.ts:132` replace the single `recent_input` row with two rows:

```ts
    ['recent_input', evaluate({ environment: { ...available, secondsSinceMouseInput: 10 } })],
    ['recent_input', evaluate({ environment: { ...available, secondsSinceKeyboardInput: 10 } })],
```

- `tests/assistant-question-scheduler.test.ts:74` `secondsSinceInput: 1_000,` → `secondsSinceMouseInput: 1_000, secondsSinceKeyboardInput: 1_000,`
- `tests/assistant-service.test.ts:232` `idleSeconds: 2,` → `mouseIdleSeconds: 2, keyboardIdleSeconds: 2,`
- `tests/assistant-service.test.ts:244` `secondsSinceInput: 30,` → `secondsSinceMouseInput: 30, secondsSinceKeyboardInput: 30,`
- `tests/assistant-activity-log.test.ts:26` `idleSeconds: 3,` → `mouseIdleSeconds: 9, keyboardIdleSeconds: 3,`
- `tests/assistant-activity-log.test.ts:51` stays `assert.equal(first.idle_seconds, 3);` and now proves the stored value is `min(mouse, keyboard)`.
- `dashboard/tests/assistant-settings.test.tsx:246` `reason: 'input_idle_below_threshold',` → `reason: 'mouse_idle_below_threshold',`; line 249 `details: { inputIdleSeconds: 12, requiredIdleSeconds: 180 },` → `details: { mouseIdleSeconds: 12, requiredIdleSeconds: 180 },`; line 267 `/Input idle below threshold/u` → `/Mouse idle below threshold/u`; line 271 `/inputIdleSeconds: 12/u` → `/mouseIdleSeconds: 12/u`.

- [x] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/assistant-desktop-contracts.test.ts tests/assistant-idle-gate.test.ts 2>&1 | tail -20`
Expected: FAIL (the fixtures no longer parse, `readInputIdle` does not exist).

- [x] **Step 5: Split the zod DTOs**

`packages/contracts/src/assistant-desktop.ts`, `ActivityEventDtoSchema`: replace `idleSeconds: z.number().int().min(0),` with:

```ts
  mouseIdleSeconds: z.number().int().min(0),
  keyboardIdleSeconds: z.number().int().min(0),
```

`EnvironmentStateDtoSchema`: replace `secondsSinceInput: z.number().int().min(0),` with:

```ts
  secondsSinceMouseInput: z.number().int().min(0),
  secondsSinceKeyboardInput: z.number().int().min(0),
```

- [x] **Step 6: Replace the reason**

`packages/contracts/src/assistant.ts`: replace `'input_idle_below_threshold',` with:

```ts
  'mouse_idle_below_threshold',
  'keyboard_idle_below_threshold',
```

- [x] **Step 7: Cache and environment state**

`src/assistant/questions/environment-state.ts`: replace `readonly secondsSinceInput: number;` with:

```ts
    readonly secondsSinceMouseInput: number;
    readonly secondsSinceKeyboardInput: number;
```

`src/assistant/observation/environment-cache.ts`: add after the imports:

```ts
/** Shell-reported seconds since the last physical mouse and keyboard input, respectively. */
export type DesktopInputIdle = { readonly mouse: number; readonly keyboard: number };
```

Replace `readInputIdleSeconds` with:

```ts
  /** Both input signals, or null while heartbeats are stale. */
  readInputIdle(): DesktopInputIdle | null {
    const fresh = this.fresh();
    return fresh === null
      ? null
      : { mouse: fresh.secondsSinceMouseInput, keyboard: fresh.secondsSinceKeyboardInput };
  }
```

In `read()`, replace `secondsSinceInput: fresh.secondsSinceInput,` with:

```ts
      secondsSinceMouseInput: fresh.secondsSinceMouseInput,
      secondsSinceKeyboardInput: fresh.secondsSinceKeyboardInput,
```

- [x] **Step 8: Service, policy engine, activity log**

`src/assistant/assistant-service.ts`: replace the `desktopInputIdleSeconds` method with:

```ts
  /** Shell-reported mouse/keyboard idleness; null when the shell is gone or stale. */
  desktopInputIdle(): DesktopInputIdle | null {
    return this.environment.readInputIdle();
  }
```

and add `type DesktopInputIdle` to the existing import from `./observation/environment-cache.js`, matching that file's import style.

`src/assistant/questions/policy-engine.ts`: replace the `recent_input` condition with:

```ts
    const secondsSinceInput = Math.min(
      environment.secondsSinceMouseInput, environment.secondsSinceKeyboardInput,
    );
    if (secondsSinceInput < config.Questions.ActiveInputSuppressionSeconds) {
      return this.ineligible('recent_input');
    }
```

`src/assistant/observation/activity-log.ts`: replace `event.idleSeconds,` with:

```ts
      Math.min(event.mouseIdleSeconds, event.keyboardIdleSeconds),
```

- [x] **Step 9: Five-branch gate**

Replace `src/status-server/assistant-idle-gate.ts` in full:

```ts
import type {
  BackgroundWorkAdmissionDecision, InteractivityGate,
} from '../assistant/jobs/job-runner.js';
import type { DesktopInputIdle } from '../assistant/observation/environment-cache.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../config/defaults.js';
import { isIdle } from './server-ops.js';
import type { ServerContext } from './server-types.js';

/**
 * Ordered truth table, first match wins: server busy, then data availability, then each input
 * signal. Every blocked branch names the signal holding the gate so the decision history shows
 * which one to look at (design §3.5).
 */
export function evaluateIdleDecision(
  busy: boolean,
  inputIdle: DesktopInputIdle | null,
  thresholdSeconds: number,
): BackgroundWorkAdmissionDecision {
  if (busy) {
    return { kind: 'blocked', reason: 'server_busy', details: {} };
  }
  if (inputIdle === null) {
    return { kind: 'blocked', reason: 'environment_heartbeat_missing', details: {} };
  }
  if (inputIdle.mouse < thresholdSeconds) {
    return {
      kind: 'blocked',
      reason: 'mouse_idle_below_threshold',
      details: { mouseIdleSeconds: inputIdle.mouse, requiredIdleSeconds: thresholdSeconds },
    };
  }
  if (inputIdle.keyboard < thresholdSeconds) {
    return {
      kind: 'blocked',
      reason: 'keyboard_idle_below_threshold',
      details: { keyboardIdleSeconds: inputIdle.keyboard, requiredIdleSeconds: thresholdSeconds },
    };
  }
  return { kind: 'allowed' };
}

export class StatusServerIdleGate implements InteractivityGate {
  private reportedMissingInputData = false;

  constructor(private readonly ctx: ServerContext) {}

  evaluate(): BackgroundWorkAdmissionDecision {
    const control = this.ctx.assistantControl;
    const background = control === null
      ? DEFAULT_ASSISTANT_CONFIG.Background
      : control.config.Background;
    const inputIdle = control === null ? null : control.desktopInputIdle();
    if (inputIdle === null && control !== null && control.enabled) {
      if (!this.reportedMissingInputData) {
        this.reportedMissingInputData = true;
        process.stderr.write(
          '[assistant] no fresh desktop input heartbeats; background work is paused until the shell reports.\n',
        );
      }
    } else {
      this.reportedMissingInputData = false;
    }
    return evaluateIdleDecision(
      !isIdle(this.ctx), inputIdle, background.IdleSecondsBeforeProcessing,
    );
  }
}
```

- [x] **Step 10: Dashboard labels**

`dashboard/src/tabs/settings/AssistantSettings.tsx`: replace `input_idle_below_threshold: 'Input idle below threshold',` with:

```ts
  mouse_idle_below_threshold: 'Mouse idle below threshold',
  keyboard_idle_below_threshold: 'Keyboard idle below threshold',
```

- [x] **Step 11: Verify nothing references the old names**

Run: `grep -rn "secondsSinceInput\b\|idleSeconds\b\|input_idle_below_threshold\|readInputIdleSeconds\|desktopInputIdleSeconds\|inputIdleSeconds" src packages dashboard/src dashboard/tests tests --include=*.ts --include=*.tsx`
Expected: no output.

- [x] **Step 12: Run tests to verify they pass**

Run: `npx tsx --test tests/assistant-desktop-contracts.test.ts tests/assistant-idle-gate.test.ts tests/assistant-environment-cache.test.ts tests/assistant-question-policy.test.ts tests/assistant-question-scheduler.test.ts tests/assistant-service.test.ts tests/assistant-activity-log.test.ts tests/assistant-gate-d-e2e.test.ts 2>&1 | siftkit summary --question "Return pass/fail counts and failing test names with error text."`
Expected: all pass.

Run: `npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail counts and failing test names."`
Expected: all pass.

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
Expected: pass.

- [x] **Step 13: Commit Tasks 3 and 4 together**

```bash
git add -A desktop packages/contracts/src src tests dashboard
git commit -m "feat(assistant): split desktop input idleness into mouse and keyboard signals"
```

---

### Task 5: Model-quiet condition and startup threshold

**Files:**
- Modify: `src/status-server/server-types.ts:58-63`
- Modify: `src/status-server/index.ts:280-286`
- Modify: `tests/helpers/server-context-fixture.ts:55-61`
- Modify: `packages/contracts/src/assistant.ts`
- Modify: `src/status-server/assistant-idle-gate.ts`
- Modify: `dashboard/src/tabs/settings/AssistantSettings.tsx`
- Test: `tests/assistant-idle-gate.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `tests/assistant-idle-gate.test.ts` (import `secondsSinceModelActivity` alongside `evaluateIdleDecision`):

```ts
test('model quiet is checked after data availability and before the input signals', () => {
  const quiet = { mouse: 500, keyboard: 500 };
  assert.deepEqual(evaluateIdleDecision(false, quiet, 180, 180), { kind: 'allowed' });
  assert.deepEqual(evaluateIdleDecision(false, quiet, 180, 179), {
    kind: 'blocked',
    reason: 'model_recently_active',
    details: { secondsSinceModelActivity: 179, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, { mouse: 0, keyboard: 0 }, 180, 0), {
    kind: 'blocked',
    reason: 'model_recently_active',
    details: { secondsSinceModelActivity: 0, requiredIdleSeconds: 180 },
  });
  assert.deepEqual(evaluateIdleDecision(false, null, 180, 0), {
    kind: 'blocked', reason: 'environment_heartbeat_missing', details: {},
  });
  assert.deepEqual(evaluateIdleDecision(true, null, 180, 0), {
    kind: 'blocked', reason: 'server_busy', details: {},
  });
});

test('model activity is measured from server start until the first request finishes', () => {
  const startedAtMs = 1_000_000;
  assert.equal(secondsSinceModelActivity(
    { lastModelRequestFinishedAtMs: null, serverStartedAtMs: startedAtMs }, startedAtMs + 179_999,
  ), 179);
  assert.equal(secondsSinceModelActivity(
    { lastModelRequestFinishedAtMs: null, serverStartedAtMs: startedAtMs }, startedAtMs + 180_000,
  ), 180);
  assert.equal(secondsSinceModelActivity(
    { lastModelRequestFinishedAtMs: startedAtMs + 500_000, serverStartedAtMs: startedAtMs },
    startedAtMs + 530_000,
  ), 30);
});
```

Update every existing `evaluateIdleDecision(...)` call in that file to pass a fourth argument of `500` (model quiet), except in the two new tests above.

- [x] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/assistant-idle-gate.test.ts 2>&1 | tail -20`
Expected: FAIL, `secondsSinceModelActivity` not exported.

- [x] **Step 3: Add `serverStartedAtMs`**

`src/status-server/server-types.ts`, `TerminalMetadataState`: add after `lastModelRequestFinishedAtMs: number | null;`:

```ts
  /** Set once at context construction; model quiet counts from here until the first request finishes. */
  serverStartedAtMs: number;
```

`src/status-server/index.ts` `terminalMetadata` literal: add `serverStartedAtMs: Date.now(),` after `lastModelRequestFinishedAtMs: null,`.

`tests/helpers/server-context-fixture.ts` `terminalMetadata` literal: add `serverStartedAtMs: 0,` after `lastModelRequestFinishedAtMs: null,`.

- [x] **Step 4: Add the reason**

`packages/contracts/src/assistant.ts`: add `'model_recently_active',` immediately before `'mouse_idle_below_threshold',`.

`dashboard/src/tabs/settings/AssistantSettings.tsx`: add `model_recently_active: 'Model recently active',` immediately before `mouse_idle_below_threshold: ...`.

- [x] **Step 5: Add the condition to the gate**

In `src/status-server/assistant-idle-gate.ts`, add `TerminalMetadataState` to the type import from `./server-types.js`, add the helper, and add the branch:

```ts
export function secondsSinceModelActivity(
  metadata: Pick<TerminalMetadataState, 'lastModelRequestFinishedAtMs' | 'serverStartedAtMs'>,
  nowMs: number,
): number {
  const lastActivityMs = metadata.lastModelRequestFinishedAtMs ?? metadata.serverStartedAtMs;
  return Math.floor((nowMs - lastActivityMs) / 1000);
}
```

`evaluateIdleDecision` gains a fourth parameter `modelQuietSeconds: number`, and this branch goes between the `inputIdle === null` check and the mouse check:

```ts
  if (modelQuietSeconds < thresholdSeconds) {
    return {
      kind: 'blocked',
      reason: 'model_recently_active',
      details: { secondsSinceModelActivity: modelQuietSeconds, requiredIdleSeconds: thresholdSeconds },
    };
  }
```

Update the doc comment to list the six branches in order: server busy, heartbeat missing, model recently active, mouse, keyboard, allowed.

`StatusServerIdleGate.evaluate` passes the fourth argument:

```ts
    return evaluateIdleDecision(
      !isIdle(this.ctx),
      inputIdle,
      background.IdleSecondsBeforeProcessing,
      secondsSinceModelActivity(this.ctx.terminalMetadata, Date.now()),
    );
```

- [x] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/assistant-idle-gate.test.ts tests/assistant-job-runner.test.ts tests/assistant-background-work-decisions.test.ts 2>&1 | siftkit summary --question "Return pass/fail counts and failing test names with error text."`
Expected: all pass.

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
Expected: pass.

- [x] **Step 7: Commit**

```bash
git add packages/contracts/src/assistant.ts src/status-server tests/assistant-idle-gate.test.ts tests/helpers/server-context-fixture.ts dashboard/src/tabs/settings/AssistantSettings.tsx
git commit -m "feat(assistant): gate background work on model quiet since last request or server start"
```

---

### Task 6: Full verification

- [x] **Step 1: Rust**

Run: `npm run desktop:test 2>&1 | siftkit summary --question "Return pass/fail, failing tests, and warnings."`
Expected: pass, no warnings.

- [x] **Step 2: TypeScript suite**

Run: `npm run build:test && npm run test 2>&1 | siftkit summary --question "Return pass/fail counts, failing test names, and root errors with file:line."`
Expected: pass.

Run: `npm run test:dashboard 2>&1 | siftkit summary --question "Return pass/fail counts and failing test names."`
Expected: pass.

- [x] **Step 3: Typecheck and lint**

Run: `npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
Run: `npm run lint 2>&1 | siftkit summary --question "Return pass/fail and every error with file:line."`
Expected: both pass.

- [x] **Step 4: Old-signal sweep**

Run: `grep -rn "GetLastInputInfo\|secondsSinceInput\b\|seconds_since_input\b\|input_idle_below_threshold\|inputIdleSeconds" desktop/src-tauri/src desktop/contract-fixtures src packages/contracts/src dashboard/src tests`
Expected: no output.

- [x] **Step 5: Live acceptance (primary agent, after the shell is rebuilt with `npm run desktop:build`)**

With the Xbox controller connected, leave mouse and keyboard untouched for more than 180 s with no model work. Expect `GET /assistant/background-decisions` to stop recording `mouse_idle_below_threshold` / `keyboard_idle_below_threshold`, queued jobs to show `attempts > 0`, and the pending capture count to fall.
