# SiftKit Log-Audit Defect Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three defects found by auditing `.siftkit/runtime.sqlite` run logs: web tools bypass the `WebSearch` config gate, aborted runs score `verdict=pass`, and rejected tool calls emit no `turn_command_result` transcript event.

**Architecture:** Three independent vertical slices, one per defect, each landing behind its own tests. Defect 1 adds a single web-tool policy module consulted at the one choke point where `SiftConfig` is guaranteed in scope (`executeRepoSearchRequest`), plus an explicit `webToolsEnabled` request field so chat's per-session override still wins. Defect 2 promotes the loose `reason: string` to a closed `TaskEndReason` enum and makes `passed` require `reason === 'finish'`. Defect 3 routes every tool-call rejection through one logging seam that emits a `turn_command_result` event carrying `rejected: true` and `exitCode: null`.

**Tech Stack:** TypeScript (strict; no `any`, no type assertions, no non-null assertions), Zod via `src/lib/zod.js`, `node:test` run through `npm run build:test && node ./dist/test-runner/run-tests.js <basename>`.

---

## Background: what the audit found

Read this before starting. All three defects were confirmed against real log data in `.siftkit/runtime.sqlite` (`run_logs.repo_search_transcript_jsonl`, 340 runs, 584 executed tool calls).

1. **Web tools bypass the config gate.** `WebSearch.EnabledDefault` is read in exactly one place: `src/status-server/routes/chat.ts:667`. Repo-search never consults it — `web_search` and `web_fetch` are hardcoded into `EXPOSED_REPO_TOOL_NAMES` (`src/planner-protocol/repo-search.ts:2-10`), and `resolveRepoSearchPlannerToolDefinitions` (`src/repo-search/planner-protocol.ts:191-216`) filters only on registration. With `EnabledDefault:false` and both providers disabled, run `cdf519ad` still advertised both tools, burned a turn on `web_search` failing with *"No web search provider configured."*, and successfully egressed HTTP GETs to `github.com` and `raw.githubusercontent.com` via `web_fetch` (which needs no provider).

2. **`verdict=pass` on aborted runs.** `passed = signalCheck.passed && !hasExecutedCommandFailure` (`src/repo-search/engine/task-loop.ts:765`) never consults `counters.reason`; `verdict` is then `totals.failed === 0 ? 'pass' : 'fail'` (`src/repo-search/engine.ts:115`). Run `100b487d` ended with `reason='invalid_response_limit'` after 3 invalid responses, its own terminal synthesis said *"Incomplete — I cannot report Task 1 or Task 2 as implemented or verified"*, and it still reported `verdict=pass`.

3. **Rejected tool calls emit no `turn_command_result`.** `screenRejection` (`src/repo-search/engine/tool-action-processor.ts:684-703`) returns `'next'` before any result event is written; the failure survives only as a `Rejected command: …` string inside the next turn's `turn_new_messages`. Any audit keyed on `turn_command_result` under-counts failures — this hid all 7 rejections in the corpus on the first pass of the audit.

**Decisions already made — do not re-litigate:**

- `EnabledDefault:false` removes **both** `web_search` and `web_fetch`. It is an egress switch, not a search-only switch.
- `web_search` is additionally dropped whenever no provider is usable, even when `EnabledDefault:true`, so it can never be advertised-but-broken.
- `passed` requires `reason === 'finish'`. All four other reasons — `max_turns`, `invalid_response_limit`, `forced_finish_attempt_limit`, `mock_responses_exhausted` — fail. Task 6 exists to migrate any fixture that relied on the loose rule.

---

## File Structure

**Defect 1 — web tool gating**

- Create: `src/web-search/tool-policy.ts` — resolves and applies the web-tool policy. Sole owner of "may this run see `web_search`/`web_fetch`".
- Modify: `src/web-search/web-search-provider.ts` — extract the usable-provider predicate so the advertised set and the executable set share one definition.
- Modify: `src/repo-search/types.ts` — add `webToolsEnabled?: boolean` to `RepoSearchExecutionRequest`.
- Modify: `src/repo-search/execute.ts` — apply the policy at the single choke point.
- Modify: `src/status-server/routes/chat.ts`, `src/status-server/chat-repo-operation-runner.ts` — pass explicit per-session intent.
- Create: `tests/web-tool-policy.test.ts`

**Defect 2 — verdict honesty**

- Modify: `src/repo-search/engine/task-loop-support.ts` — `TaskEndReason` enum, `countExecutedCommandFailures`, typed `LoopCounters.reason` and `TaskResultSchema.reason`.
- Modify: `src/repo-search/engine/task-loop.ts` — the `passed` rule.
- Modify: `src/repo-search/engine.ts` — `failureReasons` reports the abort reason.
- Create: `tests/task-end-reason-verdict.test.ts`

**Defect 3 — rejection logging**

- Modify: `src/repo-search/live-snapshot/schemas.ts` — widen `TurnCommandResultEventSchema`.
- Modify: `src/repo-search/live-snapshot/collector.ts` — tool-name fallback for rejections.
- Modify: `src/repo-search/engine/tool-action-processor.ts` — one `logRejectedCommand` seam, called from both rejection funnels.
- Create: `tests/rejected-command-transcript.test.ts`

---

## Task 1: Usable-provider predicate

The advertised tool set and the executable tool set must agree. Today `createWebSearchProviders` owns the only definition of "usable provider" and it is not reusable without allocating provider instances. Extract it.

**Files:**
- Modify: `src/web-search/web-search-provider.ts:18-22`
- Test: `tests/web-tool-policy.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/web-tool-policy.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasUsableWebSearchProvider } from '../src/web-search/web-search-provider.js';
import type { WebSearchConfig } from '../src/web-search/types.js';

function buildWebSearchConfig(overrides: Partial<WebSearchConfig> = {}): WebSearchConfig {
  return {
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: false, ApiKey: '' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
    ...overrides,
  };
}

test('hasUsableWebSearchProvider is false when every provider is disabled', () => {
  assert.equal(hasUsableWebSearchProvider(buildWebSearchConfig()), false);
});

test('hasUsableWebSearchProvider is false when a provider is enabled without an api key', () => {
  const config = buildWebSearchConfig({
    Providers: {
      tavily: { Enabled: true, ApiKey: '   ' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), false);
});

test('hasUsableWebSearchProvider is true when one provider is enabled with a key', () => {
  const config = buildWebSearchConfig({
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), true);
});

test('hasUsableWebSearchProvider ignores providers missing from ProviderOrder', () => {
  const config = buildWebSearchConfig({
    ProviderOrder: ['firecrawl'],
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.equal(hasUsableWebSearchProvider(config), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js web-tool-policy
```

Expected: FAIL — `hasUsableWebSearchProvider` is not exported from `web-search-provider.js`.

- [ ] **Step 3: Write minimal implementation**

Replace `src/web-search/web-search-provider.ts:18-22` with:

```ts
function usableProviderIds(config: WebSearchConfig): WebSearchProviderId[] {
  return config.ProviderOrder.filter((id) => {
    const provider = config.Providers[id];
    return provider !== undefined && provider.Enabled && provider.ApiKey.trim() !== '';
  });
}

/**
 * The single definition of "this provider can actually run a search". The planner tool surface and
 * WebSearchService both read it, so `web_search` is never advertised to a model that cannot run it.
 */
export function hasUsableWebSearchProvider(config: WebSearchConfig): boolean {
  return usableProviderIds(config).length > 0;
}

export function createWebSearchProviders(config: WebSearchConfig): WebSearchProvider[] {
  return usableProviderIds(config).map((id) => buildProvider(id, config.Providers[id].ApiKey));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js web-tool-policy
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the existing web-search suite still passes**

```bash
node ./dist/test-runner/run-tests.js web-search
```

Expected: PASS. `createWebSearchProviders` behaviour is unchanged; only the predicate moved.

- [ ] **Step 6: Commit**

```bash
git add src/web-search/web-search-provider.ts tests/web-tool-policy.test.ts
git commit -m "refactor(web-search): extract usable-provider predicate"
```

---

## Task 2: Web tool policy module

**Files:**
- Create: `src/web-search/tool-policy.ts`
- Test: `tests/web-tool-policy.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add this import to the top of `tests/web-tool-policy.test.ts`:

```ts
import { applyWebToolPolicy, resolveWebToolPolicy } from '../src/web-search/tool-policy.js';
```

Append these tests to the same file:

```ts
test('resolveWebToolPolicy denies both web tools when EnabledDefault is false', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), undefined);
  assert.deepEqual(policy, { webSearch: false, webFetch: false });
});

test('resolveWebToolPolicy denies web_search when enabled but no provider is usable', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: true }), undefined);
  assert.deepEqual(policy, { webSearch: false, webFetch: true });
});

test('resolveWebToolPolicy allows both when enabled with a usable provider', () => {
  const config = buildWebSearchConfig({
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.deepEqual(resolveWebToolPolicy(config, undefined), { webSearch: true, webFetch: true });
});

test('an explicit false overrides EnabledDefault true', () => {
  const config = buildWebSearchConfig({
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 'tvly-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
  });
  assert.deepEqual(resolveWebToolPolicy(config, false), { webSearch: false, webFetch: false });
});

test('an explicit true overrides EnabledDefault false but still needs a provider for web_search', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), true);
  assert.deepEqual(policy, { webSearch: false, webFetch: true });
});

test('applyWebToolPolicy strips only the denied web tools and preserves order', () => {
  const names = ['read', 'grep', 'web_search', 'find', 'web_fetch', 'git'];
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: false, webFetch: false }),
    ['read', 'grep', 'find', 'git'],
  );
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: false, webFetch: true }),
    ['read', 'grep', 'find', 'web_fetch', 'git'],
  );
  assert.deepEqual(
    applyWebToolPolicy(names, { webSearch: true, webFetch: true }),
    names,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js web-tool-policy
```

Expected: FAIL — cannot resolve `../src/web-search/tool-policy.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web-search/tool-policy.ts`:

```ts
import type { WebSearchConfig } from './types.js';
import { hasUsableWebSearchProvider } from './web-search-provider.js';

export type WebToolPolicy = {
  webSearch: boolean;
  webFetch: boolean;
};

/**
 * `WebSearch.EnabledDefault` is a default, not a lock: a caller that expresses per-run intent
 * (a chat session toggle) wins. `web_fetch` needs no provider — it is a direct HTTP GET — so the
 * enable flag is the only thing standing between a "web disabled" config and outbound egress.
 */
export function resolveWebToolPolicy(
  config: WebSearchConfig,
  explicitEnabled: boolean | undefined,
): WebToolPolicy {
  const enabled = explicitEnabled ?? config.EnabledDefault;
  return {
    webFetch: enabled,
    webSearch: enabled && hasUsableWebSearchProvider(config),
  };
}

export function applyWebToolPolicy(toolNames: readonly string[], policy: WebToolPolicy): string[] {
  return toolNames.filter((toolName) => {
    if (toolName === 'web_search') return policy.webSearch;
    if (toolName === 'web_fetch') return policy.webFetch;
    return true;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js web-tool-policy
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/web-search/tool-policy.ts tests/web-tool-policy.test.ts
git commit -m "feat(web-search): add web tool policy resolver"
```

---

## Task 3: Apply the policy in executeRepoSearchRequest

This is the single choke point: every caller — CLI repo-search (`src/status-server/routes/repo-search.ts:110`), repo-agent (`src/status-server/routes/repo-agent.ts:93`), chat (`src/status-server/routes/chat.ts:1048`), and chat repo operations (`src/status-server/chat-repo-operation-runner.ts:158`) — reaches the planner tool list through `executeRepoSearchRequest`, and `config` is always in scope there (`src/repo-search/execute.ts:364`).

**Files:**
- Modify: `src/repo-search/types.ts:145`
- Modify: `src/repo-search/execute.ts:42`, `src/repo-search/execute.ts:372-375`
- Modify: `src/status-server/routes/chat.ts:1048`
- Modify: `src/status-server/chat-repo-operation-runner.ts:158`
- Test: `tests/web-tool-policy.test.ts` (extend)

- [ ] **Step 1: Write the pinning test**

Add these imports to the top of `tests/web-tool-policy.test.ts`:

```ts
import { EXPOSED_REPO_TOOL_NAMES } from '../src/planner-protocol/repo-search.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
```

Append these tests to the same file:

```ts
test('the exposed repo tool surface still lists both web tools before any policy runs', () => {
  assert.equal(EXPOSED_REPO_TOOL_NAMES.includes('web_search'), true);
  assert.equal(EXPOSED_REPO_TOOL_NAMES.includes('web_fetch'), true);
});

test('a disabled web config resolves the default surface without either web tool', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: false }), undefined);
  const allowed = applyWebToolPolicy([...EXPOSED_REPO_TOOL_NAMES], policy);
  const names = resolveRepoSearchPlannerToolDefinitions(allowed).map((d) => d.function.name);
  assert.deepEqual(names, ['read', 'grep', 'find', 'ls', 'git']);
});

test('an enabled web config without providers keeps web_fetch and drops web_search', () => {
  const policy = resolveWebToolPolicy(buildWebSearchConfig({ EnabledDefault: true }), undefined);
  const allowed = applyWebToolPolicy([...EXPOSED_REPO_TOOL_NAMES], policy);
  const names = resolveRepoSearchPlannerToolDefinitions(allowed).map((d) => d.function.name);
  assert.deepEqual(names, ['read', 'grep', 'find', 'ls', 'git', 'web_fetch']);
});
```

- [ ] **Step 2: Run the test**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js web-tool-policy
```

Expected: PASS, 13 tests. These assert only on Task 2 primitives, so they pass immediately — they exist to pin the exact tool-name lists the wiring in Steps 3-5 must produce. If any fails, the Task 2 implementation is wrong; fix it before continuing.

- [ ] **Step 3: Add the request field**

In `src/repo-search/types.ts`, immediately after line 145 (`allowedTools?: string[];`), add:

```ts
  /**
   * Explicit per-run web-tool intent. Unset means "use `config.WebSearch.EnabledDefault`".
   * Chat sets it from the session toggle; repo-search and repo-agent leave it unset.
   */
  webToolsEnabled?: boolean;
```

- [ ] **Step 4: Wire the policy into execute.ts**

In `src/repo-search/execute.ts`, add these two imports directly below the existing line 42 (`import { resolveRepoSearchPlannerToolDefinitions } from './planner-protocol.js';`):

```ts
import { EXPOSED_REPO_TOOL_NAMES } from '../planner-protocol/repo-search.js';
import { applyWebToolPolicy, resolveWebToolPolicy } from '../web-search/tool-policy.js';
```

Then replace lines 372-375:

```ts
    const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(
      request.allowedTools,
      activeVisionPreset.VisionEnabled === true,
    );
```

with:

```ts
    const webToolPolicy = resolveWebToolPolicy(config.WebSearch, request.webToolsEnabled);
    const plannerToolDefinitions = resolveRepoSearchPlannerToolDefinitions(
      applyWebToolPolicy(request.allowedTools ?? [...EXPOSED_REPO_TOOL_NAMES], webToolPolicy),
      activeVisionPreset.VisionEnabled === true,
    );
```

Substituting `EXPOSED_REPO_TOOL_NAMES` for `undefined` reproduces the resolver's own default (`src/repo-search/planner-protocol.ts:195-197`), so callers that pass no `allowedTools` get the same surface, minus whatever the policy denies.

- [ ] **Step 5: Pass explicit chat intent**

In `src/status-server/routes/chat.ts`, on the line immediately after `allowedTools: webEnabled ? ['web_search', 'web_fetch'] : [],` (line 1048), add:

```ts
        webToolsEnabled: webEnabled,
```

In `src/status-server/chat-repo-operation-runner.ts`, on the line immediately after `allowedTools: this.getAllowedTools(request.config, selected.preset, session),` (line 158), add:

```ts
        webToolsEnabled: session.webSearchEnabled === true,
```

Leave `src/status-server/routes/chat.ts:764` (`allowedTools: []`) alone — an empty list has no web tools to filter.

- [ ] **Step 6: Run the affected suites**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js web-tool-policy
node ./dist/test-runner/run-tests.js repo-search-planner-protocol
node ./dist/test-runner/run-tests.js repo-search-chat-execute
node ./dist/test-runner/run-tests.js repo-search-loop.core
```

Expected: PASS. `tests/repo-search-loop.core.test.ts:118` ('repo-search executes a native web_search tool when allowed') and `tests/repo-search-chat-execute.test.ts:115` / `:197` exercise web tools. If one now fails because its fixture config leaves `WebSearch.EnabledDefault` false or has no provider, fix the fixture: set `webToolsEnabled: true` on the request **and** give the config a usable provider:

```ts
WebSearch: {
  EnabledDefault: true,
  Providers: {
    tavily: { Enabled: true, ApiKey: 'test-key' },
    firecrawl: { Enabled: false, ApiKey: '' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
},
```

Do not weaken the policy to make a test pass.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck:test && npx tsc -p ./tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/repo-search/types.ts src/repo-search/execute.ts src/status-server/routes/chat.ts src/status-server/chat-repo-operation-runner.ts tests/web-tool-policy.test.ts
git commit -m "fix(repo-search): gate web tools on WebSearch config"
```

---

## Task 4: Closed TaskEndReason enum

`LoopCounters.reason` (`src/repo-search/engine/task-loop-support.ts:234`) and `TaskResultSchema.reason` (`:113`) are both `string`, so nothing forces the scoring code to consider a new reason. Close the set first, so Task 5 can rely on it.

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:113`, `:234`, and add a new block above `:110`
- Test: `tests/task-end-reason-verdict.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/task-end-reason-verdict.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { TASK_END_REASONS, TaskEndReasonSchema } from '../src/repo-search/engine/task-loop-support.js';

test('TASK_END_REASONS lists every reason the loop can assign', () => {
  assert.deepEqual([...TASK_END_REASONS].sort(), [
    'finish',
    'forced_finish_attempt_limit',
    'invalid_response_limit',
    'max_turns',
    'mock_responses_exhausted',
  ]);
});

test('TaskEndReasonSchema rejects an unknown reason', () => {
  assert.equal(TaskEndReasonSchema.safeParse('finish').success, true);
  assert.equal(TaskEndReasonSchema.safeParse('totally_new_reason').success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js task-end-reason-verdict
```

Expected: FAIL — `TASK_END_REASONS` is not exported from `task-loop-support.js`.

- [ ] **Step 3: Write minimal implementation**

In `src/repo-search/engine/task-loop-support.ts`, add this block immediately above the `TaskResultSchema` declaration (before line 110):

```ts
/**
 * Every way a task loop can stop. Only `finish` is a genuine completion — the rest are aborts, and
 * the scorecard must not report them as passes. Closed so a new stop condition fails to compile
 * rather than silently scoring as a pass.
 */
export const TASK_END_REASONS = [
  'finish',
  'max_turns',
  'invalid_response_limit',
  'forced_finish_attempt_limit',
  'mock_responses_exhausted',
] as const;
export const TaskEndReasonSchema = z.enum(TASK_END_REASONS);
export type TaskEndReason = z.infer<typeof TaskEndReasonSchema>;
```

Change line 113 from:

```ts
  reason: z.string(),
```

to:

```ts
  reason: TaskEndReasonSchema,
```

Change line 234 (inside the `LoopCounters` type) from:

```ts
  reason: string;
```

to:

```ts
  reason: TaskEndReason;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js task-end-reason-verdict
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck to surface every assignment site**

```bash
npx tsc -p ./tsconfig.json --noEmit && npm run typecheck:test
```

Expected: no errors. The five assignment sites are `task-loop.ts:171` (`'max_turns'`, the initial value), `:478` (`'mock_responses_exhausted'`), `:663` (`'invalid_response_limit'`), `:727` (`'finish'`), and `tool-action-processor.ts:305` (`'forced_finish_attempt_limit'`). All are string literals already in the enum, so they narrow cleanly. If tsc reports a site whose literal is not in `TASK_END_REASONS`, add that literal to the array **and** to the Step 1 test — do not widen the type back to `string`.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/engine/task-loop-support.ts tests/task-end-reason-verdict.test.ts
git commit -m "refactor(repo-search): close the task end reason set"
```

---

## Task 5: Aborted runs must fail

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts` (add `countExecutedCommandFailures`)
- Modify: `src/repo-search/engine/task-loop.ts:762-765`
- Modify: `src/repo-search/engine.ts:100-107`
- Test: `tests/task-end-reason-verdict.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add these imports to the top of `tests/task-end-reason-verdict.test.ts`:

```ts
import { buildScorecard } from '../src/repo-search/engine.js';
import type { TaskEndReason, TaskResult } from '../src/repo-search/engine/task-loop-support.js';
```

Append to the same file:

```ts
function buildTaskResult(overrides: Partial<TaskResult> & { reason: TaskEndReason }): TaskResult {
  return {
    id: 'repo-search',
    question: 'q',
    turnsUsed: 3,
    safetyRejects: 0,
    invalidResponses: 0,
    commandFailures: 0,
    finishChallenges: 0,
    commands: [],
    turnThinking: {},
    finalOutput: 'answer',
    compactionSummary: '',
    mutatedPaths: [],
    passed: false,
    missingSignals: [],
    promptTokens: 0,
    outputTokens: 0,
    toolTokens: 0,
    thinkingTokens: 0,
    outputTokensEstimatedCount: 0,
    thinkingTokensEstimatedCount: 0,
    promptCacheTokens: 0,
    promptEvalTokens: 0,
    promptEvalDurationMs: 0,
    generationDurationMs: 0,
    speculativeAcceptedTokens: 0,
    speculativeGeneratedTokens: 0,
    toolStats: {},
    readOverlapSummary: {
      byFile: [],
      totalLinesRead: 0,
      totalUniqueLinesRead: 0,
      totalOverlapLines: 0,
      overlapRatePct: 0,
    },
    ...overrides,
  };
}

test('buildScorecard fails a run that hit the invalid response limit', () => {
  const scorecard = buildScorecard({
    runId: 'r1',
    model: 'm',
    tasks: [buildTaskResult({ reason: 'invalid_response_limit', passed: false })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason invalid_response_limit']);
});

test('buildScorecard fails a run that ran out of turns', () => {
  const scorecard = buildScorecard({
    runId: 'r2',
    model: 'm',
    tasks: [buildTaskResult({ reason: 'max_turns', passed: false })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: ended with reason max_turns']);
});

test('buildScorecard passes a finished run', () => {
  const scorecard = buildScorecard({
    runId: 'r3',
    model: 'm',
    tasks: [buildTaskResult({ reason: 'finish', passed: true })],
  });
  assert.equal(scorecard.verdict, 'pass');
  assert.deepEqual(scorecard.failureReasons, []);
});

test('buildScorecard names the non-zero command exit instead of a bare "task failed"', () => {
  const scorecard = buildScorecard({
    runId: 'r4',
    model: 'm',
    tasks: [buildTaskResult({
      reason: 'finish',
      passed: false,
      commands: [{
        command: 'grep pattern="x"',
        turn: 1,
        safe: true,
        reason: null,
        exitCode: 2,
        output: 'boom',
      }],
    })],
  });
  assert.equal(scorecard.verdict, 'fail');
  assert.deepEqual(scorecard.failureReasons, ['repo-search: commands exited non-zero 1']);
});
```

`buildTaskResult` is copied field-for-field from `TaskResultSchema` (`src/repo-search/engine/task-loop-support.ts:110-147`); the `readOverlapSummary` literal matches `ReadOverlapSummarySchema` (`src/repo-search/engine/read-overlap.ts:16-28`). `groundingStatus` is the schema's only optional field and is correctly omitted.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js task-end-reason-verdict
```

Expected: FAIL on the `failureReasons` assertions — today an aborted task with no missing signals and no command failures produces `['repo-search: task failed']`.

- [ ] **Step 3: Extract the executed-failure predicate**

In `src/repo-search/engine/task-loop-support.ts`, add below the `TASK_END_REASONS` block added in Task 4:

```ts
/**
 * A rejected call (`safe: false`, `exitCode: null`) is a screening decision, not an executed
 * failure — only a command that actually ran and exited non-zero counts here.
 */
export function countExecutedCommandFailures(
  commands: readonly { safe: boolean; exitCode: number | null }[],
): number {
  return commands.filter((command) => command.safe && command.exitCode !== null && command.exitCode !== 0).length;
}
```

- [ ] **Step 4: Make `passed` require a finish**

In `src/repo-search/engine/task-loop.ts`, replace lines 762-765:

```ts
    const hasExecutedCommandFailure = this.commands.some(
      (command) => command.safe && command.exitCode !== null && command.exitCode !== 0,
    );
    const passed = signalCheck.passed && !hasExecutedCommandFailure;
```

with:

```ts
    const hasExecutedCommandFailure = countExecutedCommandFailures(this.commands) > 0;
    // A run that stopped on a turn, invalid-response or forced-finish limit did not answer the
    // question. Scoring it as a pass is how run 100b487d reported verdict=pass while its own
    // terminal synthesis said "Incomplete".
    const passed = this.counters.reason === 'finish' && signalCheck.passed && !hasExecutedCommandFailure;
```

Add `countExecutedCommandFailures` to the existing `./task-loop-support.js` import in that file.

- [ ] **Step 5: Report the real failure reason**

In `src/repo-search/engine.ts`, replace lines 100-107:

```ts
  const failureReasons: string[] = [];
  for (const task of options.tasks) {
    if (task.passed) continue;
    if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
    if (Number(task.commandFailures || 0) > 0) failureReasons.push(`${task.id}: command failures ${Number(task.commandFailures || 0)}`);
    if (task.missingSignals.length === 0 && Number(task.commandFailures || 0) === 0) failureReasons.push(`${task.id}: task failed`);
  }
```

with:

```ts
  const failureReasons: string[] = [];
  for (const task of options.tasks) {
    if (task.passed) continue;
    if (task.reason !== 'finish') failureReasons.push(`${task.id}: ended with reason ${task.reason}`);
    if (task.missingSignals.length > 0) failureReasons.push(`${task.id}: missing signals [${task.missingSignals.join(', ')}]`);
    if (Number(task.commandFailures || 0) > 0) failureReasons.push(`${task.id}: command failures ${Number(task.commandFailures || 0)}`);
    const exitFailures = countExecutedCommandFailures(task.commands);
    if (exitFailures > 0) failureReasons.push(`${task.id}: commands exited non-zero ${exitFailures}`);
  }
```

The bare `task failed` fallback is gone because the three specific branches now cover every way `passed` can be false: `reason !== 'finish'`, missing signals, or an executed non-zero exit.

Add `countExecutedCommandFailures` to the existing `./engine/task-loop-support.js` import in `src/repo-search/engine.ts`.

- [ ] **Step 6: Run test to verify it passes**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js task-end-reason-verdict
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/task-loop-support.ts src/repo-search/engine/task-loop.ts src/repo-search/engine.ts tests/task-end-reason-verdict.test.ts
git commit -m "fix(repo-search): fail runs that aborted instead of finishing"
```

---

## Task 6: Migrate fixtures that relied on the loose verdict

Task 5 changes scoring for every run that ends without a `finish` action. Fixtures whose scripted mock responses run out (`reason='mock_responses_exhausted'`) now score `fail`. This task closes that gap.

Candidate files, from the audit of what asserts on `verdict`/`passed`: `tests/mock-repo-search-loop.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/repo-search.test.ts`, `tests/live-run-snapshot-execute.test.ts`, `tests/native-narration.e2e.test.ts`, `tests/timing-recorder.test.ts`, `tests/tabby-usage-metrics.e2e.test.ts`, `tests/runtime-metrics-aggregation.test.ts`, `tests/repo-search-agent-execute.test.ts`, `tests/repo-task-output.test.ts`, `tests/repo-search-chat-execute.test.ts`.

**Files:**
- Modify: whichever test files Step 1 reports as failing.

- [ ] **Step 1: Run the full suite and capture the failures**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js 2>&1 | siftkit summary --question "Return pass/fail, the exact failing test names, their file paths, and the assertion message for each."
```

Write the list down before changing anything.

- [ ] **Step 2: Fix each failure by making the fixture finish**

For every failing test that asserts `verdict === 'pass'` or `passed === true`, the correct fix is to append a finish response to its mock script so the loop reaches `reason='finish'`. Do **not** relax the assertion, and do **not** add `mock_responses_exhausted` back to the passing set.

The mock response shape used across the suite is a content-only entry with no tool calls (see `tests/mock-repo-search-loop.test.ts:404-407` for a live example). Append to the fixture's `mockResponses` array:

```ts
        { content: 'done' },
```

The content string must satisfy the task's `signals` regexes — in the fixtures above the signal is usually `['done']`, which `'done'` matches. If a fixture declares different signals, use a content string that matches them.

For a test that is genuinely asserting abort behaviour — for example `tests/repo-search-loop.core.test.ts:673` ('runTaskLoop counts non-zero command exits as command failures but not invalid responses'), which already expects `verdict === 'fail'` — leave it alone; it was already correct.

- [ ] **Step 3: Re-run the full suite**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js 2>&1 | siftkit summary --question "Return pass/fail and any remaining failing test names with file:line."
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: make repo-search fixtures reach a finish action"
```

---

## Task 7: Widen the command-result event schema

Three of the four rejection paths never emit a `turn_command_start`, so the live-snapshot collector has no earlier event to read a tool name from and would label them `unknown`. Widen the schema first so Task 8 has somewhere to write.

**Files:**
- Modify: `src/repo-search/live-snapshot/schemas.ts:178-184`
- Modify: `src/repo-search/live-snapshot/collector.ts` (inside `onCommandResult`, at `:449`)
- Test: `tests/rejected-command-transcript.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/rejected-command-transcript.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnCommandResultEventSchema } from '../src/repo-search/live-snapshot/schemas.js';

test('TurnCommandResultEventSchema accepts a rejected command with a null exit code', () => {
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 4,
    command: 'web_search query="x"',
    toolName: 'web_search',
    exitCode: null,
    output: 'Rejected command: No web search provider configured.',
    rejected: true,
    rejectionReason: 'No web search provider configured.',
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.toolName, 'web_search');
  assert.equal(parsed.data.rejected, true);
  assert.equal(parsed.data.exitCode, null);
});

test('TurnCommandResultEventSchema still accepts a plain executed result', () => {
  const parsed = TurnCommandResultEventSchema.safeParse({
    turn: 1,
    command: 'grep pattern="x"',
    exitCode: 0,
    output: 'hit',
    resultTokenCount: 12,
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.rejected, undefined);
  assert.equal(parsed.data.toolName, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js rejected-command-transcript
npm run typecheck:test
```

Expected: FAIL — `parsed.data.toolName` and `parsed.data.rejected` do not exist on the parsed shape (a tsc error from `typecheck:test`, and `undefined` for the first test's assertions at runtime).

- [ ] **Step 3: Widen the schema**

In `src/repo-search/live-snapshot/schemas.ts`, replace lines 178-184:

```ts
export const TurnCommandResultEventSchema = z.object({
  turn: z.number(),
  command: z.string(),
  exitCode: OptionalNumber,
  output: OptionalString,
  resultTokenCount: OptionalNumber,
});
```

with:

```ts
export const TurnCommandResultEventSchema = z.object({
  turn: z.number(),
  command: z.string(),
  toolName: OptionalString,
  exitCode: OptionalNumber,
  output: OptionalString,
  resultTokenCount: OptionalNumber,
  rejected: z.boolean().optional(),
  rejectionReason: OptionalString,
});
```

- [ ] **Step 4: Use the tool name in the collector**

In `src/repo-search/live-snapshot/collector.ts`, inside `onCommandResult`, change:

```ts
      toolName: existing?.toolName ?? 'unknown',
```

to:

```ts
      toolName: existing?.toolName ?? parsed.data.toolName ?? 'unknown',
```

Leave the `if (exitCode !== null && exitCode !== 0)` guard below it unchanged: a rejection reports `exitCode: null`, so it correctly does not increment the executed-failure counter.

- [ ] **Step 5: Run test to verify it passes**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js rejected-command-transcript
node ./dist/test-runner/run-tests.js live-run-snapshot-collector
```

Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/live-snapshot/schemas.ts src/repo-search/live-snapshot/collector.ts tests/rejected-command-transcript.test.ts
git commit -m "feat(live-snapshot): carry tool name and rejection on command results"
```

---

## Task 8: Emit a transcript event for every rejection

Both rejection funnels push a `safe: false, exitCode: null` entry onto `commands` but never write to the transcript logger. Give them one shared seam.

**Files:**
- Modify: `src/repo-search/engine/tool-action-processor.ts:403-433` (`recordRejectedToolCall`)
- Modify: `src/repo-search/engine/tool-action-processor.ts:550` onward (`rejectAsDuplicate`)
- Test: `tests/rejected-command-transcript.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add these imports to the top of `tests/rejected-command-transcript.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { parseLoggedEvent } from './helpers/logged-events.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
```

Append to the same file:

```ts
const REJECTION_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-rejection-transcript-');

test('a rejected read writes a turn_command_result with rejected=true', async () => {
  const repoRoot = createManagedTempDir('siftkit-rejection-repo-');
  fs.writeFileSync(path.join(repoRoot, 'present.ts'), 'export const value = 1;\n', 'utf8');
  const events: JsonObject[] = [];

  const result = await runTaskLoop(
    {
      id: 'task-rejected-read',
      question: 'Read a file that does not exist.',
      signals: ['done'],
    },
    {
      ...REJECTION_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: 'read', arguments: { path: 'absent.ts', offset: 1, limit: 5 } }] },
        { content: 'done' },
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    },
  );

  assert.equal(result.reason, 'finish');
  const results = events.filter((event) => event.kind === 'turn_command_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].rejected, true);
  assert.equal(results[0].exitCode, null);
  assert.equal(results[0].toolName, 'read');
  assert.equal(String(results[0].output).startsWith('Rejected command: '), true);
});
```

> **Note for the implementer:** this mirrors the existing fixture at `tests/mock-repo-search-loop.test.ts:380-420` — same `runTaskLoop(task, options)` shape, same in-memory logger, same `{ toolCalls: [{ name, arguments }] }` / `{ content }` mock response forms. Reading a path that does not exist makes `executeRepoTool` return `ok: false` with reason `path is not a readable file`, which is the `screenRejection` funnel.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js rejected-command-transcript
```

Expected: FAIL — `assert.equal(results.length, 1)` gets `0`, because `screenRejection` returns before any result event is written.

- [ ] **Step 3: Add the shared logging seam**

In `src/repo-search/engine/tool-action-processor.ts`, add this private method immediately above `recordRejectedToolCall` (before line 403):

```ts
  /**
   * A rejection is a completed tool attempt: the model asked, the run answered, and the answer went
   * into the transcript. Emitting it as a `turn_command_result` with a null exit code keeps a single
   * event kind as the complete record of tool outcomes — an audit keyed on `turn_command_result`
   * that misses rejections silently under-counts failures.
   */
  private logRejectedCommand(options: {
    turn: number;
    toolName: string;
    command: string;
    reason: string | null;
    output: string;
  }): void {
    this.deps.logger?.write({
      kind: 'turn_command_result',
      taskId: this.deps.task.id,
      turn: options.turn,
      toolName: options.toolName,
      command: options.command,
      requestedCommand: options.command,
      executedCommand: options.command,
      exitCode: null,
      output: options.output,
      rejected: true,
      rejectionReason: options.reason,
    });
  }
```

- [ ] **Step 4: Call it from `recordRejectedToolCall`**

In the same file, inside `recordRejectedToolCall`, immediately after the closing `});` of the `commands.push({ ... })` call (after line 423), add:

```ts
    this.logRejectedCommand({
      turn,
      toolName: rejection.toolName,
      command: rejection.transcriptCommand,
      reason: rejection.reason,
      output: rejection.output,
    });
```

This covers all four call sites that funnel through it: forced-finish mode (`:295`), approval denial (`:343`), the web/duplicate screen (`:518`), and `screenRejection` (`:691`).

- [ ] **Step 5: Call it from `rejectAsDuplicate`**

In the same file, inside `rejectAsDuplicate`, immediately after its own `commands.push({ command, turn, safe: false, reason, exitCode: null, output: ... });` statement, add:

```ts
    this.logRejectedCommand({
      turn,
      toolName: normalizedToolName,
      command,
      reason,
      output: `Rejected: ${duplicateMessage}`,
    });
```

`rejectAsDuplicate` pushes to `commands` directly rather than through `recordRejectedToolCall` because it owns extra transcript-replay logic; the shared logging seam is what both paths have in common.

- [ ] **Step 6: Run test to verify it passes**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js rejected-command-transcript
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Verify the transcript-consuming suites**

```bash
node ./dist/test-runner/run-tests.js live-run-snapshot-execute
node ./dist/test-runner/run-tests.js live-run-snapshot-collector
node ./dist/test-runner/run-tests.js mock-repo-search-loop
```

Expected: PASS. `tests/live-run-snapshot-execute.test.ts:21` ('transcript records preflight start and command start events for every turn') counts events; if it now sees extra `turn_command_result` entries for rejections, update its expectation to match — the extra events are the fix, not a regression.

- [ ] **Step 8: Commit**

```bash
git add src/repo-search/engine/tool-action-processor.ts tests/rejected-command-transcript.test.ts
git commit -m "fix(repo-search): log a command result for every rejected tool call"
```

---

## Task 9: Full verification

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Full test suite**

```bash
npm run build:test && node ./dist/test-runner/run-tests.js 2>&1 | siftkit summary --question "Return pass/fail, total test count, failing test names, and file:line for each failure."
```

Expected: all green.

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail and every tsc or eslint diagnostic with file:line."
```

Expected: no diagnostics. (`npm run typecheck` already chains `npm run lint`.)

- [ ] **Step 3: Confirm defect 1 against the real config**

```bash
node -e "const D=require('better-sqlite3');const db=new D('.siftkit/runtime.sqlite',{readonly:true});console.log(db.prepare('select web_search_json from app_config').get().web_search_json);"
```

Expected: output shows `"EnabledDefault":false` with both providers `"Enabled":false`. Then confirm the planner is never offered a web tool:

```bash
npx siftkit repo-search 'List the exact tool names available to you. Do not call any tool; answer from the tool list you were given.'
```

Expected: the answer names `read, grep, find, ls, git` and does **not** name `web_search` or `web_fetch`.

- [ ] **Step 4: Confirm defect 3 against a fresh run**

```bash
node -e "
const D=require('better-sqlite3');const db=new D('.siftkit/runtime.sqlite',{readonly:true});
const r=db.prepare('select request_id, repo_search_transcript_jsonl t from run_logs where t is not null order by started_at_utc desc limit 1').get();
const lines=String(r.t).split('\n').filter(Boolean).map(l=>JSON.parse(l));
const starts=lines.filter(e=>e.kind==='turn_command_start').length;
const results=lines.filter(e=>e.kind==='turn_command_result').length;
console.log(r.request_id.slice(0,8),'starts',starts,'results',results);
"
```

Expected: `results >= starts`. Before the fix, rejections made `results < starts`.

- [ ] **Step 5: Commit any fixes**

Only if Steps 1-4 surfaced a problem:

```bash
git add -A
git commit -m "fix: address verification failures"
```

---

## Out of scope

Deliberately not changed, recorded so a later reader does not mistake them for oversights:

- **`hasExecutedCommandFailure` excluding rejections.** `task-loop.ts` counts only `safe && exitCode !== 0`. The comment at `task-loop-support.ts:238-243` explains this is intentional — a screening rejection is not an executed failure. Task 5 preserves the semantics exactly and only moves the predicate.
- **The `st … tool_stats` CLI line.** It is derived from `toolStats`, not from the transcript, and is a separate reporting surface from the three defects here.
- **The 5-minute stall in run `100b487d`.** Turn 9 burned the whole 15,000-token output budget on 59,095 characters of reasoning and emitted nothing. That is a thinking-budget concern needing its own plan.
- **Dispatching implementation prompts to `repo-search`.** Run `100b487d` was an implement-with-TDD prompt sent to a read-only tool surface, which is why the model emitted `<tool_call><function=edit>` as plain text. That is a caller-side routing problem — use `repo-agent` — not a defect in the code changed here.
