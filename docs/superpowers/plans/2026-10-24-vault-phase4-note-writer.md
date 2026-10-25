# Vault Phase 4 — Note-writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the vault's write side: attachments, FTS, owner identity, LLM edit operations and their applier, the capture, chat, daily and tidy writers, vault capture intake and retention, and the chat retriever. Each is built and tested on its own. None is wired into `AssistantService` or the job runner until Phase 5.

**Architecture:** Everything lives under `src/vault/` and writes only through `VaultNoteStore`. The model-backed writers reuse the existing `StructuredOutputRunner` (one repair retry), the image capability gate, `SecretScanner`, `AuditStore` and `QueryIntentExtractor`. Each writer exposes a single `run(...)` method; Phase 5 maps the new job types onto them.

**Tech Stack:** TypeScript on Node 26, better-sqlite3 with fts5, zod, `node:test`.

---

## Decisions

- **Not wired in Phase 4:**
  - Writers and intake do not enqueue jobs, and the job types are not added yet. The runner's dispatch is exhaustive over `ASSISTANT_JOB_TYPES`, so adding types now would need dead handlers. Instead, intake returns the attachment id, and Phase 5 adds `capture_note`, `chat_note`, `daily_rollup`, `note_tidy` and the vault `capture_retention`, then enqueues them.
  - Config is passed as explicit parameters: retention gets `{ limitBytes, maxAgeDays }` and the retriever gets `{ maxContextTokens, maxNotes }`. Phase 5 adds the `Vault` config block and the slimmed `Retrieval`.
- **New inference roles:** `vault_capture_writer`, `vault_chat_writer`, `vault_tidy`. Each has a prompt version.
- **New actor:** `note-writer · daily` is added to `VAULT_ACTORS` for the deterministic rollup.
- **Attachments:**
  - Files live at `<runtimeRoot>/vault/attachments/<relative_path>`. A capture's relative path is `captures/<attachmentId>.png`.
  - A note embeds the file as `![[attachments/<relative_path>]]`.
  - `GET /assistant/vault/attachments/<relative_path>` serves the bytes, and refuses any path that escapes the root with a 404.
  - Showing images in the dashboard is left to Phase 5, which is when captures start producing attachments.
- **FTS:** `vault_notes_fts(note_id UNINDEXED, title, aliases, body)` is rebuilt for a note on every store write and deleted with the note. Queries quote each term and join them with `OR`, ranked by bm25.
- **Owner:**
  - The owner note is the one tagged `#me`. `ensureOwnerNote(displayName)` creates it when it is missing.
  - `OwnerIdentity.matches(name)` follows spec §4.2:
    - possessives and paths never match;
    - the owner's title or aliases match;
    - the pronoun list matches;
    - a `user <x>` prefix is stripped before matching;
    - otherwise the name is compared to the owner's first name within Levenshtein distance 2, or 3 when the name contains `y`. The name must start with the same letter and be at least 4 characters long.
  - The edit-distance check reuses `editDistanceWithin`.
- **Edit operations:**
  - The response schema is flat and strict, a discriminated union on `op`, and its JSON schema contains no `$ref`.
  - The applier groups edits per note and writes **one revision per note per job**.
  - **Values** resolve to `[[Title]]` when they name an existing note or the owner; otherwise they stay plain text.
  - **Unknown notes:** an operation that targets an unknown note is dropped. Only `create_note` creates notes.
  - **Secrets:** a string that matches the secret scanner drops its operation.
  - **Audit:** every dropped operation gets an audit event, and the job continues.
  - **Learned:** a `learned` operation becomes the line `- [[Note]]: **Label** value` in the source note's `## Learned` section.
- **Notes the writers produce:**
  - **Capture note:**
    - Title `YYYY-MM-DD HH.MM.SS · App`, in folder `Captures/YYYY-MM-DD`, kind `capture`.
    - Its body is the embed, then a context line `` [[App]] · `window title` · trigger ``, then a `> [!pending]-` callout.
    - The writer replaces the callout with `## Learned`.
  - **Chat note:**
    - Title `Chat YYYY-MM-DD · <session title>`, in folder `Chats`, kind `chat`.
    - Its transcript lives under `## Transcript`, as `#### You` and `#### Assistant` headings. Bold-label lines are not used because they would parse as fact rows.
    - `## Learned` comes after the transcript.
  - **Daily note:**
    - Title `YYYY-MM-DD`, in folder `Daily`, kind `daily`.
    - Its body is a summary line, the capture embeds, `## Learned` (the union over the day's capture and chat notes) and `## Chats`.
- **Retention:** retention deletes PNG files only. The capture state becomes `image_removed` and the note is kept.
- **Shared code moved, not copied:**
  - Perceptual-hash similarity and data-URL decoding move into `src/assistant/observation/capture-image.ts`, used by both intakes.
  - The chat suppression pattern and `stripUntrustedSpans` move into `src/vault/note-writer/chat-text.ts`; the legacy ingestor and extractor import them from there.

## Tasks (each TDD: failing test → implementation → green)

1. **Schema, FTS and store:** add `vault_notes_fts`, `vault_attachments` and `vault_captures`. The store keeps FTS in sync on create, update, rename, restore and delete. Add `searchNoteIds(terms, limit)`. Tests: `tests/vault-fts.test.ts`.
2. **Attachments, plus the attachments route:** `VaultAttachments.write`, `read` and `removeFile`, with containment checks. Tests: `tests/vault-attachments.test.ts`, plus a route case in `tests/vault-routes.test.ts`.
3. **Owner identity and `ensureOwnerNote`.** Tests: `tests/vault-owner-identity.test.ts`.
4. **Edit-operation schema and `VaultEditApplier`.** Tests: `tests/vault-edit-applier.test.ts`.
5. **Capture intake (vault):** dedupe and admission as in the legacy intake. It writes the attachment, the pending capture note and the `vault_captures` row. Tests: `tests/vault-capture-intake.test.ts`.
6. **Capture writer:** uses the capability gate and the FTS candidate titles, and terminal failure still leaves an empty `## Learned`. Tests: `tests/vault-capture-writer.test.ts`.
7. **Chat writer:** handles suppression, keeps the transcript, writes `## Learned`, and strips untrusted spans from the prompt. Tests: `tests/vault-chat-writer.test.ts`.
8. **Daily rollup.** Tests: `tests/vault-daily-rollup.test.ts`.
9. **Tidy pass.** Tests: `tests/vault-tidy-pass.test.ts`.
10. **Capture retention.** Tests: `tests/vault-capture-retention.test.ts`.
11. **Retriever:** the owner lead is always first, notes come from FTS, and the binary search fits `maxContextTokens`. Tests: `tests/vault-retriever.test.ts`.
12. **Verification:** `npm run typecheck`, `npm test`, `npm run test:dashboard`.

## Status

Tasks 1–12 are implemented and verified. Decisions settled during implementation:

- **Local time:** capture, chat and daily titles and folders use the machine's local time (`src/vault/vault-time.ts`).
- **`vault_captures`** also stores `app` and `window_title`, so the capture writer never parses the note body. Row access lives in `src/vault/captures.ts`.
- **`vault_chat_notes(session_id, day, note_id)`** maps a chat session's local day to its note. The daily rollup reads it.
- **`searchNoteIds(terms, kinds, limit)`** filters by note kind. Writers offer only entity notes as candidates; the retriever searches entity and free notes.
- **`VaultNoteStore.availableTitle(base)`** numbers clashing titles (`… 2`). The capture intake and the chat writer both use it.
- **Contracts:** `sectionLines` reads a section; `insertSectionLines` appends without dedupe for transcripts.
- **Chat writer:**
  - The model runs before anything is written, so a retried job never duplicates a transcript.
  - Messages with credential material are withheld from both the transcript and the model.
  - Heading and callout lines in messages are escaped.
- **Shared constants:** folders, the `## Learned` heading and the pending callout are defined once, in `src/vault/vault-layout.ts`.
- **Raw samples:** a rejected model answer's raw sample is audited only when the secret scanner finds nothing in it (`note-writer/rejections.ts`).
- **Intake cleanup:** an intake whose rows fail to write deletes its attachment file and row (`VaultAttachments.delete`).
