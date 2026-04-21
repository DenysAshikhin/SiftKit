# SiftKit Spec-Settings Benchmark Design

Date: 2026-04-20

## Goal

Add a benchmark script that uses the live SiftKit CLI end-to-end to measure how different speculative decoding settings affect:

- `Output/s`
- `Acceptance`
- supporting telemetry such as cached/eval tokens and wall-clock duration

The benchmark prompt is fixed to:

`how are tool calls handled?`

The benchmark must:

- drive the public `siftkit` CLI surface, not a direct llama-server invocation
- mutate the live managed-llama configuration
- restart SiftKit fresh for each benchmark case
- read the same telemetry that powers the UI header, without scraping the UI
- record multiple curated speculative-setting cases while keeping `SpeculativeType` unchanged

## Scope

In scope:

- one new benchmark script under `scripts/`
- a curated list of speculative-setting cases to try
- automatic restart/startup/shutdown between cases
- session/run discovery for the benchmarked CLI request
- result capture to JSON and CSV
- ranking by `Output/s`

Out of scope:

- UI changes
- automatic optimization/search beyond the curated case list
- changing `SpeculativeType`
- isolated runtime roots or sandboxed benchmark databases

## Recommended Approach

Use a PowerShell harness that:

1. stops any running SiftKit/status-server instance
2. updates the live managed-llama config values for one benchmark case
3. starts SiftKit fresh
4. waits for backend health and managed-llama readiness
5. runs:
   - `siftkit repo-search --prompt "how are tool calls handled?"`
6. identifies the newly created session and relevant managed-llama run
7. extracts the session telemetry used by the UI header
8. verifies speculative metrics from the managed-llama logs
9. persists one result row
10. shuts SiftKit down before the next case

This matches the user’s requirement to benchmark the integrated SiftKit path rather than a lower-level raw llama.cpp path.

## Why Not The Alternatives

### Direct HTTP `/dashboard/chat/...` driver

Rejected because it bypasses the public CLI execution path the benchmark is intended to measure.

### Raw `llama-server.exe` benchmark

Rejected because it measures model throughput, not SiftKit end-to-end behavior.

### UI scraping

Rejected because the same metrics are available more reliably from the stored session telemetry and managed-llama logs.

## Script Location and Interface

New script:

- `scripts/benchmark-siftkit-spec-settings.ps1`

Expected parameters:

- `-Prompt`
  - default: `how are tool calls handled?`
- `-Cases`
  - optional JSON file path for overriding the built-in case list later
- `-OutputRoot`
  - default under `eval/results/`
- `-StatusHost`
  - default `127.0.0.1`
- `-StatusPort`
  - default `4765`
- `-RepoRoot`
  - default current repo root
- `-StartCommand`
  - default `npm run start:status`
- `-ShutdownAfterEachCase`
  - default enabled

The first implementation can keep the interface small and hardcode the built-in case list while still allowing prompt/output overrides.

## Live-System Behavior

The script will benchmark against the live runtime, not an isolated copy.

Consequences:

- benchmark sessions will be written into the normal `.siftkit/runtime.sqlite`
- managed-llama runs will appear in the normal admin log history
- the live config will be mutated during the benchmark

To reduce operator risk, the script must:

- capture the original managed-llama speculative settings before the first case
- restore the original values when the script finishes or fails
- attempt best-effort shutdown of the started backend during cleanup

## Config Mutation Strategy

The script should update only these managed-llama fields:

- `SpeculativeEnabled`
- `SpeculativeNgramSizeN`
- `SpeculativeNgramSizeM`
- `SpeculativeNgramMinHits`
- `SpeculativeDraftMax`
- `SpeculativeDraftMin`

It must not modify:

- `SpeculativeType`
- model path
- batch sizes
- unrelated runtime settings

Config writes should go through the status server config API if available so the stored config shape stays normalized.

## Startup and Shutdown Strategy

Per case:

1. stop any currently running backend on the configured status port
2. write config for the case
3. start backend with `npm run start:status`
4. wait for `/health`
5. wait until managed-llama has a latest run with `status = ready`
6. run the CLI prompt
7. collect artifacts
8. stop the backend

Fresh restart per case is required so speculative settings definitely apply and cross-case warm state is minimized.

## CLI Benchmark Request

Each case runs exactly one CLI command:

`siftkit repo-search --prompt "how are tool calls handled?"`

The benchmark should capture:

- CLI stdout
- CLI stderr
- process exit code
- wall-clock duration

The benchmark should not parse benchmark results out of the generated answer text. It should use runtime/session telemetry instead.

## Session Discovery

After the CLI request completes, the script must identify the new session produced by that invocation.

Reliable matching strategy:

- snapshot the current newest session timestamp/id before running the CLI command
- after the command, query sessions again
- choose the newest session updated after the command start time
- verify:
  - preset/mode is `repo-search`
  - latest user message content equals the benchmark prompt

This avoids depending on the CLI output format.

## Metrics Source

Primary metrics source:

- session telemetry returned by the status-server chat/session endpoints or read from the persisted session payload

These provide the values that drive the UI header:

- `Prompt/s`
- `Output/s`
- `speculativeAcceptedTokens`
- `speculativeGeneratedTokens`
- prompt cache/eval counts

Acceptance should be computed the same way as the UI:

- session acceptance = `sum(speculativeAcceptedTokens) / sum(speculativeGeneratedTokens)`
- null when the generated sum is zero

Supporting verification source:

- latest managed-llama run log text from `/dashboard/admin/managed-llama/runs/:id`

This is used to confirm:

- speculation actually initialized
- `speculative:true` was active
- cumulative speculative totals were emitted

## Result Schema

Each benchmark case should emit one result object containing:

- case id
- prompt
- start/end timestamps
- CLI duration ms
- CLI exit code
- managed run id
- session id
- speculative settings:
  - `SpeculativeNgramSizeN`
  - `SpeculativeNgramSizeM`
  - `SpeculativeNgramMinHits`
  - `SpeculativeDraftMax`
  - `SpeculativeDraftMin`
- session metrics:
  - `promptTokensPerSecond`
  - `outputTokensPerSecond`
  - `acceptanceRate`
  - `promptCacheTokens`
  - `promptEvalTokens`
  - `speculativeAcceptedTokens`
  - `speculativeGeneratedTokens`
  - `outputTokensEstimate`
  - `thinkingTokens`
  - `generationDurationMs`
- log verification fields:
  - whether `speculative:true` was seen
  - whether checkpointed speculation was seen
  - latest cumulative `#gen tokens`
  - latest cumulative `#acc tokens`
  - latest raw acceptance line, if present

Outputs:

- JSON with all raw rows
- CSV summary sorted by descending `Output/s`

## Curated Case List

The initial implementation should not brute-force the full cartesian product.

It should run a curated shortlist centered around the currently working profile:

Baseline:

- `N=24, M=64, MinHits=2, DraftMax=48, DraftMin=4`

Suggested initial case set:

1. `N=16, M=48, MinHits=1, DraftMax=32, DraftMin=2`
2. `N=16, M=64, MinHits=2, DraftMax=48, DraftMin=4`
3. `N=16, M=96, MinHits=2, DraftMax=64, DraftMin=4`
4. `N=24, M=48, MinHits=1, DraftMax=48, DraftMin=2`
5. `N=24, M=64, MinHits=2, DraftMax=48, DraftMin=4`
6. `N=24, M=96, MinHits=2, DraftMax=64, DraftMin=4`
7. `N=32, M=64, MinHits=2, DraftMax=48, DraftMin=4`
8. `N=32, M=96, MinHits=3, DraftMax=64, DraftMin=4`
9. `N=24, M=64, MinHits=3, DraftMax=48, DraftMin=4`
10. `N=24, M=64, MinHits=2, DraftMax=48, DraftMin=8`
11. `N=24, M=64, MinHits=2, DraftMax=64, DraftMin=4`
12. `N=24, M=32, MinHits=2, DraftMax=32, DraftMin=4`

Rationale:

- vary `N` around the current 24
- vary `M` from moderate to aggressive
- test both easier and stricter `MinHits`
- test whether `DraftMin` is suppressing useful speculation
- test whether larger `DraftMax` helps throughput on this repo-search workload

## Error Handling

The script must fail clearly when:

- status server does not become healthy
- managed llama does not become ready
- CLI command exits nonzero
- no matching benchmark session can be found
- no managed run can be associated with the case

The script should still append a failed result row where possible with:

- case id
- settings
- stage of failure
- error message

Cleanup must still run on failure.

## Testing Strategy

The implementation should use TDD and add focused tests around the non-shell logic.

Testable logic should be extracted into a small TS helper module rather than embedding all logic directly in PowerShell.

Test targets:

- case list normalization
- result sorting
- acceptance-rate computation from message telemetry
- session selection logic for “newest matching session after benchmark start”
- parsing of latest cumulative speculative metrics from managed-llama log text
- config snapshot/restore payload shaping

The PowerShell script itself can stay thin and delegate parsing/selection logic to typed TS helpers.

## Expected Limitations

- per-case results will still contain some run-to-run model variance
- using the live runtime means benchmark history mixes with normal operator history
- repo-search workloads include tool overhead and prompt variation, so this is an end-to-end practical benchmark rather than a pure model microbenchmark

## Implementation Notes

To keep diffs minimal:

- prefer one new TS helper module for benchmark parsing/selection
- prefer one new PowerShell entry script
- reuse existing status-server endpoints and session telemetry instead of adding new APIs unless strictly necessary

## Success Criteria

The feature is complete when:

1. one command runs all benchmark cases against the current repo
2. each case restarts SiftKit fresh and uses the live CLI path
3. results include `Output/s` and `Acceptance`
4. results are ranked and persisted
5. the original speculative settings are restored after completion or failure
