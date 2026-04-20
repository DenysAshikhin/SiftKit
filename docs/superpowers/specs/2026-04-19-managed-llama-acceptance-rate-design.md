# Managed Llama Acceptance Rate Design

**Goal:** Track speculative decoding acceptance rate for the managed llama.cpp server, persist it per completed run, and aggregate it into dashboard metrics the same way prompt cache hit rate is derived from stored token totals.

## Scope

- Managed llama server only.
- Capture acceptance metrics from managed llama stdout/stderr logs after requests complete.
- Persist accepted/generated speculative token counts on run records.
- Aggregate acceptance rate into dashboard metrics/history.
- Exclude external/custom unmanaged `BaseUrl` servers.
- Exclude live in-flight acceptance charts or per-token streaming telemetry.

## Current Context

SiftKit already tracks prompt cache effectiveness by:

- storing raw prompt cache and prompt eval token counts on completed runs
- aggregating those stored totals into daily metrics
- deriving cache hit rate in the dashboard from aggregate totals rather than from transient UI state

Managed llama output already flows through a dedicated launcher/logging pipeline. That makes it the correct place to extract speculative acceptance metrics without changing model request payloads or the OpenAI-compatible response contract.

## Recommended Approach

Add one managed-server-only telemetry path that parses speculative summary lines from managed llama logs, stores raw accepted/generated token counts on each completed run, and computes aggregate acceptance rate from totals.

This mirrors the cache-hit-rate design:

- store primitive counts
- aggregate primitive counts
- derive displayed rate from aggregated totals

This avoids lossy averaging across runs and keeps the metric stable when some requests have no speculative data.

## Data Model

Add two persisted numeric fields to completed run records:

- `speculativeAcceptedTokens`
- `speculativeGeneratedTokens`

Derive:

- per-run `acceptanceRate = speculativeAcceptedTokens / speculativeGeneratedTokens` when generated tokens are greater than zero
- aggregate `acceptanceRate = totalAccepted / totalGenerated` when total generated tokens are greater than zero

Null/absence rules:

- unmanaged or non-speculative runs store `null`
- managed runs with no observed speculative summary lines store `null`
- aggregate acceptance rate is `null` when total generated speculative tokens is zero

## Extraction Design

### Source

Parse managed llama log text for the speculative statistics lines emitted by `llama.cpp`, for example:

- `draft acceptance rate = ... (accepted / generated)`
- `statistics ngram_*: ... #gen tokens = ..., #acc tokens = ...`

### Parser behavior

Prefer token counts over the already-computed rate string:

- use `accepted` and `generated` counts from the log
- compute the rate inside SiftKit from those counts

Reason:

- preserves exact totals for aggregate calculations
- avoids rounding drift from upstream formatted percentages

### Association with runs

Attach parsed speculative totals to the same completed run artifact that currently receives prompt cache/eval token totals.

The parser should use the final speculative summary observed during a managed request lifecycle and ignore earlier partial/noisy matches from unrelated startup logging.

## Storage and Aggregation

### Run-level persistence

Extend the run log/runtime artifact persistence layer to accept:

- `speculativeAcceptedTokens`
- `speculativeGeneratedTokens`

### Aggregate metrics

Extend daily/task aggregate tables and rollups with:

- `speculativeAcceptedTokensTotal`
- `speculativeGeneratedTokensTotal`

Compute dashboard acceptance rate from those totals:

- `acceptanceRate = speculativeAcceptedTokensTotal / speculativeGeneratedTokensTotal`

This should follow the same model as cache hit rate:

- store totals
- derive rate during read/format

## UI

### Metrics tab

Add acceptance-rate visibility alongside existing cache metrics:

- acceptance-rate series
- accepted/generated speculative token totals where metric totals are displayed

Presentation rules:

- show percentage when aggregate data exists
- show neutral/empty state when no speculative totals exist

No acceptance-rate UI is added to chat or per-run log detail in this pass.

## Error Handling

- If no speculative summary line is found, store `null` metrics and continue normally.
- If malformed speculative text is found, ignore the malformed sample rather than failing the run.
- If both explicit rate text and token totals are present but disagree, trust token totals and recompute the rate.
- Parsing must never cause a managed run to fail.

## Testing

Add coverage for:

- managed log parsing of accepted/generated speculative tokens
- completed run persistence of the new fields
- aggregate totals and derived acceptance rate math
- empty/non-speculative runs returning `null` acceptance rate
- mixed speculative and non-speculative runs aggregating correctly
- dashboard metric response shape and UI rendering

## Implementation Boundaries

Files likely involved:

- managed llama log capture/parsing
- run log/runtime artifact persistence
- metrics aggregation and response formatting
- dashboard types and metrics UI tests

No changes are required to:

- external provider request payloads
- unmanaged servers
- CLI summary/repo-search provider contracts

## Success Criteria

- Managed speculative runs record accepted/generated token counts.
- Dashboard metrics expose aggregate acceptance rate.
- Aggregate acceptance rate is computed from totals, not averaged per run.
- Non-managed or non-speculative runs do not produce false acceptance metrics.
