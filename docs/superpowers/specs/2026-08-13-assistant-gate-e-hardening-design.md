# SiftKit Assistant — Gate E (Hardening) Design

**Date:** 2026-08-13
**Source spec:** `assistant/2026-07-30-siftkit-assistant-design.md` §10.3, §15, §16, §7.6, §18 (Gate E), §19.4, §19.5, §21.
**Predecessor:** Gate D complete and green (`docs/superpowers/handoffs/2026-08-10-assistant-gate-d-tasks-13-28-handoff.md`). `CURRENT_SCHEMA_VERSION = 43`.

Gate E is the final assistant gate: projection lifecycle (compaction + orphan cleanup), the three
missing deletion modes, export / backup / restore, the mobile envelope contract, and a seeded
performance measurement. One spec, one implementation plan.

## Current-state findings this design must fix

1. **Silent 501st Tier 3 drop.** `ProjectionCompiler.compileAll` ends Tier 3 selection with
   `.slice(0, TIER_DOCUMENT_LIMIT[3])` (`src/assistant/projections/projection-compiler.ts:84`).
   Overflow past 500 is discarded — no archive merge, no record on `CompileSummary`. §10.3
   requires merge → retain graph facts → delete superseded rows → record the mutation.
2. **Orphan projection rows.** `ProjectionStore.deleteProjection` has zero callers. `upsert` keys
   on `(owner, tier, topic_key)`, so a topic demoted 2→3 writes a new Tier 3 row and leaves the
   Tier 2 row behind — stale, FTS-searchable, retrievable. Retired topics leak the same way.
   Monotonic growth.
3. **Deletion is one-quarter done.** Of §16.1's four modes only *forget one assertion* exists.
   *Delete source evidence*, *forget topic*, and *factory reset* have no workflow, route, CLI,
   or UI. `DELETE /assistant/evidence/{id}` from §15.1 was never implemented.
4. **Export, backup, restore do not exist.** No modules, no routes, no CLI.
5. **Mobile envelope does not exist** beyond the Gate A `assistant_devices` table (public_key
   nullable) and a source-channel enum value. No verifier, no nonce tracking, no route.

## Locked decisions

| Decision | Choice |
|---|---|
| Scope | Single spec + single plan for all of Gate E |
| Soak test | **Dropped.** The user runs the 24-hour soak manually, later, outside this gate |
| Benchmarks | Final task: seed scripts fill a disposable DB with fake rows at §19.5 scale, a measure script reports each target |
| Mobile | **Contract only**: verifier + nonce table + 404 route. No client, pairing, consent UI, or device-registration surface (§22.3) |
| Compaction architecture | **Compile-as-reconciler** (approach A): deterministic, in `compileAll`, no new job type, no model dependency. Projections stay a pure function of the graph (§21.1, §21.10) |
| Surfaces | Every workflow surfaced on HTTP, CLI, **and** dashboard — including factory reset, export, backup, restore |
| Restore scope | Assistant-scoped: only assistant tables/blobs are replaced; non-assistant SiftKit data ignored |
| Key in backup | OS-protected (DPAPI) form only; plaintext never written (§16.4) |

## Non-goals

Soak machinery; mobile client/pairing/consent; model-based archive prose (deterministic merge
with the existing summarizer pass only); macOS/Linux adapters; changing retention defaults
(§16.2 — already enforced by Gate D capture retention); any change to non-assistant SiftKit data.

---

## 1. Projection lifecycle reconciler

`ProjectionCompiler.compileAll` becomes the single owner of the desired state of
`memory_projections` for an owner.

1. **Desired set.** Profile + top-25 Tier 2 + Tier 3 (native + demoted Tier 2 overflow), as
   today, keyed by `(tier, topicKey)`.
2. **Archive merge.** While Tier 3 exceeds `TIER_DOCUMENT_LIMIT[3]` (500): take the
   lowest-utility overflow topics, group by the first segment of `topicKey`, and compile each
   group into one `archive/<segment>` Tier 3 dossier rendered from the same `AssertionView`s —
   compact per-topic sections, standard frontmatter, citations (`includedAssertionIds`) kept.
   Archive documents count toward the 500 cap; merging repeats until the cap holds. Same graph →
   same groups → same bytes. Overlong archive documents flow through the existing
   `ProjectionSummaryService` pass with its deterministic floor, like every other document.
   Graph facts are never touched (§21.10).
3. **Orphan sweep.** After writes, list all projection rows for the owner and delete every row
   whose `(tier, topicKey)` is not in the desired set — via `ProjectionStore.deleteProjection`,
   which also drops the FTS shadow row. Runs unconditionally, independent of the
   `graph_version` write-skip.
4. **Reporting.** `CompileSummary` gains `archivedTopicKeys: readonly string[]` and
   `deletedProjectionCount: number`. Each archive merge and each orphan delete writes an
   `assistant_audit_events` row (§10.3 "record the projection mutation").

Regression test for finding 2: demote a topic 2→3, recompile, assert exactly one row for that
topic exists and projection FTS no longer matches the stale Tier 2 document.

## 2. Deletion modes

All three follow the existing forget-assertion pattern (`MemoryMutationService` +
`DeletionPreviewService`): preview → confirm token → transactional cascade inside
`AssistantTransactionManager` → projection refresh → audit rows.

### 2.1 Delete source evidence

- Preview: dependent assertions via `assertion_evidence`, plus the projections that include them.
- Confirm: purge the blob file, delete `assertion_evidence` links, recalculate dependent
  assertion confidence **through the existing Gate D retention-expiry recalc path** (no second
  implementation), refresh projections.
- The §16.1 deletion barrier (a job re-checks evidence status inside its mutation transaction and
  aborts if it changed) already exists for retention expiry; a test extends coverage to explicit
  deletion.

### 2.2 Forget topic

- Preview: every live assertion under the `topicKey`, its evidence links, projections including
  them.
- Confirm: retire those assertions (retire, not row-delete — the audit trail survives, §21.11),
  delete the topic's projection rows, and, when `addPolicy: true`, insert a `never_infer_topic`
  policy row.

### 2.3 Factory reset

- Preview: row counts per assistant table, blob count and bytes.
- Confirm: pause the job runner and wait for any in-flight job → delete the custody key file →
  delete all rows from every assistant table (the `schema.ts` inventory: graph, evidence,
  observations, candidates, projections + FTS shadows, jobs, questions, feedback, policies,
  activity, capture queue, audit, devices, owners) → delete the evidence blob tree. All
  non-assistant SiftKit configuration and data untouched (§16.1). Next assistant start finds
  empty tables and provisions a fresh key through existing custody machinery.
- Dashboard requires a typed confirmation phrase; CLI requires `--preview` then
  `--confirm <token>`.

## 3. Export, backup, restore

### 3.1 Export

`POST /assistant/export`, CLI `siftkit assistant export --output <zip>`, dashboard button
(download). Streams a zip in the §16.3 layout:

```
manifest.json
graph/nodes.jsonl, graph/assertions.jsonl, graph/aliases.jsonl, graph/evidence-links.jsonl
evidence/metadata.jsonl
evidence/blobs/            only with includeDecryptedBlobs: true; audited
projections/tier1/*.md, tier2/*.md, tier3/**/*.md   rendered from memory_projections.content via relative_path
policies.json
questions.jsonl
audit.jsonl
```

Read-only, one read transaction. Blobs excluded by default; the explicit flag decrypts them into
the archive and writes an audit row recording that a decrypted export happened. Zip container:
a small internal writer over `node:zlib` deflate (local headers + central directory) shared by
export and backup; no new dependency.

### 3.2 Backup

`POST /assistant/backup`, CLI `--output <zip>`, dashboard. Artifact:

- `snapshot.sqlite` — whole runtime DB via SQLite's online backup API (`better-sqlite3`
  `db.backup()`), consistent and non-blocking;
- `blobs/` — the encrypted evidence tree copied byte-for-byte;
- `key.protected` — the custody key in OS-protected (DPAPI) form only;
- `manifest.json` — `CURRENT_SCHEMA_VERSION` + SHA-256 per file.

### 3.3 Restore

`POST /assistant/restore`, CLI `restore --input <zip> --preview/--confirm`, dashboard.
**Spec-gap addition:** §15.1 lists export and backup but omits restore; this design adds it.

Order: verify every manifest hash → refuse `schemaVersion > CURRENT_SCHEMA_VERSION` → pause job
runner → one transaction: delete all assistant rows, re-insert assistant tables read from
`snapshot.sqlite` (attached read-only) → replace the blob tree → re-import `key.protected`
through existing custody import. Assistant-scoped: non-assistant tables in the snapshot are
ignored, mirroring the factory-reset boundary.

Cross-machine honesty: on the original machine DPAPI unprotects the key and blobs decrypt; on a
foreign machine unprotection fails, the graph and projections restore fully, and the response and
UI state that blob contents are unreadable — never silently.

E2E (§19.4 scenario 12): export → factory reset → restore → graph, projections, and a second
export byte-identical to the first.

## 4. Mobile envelope contract (migration v44 — final assistant migration)

- **Schema:** v44 adds `assistant_device_nonces` (device id FK, nonce, monotonic timestamp,
  seen-at; unique on device+nonce). `assistant_devices` already exists from Gate A; the verifier
  requires `public_key` non-null and `status = 'active'`.
- **Contract** (`packages/contracts`): zod envelope — `deviceId`, monotonic timestamp, `nonce`,
  `schemaVersion` (literal 1, fail closed), consent flags, sensitivity, payload, Ed25519
  signature. `node:crypto` Ed25519; no new dependency.
- **`EnvelopeVerifier`** rejects, in order: malformed body (zod), unknown device, revoked device,
  missing public key, bad signature, timestamp not greater than the device's last seen
  monotonic timestamp, replayed nonce. Each rejection is audited with a distinct reason.
- **Route:** `POST /assistant/ingest/mobile` registered; returns 404 unless
  `Assistant.Mobile.Enabled` (new config key, default `false`). When enabled it verifies, then
  feeds the standard ingestion pipeline with no special-casing (§7.6).
- Tests insert device rows directly; there is no registration surface in this gate.

## 5. Surfaces

**HTTP** (all behind the §15.0 loopback+bearer guard, all bodies schema'd in
`packages/contracts`):

```
GET    /assistant/evidence/{id}/deletion-preview
DELETE /assistant/evidence/{id}                    { confirmToken }
POST   /assistant/topics/forget-preview            { topicKey }
POST   /assistant/topics/forget                    { topicKey, addPolicy, confirmToken }
GET    /assistant/factory-reset/preview
POST   /assistant/factory-reset                    { confirmToken }
POST   /assistant/export                           { includeDecryptedBlobs? } → zip stream
POST   /assistant/backup                           → zip stream
POST   /assistant/restore-preview                  raw zip body → manifest summary + confirmToken
POST   /assistant/restore                          { uploadId, confirmToken }
POST   /assistant/ingest/mobile                    404 unless Assistant.Mobile.Enabled
```

`topicKey` travels in bodies, never in the path — archive keys contain `/`. Restore uploads the
zip once (`restore-preview` stores it in a temp file keyed by `uploadId`, verifies hashes, and
returns the summary + token); confirm references the upload, so the destructive step never
re-reads a mutable client file. The CLI drives the same two calls from `--preview`/`--confirm`.

**CLI** (destructive commands: `--preview` first, `--confirm <token>` to execute):

```powershell
siftkit assistant evidence delete <evidenceId> --preview|--confirm <token>
siftkit assistant memory forget-topic <topicKey> [--block] --preview|--confirm <token>
siftkit assistant factory-reset --preview|--confirm <token>
siftkit assistant export --output .\assistant-export.zip [--include-blobs]
siftkit assistant backup --output .\assistant-backup.zip
siftkit assistant restore --input .\assistant-backup.zip --preview|--confirm <token>
```

**Dashboard:**

- Memory Inspector: evidence deletion and forget-topic actions, each with the cascade preview
  (§15.3's promised "raw evidence deletion with cascade preview").
- Settings ▸ Assistant: a maintenance panel — export (download, blob checkbox), backup
  (download), restore (file upload → preview → confirm), factory reset behind a typed
  confirmation phrase.

## 6. Error handling

- Every destructive confirm validates its token; a stale or wrong token is 409, never a partial
  cascade. All cascades are single transactions.
- Restore failures (hash mismatch, newer schema, mid-transaction error) leave the current state
  untouched — verification happens before any write; the write is one transaction.
- Export/backup are read-only and cannot corrupt state; a failed stream is a failed download.
- Factory reset pauses the runner *before* deleting; a crash between key deletion and row
  deletion is recovered by re-running reset (idempotent: deleting absent rows/files is a no-op).
- Envelope verification failures never reach the ingestion pipeline and are individually audited.

## 7. Testing

- **E2E** (§19.4): scenario 5 (evidence deletion → confidence recalculation → projection
  refresh), 7 (26th Tier 2 dossier demotes, graph intact), 8 (501st Tier 3 document archives,
  graph intact), 12 (export → factory reset → restore → identical).
- **Regression:** the demotion-orphan leak (finding 2) red-green.
- **Property:** after any deletion mode or recompile, no projection row or FTS row references a
  retired/deleted assertion; no projection row exists outside the desired set.
- **Verifier matrix:** each envelope rejection reason, plus the 404-when-disabled route test.
- **Restore refusal:** tampered hash, newer schema version, wrong token.
- Suite stays GPU-free and desktop-free; archive-merge determinism asserted by compiling the same
  graph twice and comparing bytes.

## 8. Performance measurement (final task)

`scripts/assistant-bench/seed.ts`: builds a disposable runtime DB **through the real stores** at
§19.5 scale — 100 000 assertions with nodes/aliases/evidence metadata, full projection set,
activity volume. `scripts/assistant-bench/measure.ts`: reports measured numbers for each §19.5
target — graph lookup p95 (< 50 ms), Tier 1 load (< 20 ms), deterministic retrieval p95
(< 150 ms), activity ingestion (< 10 ms), capture dedupe hash compare (< 250 ms) — as a table
recorded in the Gate E handoff. Not a CI gate. "Record measured results, do not claim unmeasured
performance."

## 9. Exit criteria (§18 Gate E, adjusted)

1. The 26th Tier 2 dossier demotes and the 501st Tier 3 document archives without losing a graph
   fact — E2E scenarios 7 and 8.
2. No orphan projection rows survive a recompile (new, from finding 2).
3. Deletion cascades correctly across all four §16.1 modes.
4. Backup restores with verified hashes; scenario 12 round-trips byte-identical.
5. Signed envelopes reject replay and revoked devices; the route stays 404 while disabled.
6. §19.5 numbers measured and recorded.
7. Soak: **explicitly out of this gate** — run manually by the user later.
