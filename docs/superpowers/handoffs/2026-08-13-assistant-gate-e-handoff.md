# Assistant Gate E — handoff

Plan: `docs/superpowers/plans/2026-08-13-assistant-gate-e-hardening.md` (21 tasks, all executed).
Design: `docs/superpowers/specs/2026-08-13-assistant-gate-e-hardening-design.md`.
Branch: `main`. Work landed as one commit per task.

## Result

All 21 tasks are implemented and committed. Every verification gate below was run at the final
commit and passed. One §19.5 budget is missed and is reported as missed, not rounded up.

### Verification gate (Task 21)

| Step | Command | Result |
|---|---|---|
| 1 | `npm run build:test` | exit 0 |
| 2 | `npm test` | 3035 tests, 3033 pass, 0 fail, 2 skipped |
| 3 | `npm run test:dashboard` | 277 tests, 277 pass, 0 fail |
| 4 | `npm run typecheck` (contracts, src, scripts, dashboard, bench, test, dashboard-test, analysis, eslint) | exit 0 |
| 5 | `npm run build` | exit 0 (known >500 kB chunk warning) |

The 2 skips are pre-existing environment skips, unrelated to Gate E:

- `invokeShellProcess with explicit bash shell on POSIX runs via bash` — POSIX-only.
- `real Formatron planner grammar compiles quickly and enforces the payload corpus` — needs
  `SIFTKIT_FORMATRON_PYTHON`, `SIFTKIT_TABBY_ROOT`, `SIFTKIT_EXL3_MODEL_DIR`.

## §9 exit criteria, line by line

**1. The 26th Tier 2 dossier demotes and the 501st Tier 3 document archives without losing a graph
fact.** — Partially proven; see the scale caveat.

- 26th Tier 2 dossier: `gate E scenario 7: the 26th tier 2 topic is demoted and leaves no orphan
  tier 2 row` (`tests/assistant-gate-e-e2e.test.ts`). 25 topics × 3 assertions compile to exactly
  25 Tier 2 rows; the 26th topic demotes, is named in `demotedTopicKeys`, reappears in Tier 3, and
  all 78 assertions stay live.
- Tier 3 archive merge: `gate E scenario 8: tier 3 overflow merges into archive documents and
  recompiles identically` (injected limits `{1: 1, 2: 3, 3: 5}`), plus
  `tier 3 overflow archives without losing graph facts and reports it` and
  `the superseded individual tier 3 rows are swept once an archive replaces them`
  (`tests/assistant-projection-reconciler.test.ts`), plus the segment-bucketing unit tests in
  `tests/assistant-archive-planner.test.ts`.
- **Unproven:** the literal 501-document scale. Overflow is exercised through the injectable
  `TierDocumentLimits`, which the plan chose deliberately so the suite stays fast. Nothing in the
  compiler special-cases 500, but no test compiles 501 real Tier 3 documents.

**2. No orphan projection rows survive a recompile.** — Proven.
`a projection row outside the desired set is deleted on recompile`,
`the sweep leaves every row the compile produced and audits only what it removed`,
`a topic whose assertions are all retired loses its projection row`
(`tests/assistant-projection-reconciler.test.ts`), and the explicit orphan assertion inside
scenario 7 (the demoted topic must not keep a Tier 2 row after the recompile).

**3. Deletion cascades correctly across all four §16.1 modes.** — Proven.

- Forget assertion: `signed deletion previews reject tampering and staleness before forgetting`
  (`tests/assistant-memory-mutation-service.test.ts`).
- Delete evidence: `deleting source evidence purges the blob, unlinks, and zeroes dependent
  confidence`, `a stale evidence-deletion token is rejected without partial work`, `a blob shared
  by another live record survives the deletion of one of them`
  (`tests/assistant-deletion-modes.test.ts`), and `gate E scenario 5` end to end from a real
  capture.
- Forget topic: `forgetting a topic retires its assertions, deletes its projections, and can add a
  policy`, `forgetting a topic without a policy leaves the topic open to future inference`,
  `a stale forget-topic token retires nothing`.
- Factory reset: `factory reset empties every assistant table, the blob tree, and the key, leaving
  the rest intact`, `factory reset re-seeds the registries, owner, and device so the assistant is
  usable again`, `re-running factory reset on an empty assistant is a no-op, not an error`
  (`tests/assistant-factory-reset.test.ts`).
- Token confusion across modes: `a forget-assertion token cannot be replayed as an evidence or
  topic token`, `an evidence preview token does not validate a different evidence id`.

**4. Backup restores with verified hashes; scenario 12 round-trips byte-identical.** — Proven.
`backup carries a verified snapshot, the encrypted blob tree, and a sealed key`,
`restore refuses a tampered manifest hash before touching anything`,
`restore refuses a newer schema version`,
`a wrong confirm token is a conflict and an unknown upload is a not-found`,
`a backup whose key cannot be unsealed restores loudly, not silently`
(`tests/assistant-backup-restore.test.ts`), and
`gate E scenario 12: export survives factory reset and restore byte for byte`
(`tests/assistant-gate-e-e2e.test.ts`), which also asserts `status()` and `desktopState()` answer
sanely from the restored graph and that the owner person node is re-resolved.

**5. Signed envelopes reject replay and revoked devices; the route stays 404 while disabled.** —
Proven. The nine tests in `tests/assistant-mobile-envelope.test.ts` cover the whole rejection
matrix in verifier order (unknown device → revoked device → missing public key → bad signature →
stale timestamp → replayed nonce), plus `a rejection is audited by reason alone, never by payload`.
The route behaviour — 404 while `Assistant.Mobile.Enabled` is false, 403 on rejection, 202 on
acceptance — is in `the Gate E routes serve deletion, maintenance, transfer, and mobile end to end`
(`tests/assistant-gate-e-routes.test.ts`).

**6. §19.5 numbers measured and recorded.** — Done; one budget missed (table below).

**7. Soak.** — Explicitly out of this gate. Not run, not simulated. The user runs it manually.

## §19.5 benchmark

Seeded with `npm run bench:assistant:seed -- --assertions 100000` (2 000 object nodes, 100 000
assertions, 2 000 shared evidence rows, 526 projections, 10 000 activity events; 97.9 s to seed),
then `npm run bench:assistant`. Machine: the development workstation, Windows 11, warm page cache.

```
assistant §19.5 benchmark — C:\Users\denys\Documents\GitHub\SiftKit\.bench-assistant
Measurement        |    p50 ms |    p95 ms | budget ms | n      | verdict
-------------------+-----------+-----------+-----------+--------+--------
Graph lookup       |     0.034 |     0.079 |        50 | 1000   | ok
Tier 1 load        |     0.025 |     0.066 |        20 | 1000   | ok
Retrieval          |   186.741 |   219.303 |       150 | 50     | MISSED
Activity ingestion |     3.318 |     5.043 |        10 | 1000   | ok
Capture dedupe     |     3.150 |     3.505 |       250 | 1000   | ok
MISSED: Retrieval
```

**Retrieval misses its 150 ms budget at p95 (219 ms).** This is a real miss, not a harness
artifact — the same shape appeared on a 2 000-assertion seed (p95 293 ms), so it is not purely a
function of corpus size. It is un-investigated: the benchmark records numbers and does not gate, so
nothing was tuned to make it pass. Profiling `MemoryRetriever.retrieve` (FTS seed search →
neighborhood expansion → view building → token accounting) is the natural next step and is left
open for whoever owns retrieval performance.

The measurement scripts exit 0 regardless of budget misses, by design.

## DPAPI / PowerShell dependency

Backup key sealing goes through `src/assistant/crypto/dpapi.ts`, which shells out to PowerShell and
calls `System.Security.Cryptography.ProtectedData` at `CurrentUser` scope, with the payload passed
over stdin as base64 (never argv). Consequences the next owner must know:

- **Windows-only.** Backup creation and restore-with-readable-blobs cannot work on a machine
  without PowerShell and DPAPI. Every backup/restore test in the suite therefore only passes on
  Windows.
- **Per-user, per-machine.** A backup sealed by one Windows account does not unseal on another.
  This is the designed behaviour, and it is surfaced rather than swallowed: restore returns
  `blobsReadable: false` with a warning string, the CLI prints the warning on its own line, and the
  dashboard renders it in an error-styled `role="status"` element.
- **30 s timeout per call**, and each call is a process spawn. Backup and restore each seal/unseal
  once, so this is not on any hot path.

## Deviations from the plan

Carried forward from the earlier sessions (Tasks 1–15), still in force:

- **Task 14 sensitivity.** `IngestionEnvelope` had no sensitivity field, so rather than special-case
  mobile, `declaredSensitivity: Sensitivity | null` was added to `IngestionEnvelopeSchema` with
  `maxSensitivity()` in `domain/enums.ts`. Resolution is
  `max(scanFloor, declared ?? 'low', 'personal')` — the source's classification is a floor the
  secret scan can raise but never lower. Every construction site was updated; a new ingestion
  source must set it.
- **Task 14 store split.** `getDevice`/`listDevices` moved out of `IdentityStore` into the new
  `DeviceStore` (`graph.devices`); `IdentityStore` now holds only owner identity plus the local
  device id.
- **Task 15 restore wiring.** The plan wrote `service.restores.preview(...)`; the service exposes
  `previewRestore(bytes)` / `restore(uploadId, token)` wrappers over a private `restoreService`.
  `restore()` already wraps `runMaintenance`, so the plan's extra wrap would have double-wrapped.
- **Task 15 body reading.** `readBody` was refactored so `readBodyBytes` is the implementation and
  `readBody` is its utf8 view; a utf8 round trip would have destroyed the restore zip.
- **Factory reset is not "all tables empty"** — it re-seeds registries, owner, and device rows in
  the same transaction, so `assistant_owners` and `assistant_devices` hold one row each afterwards.
- `manifest.json` is not hashed inside its own `files` map; that is what makes the "newer schema
  version" refusal test possible.

New in this session (Tasks 16–21):

- **Task 16 — binary HTTP primitive.** The plan asked for two binary helpers "modelled on
  `requestAssistant`", but `HttpClient` had no binary path at all. Added
  `HttpClient.requestBytes(RequestBytesOptions): Promise<Buffer>` (never sets a response encoding,
  caller owns `Content-Type`, we add `Content-Length`) and built `requestAssistantZip` and
  `postAssistantRestorePreview` on it. One primitive covers both directions.
- **Task 16 — extra client method.** The plan's list of new `StatusServerApiClient` methods omitted
  restore confirmation, which `restore --confirm` needs; `confirmAssistantRestore(token, uploadId,
  confirmToken)` was added.
- **Task 16 — output wording.** Export and backup share one line, `wrote <path> (<n> bytes)`,
  rather than two near-identical strings.
- **Task 17 — no new UI idiom, so no direct API calls in the component.** The plan's test sketch
  mocked `assistant-api` inside the detail component. `AssistantMemoryDetail` imports only types
  today; the preview→confirm state for forget-assertion lives in `useAssistantController`. The two
  new flows follow that same wiring (controller owns
  `evidenceDeletionPreview`/`topicForgetPreview`, component takes props), which is what "reuse its
  confirmation affordances exactly — no new UI idiom" actually implies.
- **Task 17 — forget-topic lives on the projection detail**, beside the topic key, because that is
  the only selection that carries a `topicKey`. The `addPolicy` choice is a checkbox inside the
  preview block, so the block-the-topic decision is made after the cascade is visible.
- **Task 18 — `AssistantMaintenance` takes `token` as a prop** from `AssistantSettings`, which
  already bootstraps one, instead of bootstrapping a second token.
- **Task 18 — settings-sections.** Four descriptors were added to the previously empty `assistant`
  section (`Export memory`, `Backup`, `Restore`, `Factory reset`) and the panel's sections render
  through `SettingsSectionField`, per the plan. `tests/settings-sections.test.ts` locks the tooltip
  label list exactly, so that expectation was extended with the four new labels.
- **Task 19 — scenario 5's projection claim was not provable as written.** The plan expected
  "projections refreshed without the citation". A screenshot-derived belief inherits `sensitive`
  sensitivity, and §10.2 keeps sensitive content out of every plaintext projection, so the
  capture-backed assertion is never in a projection to begin with. Deleting its evidence also does
  not retire the assertion — `recalculateConfidence` drives confidence to 0 and leaves the status
  `active`, exactly as Gate D's expiry path does. The test therefore proves what the system
  actually guarantees: the belief never reaches a projection, the blob is purged, links are
  dropped, confidence is recalculated downward, a `projection_maintenance` job is queued by the
  mutation itself, and projection integrity holds after the recompile. **The literal "projection
  refreshed without the citation" assertion is unproven, because it is not true of this codebase.**
- **Task 19 — `seedOwnerAssertion`'s `variant` option was broken.** It created the scope node as a
  `topic`, which the assertion validator rejects ("An assertion scope must be a preference_context
  node"). No caller had ever used it. Fixed to create a `preference_context` node; scenario 7 is
  its first user.
- **Task 20 — bench scripts use `RandomIdGenerator`.** `SequentialIdGenerator` restarts at 1 in
  each process, so a `measure` run collided with ids the `seed` run had already written
  (`UNIQUE constraint failed: evidence_blobs.id`).
- **Task 20 — typecheck coverage.** `scripts/assistant-bench/**/*.ts` was added to
  `tsconfig.bench.json` (the noEmit project) so `npm run typecheck` covers the new scripts;
  `.bench-assistant` was added to `.gitignore`.
- **Task 20 — the activity-ingestion measurement writes rows.** It is the one non-read-only target,
  so a seeded root grows by ~1 010 activity events per benchmark run. Re-seed before comparing
  runs. This is noted in the script.

## Where things live

- CLI: `src/cli/assistant-args.ts` (parser), `src/cli/run-assistant.ts` (dispatch),
  `src/cli/status-server-api-client.ts` (transport). Tests: `tests/assistant-gate-e-cli.test.ts`.
- Routes: the Gate E block in `src/status-server/routes/assistant.ts`; the exact paths are in the
  `RouteTable` at the bottom of that file. Maintenance and transfer sit **above** the `enabled`
  gate; deletion and mobile ingestion sit below it.
- Dashboard: `dashboard/src/tabs/settings/AssistantMaintenance.tsx` (panel),
  `dashboard/src/components/AssistantMemoryDetail.tsx` (evidence delete, forget topic),
  `dashboard/src/assistant-api.ts` (archive transport is deliberately outside the JSON `request`
  helper).
- Benchmarks: `scripts/assistant-bench/{shared,seed,measure}.ts`;
  `npm run bench:assistant:seed` / `npm run bench:assistant`.

## Open items for the next owner

1. **Retrieval p95 exceeds its §19.5 budget** (219 ms vs 150 ms). Not investigated.
2. **The 501-document Tier 3 archive path is proven only at injected small limits.** If the literal
   scale matters, add a slow-tagged compile over 501 real Tier 3 topics.
3. **Soak testing** is carved out of this gate and has not been run.
