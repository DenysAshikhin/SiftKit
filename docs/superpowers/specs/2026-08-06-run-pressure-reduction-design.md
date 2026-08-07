# Run Pressure Reduction — Design

Date: 2026-08-06
Status: Approved

## Problem

Investigation of live repo-search/repo-agent runs found four resource-pressure
sources:

1. **Per-turn full-prompt re-tokenize (O(n²) per run).** Every turn re-renders
   the whole transcript (`src/repo-search/engine/prompt-preparer.ts:59`) and
   POSTs the full text to the engine `/tokenize` endpoint
   (`src/repo-search/prompt-budget.ts:120` → `src/llm-protocol/llama-cpp-client.ts:189`).
   Measured 42→178 ms per turn and growing, against a GPU-saturated engine.
2. **PowerShell spawn per shell/git command.**
   `src/repo-search/engine/command-execution.ts:68` spawns `powershell.exe`
   (~100–300 ms + tens of MB) for every non-native command. `grep` already
   spawns `rg` directly (`src/repo-search/engine/repo-tools.ts:708`).
3. **`pending_log_peak` console flood.** One stdout line per 1 KB of
   engine-output delta (`src/state/inference-runs.ts:51`).
4. **Engine CPU.** The python engine holds ~4.8 cores continuously while
   generating (measured 23,741 CPU-s over ~1 h; GPU at 93–100%).

Non-problems confirmed during investigation: the log-chunk flush pipeline is
bounded (8 MB high-water), batched (single SQLite transaction in a worker
thread), and deferred off the inference path; RAM has no paging pressure.

## Scope decisions

- All four items in scope.
- Item 1 strategy: delta counting with exact recount near the budget boundary.
- Item 4: diagnose only — no launcher changes.

## Design

### 1. Incremental token counting

Facts the design relies on:

- `renderTaskTranscript` (`src/repo-search/planner-protocol.ts:851-871`) joins
  per-message blocks with `\n\n` and ignores `reasoning_content`, so per-turn
  thinking pruning does not change the rendered text. Most turns are pure
  appends to the rendered prompt.
- Mid-transcript rewrites are occasional: compaction (`replaceWith`),
  duplicate-replay `replaceToolMessage`, forced-finish `upsertTrailingUser`.

New module `src/repo-search/incremental-token-counter.ts` exporting
`IncrementalTokenCounter`:

- State: `lastText`, `lastCount`, `lastSource`.
- `count(config, text, { forceExact })`:
  - `text === lastText` → return cached count (covers the near-constant
    provider reserve text).
  - `text.startsWith(lastText)` and not `forceExact` → tokenize only
    `text.slice(lastText.length)` via the existing
    `countTokensWithFallbackDetailed` path; result is
    `lastCount + deltaCount`. Update state.
  - Otherwise → full tokenize (first turn, compaction, rewrites). Update state.
  - No config (`useEstimatedTokensOnly`) → estimate fallback, unchanged.
- Exact-near-budget: in `preflightPlannerPromptBudget`, when a delta-derived
  count lands within `EXACT_RECOUNT_MARGIN = 2048` tokens of
  `maxPromptBudget`, recount once with `forceExact` before deciding
  overflow/compaction. This bounds seam-merge drift (≤ ~2 tokens per delta)
  exactly where accuracy matters.
- Wiring: `PromptPreparer` owns two counter instances (prompt, reserve) and
  passes them into `preflightPlannerPromptBudget`. Other preflight callers
  keep the current one-shot behavior. Repo-search and repo-agent share this
  engine loop, so one fix covers both.

Net effect: per-turn tokenize payload drops from the full prompt (100k+ chars)
to the appended tail (~1–2 KB), flat across the run.

### 2. Direct git spawn

In `executeRepoCommand` (`src/repo-search/engine/command-execution.ts`):

- Tokenize the command string with a minimal quote-aware splitter (double and
  single quotes, no expansion).
- If the first token is `git` and the command contains no shell
  metacharacters (pipe, ampersand, semicolon, redirects, `$`, backtick,
  parentheses), run
  `spawnDirectCommand('git', args)` with `AGENT_RUN_ID_ENV` in the env —
  mirroring the `grep`→`rg` path.
- Anything else keeps `spawnPowerShellAsync` (it genuinely needs a shell;
  correct routing, not a compatibility path).
- Output shape must match the PowerShell path (combined stdout+stderr,
  exit code).

### 3. pending_log_peak noise

Raise `PENDING_LOG_PEAK_MIN_STREAM_CHARACTER_DELTA`
(`src/state/inference-runs.ts:51`) from 1 KB to 256 KB. Still yields 32 lines
before the 8 MB flush high-water. Existing tests adjusted; no other behavior
change.

### 4. Engine CPU — diagnosis only

Procedure (no code changes):

1. Measure engine CPU over ≥60 s while fully idle (wait for queue drain;
   restart the server only if needed).
2. Sample the python process thread count and per-thread activity.
3. Compare with generating-state CPU (~4.8 cores measured).
4. Inspect the launcher environment for OMP/torch thread settings.

Deliverable: evidence + proposed fix in the completion report; launcher
untouched.

## Error handling

- Tokenize HTTP failures fall back to the estimate exactly as today; a delta
  failure falls back the same way and resets counter state.
- Command-splitter bail-out routes to PowerShell.
- No new failure modes on the inference path.

## Testing (TDD)

- `IncrementalTokenCounter` unit tests: cache hit, delta path, divergence →
  full recount, `forceExact`, estimate fallback, failure → state reset.
- Preflight tests: near-budget exact recount trigger; delta reuse across
  turns; compaction forces full recount.
- Command-execution tests: git arg tokenization (quotes), metachar bail-out
  to PowerShell, env passthrough, output parity with the PowerShell path.
- Updated pending-log-peak threshold test.
- Before completion: targeted suites, broader applicable suite,
  `npm run typecheck`, `npm run lint`, plus live before/after measurement
  (per-turn tokenize ms, pending_log_peak line counts).

## Success criteria

- Turn t>1 tokenize calls send only the appended tail; measured per-turn
  tokenize time flat instead of growing with prompt size.
- git commands in runs no longer spawn powershell.exe.
- pending_log_peak lines reduced ~256× per run.
- Engine CPU cause identified with evidence and a concrete proposed fix.
- All suites, typecheck, lint green.
