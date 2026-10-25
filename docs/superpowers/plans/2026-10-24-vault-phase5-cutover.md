# Vault Phase 5 — Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose `AssistantService` around the vault. Screenshots, chat turns and chat retrieval go to the vault; the config is slimmed; the legacy graph write paths, routes and UI are removed.

**Architecture:** The Phase 4 writers become job handlers in the existing runner (leases, gates, preemption and the decision log are all unchanged). Intake and chat ingestion enqueue jobs, and finished note jobs enqueue the daily rollup and the tidy pass. The legacy graph stays behind for the Phase 6 migration, read-only: its stores, crypto and key custody, plus backup, restore, export and factory reset of the legacy data.

**Tech Stack:** TypeScript on Node 26, better-sqlite3, zod, `node:test`, React and vitest.

---

## Decisions

- **Dead code is deleted now.** Slimming the config removes what the legacy write path reads (`Memory`, `Questions`, the graph `Retrieval` knobs, `Retention`, `Mobile`), so Phase 5 deletes every module that becomes unreferenced, and their tests, rather than keeping dead code until Phase 7. Phase 7 keeps:
  - the graph stores and crypto;
  - backup, restore, export and factory reset;
  - the evidence writes in `ActivityLog`;
  - the legacy tables;
  - the shell DTO fields.
- **Config:** `Assistant` = `Enabled`, `Owner`, `Retrieval{MaxContextTokens, MaxNotes}`, `Observation`, `Background`, `PrivateMode`, `Vault{TidyPassEnabled, CaptureImageMaxAgeDays}`, `KeyCustody`.
  - `JobPriorities` = `CaptureNote 400, ChatNote 800, DailyRollup 500, NoteTidy 100, CaptureRetention 900`. `Retrieval.MaxNotes` defaults to 8.
  - Normalization ignores the removed keys, so stored configs keep loading.
- **Jobs:** `capture_note{attachmentId}`, `chat_note{turn}`, `daily_rollup{day}`, `note_tidy{noteId}`, `capture_retention{reason}`.
  - `capture_note`, `chat_note` and `note_tidy` are model-backed.
  - **Upgrade 86 → 87** deletes `assistant_jobs` rows of retired types; the job row schema would otherwise reject them.
- **Follow-ups:** a `capture_note` or `chat_note` that writes a note enqueues `daily_rollup` for the note's local day. When `TidyPassEnabled`, it also enqueues `note_tidy` for each touched entity note.
  - All follow-up keys are live-idempotent, so at most one job per day or per note waits.
  - The tidy pass skips a note whose latest revision is already its own, so an unchanged note is never re-tidied.
- **Capture flow:**
  - **Intake:** `ingestCapture` → `VaultCaptureIntake`. A `queued` capture enqueues `capture_note`. An intake that pushes live PNG bytes over `RawStorageLimitGb` enqueues `capture_retention{capacity}`.
  - **Each drain:**
    - schedules `capture_retention{schedule}`;
    - re-queues captures stranded in `processing` without a live job;
    - enqueues waiting captures when image capability is usable, as the legacy drain did.
  - **Retention limits:** `RawStorageLimitGb` and `Vault.CaptureImageMaxAgeDays`, where 0 means no age limit.
- **Chat flow:**
  - `ingestChatTurn` enqueues `chat_note` with the turn, including the session title. The seam passes `session.title`.
  - `retrieveMemoryContext` → `VaultRetriever` with `Retrieval` limits.
- **Owner:**
  - Enabling the assistant, or refreshing the config while enabled, ensures the `#me` note titled `Owner.DisplayName`.
  - A changed display name renames the note; the old title stays as an alias.
- **Status and desktop state:**
  - `AssistantStatusResponse` drops `pendingQuestionCount` and `pendingValidationCount`.
  - `DesktopStateDto` keeps its shape until Phase 7: `pendingQuestion` is always `null`, and `queueDepth` counts vault captures in `queued` or `awaiting_image_capability`.
  - `PendingCaptureDto` becomes `{attachmentId, noteId, noteTitle, state, capturedAtUtc, byteLength, relativePath}`.
  - Suppression audits move to `VaultCaptureIntake.recordSuppression`.
- **Routes kept:**
  - `status`, `background-decisions`, `config`, `keys/*`;
  - `ingest/{environment,activity,capture,suppression}`;
  - `factory-reset/*`, `export`, `backup`, `restore-preview`, `restore`;
  - `captures/pending`, `desktop/state`, `vault/*`.
- **Routes removed:** `search`, `graph/*`, `evidence/*`, `topics/*`, `cleanup/*`, `ingest/mobile`, `projections/*`, `questions/*`, `policies/*`, `validation/*`, `history`. Their contracts and dashboard clients go too.
- **Dashboard:**
  - **Settings → Assistant:** the configuration groups follow the new config. The views become `Configuration` and `Pending captures`, whose previews come from vault attachments. Validation and memory history are removed.
  - **Notes:** `NoteMarkdown` renders attachment embeds as images, fetched with the bearer token into object URLs. A missing file renders "image removed".

## Tasks (each TDD: failing test → implementation → green)

1. **Config:** contracts schema, defaults and normalization. Tests: `tests/assistant-config.test.ts`.
2. **Job types, job store and the 86 → 87 upgrade.** Tests: `tests/assistant-job-store.test.ts`, `tests/vault-job-upgrade.test.ts`.
3. **Job runner over the vault writers, with follow-ups.** Tests: `tests/assistant-job-runner.test.ts`.
4. **Tidy skip:** the tidy pass skips a note whose latest revision is already a tidy. Tests: `tests/vault-tidy-pass.test.ts`.
5. **`AssistantService` recomposition:**
   - capture, chat, retrieval, owner note;
   - drain scheduling;
   - desktop state and pending captures;
   - suppression.
   Tests: `tests/assistant-service.test.ts`, `tests/assistant-chat-seam.test.ts`, `tests/assistant-desktop-state.test.ts`, `tests/assistant-pending-captures.test.ts`.
6. **Routes and contracts:** remove the unplugged routes, slim the status response, and serve vault pending captures. Tests: `tests/assistant-routes.test.ts`, `tests/assistant-contracts.test.ts`.
7. **Delete the legacy modules** left unreferenced by tasks 1–6, and their tests. Verify with typecheck and an import scan.
8. **Dashboard:** settings, API clients, pending-capture previews, attachment embeds. Tests: `dashboard/tests/*`.
9. **Cutover E2E through the status server:** capture → drain → capture note and daily note; chat turn → chat note; retrieval context. Tests: `tests/vault-cutover-e2e.test.ts`.
10. **Verification:** `npm run typecheck`, `npm test`, `npm run test:dashboard`. Update the spec's Phase 7 list to what remains.
