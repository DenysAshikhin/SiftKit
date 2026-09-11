# Chat recovery replay, transport, and integrity review

## Recheck of the current working tree

**Still incomplete.** The fixes are uncommitted changes over `3299b337`. Three new isolated probes fail: two migration cases and an owned-stream refresh retry. The existing suites pass, but do not cover those cases.

### Remaining blockers

1. **High — The migration rejects valid schema-70 automatic approvals.** `LegacyChatJournalEventSchema` omits `approval_reviewed` ([migration:70](../../../src/state/schema-upgrades/chat-replay-transport.ts#L70)). Commit `3af24c44` already recorded this event with journal version 1. A digest-valid row causes `getRuntimeDatabase()` to throw `invalid version-1 payload` / `No matching discriminator`, preventing database startup. Preserve this historical variant in the migration and add a real schema-70 fixture.

2. **High — The migration now rejects the newer valid v1 queue layout.** The historical queue schema accepts only top-level `imageMeta` ([migration:61](../../../src/state/schema-upgrades/chat-replay-transport.ts#L61)). Schema 70 already stored it inside `message`. An isolated database with that layout fails opening with `Unrecognized key: "imageMeta"` at `message` and a missing top-level array. The earlier schema-69 layout is now converted, but both shipped v1 layouts must be handled inside the migration.

3. **Medium — Owned-stream refresh retries can be lost.** The failure handler calls `setRemoteRunGeneration(...)` while `ownedStreamSessionIds` still contains the session ([hook:569](../../../dashboard/src/hooks/useChatSessions.ts#L569)). The attach effect skips owned sessions. When the stream later reaches EOF, `finally` releases ownership but does not re-arm this failed refresh. **Reproduction:** deliver a committed terminal, fail the detail GET, hold EOF until React processes the generation change, then close the stream. After another 1.5 seconds, detail requests remain **2→3** and attach requests **1→1**: the failed refresh was never retried. Re-arm after releasing ownership. The added hook test exercises attached-view preservation, not this owned-stream retry.

### Other remaining gaps

- The new `same(before, after)` call in `textSuffix()` serializes and parses both accumulated message bodies on every text delta ([encoder:163](../../../src/status-server/chat-projection-encoder.ts#L163), [comparison:148](../../../src/status-server/chat-projection-encoder.ts#L148)). Wire traffic is reduced, but growing-answer comparison work becomes quadratic in total text length. Prefix growth already proves that the bodies differ; compare bounded metadata for the equal-length case. This finding is from code inspection, not a CPU benchmark.
- Process-kill barriers for deletion followed by replacement and coalescing before/after its splice remain absent. The new `finalization` case contains one ordinary call, so it does not establish the required mixed collapsed/fresh-batch proof. The `invalid_rejection` barrier was added and its existing test passed.
- The integrated slow-socket/image-deletion test through the real subscriber and dashboard assembler is still absent. The two-server deferred-writer isolation gap also remains.

### What was corrected

The original metadata-only wire update, Unicode page budget, duplicate snapshot ID, and terminal cursor findings now have fixes and passing regression coverage. Represented tool calls release their argument payloads. A failed terminal refresh preserves the committed view, although the owned retry above is incomplete. The operational documentation now describes the new transport and replay behavior.

### Fresh validation

| Check | Current result |
| --- | --- |
| `npm run build:test` | Passed; manifest current. |
| Plan's focused command | **1,186 passed, 1 skipped, 0 failed**. |
| `npm test` | **3,999 passed, 5 skipped, 0 failed**. |
| Dashboard suite | **484 passed, 0 failed**. |
| `npm run typecheck` and explicit `npm run lint` | Passed. |
| `npm run build` and `npm --prefix dashboard run build` | Passed; dashboard retains the existing large-chunk warning. |
| Independent migration probes | **2 failed**, confirming both schema-70 startup blockers above. |
| Independent owned-refresh probe | **Failed**, including a wait beyond the normal one-second reconnect interval. |

Only this review document was edited by the reviewer. Existing source/test changes were preserved. No SiftKit, production database writes, or commits.

## Original committed-code review

The remainder records the earlier review of `3299b337`; the recheck above supersedes its status statements for the current working tree.

**Verdict: partially implemented; the plan's acceptance criteria are not met.** Five isolated regression probes reproduced defects despite the existing focused and dashboard suites passing. A further completion-path issue is evident from the code.

Reviewed the combined result of all three September 11 commits on `main`, using America/Toronto dates:

| Commit | Role in this review |
| --- | --- |
| `701188f0` | Earlier recovery changes, including the queued-message payload change. |
| `3af24c44` | Plan introduction, projection checkpoints, and schema 70. |
| `3299b337` | Main implementation of replay, lifecycle, image sanitation, tool identities, and projection transport. |

Comparison: `3b300bd9..3299b337`. Requirements: [implementation plan](../plans/2026-09-11-chat-recovery-replay-transport-integrity.md), findings 8–11 and 14–16. Earlier policy changes and unrelated performance documents were not treated as additional requirements.

## Findings

### 1. High — Upgrading valid historical queue events breaks replay

Evidence: [chat-journal-schema.ts:201](../../../src/state/chat-journal-schema.ts#L201), [chat-replay-transport.ts:50](../../../src/state/schema-upgrades/chat-replay-transport.ts#L50).

`701188f0` moved `queue_delivered.imageMeta` into `queue_delivered.message.imageMeta`. Previously committed v1 events have the old shape. The version-2 migration changes non-splice rows with `update.run(UPGRADED_EVENT_VERSION, row.body_json, row.payload_digest, ...)`, preserving those incompatible bodies.

**Reproduction:** insert a digest-valid queue event with the schema-69 layout into an isolated database, then open it with this build. The marker advances to 71, but `ChatJournalStore.readAll()` throws `ChatJournalIntegrityError: malformed event payload`. Even a text-only delivery with `imageMeta: []` fails. Affected sessions cannot be recovered normally.

**Correction:** explicitly migrate the historical queue layout and its digest before advancing the marker. Validate every historical event against a complete frozen schema. Currently non-splice bodies receive only `JsonObjectSchema` validation, and legacy splice messages/reasons are also loosely validated. The migration tests construct legacy bodies from current events and omit this old queue layout ([fixture](../../../tests/runtime-db-schema-journal-v2.test.ts#L29)).

### 2. Medium — Usage-only updates resend the accumulated answer

Evidence: [chat-projection-encoder.ts:158](../../../src/status-server/chat-projection-encoder.ts#L158), [replacement branch:206](../../../src/status-server/chat-projection-encoder.ts#L206).

`textSuffix()` returns null when `after.content.length <= before.content.length`. A token-count or timing change therefore takes the full `message` replacement path, even when the text is unchanged.

**Reproduction:** changing only `outputTokensEstimate` on a 1 MiB answer emits `begin,message,commit` and **1,052,784 wire bytes**. Separately delivered usage updates can repeatedly resend growing text. The existing linear-traffic test captures usage together with text growth, hiding this case; another test explicitly expects usage changes to replace the whole row ([tests](../../../tests/chat-projection-updates.test.ts#L95)).

**Correction:** carry metadata-only changes without the body, and measure text/usage publications as separate updates.

### 3. Medium — Journal paging counts characters instead of bounded body bytes

Evidence: [chat-journal.ts:358](../../../src/state/chat-journal.ts#L358), [budget comparison:366](../../../src/state/chat-journal.ts#L366).

The page selector uses `length(body_json) AS body_chars` against `CHAT_JOURNAL_READ_PAGE_BYTES`. SQLite text length counts Unicode characters, which understates both UTF-8 bytes and JavaScript code units for supplementary characters.

**Reproduction:** three events containing 220,000 emoji each are fetched together: **2,640,262 UTF-8 bytes / 1,320,262 JavaScript code units**. Each event individually fits 1 MiB, so this is not the allowed single-oversized-event exception.

**Correction:** enforce the chosen byte budget before fetching bodies and add non-ASCII page tests. The existing observer calls `body_json.length` “bytes” and exercises ASCII ([test:396](../../../tests/chat-journal.test.ts#L396)).

### 4. Medium — A snapshot silently accepts conflicting duplicate message IDs

Evidence: [chat-operation-projection.ts:143](../../../dashboard/src/lib/chat-operation-projection.ts#L143).

Every `message` record executes `removeMessage(staged, record.message.id)` before insertion, including during a snapshot. Snapshot identity conflicts therefore behave as replacements.

**Reproduction:** send two snapshot records with the same ID and different content, followed by a commit declaring one message. The decoder publishes the second value instead of rejecting the transfer. Counts alone do not enforce the plan's unique snapshot identities.

**Correction:** reject duplicate IDs within a snapshot while retaining explicit replacement semantics for updates.

### 5. Medium — A terminal can advance beyond the last committed projection

Evidence: [chat-operation-projection.ts:98](../../../dashboard/src/lib/chat-operation-projection.ts#L98).

The terminal check uses `advancesChatProjectionCursor(committed.cursor, record.cursor)`, which accepts any greater sequence/revision.

**Reproduction:** commit sequence 1, then send a completed terminal for sequence 50. The decoder accepts completion despite never receiving or committing the intervening final view. This defeats detection of an omitted final transfer.

**Correction:** require the terminal to identify the exact final committed cursor and consistent terminal state.

### 6. Medium — Failed terminal REST refresh discards the readable final view

Evidence: [useChatSessions.ts:285](../../../dashboard/src/hooks/useChatSessions.ts#L285), [owned stream:547](../../../dashboard/src/hooks/useChatSessions.ts#L547), [runtime terminal transition:220](../../../dashboard/src/lib/chat-session-runtime-store.ts#L220).

Both paths apply the terminal transition from `finally`, even if `getChatSession()` fails. That transition clears `journalSnapshot` and `liveMessages`. The UI consequently falls back to the older stored session although it already received a complete final projection. An owned stream does not automatically reattach solely because this refresh failed.

**Evidence level:** verified by control-flow inspection; no dedicated hook reproduction was added. **Correction:** retain the committed view until the replacement session has been fetched successfully, and retry the metadata refresh.

## Remaining acceptance gaps

| Requirement | Assessment |
| --- | --- |
| 8: bounded replay | Iterator folds and the incident memory test are present. Unicode paging fails above. `ToolCallRecord` also retains full `commandArguments` after `markRepresented()` clears results; large arguments survive compaction rather than becoming compact identity metadata ([source:82](../../../src/status-server/chat-context-replay.ts#L82)). |
| 9: efficient updates | Ordinary prefix growth uses suffixes; separately published metadata updates still resend bodies. |
| 10: bounded, atomic transport | Encoder round trips and frame-size tests pass. Decoder integrity and failed-refresh behavior remain incomplete. No integrated slow-socket/image-deletion test was found that exercises the subscriber through the actual dashboard assembler. |
| 11: database ownership | Stable path registry, captured handles, scoped close, and awaitable shutdown are implemented; relevant existing tests passed. The two-server test checks basic independence, not both servers with deferred writes pending simultaneously. |
| 14: deletion-safe writes | Sanitization runs inside context append transactions, and the live transcript applies the returned value. Existing pruning, replacement, duplicate-image, retention, and tool-image tests passed. Required process-kill barriers are absent. |
| 15: duplicate-call replay | Original call identities and explicit coalescing are implemented; HTTP/replay regressions passed. Before/after-coalescing coverage is an in-memory event replay, not the required kill/restart proof. |
| 16: invalid native calls | Durable rejection and subsequent correction have passing HTTP coverage. The required invalid-rejection process-kill barrier is absent. |

The crash helper still exposes only the previous barriers: `submission`, `text`, `proposal`, `approval`, `start`, `effect`, `result`, `projection`, `terminal`, and `queue` ([helper:22](../../../tests/helpers/chat-recovery-process.ts#L22)). Task 12's deletion/replacement, invalid rejection, coalescing, and mixed-finalization barriers were not added.

Operational documentation was not brought up to date. [web-chat-recovery.md](../../web-chat-recovery.md) still describes 100-row snapshot pages, complete event-array replay, approximately 0.5 GiB replay growth, and whole-row catch-up transport. These are superseded descriptions, not an accurate account of the new implementation.

## Validation

Validation used Node **v24.14.0**, isolated databases, and `SIFTKIT_GUARD_RUNTIME_DATABASE` pointing to the repository's real database.

| Check | Result |
| --- | --- |
| `npm run build:test` | Passed; compiled test manifest current. |
| Plan's focused test command | **1,179 passed, 1 skipped, 0 failed**. |
| `node dist/test-runner/run-tests.js --dashboard` | **481 passed, 0 failed**. |
| `npm test` | **3,993 passed, 5 skipped, 1 failed**. See failure below. |
| `npm run typecheck` | Passed, including its internal lint invocation. |
| `npm run lint` | Passed. |
| `npm run build` | Passed. |
| `npm --prefix dashboard run build` | Passed; Vite reported its 500 kB chunk-size warning (main JavaScript chunk approximately 1.07 MB). |
| Isolated review probes | **Five failures reproduced findings 1–5**; these were temporary diagnostics, not changes to the repository test suite. |

The broad-suite failure was `managed engine readiness cleanup releases its worker and every failed engine process` in [run-tests-watchdog.test.ts:97](../../../tests/run-tests-watchdog.test.ts#L97). Its nested readiness test reported a request timeout after the fake TabbyAPI startup timeout. This is outside the seven plan findings; attribution to today's commits is not established. An isolated rerun of the watchdog file passed all three tests. The original full-suite run remains a failed run.

The existing clean-child replay measurement passed the 192 MiB budget: **26.8 MiB journal**, **8.9 MiB retained context**, **9.1 MiB retained rows**, approximately **139–141 MiB peak RSS increase**. This validates that fixture, not the untested large-argument case above.

## Changes and boundaries

Deliverable: this review document only. No production code, checked-in tests, commits, production migration, or historical repair. Temporary review diagnostics are removed at completion. SiftKit and subagents were not used.
