# SiftKit Spec Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CLI-driven benchmark that restarts live SiftKit for each speculative-settings case, runs one `siftkit repo-search` prompt, and records the same `Prompt/s`, `Output/s`, and `Acceptance` metrics shown in the UI.

**Architecture:** Keep shell/process orchestration in one new PowerShell script and move selection/parsing/reporting into one small typed TS helper module. Reuse existing `/config`, `/status/restart`, `/dashboard/chat/sessions`, `/dashboard/admin/managed-llama/runs`, and dashboard telemetry formatting logic instead of creating new APIs.

**Tech Stack:** TypeScript, PowerShell, existing status-server HTTP APIs, Node test runner, dashboard telemetry helpers.

---

### Task 1: Add benchmark helper module

**Files:**
- Create: `src/benchmark-spec-settings.ts`
- Test: `tests/benchmark-spec-settings.test.ts`
- Reuse: `dashboard/src/lib/format.ts`, `src/status-server/managed-llama.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SPEC_BENCHMARK_CASES,
  buildBenchmarkCaseId,
  findBenchmarkSession,
  getLatestSpeculativeTotalsFromLogText,
  sortBenchmarkResults,
} from '../src/benchmark-spec-settings';

test('buildBenchmarkCaseId is stable and descriptive', () => {
  assert.equal(
    buildBenchmarkCaseId({
      speculativeNgramSizeN: 24,
      speculativeNgramSizeM: 64,
      speculativeNgramMinHits: 2,
      speculativeDraftMax: 48,
      speculativeDraftMin: 4,
    }),
    'n24-m64-h2-dmax48-dmin4',
  );
});

test('findBenchmarkSession selects the newest matching repo-search session after the run start', () => {
  const session = findBenchmarkSession([
    {
      id: 'older',
      presetId: 'repo-search',
      updatedAtUtc: '2026-04-20T21:00:00.000Z',
      messages: [{ role: 'user', content: 'how are tool calls handled?' }],
    },
    {
      id: 'winner',
      presetId: 'repo-search',
      updatedAtUtc: '2026-04-20T21:01:00.000Z',
      messages: [{ role: 'user', content: 'how are tool calls handled?' }],
    },
  ] as never, 'how are tool calls handled?', '2026-04-20T21:00:30.000Z');

  assert.equal(session?.id, 'winner');
});

test('getLatestSpeculativeTotalsFromLogText reads checkpointed cumulative statistics', () => {
  assert.deepEqual(
    getLatestSpeculativeTotalsFromLogText([
      'statistics ngram_mod: #calls(b,g,a) = 20 2985 131, #gen drafts = 131, #acc drafts = 131, #gen tokens = 6168, #acc tokens = 5837',
      'statistics ngram_mod: #calls(b,g,a) = 26 5746 137, #gen drafts = 137, #acc drafts = 137, #gen tokens = 6426, #acc tokens = 5895',
      'draft acceptance rate = 1.00000 ( 1946 accepted / 1946 generated)',
      'launching slot : {"id":0,"speculative":true}',
      'srv    load_model: speculative decoding will use checkpoints',
    ].join('\n')),
    {
      speculative: true,
      checkpointed: true,
      speculativeAcceptedTokens: 5895,
      speculativeGeneratedTokens: 6426,
      rawAcceptanceLine: 'draft acceptance rate = 1.00000 ( 1946 accepted / 1946 generated)',
    },
  );
});

test('sortBenchmarkResults orders by output tokens per second descending', () => {
  const sorted = sortBenchmarkResults([
    { caseId: 'slow', sessionMetrics: { outputTokensPerSecond: 60 } },
    { caseId: 'fast', sessionMetrics: { outputTokensPerSecond: 90 } },
  ] as never);

  assert.deepEqual(sorted.map((entry) => entry.caseId), ['fast', 'slow']);
});

test('DEFAULT_SPEC_BENCHMARK_CASES contains the approved baseline', () => {
  assert.equal(
    DEFAULT_SPEC_BENCHMARK_CASES.some((entry) => (
      entry.speculativeNgramSizeN === 24
      && entry.speculativeNgramSizeM === 64
      && entry.speculativeNgramMinHits === 2
      && entry.speculativeDraftMax === 48
      && entry.speculativeDraftMin === 4
    )),
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- benchmark-spec-settings.test.ts`
Expected: FAIL with module-not-found/export errors for `src/benchmark-spec-settings.ts`

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ChatSession } from '../dashboard/src/types';

export type SpecBenchmarkCase = {
  speculativeNgramSizeN: number;
  speculativeNgramSizeM: number;
  speculativeNgramMinHits: number;
  speculativeDraftMax: number;
  speculativeDraftMin: number;
};

export type SpecLogTotals = {
  speculative: boolean;
  checkpointed: boolean;
  speculativeAcceptedTokens: number | null;
  speculativeGeneratedTokens: number | null;
  rawAcceptanceLine: string | null;
};

export const DEFAULT_SPEC_BENCHMARK_CASES: SpecBenchmarkCase[] = [
  { speculativeNgramSizeN: 16, speculativeNgramSizeM: 48, speculativeNgramMinHits: 1, speculativeDraftMax: 32, speculativeDraftMin: 2 },
  { speculativeNgramSizeN: 16, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 16, speculativeNgramSizeM: 96, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 48, speculativeNgramMinHits: 1, speculativeDraftMax: 48, speculativeDraftMin: 2 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 96, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 32, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 32, speculativeNgramSizeM: 96, speculativeNgramMinHits: 3, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 3, speculativeDraftMax: 48, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 48, speculativeDraftMin: 8 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 64, speculativeNgramMinHits: 2, speculativeDraftMax: 64, speculativeDraftMin: 4 },
  { speculativeNgramSizeN: 24, speculativeNgramSizeM: 32, speculativeNgramMinHits: 2, speculativeDraftMax: 32, speculativeDraftMin: 4 },
];

export function buildBenchmarkCaseId(entry: SpecBenchmarkCase): string {
  return `n${entry.speculativeNgramSizeN}-m${entry.speculativeNgramSizeM}-h${entry.speculativeNgramMinHits}-dmax${entry.speculativeDraftMax}-dmin${entry.speculativeDraftMin}`;
}

export function findBenchmarkSession(sessions: ChatSession[], prompt: string, startedAtUtc: string): ChatSession | null {
  const startedAt = Date.parse(startedAtUtc);
  return [...sessions]
    .filter((session) => Date.parse(String(session.updatedAtUtc || '')) >= startedAt)
    .filter((session) => session.presetId === 'repo-search' || session.mode === 'repo-search')
    .filter((session) => session.messages.some((message) => message.role === 'user' && message.content === prompt))
    .sort((left, right) => Date.parse(String(right.updatedAtUtc || '')) - Date.parse(String(left.updatedAtUtc || '')))
    .at(0) ?? null;
}

export function getLatestSpeculativeTotalsFromLogText(text: string): SpecLogTotals {
  const statsMatches = [...String(text || '').matchAll(/statistics\s+\S+:.*?#gen tokens\s*=\s*(\d+),\s+#acc tokens\s*=\s*(\d+)/giu)];
  const latestStats = statsMatches.at(-1);
  const acceptanceMatches = [...String(text || '').matchAll(/^.*draft acceptance rate\s*=.*$/gimu)];
  const latestAcceptance = acceptanceMatches.at(-1)?.[0] ?? null;
  return {
    speculative: /"speculative"\s*:\s*true/iu.test(text),
    checkpointed: /speculative decoding will use checkpoints/iu.test(text),
    speculativeGeneratedTokens: latestStats ? Number.parseInt(latestStats[1], 10) : null,
    speculativeAcceptedTokens: latestStats ? Number.parseInt(latestStats[2], 10) : null,
    rawAcceptanceLine: latestAcceptance,
  };
}

export function sortBenchmarkResults<T extends { sessionMetrics?: { outputTokensPerSecond?: number | null } }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => (Number(right.sessionMetrics?.outputTokensPerSecond || 0) - Number(left.sessionMetrics?.outputTokensPerSecond || 0)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- benchmark-spec-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/benchmark-spec-settings.test.ts src/benchmark-spec-settings.ts
git commit -m "feat: add spec benchmark helper module"
```

### Task 2: Add the live CLI benchmark script

**Files:**
- Create: `scripts/benchmark-siftkit-spec-settings.ps1`
- Modify: `package.json`
- Reuse: `scripts/start-dev.ts`, `src/cli/run-repo-search.ts`

- [ ] **Step 1: Write the failing smoke test**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

test('spec benchmark script exists and exposes the benchmark prompt default', () => {
  const script = fs.readFileSync('scripts/benchmark-siftkit-spec-settings.ps1', 'utf8');
  assert.match(script, /how are tool calls handled\?/u);
  assert.match(script, /siftkit repo-search --prompt/u);
  assert.match(script, /\/status\/restart/u);
  assert.match(script, /\/dashboard\/chat\/sessions/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- benchmark-spec-settings.test.ts`
Expected: FAIL because the script file does not exist yet

- [ ] **Step 3: Write minimal script and npm entry**

```powershell
[CmdletBinding()]
param(
    [string]$Prompt = 'how are tool calls handled?',
    [string]$OutputRoot = '.\eval\results\spec_bench',
    [string]$StatusHost = '127.0.0.1',
    [int]$StatusPort = 4765
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The script will:
# 1. GET /config?skip_ready=1
# 2. save original speculative settings
# 3. loop over built-in cases
# 4. PUT /config with one case
# 5. POST /status/restart
# 6. run `node .\bin\siftkit.js repo-search --prompt $Prompt`
# 7. GET /dashboard/chat/sessions and latest managed run
# 8. write JSON + CSV
# 9. restore original config in finally
```

```json
{
  "scripts": {
    "benchmark:spec-settings": "powershell -ExecutionPolicy Bypass -File .\\scripts\\benchmark-siftkit-spec-settings.ps1"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- benchmark-spec-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/benchmark-siftkit-spec-settings.ps1 package.json tests/benchmark-spec-settings.test.ts
git commit -m "feat: add live siftkit spec benchmark script"
```

### Task 3: Wire exact metric collection and reporting

**Files:**
- Modify: `src/benchmark-spec-settings.ts`
- Modify: `scripts/benchmark-siftkit-spec-settings.ps1`
- Test: `tests/benchmark-spec-settings.test.ts`
- Reuse: `dashboard/src/lib/format.ts`

- [ ] **Step 1: Extend tests for UI-equivalent metric capture**

```ts
import { getSessionTelemetryStats } from '../dashboard/src/lib/format';

test('benchmark helper uses session telemetry compatible with the UI header', () => {
  const session = {
    messages: [
      { role: 'user', content: 'how are tool calls handled?' },
      {
        role: 'assistant',
        outputTokensEstimate: 100,
        thinkingTokens: 40,
        promptCacheTokens: 200,
        promptEvalTokens: 50,
        promptTokensPerSecond: 5000,
        outputTokensPerSecond: 70,
        speculativeAcceptedTokens: 30,
        speculativeGeneratedTokens: 60,
      },
    ],
  };
  const stats = getSessionTelemetryStats(session as never);
  assert.equal(Math.round(Number(stats.acceptanceRate) * 100), 50);
  assert.equal(Math.round(Number(stats.outputTokensPerSecond)), 70);
});
```

- [ ] **Step 2: Run test to verify it fails if helper output shape is incomplete**

Run: `npm test -- benchmark-spec-settings.test.ts`
Expected: FAIL until the helper exposes the report row builder the script uses

- [ ] **Step 3: Implement final report-row logic and script serialization**

```ts
export type SpecBenchmarkResultRow = {
  caseId: string;
  prompt: string;
  sessionId: string | null;
  managedRunId: string | null;
  cliDurationMs: number;
  cliExitCode: number;
  sessionMetrics: ReturnType<typeof getSessionTelemetryStats>;
  logMetrics: SpecLogTotals;
};
```

```powershell
# Serialize:
# - results.json
# - summary.csv
# Sort summary by descending Output/s
```

- [ ] **Step 4: Run focused tests**

Run: `npm test -- benchmark-spec-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/benchmark-spec-settings.ts scripts/benchmark-siftkit-spec-settings.ps1 tests/benchmark-spec-settings.test.ts
git commit -m "feat: capture and rank live spec benchmark metrics"
```

### Task 4: Validate the real script path

**Files:**
- Verify: `scripts/benchmark-siftkit-spec-settings.ps1`

- [ ] **Step 1: Run the new focused test suite**

Run: `npm test -- benchmark-spec-settings.test.ts`
Expected: PASS

- [ ] **Step 2: Run a single real benchmark case smoke check**

Run: `npm run benchmark:spec-settings -- -Prompt "how are tool calls handled?"`
Expected: one benchmark output directory with JSON and CSV rows

- [ ] **Step 3: Inspect the result files**

Run: `Get-ChildItem .\eval\results\spec_bench -Recurse`
Expected: newest run folder contains `results.json` and `summary.csv`

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-04-20-siftkit-spec-benchmark.md
git commit -m "docs: add spec benchmark implementation plan"
```
