# Handoff: three-signal idle gate shipped, live-tested, one migration added (2026-09-01)

## 1. What shipped

Plan `docs/superpowers/plans/2026-09-01-three-signal-idle-gate.md` is fully implemented and committed on `main`.
Spec: `docs/superpowers/specs/2026-08-31-three-signal-idle-gate-design.md`.

| Commit | Content |
| --- | --- |
| `0a06f288` | `InputIdleTimestamps` pure tick arithmetic (`desktop/src-tauri/src/platform/windows/input_tracker.rs`) |
| `8eb74e3b` | `WindowsInputTracker` Raw Input thread (message-only window, usages 0x02/0x06, `RIDEV_INPUTSINK`, null `hDevice` dropped) |
| `712608bc` | Wire split: `secondsSinceMouseInput`/`secondsSinceKeyboardInput`, `mouseIdleSeconds`/`keyboardIdleSeconds`, reasons `mouse_idle_below_threshold`/`keyboard_idle_below_threshold`, `GetLastInputInfo` removed, activity log stores `min(mouse, keyboard)` |
| `d0d0b8b7` | `model_recently_active` branch, `serverStartedAtMs` on `TerminalMetadataState`, `secondsSinceModelActivity()` |
| `990e1880` | Schema migration v56: drops persisted decision entries with the removed `input_idle_below_threshold` reason |

Gate order (`src/status-server/assistant-idle-gate.ts`): server busy → heartbeat missing → model recently active → mouse → keyboard → allowed. Threshold is `Background.IdleSecondsBeforeProcessing` (180 s).

Files the plan missed but were required: `tests/assistant-background-work-decisions.test.ts`, `scripts/assistant-bench/shared.ts`.

## 2. Validation done

- `npm run desktop:test`: 54 pass, no warnings.
- `npm run test` (full TS): 3510 pass, 0 fail. Run before commit `990e1880`.
- `npm run test:dashboard`: 386 pass.
- `npm run typecheck` and `npm run lint`: clean after every commit.
- After `990e1880` only these ran: `runtime-db-schema-v56`, `runtime-db-migration-registry`, `assistant-background-work-decisions` (7 pass). The full suite was not rerun because the live daemon on 4765 trips the test runner's live-instance guard.

## 3. Live acceptance (done 2026-09-01 20:17 local, real repo runtime `.siftkit/`)

Stack launched with `npm run start -- --stable` (starts daemon, dashboard, and the shell from `desktop/src-tauri/target/release/siftkit-assistant-shell.exe`). Hands off for 6 minutes.

Decision history showed the branch order exactly:

| Time (UTC) | Reason | Detail |
| --- | --- | --- |
| 00:17:46 | `environment_heartbeat_missing` | before the shell's first heartbeat |
| 00:18:06 → 00:20:06 | `model_recently_active` | 40 s → 160 s since server start |
| 00:20:26 → 00:21:06 | `mouse_idle_below_threshold` | 140, 159, 179 s |
| 00:21:26 → | `model_not_resident` | input gate open; resource policy blocks (LLM not loaded) |

Outcome: completed jobs 414 → 420, queued 31 → 30, pending captures (decision record) 1288 → 1037.
`keyboard_idle_below_threshold` never fired because the keyboard was already quieter than the mouse.

## 4. Bug found during acceptance (fixed)

Persisted history under `runtime_metadata` key `assistant.background_work_decisions.v1` held two entries with the old reason. The strict enum rejected the whole blob, which failed every job drain (`Assistant job drain failed` in the daemon log) and `GET /assistant/background-decisions`. Migration v56 (`src/state/migrations/registry.ts`, `CURRENT_SCHEMA_VERSION = 56`) filters those entries. Regression test: `tests/runtime-db-schema-v56.test.ts`.

## 5. How to test tomorrow

1. Rebuild if anything changed: `npm run build` (daemon) and `npm run desktop:build` (shell).
2. Start: `npm run start -- --stable`. Confirm `tasklist | findstr siftkit-assistant-shell` and `curl http://127.0.0.1:4765/health`.
3. Token: `curl http://127.0.0.1:4765/assistant/auth/bootstrap` (loopback only) → `{"token":...}`. Assistant routes need `Authorization: Bearer <token>`.
4. Decisions: `GET /assistant/background-decisions` (newest first, 100 max, per-owner `own_local`).
5. Jobs (no HTTP route; read sqlite readonly):
   ```
   SELECT status, COUNT(*), SUM(attempts > 0), MAX(attempts) FROM assistant_jobs GROUP BY status
   ```
   via `node_modules/better-sqlite3` on `.siftkit/runtime.sqlite`.
6. Do not use `/assistant/captures/pending` as the backlog signal; it caps each state at `PENDING_CAPTURE_LIST_LIMIT` (showed a flat 208). Use `pendingCaptureCount` on the decision entries.
7. Stay hands-off for >180 s after the daemon starts (model quiet counts from `serverStartedAtMs` until the first request finishes). Expect `model_recently_active` first, then mouse/keyboard, then either `allowed` (jobs run) or a resource-policy reason.
8. Checks worth adding tomorrow:
   - Move the mouse only → next tick must be `mouse_idle_below_threshold` with a small `mouseIdleSeconds`; keyboard value unaffected in `secondsSinceKeyboardInput` heartbeats.
   - Press a key only → `keyboard_idle_below_threshold`.
   - Xbox controller input only → no reset of either signal.
   - Run a model request → `model_recently_active` restarts from `lastModelRequestFinishedAtMs`.
   - Kill the tracker thread path is untestable live; the shell exits with `input tracker failed` if `snapshot()` errors.

Stopping the stack: `TaskStop`/Ctrl-C on `npm run start` kills only the npm wrapper. Use PowerShell `Stop-Process` on the shell process and on the PID listening on 4765 (`netstat -ano | findstr :4765`). Git Bash mangles `taskkill /PID`.

## 6. Open items

- Background work is now blocked by `model_not_resident` and `image_capability_unavailable`. Both are resource-policy reasons outside this plan; the LLM must be resident for queued jobs to drain fully.
- Full TS suite not rerun after `990e1880` (see §2). Run `npm run build:test && npm run test` with the stack stopped.
- `scripts/desktop/manual-smoke.md` rows remain unverified; this session only exercised the idle gate.
- Working tree had unrelated edits not mine, left untouched: `docs/superpowers/plans/2026-09-01-single-response-reserve-budget.md` (modified) and `docs/superpowers/plans/2026-09-01-no-think-approval-verdict.md` (untracked). Commit `f79ec557` landed on `main` from another session mid-work.
- Plan checkboxes in `2026-09-01-three-signal-idle-gate.md` were not ticked.

## 7. Stack state at handoff

The dev stack started at 20:17 local is still running (daemon PID on 4765, dashboard, shell). Stop it before running the test suite.

## 8. Follow-up (2026-09-02, branch `three-signal-idle-gate`, worktree `.worktrees/three-signal-idle-gate`)

- Stopped the dev stack left running in §7 (shell and daemon on 4765) before running suites.
- `InputIdleTimestamps::stamp_raw_input(device_type, physical_device, tick)` now owns the `WM_INPUT` routing that lived inline in `input_window_proc`. New Rust test `only_physical_mouse_and_keyboard_headers_stamp_their_own_signal` covers §5.8: `RIM_TYPEHID` (gamepad) and null-device (injected) input move neither signal; physical mouse/keyboard move only their own.
- New TS test in `tests/assistant-idle-gate.test.ts`: acquiring and releasing a model request on a `ServerContext` resets `secondsSinceModelActivity` to 0 (§5.8 "run a model request" check), via `releaseModelRequest` stamping `lastModelRequestFinishedAtMs`.
- Old-signal sweep (plan Task 6 Step 4): reworded the `GetLastInputInfo` mention in the tracker doc comment and renamed the `secondsSinceInput` local in `policy-engine.ts` to `secondsSinceAnyInput`. Remaining hits are intentional: migration v56 in `src/state/migrations/registry.ts`, `tests/runtime-db-schema-v56.test.ts`, and the rejection assertion in `tests/assistant-desktop-contracts.test.ts`.
- Plan checkboxes in `docs/superpowers/plans/2026-09-01-three-signal-idle-gate.md` ticked.
- Rust toolchain note: `scripts/desktop/toolchain-paths.mjs` resolves `.tooling` relative to the checkout's parent, so inside a worktree set `SIFTKIT_TOOLING_ROOT=C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d` before `npm run desktop:test`.
- Full TS suite rerun found the two tests §2 missed after v56: `tests/assistant-migration.test.ts` and `tests/runtime-db-schema-v51.test.ts` asserted `CURRENT_SCHEMA_VERSION === 55`. Both now assert 56.
