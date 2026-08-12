# Assistant Gate D — Handoff after Tasks 13–28 (gate complete)

**Date:** 2026-08-10
**Plan:** `docs/superpowers/plans/2026-08-10-assistant-gate-d-desktop-observation.md`
**Spec:** `docs/superpowers/specs/2026-08-10-assistant-gate-d-desktop-observation-design.md`
**Predecessor handoffs:** tasks 1–7, 8–11 (committed), task 12 handoff (this session).
**State:** Tasks 12–28 are complete and **uncommitted** in the working tree (per session
constraints: no commits). Gate D's plan is finished apart from the manual smoke checklist.

---

## Verification status (final gate, Task 28)

```
npm run build:test     # passes
npm test               # 2949 tests, 0 fail, 2 pre-existing skips
npm run typecheck      # passes (includes eslint)
npm run build          # passes (known ~1 MB chunk warning)
npm run desktop:test   # 47 Rust tests, 0 fail
npm run desktop:build  # NSIS installer at desktop/src-tauri/target/release/bundle/nsis/
dashboard suite        # 262/271; the 9 failures are vision-preset-controls tests that fail
                       # identically on clean HEAD (verified by stash) — pre-existing, untouched
```

Process/listener audit: no stray test/daemon/shell processes or listeners (the one running
node process belongs to an unrelated external tool in another repository).

**Unverified:** everything in `scripts/desktop/manual-smoke.md` (tray, popup paint, capture
silence, multi-monitor bounds, quit semantics, real custody migration through the shell binary,
sign-in registration). This session ran headless; the checklist rows are marked unverified.
The DPAPI round-trip Rust test DID run against the real DPAPI and passes.

---

## Task 13 — `GET /assistant/desktop/state` + mark-shown/dismiss

- `AssistantService.desktopState()` assembles the DTO; the route sits **above** the enabled
  gate (the tray needs "assistant off" as a state). A poll never transitions a question.
- `POST /assistant/questions/mark-shown` / `dismiss` take `{questionId}` bodies, sit behind the
  enabled gate; `QuestionStore.markShown` (eligible→shown) stays the only writer of
  `shown_at_utc`; wrong-status transitions map to 409, unknown/foreign ids to 404.
- `CaptureQueueStore.countByState` added; queueDepth = queued + awaiting_image_capability.

## Task 14 — dashboard observation settings replacement

- `ObservationSettings` section: consent text ("…enables automatic image analysis…"),
  screenshot toggle (off default), cadence, capture-scope select, similarity, dwell, deny-list
  textareas, retention hours/GB, sign-in startup toggle, custody status line, and the
  incapable-runtime warning with queue depth (desktop state fetched in the settings mount
  effect via `getAssistantDesktopState`).
- **Deviation (plan gap):** the plan's "deny lists" and "sign-in startup" had no home in the
  Task 1 config. Added `Observation.ProcessDenyList: string[]`, `TitleDenyPatterns: string[]`,
  `StartOnSignIn: boolean` (defaults `[]/[]/false`) to the contract, defaults, normalization
  (`stringListOrDefault` keeps string entries, falls back whole on non-arrays), and the config
  tests. The shell reads them via `GET /assistant/config`.
- The stale "OS keychain integration arrives in Gate D" note replaced.

## Task 15 — per-item pixel reveal

- `GET /assistant/evidence/blob?id=` decrypts and serves owned, active, blob-backed evidence
  with `Cache-Control: no-store`; expired/foreign/unknown → 404; a tampered envelope → 500
  with the cipher error, never bytes. Route ordering: the literal path is matched before the
  `/assistant/evidence/:id` regex.
- `EvidencePixelReveal` in `AssistantMemoryDetail`: `window.confirm` → fetch → object URL;
  the unmount/replace effect is the **only** revoker (exactly one revoke per URL).

## Task 16 — portable toolchain

- rustup + stable-x86_64-pc-windows-msvc 1.97.1 + tauri-cli 2.11.4 under
  `C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\`; `scripts/desktop/rust-env.mjs`
  scopes RUSTUP_HOME/CARGO_HOME/PATH per process. Global env verified untouched.
  Manifest + removal boundary: `docs/superpowers/handoffs/gate-d-toolchain-manifest.md`.

## Tasks 17–26 — Tauri shell (`desktop/src-tauri`)

- **Scaffold (17):** Tauri 2, tray-icon feature, no startup window (`ExitRequested` with no
  code is prevented), identifier `com.siftkit.assistant`. BMP-format `icons/icon.ico`
  (the resource compiler rejects PNG-in-ICO).
- **DTOs (18):** `contracts.rs` mirrors `assistant-desktop.ts` 1:1; `SchemaV1` unit struct
  fails closed on any other version; golden fixtures parse + round-trip (numeric-canonical
  compare: JSON `87` == `87.0`); `deny_unknown_fields` everywhere except the internally-tagged
  power union (serde limitation).
- **Adapters + heartbeat (19):** traits in `platform/mod.rs`; Win32 impls in
  `platform/windows/{activity,power}.rs` (foreground identity via
  `QueryFullProcessImageNameW`, idle via `GetLastInputInfo`, lock/secure desktop via
  `OpenInputDesktop`+desktop name, DND/presenting via `SHQueryUserNotificationState`).
  `observation/heartbeat.rs` is pure: environment every 20 s, activity on change while
  unlocked, silence while paused; `observation/titles.rs` strips URLs/emails/paths.
- **Preflight + scheduler (20):** `observation/preflight.rs` evaluates the §4 order, first
  match wins; an uncompilable user title pattern **denies**; provider error → suppression.
  `observation/scheduler.rs`: cadence + re-arming dwell; pause cancels timers.
- **Capture + hashes (21):** `PrintWindow(PW_RENDERFULLCONTENT)` foreground path with
  minimized/cloaked checks; DXGI duplication per output composed onto the virtual desktop for
  `all_monitors`; `hash.rs` SHA-256 + 64-bit dHash; uniform frames are `capture_failure`.
- **Custody (22):** `custody.rs` state machine (status→export→protect→write→re-read→
  unprotect→verify→import); any failure removes the blob (no partial state); steady-state
  desktop custody re-imports. `secure_key.rs` wraps DPAPI (`CRYPTPROTECT_UI_FORBIDDEN`);
  real round-trip tested. Key bytes zeroized after use.
- **Daemon client + supervision (23):** `daemon/client.rs` (ureq, bearer bootstrapped once,
  400→ContractMismatch, transport→Disconnected — capture halts, nothing buffered; tested
  against tiny_http stubs including restart/resume). `daemon/supervisor.rs` adopt/spawn/
  blocked; quit terminates only a spawned tree; `platform/windows/job.rs` wraps a Job Object
  with `KILL_ON_JOB_CLOSE`.
- **Popup (24):** `popup.rs` state machine — only `popup_rendered` marks shown; creation
  failure/disconnect never do; close-without-answer dismisses; failed submits retain the text
  and retry; badge clears with no pending question. `desktop/ui/popup.html` + `popup.js`
  (plain JS, not TS — no build pipeline exists for static shell assets; IPC via
  `withGlobalTauri`-less script relying on `window.__TAURI__` through the `core:default`
  capability). Tray tooltip carries on/capture/paused/attention/question states.
- **Startup (25):** `platform/windows/startup.rs` — `reconcile_startup` idempotent over a
  `RunKeyRegistry` trait; HKCU Run impl; reconciled on every config poll in `main.rs`.
- **Packaging (26):** NSIS bundle builds; `windows/hooks.nsh` `NSIS_HOOK_POSTUNINSTALL`
  deletes the Run value. `scripts/desktop/manual-smoke.md` created — **all rows unverified**.
- `main.rs` wires the whole runtime: connect (probe→adopt/spawn→custody sync) → 1 s worker
  loop (config refresh every 30 s, heartbeat posts, scheduler→preflight→capture→submit,
  desktop-state poll→tray/popup/startup-reconcile). Daemon spawn command is env-configurable
  (`SIFTKIT_DAEMON_PROGRAM/ARGS/CWD`, `SIFTKIT_STATUS_PORT`, `SIFTKIT_RUNTIME_ROOT`).

## Task 27 — E2E (`tests/assistant-gate-d-e2e.test.ts`)

Five tests over a real status server + fake shell HTTP client (+ an in-proc drain service
with fake inference/capability sharing the runtime DB):
disabled-assistant rejection with zero rows; capture→evidence→queue→drain→assertion→search
followed by retention expiry recalculating confidence to zero with the blob purged;
suppression audit-only + injection-bearing extraction output (unknown predicate) mutating no
policy and promoting nothing (`extraction_rejected` audited); custody migration + daemon
restart + re-import decrypting pre-migration evidence; environment staleness →
`environment_unavailable` pending-only policy (fresh heartbeat restores, three missed beats
fail closed).

## Notes / known gaps

- The 9 dashboard `vision-preset-controls` failures are pre-existing on HEAD (verified by
  stashing) and untouched.
- The shell's `capture_enabled` check trusts the daemon's desktop state; daemon-side private
  mode already zeroes it, so the shell's preflight passes `private_mode: false`.
- `eslint.config.mjs` now ignores `desktop/src-tauri/target/**` (generated codegen assets).
- The boot-time-config staleness note from earlier handoffs (assistant inference base URL)
  remains open and out of scope.
- TDD honesty: Node-side tasks 13/15 had observed RED runs (twice catching real expectation
  bugs); Task 14's RED was config-compile + component-test failures. Rust modules were written
  tests-with-implementation and verified by the first full `cargo test` (one genuine failure
  caught: integer/float round-trip), plus a caught wrong epoch constant in `clock.rs`.

## Changed / added in this session (Tasks 13–28, all uncommitted)

Node/dashboard: `packages/contracts/src/config.ts`, `src/config/{defaults,normalization}.ts`,
`src/assistant/assistant-service.ts`, `src/assistant/images/capture-queue-store.ts`,
`src/status-server/routes/assistant.ts`, `dashboard/src/assistant-api.ts`,
`dashboard/src/tabs/AssistantTab.tsx`, `dashboard/src/tabs/settings/AssistantSettings.tsx`,
`dashboard/src/components/AssistantMemoryDetail.tsx`,
`dashboard/src/hooks/useAssistantController.ts`, `eslint.config.mjs`, `package.json`,
tests: `assistant-desktop-state`, `assistant-evidence-blob`, `assistant-gate-d-e2e`,
`dashboard/tests/{assistant-settings,assistant-evidence-reveal,settings-tab}`.

Desktop: the whole `desktop/src-tauri` crate, `desktop/ui/*`, `desktop/.gitignore`,
`scripts/desktop/{rust-env,install-toolchain}.mjs`, `scripts/desktop/manual-smoke.md`,
`docs/superpowers/handoffs/gate-d-toolchain-manifest.md`.
