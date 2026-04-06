# `unknown` Type Audit

Generated: 2026-04-05. Covers 222 `unknown` occurrences across 50 `.ts` files in `src/`.

**TL;DR**: About 85% of `unknown` usages are **structurally required** (error handling, validation boundaries, JSON parsing). The remaining ~15% are return types on public API functions where a more specific shape could be defined. Most of the seemingly-loose dictionary types are actually `Record<string, unknown>` — a type alias for "plain JSON-ish object" — which is a valid typing choice for config/message-passing boundaries.

## Categorization

### Category A — Error handling (REQUIRED by TypeScript strict mode) — ~22 sites

TypeScript's `useUnknownInCatchVariables` + thrown-value semantics mean any caught error is typed `unknown`. Same applies to rejection callbacks.

- `src/lib/errors.ts:1` — `getErrorMessage(error: unknown)` — central error coercer
- `src/benchmark.ts:11`, `src/benchmark-matrix.ts:17`, `src/llama-cpp-bridge.ts:97` — top-level `.catch((error: unknown) => ...)`
- `src/benchmark/runner.ts:43` — `let fatalException: unknown = null`
- `src/benchmark-matrix/runner.ts:82-83` — `let capturedError / restoreError: unknown = null`
- `src/benchmark/interrupt.ts:8,75,91` — Promise reject callback, `isTimeoutError(error: unknown)`
- `src/benchmark-matrix/interrupt.ts:9` — Promise reject callback
- `src/providers/llama-cpp.ts:244` — `const rejectOnce = (error: unknown)`
- `src/status-server/index.ts:1740,2181` — Promise reject + `.catch((error: unknown) => ...)`
- `src/lib/fs.ts:14,26` — `isRetryableFsError(error: unknown)`, `let lastError: unknown`
- `src/status-server/http-utils.ts:147,167` — `let lastError: unknown`, `(error as { code?: unknown }).code`

**Verdict: Cannot tighten.** TS strict-mode requirement + fs error code lookup is inherently untyped (no Node type for all ENOENT/EPERM/EACCES/EBUSY string values).

---

### Category B — Runtime input validation / coercion (REQUIRED by design) — ~60 sites

These functions exist precisely to accept arbitrary input and narrow it. Typing the parameter tighter would defeat their purpose.

**Config / state normalizers:**
- `src/status-server/config-store.ts:105,109,119,143,263,268,282,296,301` — `normalizeWindowsPath`, `isLegacyManagedStartupScriptPath`, `mergeConfig`, `normalizeConfig`, `getFinitePositiveInteger`, `getManagedStartupTimeoutMs`, `getCompatRuntimeLlamaCpp`, `getLlamaBaseUrl`, `getManagedLlamaConfig`
- `src/status-server/metrics.ts:36` — `normalizeMetrics(input: unknown)`
- `src/status-server/status-file.ts:11,42` — `normalizeStatusText`, `parseBooleanLikeStatus`
- `src/status-server/idle-summary.ts:117,193` — `normalizeSqlNumber`, `normalizeIdleSummarySnapshotRowNumber`
- `src/state/observed-budget.ts:20` — `normalizeObservedBudgetState`
- `src/state/chat-sessions.ts:10` — `estimateTokenCount(value: unknown)`
- `src/config/normalization.ts:18` — `isLegacyManagedStartupScriptPath`
- `src/config/getters.ts:12` — `getFinitePositiveNumber`

**Formatting coercers** (accept any value, produce display string):
- `src/status-server/formatting.ts:31,51,58,65,72,79,86` — `formatGroupedNumber`, `formatInteger`, `formatMilliseconds`, `formatSeconds`, `formatPercentage`, `formatRatio`, `formatTokensPerSecond`

**Provider response shape extractors** (llama.cpp response JSON has variable shape):
- `src/providers/llama-cpp.ts:131,476` — `getUsageValue`, `getPromptTimingValue`
- `src/status-server/index.ts:621,997,1021,1049,1073` — `getPromptCacheHitRate`, `getChatUsageValue`, `getThinkingTokensFromUsage`, `getPromptCacheTokensFromUsage`, `getPromptEvalTokensFromUsage`
- `src/status-server/index.ts:1548,1560,1465,1436` — `getScorecardTotal`, `truncateToolContextOutput`, `truncatePlanEvidence`, `buildPlanRequestPrompt`

**Repo-search scorecard extractors** (scorecard JSON is user-defined):
- `src/repo-search/scorecard.ts:1,6,8,20,24,28` — `getOutputCharacterCount`, `getNumericTotal`, nested access
- `src/summary/planner/json-filter.ts:9,14,20,42-44,97-98,140,143,170,175,240,247,269` — json-path helpers on arbitrary parsed JSON
- `src/summary/planner/tools.ts:36` — `getPlannerToolName(value: unknown)`

**CLI arg parsers:**
- `src/benchmark-matrix/args.ts:3,12,21,30,38,50` — `getRequiredString/Int/Double/OptionalInt/OptionalPositiveInt/OptionalBoolean`
- `src/cli/args.ts:229-230` — `formatPsList(value: unknown)` — formats arbitrary JSON for PowerShell output

**Status-server log formatters:**
- `src/status-server/index.ts:298` — `normalizeRepoSearchCommandForLog(command: unknown)`

**Verdict: Cannot tighten.** These are type-narrowing boundaries by design.

---

### Category C — JSON.parse boundaries — ~12 sites

`JSON.parse()` returns `any`; best practice is to cast to `unknown` and immediately narrow.

- `src/summary/structured.ts:47,49` — parse model response
- `src/summary/planner/parse.ts:11,13` — parse planner action
- `src/summary/planner/prompts.ts:26,32,40` — parse document profile
- `src/summary/planner/json-filter.ts:240,247,269` — parse JSON for filter tool
- `src/providers/llama-cpp.ts:323-336` — `parseToolArguments` (tool-call arguments come as string OR object)
- `src/cli/run-internal.ts:13-16` — `readRequestFile` returns parsed request JSON
- `src/lib/paths.ts:20` — parse `package.json` with unknown `name` field
- `src/state/chat-sessions.ts:47` — `(payload.hiddenToolContexts as unknown[])` — already parsed from JSON

**Verdict: Cannot tighten.** JSON input shape is inherently unknown until validated.

---

### Category D — Provider response types (externally-defined JSON) — ~12 sites

llama.cpp server response schemas vary across server versions; the fields are intentionally permissive.

- `src/providers/llama-cpp.ts:23-26` — tokenize response: `tokens?: unknown[]`, `count?: unknown`, `token_count?: unknown`, `n_tokens?: unknown`
- `src/providers/llama-cpp.ts:40,45,52,108,114` — tool-call `arguments?: unknown` (string | object)
- `src/providers/llama-cpp.ts:121` — planner-action payload `tools?: unknown[]`
- `src/providers/llama-cpp.ts:487` — chat request `tools?: unknown[]`

**Verdict: Cannot tighten.** External API contract intentionally loose.

---

### Category E — Dictionary / message-passing types — ~65 sites

These are `Record<string, unknown>` (dictionary type), NOT bare `unknown`. This is a common pattern for JSON-ish config/message objects where the schema is validated at runtime (not compile-time). Tightening these would require defining discriminated unions for every config shape — large upfront effort with marginal payoff.

**Config objects:**
- `src/benchmark-matrix/types.ts:130,133` — `ConfigRecord`, nested `LlamaCpp?`
- `src/benchmark-matrix/config-rpc.ts:21,23,26,33` — runtime config path walking
- `src/repo-search/types.ts:29` — `config?: Record<string, unknown>`
- `src/repo-search/execute.ts:23` — `config?: Record<string, unknown>`
- `src/config/normalization.ts:145,162,194` — legacy `Ollama?` field coercion
- `src/config/config-service.ts:67,73` — `setTopLevelConfigKey(key, value: unknown)`

**Log event / message types (varying shape per event kind):**
- `src/repo-search/logging.ts:49` — `write(event: Record<string, unknown>)`
- `src/repo-search/types.ts:3` — `JsonLogger.write(event: Record<string, unknown>)`
- `src/summary/artifacts.ts:43,46,52-53,67-68,103,215` — planner debug payloads, event recorder

**Planner tool I/O:**
- `src/summary/types.ts:77,94` — tool schema `properties: Record<string, unknown>`, `args: Record<string, unknown>`
- `src/summary/planner/tools.ts:133,202,218,222,238,261` — tool arg/result records, `matches: unknown[]`
- `src/summary/planner/formatters.ts:19,23,48` — `formatCompactJsonBlock(values: unknown[])`, `formatPlannerToolResultHeader`, `formatPlannerResult`
- `src/summary/planner/json-filter.ts:3,5,35,42,51,61,68-70,175` — record navigation
- `src/summary/planner/prompts.ts` — doc profile

**Result/response dicts:**
- `src/providers/llama-cpp.ts:323,328,336,427-428` — `parseToolArguments`, `getLlamaCppProviderStatus`
- `src/cli/run-repo-search.ts:36,51` — response scorecard shape
- `src/status-server/index.ts:2780-2781,2877-2878,2996-2997` — parsed request body arrays
- `src/status-server/index.ts:2856,2975,3101` — SSE payload serializers
- `src/status-server/index.ts:1534` — `missingSignals as unknown[]`
- `src/status-server/index.ts:1009` — multimodal message part
- `src/summary.ts:689,865` — planner tool result record

**Internal state types:**
- `src/status-server/index.ts:303-307` — repo-search progress event fields (each field validated individually)
- `src/state/jsonl-transcript.ts:3` — `Dict` type alias
- `src/state/chat-sessions.ts:5` — `Dict` type alias
- `src/status-server/idle-summary.ts:14,142` — `Dict`, `PRAGMA table_info` row
- `src/status-server/status-file.ts:4` — `Dict`
- `src/status-server/config-store.ts:5,240,314` — `Dict`, `VerboseArgs as unknown[]`
- `src/status-server/http-utils.ts:6,9,110` — `Dict`, `JsonResponse.body: unknown`, `sendJson(payload: unknown)`
- `src/status-server/metrics.ts:4` — `Dict`
- `src/status-server/index.ts:105,132,1661,1880` — `Dict`, `process as unknown as`, require() cast, "unknown" literal

**Verdict: These are valid "JSON-ish dictionary" types.** Tightening requires introducing full discriminated-union schemas for every message/event shape. Would roughly double the config/summary/planner typedefs with limited runtime safety gain (all values are still checked at runtime).

---

### Category F — CANDIDATES for tightening (return types on typed objects) — ~9 sites

These are functions returning `Record<string, unknown>` or `Promise<Record<string, unknown>>` where the actual returned object has a **fixed literal shape**. Replacing with a named interface is safe and adds call-site type safety. The results flow into `formatPsList` (which accepts `unknown` — no change there) so no other call sites need updating.

| Site | Current | Suggested |
| --- | --- | --- |
| `src/install.ts:65` `installSiftKit` | `Promise<Record<string, unknown>>` | `Promise<InstallSiftKitResult>` |
| `src/install.ts:98` `installCodexPolicy` | `Promise<Record<string, unknown>>` | `Promise<InstallCodexPolicyResult>` |
| `src/install.ts:130` `installShellIntegration` | `Promise<Record<string, unknown>>` | `Promise<InstallShellIntegrationResult>` |
| `src/cli/run-test.ts:5` `buildTestResult` | `Promise<Record<string, unknown>>` | `Promise<TestResult>` |
| `src/interactive.ts:18` `runInteractiveCapture` | `Promise<Record<string, unknown>>` | `Promise<InteractiveCaptureResult>` |
| `src/eval.ts:79,87` eval result | `Array<Record<string, unknown>>` | `Array<EvalCaseResult>` |

**Verdict: These can be tightened.** Recommend a small follow-up pass if you want them done.

---

### Category G — Intentional `unknown` at dispatch point — 1 site

- `src/cli/run-internal.ts:36` — `let result: unknown;` then `JSON.stringify(result)` — result is a union of ~14 different return types across a switch. A discriminated union would be accurate but verbose. Current usage is sound.

**Verdict: Fine as-is.** Could be changed to `Record<string, unknown> | SiftConfig | SummaryResult | ...` but that's worse than `unknown` for a write-then-serialize variable.

---

### Category H — Type-reshaping casts — ~8 sites

- `src/status-server/index.ts:132` — `process as unknown as { platform; kill }` — lets test code inject a mock process
- `src/status-server/index.ts:1661` — `require(modulePath) as { executeRepoSearchRequest?: unknown }` — dynamic require
- `src/types/better-sqlite3.d.ts:3-18` — better-sqlite3 ambient declarations (external library, can't narrow parameter types)
- `src/cli/args.ts:230` — `value as Record<string, unknown>` after `formatPsList` receives unknown
- `src/state/observed-budget.ts:26` — after `isObject` check, cast to `Record<string, unknown>`

**Verdict: Cannot tighten.** Cast-through-unknown is the standard pattern for test mocks + dynamic require.

---

### Category I — String literals (`'unknown'`) not types — 4 sites

These aren't TypeScript `unknown`, they're the string literal "unknown" used in log/display text.

- `src/summary.ts:1281-1282` — `request.backend || 'unknown'`
- `src/summary/prompt.ts:50,123` — `'Command exit code: unknown.'`, `'<unknown>'`
- `src/repo-search/execute.ts:104,131` — `scorecard?.verdict ?? 'unknown'`
- `src/status-server/index.ts:1880` — `Result: ${dumpOptions.result || 'unknown'}`
- `src/summary/planner/parse.ts:48` — `'Provider returned an unknown planner action.'`

**Verdict: Not types — no action.**

---

## Summary Counts

| Category | Sites | Tightenable? |
| --- | --- | --- |
| A — Error handling | ~22 | No (TS strict-mode requirement) |
| B — Input validation / coercion | ~60 | No (validation-boundary functions) |
| C — JSON.parse boundaries | ~12 | No (parse result is inherently untyped) |
| D — External API response shapes | ~12 | No (llama.cpp server contract) |
| E — `Record<string, unknown>` dictionary types | ~65 | Partially (massive schema work) |
| F — Return types on fixed-shape objects | ~9 | **YES (recommended)** |
| G — Switch-dispatch result | 1 | No (heterogeneous union) |
| H — Type-reshaping casts | ~8 | No (test mocks / dynamic require) |
| I — String literal `'unknown'` | ~6 | N/A (not types) |
| Noise (comments, `'unknown'` in strings) | rest | N/A |

## Recommended Actions

1. **Tighten Category F (9 sites)** — define `InstallSiftKitResult`, `InstallCodexPolicyResult`, `InstallShellIntegrationResult`, `TestResult`, `InteractiveCaptureResult`, `EvalCaseResult` interfaces. Small, safe, additive. Would replace 6 `Record<string, unknown>` return types.
2. **Leave Categories A, B, C, D, G, H as-is** — these are correct usages.
3. **Optionally revisit Category E** as a separate project: pick the highest-traffic `Record<string, unknown>` shapes (`ConfigRecord`, `SiftConfig`, `SummaryRequest`) and introduce discriminated unions. This is a large schema-design effort and should not be mixed with the current refactor.
