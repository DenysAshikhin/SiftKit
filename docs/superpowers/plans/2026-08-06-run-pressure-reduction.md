# Run Pressure Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut CPU/read/write pressure during repo-search/repo-agent runs: incremental prompt token counting, direct git spawning, quieter pending-log-peak logging, and an engine-CPU diagnosis.

**Architecture:** A new `IncrementalTokenCounter` tokenizes only the appended prompt tail per turn (full recount on any prefix change or near the budget boundary); `executeRepoCommand` routes simple `git` commands to `spawnDirectCommand` instead of PowerShell; the pending-log-peak stdout delta rises from 1 KB to 256 KB. Spec: `docs/superpowers/specs/2026-08-06-run-pressure-reduction-design.md`.

**Tech Stack:** TypeScript (Node), `node:test` via `npx tsx --test`, existing stub server helper `withTestEnvAndServer`.

---

## Repo cautions (read first)

- The repo has **unrelated uncommitted changes** from a parallel session (branch `codex/admission-ram-progress-fixes`): `src/status-server/*`, `tests/helpers/server-context-fixture.ts`, `tests/inference-runs.test.ts`, `tests/model-request-queue.test.ts`, and new files under `src/status-server/` and `tests/`. **Preserve them.** `git add` only the exact files named in each commit step.
- `tests/inference-runs.test.ts` (Task 4) is one of those dirty files. Before committing it, run `git diff tests/inference-runs.test.ts`; if hunks other than yours exist, **do not commit that file** — leave it modified and report it in the task result.
- Do not stop, start, or edit the running status server except where Task 6 explicitly says to.
- Focused test command convention: `npx tsx --test tests/<file>.test.ts`. Full checks: `npm test`, `npm run typecheck` (includes lint), `npm run lint`.

---

### Task 1: IncrementalTokenCounter

**Files:**
- Create: `src/repo-search/incremental-token-counter.ts`
- Test: `tests/incremental-token-counter.test.ts`

Background: `countTokensWithFallbackDetailed(config, text)` (`src/repo-search/prompt-budget.ts:42-68`) POSTs `text` to the engine tokenizer and falls back to a chars-per-token estimate (`source: 'estimate'`) when the server is unreachable or returns no count. The stub server helper `withTestEnvAndServer` (see `tests/token-count-source.test.ts` for the pattern) accepts `tokenizeTokenCount` as a number or a `(content: string) => number | null` function.

- [ ] **Step 1: Write the failing test**

Create `tests/incremental-token-counter.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

import { IncrementalTokenCounter } from '../src/repo-search/incremental-token-counter.js';
import type { InferenceBackendId } from '../src/config/types.js';
import type { SiftConfig } from '../src/config/index.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { asRuntimeSiftConfig } from './helpers/mock-config.js';

function activateEngine(config: SiftConfig, engine: InferenceBackendId): SiftConfig {
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Stub config has no model preset to activate.');
  }
  preset.Backend = engine;
  config.Server.ModelPresets.ActivePresetId = preset.id;
  return config;
}

// The stub counts tokens as content.length so full-vs-delta requests are
// distinguishable by both the recorded content and the returned count.
function trackingTokenizer(seen: string[]): (content: string) => number {
  return (content) => {
    seen.push(content);
    return content.length;
  };
}

test('first count tokenizes the full text', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    const result = await counter.count(config, 'alpha beta');
    assert.equal(result.tokenCount, 'alpha beta'.length);
    assert.equal(result.source, 'exl3');
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an appended tail tokenizes only the delta and sums with the cache', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta gamma');
    assert.equal(result.tokenCount, 'alpha beta gamma'.length);
    assert.equal(result.approximate, true);
    assert.deepEqual(seen, ['alpha beta', ' gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an identical text returns the cached count without tokenizing', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta');
    assert.equal(result.tokenCount, 'alpha beta'.length);
    assert.equal(result.llamaTokenCount, null);
    assert.deepEqual(seen, ['alpha beta']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('a changed prefix forces a full re-tokenize', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'ALPHA beta gamma');
    assert.equal(result.tokenCount, 'ALPHA beta gamma'.length);
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta', 'ALPHA beta gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('forceExact re-tokenizes the full text even for a pure append', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta gamma', { forceExact: true });
    assert.equal(result.tokenCount, 'alpha beta gamma'.length);
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta', 'alpha beta gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an estimate fallback never updates the cache', async () => {
  const seen: string[] = [];
  let serverUp = true;
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    serverUp = false;
    const estimated = await counter.count(config, 'alpha beta gamma');
    assert.equal(estimated.source, 'estimate');
    assert.equal(estimated.approximate, true);

    serverUp = true;
    // The cache still holds 'alpha beta', so this is a delta from that prefix.
    const recovered = await counter.count(config, 'alpha beta gamma delta');
    assert.equal(recovered.tokenCount, 'alpha beta gamma delta'.length);
    assert.deepEqual(seen, ['alpha beta', ' gamma delta']);
  }, {
    tokenizeTokenCount: (content) => {
      if (!serverUp) {
        return null;
      }
      seen.push(content);
      return content.length;
    },
  });
});

test('no config uses the estimate without caching', async () => {
  const counter = new IncrementalTokenCounter();
  const result = await counter.count(undefined, 'alpha beta');
  assert.equal(result.source, 'estimate');
  assert.equal(result.approximate, false);
  assert.equal(result.tokenCount > 0, true);
});
```

Note: if `tokenizeTokenCount: () => null` in the stub produces a different failure shape than an unreachable server (check `tests/token-count-source.test.ts:85-88` — it produces a `null` count, which `countTokensWithFallbackDetailed` treats as estimate fallback), the estimate-fallback test works as written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/incremental-token-counter.test.ts`
Expected: FAIL — cannot find module `../src/repo-search/incremental-token-counter.js`.

- [ ] **Step 3: Write the implementation**

Create `src/repo-search/incremental-token-counter.ts`:

```typescript
import type { SiftConfig } from '../config/index.js';
import {
  countTokensWithFallbackDetailed,
  estimateTokenCount,
  type TokenCountSource,
  type TokenCountWithFallbackResult,
} from './prompt-budget.js';

export type IncrementalTokenCountResult = TokenCountWithFallbackResult & {
  /** True when the count includes accumulated delta sums rather than one full tokenize. */
  approximate: boolean;
};

/**
 * Token counter for prompts that grow by appending. When the new text starts
 * with the previously counted text, only the appended tail is tokenized and
 * added to the cached count. Any other change (compaction, mid-transcript
 * rewrites) falls back to a full tokenize. Only server-sourced counts update
 * the cache, so an estimate fallback never poisons later delta sums.
 */
export class IncrementalTokenCounter {
  private lastText: string | null = null;
  private lastCount = 0;
  private lastSource: TokenCountSource = 'estimate';
  private lastApproximate = false;

  async count(
    config: SiftConfig | undefined,
    text: string,
    options: { forceExact?: boolean } = {},
  ): Promise<IncrementalTokenCountResult> {
    if (!config) {
      return { ...(await countTokensWithFallbackDetailed(undefined, text)), approximate: false };
    }
    if (!options.forceExact && this.lastText !== null && text === this.lastText) {
      return {
        tokenCount: this.lastCount,
        source: this.lastSource,
        llamaTokenCount: null,
        approximate: this.lastApproximate,
      };
    }
    if (!options.forceExact && this.lastText !== null && text.startsWith(this.lastText)) {
      const delta = await countTokensWithFallbackDetailed(config, text.slice(this.lastText.length));
      if (delta.source !== 'estimate') {
        this.lastText = text;
        this.lastCount += delta.tokenCount;
        this.lastSource = delta.source;
        this.lastApproximate = true;
        return {
          tokenCount: this.lastCount,
          source: delta.source,
          llamaTokenCount: delta.llamaTokenCount,
          approximate: true,
        };
      }
      // Server unavailable: report the estimate for the full text and keep the
      // cache as-is so the next reachable call can delta from the last good prefix.
      return {
        tokenCount: estimateTokenCount(config, text),
        source: 'estimate',
        llamaTokenCount: delta.llamaTokenCount,
        approximate: true,
      };
    }
    const full = await countTokensWithFallbackDetailed(config, text);
    if (full.source !== 'estimate') {
      this.lastText = text;
      this.lastCount = full.tokenCount;
      this.lastSource = full.source;
      this.lastApproximate = false;
    }
    return { ...full, approximate: false };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/incremental-token-counter.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/incremental-token-counter.ts tests/incremental-token-counter.test.ts
git commit -m "feat: add incremental token counter for append-only prompts"
```

---

### Task 2: Wire incremental counting into preflight and PromptPreparer

**Files:**
- Modify: `src/repo-search/prompt-budget.ts` (`preflightPlannerPromptBudget`, lines 95-158)
- Modify: `src/repo-search/engine/prompt-preparer.ts` (class fields + both preflight call sites, lines 16-32, 73-79, 133-139)
- Test: `tests/incremental-token-counter.test.ts` (add preflight integration tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/incremental-token-counter.test.ts` (add `preflightPlannerPromptBudget` and `EXACT_RECOUNT_MARGIN_TOKENS` to the imports from `../src/repo-search/prompt-budget.js`):

```typescript
import {
  EXACT_RECOUNT_MARGIN_TOKENS,
  preflightPlannerPromptBudget,
} from '../src/repo-search/prompt-budget.js';

test('preflight with counters tokenizes only the appended tail across turns', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const transcriptTokenCounter = new IncrementalTokenCounter();
    const reserveTokenCounter = new IncrementalTokenCounter();

    const first = await preflightPlannerPromptBudget({
      config,
      prompt: 'turn one',
      providerPromptReserveText: 'reserve',
      totalContextTokens: 128_000,
      responseReserveTokens: 4_000,
      transcriptTokenCounter,
      reserveTokenCounter,
    });
    assert.equal(first.transcriptPromptTokenCount, 'turn one'.length);
    assert.equal(first.providerPromptReserveTokenCount, 'reserve'.length);

    const second = await preflightPlannerPromptBudget({
      config,
      prompt: 'turn one turn two',
      providerPromptReserveText: 'reserve',
      totalContextTokens: 128_000,
      responseReserveTokens: 4_000,
      transcriptTokenCounter,
      reserveTokenCounter,
    });
    assert.equal(second.transcriptPromptTokenCount, 'turn one turn two'.length);
    assert.equal(second.providerPromptReserveTokenCount, 'reserve'.length);
    // Full prompt + reserve once, then only the appended tail; the unchanged
    // reserve text is served from cache.
    assert.deepEqual(seen, ['turn one', 'reserve', ' turn two']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('a delta-derived count near the budget forces one exact recount', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const transcriptTokenCounter = new IncrementalTokenCounter();

    const base = 'a'.repeat(500);
    const grown = base + 'b'.repeat(600);
    // maxPromptBudget = 3000; threshold = 3000 - EXACT_RECOUNT_MARGIN_TOKENS = 952.
    // The delta-derived count (1100) crosses it, so preflight must recount fully.
    assert.equal(3000 - EXACT_RECOUNT_MARGIN_TOKENS, 952);

    await preflightPlannerPromptBudget({
      config,
      prompt: base,
      totalContextTokens: 3000,
      responseReserveTokens: 0,
      transcriptTokenCounter,
    });
    const second = await preflightPlannerPromptBudget({
      config,
      prompt: grown,
      totalContextTokens: 3000,
      responseReserveTokens: 0,
      transcriptTokenCounter,
    });
    assert.equal(second.transcriptPromptTokenCount, grown.length);
    assert.deepEqual(seen, [base, 'b'.repeat(600), grown]);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('preflight without counters keeps the one-shot behavior', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    await preflightPlannerPromptBudget({
      config,
      prompt: 'turn one',
      totalContextTokens: 128_000,
      responseReserveTokens: 4_000,
    });
    await preflightPlannerPromptBudget({
      config,
      prompt: 'turn one turn two',
      totalContextTokens: 128_000,
      responseReserveTokens: 4_000,
    });
    assert.deepEqual(seen, ['turn one', 'turn one turn two']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/incremental-token-counter.test.ts`
Expected: FAIL — `EXACT_RECOUNT_MARGIN_TOKENS` is not exported and the `transcriptTokenCounter` option does not exist (TypeScript error via tsx, or assertion failures).

- [ ] **Step 3: Implement the preflight changes**

In `src/repo-search/prompt-budget.ts`, after `countTokensWithFallback` (line 70-72), add:

```typescript
/**
 * A delta-derived transcript count within this many tokens of the prompt
 * budget triggers one exact full recount before the overflow decision.
 * Delta counting drifts ≤ ~2 tokens per seam; this margin bounds a whole
 * run's drift with room to spare.
 */
export const EXACT_RECOUNT_MARGIN_TOKENS = 2048;

export type PromptTokenCounter = {
  count(
    config: SiftConfig | undefined,
    text: string,
    options?: { forceExact?: boolean },
  ): Promise<TokenCountWithFallbackResult & { approximate: boolean }>;
};

const oneShotTokenCounter: PromptTokenCounter = {
  async count(config, text) {
    return { ...(await countTokensWithFallbackDetailed(config, text)), approximate: false };
  },
};
```

In `preflightPlannerPromptBudget` (line 95), add the two optional options:

```typescript
export async function preflightPlannerPromptBudget(options: {
  config?: SiftConfig;
  prompt?: string;
  messages?: ChatMessage[];
  providerPromptReserveText?: string;
  totalContextTokens: number;
  responseReserveTokens: number;
  transcriptTokenCounter?: PromptTokenCounter;
  reserveTokenCounter?: PromptTokenCounter;
}): Promise<PreflightResult> {
```

Replace the body between the `imageTokenCount` computation (line 115-118) and the `return` (line 133) — currently lines 120-131 — with:

```typescript
  const transcriptCounter = options.transcriptTokenCounter ?? oneShotTokenCounter;
  const reserveCounter = options.reserveTokenCounter ?? oneShotTokenCounter;
  const maxPromptBudget = Math.max(totalContextTokens - responseReserveTokens, 0);

  let tokenCount = await transcriptCounter.count(options.config, promptText);
  const providerPromptReserveText = String(options.providerPromptReserveText || '').trim();
  const reserveTokenCount = providerPromptReserveText
    ? await reserveCounter.count(options.config, providerPromptReserveText)
    : null;
  const providerPromptReserveTokenCount = reserveTokenCount?.tokenCount ?? 0;

  // A delta-derived count is approximate; when it lands near the budget the
  // overflow/compaction decision needs an exact number.
  const provisionalPromptTokenCount = tokenCount.tokenCount + imageTokenCount + providerPromptReserveTokenCount;
  if (
    tokenCount.approximate
    && tokenCount.source !== 'estimate'
    && provisionalPromptTokenCount >= maxPromptBudget - EXACT_RECOUNT_MARGIN_TOKENS
  ) {
    tokenCount = await transcriptCounter.count(options.config, promptText, { forceExact: true });
  }

  const transcriptPromptTokenCount = tokenCount.tokenCount + imageTokenCount;
  const promptTokenCount = transcriptPromptTokenCount + providerPromptReserveTokenCount;
  const overflowTokens = Math.max(promptTokenCount - maxPromptBudget, 0);
  const llamaTokenCount = tokenCount.llamaTokenCount;
  const reserveLlamaTokenCount = reserveTokenCount?.llamaTokenCount ?? null;
```

The `return` block (lines 133-157) stays exactly as it is — all referenced locals keep their names. Delete the now-duplicated `const maxPromptBudget`/`const overflowTokens` lines from the old body (previous lines 128-129).

In `src/repo-search/engine/prompt-preparer.ts`:

Add the import:

```typescript
import { IncrementalTokenCounter } from '../incremental-token-counter.js';
```

Add two fields to the class (after the constructor, line 32):

```typescript
  private readonly transcriptTokenCounter = new IncrementalTokenCounter();
  private readonly reserveTokenCounter = new IncrementalTokenCounter();
```

Pass both counters at both preflight call sites — the initial one (lines 73-79) and the post-compaction one (lines 133-139):

```typescript
    let preflight = await preflightPlannerPromptBudget({
      config: preflightConfig,
      prompt,
      providerPromptReserveText,
      totalContextTokens: budget.totalContextTokens,
      responseReserveTokens: budget.responseReserveTokens,
      transcriptTokenCounter: this.transcriptTokenCounter,
      reserveTokenCounter: this.reserveTokenCounter,
    });
```

```typescript
      const afterCompaction = await preflightPlannerPromptBudget({
        config: preflightConfig,
        prompt,
        providerPromptReserveText,
        totalContextTokens: budget.totalContextTokens,
        responseReserveTokens: budget.responseReserveTokens,
        transcriptTokenCounter: this.transcriptTokenCounter,
        reserveTokenCounter: this.reserveTokenCounter,
      });
```

Compaction rewrites the transcript, so the post-compaction render fails the `startsWith` check and recounts fully — no extra invalidation code is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/incremental-token-counter.test.ts tests/token-count-source.test.ts`
Expected: PASS — the new integration tests and the untouched one-shot tests.

- [ ] **Step 5: Run adjacent suites**

Run: `npx tsx --test tests/mock-repo-search-loop.test.ts tests/engine-tool-result-budgeter.test.ts`
Expected: PASS (these exercise preflight paths).

- [ ] **Step 6: Commit**

```powershell
git add src/repo-search/prompt-budget.ts src/repo-search/engine/prompt-preparer.ts tests/incremental-token-counter.test.ts
git commit -m "feat: tokenize only the appended prompt tail per turn"
```

---

### Task 3: Direct git spawn in executeRepoCommand

**Files:**
- Modify: `src/repo-search/engine/command-execution.ts`
- Test: `tests/engine-command-execution.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine-command-execution.test.ts` (add `parseDirectSpawnCommand` to the existing import from `../src/repo-search/engine/command-execution.js`):

```typescript
test('parseDirectSpawnCommand tokenizes simple git commands', () => {
  assert.deepEqual(parseDirectSpawnCommand('git log --oneline -5'), {
    executable: 'git',
    args: ['log', '--oneline', '-5'],
  });
  assert.deepEqual(parseDirectSpawnCommand('git log --format="%H %s" -3'), {
    executable: 'git',
    args: ['log', '--format=%H %s', '-3'],
  });
  assert.deepEqual(parseDirectSpawnCommand("git grep 'two words'"), {
    executable: 'git',
    args: ['grep', 'two words'],
  });
});

test('parseDirectSpawnCommand rejects non-git and shell-dependent commands', () => {
  assert.equal(parseDirectSpawnCommand('rg -n foo'), null);
  assert.equal(parseDirectSpawnCommand('git log | head -5'), null);
  assert.equal(parseDirectSpawnCommand('git log; git status'), null);
  assert.equal(parseDirectSpawnCommand('git log > out.txt'), null);
  assert.equal(parseDirectSpawnCommand('git log $env:HOME'), null);
  assert.equal(parseDirectSpawnCommand('git commit -m "a & b"'), null);
  assert.equal(parseDirectSpawnCommand('git log "unbalanced'), null);
  assert.equal(parseDirectSpawnCommand(''), null);
});

test('executeRepoCommand runs simple git commands without a shell', async () => {
  const result = await executeRepoCommand('git --version', process.cwd(), null, 'test-run');
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /git version/u);
});

test('executeRepoCommand surfaces git stderr and exit code on the direct path', async () => {
  const result = await executeRepoCommand(
    'git rev-parse --verify definitely-not-a-ref-xyz',
    process.cwd(),
    null,
    'test-run',
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /fatal|error/iu);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/engine-command-execution.test.ts`
Expected: FAIL — `parseDirectSpawnCommand` is not exported. (The two `executeRepoCommand` git tests may pass via PowerShell; that is fine — they pin output parity for the switch.)

- [ ] **Step 3: Implement the direct spawn route**

In `src/repo-search/engine/command-execution.ts`, add imports:

```typescript
import { spawnDirectCommand } from '../../lib/command-spawn.js';
import { toStringRecord } from '../../lib/captured-command.js';
```

Add above `executeRepoCommand`:

```typescript
/** Command families safe to spawn without a shell. */
const DIRECT_SPAWN_EXECUTABLES = new Set(['git']);

/**
 * Anything that needs shell interpretation (pipes, chaining, redirects,
 * expansion) stays on the PowerShell path. Checked on the raw string, so a
 * quoted metacharacter also bails — conservative and correct either way.
 */
const SHELL_METACHARACTERS = /[|&;<>$`()\r\n]/u;

function tokenizeCommand(text: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote) {
    return null;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

export function parseDirectSpawnCommand(command: string): { executable: string; args: string[] } | null {
  const trimmed = String(command || '').trim();
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed)) {
    return null;
  }
  const tokens = tokenizeCommand(trimmed);
  const firstToken = tokens?.[0];
  if (!tokens || !firstToken) {
    return null;
  }
  const executable = firstToken.toLowerCase();
  if (!DIRECT_SPAWN_EXECUTABLES.has(executable)) {
    return null;
  }
  return { executable, args: tokens.slice(1) };
}
```

In `executeRepoCommand`, replace the tail (lines 68-75):

```typescript
  const direct = parseDirectSpawnCommand(command);
  if (direct) {
    return spawnDirectCommand(direct.executable, direct.args, {
      cwd: repoRoot,
      abortSignal,
      env: { ...toStringRecord(process.env), [AGENT_RUN_ID_ENV]: agentRunId },
    }).then((result) => ({
      exitCode: result.exitCode,
      output: result.output,
    }));
  }

  return spawnPowerShellAsync(command, {
    cwd: repoRoot,
    env: { [AGENT_RUN_ID_ENV]: agentRunId },
  }).then((result) => ({
    exitCode: result.exitCode,
    output: result.output,
  }));
```

Note: `DirectCommandOptions.env` is a full replacement (`src/lib/command-spawn.ts:10-15`), so the merge with `toStringRecord(process.env)` is required — it mirrors `spawnPowerShellAsync` (`src/lib/powershell.ts:76`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/engine-command-execution.test.ts`
Expected: PASS (all tests, old and new).

- [ ] **Step 5: Commit**

```powershell
git add src/repo-search/engine/command-execution.ts tests/engine-command-execution.test.ts
git commit -m "feat: spawn simple git commands directly instead of via PowerShell"
```

---

### Task 4: Raise the pending_log_peak delta to 256 KB

**Files:**
- Modify: `src/state/inference-runs.ts:51` (`PENDING_LOG_PEAK_MIN_STREAM_CHARACTER_DELTA`)
- Test: `tests/inference-runs.test.ts` (peak-logging test around lines 130-153) — **dirty file, see Repo cautions**

- [ ] **Step 1: Update the test to expect the new threshold**

In `tests/inference-runs.test.ts`, the peak test currently buffers `'a'.repeat(1023)`, `'b'`, `'c'.repeat(1023)`, `'d'` and expects peaks at 1024 and 2048. Change only those literals:

```typescript
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'a'.repeat(262_143) });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'b' });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'c'.repeat(262_143) });
      bufferInferenceRunLogChunk({ runId: run.id, streamKind: 'engine_stdout', chunkText: 'd' });
```

```typescript
        `inference_run pending_log_peak run_id=${run.id} pending_chars=262144 stream=engine_stdout stream_chars=262144`,
        `inference_run pending_log_peak run_id=${run.id} pending_chars=524288 stream=engine_stdout stream_chars=524288`,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/inference-runs.test.ts`
Expected: FAIL — peaks still fire at every 1024-char delta, so the expected two-line list does not match.

- [ ] **Step 3: Raise the constant**

In `src/state/inference-runs.ts:51`:

```typescript
const PENDING_LOG_PEAK_MIN_STREAM_CHARACTER_DELTA = 256 * 1024;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/inference-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (conditional)**

Run `git diff tests/inference-runs.test.ts`. If the only hunks are yours from Step 1:

```powershell
git add src/state/inference-runs.ts tests/inference-runs.test.ts
git commit -m "feat: raise pending_log_peak stdout delta to 256 KB"
```

If unrelated hunks exist (expected — a parallel session modified this file), commit only the source file and report the test file as intentionally left uncommitted:

```powershell
git add src/state/inference-runs.ts
git commit -m "feat: raise pending_log_peak stdout delta to 256 KB"
```

---

### Task 5: Engine CPU diagnosis (no code changes)

**Files:** none modified. Output: a findings section in the completion report.

- [ ] **Step 1: Measure idle CPU**

Wait for the run queue to drain (server console shows no active runs; `nvidia-smi` GPU util near 0). Then:

```powershell
$p = Get-Process -Name python | Sort-Object WorkingSet64 -Descending | Select-Object -First 1
$c0 = $p.CPU; $t0 = Get-Date; Start-Sleep -Seconds 60; $p.Refresh()
"idle cores: " + [math]::Round(($p.CPU - $c0) / ((Get-Date) - $t0).TotalSeconds, 2)
"threads: " + $p.Threads.Count
```

Expected insight: idle cores ≈ 0 means the ~4.8 cores are generation-only (thread pool / sampling); idle cores > 1 means a busy-wait loop independent of load.

- [ ] **Step 2: Measure generating CPU**

Dispatch one small run (`siftkit repo-search "list the files in src/lib"`), then repeat the 60-second sample while it generates. Record cores and `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader`.

- [ ] **Step 3: Inspect launcher thread configuration**

Find where the engine process env is built (search `src` for the exl3 launcher's `spawn`/`env` construction, e.g. `rg -n "OMP_NUM_THREADS|num_threads|torch" src`). Record whether any thread caps are set today.

- [ ] **Step 4: Write up the diagnosis**

In the completion report state: idle vs generating cores, thread count, whether launcher sets caps, and the proposed fix (e.g. `OMP_NUM_THREADS`/`torch.set_num_threads` cap in the launcher env) with expected impact. Do not modify the launcher.

---

### Task 6: Full verification and live before/after measurement

**Files:** none modified.

- [ ] **Step 1: Full checks**

```powershell
npm run typecheck
npm run lint
npm test
```

Expected: all green. Report any pre-existing failures from the parallel session's dirty files separately from failures caused by this plan.

- [ ] **Step 2: Rebuild and restart the status server (user has authorized restarts)**

```powershell
npm run build
```

Then restart the running status server process the same way it was started (`npm run start:status:stable` chain). Confirm it comes up and the dashboard responds.

- [ ] **Step 3: Live measurement**

Run `siftkit repo-search` with a small prompt against this repo. In the server console verify:
- `preflight ... tokenize=` times stay flat across turns instead of growing (t2+ tokenizes only the tail).
- No `pending_log_peak` line spam (at most one line per 256 KB of engine output).
- git commands issued by the run do not spawn `powershell.exe` (spot-check with `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"` while the run executes git).

- [ ] **Step 4: Report**

State result, changed files, validation evidence (test output, measurements), and risks.

---

## Self-review notes

- Spec coverage: item 1 → Tasks 1-2; item 2 → Task 3; item 3 → Task 4; item 4 → Task 5; testing/success criteria → Tasks 1-4 steps + Task 6.
- Types used in Task 2 (`PromptTokenCounter`, `approximate`) match Task 1's `IncrementalTokenCountResult`.
- `EXACT_RECOUNT_MARGIN_TOKENS` is exported once (Task 2) and imported only in tests.
