# Chars-Per-Token Calibration Design

## Goal

Make `Effective.InputCharactersPerContextToken` reflect real observed char-to-token conversions from this workload.

After this change, the calibration source should be exact local observations gathered whenever SiftKit has an accurate character count and an accurate token count for the same text.

## Problem

Today the observed chars-per-token value is derived from aggregate status metrics:

- numerator: `inputCharactersTotal`
- denominator: `promptCacheTokensTotal + promptEvalTokensTotal`

That is not a valid calibration ratio for this purpose.

It mixes:

- small top-level prompt character counts
- large cached/evaluated prompt token totals accumulated across provider turns

This distorts the ratio badly, especially for repo-search, and can drive the effective value far below any realistic chars-per-token estimate for the actual workload.

## Decision

Adopt a weighted persisted observation model.

- Replace the status-snapshot-derived calibration path with explicit exact observations.
- Add one central recorder for accurate char-to-token measurements.
- Persist cumulative observed character and token totals.
- Derive the effective chars-per-token value as a weighted average:
  - `observed_chars_total / observed_tokens_total`

This makes the calibration value represent the actual text that SiftKit has directly measured, instead of indirect aggregate runtime telemetry.

## Non-Goals

- Do not redesign prompt budgeting call sites.
- Do not change how estimated fallback token counting works, beyond feeding better calibration.
- Do not remove the bootstrap fallback before any exact observation exists.
- Do not add per-model or per-feature calibration buckets in this change.

## Target Behavior

### Before any exact observation exists

Use the existing bootstrap fallback:

- `2.5` chars per token

This preserves cold-start behavior.

### After exact observations exist

Use persisted weighted calibration only:

- `observed_chars_total / observed_tokens_total`

Do not derive this value from status snapshot aggregate metrics.

### What counts as an exact observation

Any path that has an accurate character count and an accurate token count for the same text may update calibration.

Initial required sources:

- successful `/tokenize` responses
- successful provider responses that expose exact prompt token counts for the exact prompt text sent

Explicitly excluded:

- estimated token counts based on chars-per-token division
- aggregate status metrics
- token totals that do not correspond to the exact text length being recorded

## Data Model

Extend `observed_budget_state` to store weighted totals in addition to the current cached ratio:

- `observed_telemetry_seen`
- `last_known_chars_per_token`
- `observed_chars_total`
- `observed_tokens_total`
- `updated_at_utc`

### Invariants

- totals must be finite and positive to count as observed state
- `last_known_chars_per_token` must equal `observed_chars_total / observed_tokens_total`
- zero or invalid observations must be ignored

## Write Path

Add one central helper, conceptually:

- `recordAccurateCharTokenObservation(chars, tokens, source)`

Responsibilities:

1. validate the observation
2. read current persisted totals
3. add new `chars` and `tokens` to the totals
4. recompute `last_known_chars_per_token`
5. persist the updated row

The helper should live close to the observed-budget persistence code so there is one authoritative update path.

### Source tagging

`source` is diagnostic only for this change.

It may be logged or surfaced later, but it must not affect aggregation behavior now. All exact observations are weighted equally by their real `chars` and `tokens`.

## Read Path

`resolveInputCharactersPerContextToken()` should change behavior:

1. if persisted observed totals exist, return the weighted ratio
2. otherwise return the bootstrap fallback

It should stop querying the status snapshot to derive chars-per-token.

Status server availability should no longer block or distort this calibration value.

## Integration Points

### Tokenize path

When `/tokenize` returns an exact token count for `content`, record:

- `chars = content.length`
- `tokens = exact tokenize result`

This is the cleanest calibration source and should always feed the weighted totals.

### Provider response path

When a provider response exposes exact prompt token counts for the exact prompt text that was sent, record:

- `chars = prompt.length`
- `tokens = exact prompt token count`

This applies only when the prompt token count corresponds to that exact prompt text. If the metric is ambiguous or inflated by unrelated cached context, it must not be recorded.

## Migration

The existing persisted row may contain:

- `observed_telemetry_seen = true`
- `last_known_chars_per_token = <old distorted value>`

but no weighted totals.

For this change:

- preserve backward compatibility for reading old rows
- treat rows without valid weighted totals as uninitialized for the new model
- fall back to bootstrap until the first exact observation is recorded

Do not seed the new weighted totals from the old aggregate-derived ratio.

## Risks

### Slow calibration after reset

If no exact observations occur yet, the system remains on bootstrap `2.5`. That is acceptable because it is still better than importing a distorted aggregate-derived ratio.

### Ambiguous provider metrics

Some provider prompt-token metrics may include cached or reconstructed context that does not correspond exactly to the current prompt text. Those paths must not record calibration data unless the mapping is exact.

### Unbounded historical weighting

A fully cumulative weighted average adapts slowly if workload characteristics change dramatically. That is acceptable for this change because the current problem is correctness, not short-term responsiveness.

## Testing Strategy

Add or update tests for:

- bootstrap fallback still returns `2.5` before any exact observation exists
- recording a `/tokenize` observation persists weighted totals and updates effective config
- recording a provider prompt-token observation persists weighted totals and updates effective config
- multiple observations produce a weighted average, not last-write-wins
- estimated token paths do not mutate observed-budget state
- legacy observed-budget rows without weighted totals do not seed the new model with the old ratio

## Implementation Outline

### Phase 1: Persistence

- extend `observed_budget_state`
- add normalization for weighted totals
- add the central exact-observation recorder

### Phase 2: Read behavior

- switch effective budget resolution to persisted weighted totals
- remove status-snapshot-derived chars-per-token calibration

### Phase 3: Producers

- wire `/tokenize` exact counts into the recorder
- wire exact provider prompt-token counts into the recorder where the mapping is valid

### Phase 4: Tests

- add red tests for tokenize, provider, weighted averaging, and bootstrap behavior
- implement minimal code to pass
- rerun targeted config, provider, summary, and repo-search tests
