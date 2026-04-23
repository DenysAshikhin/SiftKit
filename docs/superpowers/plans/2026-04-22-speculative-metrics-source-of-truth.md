# Speculative Metrics Source Of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make speculative accepted/generated token metrics come only from managed-llama log delta persistence, with `null` when no managed-log delta exists for a request.

**Architecture:** Keep `run_logs.speculative_accepted_tokens` and `run_logs.speculative_generated_tokens` as the single canonical store, but restrict population to the `/status` managed-log-delta path. Remove all artifact/request/repo fallback logic in dashboard run-log canonicalization so benchmark and dashboard consumers keep reading one trustworthy source.

**Tech Stack:** TypeScript, node:test, better-sqlite3, existing status-server runtime DB and managed-llama telemetry pipeline

---

### Task 1: Lock The Broken Fallback With A Failing Integration Test

**Files:**
- Modify: `tests/status-server-speculative-metrics.test.ts`
- Test: `tests/status-server-speculative-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```js
test('dashboard runs keep speculative totals null when only artifact payloads provide them', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeRoot = path.join(tempRoot, '.siftkit');
    const runtimeDbPath = path.join(runtimeRoot, 'runtime.sqlite');
    const logsRoot = path.join(runtimeRoot, 'logs');
    const requestsRoot = path.join(logsRoot, 'requests');
    const repoSearchPassRoot = path.join(logsRoot, 'repo_search', 'succesful');
    const requestId = 'repo-run-artifact-only-speculative';

    fs.mkdirSync(requestsRoot, { recursive: true });
    fs.mkdirSync(repoSearchPassRoot, { recursive: true });

    const database = new Database(runtimeDbPath);
    try {
      upsertRepoSearchRun({
        database,
        requestId,
        taskKind: 'repo-search',
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        model: 'mock-model',
        requestMaxTokens: 512,
        maxTurns: 2,
        transcriptText: '',
        artifactPayload: { requestId, prompt: 'find speculative metrics', repoRoot: tempRoot },
        terminalState: 'completed',
        startedAtUtc: '2026-04-22T17:00:00.000Z',
        finishedAtUtc: '2026-04-22T17:00:30.000Z',
        requestDurationMs: 30000,
        promptTokens: 10,
        outputTokens: 5,
        thinkingTokens: 2,
        toolTokens: 1,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
        speculativeAcceptedTokens: null,
        speculativeGeneratedTokens: null,
      });

      fs.writeFileSync(path.join(requestsRoot, `request_${requestId}.json`), JSON.stringify({
        requestId,
        question: 'find speculative metrics',
        createdAtUtc: '2026-04-22T17:00:00.000Z',
        speculativeAcceptedTokens: 47,
        speculativeGeneratedTokens: 47,
        promptCacheTokens: 3,
        promptEvalTokens: 7,
      }, null, 2));

      fs.writeFileSync(path.join(repoSearchPassRoot, `request_${requestId}.json`), JSON.stringify({
        requestId,
        prompt: 'find speculative metrics',
        repoRoot: tempRoot,
        createdAtUtc: '2026-04-22T17:00:00.000Z',
        totals: {
          promptTokens: 10,
          outputTokens: 5,
          thinkingTokens: 2,
          promptCacheTokens: 3,
          promptEvalTokens: 7,
          speculativeAcceptedTokens: 11,
          speculativeGeneratedTokens: 11,
        },
      }, null, 2));

      const flushed = flushRunArtifactsToDbAndDelete({
        database,
        requestId,
        terminalState: 'completed',
        taskKind: 'repo-search',
      });
      assert.equal(flushed, true);
    } finally {
      database.close();
    }

    const verifyDb = new Database(runtimeDbPath);
    try {
      const runs = queryDashboardRunsFromDb(verifyDb);
      const run = runs.find((entry) => entry.id === requestId);
      assert.equal(run?.speculativeAcceptedTokens, null);
      assert.equal(run?.speculativeGeneratedTokens, null);

      const detail = queryDashboardRunDetailFromDb(verifyDb, requestId);
      assert.equal(detail?.run.speculativeAcceptedTokens, null);
      assert.equal(detail?.run.speculativeGeneratedTokens, null);
    } finally {
      verifyDb.close();
    }
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm run build
npx tsx --test .\tests\status-server-speculative-metrics.test.ts --test-name-pattern "dashboard runs keep speculative totals null when only artifact payloads provide them"
```

Expected: FAIL because the current flush path fills speculative metrics from artifact/request fallback values instead of leaving them `null`.

### Task 2: Remove Artifact Fallback And Keep Persisted Metrics Canonical

**Files:**
- Modify: `src/status-server/dashboard-runs.ts`
- Test: `tests/status-server-speculative-metrics.test.ts`

- [ ] **Step 1: Update canonical speculative metric resolution**

Replace the fallback-capable helper with a persisted-only helper:

```ts
function resolveCanonicalRunLogSpeculativeMetrics(options: {
  database: DatabaseInstance;
  requestId: string;
}): { speculativeAcceptedTokens: number | null; speculativeGeneratedTokens: number | null } {
  return readPersistedRunLogSpeculativeMetrics(options.database, options.requestId);
}
```

- [ ] **Step 2: Remove speculative fallback arguments at the summary/artifact call site**

Update the artifact upsert path:

```ts
  const canonicalSpeculativeMetrics = resolveCanonicalRunLogSpeculativeMetrics({
    database: options.database,
    requestId,
  });
```

This replaces:

```ts
  const canonicalSpeculativeMetrics = resolveCanonicalRunLogSpeculativeMetrics({
    database: options.database,
    requestId,
    fallbackAcceptedTokens: options.artifactPayload?.speculativeAcceptedTokens,
    fallbackGeneratedTokens: options.artifactPayload?.speculativeGeneratedTokens,
  });
```

- [ ] **Step 3: Remove speculative fallback arguments at the repo-search flush call site**

Update the run-log flush path:

```ts
  const canonicalSpeculativeMetrics = resolveCanonicalRunLogSpeculativeMetrics({
    database: options.database,
    requestId: options.requestId,
  });
```

This replaces:

```ts
  const canonicalSpeculativeMetrics = resolveCanonicalRunLogSpeculativeMetrics({
    database: options.database,
    requestId: options.requestId,
    fallbackAcceptedTokens: requestPayload?.speculativeAcceptedTokens ?? failedRequestPayload?.speculativeAcceptedTokens ?? repoTotals?.speculativeAcceptedTokens ?? null,
    fallbackGeneratedTokens: requestPayload?.speculativeGeneratedTokens ?? failedRequestPayload?.speculativeGeneratedTokens ?? repoTotals?.speculativeGeneratedTokens ?? null,
  });
```

- [ ] **Step 4: Run the focused tests to verify green**

Run:

```powershell
npm run build
npx tsx --test .\tests\status-server-speculative-metrics.test.ts --test-name-pattern "dashboard runs keep speculative totals null when only artifact payloads provide them|dashboard runs keep persisted speculative totals when artifact payloads disagree|real status server uses managed llama cumulative speculative delta for repo-search run logs"
```

Expected: PASS for the new null-behavior test and the existing persisted-managed-log regression tests.

- [ ] **Step 5: Commit**

```powershell
git add tests/status-server-speculative-metrics.test.ts src/status-server/dashboard-runs.ts
git commit -m "fix: use managed llama metrics as speculative source of truth"
```

### Task 3: Verify Benchmark Consumers Still Derive Acceptance From Persisted Run Metrics

**Files:**
- Test: `tests/benchmark-spec-settings.test.ts`

- [ ] **Step 1: Run the benchmark helper regression tests**

Run:

```powershell
npm run build
npx tsx --test .\tests\benchmark-spec-settings.test.ts .\tests\status-server-speculative-metrics.test.ts
```

Expected: PASS, confirming `getRunTelemetryStats(...)` still derives acceptance strictly from `run.speculativeAcceptedTokens / run.speculativeGeneratedTokens`, which are now managed-log-only or `null`.

- [ ] **Step 2: Optional manual sanity-check the benchmark**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\.tmp\run-spec-bench-ordered-safe.ps1
```

Expected:
- speculative cases no longer show false `1.0` acceptance values caused by artifact fallback
- runs without managed-log speculative delta show `null` acceptance instead of synthetic ratios

- [ ] **Step 3: Commit any validation-only note if code changed during follow-up fixes**

```powershell
git status --short
```

Expected: no additional tracked code changes beyond the source/test files from Task 2 unless the benchmark smoke exposed a real regression that required another TDD cycle.
