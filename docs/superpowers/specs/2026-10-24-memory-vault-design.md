# Memory vault — design

**Status:** design approved via mockup (`docs/mockups/vault/`), 2026-10-24.
**Replaces:** the triple-graph assistant memory (`src/assistant/graph`, `ingestion`, `projections`, `questions`, candidates, policies) and the Assistant tab's Memory Inspector.

## 1. Goal

Memory becomes a custom vault of linked markdown notes, styled after Obsidian but built from scratch and shown inside the SiftKit dashboard. It replaces subject–predicate–object assertions. Background jobs read screenshots and chat turns and edit notes directly. Every write creates a revision. All existing memory is migrated into the vault, including queued screenshots and unpromoted candidates.

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| Source of truth | SQLite tables in `runtime.sqlite`. Screenshot PNGs are files on disk. A one-click export writes a folder of `.md` files. |
| Triple graph | Replaced entirely. Its code and tables are deleted after migration. |
| LLM edits | Applied directly. Every write is a revision with diff and restore. There is no approval queue. |
| Privacy at rest | Everything is plaintext: notes, and screenshots stored as PNG attachments. Evidence encryption and key custody are removed. |
| Migration | Deterministic, one note per entity, followed by a background LLM tidy pass. |
| Migrate | Queued screenshots, pending and needs-confirmation candidates, all active screenshots, and chat messages. |
| UI v1 | Core vault plus graph view, exactly as in the approved mockup. |

## 2. Vault model

A **note** has:

- a unique `title`, compared case-insensitively;
- a `folder` path;
- a `kind`: `entity | capture | daily | chat | note`;
- frontmatter: `types[]`, `aliases[]`, `tags[]`;
- a markdown `body`;
- `created_at` and `updated_at`;
- a monotonically increasing `revision`.

The body uses one small dialect, parsed by a single shared module (§4.1):

- **Lead paragraph**: the first paragraph, rendered larger.
- **Fact rows**: `**Label** [[A]] · [[B]] · plain value`. Values are separated by ` · `. Links render as pills and plain values as text pills.
- **Wikilinks**: `[[Title]]` and `[[Title|label]]`. A link to a missing note is *unresolved*.
- **Tags**: `#tag` inline, plus frontmatter tags.
- **Tasks**: `- [ ] text` / `- [x] text`.
- **Callouts**: `> [!kind] title`. Adding `-` or `+` after `]` makes the callout foldable. The kinds used are `more`, `unverified` and `pending`.
- **Embeds**: `![[attachments/captures/<id>.png]]`. Consecutive embeds render as a thumbnail grid.
- Headings, bullets, code spans and fences.

An **entity note** has this canonical shape. Both the migration and the note-writer produce it, using the same builder (§4.1):

```
<lead sentence(s)>

**Uses** [[A]] · [[B]] · …           ← at most 8 values per row
**Works on** [[C]]

## Plans
- [ ] text

> [!more]- 140 more · uses
> [[…]] · [[…]]

> [!unverified]- 3 unverified facts
> - **Uses** [[GitHub]] #unverified
```

**Capture notes** live in `Captures/<day>/`. Each contains:
- the embed;
- a context line: app link, `` `window title` `` and trigger;
- a `## Learned` list, or a `pending` callout while the note-writer has not processed it.

**Daily notes** live in `Daily/`. Each contains a summary line, a thumbnail grid, `## Learned` and `## Chats`.

**Chat notes** live in `Chats/`. Each contains the transcript and `## Learned`.

**Owner**: one entity note tagged `#me`, titled `Assistant.Owner.DisplayName`. Its aliases are the identity list the note-writer uses to resolve "the user", "me", OCR misreads and similar references.

## 3. Storage

New tables are created with `CREATE TABLE IF NOT EXISTS` in the runtime schema bootstrap, the same pattern the assistant tables use today:

- `vault_notes(id, title, title_key UNIQUE, folder, kind, types_json, aliases_json, tags_json, body, revision, created_at_utc, updated_at_utc)`. `title_key` is the lower-cased title.
- `vault_note_revisions(note_id, revision, actor, summary, source_ref, title, folder, body, types_json, aliases_json, tags_json, created_at_utc)`, with primary key `(note_id, revision)`. Each row is a full snapshot.
- `vault_links(from_note_id, target_key, label)`. This is a derived index: `target_key` is the lower-cased link target, resolved against titles and aliases at read time through the `vault_key_owners` view, the single resolution rule: a title beats an alias, and among alias owners the oldest note (by `created_at_utc`) wins. `label` is the fact-row label, or `NULL`.
- `vault_aliases(alias_key, note_id)`: a derived index used for resolution.
- `vault_tags(note_id, tag)`: derived.
- `vault_notes_fts` (fts5 over title, aliases and body) is added in Phase 4 together with its first reader, the retriever and the capture-writer candidate lookup.
- `vault_attachments(id, note_id, relative_path, mime_type, byte_length, sha256, created_at_utc)`. Files live under `<runtimeRoot>/vault/attachments/…`.
- `vault_captures(attachment_id PK, note_id, state, foreground_context_key, pixel_sha256, perceptual_hash, captured_at_utc, processed_at_utc)`. `state` is one of `queued | awaiting_image_capability | processing | processed | image_removed`. This table holds dedupe and queue state only.

**Writes.** Every note write goes through `VaultNoteStore` in one transaction. The transaction:
1. checks the expected revision (optimistic concurrency, so a stale write throws `VaultConflictError`);
2. bumps `revision`;
3. inserts the revision snapshot;
4. rebuilds that note's links, aliases and tags (and FTS rows from Phase 4).

**Rename** runs in the same transaction. It rewrites `[[Old…]]` in every inbound note, which gives each of those notes its own revision, and appends the old title to the renamed note's aliases.

**Restore** writes an old snapshot as a new revision. History is never deleted.

## 4. Components

### 4.1 Shared: `packages/contracts/src/vault-markdown.ts`

Pure functions, used by the server, the migration and the dashboard renderer:

- `parseNoteBody(body)` → blocks and derived data: `links[]` (target, label, line), `tags[]`, `factRows[]`, `tasks[]`, `embeds[]`, lead text.
- `splitValues(text)`.
- `buildEntityBody({ lead, rows, tasks, more, unverified })`.
- `addRowValues(body, label, values)`. Deduplicates case-insensitively. Overflow beyond 8 values moves into the matching `more` callout.
- `replaceLead(body, lead)`.
- `rewriteLinks(body, oldTitle, newTitle)`.
- `confirmUnverified(body, line)` and `dropLine(body, line)`.
- `mergeEntityDraft(existingBody, draft)`: keeps the existing lead, adds rows through `addRowValues`, and appends tasks and unverified lines that are not already present.

### 4.2 Server: `src/vault/`

| Module | Responsibility |
|---|---|
| `vault-schema.ts` | Table SQL. |
| `note-store.ts` | CRUD, revisions, rename, restore, concurrency, derived indexes. |
| `note-queries.ts` | Folder tree counts, note list, backlinks with labels, outgoing links, review items (`#unverified` lines), vault stats. |
| `vault-search.ts` | Title, alias and body scoring over the notes in memory. Supports `tag:`, `path:` and `type:` filters. |
| `vault-graph.ts` | Nodes and edges for the global graph (folder and min-degree filters) and the local graph (depth 1–2, capped at 160). |
| `attachments.ts` | Writes and reads PNG files; path containment checks. |
| `vault-export.ts` | Folder or zip of `.md` files (YAML frontmatter plus body) and attachments. |
| `owner-identity.ts` | Resolves owner references: owner note aliases, pronoun list, `user <x>` prefix, Levenshtein ≤ 2 (≤ 3 when the name contains `y`) against the owner's first name. Possessives and paths are excluded. Ported from the prototype. |
| `note-writer/edit-ops.ts` | Zod schema for LLM edit operations. It is flat and scalar-bounded, with **no recursive `$ref`** (the lesson of Defect A): `create_note{title,type,lead}`, `add_facts{note,label,values[]}`, `add_aliases{note,aliases[]}`, `add_task{note,text}`, `learned{note,label,value}`. |
| `note-writer/edit-applier.ts` | Validates every string with the existing `SecretScanner`, resolves owner and note titles, and applies operations through the store with actor `note-writer · screenshot` or `note-writer · chat` and a `source_ref`. A rejected string is dropped and audited; it never fails the job. |
| `note-writer/capture-writer.ts` | Screenshot job. The model gets the image, the context line and up to 20 candidate note titles from FTS on app and window title. It returns edit operations. The writer then fills in the capture note's `## Learned` list. |
| `note-writer/chat-writer.ts` | Chat turn job. Same operation schema. Writes the chat note transcript plus `## Learned`. |
| `note-writer/daily-rollup.ts` | Deterministic, no LLM. Rebuilds the day's daily note from that day's capture and chat notes. |
| `note-writer/tidy-pass.ts` | LLM rewrite of one entity note's lead paragraph from its fact rows. Replaces only the lead. Actor `note-writer · tidy`. |
| `capture-intake.ts` | Keeps the current dedupe and admission rules. Writes the PNG attachment, a `pending` capture note (actor `capture-intake`), a `vault_captures` row, and enqueues a `capture_note` job. |
| `capture-retention.ts` | Enforces `RawStorageLimitGb` (evicts oldest PNGs) and the optional age limit. The note stays; its embed renders "image removed". |
| `vault-retriever.ts` | Chat context. Takes query terms (existing `QueryIntentExtractor`), runs FTS, and always includes the owner note's lead. Renders `## Relevant personal context` with each note's title, lead and fact rows, fitted by binary search to `MaxContextTokens` (existing technique). |

**Jobs.** The job types become `capture_note`, `chat_note`, `daily_rollup`, `note_tidy` and `capture_retention`. The existing runner, idle and residency gates, resource policy, preemption, leases and background-decision log are kept.

### 4.3 HTTP: `/assistant/vault/*`

These sit behind the existing assistant auth, rate limiter and `RouteTable`:

```
GET    /assistant/vault/tree                      folders + counts (+ notes per expanded folder)
GET    /assistant/vault/notes?folder=&limit=      list
GET    /assistant/vault/notes/:id                 note + backlinks + outgoing + revision count
GET    /assistant/vault/resolve?title=            title/alias → id | null
POST   /assistant/vault/notes                     create {title, folder?, body}
PUT    /assistant/vault/notes/:id                 update {body, expectedRevision}
POST   /assistant/vault/notes/:id/rename          {title, expectedRevision}
DELETE /assistant/vault/notes/:id                 {expectedRevision}
GET    /assistant/vault/notes/:id/revisions       list
GET    /assistant/vault/notes/:id/revisions/:rev  snapshot
POST   /assistant/vault/notes/:id/restore         {revision, expectedRevision}
GET    /assistant/vault/search?q=                 hits with snippets
GET    /assistant/vault/graph?minLinks=&hide=     global graph
GET    /assistant/vault/graph/local/:id?depth=    local graph
GET    /assistant/vault/review                    unverified items
GET    /assistant/vault/stats                     counts + note-writer queue
GET    /assistant/vault/attachments/:path         PNG bytes (contained under the vault root)
POST   /assistant/vault/export                    zip download
GET    /assistant/vault/migration/preview         counts + blockers + previewToken
POST   /assistant/vault/migration                 {previewToken}
```

Every DTO is a zod schema in `packages/contracts/src/vault.ts`, with types derived from `z.infer`.

### 4.4 Dashboard

`AssistantTab` is replaced by `VaultTab`, a faithful port of the mockup to React components:
- `VaultLayout`, `FileTree`, `NoteView` (renderer built on the shared parser), `NoteEditor` (`[[` autocomplete);
- `GraphView`, `LocalGraph` (shared canvas force simulation, `fitView`), `GraphPreview`;
- `LinksPanel`, `OutlinePanel`, `HistoryPanel` with `DiffView`, `ReviewView`;
- `SearchPanel`, `QuickSwitcher`, `StatusBar`.

The vault opens on the graph. State lives in `useVaultController`, using the existing token and fetch pattern. Settings → Assistant keeps configuration only, plus a **Migrate to vault** card (preview → confirm) shown until migration is done.

## 5. Migration

`VaultMigrationService` runs inside the status server under `runMaintenance`. It needs the evidence key: with `KeyCustody: desktop`, the desktop shell must be running and must have pushed the key.

It runs after the cutover (phase 5), so live captures may already have created notes. It is **merge-safe**: a draft whose title or alias matches an existing note is merged into that note with `mergeEntityDraft`, which takes the union of aliases and calls `addRowValues` for each row. The merge is a revision with actor `migration`.

`preview()` returns counts (including how many drafts will merge into existing notes) and **blockers**:
- `evidence_key_unavailable`;
- `already_migrated`, set when `vault.migrated_at` exists;
- `assistant_disabled`.

`run(previewToken)`:
1. Reads legacy rows with typed SQL readers: active nodes and aliases, active assertions (with first supporting evidence), pending and needs-confirmation candidates, active screenshots with queue state, and chat evidence.
2. Builds note drafts with `graph-to-notes.ts`, a tested TypeScript port of `docs/mockups/vault/build-data.mjs`:
   - merges owner aliases;
   - drops junk names;
   - merges nodes by name, taking the dominant type as the folder;
   - turns objects that appear only as plans or goals into checklist text;
   - builds lead, rows, `more` and `unverified` sections;
   - creates link-only stub notes for referenced entities;
   - groups post-cutover facts into note-writer revisions.
3. Decrypts every active screenshot to `vault/attachments/captures/<id>.png`. Decrypts chat messages into chat note transcripts.
4. Inserts all notes, revisions, attachments and captures in **one** DB transaction. Files are written before the transaction and deleted again if it fails.
5. For queued and awaiting captures, inserts `vault_captures` rows in `queued` state and enqueues `capture_note` jobs.
6. Enqueues a `daily_rollup` for every day touched.
7. Writes `runtime_metadata['vault.migrated_at']`.

Legacy tables are left untouched by the migration. They are dropped later by a guarded schema upgrade (§7).

**Operational prerequisite:** set `Observation.RawRetentionHours` high, for example 2000, until the migration has run. Otherwise legacy retention deletes the 254 active screenshots, starting about 72 hours after capture.

## 6. Configuration

`Assistant` keeps `Enabled`, `Owner`, `Observation`, `Background` (job priorities renamed to the new job types), and `PrivateMode`. `Retrieval` becomes `{ MaxContextTokens, MaxNotes }`.

The following are removed at the cutover:
- `Memory` tiers;
- `Questions`;
- graph `Retrieval` knobs;
- `Retention` (candidate/OCR);
- `Mobile`.

`KeyCustody` stays until the removal phase, because the migration needs it to decrypt legacy evidence.

A new `Vault` block holds:
- `TidyPassEnabled` (default `true`);
- `CaptureImageMaxAgeDays` (default `0`, meaning keep forever, still bounded by `RawStorageLimitGb`).

`normalizeAssistantConfig` already rebuilds from defaults and ignores unknown keys, so a stored config with removed keys keeps loading.

## 7. Removal (after the migration has run on the live install)

Deleted code:
- `src/assistant/{graph,ingestion,projections,questions,retrieval,mobile,crypto}`;
- the graph stores, candidates, policies, validation, deletion previews, backup, restore, factory reset and graph cleanup;
- the image extractor and conversation extractor;
- the matching routes, contracts, dashboard components and tests;
- the vault migration module itself, which only runs once.

A schema upgrade drops the legacy tables. It **throws** if any legacy table has rows and `vault.migrated_at` is absent, so a missed migration fails loudly. On a database that is empty or already migrated, it drops the tables and deletes `<runtimeRoot>/assistant/evidence`.

Desktop shell:
- `DesktopStateDto` loses `custody` and `pendingQuestion`;
- the Rust shell drops `custody.rs`, `secure_key.rs`, the key push and the question popup;
- capture and activity ingestion are unchanged.

`ActivityLog` stops writing evidence and observations. It keeps `assistant_activity_events` and `assistant_activity_sessions`, which the idle gate and environment use.

Factory reset is reimplemented for the vault: preview counts → confirm → wipe the vault tables and attachments. Export replaces backup. Restore from backup is dropped.

**Already removed in Phase 5:**
- the ingestion pipeline (everything except `ingestion/candidate-hold.ts`);
- projections (everything except `projections/assertion-view*.ts`);
- questions (everything except `questions/environment-state.ts`);
- `retrieval/memory-retriever.ts` and the explicit-intent parser;
- `mobile/`, the image and conversation extractors, the legacy capture queue and retention;
- the graph cleanup, memory query/mutation, policy and validation services;
- every deletion preview except factory reset;
- the graph, mutation, question, policy and mobile routes, their contracts, CLI commands and dashboard views;
- the legacy job types (schema upgrade 86 → 87).

**Left for Phase 7** (kept for the migration or still wired to backup, export, restore and factory reset):
- `assistant-graph.ts`, `graph/`, `crypto/` and every store in `storage/` except `job-store`, `audit-store` and `background-work-decision-store`;
- `ingestion/candidate-hold.ts`, `projections/assertion-view*.ts`, `domain/{confidence,owner-identity,staleness,node-types,relation-types}.ts`;
- `control/{backup-format,backup-service,restore-service,temp-archive,export-service}.ts`, with factory reset and `deletion-preview.ts` rewritten for the vault;
- `questions/environment-state.ts`, which moves next to the environment cache;
- the `NodeStatusSchema` contract, `DesktopStateDto.pendingQuestion` and `custody`, and `KeyCustody` in config and routes;
- `ActivityLog`'s evidence and observation writes;
- the legacy tables and `<runtimeRoot>/assistant/evidence`.

## 8. Error handling

- A stale `expectedRevision` → `409 conflict`, with the current revision.
- A missing note → `404`.
- A title collision on create or rename → `409 title_taken`.
- An attachment path outside the vault root → `404`.
- The note-writer never fails a job on one bad operation. Unknown notes are created only through an explicit `create_note`. Secret hits are dropped and audited. A model output that fails schema validation after one repair retry is audited, and the capture is marked processed with an empty `## Learned`. This is the same terminal-not-failure rule as today.
- Migration: any blocker → `409` with the blocker list. A failure part-way rolls back the DB transaction and removes the files written.

## 9. Testing

The repo uses `node:test` through `npm test`, and vitest SSR-string tests for the dashboard (`npm run test:dashboard`). Coverage:

- **Shared markdown:** parser and builders, unit tests with round-trip and edge cases (unicode, pipes in labels, empty rows, overflow to `more`).
- **Note store:** concurrency, rename rewriting inbound links, restore, derived index consistency after every operation.
- **HTTP:** end-to-end through `withAssistantServer` for each route, covering success, 404, 409 and auth.
- **Migration:** a fixture legacy database built from the existing assistant fixtures. Asserts the expected notes, owner merge, junk drop, unverified callouts, attachments decrypted byte-for-byte, captures enqueued, idempotency blocker, and rollback on failure.
- **Note-writer:** fake inference returns edit operations. Asserts the applied revisions, secret drop, owner resolution, terminal handling of schema failure, and preemption.
- **Retriever:** token budget fitting and that the owner lead is always present.
- **Dashboard:** renderer output for every dialect element, the panels, graph pure functions (simulation stability with hub nodes, `fitView`), diff, and triage edits.
- **Before each phase completes:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:dashboard`.

## 10. Phases

Each phase is shippable and has its own implementation plan in `docs/superpowers/plans/`:

1. **Vault core:** shared markdown, schema, note store, queries, search, graph.
2. **Vault HTTP API and contracts.**
3. **Dashboard vault UI** (replaces the Memory Inspector).
4. **Note-writer:** edit operations, applier, capture, chat, daily and tidy writers, vault capture intake and retention, retriever. Built and tested standalone, not yet wired in.
5. **Cutover:** `AssistantService` composed around the vault. Captures, chat ingestion and retrieval go to the vault. Config is slimmed and the legacy graph write paths, routes and UI are unplugged. The legacy read path and crypto are kept for the migration.
6. **Migration:** merge-safe preview and run, plus the Settings card. Run it once on the live install while the desktop shell is up.
7. **Removal:** legacy code, crypto, `KeyCustody` and tables; Rust shell custody and questions. This only happens after the live migration.
