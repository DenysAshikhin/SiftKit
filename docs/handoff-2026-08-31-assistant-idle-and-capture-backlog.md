# Handoff: assistant diagnostics, capture backlog, and broken idle signal (2026-08-31)

## 1. User goal and current decision point

The user wants assistant background work to run only after **all three** signals have been quiet for `Background.IdleSecondsBeforeProcessing` (currently 180 seconds):

1. No active or queued model request, and at least 180 seconds since the last model request completed.
2. At least 180 seconds since the last mouse input.
3. At least 180 seconds since the last keyboard input.

The current combined `GetLastInputInfo` path is not acceptable. The next session must finish the design with the user before implementation. The open question already asked is whether injected/synthetic mouse and keyboard events must be ignored so only physical user input resets the timers. No answer has been received yet.

## 2. Persisted background-decision diagnostics implemented (uncommitted)

The dashboard previously hid the real job queue and gave no reason why background work did not start. This session added a persisted, newest-first history of the last 100 block decisions:

- Strict shared schemas and reason enum: `packages/contracts/src/assistant.ts:18-57`.
- Persistent `runtime_metadata` store under key `assistant.background_work_decisions.v1`: `src/assistant/storage/background-work-decision-store.ts`.
- Store is composed through `AssistantGraph`: `src/assistant/assistant-graph.ts`.
- Structured idle/resource/model/preemption reasons: `src/assistant/jobs/job-runner.ts:20-30,105-193`.
- Structured server/input-idle decisions: `src/status-server/assistant-idle-gate.ts:14-59`.
- Service-level reasons (`drain_blocked`, disabled, active drain, unavailable image capability): `src/assistant/assistant-service.ts:487-499,684-767`.
- Authenticated `GET /assistant/background-decisions`: `src/status-server/routes/assistant.ts:82`, `src/status-server/routes/assistant/admin-routes.ts:59-61`.
- Assistant Settings → Configuration UI: `dashboard/src/tabs/settings/AssistantSettings.tsx:37-82,332-354,433-441`.

The store writes only while queued jobs or pending captures exist, retains exactly 100 entries, parses persisted JSON with Zod, and fails loudly on malformed storage. Queue behavior itself was not changed.

### Live verification after restart

- Unauthenticated endpoint: HTTP 401.
- Authenticated endpoint: HTTP 200.
- Response passed the shared schema.
- Endpoint exactly matched SQLite and was newest-first.
- Decisions accumulated every 20 seconds.
- The history has now reached its intended 100-entry cap.

## 3. Current live state

Read from `.siftkit/runtime.sqlite` at handoff time:

- Jobs: 414 completed, **29 queued**.
- Captures: 99 processed, **1,012 queued**, 8 awaiting image capability (1,020 unprocessed total).
- Memory: 1 root node, 0 assertions, 0 projections.
- Latest persisted block decision: `server_busy` at `2026-08-31T22:57:56.498Z`, with 29 queued jobs and 1,020 pending captures. This was expected while repository/model work was active.

The job rows all remained at zero attempts during the original diagnosis, proving admission stopped them before claim/execution. The dashboard's “Pending validation” count is not the job queue; there is still no general job-list endpoint.

## 4. Capture semantics confirmed

There is **no 1,000-capture count limit**. The count passed 1,000 during live observation.

- Admission has no count cap: `src/assistant/observation/capture-intake.ts:81-156`.
- Default raw retention is 72 hours: `src/config/defaults.ts:69`.
- Default raw storage cap is 5 GiB, enforced oldest-first by bytes: `src/config/defaults.ts:70`, `src/assistant/images/capture-retention.ts:51-75`.
- The pending-captures endpoint is display-capped at 200 rows per state only: `src/assistant/assistant-service.ts:153-154,475-489`.
- `desktopState.imageCapability.queueDepth` is an unbounded SQL count over queued + awaiting capability: `src/assistant/assistant-service.ts:398-402`.

Screenshots continue to be captured, encrypted, stored, and queued while the model is frozen or unloaded:

- Desktop capture gate has no model-state condition: `desktop/src-tauri/src/main.rs:398-420`.
- Intake encrypts/stores pixels before queue admission: `src/assistant/observation/capture-intake.ts:118-144`.
- Frozen/unloaded capability maps new captures to `awaiting_image_capability`: `src/assistant/observation/capture-intake.ts:173-176`, `src/status-server/runtime-image-capability.ts:18-26`.
- When the model becomes ready, waiting captures receive image-extraction jobs oldest-first: `src/assistant/assistant-service.ts:745-767`.
- A capability loss during extraction returns the capture to `awaiting_image_capability` without consuming a failure attempt: `src/assistant/images/image-extractor.ts:77-89`.

Capture still stops for assistant disabled, private mode, screenshots disabled, locked/secure desktop, suppression rules, capture failure/blank frames, or deduplication.

## 5. Idle failure reproduced and localized

### Four-minute live observation

The user was asked to leave keyboard and mouse untouched. Thirteen samples were taken every 20 seconds for four minutes:

- Independent Win32 idle probe: exactly 0 seconds every sample.
- Assistant persisted decision: exactly 0 seconds every sample.
- Required threshold: 180 seconds.
- Queued jobs stayed at 29.
- Pending captures grew from 1,007 to 1,012 during the observation.

This proves the comparison `0 < 180` works and the desktop heartbeat faithfully transmits the Windows value. The bad value originates upstream of the assistant idle gate.

### Millisecond and low-level-hook probes

- Fifty `GetLastInputInfo` samples over five seconds reported 0–16 ms idle and five observed counter resets.
- The independent probe checked the Win32 return value and it succeeded, so the live result was not the shell's silent failure-to-zero branch.
- A five-second low-level keyboard/mouse hook saw zero keyboard and zero mouse events while `GetLastInputInfo` continued to reset.
- A second 15-second hook also saw zero events; whether the user intentionally interacted during that exact window was not confirmed, so it does not yet prove the hook catches this machine's physical devices.

Current root-cause verdict: **`GetLastInputInfo` is reporting phantom activity that is not visible as ordinary low-level keyboard or mouse events in this session.** Its arithmetic is correct (`GetTickCount().wrapping_sub(dwTime) / 1000`), but it cannot satisfy the required separate physical mouse/keyboard semantics. Implementation: `desktop/src-tauri/src/platform/windows/activity.rs:145-155`.

The code also has a separate defect: `GetLastInputInfo == FALSE` silently returns 0 (`activity.rs:150-152`), conflating unavailable telemetry with immediate user activity. The live independent probe did not take this branch, but the replacement must still fail loudly rather than preserve it.

## 6. Exact replacement direction (not yet approved)

This grew from a bounded gate change into a cross-component idle-contract replacement. Do not implement until the user approves the design.

Recommended design:

1. Add a long-lived Windows input tracker owned by the desktop shell. Track mouse and keyboard timestamps separately. Ignore injected input if the user confirms physical-only semantics. Hook/tracker startup failure must be explicit; do not fall back to `GetLastInputInfo` or report zero.
2. Replace `EnvironmentStateDto.secondsSinceInput` with `secondsSinceMouseInput` and `secondsSinceKeyboardInput` in both strict TS and Rust contracts. Update the golden fixture and remove the old field everywhere.
3. Preserve question-policy combined-input behavior by deriving the minimum of the two validated values internally; do not keep a parallel legacy contract field.
4. Reuse `ServerContext.terminalMetadata.lastModelRequestFinishedAtMs`, already written by `releaseModelRequest` at `src/status-server/server-ops.ts:584-618`. Model quiet requires:
   - `activeModelRequests.size === 0`,
   - `modelRequestQueue.length === 0`, and
   - elapsed time since `lastModelRequestFinishedAtMs` ≥ threshold.
   Initialization semantics still need an explicit ruling: safest is to require one full threshold after server startup when no prior completion timestamp exists.
5. The idle gate allows work only when model quiet, mouse quiet, and keyboard quiet all meet the same configured threshold. Persist distinct block reasons/details for each failed condition.
6. Use TDD and remove `GetLastInputInfo` completely after the replacement. No fallback, shim, or parallel path.

Before finalizing this design, run one interactive native probe that proves the proposed tracker observes one deliberate physical mouse movement and one deliberate physical keypress separately on this machine.

## 7. Validation snapshot for current uncommitted diagnostics

- Focused assistant/backend/dashboard tests: 50 passed, 0 failed.
- Full suite: 3,461 passed, 0 failed, 3 skipped.
- `npm run typecheck`: passed (includes lint).
- Explicit `npm run lint`: passed.
- `npm run build`: passed.
- Vite emitted the existing warning that the main bundle exceeds 500 kB; build exit was 0.
- Independent read-only review: no Critical, Important, or Minor findings.
- No commit was created.

## 8. Working tree and preservation notes

Branch: `main`.

Tracked files modified by the persisted-diagnostics feature:

- `dashboard/src/assistant-api.ts`
- `dashboard/src/tabs/settings/AssistantSettings.tsx`
- `dashboard/tests/assistant-settings.test.tsx`
- `packages/contracts/src/assistant.ts`
- `src/assistant/assistant-graph.ts`
- `src/assistant/assistant-service.ts`
- `src/assistant/jobs/job-runner.ts`
- `src/status-server/assistant-idle-gate.ts`
- `src/status-server/routes/assistant.ts`
- `src/status-server/routes/assistant/admin-routes.ts`
- `tests/assistant-capture-retention.test.ts`
- `tests/assistant-idle-gate.test.ts`
- `tests/assistant-job-runner.test.ts`
- `tests/assistant-routes.test.ts`
- `tests/assistant-service.test.ts`
- `tests/helpers/assistant-gates.ts`

New files from that feature:

- `src/assistant/storage/background-work-decision-store.ts`
- `tests/assistant-background-work-decisions.test.ts`

Unrelated pre-existing user file that must be preserved:

- `docs/handoff-2026-08-31-runtime-time-token-analysis.md` (untracked)

This handoff file is also untracked until the user chooses to commit. Temporary diagnostic probes were process-local only; no scratch files remain.

## 9. Next-session checklist

1. Read this handoff and inspect `git status --short`; preserve the unrelated runtime/token handoff.
2. Ask/confirm whether injected input is ignored and physical input alone resets mouse/keyboard timers.
3. Run the explicit physical-input probe so the proposed Windows tracker is proven on this machine before code changes.
4. Present the final architecture/design and obtain approval.
5. Write failing Rust + TypeScript contract/cache/gate tests before implementation.
6. Use the required single `siftkit repo-agent` implementation dispatch if its model backend is healthy; never retry it on failure, and finish directly if it fails completely.
7. Validate Rust desktop tests/build, focused assistant tests, full suite, typecheck, lint, production build, and a live >180-second untouched test showing all three counters rise and queued jobs begin draining.
