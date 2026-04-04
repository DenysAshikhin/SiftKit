SiftKit: Big-Bang TypeScript Refactor & Targeted Split
Context
The repo has grown into a mix of TypeScript src/ modules and a large CommonJS surface (status server, tests, scripts, root analyzers). Several core files have become too large to navigate or test in isolation:

File	Size	Top-level decls
src/summary.ts	115 KB	~110
src/config.ts	50 KB	~65
src/benchmark-matrix.ts	37 KB	~48
src/cli.ts	28 KB	~28
siftKitStatus/index.js	178 KB / 4782 lines	~100+
tests/runtime.test.js	317 KB / 8352 lines	hundreds of test(...)
There is also real duplication across files: requestJson, parseJsonText, ensureDirectory, writeJsonFile, readJsonFile, normalizeWindowsPath, isLegacyManagedStartupScriptPath, formatElapsed, and the llama/managed config normalization are reimplemented in 2–4 places (at least src/config.ts, src/cli.ts, src/benchmark-matrix.ts, src/providers/llama-cpp.ts, siftKitStatus/index.js).

Goal: in a single pass, (1) extract shared utilities, (2) break the four large source files into cohesive modules via a targeted split, (3) convert every remaining .js file in the repo to TypeScript (bin, siftKitStatus, tests, scripts, and root analyze_*.js / test.js), and (4) split runtime.test.js into domain-aligned test files that mirror the new source layout.

Deliverables Overview
New shared-lib folder src/lib/ with io/http/json/fs/text primitives.
Targeted splits of summary.ts, config.ts, benchmark-matrix.ts, cli.ts into subfolders with thin re-export barrels so existing test imports (require('../dist/summary.js'), etc.) keep working.
siftKitStatus/index.js rewritten as src/status-server/ TypeScript modules; a thin siftKitStatus/index.js bootstrap replaced by dist/status-server/index.js, and package.json scripts updated.
All scripts/*.js, tests/*.js, bin/siftkit.js, root analyze_*.js, test.js converted to .ts.
runtime.test.js split into domain files (see Test Split below).
package.json test/script entries updated to run TypeScript via tsx and/or the existing tsc build step.
Target Source Layout
src/
├── cli.ts                       (thin: parses argv, delegates to cli/*)
├── cli/
│   ├── args.ts                  (parseArguments, validateRepoSearchTokens, getCommandName/Args)
│   ├── help.ts                  (showHelp, KNOWN_COMMANDS, BLOCKED_PUBLIC_COMMANDS, SERVER_DEPENDENT_*)
│   ├── run-summary.ts           (runSummary)
│   ├── run-install.ts           (runInstall, runInstallGlobalCli, runCodexPolicyCli)
│   ├── run-config.ts            (runConfigGet, runConfigSet)
│   ├── run-find-files.ts
│   ├── run-test.ts              (runTest, buildTestResult)
│   ├── run-command.ts           (runCommandCli)
│   ├── run-eval.ts              (runEvalCli)
│   ├── run-capture.ts           (runCaptureInternalCli)
│   ├── run-repo-search.ts       (runRepoSearchCli, getRepoSearchServiceUrl, formatPsList)
│   └── run-internal.ts          (runInternal, readRequestFile)
│
├── lib/                         (NEW — shared primitives)
│   ├── http.ts                  (requestJson, requestText, http options type)
│   ├── json.ts                  (parseJsonText)
│   ├── fs.ts                    (ensureDirectory, writeUtf8NoBom, saveContentAtomically,
│   │                              readJsonFile, writeJsonFile, readTextIfExists,
│   │                              listFiles, isRetryableFsError)
│   ├── paths.ts                 (normalizeWindowsPath, isLegacyManagedStartupScriptPath,
│   │                              resolvePathFromBase, resolveOptionalPathFromBase,
│   │                              findNearestSiftKitRepoRoot)
│   ├── time.ts                  (getUtcTimestamp, formatTimestamp, formatElapsed,
│   │                              formatMilliseconds, formatSeconds)
│   ├── text-format.ts           (formatInteger, formatPercentage, formatRatio,
│   │                              formatGroupedNumber, formatTokensPerSecond,
│   │                              supportsAnsiColor, colorize)
│   └── errors.ts                (getErrorMessage, wrapUnknownError)
│
├── config/
│   ├── index.ts                 (barrel: re-exports public API — loadConfig, saveConfig,
│   │                              setTopLevelConfigKey, all getConfigured*, StatusServerUnavailableError,
│   │                              MissingObservedBudgetError, SIFT_* constants, types,
│   │                              notifyStatusBackend, ensureStatusServerReachable,
│   │                              execution-lease helpers, ensureDirectory, saveContentAtomically)
│   ├── constants.ts             (SIFTKIT_VERSION, SIFT_DEFAULT_*, SIFT_LEGACY_*,
│   │                              SIFT_PREVIOUS_*, SIFT_FORMER_*, SIFT_BROKEN_*,
│   │                              SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN, etc.)
│   ├── types.ts                 (SiftConfig, RuntimeLlamaCppConfig,
│   │                              ServerManagedLlamaCppConfig, status-snapshot types,
│   │                              StatusServerUnavailableError, MissingObservedBudgetError)
│   ├── paths.ts                 (getRuntimeRoot, getRepoLocalRuntimeRoot,
│   │                              getRepoLocalLogsPath, initializeRuntime,
│   │                              getConfigPath, getInferenceStatusPath,
│   │                              isRuntimeRootWritable)
│   ├── defaults.ts              (getDefaultConfigObject, RUNTIME_OWNED_LLAMA_CPP_KEYS)
│   ├── normalization.ts         (normalizeConfig, updateRuntimePaths,
│   │                              applyRuntimeCompatibilityView, toPersistedConfigObject,
│   │                              getCompatRuntimeLlamaCpp, getMissingRuntimeFields,
│   │                              NormalizationInfo)
│   ├── effective.ts             (addEffectiveConfigProperties,
│   │                              getDerivedMaxInputCharacters, getEffectiveMaxInputCharacters,
│   │                              getEffectiveInputCharactersPerContextToken,
│   │                              getChunkThresholdCharacters)
│   ├── observed-budget.ts       (read/write/normalize ObservedBudgetState,
│   │                              resolveInputCharactersPerContextToken,
│   │                              getObservedInputCharactersPerContextToken)
│   ├── status-backend.ts        (getStatusBackendUrl, getStatusServerHealthUrl,
│   │                              getStatusServerUnavailableMessage, getStatusSnapshot,
│   │                              notifyStatusBackend, ensureStatusServerReachable,
│   │                              toStatusServerUnavailableError)
│   ├── execution-lease.ts       (getExecutionServiceUrl, getExecutionServerState,
│   │                              tryAcquireExecutionLease, refreshExecutionLease,
│   │                              releaseExecutionLease)
│   ├── config-service.ts        (getConfigServiceUrl, getConfigFromService,
│   │                              setConfigInService, saveConfig, loadConfig,
│   │                              setTopLevelConfigKey)
│   └── getters.ts               (getConfiguredModel, getConfiguredPromptPrefix,
│                                  getConfiguredLlamaBaseUrl, getConfiguredLlamaNumCtx,
│                                  getConfiguredLlamaSetting, getDefaultNumCtx)
│
├── summary/
│   ├── index.ts                 (barrel: summarizeRequest, readSummaryInput,
│   │                              buildPrompt, getSummaryDecision, getDeterministicExcerpt,
│   │                              planTokenAwareLlamaCppChunks, getPlannerPromptBudget,
│   │                              buildPlannerToolDefinitions, UNSUPPORTED_INPUT_MESSAGE,
│   │                              all public types)
│   ├── types.ts                 (SummaryRequest, SummaryResult, SummaryDecision,
│   │                              StructuredModelDecision, QuestionAnalysis,
│   │                              PlannerPromptBudget, PlannerTool* types, SummaryPhase)
│   ├── measure.ts               (measureText, normalizeInputText, sumTokenCounts,
│   │                              getErrorSignalMetrics, isPassFailQuestion,
│   │                              getQuestionAnalysis, getDeterministicExcerpt)
│   ├── decision.ts              (getSummaryDecision, getCommandOutputRawReviewRequired,
│   │                              shouldRetryWithSmallerChunks, getPolicyDecision)
│   ├── chunking.ts              (splitTextIntoChunks, countPromptTokensForChunk,
│   │                              planTokenAwareLlamaCppChunks, getTokenAwareChunkThreshold,
│   │                              getLlamaCppPromptTokenReserve, allocateLlamaCppSlotId,
│   │                              getLlamaCppChunkThresholdCharacters,
│   │                              getPlannerActivationThresholdCharacters,
│   │                              estimatePromptTokenCount)
│   ├── prompt.ts                (buildPrompt, getSourceInstructions,
│   │                              extractPromptSection, appendChunkPath)
│   ├── structured.ts            (stripCodeFence, decodeStructuredOutputText,
│   │                              tryRecoverStructuredModelDecision,
│   │                              parseStructuredModelDecision, ensureRawReviewSentence,
│   │                              normalizeStructuredDecision,
│   │                              buildConservativeChunkFallbackDecision,
│   │                              buildConservativeDirectFallbackDecision,
│   │                              isInternalChunkLeaf)
│   ├── provider-invoke.ts       (invokeProviderSummary)
│   ├── mock.ts                  (getMockSummary, buildMockDecision, toMockDecision)
│   ├── artifacts.ts             (getRuntimeLogsPath, getPlannerDebugPath,
│   │                              getPlannerFailedPath, getPlannerFailedLogsPath,
│   │                              getSummaryRequestLogPath, getSummaryRequestLogsPath,
│   │                              postSummaryArtifact, writeFailedRequestDump,
│   │                              writeSummaryRequestDump, clearSummaryArtifactState,
│   │                              readPlannerDebugPayload, updatePlannerDebugDump,
│   │                              appendTestProviderEvent, attachSummaryFailureContext,
│   │                              getSummaryFailureContext, traceSummary)
│   ├── planner/
│   │   ├── tools.ts             (buildPlannerToolDefinitions, executePlannerTool,
│   │   │                          executeFindTextTool, executeReadLinesTool,
│   │   │                          executeJsonFilterTool, formatPlannerToolResultHeader,
│   │   │                          formatPlannerResult, formatPlannerToolResultTokenGuardError,
│   │   │                          truncatePlannerText, formatNumberedLineBlock,
│   │   │                          formatCompactJsonBlock,
│   │   │                          escapeUnescapedRegexBraces, isRegexCharEscaped)
│   │   ├── json-filter.ts       (normalizeJsonFilterFilters, compareJsonFilterOrdered,
│   │   │                          matchesJsonFilter, projectJsonFilterItem,
│   │   │                          toJsonFallbackPreview, findBalancedJsonEndIndex,
│   │   │                          parseJsonForJsonFilter, getValueByPath, setValueByPath)
│   │   ├── prompts.ts           (buildPlannerDocumentProfile, buildPlannerSystemPrompt,
│   │   │                          buildPlannerInitialUserPrompt,
│   │   │                          buildPlannerInvalidResponseUserPrompt,
│   │   │                          renderPlannerTranscript, buildPlannerAssistantToolMessage,
│   │   │                          getPlannerPromptBudget)
│   │   ├── parse.ts             (parsePlannerAction, getRecord, getPlannerToolName,
│   │   │                          getFiniteInteger)
│   │   ├── debug.ts             (createPlannerDebugRecorder, finalizePlannerDebugDump,
│   │   │                          buildPlannerFailureErrorMessage)
│   │   ├── provider.ts          (invokePlannerProviderAction)
│   │   └── mode.ts              (invokePlannerMode)
│   └── core.ts                  (invokeSummaryCore, summarizeRequest, readSummaryInput)
│
├── benchmark/                   (split from src/benchmark.ts)
│   ├── index.ts                 (barrel: runBenchmarkSuite + types)
│   ├── types.ts                 (BenchmarkRunnerOptions, BenchmarkCaseResult,
│   │                              BenchmarkRunResult, BenchmarkFixture)
│   ├── args.ts                  (parseArguments, getValidatedRequestTimeoutSeconds,
│   │                              resolvePromptPrefix, getPromptLabel,
│   │                              getDefaultOutputPath, getRepoRoot)
│   ├── fixtures.ts              (getFixtureManifest)
│   ├── interrupt.ts             (createInterruptSignal, runWithFixtureDeadline,
│   │                              createFixtureHeartbeat, isTimeoutError)
│   ├── report.ts                (buildBenchmarkArtifact, getTimestamp,
│   │                              roundDuration, formatElapsed)
│   └── runner.ts                (runBenchmarkSuite, main)
│
├── benchmark-matrix/            (split from src/benchmark-matrix.ts)
│   ├── index.ts                 (barrel: runMatrix, runMatrixWithInterrupt,
│   │                              readMatrixManifest, buildLaunchSignature,
│   │                              buildLauncherArgs, buildBenchmarkArgs,
│   │                              pruneOldLauncherLogs + types)
│   ├── types.ts                 (MatrixCliOptions, ResolvedMatrixManifest,
│   │                              ResolvedMatrixTarget, MatrixIndex, LaunchResult,
│   │                              BenchmarkProcessResult, MatrixInterruptedError,
│   │                              RawMatrixManifest, ConfigRecord, HttpOptions)
│   ├── args.ts                  (parseArguments)
│   ├── manifest.ts              (readMatrixManifest, getSelectedRuns,
│   │                              getRequired*/getOptional* value coercions,
│   │                              resolveModelPathForStartScript)
│   ├── launcher.ts              (buildLauncherArgs, buildBenchmarkArgs,
│   │                              buildLaunchSignature, startLlamaLauncher,
│   │                              restartLlamaForTarget, waitForLlamaReadiness,
│   │                              getLlamaModels, invokeStopScript,
│   │                              forceStopLlamaServer)
│   ├── process.ts               (spawnAndWait, invokeBenchmarkProcess,
│   │                              getBenchmarkProcessPaths)
│   ├── config-rpc.ts            (invokeConfigGet, invokeConfigSet,
│   │                              getRuntimeLlamaCppConfigValue)
│   ├── pruning.ts               (pruneOldLauncherLogs, collectLauncherLogPaths,
│   │                              isLauncherLogFile, ONE_WEEK_MS)
│   ├── interrupt.ts             (createMatrixInterruptSignal, withMatrixInterrupt)
│   └── runner.ts                (runMatrix, runMatrixWithInterrupt, writeMatrixIndex,
│                                  main)
│
├── status-server/               (NEW — replaces siftKitStatus/index.js)
│   ├── index.ts                 (bootstrap: HTTP server, route table, lifecycle)
│   ├── routes/
│   │   ├── status.ts            (GET/POST /status, shared-status file contract)
│   │   ├── config.ts            (GET/POST /config)
│   │   ├── execution.ts         (/execution/{state,acquire,refresh,release})
│   │   ├── health.ts            (GET /health)
│   │   ├── dashboard.ts         (dashboard runs/metrics endpoints)
│   │   ├── chat.ts              (chat-session endpoints)
│   │   └── repo-search.ts       (repo-search progress & session endpoints)
│   ├── llama-manager.ts         (managed llama.cpp startup/shutdown,
│   │                              health probes, log scanning)
│   ├── status-file.ts           (shared-status file read/write, normalizeStatusText)
│   ├── metrics.ts               (metrics read/write/normalize, idle-summary aggregation)
│   ├── idle-summary.ts          (build/emit idle-summary snapshots, sqlite persistence)
│   ├── dashboard-runs.ts        (loadDashboardRuns, buildDashboardRunDetail,
│   │                              buildDashboardDailyMetrics*, run record normalization)
│   ├── chat-sessions.ts         (list/read/append chat sessions, context usage)
│   ├── formatting.ts            (log formatting helpers; re-exports from lib/text-format)
│   ├── http-utils.ts            (readBody, parseJsonBody, sendJson)
│   └── config-store.ts          (default config, normalizeConfig, migrations —
│                                  shares constants with src/config via a shared
│                                  `src/config/constants.ts` import)
│
├── providers/
│   └── llama-cpp.ts             (kept; requestJson swapped for lib/http)
│
├── analyzers/                   (NEW — from repo-root analyze_*.js)
│   ├── actionless-finishes.ts
│   ├── failures.ts
│   └── planner-failures.ts
│
├── command.ts                   (kept; imports from lib/* and config/*)
├── eval.ts                      (kept)
├── execution-lock.ts            (kept)
├── find-files.ts                (kept)
├── install.ts                   (kept)
├── interactive.ts               (kept)
├── llama-cpp-bridge.ts          (kept)
├── repo-search.ts               (kept)
└── import-markdown-benchmark.ts (kept)

bin/
└── siftkit.ts                   (converted; still emits dist/bin/siftkit.js
                                  referenced by "bin" in package.json)

scripts/                         (all JS → TS; tsx-invoked)
├── debug-case48-steps.ts
├── mock-repo-search-loop.ts
├── postinstall.ts
├── repro-fixture60-malformed-json.ts
├── run-benchmark-fixture-debug.ts
├── run-benchmark-fixture31.ts
├── start-dev.ts
└── verify-prompt-dispatch-cases.ts

tests/                           (all JS → TS; node --test via tsx)
├── _test-helpers.ts             (makeCaptureStream, readBody, getDefaultConfig, etc.)
├── (all existing *.test.js → *.test.ts)
├── runtime-loadconfig.test.ts          (split from runtime.test.js, ~20 tests)
├── runtime-summarize.test.ts           (summarizeRequest happy/recursive paths)
├── runtime-planner-token-aware.test.ts (token-aware chunking, planner budgets)
├── runtime-planner-mode.test.ts        (planner invocation, tool calls)
├── runtime-provider-llama.test.ts      (llama-cpp provider tests)
├── runtime-status-server.test.ts       (real status server behaviours)
├── runtime-execution-lease.test.ts     (withExecutionLock + server lease)
├── runtime-metrics-aggregation.test.ts (status metrics aggregation)
└── runtime-cli.test.ts                 (CLI fail-closed paths)
Thin barrel files (summary/index.ts, config/index.ts, benchmark/index.ts, benchmark-matrix/index.ts) re-export everything the existing test suite imports today, so consumers of dist/summary.js, dist/config.js, etc. keep working unchanged when they load from the compiled output.

Shared Utility Consolidation
src/lib/http.ts
Single requestJson<T>(options) + requestText(url, timeoutMs) used by:

src/config.ts:148 → config/config-service.ts, config/status-backend.ts, config/execution-lease.ts
src/cli.ts:272 → cli/run-repo-search.ts, cli/run-internal.ts
src/benchmark-matrix.ts:178 → benchmark-matrix/config-rpc.ts, benchmark-matrix/launcher.ts
src/providers/llama-cpp.ts
siftKitStatus/index.js:540 → status-server/ (uses same primitive)
src/lib/fs.ts
ensureDirectory, writeUtf8NoBom, saveContentAtomically, readJsonFile, writeJsonFile, readTextIfExists, listFiles, isRetryableFsError.

Replaces duplicates in src/config.ts:231, src/benchmark-matrix.ts:235, siftKitStatus/index.js:143.
config/index.ts re-exports ensureDirectory and saveContentAtomically to preserve the existing public surface consumed by src/benchmark.ts, src/command.ts, src/eval.ts.
src/lib/json.ts
parseJsonText<T>(text) — deduped from src/config.ts:143, src/benchmark-matrix.ts:173, siftKitStatus/index.js:1211.

src/lib/paths.ts
normalizeWindowsPath, isLegacyManagedStartupScriptPath, findNearestSiftKitRepoRoot, resolvePathFromBase, resolveOptionalPathFromBase.

Replaces duplicates in src/config.ts:400, src/benchmark-matrix.ts:322, siftKitStatus/index.js:343.
src/lib/time.ts + src/lib/text-format.ts
Collect all formatElapsed/formatTimestamp/formatMilliseconds/ formatPercentage/formatInteger/formatGroupedNumber/supportsAnsiColor/ colorize helpers that currently live only inside siftKitStatus/index.js and partially in src/benchmark.ts:200, src/benchmark-matrix.ts:310.

src/lib/errors.ts
getErrorMessage (currently inline in src/summary.ts:185), plus the attachSummaryFailureContext/getSummaryFailureContext stays in summary/artifacts.ts as it is summary-specific.

Status-Server Rewrite (siftKitStatus → src/status-server)
siftKitStatus/index.js (4782 lines, CommonJS) is converted to a TypeScript package under src/status-server/ with the layout above. Key moves:

Shared constants — DEFAULT_LLAMA_*, *_STARTUP_SCRIPT duplicates removed; the status server imports from src/config/constants.ts.
Shared normalization — normalizeConfig/mergeConfig/startup-script migration logic currently duplicated at siftKitStatus/index.js:357 and src/config.ts:1055 is collapsed into a single src/config/normalization.ts that both the CLI config client and the server consume.
Testable modules — managed-llama lifecycle, idle-summary snapshotting, metrics aggregation, dashboard-runs indexing, and chat sessions each become a module that can be unit-tested without spinning the HTTP server.
Entry point — package.json start:status script updated to invoke dist/status-server/index.js (or tsx src/status-server/index.ts during dev). The old siftKitStatus/index.js is deleted.
JS → TS Conversion
Every .js file becomes .ts. For CommonJS-only files we rewrite require/module.exports to ES module syntax under "module": "NodeNext".

Source	New Location
bin/siftkit.js	bin/siftkit.ts (compiled to dist/bin/siftkit.js, package.json#bin points there)
siftKitStatus/index.js	src/status-server/ (see above)
scripts/*.js (9 files)	scripts/*.ts, invoked with tsx
tests/*.js (20 files)	tests/*.ts, run via tsx --test
analyze_actionless_finishes.js, analyze_failures.js, analyze_planner_failures.js	src/analyzers/*.ts
test.js (repo root)	scripts/smoke-test.ts (or deleted if obsolete)
Runtime/testing changes:

Add tsx as the test runner: npm test becomes npm run build && tsx --test tests/**/*.test.ts.
OR compile tests via a second tsconfig.tests.json that emits to dist-tests/ and keep node --test. Recommended: tsx — keeps source maps intact, no extra tsconfig, tests can import from source during development and from ../dist/*.js for fidelity with production build (we'll keep the dist import style so tests exercise the built artifact, as today).
Runtime Test Split
tests/runtime.test.js (8352 lines) becomes the following .ts files. Each gets the same imports-from-../dist/* setup and a local helper import from ./_test-helpers.ts:

New file	Tests included
tests/runtime-loadconfig.test.ts	getConfigPath / loadConfig / saveConfig / config-migration tests (lines ~1360–1647)
tests/runtime-summarize.test.ts	summarizeRequest recursive merge, split, serialize, fail-closed (~1648–1866, 3097–3146, 3640–3842)
tests/runtime-planner-token-aware.test.ts	token-aware chunking & planning (~3842–end of planner-token tests)
tests/runtime-planner-mode.test.ts	planner invocation + tool-call integration
tests/runtime-provider-llama.test.ts	llama.cpp provider stub-server tests (~3147–3422)
tests/runtime-status-server.test.ts	"real status server" tests (~2035–3096)
tests/runtime-execution-lease.test.ts	withExecutionLock + lease serialization (~2005–2034)
tests/runtime-metrics-aggregation.test.ts	status metrics aggregation (~3423–3639)
tests/runtime-cli.test.ts	CLI fail-closed + find-files-local (~3097–3146)
Tests continue to require against the compiled dist/ output so they cover the shipping artifact. Once the split lands, runtime.test.js is deleted and the package.json test script is updated to enumerate the new files.

Critical Files to Modify
package.json — scripts.test, scripts.test:coverage, scripts.start:status, scripts.benchmark*, scripts.verify:*, bin.siftkit, files list
tsconfig.json — add bin/**/*.ts, scripts/**/*.ts, tests/**/*.ts, src/status-server/**/*.ts to include; consider outDir layout
bin/siftkit.cmd, bin/siftkit.ps1 — update entry reference if path changes
scripts/postinstall.js → scripts/postinstall.ts (runs at npm install; must still work after build)
All files listed in the Target Source Layout above
Barrel files (src/summary/index.ts, src/config/index.ts, etc.) preserve the existing import surface so the compiled dist/summary.js, dist/config.js, dist/benchmark-matrix.js, dist/cli.js remain drop-in entry points for tests and the siftkit binary.

Verification
Typecheck: npm run build (invokes tsc -p tsconfig.json) must pass with zero new errors. Dashboard build (npm --prefix dashboard run build) must still pass.
Unit tests: npm test runs the full suite via tsx against freshly built dist/. All existing tests must pass. New runtime-split files collectively cover every test previously in runtime.test.js.
Coverage: npm run test:coverage still produces a report with no regression in statement coverage for the refactored modules.
CLI smoke: after npm run refresh-global, run siftkit --help, siftkit config get, siftkit find-files . to confirm the packaged bin entry points work end-to-end.
Status server smoke: npm run start:status (new TS entry) boots, responds to GET /health, GET /status, GET /config, and performs a lease acquire/release round-trip. Dashboard npm run start:dashboard loads data from the rewritten server.
Benchmark smoke: npm run benchmark:fixture31 still completes against the running status server using the new scripts/run-benchmark-fixture31.ts.
Grep for duplicates — confirm requestJson, parseJsonText, ensureDirectory, normalizeWindowsPath, isLegacyManagedStartupScriptPath each appear as a single definition under src/lib/ or src/config/.