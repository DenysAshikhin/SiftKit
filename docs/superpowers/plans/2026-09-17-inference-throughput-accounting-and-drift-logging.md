# Inference Throughput Accounting and Drift Logging Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task when execution is requested. Steps use checkbox syntax. Do not start implementation merely because this plan exists.

**Goal:** Correct the understated decode rate and emit a nonfatal red server-log error whenever a comparable internally calculated or published PP/decode rate differs from Tabby's reported rate by more than 5%.

**Architecture:** Preserve backend generation counts, timing, and reported rates at the response boundary. Carry one schema-defined throughput record through operation accounting, persistence, and presentation. Use shared calculation and audit functions at request completion and publication, including checks after operation-specific transformations.

**Tech stack:** TypeScript, Zod, Node HTTP/SSE, SQLite, existing server logger, React dashboard, repository Node test harness.

**Spec:** The user requirements, decisions, and acceptance criteria below are the design specification for this plan. This document is a proposal; no implementation or deployment is authorized by its creation.

## Constraints

- No implementation changes during plan preparation. No SiftKit retrieval, summary, or implementation tools.
- No worktrees or commits. Preserve the existing uncommitted inference-run flush work and its tests.
- TypeScript only for new implementation, tests, and diagnostic tooling. Runtime schemas own boundary types; derive types with `z.infer`. No assertions, non-null assertions, `any`, duplicated schema definitions, or dynamic function dependencies.
- Replace the old throughput calculation everywhere it is used as PP/decode. Do not leave a compatibility calculation that reconstructs generated tokens from visible text.
- Keep visible answer, thinking, tool-result, prompt-budget, and compression accounting semantically distinct from model throughput. A tool result is input to a later request; a generated tool call is model output.
- Use TDD and isolated fake-backend tests before real-model validation. Real-model runs must be sequential and start only with the inference slot idle.
- Keep diagnostic artifacts in one scratch directory and remove it after retaining the required results. Do not modify the production model, engine installation, preset, or environment as part of this telemetry implementation.

## Evidence and intended result

The September 17 investigation matched every one of 15 planner responses in run `f8d145b1-8d16-49d4-b574-19a9cb7e9622` to a Tabby completion:

| Quantity | Existing application accounting | Backend evidence |
|---|---:|---:|
| Generated tokens | 19,650 | 28,036 |
| Generation duration | 1,189.48 s | Same request cohort |
| Decode rate | 16.5198 tok/s | 23.5700 tok/s from emitted tokens/time |
| Processed prompt tokens | 35,414 | 35,414 |
| Cached prompt tokens | 251,392 | 251,392 |
| Prefill duration | 48.73 s | 48.73 s |
| PP rate | 726.7392 tok/s | 726.7392 tok/s |

Root cause and additional consumers found during planning:

- `src/llm-protocol/live-content-classifier.ts:11` makes `text` the narration projection, excluding generated tool-control text.
- `src/repo-search/planner-protocol.ts:558` forwards timings but drops the provider completion count and reported rates.
- `src/repo-search/engine/token-usage.ts:92` recounts projected text and thinking; line 110 retains the full generation duration.
- `src/status-server/chat-run-recorder.ts:458` divides those incomplete output totals by the full duration.
- `dashboard/src/lib/format.ts:282` reconstructs duration from projected token counts and an existing rate when calculating session averages.
- `dashboard/src/tabs/BenchmarkTab.tsx:63` arithmetically averages PP/decode rates across attempts instead of weighting their respective processing durations.
- `src/status-server/idle-summary.ts:300` divides output tokens by whole-request time, then presents the result as generation speed.
- `src/summary/request-runner.ts` omits prefill/decode durations from terminal metadata; `src/status-server/status-run-log.ts:108` writes null durations.
- `src/status-server/server-logger.ts` already implements red error bodies, including at quiet log level. Its warning level is yellow and suppressed at quiet level.

Correcting accounting is expected to change the displayed 16.52 to approximately 23.57 for an equivalent complete request cohort. It does not itself increase kernel decode throughput or establish why direct `perf.py` can reach 25–30 tok/s.

## Decisions and semantics

### Counts, clocks, and independent references

- **Generated tokens:** the raw Tabby `usage.completion_tokens`, including reasoning, narration, tool-call markup/arguments, and other emitted control tokens. Do not subtract reasoning or add accepted drafts again. Rejected draft tokens are excluded.
- **Processed prompt tokens:** `usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens`. Include tokens from tools, templates, reasoning history, and images when Tabby includes them. Cached tokens are not newly processed tokens.
- **PP duration:** `usage.prompt_time` converted once from seconds to milliseconds.
- **Decode duration:** `usage.completion_time` converted once from seconds to milliseconds.
- **Independent reference rates:** `usage.prompt_tokens_per_sec` and `usage.completion_tokens_per_sec`. Preserve these fields rather than reconstructing the reference from the same internal counts under audit.
- Wall time, lock wait, tool execution, tokenization, browser rendering, and network receipt time must not replace backend PP/decode duration. Keep existing wall-time metrics under their own names.
- Audit PP and decode independently. Never compare one request's internal rate with another request's Tabby rate, or compare a whole operation with only its final model call.

For a single comparable metric:

```text
internal_rate = token_count / (duration_ms / 1000)
relative_error = abs(internal_rate - tabby_reported_rate) / abs(tabby_reported_rate)
emit_error = relative_error > 0.05
```

Compare before display rounding. Exactly 5% is allowed. Both underreporting and overreporting trigger the same error.

For multiple requests, sum token counts and durations. Compute the independent reference with duration weighting:

```text
internal_rate = sum(internal_tokens) / sum(internal_seconds)
tabby_reference = sum(tabby_reported_rate * tabby_seconds) / sum(tabby_seconds)
```

Maintain separate PP and decode weights. Do not average rates arithmetically. Preserve backend reference durations independently so a later internal duration error remains detectable. Parallel requests still use summed model processing time for this metric; operation wall throughput is a different quantity.

### Coverage and incomplete measurements

- A physical HTTP request is counted once. Repeated cumulative usage frames replace the previous observation; they are not added together.
- Each retry and thinking-budget continuation has its own request identity. Audit complete physical requests individually, then combine their observations for the corresponding logical request.
- Never claim an aggregate is fully comparable when one of its contributing requests lacks required internal or reference data. Do not silently publish a rate for only the measured subset under a whole-operation label.
- A successfully completed SiftKit-managed Tabby request is expected to supply usage. Missing or malformed required telemetry produces one nonfatal red `throughput_unverifiable` event identifying the missing fields; it is not a successful comparison.
- Cancellation, connection failure, or a deliberate early stop before final usage produces explicitly incomplete telemetry. Keep any known counts; publish no authoritative aggregate rate for that incomplete cohort. Record the reason without inventing a percentage discrepancy.
- An explicitly disabled usage response on a transparent passthrough request is uncomparable, not a fabricated zero. Do not change the caller's response contract just to obtain usage.
- Zero internal and reference rates agree. A positive internal rate against an explicit zero reference emits an error with `reason=zero_reference` and no fabricated percentage. Invalid/zero durations cannot be used as divisors. Tabby's `Indeterminate` rate is unavailable, not numeric zero.
- Deterministic operations that never invoke a model and explicit mock providers have no Tabby comparison. A model name alone must not disable auditing.

### Logging

Use `serverLogger.error`, not an exception that aborts generation. The operation may complete successfully with a telemetry error.

Example, shown without ANSI escapes:

```text
09:42:10  inference f8d145b1  throughput_mismatch  operation=repo-agent stage=planner_action scope=published metric=decode internal=16.5198 tabby=23.5700 delta_pct=-29.91 threshold_pct=5 generated_tokens=19650 duration_ms=1189480 model=td_flash-next_4.05bpw_h6_ng6
```

Include operation ID, physical request ID or aggregate identity, original operation type, stage, model/preset, metric, both rates, signed discrepancy, internal count/duration, and backend reference duration. Do not log prompts, generated text, tool arguments, credentials, or images.

Emit once per metric and audit scope for a completed observation. Request and publication audits are distinct; SSE retransmission, multiple dashboard subscribers, and replay must not duplicate a publication warning. Use existing operation/terminal-event ownership rather than an unbounded global deduplication cache.

Error event and body are red in a color-enabled terminal, using the existing logger's ANSI reset behavior. Preserve `NO_COLOR` and plain redirected logs; severity and event text remain visible there. The error must appear at quiet, normal, and debug levels.

### Scope matrix

| Entry point / stage | Required accounting and audit boundary |
|---|---|
| Chat, plan, repo-search, repo-agent; CLI and WebUI | Shared inference response, planner response accounting, operation completion, published chat/run rates |
| Tool approval model calls | Audit their own request; keep their rates/counts/durations in the same explicitly identified cohort if included in operation totals |
| Context compaction, manual condensation, terminal synthesis | Audit each physical attempt, including completed attempts subsequently rejected by the operation |
| Summary, leaf/merge work, planner summaries, structured-output retries | Preserve every model observation through core result, terminal metadata, artifacts, and aggregate metrics |
| Assistant text/image extraction | Audit before `DefaultAssistantInferenceClient.complete` discards usage from its public result |
| Image caption and evaluation operations | Use the shared inference boundary with explicit operation/stage identity; cover their final metric consumer when present |
| Benchmark attempts and matrix runs | Consume corrected persisted measurements; audit the published attempt/aggregate rate |
| Transparent inference passthrough | Observe returned usage without altering the byte stream; audit internal rates when usage exists; do not claim to audit an external client's private calculations |
| Session averages, Metrics tab, idle summary | Sum canonical model counts/times; compare only matching backend reference cohorts; the server publishes audited rates and the browser formats them |

The CLI summary already calls `StatusServerApiClient.requestSummary`; execution occurs in `routes/operations.ts`. Repo operations and assistant inference also execute in the server. Reuse these boundaries so warnings reach the server console; do not introduce a separate diagnostic HTTP service.

## Shared interfaces

Create `packages/contracts/src/inference-throughput.ts` as the sole schema owner. Reuse its types in protocol, scorecard, status, database, and dashboard contracts.

The proposed record uses constant-size aggregates. Where a request/run completion event already exists, augment it with the raw numeric observation; do not add ordinary console lines for every successful check or an ever-growing observation array in lifetime metrics:

```ts
import { z } from 'zod';

const NonNegativeFiniteSchema = z.number().finite().nonnegative();
export const ThroughputMetricSchema = z.strictObject({
  tokenCount: z.number().int().nonnegative().nullable(),
  durationMs: NonNegativeFiniteSchema.nullable(),
  tabbyWeightedTokens: NonNegativeFiniteSchema.nullable(),
  tabbyDurationMs: NonNegativeFiniteSchema.nullable(),
  requestCount: z.number().int().nonnegative(),
  missingInternalRequests: z.number().int().nonnegative(),
  missingTabbyRequests: z.number().int().nonnegative(),
});
export const InferenceThroughputSchema = z.strictObject({
  pp: ThroughputMetricSchema,
  decode: ThroughputMetricSchema,
});
export type ThroughputMetric = z.infer<typeof ThroughputMetricSchema>;
export type InferenceThroughput = z.infer<typeof InferenceThroughputSchema>;
```

For one request, `tabbyWeightedTokens = reported_rate * backend_duration_ms / 1000`. This is a floating-point reference weight, not an emitted-token count. A fold adds known values and missing-request counters; a rate is comparable only when the corresponding missing counters are zero and its denominator is valid. An empty fold has zero requests and publishes null rates. An incomplete fold retains the known subtotal but never presents it as a complete cohort.

Create `src/lib/inference-throughput.ts` with these public functions, all types inferred from schemas:

```ts
readTabbyThroughput(body: JsonValue): InferenceThroughput;
mergeInferenceThroughput(values: readonly InferenceThroughput[]): InferenceThroughput;
calculateThroughputRate(metric: ThroughputMetric): number | null;
calculateTabbyReferenceRate(metric: ThroughputMetric): number | null;
compareThroughputRate(internalRate: number | null, tabbyRate: number | null): ThroughputComparison;
```

Define `ThroughputComparisonSchema` in the shared contract with discriminated outcomes `match`, `mismatch`, and `unverifiable`; include the two rates, nullable signed percentage, and a reason for zero/unavailable references. Define a schema for audit context containing operation type/ID, request ID, stage, model/preset, and audit scope. Move the existing five-value `RunOperationTypeSchema` unchanged into `packages/contracts/src/operation-types.ts`, update its imports/exports, and extend it only for assistant, passthrough, and evaluation observations. This avoids a runtime import cycle when `runs.ts` imports the new throughput schema; do not duplicate the enum or leave an old definition.

An aggregate spanning multiple models keeps the per-request identities in its source events and labels its own model/preset as mixed. Its reference uses precisely the same constituent requests, rather than one selected model's rate. No new model-indexed metrics store is needed.

Create `src/status-server/inference-throughput-audit.ts` with `auditInferenceThroughput(context, throughput, publishedRates)`. It uses the shared comparator and existing `serverLogger.error`. `publishedRates` must be the actual PP/decode values about to leave that consumer; checking only the pristine backend observation would miss the original bug. Physical-request normalization and post-transformation publication both call the same audit implementation with distinct scopes. Keep the dependencies concrete; do not introduce callback-based sink selection.

## Task 1: Preserve complete backend measurements and define comparison semantics

**Create:** `packages/contracts/src/inference-throughput.ts`, `packages/contracts/src/operation-types.ts`, `src/lib/inference-throughput.ts`, `tests/inference-throughput.test.ts`.

**Modify:** `packages/contracts/src/index.ts`, `packages/contracts/src/runs.ts`, `src/lib/provider-helpers.ts`, `src/llm-protocol/types.ts`, `src/llm-protocol/inference-client.ts`.

**Tests:** `tests/provider-helpers.test.ts`, `tests/llm-protocol-streaming.test.ts`, `tests/inference-client-thinking-budget.test.ts`.

**Produces:** The shared schemas/functions above and a required `throughput` field on normalized inference usage. Migrate normalized usage construction to schema-derived types rather than adding another manually duplicated type.

- [x] Add failing tests for raw completion counts containing reasoning/tool calls, cached prompts, final streaming usage, and distinct backend-reported rates. Existing token attribution must not overwrite the raw generation count.
- [x] Add threshold tests using Tabby rate 20: internal 19 and 21 pass; 18.99 and 21.01 mismatch. Cover null, `Indeterminate`, zero, non-finite/negative values, invalid durations, and both discrepancy directions.
- [x] Add weighted-rollup tests: rates 10 for 1 second and 30 for 3 seconds yield reference 25, not 20. Independently alter internal duration and assert the reference does not change.
- [x] Run the new tests and confirm failures are caused by missing behavior.
- [x] Implement the schemas and functions. Capture response identity and the original reported rates before normalized/visible-content transformations. Seconds are converted once.
- [x] Replace cumulative SSE observations; merge distinct physical requests/continuations exactly once. Never add all `usage` frames. Preserve incomplete coverage across a stopped first request and a successful continuation.
- [x] Make audit context explicit at physical inference entry points. Update every caller/fixture required by the changed interface; no default fake operation identity for real requests.
- [x] Run the focused suite and typecheck the affected contracts/protocol. Confirm streaming, cancellation, and retry behavior still pass.

Suggested boundary regression:

```ts
const metric = readTabbyThroughput({ usage: {
  prompt_tokens: 3365, prompt_tokens_details: { cached_tokens: 0 },
  prompt_time: 3.88, prompt_tokens_per_sec: 867.27,
  completion_tokens: 754, completion_time: 35.07,
  completion_tokens_per_sec: 21.5,
} });
assert.equal(metric.decode.tokenCount, 754);
assert.equal(metric.pp.tokenCount, 3365);
assert.equal(compareThroughputRate(398 / 35.07, 21.5).kind, 'mismatch');
```

## Task 2: Fix operation accounting after content projection

**Modify:** `src/repo-search/planner-protocol.ts`, `src/repo-search/engine/token-usage.ts`, `src/repo-search/engine/task-loop.ts`, `src/repo-search/engine/task-loop-support.ts`, `src/repo-search/engine/terminal-synthesizer.ts`, `src/repo-search/engine/transcript-compactor.ts`, `src/repo-search/engine.ts`, `src/repo-search/scorecard.ts`, `src/repo-search/types.ts`, `src/repo-search/execute.ts`.

**Tests:** `tests/engine-token-usage.test.ts`, `tests/repo-search-planner-protocol.test.ts`, `tests/tabby-usage-metrics.e2e.test.ts`, `tests/token-usage-records.test.ts`.

**Consumes:** Normalized `usage.throughput` from Task 1.

**Produces:** `throughput` on planner responses, token-usage snapshots, task scorecards, and operation totals. Existing visible output/thinking/tool-result counts retain their documented attribution role.

- [x] Reproduce a tool-only answer: Tabby generates tool-call tokens while narration is empty. Assert positive decode throughput and a correct full emitted-token count.
- [x] Reproduce a mixed reasoning/narration/tool-call answer, and a terminal answer delivered through a tool. Assert no tokens are lost or counted twice in throughput.
- [x] Preserve `throughput` through the planner adapter. Accumulate it when recording the model response, once per request, independently of `addOutputTokens` and content classification.
- [x] Remove throughput dependence on retokenized narration/thinking. Retokenization may remain where needed for visible-text or prompt-budget attribution; it is not throughput evidence.
- [x] Include measured compaction, synthesis, and successful-but-rejected attempts in the same count/time cohort used by the operation. Audit approval requests separately; if operation totals include them, include both their counters and durations, never just one side.
- [x] Replace scorecard throughput totals with the canonical fold; preserve original operation/stage identity across collapsed dashboard/status groups.
- [x] Add the numerical regression `28036 / 1189.48 = 23.5699633453`, while attributed visible+thinking tokens remain 19,650. Assert the PP regression remains `35414 / 48.73 = 726.7391750462`.
- [x] Run the focused operation tests. Reject changes that fix only plain answers while tool-only and mixed turns remain wrong.

## Task 3: Carry telemetry through every remaining operation and add red audits

**Create:** `src/status-server/inference-throughput-audit.ts`, `tests/inference-throughput-audit.test.ts`, `tests/inference-throughput-operations.e2e.test.ts`.

**Modify:** `src/llm-protocol/inference-client.ts`, `src/providers/inference.ts`, `src/summary/provider-invoke.ts`, `src/summary/core-runner.ts`, `src/summary/request-runner.ts`, `src/summary/planner/agent-loop-adapter.ts`, `src/summary/planner/mode.ts`, `src/assistant/inference/client.ts`, `src/status-server/routes/operations.ts`, `src/status-server/routes/chat.ts`, `src/status-server/routes/chat-image-caption.ts`, `src/status-server/routes/inference-passthrough.ts`.

**Tests:** `tests/server-logger.test.ts`, `tests/assistant-inference-client.test.ts`, `tests/summary-request-runner.test.ts`, `tests/inference-passthrough-status-server.test.ts`.

**Consumes:** Shared measurements, comparison functions, and explicit audit context.

**Produces:** Request-level audits for all scope-matrix rows, including model calls that do not publish a dashboard rate.

- [x] Write a failing server test with consistent raw Tabby usage followed by a deliberately wrong internal/publication calculation. It must emit a red error; a checker only inside the HTTP parser cannot satisfy this test.
- [x] Implement the audit with `serverLogger.error`, keeping existing color/no-color behavior and quiet-level visibility. Test the ANSI red prefix and reset when color is enabled, and readable plain output when disabled.
- [x] Invoke request audits once after final usage/normalization; pass actual calculated rates. Preserve their independent reference for later publication audits. Log telemetry errors without throwing into the model/tool execution path.
- [x] Carry measurements through summary retry/chunk/merge results and terminal metadata. Accumulate all attempted model work instead of retaining only the latest response's metrics.
- [x] Audit assistant text and image inference before its reduced result drops usage. Migrate every remaining `InferenceClient.chat` caller to explicit identity; an omitted real-operation context must fail typecheck or runtime validation.
- [x] Use the shared SSE parser for a passive, bounded passthrough usage observer. Preserve existing streaming/backpressure and cancellation, raw response bytes, caller authorization, and usage opt-in behavior. Inspect complete JSON responses when the caller uses non-streaming mode. Do not buffer a complete answer or retokenize every delta.
- [x] Test PP-only, decode-only, and simultaneous mismatches across summary, chat, plan, repo-search, repo-agent, assistant, evaluation, and passthrough. Include physical retries and continuation IDs.
- [x] Verify multiple SSE subscribers, duplicate final usage frames, and replay do not repeat the same publication event. Verify request and aggregate audit scopes remain distinguishable.
- [x] Run focused suites. Confirm the server console receives CLI-originated warnings through the existing server execution routes.

Example log assertion using the existing concrete logger test pattern:

```ts
assert.match(serverOutput, /throughput_mismatch/);
assert.match(serverOutput, /metric=decode/);
assert.match(serverOutput, /\u001b\[31m/);
assert.match(serverOutput, /\u001b\[0m/);
assert.equal(operationResult.status, 'completed');
```

## Task 4: Persist canonical measurements and replace all published rate calculations

**Create:** `src/state/schema-upgrades/inference-throughput.ts`, `tests/runtime-db-schema-inference-throughput.test.ts`.

**Modify — contracts/storage:** `packages/contracts/src/chat.ts`, `packages/contracts/src/chat-projection.ts`, `packages/contracts/src/runs.ts`, `packages/contracts/src/benchmark.ts`, `packages/contracts/src/metrics.ts`, `packages/contracts/src/idle-summary.ts`, `src/state/runtime-schema.ts`, `src/state/runtime-db.ts`, `src/state/chat-sessions.ts`, `src/state/chat-journal-schema.ts`, `src/state/status-artifacts.ts`, `src/state/dashboard-benchmark.ts`, `src/status-server/dashboard-runs/types.ts`, `src/status-server/dashboard-runs/artifact-upserts.ts`, `src/status-server/dashboard-runs/run-records.ts`, `src/status-server/repo-search-scorecard-types.ts`.

**Modify — publishers:** `src/config/status-backend.ts`, `src/status-server/status-file.ts`, `src/status-server/status-run-log.ts`, `src/status-server/terminal-metadata.ts`, `src/status-server/metrics.ts`, `src/status-server/idle-summary.ts`, `src/status-server/chat-run-recorder.ts`, `src/status-server/chat-turn-telemetry.ts`, `src/status-server/chat-projection-encoder.ts`, `src/status-server/dashboard-benchmark-runner.ts`, `src/lib/telemetry-metrics.ts`, `dashboard/src/lib/format.ts`, `dashboard/src/components/ChatStatsBar.tsx`, `dashboard/src/tabs/BenchmarkTab.tsx`, `dashboard/src/tabs/MetricsTab.tsx`.

**Tests:** `tests/chat-run-recorder.test.ts`, `tests/chat-persist-token-parity.test.ts`, `tests/chat-journal.test.ts`, `tests/status-file-deferred-artifacts.test.ts`, `tests/terminal-metadata-drain.test.ts`, `tests/runtime-status-server.idle-summary.test.ts`, `tests/dashboard-benchmark.test.ts`, `dashboard/tests/lib/format.test.ts`, `dashboard/tests/chat-stats-bar.test.tsx`, `dashboard/tests/benchmark-tab.test.tsx`.

**Produces:** Identical corrected rates in completed answers, stored runs, reconnect/replay, benchmarks, session averages, and idle/metrics generation displays.

- [x] Add failing persistence/reload and session-average tests with different tool-call proportions across two turns. A reconstruction using filtered counts must fail.
- [x] Add nullable `throughput_json` columns to `run_logs`, `chat_messages`, `benchmark_attempts`, `runtime_metrics_totals`, and `idle_summary_snapshots`. Parse with the shared schema. Add `throughput: InferenceThroughput | null` to corresponding contracts; null explicitly means historical/unrecorded data, not a signal to use the old formula.
- [x] Implement the atomic schema upgrade from current version 72 to 73, with fresh-bootstrap parity and rollback tests. Recheck the version immediately before implementation if concurrent work has advanced it; never overwrite another upgrade.
- [x] Migrate stored nested chat/run/status representations affected by the new required field, including archived/baseline chat messages and journal presentation payloads. Use the existing versioned upgrade mechanism, update payload digests/checkpoints when required, and reject missed migrations. Do not add a second old-event parser.
- [x] Preserve historical text and counters. Historical records without provable backend telemetry expose unavailable authoritative rates and are excluded from comparable aggregates. Do not guess missing tool-call tokens or rewrite old counts using today's model tokenizer. Do not replay historical records as new runtime warnings.
- [x] Carry summary prefill/decode timing and canonical throughput through terminal/deferred metadata and artifact upserts. Do not let a partial status write overwrite complete backend telemetry already persisted by the operation.
- [x] Build chat/run/benchmark rates from canonical counts and duration. Keep existing response rate field names where their meaning remains correct, but make them derived projections rather than independent accumulators.
- [x] Preserve attempt measurements in `benchmark_attempts` and compute benchmark session PP/decode aggregates on the server using duration weighting. Publish these in the benchmark session contract and remove the browser's arithmetic averaging of those two rates. Leave separately defined quality/overall-completion metrics under their own semantics.
- [x] Replace session-average duration reconstruction with direct sums from canonical records on the server. Add `buildChatSessionThroughput` to `src/status-server/chat-turn-telemetry.ts`; use it at session snapshot/completed-turn projection boundaries and send audited session PP/decode values in the session contract. Count a completed operation once; do not add its internal thinking/tool bubbles again.
- [x] Replace idle-summary/Metrics-tab generation speed based on `outputTokens / requestDurationMs` with canonical decode throughput. Keep overall wall/request metrics distinct. Preserve exact request-cohort matching and incomplete-coverage semantics across models.
- [x] Audit actual rates at the owning server publication boundaries before terminal persistence/emission. The dashboard formats server-owned last-turn, session, benchmark, and idle rates; remove independent browser PP/decode arithmetic. Do not add an endpoint that sends client-rendered rates back for comparison.
- [x] Remove the obsolete three-argument decode helper/formula from all PP/decode consumers and migrate callers/tests. Retain separately named attribution helpers only where they serve a different documented metric.
- [x] Run database upgrade/replay, chat, benchmark, metrics, and dashboard suites. Confirm fresh and upgraded databases return the same telemetry shape.

## Task 5: Prove complete operation coverage and absence of measurement overhead

**Modify:** `tests/inference-throughput-operations.e2e.test.ts`, `tests/tabby-usage-metrics.e2e.test.ts`, `tests/inference-throughput-audit.test.ts`, the existing operation harnesses used by those tests.

**Consumes:** Tasks 1–4, including publication audits and persisted references.

- [x] Drive the real server routes against an isolated fake Tabby server, using CLI API-client entry points and dashboard routes. Exercise every scope-matrix operation; stub destructive tools rather than executing them.
- [x] Supply a correct usage record but return enough generated tool-call tokens to reproduce the original dropped-count behavior. Assert both corrected persisted/public rates and zero mismatch errors after the fix.
- [x] Inject a fault after response normalization, separately changing internal token count, duration, published rate, and aggregate membership. Assert a red mismatch for both PP and decode when the discrepancy exceeds 5%. This is the required proof that the watchdog can catch downstream corruption.
- [x] Cover 5% equality, over/under boundaries, one-frame and fragmented SSE, final usage after finish_reason, repeated cumulative usage, reasoning on/off, tool-only output, images, empty output, cache hits, cancellation, missing usage, and a partial-plus-complete continuation.
- [x] Verify raw draft acceptance/rejection counters do not inflate emitted-token throughput. Verify tool outputs, approval wall time, and queue wait cannot leak into the wrong numerator or denominator.
- [x] Verify no per-token log calls, no extra tokenization or inference requests, bounded SSE observation, and no added synchronous database writes in the token loop. Compare identical fake-stream workloads with the audit active; use call-count/allocation bounds as the deterministic gate, not a flaky wall-clock unit assertion.
- [x] Run the relevant suites followed by the full applicable validation commands below. Fix real failures without weakening valid tests.

## Task 6: Validate against Tabby and characterize any remaining real decode gap

**Create:** `scripts/verify-inference-throughput.ts`, `tests/inference-throughput-validation.test.ts`, and `docs/analysis/2026-09-17-inference-throughput-validation.md` during implementation, not during plan preparation.

**Tests:** `tests/inference-throughput-validation.test.ts` for schema parsing, cohort matching, abort handling, and refusal to benchmark a busy slot.

- [x] Implement a TypeScript HTTP validation harness that records request identity, preset/model, workload, emitted tokens, cached/processed tokens, backend durations, backend rates, and published internal rates. Parse all IO. Keep text and credentials out of the result artifact.
- [x] Use an isolated fake server to prove the harness detects >5% drift and records a busy/timeout run as unverified rather than as a throughput result.
- [x] With the real engine idle, run sequential fresh and cached text requests, a long generated tool-call response, a reasoning response, and one multi-turn operation. Exercise summary, chat, plan, repo-search, repo-agent, assistant, and benchmark paths with benign workloads. Ensure real token counts, not requested maxima, form the results.
- [x] Run three repetitions of comparable workloads. Compare each internal PP/decode measurement with its corresponding Tabby reference and require no unexplained >5% discrepancy. Preserve all results; do not discard slow repetitions.
- [x] Separately compare direct Tabby and SiftKit with identical payload/sampling/context. Measure backend decode, observed stream delivery, and total wall time independently. Profile a repeatable delivery deficit instead of attributing it to GPU kernels.
- [ ] Compare with the existing `eval/perf.py` only in a separate idle window with the managed model cleanly unloaded. Match model, installed engine, allocator/environment, CPU expert split/thread count, KV cache, context capacity, chunk size, n-gram placement, and speculation settings. Record the actual commands and restore the prior resident preset after the control run. Do not run two copies of this model simultaneously.
- [x] Do not treat direct forward passes on a fixed WikiText token stream as the same workload as sampled generation. Record sampling, paged-cache/checkpoint, and workload differences when interpreting the remaining 23.57 versus 25–30 gap.
- [ ] If a repeatable real execution deficit remains, report its measured size and the layer responsible when established. This plan does not authorize an unmeasured engine patch or a speculative change to `EXL3_MOE_STREAM_T`, MTP, context, or CPU offload. A kernel/serving optimization needs its own evidence-based change definition.
- [x] Record validation limits, remove the scratch directory, and leave the production preset/environment unchanged.

## Validation commands for execution

Use the existing compiled test runner so live-instance guards remain enabled. Rebuild test artifacts after editing their inputs. These are future execution commands; none are run merely to prepare this plan.

```powershell
npm run build:test
npm test -- inference-throughput provider-helpers llm-protocol-streaming inference-client-thinking-budget
npm test -- engine-token-usage repo-search-planner-protocol tabby-usage-metrics token-usage-records
npm test -- server-logger assistant-inference-client summary-request-runner inference-passthrough-status-server
npm test -- runtime-db-schema-inference-throughput chat-run-recorder chat-persist-token-parity chat-journal status-file-deferred-artifacts terminal-metadata-drain dashboard-benchmark
npm test -- --dashboard
npm test
npm run typecheck
npm run lint
```

Capture large output in the single scratch directory and inspect exit codes plus narrowly selected failure diagnostics; do not route it through SiftKit. Typecheck currently also invokes lint; the explicit lint command satisfies the repository's completion check. Do not claim live validation from the fake-backend suites.

## Completion criteria

- [x] Generated tool calls and reasoning contribute exactly once to decode throughput; the 28,036-token regression passes.
- [x] PP preserves Tabby's processed-token and duration semantics; the 35,414-token regression passes.
- [x] Every operation and internal model stage in the matrix is covered; missing identity/telemetry cannot silently disable the check.
- [x] A >5% error in either direction produces a nonfatal red server-log error, including at quiet log level; exactly 5% does not.
- [x] Faults introduced after normalization and during aggregation/publication are detected.
- [x] No plain average of rates, filtered-text reconstruction, wall-time-as-decode formula, duplicate SSE accumulation, or mismatched request cohort remains in a PP/decode reporting path.
- [x] Restart/replay, session averages, benchmarks, and idle metrics use the same canonical measurements; historic unknowns remain explicitly unknown.
- [x] All appropriate tests, typecheck, and lint pass. Real-model verification either passes with retained evidence or is explicitly reported as unverified with its blocking condition.
- [x] No production engine tuning, unrelated edits, worktrees, or commits were introduced.

## Plan review

The design deliberately adds a shared schema, pure arithmetic, and a thin server-log audit. It reuses existing operation ownership, HTTP/SSE parsing, persistence upgrades, and logger coloring. It does not add a telemetry service, per-token logging, arbitrary threshold settings, or model-specific exceptions. The residual kernel/serving speed gap is a measured validation question, not a promised throughput improvement from correcting a counter.
