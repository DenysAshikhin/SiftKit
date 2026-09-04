# Repo-Agent Discovery Prompt Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not dispatch subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a reproducible four-arm repo-agent prompt experiment that measures discovery efficiency without accepting correctness regressions.

**Architecture:** Add a focused harness under `bench/repo-agent-prompt-experiment`. It materializes dependency-free fixture repositories into owned temporary directories, invokes the existing repo-agent API with composed prompt factors, independently validates each result, reads the inner transcript from `run_logs`, and emits paired JSON/Markdown reports. A 16-run pilot selects at most one candidate for a 24-run control-versus-candidate confirmation stage.

**Tech Stack:** TypeScript, Zod, Node.js 24, `better-sqlite3`, existing `StatusServerApiClient`, existing PowerShell process helper, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-04-repo-agent-discovery-prompt-experiment-design.md`

## Global Constraints

- Do not use subagents or Git worktrees.
- Do not commit, stage, reset, clean, or otherwise alter the SiftKit working tree outside the files named by this plan.
- All implementation and tests are TypeScript with Zod-validated IO and `z.infer` types.
- Do not use `any`, type assertions, non-null assertions, namespace imports, schema-duplicating types, dynamically passed functions, compatibility paths, or fallback implementations.
- Run live repo-agent cases sequentially; the local model queue is exclusive.
- Never run a live experiment against the SiftKit working tree.
- Preserve exact-match edit safety; this plan does not change repo-agent production behavior.
- Route large validation output through `siftkit summary` when the status server is available; use narrowly targeted raw output only for a specific failure.

---

### Task 1: Experiment manifest and prompt-factor composition

**Files:**
- Create: `bench/repo-agent-prompt-experiment/types.ts`
- Create: `bench/repo-agent-prompt-experiment/manifest.ts`
- Create: `bench/repo-agent-prompt-experiment/prompts/search-first.txt`
- Create: `bench/repo-agent-prompt-experiment/prompts/question-bounded.txt`
- Create: `bench/repo-agent-prompt-experiment/manifest.json`
- Test: `tests/repo-agent-prompt-experiment-manifest.test.ts`

**Interfaces:**
- Produces: `ExperimentManifestSchema`, `ExperimentManifest`, `ResolvedExperimentManifest`, `PromptArm`, `ExperimentCase`, `readExperimentManifest(path)`, and `composePromptPrefix(manifest, armId)`.
- Consumes: `z` from `src/lib/zod.ts`, `readJsonFile` from `src/lib/fs.ts`, and path helpers from `src/lib/paths.ts`.

- [ ] **Step 1: Write failing schema and composition tests**

Test all four arm compositions, duplicate ids, unknown factor ids, missing prompt files, missing fixture roots, empty validation commands, non-positive repetitions/timeouts, and path resolution relative to the manifest. The core assertions are:

```ts
assert.equal(composePromptPrefix(manifest, 'control'), '');
assert.equal(composePromptPrefix(manifest, 'search-first'), searchFirstText);
assert.equal(composePromptPrefix(manifest, 'question-bounded'), questionBoundedText);
assert.equal(
  composePromptPrefix(manifest, 'combined'),
  `${searchFirstText}\n\n${questionBoundedText}`,
);
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-manifest.test.ts
```

Expected: FAIL because the experiment schemas and manifest reader do not exist.

- [ ] **Step 3: Implement the schemas and resolver**

Use this manifest shape as the sole source of experiment configuration:

```ts
export const ExperimentManifestSchema = z.strictObject({
  id: z.string().min(1),
  model: z.string().min(1),
  approval: z.literal('off'),
  maxTurns: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  runLogPollTimeoutMs: z.number().int().positive(),
  pilotRepetitions: z.number().int().positive(),
  confirmationRepetitions: z.number().int().positive(),
  resultRoot: z.string().min(1),
  factors: z.array(z.strictObject({
    id: z.string().min(1),
    file: z.string().min(1),
  })),
  arms: z.array(z.strictObject({
    id: z.string().min(1),
    label: z.string().min(1),
    factorIds: z.array(z.string().min(1)),
  })),
  cases: z.array(z.strictObject({
    id: z.string().min(1),
    label: z.string().min(1),
    category: z.enum(['localized', 'call-path', 'decoy', 'multi-file']),
    fixtureRoot: z.string().min(1),
    task: z.string().trim().min(1),
    validationCommands: z.array(z.string().trim().min(1)).min(1),
    protectedPaths: z.array(z.string().min(1)).min(1),
  })).min(1),
});
export type ExperimentManifest = z.infer<typeof ExperimentManifestSchema>;
```

The resolved type must replace every manifest-relative file/directory with an absolute path and retain the parsed manifest. Reject duplicate factor, arm, and case ids case-insensitively. Reject an arm referring to an unknown factor and require the exact arm set `control`, `search-first`, `question-bounded`, `combined` with factor sets `[]`, `['search-first']`, `['question-bounded']`, and `['search-first', 'question-bounded']`.

Write the two prompt files byte-for-byte from the spec. Set these fixed manifest values:

```json
{
  "id": "discovery-guidance-v1",
  "model": "3.8_27b_4.9bpw",
  "approval": "off",
  "maxTurns": 120,
  "requestTimeoutMs": 3600000,
  "runLogPollTimeoutMs": 60000,
  "pilotRepetitions": 1,
  "confirmationRepetitions": 3,
  "resultRoot": "../../eval/results/repo-agent-prompt-experiment/discovery-guidance-v1"
}
```

Include the exact four factor arms and all four cases created in Task 2. Factor files are `prompts/search-first.txt` and `prompts/question-bounded.txt`; fixture roots are `fixtures/port-parser/repo`, `fixtures/handler-registration/repo`, `fixtures/duplicate-decoy/repo`, and `fixtures/usage-contract/repo`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-manifest.test.ts
```

Expected: PASS.

---

### Task 2: Deterministic fixture repositories

**Files:**
- Create: `bench/repo-agent-prompt-experiment/fixtures/port-parser/repo/package.json`
- Create: `bench/repo-agent-prompt-experiment/fixtures/port-parser/repo/src/port.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/port-parser/repo/tests/port.test.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/handler-registration/repo/package.json`
- Create: `bench/repo-agent-prompt-experiment/fixtures/handler-registration/repo/src/handlers/admin.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/handler-registration/repo/src/handlers/health.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/handler-registration/repo/src/registry.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/handler-registration/repo/tests/registry.test.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/duplicate-decoy/repo/package.json`
- Create: `bench/repo-agent-prompt-experiment/fixtures/duplicate-decoy/repo/src/legacy/format-status.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/duplicate-decoy/repo/src/runtime/format-status.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/duplicate-decoy/repo/src/status-service.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/duplicate-decoy/repo/tests/status-service.test.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/usage-contract/repo/package.json`
- Create: `bench/repo-agent-prompt-experiment/fixtures/usage-contract/repo/src/producer.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/usage-contract/repo/src/normalizer.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/usage-contract/repo/src/reporter.ts`
- Create: `bench/repo-agent-prompt-experiment/fixtures/usage-contract/repo/tests/usage.test.ts`
- Test: `tests/repo-agent-prompt-experiment-fixtures.test.ts`

**Interfaces:**
- Produces four self-contained repositories whose validation command is `npm test` and whose tests are protected from mutation.
- Consumes Node 24 `--experimental-strip-types`; no package installation or external dependency.

- [ ] **Step 1: Write the fixture integrity test**

For each fixture, copy `repo/` to a managed temporary directory and execute `npm test` with the existing PowerShell helper. Assert that the initial fixture fails for its intended behavioral reason, not because of missing modules, syntax, or infrastructure. Also assert that every protected path from the manifest exists.

Expected initial failures:

| Case | Required failing assertion |
|---|---|
| `port-parser` | fractional port `4765.5` is accepted instead of rejected |
| `handler-registration` | `/admin/reload` is absent from the constructed registry |
| `duplicate-decoy` | runtime status formats `ready` as `READY` instead of `Ready` |
| `usage-contract` | reporter uses estimated output tokens instead of the producer's measured count |

Use these exact task texts and production defects:

| Case | Task text | Initial production defect | Passing behavior |
|---|---|---|---|
| `port-parser` | `Fix port parsing so only integer TCP ports from 1 through 65535 are accepted. Preserve the existing error type and run npm test.` | `parsePort` validates finiteness and range but omits `Number.isInteger`. | `4765` returns `4765`; `4765.5`, `0`, `65536`, and non-numeric text throw `InvalidPortError`. |
| `handler-registration` | `Make the constructed route registry include the existing admin reload handler without duplicating route definitions. Run npm test.` | `buildRegistry` registers only the health handler although `createAdminHandler` already exists. | Registry contains `/health` and `/admin/reload` exactly once and dispatches each existing handler. |
| `duplicate-decoy` | `Fix runtime status display casing while preserving the legacy export. Run npm test.` | `src/runtime/format-status.ts` uppercases the complete value; `src/legacy/format-status.ts` intentionally retains legacy uppercase behavior. | `StatusService.display('ready')` returns `Ready`; the protected test also proves the legacy formatter remains `READY`. |
| `usage-contract` | `Make the final usage report use the producer-measured output-token count end to end while retaining the estimate as separate data. Run npm test.` | Producer emits both counts, normalizer keeps only the estimate, and reporter therefore displays the estimate. | Normalized data retains both fields and reporter displays the measured count while the estimate remains accessible. |

- [ ] **Step 2: Run the fixture test and verify RED**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-fixtures.test.ts
```

Expected: FAIL because the fixture repositories do not exist.

- [ ] **Step 3: Create the four minimal repositories**

Each `package.json` must contain only:

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --experimental-strip-types --test tests/*.test.ts"
  }
}
```

Implement only the files listed for each fixture. The duplicate-decoy case has exactly two formatter implementations plus the service import path; the handler-registration case has exactly two handler modules plus the registry; the usage-contract case has exactly the three named pipeline modules. Tests must import production TypeScript directly, assert every passing behavior in the table, and pass after the smallest correct production change. Use the task text from the table verbatim. Protect `package.json` and the complete `tests/` directory.

- [ ] **Step 4: Prove each fixture is solvable without changing protected files**

For each fixture copy, make the minimum production-only correction manually inside the temporary copy, run `npm test`, assert PASS, and delete the copy. Do not alter the checked-in broken fixture.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-fixtures.test.ts
```

Expected: PASS, proving every checked-in fixture fails for the intended reason and every temporary corrected copy passes.

---

### Task 3: Owned workspace materialization and independent validation

**Files:**
- Create: `bench/repo-agent-prompt-experiment/workspace.ts`
- Create: `bench/repo-agent-prompt-experiment/validation.ts`
- Test: `tests/repo-agent-prompt-experiment-workspace.test.ts`

**Interfaces:**
- Produces: `ExperimentWorkspace`, `ExperimentWorkspaceFactory.create(caseId, armId, repetition)`, `ExperimentWorkspaceFactory.remove(workspace)`, `ValidationRunner.captureProtectedPaths(workspace, paths)`, and `ValidationRunner.validate(workspace, commands, baseline)`.
- Consumes: resolved fixture paths from Task 1 and `spawnPowerShellAsync` from `src/lib/powershell.ts`.

- [ ] **Step 1: Write failing safety and validation tests**

Cover unique workspace paths, complete fixture copying, SHA-256 protected-path snapshots, changed protected files causing invalidation, validation exit/output capture, multiple commands stopping at the first failure, and refusal to remove a directory without the exact experiment marker.

- [ ] **Step 2: Run the test and verify RED**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-workspace.test.ts
```

Expected: FAIL because the workspace and validator do not exist.

- [ ] **Step 3: Implement workspace ownership**

Create workspaces beneath `path.join(fs.realpathSync(os.tmpdir()), 'siftkit-repo-agent-prompt-experiment')`. Each workspace path must include sanitized experiment, case, arm, repetition, and a UUID. Write `.siftkit-experiment-workspace.json` containing those exact identities before returning the workspace.

`remove` must resolve the absolute path, require it to remain below the owned root, parse and validate the marker, verify the expected identities, and then call `fs.rmSync` only for that exact workspace. Never remove the owned root recursively.

- [ ] **Step 4: Implement independent validation**

Hash protected files recursively in stable relative-path order before repo-agent runs. After the run, re-hash them and fail validation on any addition, deletion, or content change. Execute manifest commands sequentially in the workspace, retaining exit code and a capped stdout/stderr tail for each command. A run is verified only when the public result is `completed`, protected paths are unchanged, and every validation command exits zero.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-workspace.test.ts
```

Expected: PASS.

---

### Task 4: Correct run-log correlation and transcript metrics

**Files:**
- Create: `bench/repo-agent-prompt-experiment/run-log-reader.ts`
- Create: `bench/repo-agent-prompt-experiment/metrics.ts`
- Test: `tests/repo-agent-prompt-experiment-metrics.test.ts`

**Interfaces:**
- Produces: `RunLogReader.waitForRepoAgentRun(options): Promise<MeasuredRunLog>` and `measureTranscript(runId, databaseModel, transcript): RepoAgentRunMetrics`.
- Consumes: `getRuntimeDatabasePath`, read-only `better-sqlite3`, the unique disposable `repo_root`, and timestamps supplied by the runner.

- [ ] **Step 1: Write failing regression tests from the validated investigation**

Use synthetic JSONL covering:

- database `model = null` with real `run_start.configuredModel`;
- database `model = null` with fixture configured model;
- rejected edit with `toolName='edit'`, populated `requestedCommand`, and `executedCommand=null`;
- both `Rejected:` and `Rejected command:` text fallbacks;
- two command results sharing one turn;
- preflight turns 1 through 4 with tool results only on turns 1, 2, and 4;
- successful edit, `oldText not found`, repeated read path, and exhausted read.

Required assertions:

```ts
assert.equal(metrics.preflightTurns, 4);
assert.equal(metrics.toolBearingTurns, 3);
assert.equal(metrics.maximumObservedTurn, 4);
assert.equal(metrics.editAttempts, 1);
assert.equal(metrics.rejectedToolCalls, 2);
assert.equal(metrics.effectiveModel, '3.8-real');
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-metrics.test.ts
```

Expected: FAIL because the reader and metrics module do not exist.

- [ ] **Step 3: Implement validated JSONL parsing and metrics**

Define one Zod event schema containing only consumed fields and use `.passthrough()` for retained event compatibility. Resolve command identity in this order:

```ts
const command = event.requestedCommand ?? event.executedCommand ?? event.command ?? '';
const toolName = event.toolName ?? command.trim().split(/\s+/u)[0] ?? '';
```

Treat structured `rejectionReason` or `rejectionKind` as authoritative. Use `/^Rejected(?: command)?:/u` only when structured fields are absent. Count `resultTokenCount ?? 0` for every read attempt so rejected zero-token reads remain in ordinal denominators.

- [ ] **Step 4: Implement exact run correlation**

Open `.siftkit/runtime.sqlite` read-only and poll for one row satisfying:

```sql
SELECT run_id, model, terminal_state, started_at_utc, finished_at_utc,
       repo_search_transcript_jsonl
FROM run_logs
WHERE operation_type = 'repo-agent'
  AND repo_root = ?
  AND started_at_utc >= ?
ORDER BY started_at_utc DESC, id DESC
LIMIT 2
```

Require exactly one matching row with a non-empty transcript. Two rows for one disposable workspace are an experiment-integrity failure. Stop at `runLogPollTimeoutMs` with the repo root and start timestamp in the error.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-metrics.test.ts
```

Expected: PASS.

---

### Task 5: Sequential repo-agent experiment runner

**Files:**
- Create: `bench/repo-agent-prompt-experiment/schedule.ts`
- Create: `bench/repo-agent-prompt-experiment/runner.ts`
- Test: `tests/repo-agent-prompt-experiment-runner.test.ts`

**Interfaces:**
- Produces: `buildPilotSchedule`, `buildConfirmationSchedule`, `RepoAgentPromptExperimentRunner.runPilot`, and `RepoAgentPromptExperimentRunner.runConfirmation`.
- Consumes: Tasks 1-4, `RepoAgentStartRequestSchema`, `StatusServerApiClient.requestRepoAgent`, and `SilentProgressRenderer`.

- [ ] **Step 1: Write failing schedule tests**

For four cases and four arms, assert 16 pilot entries and the cyclic arm orders:

```text
case 0: control, search-first, question-bounded, combined
case 1: search-first, question-bounded, combined, control
case 2: question-bounded, combined, control, search-first
case 3: combined, control, search-first, question-bounded
```

For confirmation, assert 24 entries for four cases, two arms, and three repetitions, with pair order alternating by `(caseIndex + repetition) % 2`.

- [ ] **Step 2: Write failing runner tests**

Use explicit test-double classes for the status client, workspace factory, validator, and run-log reader. Verify strict sequential execution, exact prompt prefix per arm, `approval: 'off'`, fixed model/maxTurns, cleanup after success and every failure branch, preservation of failed-run evidence, and no next run starting before the previous transcript has been measured.

- [ ] **Step 3: Run tests and verify RED**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-runner.test.ts
```

Expected: FAIL because scheduling and runner modules do not exist.

- [ ] **Step 4: Implement sequential execution**

For each schedule entry:

1. Create a fresh workspace and capture protected hashes.
2. Record `startedAtUtc` immediately before the request.
3. Build the request with `RepoAgentStartRequestSchema.parse`:

```ts
{
  prompt: experimentCase.task,
  repoRoot: workspace.path,
  approval: 'off',
  model: manifest.model,
  promptPrefix: composePromptPrefix(manifest, arm.id),
  maxTurns: manifest.maxTurns,
}
```

4. Await `StatusServerApiClient.requestRepoAgent` using a silent renderer.
5. Independently validate commands and protected paths even when the public result reports completion.
6. Poll and measure the inner run log by workspace path and start time.
7. Append a complete run record before removing the workspace.
8. Remove only the marked workspace in `finally`.

Do not call `buildRepoAgentServerRequest`; its current interface does not carry `promptPrefix` or `maxTurns`.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-runner.test.ts
```

Expected: PASS.

---

### Task 6: Paired analysis, promotion, and confirmation verdict

**Files:**
- Create: `bench/repo-agent-prompt-experiment/statistics.ts`
- Create: `bench/repo-agent-prompt-experiment/report.ts`
- Test: `tests/repo-agent-prompt-experiment-report.test.ts`

**Interfaces:**
- Produces: `buildPilotDecision`, `buildConfirmationDecision`, `buildExperimentArtifact`, and `renderExperimentMarkdown`.
- Consumes: measured run records from Task 5 and `persistBenchmarkRun` from `src/state/runtime-results.ts`.

- [ ] **Step 1: Write failing paired-statistic tests**

Cover median, nearest-rank p75, paired read-token ratios, zero-token denominator rejection, incomplete pair rejection, pilot promotion, tie-breaking, no-candidate outcome, and every confirmation gate from the spec.

Use exact examples:

```ts
assert.equal(median([1, 3, 8, 10]), 5.5);
assert.equal(percentileNearestRank([1, 3, 8, 10], 0.75), 8);
assert.deepEqual(buildPilotDecision(noRegressionThreeOfFour), {
  recommendedArmId: 'combined',
  reason: 'passed pilot promotion gate',
});
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-report.test.ts
```

Expected: FAIL because the statistics and report modules do not exist.

- [ ] **Step 3: Implement deterministic statistics and decisions**

Compute paired ratios per `(caseId, repetition)` before aggregating; never divide aggregate totals. Treat a control value of zero as an integrity error because a read-efficiency ratio is undefined. Apply the exact pilot and confirmation gates from the spec in their stated order and record every failed gate.

- [ ] **Step 4: Implement artifacts**

The JSON artifact must contain:

```ts
{
  schemaVersion: 1,
  experimentId,
  stage,
  startedAtUtc,
  completedAtUtc,
  manifestPath,
  manifestSha256,
  factorSha256ById,
  fixtureSha256ByCaseId,
  fixedExecutionSettings,
  schedule,
  runs,
  pairedComparisons,
  armAggregates,
  decision,
}
```

Render a Markdown table with verified completion, read calls/tokens, preflight turns, tool-bearing turns, edit success/rejection, compaction failures, and duration for every arm. Include per-case paired ratios and the exact promotion/verdict explanation. Persist the JSON via `persistBenchmarkRun` and write JSON/Markdown files below the resolved `resultRoot`.

- [ ] **Step 5: Run focused tests and verify GREEN**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-report.test.ts
```

Expected: PASS.

---

### Task 7: CLI entrypoint, validation mode, and package script

**Files:**
- Create: `bench/repo-agent-prompt-experiment/args.ts`
- Create: `bench/repo-agent-prompt-experiment/main.ts`
- Modify: `package.json`
- Test: `tests/repo-agent-prompt-experiment-cli.test.ts`

**Interfaces:**
- Produces commands `npm run benchmark:repo-agent-prompts -- --manifest .\bench\repo-agent-prompt-experiment\manifest.json --stage pilot` and `npm run benchmark:repo-agent-prompts -- --manifest .\bench\repo-agent-prompt-experiment\manifest.json --stage confirmation --pilot-result .\eval\results\repo-agent-prompt-experiment\discovery-guidance-v1\pilot.json`.
- Consumes Tasks 1-6.

- [ ] **Step 1: Write failing CLI tests**

Cover `--manifest`, `--stage pilot`, `--stage confirmation`, required `--pilot-result` for confirmation, `--validate-only`, optional repeated `--case`, optional repeated `--arm` limited to pilot diagnostics, and rejection of unknown arguments. Validation mode must read and hash every prompt/fixture without contacting the status server or creating a workspace.

- [ ] **Step 2: Run the test and verify RED**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-cli.test.ts
```

Expected: FAIL because the CLI does not exist.

- [ ] **Step 3: Implement the CLI and script**

Add:

```json
"benchmark:repo-agent-prompts": "tsx .\\bench\\repo-agent-prompt-experiment\\main.ts"
```

Before live execution, construct `StatusServerApiClient` with `{ repoAgentIdleTimeoutMs: manifest.requestTimeoutMs }`, call `getConfig()` and `listPresets()` to require a reachable server, and require `getConfiguredModel(config) === manifest.model`. Print the experiment id, stage, cases, arms, repetitions, model, maximum turns, and output directory before the first run.

Confirmation must read the pilot artifact with a Zod schema, require `decision.recommendedArmId`, and schedule only `control` plus that candidate. It must reject manifest/factor/fixture digest drift from the pilot.

- [ ] **Step 4: Run focused tests and validate the checked-in manifest**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-cli.test.ts
npm run benchmark:repo-agent-prompts -- --manifest .\bench\repo-agent-prompt-experiment\manifest.json --stage pilot --validate-only
```

Expected: tests PASS and validation prints the four arms, four cases, fixed model, and matching digests without contacting the server.

---

### Task 8: Full implementation validation

**Files:**
- Verify all files created or modified in Tasks 1-7.

- [ ] **Step 1: Run all focused experiment tests**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js repo-agent-prompt-experiment-manifest.test.ts repo-agent-prompt-experiment-fixtures.test.ts repo-agent-prompt-experiment-workspace.test.ts repo-agent-prompt-experiment-metrics.test.ts repo-agent-prompt-experiment-runner.test.ts repo-agent-prompt-experiment-report.test.ts repo-agent-prompt-experiment-cli.test.ts
```

Expected: PASS with zero failed tests and no leaked temporary directories.

- [ ] **Step 2: Run the broader validation suite**

```powershell
npm run typecheck
npm run lint
npm test
```

Expected: all commands exit zero. If unrelated pre-existing changes prevent a command from passing, record the exact failing tests/files and do not claim the implementation is fully green.

- [ ] **Step 3: Verify repository scope**

Confirm that only the files named in this plan changed, no generated experiment results are tracked, and no experiment workspace remains below the owned temporary root.

---

### Task 9: Execute the 16-run pilot

**Files:**
- Generate: `eval/results/repo-agent-prompt-experiment/discovery-guidance-v1/pilot.json`
- Generate: `eval/results/repo-agent-prompt-experiment/discovery-guidance-v1/pilot.md`

- [ ] **Step 1: Run live preflight**

Require the status server health endpoint, model inventory, manifest validation, clean fixture hashes, and an idle repo-agent queue. Do not start a pilot while another live repo-agent or repo-search operation owns the model queue.

- [ ] **Step 2: Run the pilot**

```powershell
npm run benchmark:repo-agent-prompts -- --manifest .\bench\repo-agent-prompt-experiment\manifest.json --stage pilot
```

Expected: 16 sequential terminal run records, 16 correlated inner transcripts, independent validation for every case, and no surviving workspace.

- [ ] **Step 3: Review the pilot report**

Verify every pair uses identical model/settings/fixture digests, inspect every failed validation and outlier above control p75 read tokens, and confirm the reported candidate satisfies all pilot gates. If `recommendedArmId` is null, stop the experiment and retain the built-in prompt unchanged.

---

### Task 10: Execute confirmation and issue the prompt verdict

**Files:**
- Generate: `eval/results/repo-agent-prompt-experiment/discovery-guidance-v1/confirmation.json`
- Generate: `eval/results/repo-agent-prompt-experiment/discovery-guidance-v1/confirmation.md`

- [ ] **Step 1: Run confirmation from the immutable pilot artifact**

```powershell
npm run benchmark:repo-agent-prompts -- --manifest .\bench\repo-agent-prompt-experiment\manifest.json --stage confirmation --pilot-result .\eval\results\repo-agent-prompt-experiment\discovery-guidance-v1\pilot.json
```

- [ ] **Step 2: Review all confirmation failures and paired outliers**

For every correctness difference or read-token regression, inspect the corresponding `run_logs` transcript using its stored inner run id. Classify the cause as insufficient context, search detour, repeated reads, edit failure, validation failure, provider failure, or compaction failure. Keep classifications in the confirmation artifact rather than a separate scratch file.

- [ ] **Step 3: Apply the decision rule**

If every confirmation gate passes, report the winning factor text and its measured completion/read-token/edit/compaction deltas. If any gate fails, retain the current built-in prompt and report which gate failed. Do not modify `src/repo-search/prompts.ts` as part of this plan; production prompt adoption requires a separate reviewed change.
