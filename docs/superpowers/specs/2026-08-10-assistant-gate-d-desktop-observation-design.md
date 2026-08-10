# Assistant Gate D — Desktop Observation Design

Date: 2026-08-10  
Status: approved section-by-section in session; supersedes the Gate D portions of
`assistant/2026-07-30-siftkit-assistant-design.md` where they conflict.  
Prerequisites: Gate C complete (uncommitted workspace changes on `main`,
base `a9fc22b58cac658924fd756c65b9d80f59ebe856`).

Gate D delivers the desktop-observation layer: a Tauri 2 shell with Rust Windows adapters,
tray and native question popup, activity metadata and sessionization, silent encrypted
screenshot capture, an image-extraction queue gated on live runtime vision capability,
retention, and Windows-protected key custody.

## 0. Superseded invariants

- The assistant **no-image invariant** (design §12.6, §21.7, `AssistantInferenceRequest.userText`
  comment) is obsolete. Gate D replaces it with a strict text-or-image request contract (§5).
  Its guard tests are replaced, not weakened: tool-free, schema-validated output remains
  mandatory for every assistant inference request.
- The Gate C provisional observation config fields `FixedCadenceMinutes` and
  `MinimumPerceptualDistance` are removed and replaced completely (§4). No compatibility
  fields, migrations keep the config strict and fail loudly on unknown/missing fields as today.

## 1. Architecture and boundaries

Three processes:

1. **Node daemon (status server)** — authoritative for all assistant state. Gains: ingestion
   routes, capture-policy decisions (dedupe thresholds, queue admission), encryption at rest,
   the screenshot/image queue, retention, and the replaced image-capable inference client.
   Runs headless without the shell: chat memory works; activity/capture are simply unavailable.
2. **Tauri 2 shell (`desktop/`)** — Rust, privileged. Tray, native question popup, Windows
   adapters (foreground, idle, lock/secure-desktop, power, capture, accessibility preflight,
   DPAPI key custody), and an "Open dashboard" webview pointed at the existing dashboard URL.
   No second UI implementation.
3. **React dashboard** — unchanged host. Gains the replaced observation settings and per-item
   screenshot preview. No OS access, no key material.

**Startup/ownership.** The shell probes the configured status port. Compatible server present →
connect. Absent → spawn the daemon as a managed child and supervise it. Closing the dashboard
window leaves tray + daemon running. `Quit SiftKit Assistant` gracefully stops capture/jobs and
terminates only the process tree this shell launched (Rust-side equivalent of
`src/process-tree.ts` semantics: `taskkill /PID <pid> /T /F`, `SIGTERM`-equivalent fallback).
It never touches an independently launched server.

**Boundary rules (test-enforced):**

- All Win32/`unsafe` code lives under `desktop/src-tauri/src/platform/windows/`;
  platform-neutral traits sit above it (`NativeActivityProvider`, `NativeCaptureProvider`,
  `NativeAccessibilityProvider`, `NativeSecureKeyProvider`, `NativeNotificationProvider`,
  `NativePowerStateProvider`).
- Rust holds zero memory semantics: no ontology, confidence, dedupe policy, or retention
  decisions. It computes bytes, hashes, and privacy-preflight facts, then ships DTOs.
- React never sees key material or capture bytes except explicit confirmed preview responses.
- Every shell↔daemon payload carries `schemaVersion`; unknown versions fail closed with an
  audit event.
- Assistant domain modules import no Tauri/Win32 symbol; the shell imports no graph/memory code.

**New layout:** `desktop/` (Tauri app: `src-tauri/` Rust + minimal popup/tray webview assets),
daemon modules `src/assistant/observation/` (ingestion, capture policy, dedupe, activity
sessionization) and `src/assistant/images/` (queue, capability gate, extraction).

Considered and rejected: a fat Rust shell owning capture/dedupe/encryption/retention (violates
the no-memory-semantics boundary, duplicates logic outside the TDD harness) and daemon-side
capture via native helpers with toast notifications (no tray lifetime, no confirmed-render
`shown` semantics, OS calls leak into Node).

## 2. Versioned DTOs and transport

**Contracts.** New `packages/contracts/src/assistant-desktop.ts`: strict zod schemas, types via
`z.infer`, every DTO carries `schemaVersion: z.literal(1)`. Rust mirrors them as serde structs.
Golden JSON fixtures under `desktop/contract-fixtures/` are parsed by both the Rust tests and
the Node contract tests so the two sides cannot drift silently.

DTO families:

- **`ActivityEventDto`** — foreground context (process name, executable path, application id,
  normalized privacy-filtered title, fullscreen), idle seconds, session locked, capturedAtUtc.
- **`EnvironmentStateDto`** — fullscreen / locked / do-not-disturb / presenting / excluded
  application / seconds-since-input, plus power (AC or battery, percent). Feeds the Gate C
  `QuestionEnvironmentStateProvider` and `PowerStateProvider` seams.
- **`CaptureSubmissionDto`** — PNG bytes as a bounded base64 data URL (existing validated
  image-admission limits), display descriptor (logical + pixel dimensions, scale), capture
  reason (`fixed_cadence | window_change | manual`), foreground-context key, pixel SHA-256,
  perceptual hash, capturedAtUtc.
- **`SuppressionAuditDto`** — non-content record of a suppressed or discarded capture: rule id
  only, never title or pixels of the suppressed target.
- **Question DTOs** — pending-question view for the popup; `shown`-confirmation, `dismissed`,
  and answer submissions.
- **Key custody DTOs** — custody status, key export to shell, key import to daemon (§3).

**Transport.** Shell → daemon over the existing authenticated loopback `/assistant/*` surface;
the shell bootstraps a bearer once per shell lifecycle and keeps it memory-only, exactly like
the dashboard controller. New routes: `POST /assistant/ingest/activity`,
`/assistant/ingest/environment`, `/assistant/ingest/capture`, `/assistant/ingest/suppression`.
For daemon → shell state (pending question, capture-enabled state, image-capability warning,
custody status) the shell **polls** a compact `GET /assistant/desktop/state` endpoint —
no SSE/WebSocket. Poll interval configurable, default 5 s.

**Staleness = unavailable.** The daemon caches the last `EnvironmentStateDto`; when it is older
than the heartbeat deadline (default 60 s; the shell pushes every 20 s and on every change),
the environment/power providers report `unavailable` and questions/capture fail closed exactly
as headless mode today.

**Version mismatch.** Unknown `schemaVersion` in either direction: reject with 400, write an
audit event, shell halts capture and shows a tray attention state. No best-effort parsing.

## 3. Key migration and custody

**At-rest custody.** The shell protects the key set with per-user DPAPI (`CryptProtectData`),
stored as one blob file under the runtime root (`.siftkit/assistant-keys.dpapi`). The logical
schema matches the existing key file (`activeKeyId` + `keys` map) so multi-key support carries
over. All DPAPI calls live in `desktop/src-tauri/src/platform/windows/`. Credential Manager is
deliberately not used.

**Custody modes.** New strict config field `Assistant.KeyCustody: 'file' | 'desktop'`.
`'file'` keeps `FileKeyProvider` as the explicit headless configuration. `'desktop'` means the
DPAPI blob is authoritative and no plaintext key file may exist. No automatic fallback in
either direction.

**Migration** (runs when the shell connects and custody is `'file'`):

1. Shell requests custody status; daemon reports `'file'` with active key id(s).
2. Daemon sends key material to the shell over the authenticated loopback channel, memory-only.
3. Shell writes the DPAPI blob, then re-reads and unprotects it (round-trip proof).
4. Shell POSTs the recovered material to `/assistant/keys/import`; the daemon verifies the key
   ids match and decrypts one existing evidence blob (or runs a cipher self-test when no
   evidence exists).
5. Only then: the daemon deletes the plaintext key file and sets `KeyCustody: 'desktop'`.

Any failure at steps 2–4 leaves the file key untouched, aborts the migration, stops capture,
and raises a loud tray + dashboard error. There is no partial state in which both stores are
authoritative.

**Steady state.** On every daemon (re)start or shell reconnect, the shell unprotects the blob
and POSTs the material to `/assistant/keys/import`; the daemon holds it in a new
`ImportedKeyProvider implements AssistantKeyProvider` — memory only, never persisted daemon-side.
Custody `'desktop'` with no import yet → encrypt/decrypt unavailable: capture ingestion
rejected, decryption-dependent jobs pause with an explicit reason, loud status. Key material
never appears in React, logs, argv, config, or audit rows (key id only).

## 4. Capture and activity

**Activity pipeline.** The shell emits `ActivityEventDto` on foreground change and on the same
20 s heartbeat as `EnvironmentStateDto` while the session is unlocked. Privacy filtering normalizes titles in Rust before the DTO exists; a
raw title may ride along only when policy permits its short-retention encrypted evidence use,
otherwise it is dropped pre-serialization. Daemon-side `src/assistant/observation/` stores
activity rows and sessionizes them (app session = same foreground identity, gap-bounded) into
observations — never directly preferences. `ActivityMetadataEnabled` stays on by default when
the assistant is enabled; onboarding and tray state make that visible. Private mode or tray
pause stops activity and capture immediately: timers cancelled, in-flight submissions dropped.

**Config replacement** (complete, no compatibility fields):

| Removed | Replacement | Default |
| --- | --- | --- |
| `FixedCadenceMinutes` | `FixedCadenceSeconds` | 30 |
| `MinimumPerceptualDistance` | `DuplicateSimilarityPercent` | 92 |
| — | `CaptureScope: 'foreground_window' \| 'all_monitors'` | `foreground_window` |

`MinimumForegroundDwellSeconds` defaults to 5; `WindowChangeCapture` stays. Screenshot capture
(`ScreenshotsEnabled`) remains off by default and requires explicit enablement.

**Capture state machine (Rust).** Per trigger source `disabled → ready → cooldown`: a fixed
cadence tick every `FixedCadenceSeconds`, and a foreground change arming a
`MinimumForegroundDwellSeconds` dwell timer that resets if focus changes again. Every attempt
runs the fail-closed preflight **before any pixel is read**, in order:

1. private mode active;
2. session locked;
3. secure desktop / UAC prompt active;
4. unknown foreground identity;
5. process denylist match;
6. window-title deny pattern match;
7. private/incognito browser window;
8. fullscreen or game suppression (when configured);
9. fast secret/authentication/payment classification of the accessibility snapshot.

Any hit → `SuppressionAuditDto` (rule id only) and nothing else. Preflight errors count as
hits — unknown means no capture. Accessibility text is used only for pre-capture privacy
suppression, never as extraction input.

**Capture mechanics.** Foreground scope uses `PrintWindow` (`PW_RENDERFULLCONTENT`) / BitBlt;
all-monitors uses DXGI desktop duplication. Both are silent: no border, flash, focus change,
sound, toast, or cursor interruption (explicitly not Windows.Graphics.Capture with its capture
border). A passive tray state still shows that capture is enabled. Minimized/cloaked windows
and DRM-protected black frames → audited failure with bounded backoff, no retry storm.
Multi-monitor bounds and DPI scaling are resolved in Rust; the DTO carries logical and pixel
dimensions. Secret-classified content is discarded immediately and writes only a non-content
audit event.

**Dedupe (daemon, before queue insertion).** Exact pixel SHA-256 match against the relevant
recent context → always discard. Perceptual similarity ≥ `DuplicateSimilarityPercent` against
previous captures for the same foreground-context key within the retention window →
`skipped_duplicate` audit, no evidence. Rust computes the hashes; the daemon owns the
thresholds and the decision.

## 5. Image queue and capability lifecycle

**Queue.** A capture that survives preflight + dedupe is encrypted with the existing
`blob-cipher` envelope and stored as evidence, then enters a per-evidence state machine in
`src/assistant/images/`:

```
queued → processing → processed
queued → awaiting_image_capability → processing (capable runtime active)
any    → expired | evicted (retention §7) | discarded (secret classification)
```

The insertion state is decided by the capability gate at insertion time (`queued` when the
live runtime is image-capable, otherwise `awaiting_image_capability`); claim-time and
dispatch-time revalidation move items between the two.

Jobs run through the existing Gate C job runner — leases, interactive preemption, and the
resource policy (idle, GPU minutes, battery) apply unchanged; no new policy engine.
Exactly-once processing: the lease plus a `processed` marker keyed by evidence id; re-claims of
processed items are no-ops.

**Capability gate.** New `RuntimeImageCapabilityProvider` reads the **live runtime instance**:
`{ instanceId, visionCapable, healthy }` from the runtime manager. A preset's `VisionEnabled`
flag alone is never sufficient proof. The gate is checked at job claim (admission) and again
immediately before dispatch (revalidation). Instance restart, unload, preset switch, or health
degradation changes `instanceId` → an in-flight claim aborts cleanly back to
`awaiting_image_capability`. The gate never starts, switches, or loads a model. When the active
runtime is not image-capable, Settings, tray, and `/assistant` status show an explicit warning
with the queue depth.

**No substitution.** OCR/accessibility text is never used as memory extraction. Items wait in
`awaiting_image_capability` until a capable runtime is active or retention removes them. A
compatible runtime becoming active drains the queue oldest-first under resource policy.
Enabling screenshots enables automatic image analysis; there is no second vision-consent toggle.

**Inference contract replacement.** `src/assistant/inference/client.ts` is replaced with a
discriminated union: the existing text request shape (roles unchanged, structurally unable to
carry images) and a new image request carrying bounded validated image data URLs that reuse
`src/llm-protocol/image-attachments.ts` parsing/limits,
`src/llm-protocol/preset-image-admission.ts`, and `packages/contracts/src/image.ts` — no
duplicated admission logic. Decrypted bytes exist only inside the job for the duration of the
request. Both variants remain tool-free with schema-validated JSON output.

**Output handling.** Extraction results are untrusted passive evidence: schema-validated
candidates flowing into the existing Gate B/C consolidation. A single image is capped at low
confidence and cannot directly establish a stable preference — promotion requires
corroboration, enforced deterministically in consolidation, not by prompt.

## 6. UI, tray, and popup

**Tray (Rust).** Persistent; survives dashboard close. Icon states: assistant on, capture
enabled (passive indicator), paused, attention (key migration failure, version mismatch,
image-capability warning), question pending (badge). Menu: Open dashboard ·
Pause/Resume observation (single action; stops activity + capture immediately) ·
Quit SiftKit Assistant.

**Question popup.** A compact frameless Tauri window with its own minimal static webview
assets under `desktop/` (not the React dashboard). Offers answer, skip, snooze, and an
overflow with do-not-repeat / stop-topic; the full feedback set stays in the dashboard.
`shown` semantics: the popup webview signals after first paint → shell confirms to the daemon →
daemon marks the question `shown`. Queued-but-not-painted, notification failure, daemon
disconnect, or suppression never mark `shown`. Closing without answering records `dismissed`;
the dashboard still lists and can answer the question. Failed submissions keep the typed
answer in the popup with retry — never silently lost.

**Sign-in startup.** Explicit `Start SiftKit Assistant when I sign in` setting (default off).
The shell reconciles an HKCU Run registration to match; disabling the setting or uninstalling
removes the registration. No silent registration.

**Dashboard (React, no OS access).** The observation section of
`dashboard/src/tabs/settings/AssistantSettings.tsx` is fully replaced: screenshot enable (off
by default, plain-language consent text including "enabling screenshots enables image
analysis"), cadence seconds, capture scope, similarity threshold, dwell seconds, process/title
deny lists, retention hours/GB, sign-in startup, key-custody status, image-capability warning
with queue depth. Evidence browsing shows metadata only by default (time, app identity,
display, size, queue state). Pixel reveal is per-item behind an explicit confirmation; the
daemon decrypts and serves bytes over the authenticated loopback; the dashboard holds them in
memory only (object URL revoked on preview close or auth loss), nothing cached.

## 7. Retention and errors

**Retention.** A retention job (existing job runner, deterministic) enforces the earlier of
`RawRetentionHours` (default 72) and `RawStorageLimitGb` (default 5): expired or
capacity-evicted blobs are deleted, evidence marked `expired`/`evicted`, an audit-history
event written, and the confidence of any dependent assertion recalculated. Capacity pressure
evicts oldest-first and applies equally to `awaiting_image_capability` items — a stalled queue
cannot grow past the caps. Normalized titles in activity tables are durable observations; raw
titles, where policy permits them at all, exist only as encrypted evidence under the same
short retention. Suppression audits are non-content and follow the existing unbounded audit
history, not blob retention.

**Error handling — fail loud, fail closed:**

- **Key unavailable / migration failure** — capture ingestion rejected, decrypt-dependent jobs
  pause with explicit reason, tray attention state + dashboard error. No silent file-key
  fallback.
- **Version mismatch** — 400 + audit; shell halts capture, tray attention state.
- **Capture failures** (DRM black frame, API error, cloaked window) — audited, bounded
  exponential backoff per failure class; the cadence never becomes a retry storm.
- **Daemon disconnect** — shell halts capture immediately (no local buffering: nothing is
  captured while there is nowhere authenticated to send it), tray shows disconnected.
  Shell-managed daemon: supervised restart with backoff, attention state after repeated
  failures. External daemon: the shell polls for reappearance and reconnects.
- **Shell crash** — daemon and its queue continue (image jobs, retention, dashboard work);
  activity/environment go stale → providers report `unavailable` → questions/capture fail
  closed exactly as headless mode. The next shell start reconnects.
- **Popup failure** — the question stays pending and dashboard-visible; never marked `shown`.

## 8. Tests, packaging, toolchain

**Testing (TDD throughout).** Normal CI stays GPU-free, desktop-free, screenshot-free.

- **Daemon (`node:test`, existing harness):** ingestion route auth/validation/version
  rejection; dedupe policy (exact, ≥ threshold, context scoping); custody state machine and
  migration protocol (daemon half, fake shell); `ImportedKeyProvider`; image queue lifecycle
  including the capability gate against fake runtime instances (restart/unload/degrade
  mid-claim); inference contract union (text roles structurally image-free, image path reuses
  admission limits); single-image confidence cap in consolidation; retention/eviction
  including awaiting items; environment staleness → unavailable providers; settings and
  preview component tests.
- **Rust (`cargo test`):** preflight ordering including unknown-identity fail-closed,
  capture/dwell state machines, title normalization, serde against the shared golden
  fixtures, DPAPI round-trip (Windows-only test). Win32 calls sit behind traits so logic
  tests run with fakes.
- **Contract fixtures** in `desktop/contract-fixtures/` parsed by both suites — drift fails
  one side loudly.
- **E2E (Node, fake shell client):** capture DTO → evidence → queue → fake image-capable
  runtime → schema-validated candidate → consolidation; suppression produces audit only;
  injection-bearing screen content mutates no policy; expiry recalculates confidence;
  disabled assistant does zero work.
- **Manual smoke script** (dev-only, not CI): real capture on this machine, verifying silence
  and multi-monitor bounds.

**Toolchain.** Portable rustup/cargo under
`C:\Users\denys\Documents\GitHub\.tooling\siftkit-gate-d\` via `RUSTUP_HOME`/`CARGO_HOME`;
repo scripts (`npm run desktop:dev|build|test`) set those env vars per invocation — global
PATH untouched. A manifest + cleanup doc records exactly what was installed and how to remove
it, stating plainly that the pre-existing Visual Studio 2022 and WebView2 are reused system
components that deleting the portable folder does not remove.

**Packaging.** `tauri build` NSIS installer as the deliverable artifact; dev flow uses
`tauri dev`. Uninstall removes the Run-key registration. No auto-update, no code signing in
this gate.

## 9. Out of scope

macOS/Linux adapters (traits stay portable; no adapter work), mobile client, OCR-based memory
extraction, key rotation UI, auto-update, code signing, embeddings, any change to the status
server's default bind or non-assistant route authentication.

## 10. Known risks

- The 30-second cadence can produce substantial disk and GPU pressure; dedupe, resource
  policy, retention, and oldest-first eviction must be in place before capture defaults are
  exercised for long periods.
- Silent foreground capture must correctly handle multi-monitor bounds, scaling,
  minimized/cloaked windows, secure desktop, and protected-content failures; the manual smoke
  script verifies silence because CI cannot.
- The repository-local `.siftkit/runtime.sqlite` contains pre-Gate-B preset rows missing
  `assistantMemory` and fails loudly on status-server startup by design; development runs use
  an isolated temp runtime.
