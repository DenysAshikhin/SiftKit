# Vault note-writer agent — design

## 1. Goal

The note-writer gets things wrong in four ways:
- it creates duplicate notes;
- it attributes facts to the wrong note;
- it repeats or contradicts existing facts;
- it misses relations or invents them.

All four come from one gap. Each writer makes a single structured-output call that sees at most 20 note **titles**. It never sees note contents, aliases, types or links.

This design does three things:
1. It replaces the three model-backed writers with **one note-writer agent**. The agent explores the vault graph through read-only tools before it submits its edits.
2. It condenses the deterministic jobs into **one maintenance job**.
3. It adds a **validation queue**. Every note and fact value records when it was added, edited, last accessed and last validated. Maintenance feeds the least-recently-accessed 10% of notes to the agent's review pass. The pass checks plausibility, connections and consistency, and flags what is wrong for you to decide.

Writers that touch notes go from seven to four:

| Before | After |
|---|---|
| capture writer, chat writer, tidy pass | note-writer agent |
| daily rollup, capture retention | vault maintenance |
| capture intake | capture intake (unchanged) |
| owner sync | owner sync (unchanged) |

Changes you make in the vault UI are not a writer and are unchanged.

## 2. Architecture

```
Desktop app ─capture─▶ Intake (unchanged)            Chat turn ─▶ Chat seam (unchanged)
                          │ enqueue                                  │ enqueue
                          ▼                                          ▼
      vault_write {source: capture | chat | review}   vault_maintenance {}
                          │  drain: same 20 s timer, same gates, same preemption
          ┌───────────────┴──────────────┐
          ▼                              ▼
  Note-writer agent                Vault maintenance
  (shared AgentLoop,                ├─ capture retention (age, then capacity)
   kind 'vault-writer')             ├─ daily rollup for every day in vault_rollup_days
                                    └─ review: enqueue the validation-queue head
                                       when no write is waiting
   turn 1: seeded context
   turns 2..80: read-only tools
   final: submit_edits(operations)
          │
          ▼
  Edit applier: one transaction, one revision per touched note
  (+ fact-point times; review jobs stamp validated)
```

### 2.1 Components

All new code is in `src/vault/note-writer/agent/`.

**Prompt adapter.** It builds the system prompt and turn 1.
- The system prompt is the untrusted-content preamble, then the role `vault_writer`, then the instructions and the operation vocabulary.
- Turn 1 carries the seeded context (§3.1) and the source:
  - **capture:** the screenshot, plus app and window title;
  - **chat:** your text with code fences and quoted lines stripped, plus the assistant's reply as context;
  - **review:** the queued batch (§3.6).
- On the forced final turn (§3.4) it offers only `submit_edits` and adds a notice that the budget is spent.

**Tool adapter.** It runs the read-only tools (§3.2) against the vault database.
- Every result is capped at about 1,500 tokens.
- A tool error becomes a tool result the model can correct from. It is never an exception.

**Action adapter.**
- Parses tool calls.
- `submit_edits` is the finish action. Its arguments are validated against `VaultEditResponseSchema`.
- A response with no tool call gets one reminder, then the job fails as `invalid_output`.

**Model client.**
- Wraps the assistant inference client with tools enabled.
- The response-format pin is replaced by the tool schemas.
- Reasoning is off.
- The abort signal is honoured.

**`VaultNoteWriter`** is the single entry point, called as `run(ownerId, source, signal)`. It runs the loop and then calls the applier. After that it does the source-specific bookkeeping:
- **capture:** sets the capture note's Learned section and closes the capture;
- **chat:** appends the transcript, handles withheld secrets and the "don't remember this" suppression, then sets Learned;
- **review:** stamps the batch validated (§3.6).

Capture and chat jobs also record the touched day in `vault_rollup_days`, in the same transaction as the edits.

**`VaultMaintenance`** is deterministic. It runs `VaultCaptureRetention`, then the daily rollup for each day in `vault_rollup_days`, removing each day once its rollup is rebuilt. Then it enqueues a review job when the trigger in §3.6 holds.

**`VaultValidationQueue`** (`src/vault/validation-queue.ts`) ranks notes and fact values by their timestamps (§4.5).

### 2.2 Removed

- `VaultCaptureWriter`, `VaultChatWriter` and `VaultTidyPass`. The capture and chat input formatting, transcript handling and Learned handling move into `VaultNoteWriter`.
- The job types `capture_note`, `chat_note`, `daily_rollup`, `note_tidy` and `capture_retention`.
- The roles `vault_capture_writer`, `vault_chat_writer` and `vault_tidy`, replaced by `vault_writer`.
- The config keys `Vault.TidyPassEnabled` and the old `JobPriorities` keys.

## 3. The agent

### 3.1 Seeded first message

The seeded context exists so that easy jobs finish in one or two turns. It contains:
- **Owner card:** title, aliases, lead and the first 10 fact rows of the `#me` note.
- **Candidate cards:** the top 5 full-text matches on the source text, searched over titles, aliases and bodies. Each card has title, folder, types, aliases, lead and fact-row labels. The source text is app plus window title for a capture, and your visible text for a chat.
- **Known titles:** the next 15 matches, title only.
- **The source** (§2.1).

For a **review** job (§3.6), turn 1 carries the batch instead: a card for each queued note, and each fact value annotated with its ages (`added 40d · edited 12d · validated never`).

### 3.2 Read-only tools

| Tool | Arguments | Returns |
|---|---|---|
| `search_notes` | `query: string`, `limit ≤ 10` | Matches over title, aliases and body: title, folder, types, aliases, snippet |
| `read_note` | `title: string`, `page ≥ 1` (default 1) | Resolved by title or alias: lead, fact rows (40 values per page, each with its ages), open tasks, unverified items, aliases, types, outgoing links, up to 10 backlink titles. A note longer than one page ends with `rows 1–40 of 180 · next page 2`. A miss returns `no note "X"; closest: …` |
| `neighbors` | `title: string`, `depth: 1 \| 2` | Relations as `A —Label→ B`, built from fact rows linking to notes, plus backlinks |
| `day_context` | none | Today's earlier captures (app, title, Learned lines) and today's chat notes |

The tools never write vault content; all writes go through `submit_edits`. They only stamp access times (§4.4).

**Note size.** A stored note has no size cap. The per-batch caps (§3.3) bound what one job can add, and `read_note` paging keeps any note readable within the per-result token cap.

### 3.3 Operations (`submit_edits`)

The existing operations are kept:
- `create_note {title, type, lead}`
- `add_facts {note, label, values}`
- `add_aliases {note, aliases}`
- `add_task {note, text}`
- `learned {note, label, value}`

Three operations are new:
- **`set_lead {note, lead}`** rewrites the lead of a note the batch also edits. It is one to three plain sentences and at most 600 characters. This replaces the tidy pass.
- **`flag_conflict {note, label, value, conflictsWith}`** adds `**Label** value #unverified (replaces: <conflictsWith>)` to the note's unverified callout, so it appears in Review. In the Review view:
  - **Keep** replaces `conflictsWith` with `value` in that fact row;
  - **Drop** removes the flag.

- **`flag_doubt {note, label, value, reason}`** marks an existing fact value as doubtful, for example stale, implausible or contradicted by a neighbour. It adds `**Label** value #unverified (doubt: <reason>)` to the unverified callout. In the Review view:
  - **Keep** removes the flag and stamps the value validated;
  - **Drop** removes the flag and the fact value.

Existing facts are never changed or deleted without your decision.

The existing limits are kept: 30 operations per batch, 8 values per `add_facts`, labels up to 40 characters, values up to 200 characters, leads up to 600 characters, tasks up to 300 characters, and note references up to 120 characters.

### 3.4 Turn limits

- **Turn cap:** at most **80 turns**, the same order of magnitude as repo-agent.
- **Forced final turn:** turn 80 offers only `submit_edits`, with the notice `Turn budget spent: submit your edits now.`
- **Early forcing:** the same forced final turn happens earlier when the prompt reaches 75% of the preset's context window.
- **No submission:** a forced turn that still does not submit fails the job as `invalid_output` (§5).

### 3.5 Applier guards

These are deterministic rules applied after the model:
- **Near-duplicate title.** A `create_note` whose title matches an existing title or alias, ignoring case, whitespace and punctuation, becomes `add_aliases` on that note. It is audited as `merged_into_existing`.
- **Repeated value.** An `add_facts` value already present in that row is dropped silently.
- **Existing drops.** Unknown notes, invalid titles and secrets are still dropped and audited.
- **`set_lead` scope.** A lead for a note the batch does not otherwise touch is dropped. In a review job, every queued note counts as touched.
- **Unknown fact.** A `flag_conflict` or `flag_doubt` naming a value the note does not hold is dropped and audited.

### 3.6 Review pass

The review pass is how the vault slowly gets re-checked. It is the same agent with a third source, `review`, not a separate writer.

- **Trigger.** Maintenance enqueues one review job when all of these hold:
  - no other `vault_write` job is queued, so captures and chats always go first;
  - no review job is already live;
  - the validation queue is not empty.

  The drain gates and `Background.MaxGpuMinutesPerDay` bound how much review runs.
- **Batch.** The job takes the head of the validation queue (§4.5): the bottom 10% of entity notes by last access, at least 1 and at most 25. The note ids go in the job payload, so the batch is fixed when it is enqueued.
- **Instructions.** For each note the agent runs three checks.
  - **Plausibility.** Does each fact make common sense on its own? Anything physically impossible, absurd or clearly a joke, misread or hallucination is flagged with `flag_doubt` and the reason `implausible: …`. Example: "Denys is learning to fly by flapping his hands."
  - **Connections.** Does each link point to the right note, and does each relation make sense for both ends' types? Examples: `Pet Safety —Uses→ Neovim`, a person listed as a tool, a project "located in" a game. A wrong connection is flagged with `flag_doubt` on that fact value, with the reason `bad link: …`. Missing links that clearly belong are added.
  - **Consistency.** Do facts agree with each other, with the note's neighbours and with the owner note? A contradiction is flagged with `flag_conflict`. A duplicate is merged by adding the other name as an alias. A wrong or stale lead is rewritten with `set_lead`.

  Every flag lands in the Review view for you to decide. The pass deletes nothing.
- **Writes are checked too.** The capture and chat instructions gain the same plausibility rule: implausible content on screen or in a chat (jokes, fiction, misreads) is not recorded as fact about you.
- **Completion.** When the submitted edits commit, every note in the batch, and each fact value the agent did not flag, is stamped `validated_at_utc`, in the same transaction. The agent's reads also stamp access times (§4.4), so a validated note moves to the back of the queue.

## 4. Jobs and config

### 4.1 Jobs

| Job | Payload | Key | Priority |
|---|---|---|---|
| `vault_write` | `{source:'capture', attachmentId}` | `vault_write:capture:<attachmentId>` | `CaptureWrite` (400) |
| `vault_write` | `{source:'chat', turn}` | `vault_write:chat:<sessionId>:<userMessageId>` | `ChatWrite` (800) |
| `vault_write` | `{source:'review', noteIds}` | `vault_write:review` | `Review` (100) |
| `vault_maintenance` | `{}` | `vault_maintenance` | `Maintenance` (900) |

- `vault_write` is model-backed. `vault_maintenance` is not.
- Maintenance is enqueued on every drain, after every committed write, and when an accepted capture pushes stored bytes over the cap. It runs retention, then the pending daily rollups, then enqueues review if its trigger holds (§3.6).
- `jobIdempotencyKey` and `AssistantJobRequestSchema` change to match.

### 4.2 Config

- `Background.JobPriorities` becomes `{ChatWrite, CaptureWrite, Review, Maintenance}`.
- `Vault.TidyPassEnabled` is removed. `Vault.CaptureImageMaxAgeDays` is kept.
- Defaults, normalization and the Settings fields change to match.

### 4.3 Schema upgrade 87 → 88

- Create `vault_rollup_days (day TEXT PRIMARY KEY)`.
- Add the timestamp columns and the `vault_fact_points` table, with their indexes (§4.4).
- Backfill `vault_fact_points` from every note's current fact rows. Each value's `added_at_utc` and `edited_at_utc` start at the note's `updated_at_utc`. Access and validated times start null, so the whole existing vault enters the validation queue.
- Convert queued, running or paused `chat_note` rows to `vault_write` chat rows. The turn payload is unchanged and the key is rewritten.
- Convert `daily_rollup` rows into `vault_rollup_days` entries.
- Delete `capture_note`, `note_tidy` and `capture_retention` rows. The next drain re-queues waiting captures, and maintenance re-runs retention.

### 4.4 Access, edit and validated times

Every note and every fact value carries four times.

| Time | Notes (`vault_notes`) | Fact values (`vault_fact_points`) |
|---|---|---|
| added | `created_at_utc` (exists) | `added_at_utc` |
| edited | `updated_at_utc` (exists) | `edited_at_utc` |
| last accessed | `last_accessed_at_utc` (new, nullable) | `last_accessed_at_utc` (nullable) |
| validated (`date_validated`) | `validated_at_utc` (new, nullable) | `validated_at_utc` (nullable) |

- **`vault_fact_points`.** Columns are `note_id`, `label_key`, `value_key`, `label`, `value`, plus the four times. The primary key is `(note_id, label_key, value_key)`, with `ON DELETE CASCADE` from `vault_notes`.
  - It is kept in step by the note store's existing reindex, which runs on **every** note write, including your own edits.
  - A new value gets a row with added and edited set to now.
  - A removed value loses its row.
  - An unchanged value keeps all of its times.
- **Access.** Last accessed is stamped, for the note and for each fact value shown, by:
  - **chat retrieval:** notes injected into a chat prompt;
  - **agent reads:** seeded cards, `read_note` (the values on the returned page) and `neighbors` (the notes listed).

  Opening a note in the vault UI does not count. The review pass's reads count as agent reads.
- **Validated** is stamped only by a committed review job (§3.6), or when you press **Keep** on a `flag_doubt` item. It is separate from access: a note can be read often and never validated.

### 4.5 Validation queue

The queue lives in the database as indexed columns read by an ordered query, `VaultValidationQueue` in `src/vault/validation-queue.ts`. There is no separate queue table, so the queue can never disagree with the notes it ranks.

- **Indexes:**
  - `vault_notes(kind, last_accessed_at_utc, validated_at_utc)`;
  - `vault_fact_points(last_accessed_at_utc, validated_at_utc)`.
- **Note order:**
  - entity notes only;
  - never-accessed first, then oldest `last_accessed_at_utc`;
  - ties go to the oldest `validated_at_utc`, never-validated first, then the oldest edit.
- **`nextBatch()`** returns the head of the order: 10% of entity notes, at least 1 and at most 25. Notes in a live review job are excluded.
- **`staleFacts(noteId)`** orders that note's fact values the same way. Review cards list the stalest values first, so the agent's attention goes there.
- **Visibility.** `vaultStats` reports:
  - queue depth: entity notes never validated, or not validated in 30 days;
  - the oldest validated date.

  The Settings view shows both.

## 5. Errors

- **Invalid tool arguments or an unknown note:** returned to the model as a tool result.
- **No tool call:** one reminder, then `invalid_output`.
- **`invalid_output`:**
  - the failure is audited (`vault_writer_rejected`, with a bounded raw sample);
  - the capture or chat note gets an empty Learned section;
  - no other writes happen;
  - the capture is closed as processed;
  - for a review job nothing is stamped validated, so the batch stays at the head of the queue for the next review.
- **Preemption or model unload:** the loop is aborted before any write, and the job is re-queued.
- **Committed jobs:** a job that committed always completes.
- **Image capability:** checked at admission and again before dispatch, as today. A runtime that reloaded sends the capture back to `awaiting_image_capability`.

## 6. Testing

Every change is test-first.

- **Tools:** output shape, caps, alias resolution, `closest` hints, neighbour labels and `day_context`.
- **Applier guards:**
  - a near-duplicate title becomes an alias;
  - a repeated value is dropped;
  - `flag_conflict` lands in Review;
  - Keep replaces the old value;
  - an out-of-scope `set_lead` is dropped.
- **Agent, with a scripted fake model replaying tool calls against a real vault:**
  - it finds an existing note under another name and adds facts without creating a duplicate;
  - it flags a conflict instead of overwriting;
  - the forced final turn at the turn cap and at the context limit;
  - a response with no tool call, then `invalid_output`;
  - preemption mid-loop leaves nothing written.
- **Timestamps:**
  - reindex keeps times for unchanged values, adds rows for new values and removes rows for removed values, including on your own edits;
  - chat retrieval and the agent tools stamp access;
  - opening a note in the UI does not.
- **Validation queue:**
  - order (never-accessed first, then ties by validated date);
  - batch size of 10%, at least 1 and at most 25;
  - notes in a live review job are excluded;
  - stale-fact order.
- **Review pass, with a scripted fake model:**
  - an implausible fact ("learning to fly by flapping hands") is flagged with `flag_doubt`;
  - a bad link (`Pet Safety —Uses→ Neovim`) is flagged;
  - a contradiction is flagged with `flag_conflict`;
  - on commit the batch is stamped validated, except flagged values;
  - review is enqueued only when no write job is waiting.
- **Review actions:** Keep on `flag_doubt` stamps the value validated; Drop removes the value.
- **Jobs:** the runner, service, job store, the 87 → 88 upgrade (including the fact-point backfill), the cutover E2E and the dashboard settings tests move to the new job types.
- **Live validation, against the running SiftKit preset:**
  - copy `runtime.sqlite` and the vault attachments into the scratch directory;
  - run the agent over about 10 real pending captures, then one review batch;
  - report, per job: the tools called, the notes read, the operations submitted, the flags raised and the applier's decisions;
  - the live vault is not touched.

## 7. Documentation

Two documents are updated to the new flow:
- `docs/mockups/vault/note-writer-flow.html`;
- the memory vault spec (`2026-10-24-memory-vault-design.md`), in §4.2 and the phase list.
