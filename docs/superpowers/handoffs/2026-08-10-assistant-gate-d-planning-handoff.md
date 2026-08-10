# Assistant Gate D planning handoff

Date: 2026-08-10  
Repository: `C:\Users\denys\Documents\GitHub\SiftKit`  
Branch: `main`  
Base commit: `a9fc22b58cac658924fd756c65b9d80f59ebe856`  
State: Gate C is complete as uncommitted workspace changes. Gate D design discovery has begun; no
Gate D implementation or toolchain installation has started.

## Session constraints

- Do not invoke SiftKit in this session. The user explicitly disabled it for the session, overriding
  the repository's SiftKit-first policy.
- Work inline. Do not use subagents, repo-agent, worktrees, or commits.
- Preserve all existing Gate B/C changes and unrelated workspace changes.
- Follow strict TypeScript rules and TDD from `AGENTS.md`.
- Keep temporary artifacts under one scratch directory and remove them at completion.
- Verify and terminate only processes proven to have been launched by this work. Do not kill an
  independently launched user server or model runtime.

## Gate C closeout

Gate C Tasks 1-21 are complete. It includes proactive questions, resource policy, authenticated
assistant API/CLI controls, the dashboard Memory Inspector, pending-proof validation with durable
notes/removal, and an unbounded simple memory-change history.

Final validation on the completed Gate C tree:

- `npm run build:test`: passed.
- `npm test -- assistant`: 351 passed, 0 failed.
- `npm test`: 2,870 tests; 2,868 passed, 0 failed, 2 skipped.
- `npm run typecheck`: passed.
- `npm run lint`: passed independently.
- `npm run build`: passed; the existing approximately 1 MB Vite chunk warning remains.
- `git diff --check`: passed with line-ending normalization warnings only.
- Windows process and listener audits found no fake launcher, test runner, status server, Vite
  server, llama server, or listeners on ports 4765, 6876, or 8080.

One earlier default-concurrency run reproduced an intermittent managed-llama timing pair: a
one-second readiness request timed out and a nested cleanup watchdog briefly observed two of three
launcher PIDs. Both checks passed in isolation and in a subsequent unchanged full run. No timeout
or test was weakened. On Windows, `terminateProcessTree` first uses
`taskkill /PID <pid> /T /F`, then falls back to `SIGTERM` if taskkill fails; the fallback is covered
by a test. Direct OS inspection found zero survivors.

The detailed Gate C implementation handoff remains at
`docs/superpowers/handoffs/2026-08-10-assistant-gate-c-complete-handoff.md`.

## Authoritative Gate D sources

- Approved overall design: `assistant/2026-07-30-siftkit-assistant-design.md`.
- Historical master plan: `assistant/2026-07-30-siftkit-graph-personal-assistant-master-plan-v3.md`.
  The approved design supersedes it on conflicts.
- Gate C plan: `docs/superpowers/plans/2026-08-10-assistant-gate-c-proactive-assistant.md`.
- Gate C completion handoff:
  `docs/superpowers/handoffs/2026-08-10-assistant-gate-c-complete-handoff.md`.

Gate D is the desktop-observation gate: Tauri 2 shell, Windows Rust adapters, tray/question popup,
native environment providers, activity/sessionization, private screenshot capture, image
extraction, retention, and end-to-end validation. There is currently no `desktop/`, `src-tauri/`,
Cargo manifest, or Tauri dependency in the repository.

## Gate D decisions approved in this session

### Scope and platform

- Implement the full Gate D, including encrypted screenshots; do not defer capture.
- Use Tauri 2 and Rust for privileged Windows behavior. Do not use Electron.
- React remains the existing dashboard/widget UI and performs no direct OS access.
- Windows is the implemented platform. Platform-neutral traits/DTOs must allow later adapters.

### Encryption key and migration

- Desktop mode atomically imports an existing file key into Windows-protected storage, verifies it
  can decrypt existing evidence, then removes the plaintext key file.
- A failed migration stops capture and reports a loud error; there is no silent fallback.
- Headless mode retains the documented file-key provider as an explicit standalone configuration,
  not as an automatic desktop fallback.
- Keys never enter React.

### Question delivery

- Use a compact native popup plus a tray badge.
- Mark a question `shown` only after the popup confirms it rendered.
- Queueing, notification failure, daemon disconnect, or suppression does not count as shown.
- Closing without answering records `dismissed`; the dashboard can still display/answer it.

### Capture privacy and preview

- Screenshot capture is off by default and requires explicit enablement.
- Capture is fail-closed: never capture during private mode, lock/secure desktop, excluded or
  unknown foreground identity, password/authentication/payment contexts, or private/incognito
  windows. User app/window policies extend the defaults.
- Secret-classified content is discarded immediately and writes only a non-content audit event.
- Raw retention defaults to the earlier of 72 hours or 5 GB.
- The UI shows screenshot metadata by default. Pixel reveal is per-item, explicit, and confirmed;
  decrypted bytes stay in memory only and are cleared when preview closes or loses access.
- Automatic capture is operationally silent: no flash, focus change, border, sound, toast, cursor
  interruption, or popup. A passive tray state still shows that capture is enabled.

### Capture triggers, scope, and deduplication

- Configurable fixed cadence defaults to one attempt every 30 seconds.
- A foreground-window change triggers capture after a five-second dwell.
- Default capture scope is only the foreground window.
- Settings offer an all-monitors capture scope.
- Pixel-level perceptual deduplication runs before queue insertion.
- The user-visible duplicate-similarity threshold defaults to 92 percent. Exact matches always
  discard; at-or-above-threshold matches in the relevant recent context are audited as skipped
  duplicates.
- Replace the Gate C provisional minute cadence and perceptual-distance fields completely; do not
  retain compatibility fields or parallel paths.

### Image processing

- Gate D must use SiftKit's implemented image path. The earlier assistant no-image invariant is
  obsolete and must be replaced in the Gate D design/spec.
- Enabling screenshots also enables automatic image analysis; there is no second vision-consent
  toggle.
- Image work runs only when the exact active runtime/preset is positively image-capable. Do not
  start, switch, or load another model automatically.
- If the active LLM cannot process images, Settings, tray, and status show an explicit warning/error.
- Unprocessed captures enter `awaiting_image_capability`. Do not substitute OCR or accessibility
  text as memory extraction. Accessibility may be used only for pre-capture privacy suppression.
- Surviving queued captures are processed exactly once when a compatible runtime becomes active.
- The queue obeys the 72-hour/5-GB limits. Capacity pressure deletes oldest captures first and
  records an audit-history event.
- Model output is untrusted, schema-validated, tool-free, passive evidence. A single image remains
  low-confidence and cannot directly establish a stable preference.

### Activity, startup, and lifecycle

- Activity metadata is on by default when the assistant is enabled; onboarding and tray state make
  that visible. Private mode or tray pause stops activity and screenshots immediately.
- Store privacy-filtered normalized titles in activity tables. Raw titles may exist only as
  encrypted short-retention evidence when policy permits; otherwise discard them.
- Do not silently register login startup. Expose an explicit `Start SiftKit Assistant when I sign
  in` setting; disabling or uninstalling removes the registration.
- The shell connects to an existing compatible status server when present; otherwise it starts one
  as a managed child.
- Closing the dashboard leaves the tray and shell-owned daemon running.
- `Quit SiftKit Assistant` gracefully stops capture/jobs and terminates only the daemon process tree
  launched by that shell. It never kills an independently launched server.

## Existing code seams to reuse

- `src/assistant/crypto/key-provider.ts`: `AssistantKeyProvider` and `FileKeyProvider`.
- `src/assistant/crypto/blob-cipher.ts`: current AES-256-GCM evidence envelope.
- `src/assistant/inference/client.ts`: current text-only assistant inference interface; Gate D must
  replace it with a strictly validated text-or-image request contract without weakening text roles.
- `src/llm-protocol/image-attachments.ts` and `preset-image-admission.ts`: existing image parsing,
  limits, and preset admission.
- `packages/contracts/src/image.ts`: shared validated image contracts.
- `src/assistant/questions/environment-state.ts`: unavailable Gate C environment provider seam.
- `src/assistant/jobs/resource-policy.ts`: unavailable Gate C power provider seam.
- `src/process-tree.ts`: Windows process-tree cleanup behavior.
- `dashboard/src/tabs/settings/AssistantSettings.tsx`: provisional observation controls to replace.

Current image support is real: managed EXL3 presets use `VisionEnabled`, image data URLs are runtime
validated and bounded, and image-bearing chat/repo surfaces have E2E coverage. The Gate D assistant
path must reuse this admission logic rather than duplicate it.

## Toolchain state and installation constraint

- Node `v24.14.0` and npm `11.9.0` are installed.
- Rust and Cargo are not installed or on PATH.
- Visual Studio 2022 Community with the x64 C++ tool component is already installed at
  `C:\Program Files\Microsoft Visual Studio\2022\Community`.
- Microsoft Edge/WebView2-compatible runtime is present (`151.0.4129.72`).
- The user authorized installing the Rust/Tauri prerequisites, but requested that installable tools,
  caches, and artifacts live under
  `C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\` for easy tracking/removal.
- Do not modify global PATH. Add repository scripts that set task-specific `RUSTUP_HOME`,
  `CARGO_HOME`, and PATH for Gate D commands, plus a manifest/cleanup procedure.
- Existing Visual Studio and Edge components are system installations and must be reused, not
  reinstalled. Record this honest boundary; do not claim deletion of the portable tooling folder
  removes those pre-existing system components.

## Required next steps

1. Continue the `superpowers:brainstorming` workflow. No Gate D code may be written before design
   approval.
2. Present two or three architecture approaches. Recommend a thin Tauri native shell/adapters plus
   authenticated daemon ingestion, reusing the existing dashboard and assistant core. Explicitly
   resolve secure-key/daemon crypto flow and runtime-instance image capability invalidation.
3. Present the design in reviewable sections: architecture/boundaries; versioned DTOs and transport;
   key migration; capture/activity state machines; image queue/capability lifecycle; UI/tray/popup;
   retention/errors; tests/packaging/cleanup. Obtain user approval.
4. Write the approved spec to
   `docs/superpowers/specs/2026-08-10-assistant-gate-d-desktop-observation-design.md` and self-review
   it. Do not commit despite the generic skill wording because the user explicitly forbids commits.
5. Ask the user to review the written spec.
6. Use `superpowers:writing-plans` to create
   `docs/superpowers/plans/2026-08-10-assistant-gate-d-desktop-observation.md`.
7. After plan approval, execute inline with TDD and no SiftKit/subagents/worktrees/commits.

## Known risks

- The approved 30-second cadence can produce substantial disk and GPU pressure; dedupe, idle/GPU
  resource policy, retention, and oldest-first eviction must be enforced before rollout.
- OS-keychain ownership and Node daemon image decryption/analysis need one explicit authenticated
  IPC design. Never pass key material through React, logs, CLI arguments, or persistent config.
- Foreground-window capture must remain silent while correctly handling multi-monitor bounds,
  scaling, minimized/cloaked windows, secure desktop, and protected-content failures.
- Runtime capability must be tied to the exact active runtime instance. A preset flag alone is not
  sufficient proof after restart, unload, or health degradation.
- The repository-local `.siftkit/runtime.sqlite` contains old preset rows missing the required
  `assistantMemory` field and currently fails loudly on status-server startup. It was not modified.
- Browser visual inspection was unavailable during Gate C; component/E2E/build validation passed.

## Pause point

Stop here. No Gate D code, dependency installation, package scaffolding, migration, or config change
has been made. Resume by presenting architecture approaches and the first design section for user
approval.
