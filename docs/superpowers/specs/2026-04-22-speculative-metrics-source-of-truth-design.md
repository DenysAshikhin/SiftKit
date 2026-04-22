# Speculative Metrics Source Of Truth Design

## Goal

Make speculative accepted/generated token metrics come only from managed-llama log delta parsing, with `null` persisted when no managed-log delta is available for a request.

## Problem

The current persistence flow allows `run_logs.speculative_accepted_tokens` and `run_logs.speculative_generated_tokens` to fall back to request or repo artifact payload values when the managed-llama log-derived values are missing. In practice, those fallback payload values can disagree with the managed-llama log delta and produce incorrect acceptance rates in dashboard runs and benchmark outputs.

## Requirements

- `run.speculativeAcceptedTokens` and `run.speculativeGeneratedTokens` must reflect managed-llama log delta values only.
- If a request has no managed-llama log delta, both speculative fields must remain `null`.
- Request payload fields such as `requestPayload.speculativeAcceptedTokens`, `requestPayload.speculativeGeneratedTokens`, `failedRequestPayload.speculative*`, and repo artifact totals must not be used as speculative metric fallbacks.
- Existing consumers that compute acceptance rate from `run.speculativeAcceptedTokens / run.speculativeGeneratedTokens` should continue working without API shape changes.
- Existing behavior that updates persisted speculative metrics from `/status` log-delta handling must remain intact.

## Recommended Approach

Keep `run_logs.speculative_accepted_tokens` and `run_logs.speculative_generated_tokens` as the only canonical store, but restrict writes to the managed-llama log-delta path in `/status`. Remove all artifact/request fallback logic for speculative metrics during run-log flush and dashboard row canonicalization.

This keeps the fix small and direct:

- the write path becomes authoritative
- the read path stays simple
- benchmark and dashboard code do not need special-case logic
- incorrect payload-derived speculative ratios can no longer leak back into persisted runs

## Non-Goals

- No schema change or provenance column.
- No change to prompt/output token metrics.
- No semantic validation of repo-search answers.
- No attempt to reconstruct speculative metrics from artifacts when logs are missing.

## Design

### Canonical Data Flow

1. `/status` request handling captures a managed-llama speculative snapshot at request start.
2. On later `/status` updates for the same request, the server computes a delta with `getManagedLlamaSpeculativeMetricsDelta(...)`.
3. When that delta exists, the server persists it into `run_logs.speculative_accepted_tokens` and `run_logs.speculative_generated_tokens`.
4. Dashboard run queries and benchmark helpers read those persisted columns directly.
5. If step 2 never yields a delta, the persisted speculative fields remain `null`.

### Write Path

Keep the current `/status` handling behavior that calls `getManagedLlamaSpeculativeMetricsDelta(...)` and `updateRunLogSpeculativeMetricsByRequestId(...)`.

That path is the only allowed writer for speculative metrics.

### Flush Path

Update run-log row construction so speculative metrics are not populated from:

- request payload speculative fields
- failed request payload speculative fields
- repo totals speculative fields

During artifact flush, canonical speculative metrics should resolve to:

- persisted DB values if already written by `/status`
- otherwise `null`

### Read Path

No consumer API changes are needed. Dashboard runs, run detail, and benchmark helpers should keep using the persisted run values they already read from `run_logs`.

### Acceptance Rate Behavior

Acceptance rate remains derived as:

`speculativeAcceptedTokens / speculativeGeneratedTokens`

Only compute it when:

- both values are non-null
- `speculativeGeneratedTokens > 0`

Otherwise acceptance rate is `null`.

## Files In Scope

- `src/status-server/dashboard-runs.ts`
  - remove speculative fallback inputs from canonical resolution during flush/query paths
- `src/status-server/routes/core.ts`
  - preserve current managed-log delta persistence path
- `tests/status-server-speculative-metrics.test.ts`
  - add coverage that artifact/request speculative values do not populate run metrics without managed-log delta
- `tests/benchmark-spec-settings.test.ts`
  - keep benchmark acceptance behavior aligned with persisted run values only

## Testing Strategy

### Required Failing Test First

Add a test that creates a completed repo-search run with speculative values present only in request/repo artifacts, but without any managed-llama log-delta persistence. The expected dashboard run and run detail values must both be `null`.

This test should fail against current behavior because the flush path currently falls back to artifact/request speculative values.

### Regression Coverage

Keep or strengthen the existing test proving that when managed-log delta metrics are persisted, those persisted values survive artifact flush even if artifacts disagree.

Also keep the benchmark helper assertions that acceptance rate comes strictly from the run's speculative fields.

## Risks

- Requests that never produce managed-llama log delta will now show `null` speculative metrics instead of best-effort values. This is intentional and preferred to incorrect ratios.
- Any hidden consumer relying on artifact-derived speculative values will now see `null`. That is acceptable because those values are not trustworthy.

## Success Criteria

- No persisted speculative metrics are sourced from request/repo artifact payloads.
- Benchmark output no longer shows false `1.0` acceptance rates caused by payload fallback.
- Speculative acceptance is present only when managed-llama log delta was actually captured.
