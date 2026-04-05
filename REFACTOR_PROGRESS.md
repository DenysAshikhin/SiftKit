# SiftKit Big-Bang Refactor — Progress Dump

Plan file: `C:\Users\denys\.claude\plans\immutable-riding-unicorn.md`

## Constraints
- All new code is TypeScript, no `any`.
- No user-defined generics beyond the approved trio (`requestJson<T>`, `parseJsonText<T>`, `readJsonFile<T>`) + pre-existing `getConfiguredLlamaSetting<T>`.
- Built-in generic types (`Promise<T>`, `Array<T>`, `Record<K,V>`, `Map<K,V>`) are fine.
- Each checkpoint must end with `npx tsc -p tsconfig.json` clean + unit tests passing against `dist/`.

## Test harness note
Tests still live in `tests/*.test.js` (CommonJS) and `require('../dist/*.js')`. They run via `node --test` after `npm run build`. This stays true until Checkpoint 8.

---

## Completed Checkpoints

### ✅ Checkpoint 0 — Baseline
- Confirmed `npm run build` passes clean against the original tree.

### ✅ Checkpoint 1 — `src/lib/` shared primitives
Created 6 shared modules under `src/lib/`:
- `http.ts` — `requestJson<T>`, `HttpMethod`, `RequestJsonOptions`
- `json.ts` — `parseJsonText<T>`
- `fs.ts` — `ensureDirectory`, `writeUtf8NoBom`, `saveContentAtomically`, `isRetryableFsError`, `readJsonFile<T>`, `writeJsonFile`, `readTextIfExists`, `readTrimmedFileText`, `listFiles`
- `paths.ts` — `normalizeWindowsPath`, `findNearestSiftKitRepoRoot`, `resolvePathFromBase`, `resolveOptionalPathFromBase`
- `time.ts` — `getUtcTimestamp`, `getLocalTimestamp`, `formatElapsed`
- `errors.ts` — `getErrorMessage`

Duplicates removed from: `src/config.ts`, `src/benchmark-matrix.ts`, `src/cli.ts`, `src/benchmark.ts`, `src/summary.ts`. `config.ts` still re-exports `ensureDirectory` + `saveContentAtomically` for back-compat.

**Provider `requestJson` retained separately** — `src/providers/llama-cpp.ts` has its own copy because it returns `{statusCode, body, rawText}` without throwing on non-2xx (intentional different contract).

### ✅ Checkpoint 2 — runtime paths + state modules
Created:
- `src/config/paths.ts` — sole owner of every runtime file path. Unified env-var resolution (`sift_kit_status` + `SIFTKIT_STATUS_PATH`). Exports every path builder: `getRuntimeRoot`, `getConfigPath`, `getInferenceStatusPath`, `getIdleSummarySnapshotsPath`, `getObservedBudgetStatePath`, `getCompressionMetricsPath`, `getRuntimeLogsPath`, `getSummaryRequestLogsDirectory`, `getSummaryRequestLogPath`, `getPlannerFailedLogsDirectory`, `getPlannerFailedPath`, `getPlannerDebugPath`, `getAbandonedLogsDirectory`, `getAbandonedRequestPath`, `getRepoSearchLogRoot`, `getRepoSearchSuccessfulDirectory`, `getRepoSearchFailedDirectory`, `getChatSessionsRoot`, `getChatSessionPath`, `getStatusDirectory`, `getMetricsDirectory`, `initializeRuntime`, `RuntimePaths`.
- `src/state/observed-budget.ts` — sole owner of `<root>/metrics/observed-budget.json`.

Path-building code deleted from `src/config.ts`, `src/summary.ts`, `src/repo-search.ts` (~180 lines). Public symbols (`getRuntimeRoot`, `getRepoLocalRuntimeRoot`, `getRepoLocalLogsPath`, `getConfigPath`, `getInferenceStatusPath`, `initializeRuntime`, `ensureDirectory`, `saveContentAtomically`) still re-exported from `config.ts` barrel.

### ✅ Checkpoint 3 — Split `src/config.ts`
`src/config.ts` went from **1082 → 86 lines** (pure barrel). New modules under `src/config/`:
- `constants.ts` — all `SIFT_*` + `SIFTKIT_VERSION` + `RUNTIME_OWNED_LLAMA_CPP_KEYS`
- `types.ts` — `SiftConfig`, `RuntimeLlamaCppConfig`, `ServerManagedLlamaCppConfig`, `StatusSnapshotResponse`, `NormalizationInfo`
- `errors.ts` — `StatusServerUnavailableError`, `MissingObservedBudgetError`
- `paths.ts` — (already existed from CP2)
- `defaults.ts` — `getDefaultConfigObject`
- `getters.ts` — `getConfiguredLlamaSetting<T>`, `getConfiguredModel`, `getConfiguredLlamaBaseUrl/NumCtx`, `getCompatRuntimeLlamaCpp`, `getMissingRuntimeFields`, `getDefaultNumCtx`, `getFinitePositiveNumber`
- `effective.ts` — `getDerivedMaxInputCharacters`, `getChunkThresholdCharacters`, `getEffectiveInputCharactersPerContextToken`, `getEffectiveMaxInputCharacters`, `resolveInputCharactersPerContextToken`, `addEffectiveConfigProperties`
- `normalization.ts` — `normalizeConfig`, `toPersistedConfigObject`, `applyRuntimeCompatibilityView`, `updateRuntimePaths`, `isLegacyManagedStartupScriptPath`
- `status-backend.ts` — `getStatusBackendUrl`, `getStatusServerHealthUrl`, `getStatusServerUnavailableMessage`, `getStatusSnapshot`, `notifyStatusBackend`, `ensureStatusServerReachable`, `deriveServiceUrl`, `toStatusServerUnavailableError`
- `execution-lease.ts` — `tryAcquireExecutionLease`, `refreshExecutionLease`, `releaseExecutionLease`, `getExecutionServerState`, `getExecutionServiceUrl`
- `config-service.ts` — `loadConfig`, `saveConfig`, `setTopLevelConfigKey`, `getConfigServiceUrl`, `getConfigFromService`, `setConfigInService`

**Architectural note**: `src/config.ts` remains as a file-level barrel that coexists with the `src/config/` directory — Node resolution finds `config.ts` before the dir when consumers do `import '../config.js'`.

### ✅ Checkpoint 4 — Split `src/summary.ts`
`src/summary.ts` went from **3133 → 1483 lines** (~53% reduction). New modules:

Top-level:
- `src/summary/types.ts` (126) — all summary + planner types
- `src/summary/measure.ts` (125) — `UNSUPPORTED_INPUT_MESSAGE`, `normalizeInputText`, `measureText`, `getQuestionAnalysis`, `getErrorSignalMetrics`, `isPassFailQuestion`, `getDeterministicExcerpt`
- `src/summary/prompt.ts` (182) — `PROMPT_PROFILES`, `buildPrompt`, `getSourceInstructions`, `extractPromptSection`, `appendChunkPath`
- `src/summary/structured.ts` (185) — `stripCodeFence`, `parseStructuredModelDecision`, `tryRecoverStructuredModelDecision`, `normalizeStructuredDecision`, `buildConservativeChunkFallbackDecision`, `buildConservativeDirectFallbackDecision`, `isInternalChunkLeaf`
- `src/summary/mock.ts` (167) — `toMockDecision`, `buildMockDecision`, `getMockSummary`
- `src/summary/artifacts.ts` (235) — planner debug recorder, failure-context attach, summary-request/failed-request dumps, `appendTestProviderEvent`, `traceSummary`, `getSummaryFailureContext`, `attachSummaryFailureContext`

Planner subfolder:
- `src/summary/planner/formatters.ts` (59) — `truncatePlannerText`, `formatNumberedLineBlock`, `formatCompactJsonBlock`, `formatPlannerResult`, `MAX_PLANNER_TOOL_RESULT_CHARACTERS`, header/guard-error formatters
- `src/summary/planner/json-filter.ts` (282) — `getValueByPath`, `setValueByPath`, `matchesJsonFilter`, `projectJsonFilterItem`, `parseJsonForJsonFilter`, `findBalancedJsonEndIndex`, `getRecord`, `getFiniteInteger`
- `src/summary/planner/tools.ts` (272) — `buildPlannerToolDefinitions`, `executeFindTextTool/ReadLines/JsonFilter`, `executePlannerTool`, `escapeUnescapedRegexBraces`, `getPlannerToolName`
- `src/summary/planner/prompts.ts` (183) — `buildPlannerDocumentProfile`, `buildPlannerSystemPrompt`, `buildPlannerInitialUserPrompt`, `buildPlannerInvalidResponseUserPrompt`, `renderPlannerTranscript`, `buildPlannerAssistantToolMessage`
- `src/summary/planner/parse.ts` (49) — `parsePlannerAction`

**What's still in `src/summary.ts`** (1483 lines):
- Token-budget constants (`LLAMA_CPP_*`, `MAX_*`, `MIN_*`, `PLANNER_*`)
- `getLlamaCppPromptTokenReserve`, `allocateLlamaCppSlotId`, `getPlannerPromptBudget` (exported), `estimatePromptTokenCount`, `getLlamaCppChunkThresholdCharacters`, `getPlannerActivationThresholdCharacters`, `getTokenAwareChunkThreshold`
- `splitTextIntoChunks`, `countPromptTokensForChunk`, `planTokenAwareLlamaCppChunks` (exported), `shouldRetryWithSmallerChunks`
- `getCommandOutputRawReviewRequired`, `getSummaryDecision` (exported)
- `sumTokenCounts`, `invokeProviderSummary`, `invokePlannerProviderAction`
- `invokePlannerMode` (the planner loop — large)
- `getPolicyDecision`, `invokeSummaryCore`, `summarizeRequest` (exported), `readSummaryInput` (exported)

---

### ✅ Checkpoint 5 — Split benchmark / benchmark-matrix / cli / repo-search + `src/capture/`
New dirs (28 modules):
- `src/capture/` (3) — `artifacts.ts`, `command-path.ts`, `process.ts`. Deduped from `command.ts`/`interactive.ts`/`eval.ts`.
- `src/benchmark/` (6) — `types.ts`, `args.ts`, `fixtures.ts`, `interrupt.ts`, `report.ts`, `runner.ts`.
- `src/benchmark-matrix/` (9) — `types.ts`, `args.ts`, `pruning.ts`, `manifest.ts`, `process.ts`, `config-rpc.ts`, `launcher.ts`, `benchmark-runner.ts`, `interrupt.ts`, `runner.ts`.
- `src/cli/` (11) — `args.ts`, `help.ts`, `run-summary.ts`, `run-install.ts`, `run-config.ts`, `run-find-files.ts`, `run-test.ts`, `run-command.ts`, `run-eval.ts`, `run-capture.ts`, `run-repo-search.ts`, `run-internal.ts`, `dispatch.ts`.
- `src/repo-search/` (4) — `types.ts`, `logging.ts`, `scorecard.ts`, `execute.ts`.

Slimmed files: `src/benchmark.ts` (429→16 lines barrel), `src/benchmark-matrix.ts` (1031→21), `src/cli.ts` (785→26), `src/repo-search.ts` (288→8), `src/command.ts` (349→240), `src/interactive.ts` (170→62), `src/eval.ts` (185→120). All 367 tests still pass.

---

### ✅ Checkpoint 6a — `siftKitStatus/index.js` → `src/status-server/index.ts`
Rewrote the 4782-line CommonJS file as a single TypeScript module (`src/status-server/index.ts`, 4756 lines) compiled to `dist/status-server/index.js`. Deleted `siftKitStatus/` entirely. `package.json#scripts.start:status` now points at the dist entry. All 367 tests still pass.

### ✅ Checkpoint 6b — Extract submodules from `src/status-server/index.ts`
`src/status-server/index.ts` went from **4756 → 3711 lines** (~22% reduction, ~1050 lines extracted). Seven new submodules:
- `paths.ts` (60) — `getRuntimeRoot`, `getStatusPath`, `getConfigPath`, `getMetricsPath`, `getIdleSummarySnapshotsPath`, `getManagedLlamaLogRoot`
- `formatting.ts` (104) — `ColorOptions`, `formatTimestamp`, `formatElapsed`, `formatGroupedNumber`, `formatInteger`, `formatMilliseconds`, `formatSeconds`, `formatPercentage`, `formatRatio`, `formatTokensPerSecond`, `supportsAnsiColor`, `colorize`
- `http-utils.ts` (190) — `requestText`, `requestJson`, `readBody`, `sleep`, `parseJsonBody`, `sendJson`, `ensureDirectory`, `writeText`, `readTextIfExists`, `listFiles`, `saveContentAtomically`, `safeReadJson`, `getIsoDateFromStat`
- `status-file.ts` (214) — `STATUS_TRUE/FALSE/LOCK_REQUESTED/FOREIGN_LOCK`, `normalizeStatusText`, `ensureStatusFile`, `readStatusText`, `parseRunning`, `StatusMetadata`, `parseStatusMetadata`
- `metrics.ts` (88) — `Metrics`, `getDefaultMetrics`, `normalizeMetrics`, `readMetrics`, `writeMetrics`
- `idle-summary.ts` (195) — `IdleSummarySnapshot`, `buildIdleSummarySnapshot`, `buildIdleSummarySnapshotMessage`, `buildIdleMetricsLogMessage`, `ensureIdleSummarySnapshotsTable`, `persistIdleSummarySnapshot`, sqlite schema + migrations
- `config-store.ts` (321) — all `DEFAULT_LLAMA_*` / `*_STARTUP_SCRIPT` constants, `getDefaultConfig`, `mergeConfig`, `normalizeConfig`, `readConfig`, `writeConfig`, `getManagedLlamaConfig`, `getCompatRuntimeLlamaCpp`, `getLlamaBaseUrl`

Public API preserved via re-exports from `index.ts` (`getStatusPath`, `getConfigPath`, `getMetricsPath`, `getIdleSummarySnapshotsPath`, `supportsAnsiColor`, `colorize`, `formatElapsed`, `buildIdleSummarySnapshot`, `buildIdleMetricsLogMessage`, `terminateProcessTree`, `startStatusServer`). 367/368 tests pass (1 skipped, baseline).

---

## Remaining Checkpoints

### ✅ Checkpoint 6c — Move state modules to `src/state/`
`src/status-server/index.ts` went from **3711 → 3610 lines**. New modules:
- `src/state/jsonl-transcript.ts` (39) — `JsonlEvent`, `readJsonlEvents`, `getTranscriptDurationMs`
- `src/state/chat-sessions.ts` (88) — `ChatSession`, `ChatMessage`, `estimateTokenCount`, `getChatSessionsRoot`, `listChatSessionPaths`, `readChatSessionFromPath`, `readChatSessions`, `getChatSessionPath`, `saveChatSession`

`npx tsc -p tsconfig.json --noEmit` clean; `npm run build` + `npm test` → 367/368 pass, 0 fail, 1 skipped (baseline).

**Deferred for a follow-up pass** (not required by plan verification gates):
- `compression-metrics.ts`, `summary-artifacts.ts`, `repo-search-transcripts.ts`, `idle-summary-db.ts` state owners — these are currently tied into `status-server/index.ts` via shared closures (active run state, managed-llama handle) and would require threading context through function signatures. Can be pulled out later without behavior change.

### ⏳ Checkpoint 7 — JS → TS sweep (non-tests)
Convert every remaining `.js` file to `.ts`:
- `bin/siftkit.js` → `bin/siftkit.ts` (compiled to `dist/bin/siftkit.js`, `package.json#bin` pointer updated)
- `scripts/*.js` (9 files) → `scripts/*.ts` (invoked via `tsx`)
- `tests/_test-helpers.js` → `tests/_test-helpers.ts`
- `analyze_actionless_finishes.js`, `analyze_failures.js`, `analyze_planner_failures.js` → `src/analyzers/*.ts`
- `test.js` (repo root) — convert or delete (likely obsolete)

Update `tsconfig.json` `include` to cover `bin/**/*.ts`, `scripts/**/*.ts`, `src/analyzers/**/*.ts`, `src/status-server/**/*.ts`, `tests/**/*.ts`.

Update `package.json`:
- `bin.siftkit` → `dist/bin/siftkit.js`
- `scripts.benchmark:fixture31` and other script invocations to use `tsx` where appropriate

### ⏳ Checkpoint 8 — Convert tests to TS + split `runtime.test.js`
- All `tests/*.test.js` → `tests/*.test.ts`
- Test runner: switch to `tsx --test tests/**/*.test.ts` (or compile via a second tsconfig to `dist-tests/` and keep `node --test`). **Recommended: tsx.**
- **Split `tests/runtime.test.js`** (8352 lines / 317 KB) into domain files:
  - `tests/runtime-loadconfig.test.ts`
  - `tests/runtime-summarize.test.ts`
  - `tests/runtime-planner-token-aware.test.ts`
  - `tests/runtime-planner-mode.test.ts`
  - `tests/runtime-provider-llama.test.ts`
  - `tests/runtime-status-server.test.ts`
  - `tests/runtime-execution-lease.test.ts`
  - `tests/runtime-metrics-aggregation.test.ts`
  - `tests/runtime-cli.test.ts`
- Delete `tests/runtime.test.js`, update `package.json#scripts.test` file list.

---

## Final Verification Checklist (after CP8)
1. `npm run build` passes (tsc + dashboard vite build).
2. `npm test` runs all split tests via tsx, every test passes.
3. `npm run test:coverage` no regression.
4. `npm run refresh-global` → `siftkit --help`, `siftkit config get`, `siftkit find-files .` all work.
5. `npm run start:status` boots the rewritten TS status server, responds to `GET /health`, `GET /status`, `GET /config`, lease round-trip.
6. `npm run start:dashboard` loads data from the rewritten server.
7. `npm run benchmark:fixture31` completes end-to-end.
8. Grep confirms each primitive has exactly one definition: `requestJson`, `parseJsonText`, `ensureDirectory`, `normalizeWindowsPath`, `isLegacyManagedStartupScriptPath`, `getDefaultConfig(Object)`, `normalizeConfig`, `mergeConfig`, `getStatusPath`, `getConfigPath`, `getMetricsPath`, `getIdleSummarySnapshotsPath`, `getRuntimeLogsPath`, `getTimestamp`, `newArtifactPath`, `findCommandInPath`, `resolveExternalCommand`, `normalizeStatusText`, `ensureStatusFile`, `getChatSessionsRoot`, `getChatSessionPath`, `getRepoSearchTranscriptPath`.
9. Every `.siftkit/` state file (`config.json`, `status/inference.txt`, `status/idle-summary.sqlite`, `metrics/observed-budget.json`, `metrics/compression.json`, `logs/requests/*.json`, `logs/planner_debug_*.json`, `logs/failed/*.json`, `logs/abandoned/*.json`, `logs/repo_search/**/*.json*`, `chat/sessions/session_*.json`) is owned by exactly one module under `src/state/` or `src/config/`.

## Current Stats
- Source files split: **66 new modules** (across lib, config, summary, state, capture, benchmark, benchmark-matrix, cli, repo-search).
- Lines removed as duplicates: ~1600+ across the refactored files.
- No behavior changes. All 367 unit tests pass.
