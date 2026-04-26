# Chars-Per-Token Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the distorted status-metric-based chars-per-token calibration with a weighted observed-budget model fed only by exact char-to-token measurements.

**Architecture:** Keep `getEffectiveInputCharactersPerContextToken(...)` as the single read surface, but move its backing calibration source to persisted weighted totals in `observed_budget_state`. Add one central recorder for exact observations, feed it from `/tokenize` and exact provider prompt-token responses, and stop deriving chars-per-token from status snapshot aggregate metrics.

**Tech Stack:** TypeScript, node:test, better-sqlite3, existing runtime SQLite schema/migrations, llama.cpp provider integration

---

### Task 1: Lock The New Calibration Rules With Failing Tests

**Files:**
- Modify: `tests/runtime-loadconfig.test.ts`
- Modify: `tests/runtime-provider-llama.test.ts`
- Test: `tests/runtime-loadconfig.test.ts`
- Test: `tests/runtime-provider-llama.test.ts`

- [ ] **Step 1: Write the failing load-config tests for weighted observed-budget state**

Add these tests near the existing chars-per-token coverage in `tests/runtime-loadconfig.test.ts`:

```js
test('loadConfig uses weighted observed-budget totals instead of status snapshot telemetry once exact observations exist', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
      const database = new Database(runtimeDbPath);
      try {
        database.prepare(`
          INSERT INTO observed_budget_state (
            id,
            observed_telemetry_seen,
            last_known_chars_per_token,
            observed_chars_total,
            observed_tokens_total,
            updated_at_utc
          ) VALUES (1, 1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            observed_telemetry_seen = excluded.observed_telemetry_seen,
            last_known_chars_per_token = excluded.last_known_chars_per_token,
            observed_chars_total = excluded.observed_chars_total,
            observed_tokens_total = excluded.observed_tokens_total,
            updated_at_utc = excluded.updated_at_utc
        `).run(2.75, 2750, 1000, '2026-04-25T16:00:00.000Z');
      } finally {
        database.close();
      }

      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ObservedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.75);
      assert.equal(config.Effective.ObservedTelemetrySeen, true);
    }, {
      metrics: {
        inputCharactersTotal: 10,
        inputTokensTotal: 5000,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});

test('loadConfig ignores legacy observed-budget rows without weighted totals and stays on bootstrap until an exact observation exists', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
      const database = new Database(runtimeDbPath);
      try {
        database.prepare(`
          INSERT INTO observed_budget_state (id, observed_telemetry_seen, last_known_chars_per_token, updated_at_utc)
          VALUES (1, 1, 0.07915126409690375, '2026-04-25T16:00:00.000Z')
          ON CONFLICT(id) DO UPDATE SET
            observed_telemetry_seen = excluded.observed_telemetry_seen,
            last_known_chars_per_token = excluded.last_known_chars_per_token,
            updated_at_utc = excluded.updated_at_utc
        `).run();
      } finally {
        database.close();
      }

      const config = await loadConfig({ ensure: true });
      assert.equal(config.Effective.BudgetSource, 'ColdStartFixedCharsPerToken');
      assert.equal(config.Effective.InputCharactersPerContextToken, 2.5);
      assert.equal(config.Effective.ObservedTelemetrySeen, false);
    }, {
      metrics: {
        inputCharactersTotal: 999999,
        inputTokensTotal: 1,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});
```

- [ ] **Step 2: Write the failing provider tests for exact observation recording**

Add these tests to `tests/runtime-provider-llama.test.ts`:

```js
test('llama.cpp tokenize updates observed-budget weighted totals from exact char-token counts', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const tokenCount = await countLlamaCppTokens(config, 'A'.repeat(1234));
      assert.equal(tokenCount, 1234);

      const database = new Database(path.join(tempRoot, '.siftkit', 'runtime.sqlite'));
      try {
        const row = database.prepare(`
          SELECT observed_telemetry_seen, last_known_chars_per_token, observed_chars_total, observed_tokens_total
          FROM observed_budget_state
          WHERE id = 1
        `).get();
        assert.equal(row.observed_telemetry_seen, 1);
        assert.equal(row.observed_chars_total, 1234);
        assert.equal(row.observed_tokens_total, 1234);
        assert.equal(row.last_known_chars_per_token, 1);
      } finally {
        database.close();
      }
    }, {
      tokenizeCharsPerToken: 1,
    });
  });
});

test('llama.cpp chat responses update observed-budget weighted totals from exact prompt token counts', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const prompt = 'B'.repeat(500);
      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt,
        timeoutSeconds: 5,
      });

      const database = new Database(path.join(tempRoot, '.siftkit', 'runtime.sqlite'));
      try {
        const row = database.prepare(`
          SELECT observed_chars_total, observed_tokens_total, last_known_chars_per_token
          FROM observed_budget_state
          WHERE id = 1
        `).get();
        assert.equal(row.observed_chars_total, 500);
        assert.equal(row.observed_tokens_total, 123);
        assert.equal(row.last_known_chars_per_token, 500 / 123);
      } finally {
        database.close();
      }
    }, {
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
      },
    });
  });
});

test('estimated token fallback does not mutate observed-budget state', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'C'.repeat(500),
        timeoutSeconds: 5,
      });
      assert.match(summary.text, /^summary:/u);

      const database = new Database(path.join(tempRoot, '.siftkit', 'runtime.sqlite'));
      try {
        const row = database.prepare(`
          SELECT observed_telemetry_seen, observed_chars_total, observed_tokens_total
          FROM observed_budget_state
          WHERE id = 1
        `).get();
        assert.equal(row?.observed_telemetry_seen ?? 0, 0);
        assert.equal(row?.observed_chars_total ?? null, null);
        assert.equal(row?.observed_tokens_total ?? null, null);
      } finally {
        database.close();
      }
    }, {
      omitUsage: true,
    });
  });
});
```

- [ ] **Step 3: Run the focused tests to verify red**

Run:

```powershell
npm run build
npx tsx --test .\tests\runtime-loadconfig.test.ts .\tests\runtime-provider-llama.test.ts --test-name-pattern "weighted observed-budget|legacy observed-budget|tokenize updates observed-budget|chat responses update observed-budget|estimated token fallback"
```

Expected: FAIL because `observed_budget_state` does not yet have weighted-total columns, `loadConfig()` still reads status telemetry, and provider/tokenize paths do not record observations or distinguish exact-vs-estimated sources.

- [ ] **Step 4: Commit the red tests**

```powershell
git add tests/runtime-loadconfig.test.ts tests/runtime-provider-llama.test.ts
git commit -m "test: lock weighted chars-per-token calibration behavior"
```

### Task 2: Extend Observed-Budget Persistence For Weighted Totals

**Files:**
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/observed-budget.ts`
- Modify: `src/status-server/runtime-cutover.ts`
- Test: `tests/runtime-loadconfig.test.ts`

- [ ] **Step 1: Extend the runtime DB schema**

Update `src/state/runtime-db.ts` so `observed_budget_state` includes weighted totals:

```ts
CREATE TABLE IF NOT EXISTS observed_budget_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  observed_telemetry_seen INTEGER NOT NULL CHECK (observed_telemetry_seen IN (0, 1)),
  last_known_chars_per_token REAL,
  observed_chars_total REAL,
  observed_tokens_total REAL,
  updated_at_utc TEXT
);
```

Add a schema migration that `ALTER TABLE`s existing databases to add:

```ts
observed_chars_total REAL
observed_tokens_total REAL
```

and bump `CURRENT_SCHEMA_VERSION`.

- [ ] **Step 2: Extend the observed-budget state type and normalization**

Update `src/state/observed-budget.ts`:

```ts
export type ObservedBudgetState = {
  observedTelemetrySeen: boolean;
  lastKnownCharsPerToken: number | null;
  observedCharsTotal: number | null;
  observedTokensTotal: number | null;
  updatedAtUtc: string | null;
};
```

Normalize weighted totals only when both are finite and positive:

```ts
const observedCharsTotal = Number(parsed.observedCharsTotal);
const observedTokensTotal = Number(parsed.observedTokensTotal);
const hasWeightedTotals = Number.isFinite(observedCharsTotal) && observedCharsTotal > 0
  && Number.isFinite(observedTokensTotal) && observedTokensTotal > 0;

return {
  observedTelemetrySeen: hasWeightedTotals,
  lastKnownCharsPerToken: hasWeightedTotals ? (observedCharsTotal / observedTokensTotal) : null,
  observedCharsTotal: hasWeightedTotals ? observedCharsTotal : null,
  observedTokensTotal: hasWeightedTotals ? observedTokensTotal : null,
  updatedAtUtc: typeof parsed.updatedAtUtc === 'string' && parsed.updatedAtUtc.trim() ? parsed.updatedAtUtc : null,
};
```

- [ ] **Step 3: Add the authoritative recorder**

Add a single update helper in `src/state/observed-budget.ts`:

```ts
export function recordAccurateCharTokenObservation(options: {
  chars: number;
  tokens: number;
  updatedAtUtc?: string;
}): void {
  const chars = Number(options.chars);
  const tokens = Number(options.tokens);
  if (!Number.isFinite(chars) || chars <= 0 || !Number.isFinite(tokens) || tokens <= 0) {
    return;
  }

  const previous = readObservedBudgetState();
  const observedCharsTotal = (previous.observedCharsTotal ?? 0) + chars;
  const observedTokensTotal = (previous.observedTokensTotal ?? 0) + tokens;
  writeObservedBudgetState({
    observedTelemetrySeen: true,
    lastKnownCharsPerToken: observedCharsTotal / observedTokensTotal,
    observedCharsTotal,
    observedTokensTotal,
    updatedAtUtc: options.updatedAtUtc ?? new Date().toISOString(),
  });
}
```

Keep `tryRecordAccurateCharTokenObservation(...)` as the non-fatal wrapper for production call sites.

- [ ] **Step 4: Keep legacy import backward-compatible without seeding the new model**

Update `src/status-server/runtime-cutover.ts` so legacy `metrics/observed-budget.json` import still succeeds, but legacy rows without weighted totals remain uninitialized for the new model:

```ts
function importLegacyObservedBudget(runtimeRoot: string): void {
  const legacyPath = path.join(runtimeRoot, 'metrics', 'observed-budget.json');
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  const payload = readLegacyJsonObject(legacyPath);
  writeObservedBudgetState(normalizeObservedBudgetState(payload));
  fs.rmSync(legacyPath, { force: true });
}
```

The behavior change comes from `normalizeObservedBudgetState(...)`, not a special-case cutover branch.

- [ ] **Step 5: Run the focused state/config tests to verify green**

Run:

```powershell
npm run build
npx tsx --test .\tests\runtime-loadconfig.test.ts --test-name-pattern "bootstrap chars-per-token|weighted observed-budget|legacy observed-budget"
```

Expected: PASS for bootstrap fallback, weighted-state usage, and legacy-row fallback behavior.

- [ ] **Step 6: Commit the persistence layer**

```powershell
git add src/state/runtime-db.ts src/state/observed-budget.ts src/status-server/runtime-cutover.ts tests/runtime-loadconfig.test.ts
git commit -m "feat: persist weighted chars-per-token observations"
```

### Task 3: Feed Exact Tokenize Observations Into The Weighted Model

**Files:**
- Modify: `src/providers/llama-cpp.ts`
- Test: `tests/runtime-provider-llama.test.ts`

- [ ] **Step 1: Record exact `/tokenize` counts**

Update `countLlamaCppTokens(...)` in `src/providers/llama-cpp.ts` to record exact observations when the response contains an exact token count:

```ts
const explicitCount = getUsageValue(response.body.count)
  ?? getUsageValue(response.body.token_count)
  ?? getUsageValue(response.body.n_tokens);
if (explicitCount !== null) {
  tryRecordAccurateCharTokenObservation({
    chars: content.length,
    tokens: explicitCount,
    updatedAtUtc: new Date().toISOString(),
  });
  traceLlamaCpp(`tokenize done elapsed_ms=${Date.now() - startedAt} tokens=${explicitCount}`);
  return explicitCount;
}
```

Also record when the endpoint returns a token array:

```ts
const arrayCount = response.body.tokens.length;
tryRecordAccurateCharTokenObservation({
  chars: content.length,
  tokens: arrayCount,
  updatedAtUtc: new Date().toISOString(),
});
return arrayCount;
```

- [ ] **Step 2: Keep null/error paths non-mutating**

Do not record observations for:

```ts
if (response.statusCode >= 400) {
  return null;
}

if (!Array.isArray(response.body.tokens)) {
  return null;
}
```

The recorder must only run on exact successful counts.

- [ ] **Step 3: Run the tokenize-focused tests**

Run:

```powershell
npm run build
npx tsx --test .\tests\runtime-provider-llama.test.ts --test-name-pattern "count-only tokenize responses|tokenize updates observed-budget"
```

Expected: PASS, confirming exact `/tokenize` counts both return the right number and update weighted persisted totals.

- [ ] **Step 4: Commit the tokenize producer**

```powershell
git add src/providers/llama-cpp.ts tests/runtime-provider-llama.test.ts
git commit -m "feat: calibrate chars-per-token from tokenize results"
```

### Task 4: Feed Exact Provider Prompt Tokens And Switch Reads To Weighted Calibration

**Files:**
- Modify: `src/providers/llama-cpp.ts`
- Modify: `src/config/effective.ts`
- Modify: `tests/runtime-provider-llama.test.ts`
- Modify: `tests/runtime-loadconfig.test.ts`
- Test: `tests/runtime-provider-llama.test.ts`
- Test: `tests/runtime-loadconfig.test.ts`

- [ ] **Step 1: Record exact provider prompt-token observations**

In `generateLlamaCppChatResponse(...)`, after parsing `usage`, record exact prompt-token observations only when `usage.promptTokens` is finite and positive:

```ts
const promptTokens = getUsageValue(response.body.usage?.prompt_tokens);
if (promptTokens !== null && promptTokens > 0) {
  tryRecordAccurateCharTokenObservation({
    chars: promptChars,
    tokens: promptTokens,
    updatedAtUtc: new Date().toISOString(),
  });
}
```

Use the exact prompt text length already computed here:

```ts
const promptChars = options.messages.reduce((total, message) => {
  return total + getTextContent(message.content).length;
}, 0);
```

- [ ] **Step 2: Remove status-snapshot-derived chars-per-token calibration**

Refactor `src/config/effective.ts` so `resolveInputCharactersPerContextToken()` reads only persisted weighted observed-budget state:

```ts
export async function resolveInputCharactersPerContextToken(): Promise<{ value: number; budgetSource: string }> {
  const persistedState = readObservedBudgetState();
  if (
    persistedState.observedTelemetrySeen
    && Number.isFinite(persistedState.observedCharsTotal)
    && Number(persistedState.observedCharsTotal) > 0
    && Number.isFinite(persistedState.observedTokensTotal)
    && Number(persistedState.observedTokensTotal) > 0
  ) {
    return {
      value: Number(persistedState.observedCharsTotal) / Number(persistedState.observedTokensTotal),
      budgetSource: 'ObservedCharsPerToken',
    };
  }

  return {
    value: SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN,
    budgetSource: 'ColdStartFixedCharsPerToken',
  };
}
```

Delete the status-snapshot-derived helper and its `MissingObservedBudgetError` branch from this path.

- [ ] **Step 3: Add the weighted-average regression**

Add a provider-side regression showing weighted accumulation rather than overwrite:

```js
test('exact char-token observations accumulate as a weighted average', async () => {
  await withTempEnv(async (tempRoot) => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      await countLlamaCppTokens(config, 'A'.repeat(100));
      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'B'.repeat(500),
        timeoutSeconds: 5,
      });

      const database = new Database(path.join(tempRoot, '.siftkit', 'runtime.sqlite'));
      try {
        const row = database.prepare(`
          SELECT observed_chars_total, observed_tokens_total, last_known_chars_per_token
          FROM observed_budget_state
          WHERE id = 1
        `).get();
        assert.equal(row.observed_chars_total, 600);
        assert.equal(row.observed_tokens_total, 223);
        assert.equal(row.last_known_chars_per_token, 600 / 223);
      } finally {
        database.close();
      }
    }, {
      tokenizeCharsPerToken: 1,
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
      },
    });
  });
});
```

- [ ] **Step 4: Run the focused config/provider tests**

Run:

```powershell
npm run build
npx tsx --test .\tests\runtime-loadconfig.test.ts .\tests\runtime-provider-llama.test.ts --test-name-pattern "weighted observed-budget|legacy observed-budget|tokenize updates observed-budget|chat responses update observed-budget|weighted average|estimated token fallback"
```

Expected: PASS, confirming bootstrap fallback before first observation, weighted reads after exact observations, exact producer updates from both tokenize and provider paths, and no mutation on estimate-only fallback paths.

- [ ] **Step 5: Commit the read-path and provider-path switch**

```powershell
git add src/providers/llama-cpp.ts src/config/effective.ts tests/runtime-provider-llama.test.ts tests/runtime-loadconfig.test.ts
git commit -m "feat: derive chars-per-token from exact observed counts"
```

### Task 5: Run The Targeted Regression Suite

**Files:**
- Test: `tests/runtime-loadconfig.test.ts`
- Test: `tests/runtime-provider-llama.test.ts`
- Test: `tests/runtime-summarize.test.ts`
- Test: `tests/runtime-planner-token-aware.test.ts`

- [ ] **Step 1: Run the calibration-focused suite**

Run:

```powershell
npm run build
npx tsx --test .\tests\runtime-loadconfig.test.ts .\tests\runtime-provider-llama.test.ts
```

Expected: PASS, confirming config loading, provider usage parsing, exact tokenize handling, and weighted observed-budget persistence all remain green.

- [ ] **Step 2: Run the summary/planner regressions that consume chars-per-token**

Run:

```powershell
npm run build
npx tsx --test .\tests\runtime-summarize.test.ts .\tests\runtime-planner-token-aware.test.ts --test-name-pattern "planner activation threshold|summary keeps oversized llama.cpp requests on planner mode|summary hands oversized llama.cpp requests to planner mode"
```

Expected: PASS, confirming chunk threshold and planner activation continue to work with the new calibration source.

- [ ] **Step 3: Inspect for unintended file changes**

Run:

```powershell
git status --short
```

Expected: only the intended source/test files are modified.

- [ ] **Step 4: Commit the final verified implementation**

```powershell
git add src/state/runtime-db.ts src/state/observed-budget.ts src/status-server/runtime-cutover.ts src/providers/llama-cpp.ts src/config/effective.ts tests/runtime-loadconfig.test.ts tests/runtime-provider-llama.test.ts
git commit -m "fix: calibrate chars-per-token from exact observations"
```
