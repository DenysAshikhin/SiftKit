# Read-window semantics: repeat-read rejection + mutation invalidation — design (2026-07-30)

## Problem

`ReadWindowGovernor` tracks which line ranges of which files have already been returned to the
model, and `planRead` skips past them. Two defects, validated empirically against the real
`executeRepoTool` on a 200-line fixture:

1. **`edit`/`write` never invalidate the read state.** `executeWrite` and `executeEdit`
   (`src/repo-search/engine/repo-tools.ts`) do not touch `fileReadStateByPath`. After an agent
   edits line 5 and re-issues `read(sample.py, 1..100)`, it receives lines **101–200**. For the
   remainder of the run the agent is structurally blind to the current content of the region it
   just modified. There is no `force`/`refresh` argument on `read`.

2. **`ExpandReads: false` removes the window logic entirely, with no replacement guard.**
   `planRead` passes `returnedRanges: []` in that mode, so an identical `read` returns the same
   100 lines indefinitely. `read` is exempt from duplicate screening
   (`canAdvanceRepeatedRead`, `tool-action-processor.ts:401`), so the repeat is not rejected, does
   not increment `commandFailures`, and does not advance the 5-strike stagnation counter toward
   forced-finish. `applyToolOutputRepetitionGuard` is intra-result only. The 66.67% overlap rate
   `ReadWindowGovernor.summary()` reports is telemetry with nothing enforcing it.

The two configurations trade one failure for the other: `true` guarantees no wasted re-reads but
blinds the agent to its own edits; `false` gives correct content with no protection against
unbounded re-reading.

## Scope

In: `planRead` window arithmetic, the rejection surface for exhausted reads, read-state
invalidation on mutating tools, and the tests covering all three.

Out: a `force` argument on `read`; per-tool `ExpandReads` overrides; changes to
`ToolResultBudgeter` fitting; changes to the transcript or context-pruning behaviour.

## Governing decision

**After this change both modes skip already-returned lines. `ExpandReads` controls only the
*end* of the window.** `false` no longer means "no window management" — it means "do not run
past the requested `limit`". `true` keeps its expanding behaviour: once a file has prior
returned ranges, a follow-up read runs to EOF (subject to token fitting) instead of stopping at
the requested end. Both modes reject a request whose entire window is already covered.

Invalidation clears **bookkeeping only**. `mergedReturnedRanges` is what suppresses a re-read;
resetting it restores permission to fetch those lines again. The transcript is untouched: prior
`read` tool results remain in the message list and the model keeps the old content in context.

## A. Unified window arithmetic (`planRead`)

Given a requested window `[S, E)` and merged returned ranges `R`:

```
start' = advance S forward past any range in R that covers it
end'   = min(start of the next range after start',
             ExpandReads ? EOF : E)          <- the only mode-dependent term
fully-covered  <=>  start' >= (ExpandReads ? EOF : E)   -> reject
```

`src/repo-search/engine/repo-tools.ts:379` passes `returnedRanges` unconditionally instead of
gating it on `expandReads`. The existing `expandReads && hasReturnedRanges` guard on `totalEnd`
(`:378`) stays, so a *first* read of a file still honours its `limit` in both modes.

Resulting behaviour on a 200-line file:

| sequence | ExpandReads off | ExpandReads on |
| --- | --- | --- |
| `read(1..100)` fresh | 1–100 | 1–100 |
| then `read(50..150)` | 101–150 | 101–200 |
| then `read(20..80)` | reject | reject |
| then `edit`, then `read(1..100)` | 1–100 | 1–100 |

## B. Rejection surface

The pre-execution `canAdvanceRepeatedRead` bypass (`tool-action-processor.ts:401`) **stays**. A
command-string match cannot know about range coverage, and keeping the bypass avoids two
competing rejection messages for the same call.

The authoritative check is post-execution. `planRead` already computes `hasUnread`;
`buildReadExecution` surfaces it as `readFile.hasUnread: boolean` on the `ok: true` variant of
`RepoToolExecution`. `ToolActionProcessor` inspects it after `runNativeExecution` and before
`screenRejection`, and routes an exhausted read into the existing duplicate machinery:
`duplicates.registerDuplicate` -> replay-message collapse -> `counters.commandFailures += 1` ->
`duplicates.shouldForceFinish()` -> `forcedFinish.activateFromStagnation()`.

That block is extracted from `screenWebAndDuplicates` into a private
`rejectAsDuplicate(turn, context, state, options)` shared by both call sites, so no rejection
logic is duplicated. `options` carries the rejection reason string, the prospective tool type,
and whether the rejection is semantic. An exhausted read passes `isSemantic: false` and its own
reason, so it does not inflate `toolStats.recordSemanticRepeatReject`.

`No unread lines remain for <path>.` is removed. That soft exit-0 path becomes a rejection in
**both** modes. The rejection text names the blocked range and the unblock condition, for
example: `lines 20-80 of src/a.ts were already returned in this run; read a different range, or
edit/write the file to re-read it.`

## C. Invalidation

`ReadWindowGovernor` gains two methods:

- `invalidatePath(pathKey: string): void`
- `invalidateAll(): void`

Both reset `mergedReturnedRanges` to `[]` and **keep** the cumulative `totalLinesRead`,
`uniqueLinesRead` and `overlapLines` counters. Lines re-read after an invalidation are genuinely
new content, so they count as unique rather than overlap, and the overlap metric stays a
meaningful signal for windows that were skipped without cause.

All invalidation lives in `ToolActionProcessor`, which owns the governor. `executeWrite` and
`executeEdit` report `mutatedPathKey: string` on their `ok: true` result so path resolution is
not duplicated outside `repo-tools.ts`.

| tool | trigger |
| --- | --- |
| `write`, `edit` | `ok: true` -> `invalidatePath(mutatedPathKey)` |
| `run` | any completion, including non-zero exit -> `invalidateAll()` |
| `git` | any completion, including non-zero exit -> `invalidateAll()` |

A failed `edit` returns before `writeFileSync`, so gating on `ok: true` is exact. `run` and `git`
cannot report which paths they touched and both can rewrite the tree
(`command-safety.ts` has no git subcommand allowlist — `git checkout .` and `git reset --hard`
pass the gate today), so any invocation clears everything. Non-zero exits still invalidate
because a partially-applied command still mutates.

`write`, `edit` and `run` are agent-only (`status-server/routes/core.ts:889` selects
`INTERACTIVE_REPO_TOOL_NAMES` when `mode === 'agent'`), so repo-search picks up sections A and B
plus the `git` rule and nothing else. No mode flag is introduced anywhere.

## D. Testing

TDD, E2E first.

**E2E — `tests/mock-repo-search-loop.test.ts`**, scripted model over the real loop:

- `read -> edit -> read` with identical args returns the post-edit content of the same range.
- `read -> read` with identical args is rejected, increments `commandFailures`, and appears in
  the transcript as a repeated-call summary rather than file content.
- Five consecutive rejected reads trip forced-finish mode.
- `run` between two identical reads unblocks the second.
- `git` between two identical reads unblocks the second.
- Both of the above under `ExpandReads: true` and `ExpandReads: false`.

**Unit — `tests/repo-tools.test.ts`:**

- The full section-A table: fresh / partial-overlap / fully-covered, each under both modes.
- A first read still honours `limit` under `ExpandReads: true`.
- `write` and `edit` return `mutatedPathKey`; a failed `edit` returns no `mutatedPathKey`.
- `buildReadExecution` sets `readFile.hasUnread` correctly in both branches.

**Unit — read-window governor:**

- `invalidatePath` clears ranges for one path and leaves other paths untouched.
- `invalidateAll` clears every path.
- Both preserve `totalLinesRead` / `uniqueLinesRead` / `overlapLines`.
- Lines re-read after an invalidation count as unique, not overlap.

## Consequences

- An agent can always re-read what it just wrote, in either mode.
- A looping agent that re-reads the same range now pays a rejection instead of full token cost,
  and escalates to forced-finish after five attempts.
- `ExpandReads: false` becomes a limit-respecting mode rather than a no-guard mode. Runs
  configured that way lose unbounded re-reads, which is the intent.
- `run` and `git` discard all skip-ahead state for the run. In agent mode this is the correct
  trade: a validation command or a checkout can invalidate any file.
