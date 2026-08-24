# Handoff — SiftKit Scalability Refactors (2026-08-19)

Continuation state for `docs/superpowers/plans/2026-08-16-scalability-refactors.md` (15 tasks, 6 phases).

**All 15 tasks are complete and committed.** What remains is the pre-existing baseline issues listed under
"Validation limitation" — none of them belong to this plan.

## Binding instructions and decisions

- Do **not** use SiftKit (`repo-search`, `summary`, or `repo-agent`) for this plan. The user explicitly withdrew earlier permission to use it.
- Do not use worktrees.
- Work directly on `main` and commit each completed plan task. Task 11 intentionally has three commits, one per state cluster.
- Preserve unrelated user changes. Never stage them with plan work.
- Use TDD for behavior changes. Pure mechanical moves/renames may use characterization coverage, followed by focused tests, the broader applicable suite, `npm run typecheck`, and lint.

## Current repository state

- Branch: `main`.
- Tasks 1–15 are complete and committed.
- This handoff update is intentionally uncommitted.
- The working tree also contains unrelated user work for git-output fidelity/status-server logging. At this snapshot, preserve these paths:
  - `src/repo-search/execute.ts`
  - `src/status-server/dashboard-runs.ts`
  - `src/status-server/operation-progress-writers.ts`
  - `src/status-server/repo-agent-sessions.ts`
  - `src/status-server/routes/chat.ts`
  - `src/status-server/server-logger.ts`
  - `tests/repo-search-preflight-log.test.ts`
  - `tests/repo-search-status-server.test.ts`
  - `tests/repo-search.test.ts`
  - `tests/server-logger.test.ts`
  - `docs/superpowers/plans/2026-08-19-git-output-fidelity.md` (untracked)

Task 11 cluster 3 touched `routes/chat.ts`, which the user was also editing. Only the three
`ctx.managedLlamaLastStartupLogs` rename hunks were staged; the user's hunks were left in the
working tree untouched.

## Completed tasks and commits

1. `1da2ed0c` — `chore: remove tracked junk files, fix mojibake comments and missing route return`
2. `5e95a667` — `perf(assistant): status counts use COUNT(*) instead of materializing queues`
3. `a954bdd6` — `perf(assistant): policy mutations look up by id instead of scanning all policies`
4. `fc22a36b` — `perf(assistant): prune terminal jobs older than 7 days on each drain`
5. `f47724f2` — `perf(assistant): coalesce projection-maintenance jobs to one queued recompile`
6. `732dadb1` — `feat: add ReasoningEffort preset field to enhance reasoning depth control`
7. `a964b7fa` — `chore(assistant): log drains slower than 250ms`
8. `21588937` — `refactor(assistant): one endpoint per route, single dispatch through RouteTable`
9. `c9282c49` — `refactor(state): extract inline migrations into a versioned registry`
   - Follow-up: `2eff1af3` — `refactor(state): remove migration registry runtime cycle`
10. `49755cc2` — `refactor(status-server): split routes/core.ts into per-responsibility modules`
    - Follow-up: `dda64486` — `test(status-server): update contracts for split core routes`
11. `8062cf9e` / `ee0db0ec` / `18e51383` — group terminal-metadata, idle-summary, and managed-llama context fields
12. `13e9ad48` — `refactor(assistant): extract policy and validation services from the facade`
13. `7122cb04` — `feat(lib): streaming zip file writer with incremental CRC`
14. `abf943ff` — `perf(assistant): stream backup and export archives via temp files`
15. `0276271d` — `perf(assistant): restore uploads stream to disk and read the archive lazily`
    - Follow-up: `4eb5cc9f` — `refactor(status-server): keep readBodyBytes module-private now that uploads stream`

## Implementation notes and deliberate deviations from the plan text

### Task 11

Each cluster defined its own sub-state type in its own commit, rather than defining all three up
front, so every commit compiles on its own. `readonly idleDelayMs` / `readonly delayMs` were adopted
as the plan specified even though the flat fields were mutable; nothing assigns them after
construction.

Two partial-context test mocks are branded through `z.custom` and therefore invisible to the
compiler: `tests/inference-runs.test.ts` needed `terminalMetadata` and `idleSummary` stubs added by
hand after the rename. If a future cluster rename compiles clean but a test throws
`Cannot read properties of undefined`, that file is where to look.

### Task 13

`ZipFileWriter.addFile` makes a single pass, not the plan's two. It writes the local header with a
zero CRC, streams the payload while folding the CRC, then patches the four CRC bytes in place. Every
write is positional, so patching an earlier header cannot disturb where the next entry lands. This
halves the I/O versus a CRC pre-pass and avoids data descriptors entirely. Output was verified
readable by both `readZip` and PowerShell `Expand-Archive`.

`abort()` was added beyond the plan: Tasks 14–15 need a way to close and delete a half-written
archive, and it is idempotent and safe after `finish`.

### Task 14

`TempArchiveBuilder` / `TempArchive` in `src/assistant/control/temp-archive.ts` is shared by backup
and export instead of each service growing its own temp-directory handling.

**Open concern — resolved, no trade required.** This handoff previously recorded that streaming the
export to a temp archive violated a rule against leaving plaintext in a temp file, and offered to
revert `ExportService` to the in-memory `ZipWriter`. **That rule does not exist.** Decrypted exports
may be written into the temporary archive, restore uploads may be parked in a temporary file, and
the only value that must never be written in plaintext is the backup key, which DPAPI still protects.

Task 9 of `2026-08-19-session-drift-remediation.md` removed the false citation and replaced it with
the guarantee that does hold, now tested: a decrypted export lives alone in a `mkdtemp` directory
and does not survive `cleanup()`. No revert is needed.

`sendZip` was replaced by `sendArchive`, which streams the file and cleans up in a `finally`.
`tests/assistant-archive-streaming.test.ts` covers both the success and the client-disconnect path.

### Task 15

`ZipFileReader` gained `hasEntry`, `entrySize`, and `hashEntry` beyond the plan's sketch, because
`RestoreService` needs per-entry manifest hashes and a `totalBytes` sum without materializing
anything. `hashEntry` and `extractTo` share one private chunk walker so the CRC check cannot be
skipped.

`readBodyBytes` is now module-private in `http-utils.ts`: `readBodyToFile` replaced its only
external caller.

Test boundary helpers live in `tests/helpers/archive-bytes.ts` (`archiveBytes`,
`archiveUploadPath`) rather than being duplicated per test file.

## Validation

Per task: focused suites, then `npm run typecheck` (which also runs `npm run lint` and every
TypeScript project) — clean at each commit.

Repository-wide: `npm run test` — **3247 tests, 3245 pass, 0 fail, 2 skipped** (the baseline skips),
70s. The suite is a usable completion gate again; see below for what was blocking it.

## Baseline failures, now fixed (uncommitted)

Two pre-existing problems, neither caused by this plan, blocked the repository-wide suite. Both are
fixed in the working tree and are **not committed** — they touch test files only:

1. **`tests/llm-auto-approval.test.ts` stalled the whole suite.** Root cause: commit `709d19a7`
   ("move approval-review policy from agent prompt to verdict requests") made
   `buildApprovalVerdictQuestion` prepend `APPROVAL_REVIEW_POLICY_LINES` ahead of the
   `<APPROVAL_REVIEW_REQUEST>` marker. That commit updated `auto-approval-verdict-probe.test.ts` and
   `repo-search-prompts.test.ts` but missed this file, whose mock server routed verdict requests
   with `content.startsWith(APPROVAL_REVIEW_REQUEST_MARKER)` — no longer true once the policy
   preamble leads. The verdict request was answered with a planner action, the reviewer could not
   parse a verdict, it retried once, then escalated to the human gate; that gate had no answerer and
   inherited `DEFAULT_DECISION_TIMEOUT_MS` (600 000 ms), so the run parked and the test's `finally`
   — and therefore `server.close()` — never ran.

   Fix: route on `content.includes(APPROVAL_REVIEW_REQUEST_MARKER)`, matching how the sibling
   `auto-approval-verdict-probe.test.ts` describes the same message. Hardening: every gate in the
   file now gets a bounded `UNREACHED_GATE_TIMEOUT_MS` (1 s) instead of the 10-minute production
   default, so a future regression fails this file in a second rather than wedging the suite.
   The file now runs 11/11 in ~1 s.

   Note for future hangs: Node's `--test-timeout` *does* fire and cancels the test, but the process
   still waits on ref'd handles the cancelled test never cleaned up — which is why the symptom looked
   like "the timeout does nothing". Check for parked timers and unclosed servers, not for a broken
   timeout.

2. **`tests/status-server-chat-routes.test.ts`** — "caption route returns 500 when inference produces
   an empty final output" failed because its inline scorecard fixture omitted
   `tasks[0].finishChallenges`, required by the schema since the committed 2026-08-18 repo-agent
   finish-verification work (`59d87591`). A missed test migration from that plan. Fix: add the field,
   matching `tests/_test-helpers.ts`.

## Known plan drift and gotchas

- Task 9's plan text stopped at schema v46, but the repository was already at v48. The registry includes all current versions through v48. A minor deferred review note remains: the registry-shape test proves ascending/current ordering but does not hard-code the exact 45-version sequence; behavioral migration suites cover existing versions.
- Task 10 needed the additional `status-run-log.ts` leaf to avoid a runtime import cycle; this is intentional and complete.
- After any `src/` or `tests/` change, run `npm run build:test` before focused `npm run test -- <filter>` commands. Editing a source file *while* a suite is running invalidates the build stamp and makes every `test-targets`/`buildNodeTestArgs` test fail with "Test artifacts are stale" — that is an artifact of the edit, not a regression.
- Combined validation commands can appear silent because output is buffered.
- `.superpowers/sdd/2026-08-16-scalability-refactors/` contains ignored working notes and task briefs. They are not product artifacts and must remain untracked.

## Drift remediation (2026-08-19) — complete

The ten findings from `/reflect-session-drift` against this plan's work were remediated under
`docs/superpowers/plans/2026-08-19-session-drift-remediation.md`, commits `4502f5fb`..`2df43ee9`.
Headlines:

- `ZipWriter`/`readZip` deleted; `zip.ts` is now format-only (constants, CRC, header codecs) with
  one writer and one reader built on it.
- `readBodyBytes`/`readBodyToFile` collapsed onto one `consumeBody` loop behind a `BodySink`.
- `ZipFileReader` extraction is genuinely async behind an explicit `ChunkSink`; `preview` cascaded
  to async. Regression test: extraction must not starve a 1 ms timer.
- `TempArchiveBuilder` has one `cleanup()`; `RestoreService.confirm` states its success path
  instead of inferring it from map membership.
- The `tests/inference-runs.test.ts` branded-context hazard flagged under Task 11 above is gone —
  the context now comes from `createTestServerContext`, so a future `ServerContext` migration fails
  at compile time. (It immediately caught two `ModelRequestLock` literals missing
  `holdTimeoutHandle`.)

**Known residual: `tests/dashboard-status-server.test.ts` is load-sensitive.** Adding a
PowerShell-spawning compatibility test raised parallel load and surfaced two timing-fragile tests
there. One was a real race and is fixed (`2df43ee9`). The other — "same session conflicts cover
message plan and repo-search JSON and SSE routes" — holds a model lock for 600 ms and aborts its
active requests after 500 ms, then makes 18 sequential HTTP round-trips that must all land inside
that window. It fails intermittently under load. Bisection in a clean clone proved this is
pre-existing fragility, not a regression: `ce832dd5` green, `2912f45b` red, and `2912f45b` changes
no `src` file at all. Fixing it properly means holding the active operation until explicitly
released rather than by wall clock.

## Drift follow-up (2026-08-20) — complete

The eight follow-up findings the user selected from the 2026-08-19 reflection were closed under
`docs/superpowers/plans/2026-08-20-drift-followup-remediation.md`, commits `9feadf9f`..`3c1abb02`.
Findings 1, 2, 3, 4, 5, 7, 9 and 10 are closed:

- `BodySink.write` is async and `consumeBody` pauses the request per chunk, so no request body
  reaches disk synchronously. Ordering guard: a 8 MB position-dependent payload must hash equal.
- `RestoreService.preview` parks its upload with `fs.promises.copyFile`, not `copyFileSync`.
- `findEocdOffset` throws instead of returning `-1`; its only caller lost the sentinel check.
- `ZipFileReader` has one read path, over the `FileHandle` promise API. The `private get fd()`,
  the synchronous `readExactly` and `readExactlyAsync` are gone, `readEntry` is async, and the
  class doc's non-blocking claim is now true rather than aspirational.
- `TempArchiveBuilder.finish()` returns `{ path, cleanup }` bound to the builder's own `cleanup`,
  so a sealed archive no longer hands back its writer.
- `tests/zip-external-tool.test.ts` claims only what Expand-Archive can detect; the UTF-8 flag-bit
  claim is replaced by a note that no available oracle can pin that bit.
- The four token assertions duplicated after the poll in `tests/dashboard-status-server.test.ts`
  are gone, and `statusMetrics` moved inside the poll that assigns it.

Reviewed and deliberately left:

- 6 — `readArchiveEntriesFromBytes` still round-trips bytes through a temp file; accepted because
  it is test-only and the alternative is a second reader.
- 8 — `BufferBodySink.take()` keeps its unreachable-state throw; accepted because the nullable
  field is what makes the sink's two-phase contract type-safe.

**Not covered, still open:** `ZipFileWriter.writeAt` (`src/lib/zip-file-writer.ts:112`) uses
`fs.writeSync`. No 2026-08-19 finding named it, so it was out of this plan's scope — but it is the
same defect class as finding 1 on the archive-writing half, and a backup writes the whole evidence
tree through it.

## Suggested next steps

1. Make `DashboardModelQueueHarness` release its held operation explicitly instead of on a
   wall-clock timer, so the session-conflict matrix stops depending on 18 round-trips fitting in
   500 ms.
