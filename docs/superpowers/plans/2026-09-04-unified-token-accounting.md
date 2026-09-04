# Unified Token Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `TokenUsageTracker` the single source of token truth so the turn badge, the composer context bar, and the persisted transcript all derive from the same per-row numbers, live and settled.

**Architecture:** The engine already computes exact per-turn token counts and throws them away at the chat route. We retain them as `TurnTokenRecord[]`, publish them on the chat stream as a `usage` frame, and make every consumer read them instead of re-estimating. The badge and context bar keep separate selectors over one shared source. The in-flight streaming tail is estimated from the previous turn's measured chars-per-token ratio and snaps exact at each turn boundary.

**Tech Stack:** TypeScript, Zod v4 (`src/lib/zod.js` re-export), node:test + `node:assert/strict`, better-sqlite3 migrations, React 19 dashboard.

**Spec:** `docs/superpowers/specs/2026-09-04-unified-token-accounting-design.md`

---

## Conventions for every task

**Build before testing.** The runner executes compiled output, not TypeScript:

```powershell
npm run build:test
```

**Run one test file** (basename, no path):

```powershell
node .\dist\test-runner\run-tests.js chat-turn-telemetry.test.ts
```

**Run one dashboard test file:**

```powershell
node .\dist\test-runner\run-tests.js --dashboard chat-stream-parser.test.ts
```

**Full gate before declaring a task done:**

```powershell
npm run typecheck
npm run test
npm run test:dashboard
```

**Rules from the repo's CLAUDE.md that this plan must obey:**

- No `any`, no type assertions, no non-null assertions, no namespace imports.
- Parse all IO with Zod; derive types with `z.infer`.
- Refactors are complete replacements. No shims, no fallbacks, no parallel paths. A missed migration must fail loudly.
- Do not commit unless the user asks. The commit steps below are written as instructions to prepare a commit; **ask before running them.**

---

## File Structure

**New files:**

| File | Responsibility |
| --- | --- |
| `src/repo-search/engine/turn-token-record.ts` | The `TurnTokenRecord` type, the fold that derives run totals from records, and the chars-per-token calibration helper. Pure functions, no IO. |
| `tests/turn-token-record.test.ts` | Unit tests for the fold and calibration. |
| `tests/token-usage-records.test.ts` | Tests that `TokenUsageTracker` retains records and that `snapshot()` equals the fold. |
| `tests/chat-usage-stream-frame.test.ts` | Tests the route forwards the usage frame without dropping fields. |
| `tests/chat-persist-token-parity.test.ts` | Tests all four persist call sites produce identical row attribution. |
| `tests/migrations/token-accounting-backfill.test.ts` | Tests migration 62. |
| `dashboard/tests/lib/turn-token-parity.test.ts` | The headline regression: badge is identical live vs settled. |

**Modified files:**

| File | Change |
| --- | --- |
| `src/repo-search/engine/token-usage.ts` | Retain `TurnTokenRecord[]`; `snapshot()` becomes a fold. |
| `src/repo-search/types.ts` | Add `UsageProgressEventSchema` to the progress union. |
| `src/repo-search/engine/progress-reporter.ts` | Add `usage()` emitter. |
| `src/repo-search/engine/tool-action-processor.ts` | Emit usage after each turn record is closed. |
| `packages/contracts/src/chat.ts` | Add `ChatStreamUsageEventSchema`; remove `associatedToolTokens` from `ChatMessageBaseSchema`. |
| `src/status-server/routes/chat.ts` | Forward the usage frame; pass `TurnTokenRecord[]` at both persist call sites. |
| `src/status-server/chat.ts` | Persist per-row counts from records; delete the `associatedToolTokens` accumulator and the `usage.thinkingTokens` aggregate path; `ContextUsageBuilder` reads stored fields. |
| `src/status-server/chat-repo-operation-runner.ts` | Pass `TurnTokenRecord[]`. |
| `dashboard/src/lib/chat-stream-parser.ts` | Parse the `usage` event. |
| `dashboard/src/lib/chat-session-runtime-store.ts` | Hold `latestUsage`; replace `liveToolPromptStep`. |
| `dashboard/src/lib/chat-live-messages.ts` | Delete the `ceil(len / 4)` thinking estimate. |
| `dashboard/src/lib/format.ts` | One code path for `getTurnTokenDisplay`. |
| `dashboard/src/lib/contextBar.ts` | Read the usage frame instead of reconstructing from bubbles. |
| `dashboard/src/tabs/ChatTab.tsx` | Relabel the badge `run tokens`. |
| `src/state/migrations/registry.ts` | Add migration 62. |

---

## Task 1: `TurnTokenRecord` and the fold

**Files:**
- Create: `src/repo-search/engine/turn-token-record.ts`
- Test: `tests/turn-token-record.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/turn-token-record.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  foldTurnTokenRecords,
  resolveCharsPerToken,
  type TurnTokenRecord,
} from '../src/repo-search/engine/turn-token-record.js';

function record(overrides: Partial<TurnTokenRecord> = {}): TurnTokenRecord {
  return {
    turn: 1,
    promptTokens: 100,
    thinkingTokens: 40,
    outputTokens: 20,
    toolTokens: 10,
    generatedChars: 240,
    thinkingTokensEstimated: false,
    outputTokensEstimated: false,
    ...overrides,
  };
}

test('foldTurnTokenRecords sums every component across turns', () => {
  const totals = foldTurnTokenRecords([
    record({ turn: 1 }),
    record({ turn: 2, promptTokens: 300, thinkingTokens: 5, outputTokens: 7, toolTokens: 11 }),
  ]);
  assert.equal(totals.promptTokens, 400);
  assert.equal(totals.thinkingTokens, 45);
  assert.equal(totals.outputTokens, 27);
  assert.equal(totals.toolTokens, 21);
});

test('foldTurnTokenRecords counts estimated turns rather than flattening them to a boolean', () => {
  const totals = foldTurnTokenRecords([
    record({ turn: 1, thinkingTokensEstimated: true }),
    record({ turn: 2, thinkingTokensEstimated: false, outputTokensEstimated: true }),
  ]);
  assert.equal(totals.thinkingTokensEstimatedCount, 1);
  assert.equal(totals.outputTokensEstimatedCount, 1);
});

test('foldTurnTokenRecords returns zeroed totals for an empty run', () => {
  const totals = foldTurnTokenRecords([]);
  assert.equal(totals.promptTokens, 0);
  assert.equal(totals.thinkingTokens, 0);
  assert.equal(totals.outputTokens, 0);
  assert.equal(totals.toolTokens, 0);
  assert.equal(totals.thinkingTokensEstimatedCount, 0);
  assert.equal(totals.outputTokensEstimatedCount, 0);
});

test('resolveCharsPerToken measures the most recent completed turn', () => {
  const ratio = resolveCharsPerToken([
    record({ turn: 1, generatedChars: 1000, thinkingTokens: 100, outputTokens: 100 }),
    record({ turn: 2, generatedChars: 300, thinkingTokens: 50, outputTokens: 50 }),
  ]);
  assert.equal(ratio, 3);
});

test('resolveCharsPerToken falls back to the seed ratio before any turn completes', () => {
  assert.equal(resolveCharsPerToken([]), 4);
});

test('resolveCharsPerToken ignores a turn that generated no tokens', () => {
  const ratio = resolveCharsPerToken([
    record({ turn: 1, generatedChars: 1000, thinkingTokens: 100, outputTokens: 100 }),
    record({ turn: 2, generatedChars: 0, thinkingTokens: 0, outputTokens: 0 }),
  ]);
  assert.equal(ratio, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js turn-token-record.test.ts
```

Expected: build error or FAIL — `Cannot find module '.../turn-token-record.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/repo-search/engine/turn-token-record.ts`:

```ts
/**
 * One planner turn's token attribution. Every consumer of token counts reads these records
 * rather than re-deriving counts from text, so the badge, the context bar, and the persisted
 * transcript cannot disagree.
 */
export type TurnTokenRecord = {
  turn: number;
  promptTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  toolTokens: number;
  /** Generated characters for this turn, used to calibrate the in-flight streaming estimate. */
  generatedChars: number;
  thinkingTokensEstimated: boolean;
  outputTokensEstimated: boolean;
};

export type TurnTokenTotals = {
  promptTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  toolTokens: number;
  thinkingTokensEstimatedCount: number;
  outputTokensEstimatedCount: number;
};

/** Characters per token assumed before any turn has completed and measured a real ratio. */
export const SEED_CHARS_PER_TOKEN = 4;

export function foldTurnTokenRecords(records: readonly TurnTokenRecord[]): TurnTokenTotals {
  return records.reduce<TurnTokenTotals>((totals, record) => ({
    promptTokens: totals.promptTokens + record.promptTokens,
    thinkingTokens: totals.thinkingTokens + record.thinkingTokens,
    outputTokens: totals.outputTokens + record.outputTokens,
    toolTokens: totals.toolTokens + record.toolTokens,
    thinkingTokensEstimatedCount: totals.thinkingTokensEstimatedCount
      + (record.thinkingTokensEstimated && record.thinkingTokens > 0 ? 1 : 0),
    outputTokensEstimatedCount: totals.outputTokensEstimatedCount
      + (record.outputTokensEstimated && record.outputTokens > 0 ? 1 : 0),
  }), {
    promptTokens: 0,
    thinkingTokens: 0,
    outputTokens: 0,
    toolTokens: 0,
    thinkingTokensEstimatedCount: 0,
    outputTokensEstimatedCount: 0,
  });
}

/**
 * The chars-per-token ratio measured on the most recent turn that actually generated tokens.
 * Used to size the in-flight streaming tail, which is the only span without an exact count.
 */
export function resolveCharsPerToken(records: readonly TurnTokenRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const generatedTokens = record.thinkingTokens + record.outputTokens;
    if (generatedTokens > 0 && record.generatedChars > 0) {
      return record.generatedChars / generatedTokens;
    }
  }
  return SEED_CHARS_PER_TOKEN;
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js turn-token-record.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Prepare the commit (ask before running)**

```powershell
git add src/repo-search/engine/turn-token-record.ts tests/turn-token-record.test.ts
git commit -m "feat: add TurnTokenRecord as the per-turn token attribution unit"
```

---

## Task 2: `TokenUsageTracker` retains records

**Files:**
- Modify: `src/repo-search/engine/token-usage.ts`
- Test: `tests/token-usage-records.test.ts`

Read `src/repo-search/engine/token-usage.ts:38-140` first. `recordModelResponse` currently mutates a dozen private counters and returns per-turn values that are then discarded by callers. After this task the counters that `TurnTokenTotals` covers are gone, and `snapshot()` folds the records.

The duration, cache, and speculative counters stay as private accumulators — they are not per-row token attribution and are out of scope.

- [ ] **Step 1: Write the failing test**

Create `tests/token-usage-records.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { foldTurnTokenRecords } from '../src/repo-search/engine/turn-token-record.js';

test('tracker retains one record per turn and snapshot equals the fold of those records', async () => {
  const tracker = new TokenUsageTracker(undefined, true);
  await tracker.recordModelResponse({ text: 'abcd'.repeat(10), thinkingText: 'xy'.repeat(20) }, 500, 1);
  tracker.addToolTokens(30, 1);
  await tracker.recordModelResponse({ text: 'z'.repeat(8), thinkingText: '' }, 600, 2);

  const records = tracker.turnRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].turn, 1);
  assert.equal(records[0].toolTokens, 30);
  assert.equal(records[1].turn, 2);
  assert.equal(records[1].toolTokens, 0);

  const snapshot = tracker.snapshot();
  const folded = foldTurnTokenRecords(records);
  assert.equal(snapshot.promptTokens, folded.promptTokens);
  assert.equal(snapshot.thinkingTokens, folded.thinkingTokens);
  assert.equal(snapshot.toolTokens, folded.toolTokens);
  assert.equal(snapshot.thinkingTokensEstimatedCount, folded.thinkingTokensEstimatedCount);
});

test('tracker records the generated character count so the streaming tail can be calibrated', async () => {
  const tracker = new TokenUsageTracker(undefined, true);
  await tracker.recordModelResponse({ text: 'abcdefgh', thinkingText: 'ijkl' }, 100, 1);
  assert.equal(tracker.turnRecords()[0].generatedChars, 12);
});

test('tool tokens attach to the turn that produced them, not to the run', async () => {
  const tracker = new TokenUsageTracker(undefined, true);
  await tracker.recordModelResponse({ text: 'a', thinkingText: '' }, 10, 1);
  await tracker.recordModelResponse({ text: 'b', thinkingText: '' }, 10, 2);
  tracker.addToolTokens(7, 2);
  tracker.addToolTokens(5, 2);
  const records = tracker.turnRecords();
  assert.equal(records[0].toolTokens, 0);
  assert.equal(records[1].toolTokens, 12);
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js token-usage-records.test.ts
```

Expected: FAIL — `tracker.turnRecords is not a function`, and arity errors on `recordModelResponse` / `addToolTokens`.

- [ ] **Step 3: Write the implementation**

In `src/repo-search/engine/token-usage.ts`:

Add the import at the top of the file:

```ts
import {
  foldTurnTokenRecords,
  type TurnTokenRecord,
} from './turn-token-record.js';
```

Replace the six token counter fields (`promptTokens`, `outputTokens`, `toolTokens`, `thinkingTokens`, `outputTokensEstimatedCount`, `thinkingTokensEstimatedCount`) with a single record list:

```ts
export class TokenUsageTracker {
  private readonly records: TurnTokenRecord[] = [];
  private promptCacheTokens = 0;
  private promptEvalTokens = 0;
  private promptEvalDurationMs = 0;
  private generationDurationMs = 0;
  private speculativeAcceptedTokens = 0;
  private speculativeGeneratedTokens = 0;
  private readonly config: SiftConfig | undefined;
```

Add a private accessor that creates the record for a turn on first touch, so tool tokens and model
responses converge on the same row regardless of arrival order:

```ts
  private recordFor(turn: number): TurnTokenRecord {
    const existing = this.records.find((record) => record.turn === turn);
    if (existing) {
      return existing;
    }
    const created: TurnTokenRecord = {
      turn,
      promptTokens: 0,
      thinkingTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      generatedChars: 0,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    };
    this.records.push(created);
    this.records.sort((left, right) => left.turn - right.turn);
    return created;
  }

  turnRecords(): readonly TurnTokenRecord[] {
    return this.records;
  }
```

Change `recordModelResponse` to take the turn and write into the record. Replace its counter mutations
(the `this.promptTokens += ...`, `this.thinkingTokens += ...`, and `this.thinkingTokensEstimatedCount += 1`
lines) with record writes; leave the cache/duration/speculative accumulation exactly as it is:

```ts
  async recordModelResponse(
    response: ModelUsageResponse,
    promptTokenCount: number,
    turn: number,
  ): Promise<ResolvedResponseTokens> {
    const record = this.recordFor(turn);
    if (Number.isFinite(promptTokenCount) && promptTokenCount >= 0) {
      record.promptTokens += promptTokenCount;
    }
    const completion = await this.resolveTextTokens(response.text);
    const thinking = await this.resolveTextTokens(response.thinkingText);
    record.thinkingTokens += thinking.tokenCount;
    record.generatedChars += String(response.text || '').trim().length
      + String(response.thinkingText || '').trim().length;
    if (thinking.estimated && thinking.tokenCount > 0) {
      record.thinkingTokensEstimated = true;
    }
    // ...the existing promptCacheTokens / promptEvalTokens / duration / speculative blocks are unchanged...
    return {
      completionTokens: completion.tokenCount,
      thinkingTokens: thinking.tokenCount,
      completionTokensEstimated: completion.estimated,
      thinkingTokensEstimated: thinking.estimated,
    };
  }

  addOutputTokens(tokens: number, turn: number, estimated = false): void {
    const record = this.recordFor(turn);
    record.outputTokens += tokens;
    if (estimated && tokens > 0) {
      record.outputTokensEstimated = true;
    }
  }

  addToolTokens(tokens: number, turn: number): void {
    this.recordFor(turn).toolTokens += Math.max(0, Math.ceil(tokens));
  }
```

Rewrite `snapshot()` so the totals are a fold and cannot drift:

```ts
  snapshot(): TokenUsageSnapshot {
    const totals = foldTurnTokenRecords(this.records);
    return {
      promptTokens: totals.promptTokens,
      outputTokens: totals.outputTokens,
      toolTokens: totals.toolTokens,
      thinkingTokens: totals.thinkingTokens,
      outputTokensEstimatedCount: totals.outputTokensEstimatedCount,
      thinkingTokensEstimatedCount: totals.thinkingTokensEstimatedCount,
      promptCacheTokens: this.promptCacheTokens,
      promptEvalTokens: this.promptEvalTokens,
      promptEvalDurationMs: this.promptEvalDurationMs,
      generationDurationMs: this.generationDurationMs,
      speculativeAcceptedTokens: this.speculativeAcceptedTokens,
      speculativeGeneratedTokens: this.speculativeGeneratedTokens,
    };
  }
```

- [ ] **Step 4: Fix every caller the signature change breaks**

```powershell
npm run typecheck
```

The compiler lists every `recordModelResponse`, `addOutputTokens`, and `addToolTokens` call site. Each
one is inside a turn-scoped loop and already has a `turn` value in scope — pass it. Known sites:
`src/repo-search/engine/tool-action-processor.ts:1079` (`addToolTokens`) and the task-loop call to
`recordModelResponse`.

Do not add a default turn value. A caller with no turn in scope is a real bug that must surface here.

- [ ] **Step 5: Run tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js token-usage-records.test.ts
node .\dist\test-runner\run-tests.js turn-token-record.test.ts
```

Expected: PASS.

- [ ] **Step 6: Prepare the commit (ask before running)**

```powershell
git add src/repo-search/engine/token-usage.ts tests/token-usage-records.test.ts
git commit -m "refactor: derive token usage totals from per-turn records"
```

---

## Task 3: Engine emits a `usage` progress event

**Files:**
- Modify: `src/repo-search/types.ts`
- Modify: `src/repo-search/engine/progress-reporter.ts`
- Modify: `src/repo-search/engine/tool-action-processor.ts`
- Test: `tests/turn-token-record.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/turn-token-record.test.ts`:

```ts
import { RepoSearchProgressEventSchema } from '../src/repo-search/types.js';

test('the usage progress event carries the turn record, totals, and calibration ratio', () => {
  const parsed = RepoSearchProgressEventSchema.parse({
    kind: 'usage',
    turn: 3,
    maxTurns: 20,
    elapsedMs: 1234,
    record: {
      turn: 3,
      promptTokens: 900,
      thinkingTokens: 120,
      outputTokens: 40,
      toolTokens: 60,
      generatedChars: 640,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 2700,
      thinkingTokens: 300,
      outputTokens: 90,
      toolTokens: 180,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  });
  assert.equal(parsed.kind, 'usage');
});

test('the usage progress event rejects a negative token count', () => {
  const result = RepoSearchProgressEventSchema.safeParse({
    kind: 'usage',
    turn: 1,
    maxTurns: 20,
    elapsedMs: 0,
    record: {
      turn: 1,
      promptTokens: -1,
      thinkingTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      generatedChars: 0,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 0,
      thinkingTokens: 0,
      outputTokens: 0,
      toolTokens: 0,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  });
  assert.equal(result.success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js turn-token-record.test.ts
```

Expected: FAIL — the discriminated union has no `usage` member.

- [ ] **Step 3: Add the schema**

In `src/repo-search/types.ts`, next to `LlmStartProgressEventSchema` (around line 54), add:

```ts
export const TurnTokenRecordSchema = z.object({
  turn: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolTokens: z.number().int().nonnegative(),
  generatedChars: z.number().int().nonnegative(),
  thinkingTokensEstimated: z.boolean(),
  outputTokensEstimated: z.boolean(),
});

export const TurnTokenTotalsSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolTokens: z.number().int().nonnegative(),
  thinkingTokensEstimatedCount: z.number().int().nonnegative(),
  outputTokensEstimatedCount: z.number().int().nonnegative(),
});

export const UsageProgressEventSchema = z.object({
  ...turnScopedFields,
  kind: z.literal('usage'),
  record: TurnTokenRecordSchema,
  totals: TurnTokenTotalsSchema,
  charsPerToken: z.number().positive(),
  elapsedMs: z.number(),
});
```

Add `UsageProgressEventSchema,` to the `RepoSearchProgressEventSchema` union, directly after
`LlmEndProgressEventSchema`.

- [ ] **Step 4: Add the emitter**

In `src/repo-search/engine/progress-reporter.ts`, add the import:

```ts
import type { TurnTokenRecord, TurnTokenTotals } from './turn-token-record.js';
```

Add the method after `llmEnd` (around line 88):

```ts
  usage(turn: number, record: TurnTokenRecord, totals: TurnTokenTotals, charsPerToken: number): void {
    this.emit({
      kind: 'usage', turn, maxTurns: this.maxTurns, record, totals, charsPerToken,
      elapsedMs: this.elapsedMs(),
    });
  }
```

- [ ] **Step 5: Emit it at every turn boundary**

In `src/repo-search/engine/tool-action-processor.ts`, immediately after the existing
`tokenUsage.addToolTokens(resultTokenCount, turn)` call (was line 1079), add:

```ts
    const usageRecords = tokenUsage.turnRecords();
    const currentRecord = usageRecords.find((entry) => entry.turn === turn);
    if (!currentRecord) {
      throw new Error(`Token usage record missing for turn ${turn}.`);
    }
    progress.usage(turn, currentRecord, foldTurnTokenRecords(usageRecords), resolveCharsPerToken(usageRecords));
```

Add the import at the top of that file:

```ts
import { foldTurnTokenRecords, resolveCharsPerToken } from './turn-token-record.js';
```

Do the same in the task loop immediately after the `recordModelResponse` call, so a turn that produces
no tool call still publishes its usage.

- [ ] **Step 6: Run tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js turn-token-record.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Prepare the commit (ask before running)**

```powershell
git add src/repo-search/types.ts src/repo-search/engine/progress-reporter.ts src/repo-search/engine/tool-action-processor.ts tests/turn-token-record.test.ts
git commit -m "feat: publish per-turn token usage on the repo-search progress stream"
```

---

## Task 4: Contract for the chat stream usage frame

**Files:**
- Modify: `packages/contracts/src/chat.ts`
- Test: `tests/contracts-chat-usage.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/contracts-chat-usage.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatStreamUsageEventSchema } from '@siftkit/contracts';

const validFrame = {
  turn: 2,
  maxTurns: 20,
  record: {
    turn: 2,
    promptTokens: 800,
    thinkingTokens: 90,
    outputTokens: 30,
    toolTokens: 45,
    generatedChars: 480,
    thinkingTokensEstimated: false,
    outputTokensEstimated: false,
  },
  totals: {
    promptTokens: 1600,
    thinkingTokens: 180,
    outputTokens: 60,
    toolTokens: 90,
    thinkingTokensEstimatedCount: 0,
    outputTokensEstimatedCount: 0,
  },
  charsPerToken: 4.2,
};

test('the chat usage frame round-trips the full record and totals', () => {
  const parsed = ChatStreamUsageEventSchema.parse(validFrame);
  assert.equal(parsed.record.thinkingTokens, 90);
  assert.equal(parsed.totals.toolTokens, 90);
  assert.equal(parsed.charsPerToken, 4.2);
});

test('the chat usage frame rejects a missing totals block rather than defaulting it', () => {
  const { totals, ...withoutTotals } = validFrame;
  assert.equal(totals.promptTokens, 1600);
  assert.equal(ChatStreamUsageEventSchema.safeParse(withoutTotals).success, false);
});

test('the chat usage frame rejects a zero calibration ratio', () => {
  assert.equal(
    ChatStreamUsageEventSchema.safeParse({ ...validFrame, charsPerToken: 0 }).success,
    false,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js contracts-chat-usage.test.ts
```

Expected: FAIL — `ChatStreamUsageEventSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `packages/contracts/src/chat.ts`, after `ChatStreamToolEventSchema` (around line 52), add:

```ts
export const ChatTurnTokenRecordSchema = z.object({
  turn: z.number().int().positive(),
  promptTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolTokens: z.number().int().nonnegative(),
  generatedChars: z.number().int().nonnegative(),
  thinkingTokensEstimated: z.boolean(),
  outputTokensEstimated: z.boolean(),
});
export type ChatTurnTokenRecord = z.infer<typeof ChatTurnTokenRecordSchema>;

export const ChatTurnTokenTotalsSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  thinkingTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolTokens: z.number().int().nonnegative(),
  thinkingTokensEstimatedCount: z.number().int().nonnegative(),
  outputTokensEstimatedCount: z.number().int().nonnegative(),
});
export type ChatTurnTokenTotals = z.infer<typeof ChatTurnTokenTotalsSchema>;

export const ChatStreamUsageEventSchema = z.object({
  turn: z.number().int().nonnegative(),
  maxTurns: z.number().int().positive(),
  record: ChatTurnTokenRecordSchema,
  totals: ChatTurnTokenTotalsSchema,
  charsPerToken: z.number().positive(),
});
export type ChatStreamUsageEvent = z.infer<typeof ChatStreamUsageEventSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js contracts-chat-usage.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Prepare the commit (ask before running)**

```powershell
git add packages/contracts/src/chat.ts tests/contracts-chat-usage.test.ts
git commit -m "feat: add the chat stream usage frame contract"
```

---

## Task 5: The chat route forwards the usage frame

**Files:**
- Modify: `src/status-server/routes/chat.ts:153-205`
- Test: `tests/chat-usage-stream-frame.test.ts` (create)

This is the task that fixes the root cause. `forwardRepoSearchToolEvent` currently drops
`thinkingTokenCount`; that discard is why the dashboard estimates.

- [ ] **Step 1: Write the failing test**

Create `tests/chat-usage-stream-frame.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { forwardRepoSearchUsageEvent } from '../src/status-server/routes/chat.js';
import type { JsonSerializable } from '../src/lib/json-types.js';

type WrittenEvent = { eventName: string; payload: JsonSerializable };

function createRecordingWriter() {
  const written: WrittenEvent[] = [];
  return {
    written,
    writer: {
      writeEvent(eventName: string, payload: JsonSerializable): void {
        written.push({ eventName, payload });
      },
    },
  };
}

test('the route forwards the usage frame without dropping the record or totals', () => {
  const { written, writer } = createRecordingWriter();
  forwardRepoSearchUsageEvent(writer, {
    kind: 'usage',
    turn: 4,
    maxTurns: 20,
    elapsedMs: 900,
    record: {
      turn: 4,
      promptTokens: 1200,
      thinkingTokens: 210,
      outputTokens: 15,
      toolTokens: 80,
      generatedChars: 900,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 4800,
      thinkingTokens: 640,
      outputTokens: 60,
      toolTokens: 320,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4.28,
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].eventName, 'usage');
  assert.deepEqual(written[0].payload, {
    turn: 4,
    maxTurns: 20,
    record: {
      turn: 4,
      promptTokens: 1200,
      thinkingTokens: 210,
      outputTokens: 15,
      toolTokens: 80,
      generatedChars: 900,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 4800,
      thinkingTokens: 640,
      outputTokens: 60,
      toolTokens: 320,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4.28,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-usage-stream-frame.test.ts
```

Expected: FAIL — `forwardRepoSearchUsageEvent` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/status-server/routes/chat.ts`, add after `forwardRepoSearchToolEvent` (which ends around line 183):

```ts
export function forwardRepoSearchUsageEvent(
  writer: SseResponseWriter,
  event: Extract<RepoSearchProgressEvent, { kind: 'usage' }>,
): void {
  writer.writeEvent('usage', {
    turn: event.turn,
    maxTurns: event.maxTurns,
    record: event.record,
    totals: event.totals,
    charsPerToken: event.charsPerToken,
  });
}
```

Then wire it into the progress dispatch. Find where the route switches on
`RepoSearchProgressEvent.kind` to call `forwardRepoSearchToolEvent`, and add:

```ts
    if (event.kind === 'usage') {
      forwardRepoSearchUsageEvent(sse, event);
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-usage-stream-frame.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Prepare the commit (ask before running)**

```powershell
git add src/status-server/routes/chat.ts tests/chat-usage-stream-frame.test.ts
git commit -m "fix: stop discarding per-turn token counts at the chat route"
```

---

## Task 6: The dashboard parses the usage frame

**Files:**
- Modify: `dashboard/src/lib/chat-stream-parser.ts`
- Test: `dashboard/tests/chat-stream-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/chat-stream-parser.test.ts`:

```ts
test('parses a usage frame into a usage event', () => {
  const payload = {
    turn: 3,
    maxTurns: 20,
    record: {
      turn: 3, promptTokens: 700, thinkingTokens: 55, outputTokens: 12, toolTokens: 33,
      generatedChars: 268, thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 2100, thinkingTokens: 165, outputTokens: 36, toolTokens: 99,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  };
  const packet = `event: usage\ndata: ${JSON.stringify(payload)}`;
  assert.deepEqual(parseChatStreamPacket(packet), { kind: 'usage', usage: payload });
});

test('rejects a malformed usage frame instead of silently dropping the numbers', () => {
  const packet = 'event: usage\ndata: {"turn":3,"maxTurns":20,"charsPerToken":4}';
  assert.equal(parseChatStreamPacket(packet), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard chat-stream-parser.test.ts
```

Expected: FAIL — `parseChatStreamPacket` returns `null` for `event: usage`.

- [ ] **Step 3: Write the implementation**

In `dashboard/src/lib/chat-stream-parser.ts`, add to the contracts import block:

```ts
  ChatStreamUsageEventSchema,
  type ChatStreamUsageEvent,
```

Add to the `ChatStreamEvent` union:

```ts
  | { kind: 'usage'; usage: ChatStreamUsageEvent }
```

Add to the `switch (parsed.eventName)` block, before `default`:

```ts
    case 'usage': {
      const result = ChatStreamUsageEventSchema.safeParse(record);
      return result.success ? { kind: 'usage', usage: result.data } : null;
    }
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard chat-stream-parser.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prepare the commit (ask before running)**

```powershell
git add dashboard/src/lib/chat-stream-parser.ts dashboard/tests/chat-stream-parser.test.ts
git commit -m "feat: parse the chat stream usage frame in the dashboard"
```

---

## Task 7: The runtime store holds the usage frame and live bubbles stop estimating

**Files:**
- Modify: `dashboard/src/lib/chat-session-runtime-store.ts`
- Modify: `dashboard/src/lib/chat-live-messages.ts:11`
- Test: `dashboard/tests/chat-session-runtime-store.test.ts`

This deletes `liveToolPromptStep` entirely. It was a workaround for the missing usage frame —
reconstructing a baseline from bubble sums because the real numbers were not available. With the frame
present it is a parallel path and must go.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/tests/chat-session-runtime-store.test.ts`:

```ts
test('a usage transition replaces the stored usage frame', () => {
  const usage = {
    turn: 2, maxTurns: 20,
    record: {
      turn: 2, promptTokens: 900, thinkingTokens: 70, outputTokens: 10, toolTokens: 40,
      generatedChars: 320, thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 1800, thinkingTokens: 140, outputTokens: 20, toolTokens: 80,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  };
  const store = applyChatSessionRuntimeTransition(createEmptyStore(), {
    kind: 'usage', sessionId: 'session-a', usage,
  });
  assert.deepEqual(store['session-a'].latestUsage, usage);
});

test('live thinking bubbles carry no self-derived token estimate', () => {
  const message = createLiveMessage('live-1', 'assistant_thinking', 'assistant', 'x'.repeat(400));
  assert.equal(message.thinkingTokens, 0);
});
```

Use the store's existing test helpers for `createEmptyStore` and
`applyChatSessionRuntimeTransition` — read the top of the file and match what the surrounding tests
already import.

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard chat-session-runtime-store.test.ts
```

Expected: FAIL — no `usage` transition kind; `thinkingTokens` is 100.

- [ ] **Step 3: Write the implementation**

In `dashboard/src/lib/chat-live-messages.ts`, replace line 11 and the flag that depends on it:

```ts
  const thinkingTokens = 0;
```

and

```ts
    thinkingTokensEstimated: false,
```

The engine now supplies thinking counts; the bubble no longer guesses.

In `dashboard/src/lib/chat-session-runtime-store.ts`:

Replace the `liveToolPromptStep` field on `ChatSessionRuntime` with:

```ts
  latestUsage: ChatStreamUsageEvent | null;
```

Add to the transition union:

```ts
  | { kind: 'usage'; sessionId: string; usage: ChatStreamUsageEvent }
```

Delete `applyToolEvent`'s `liveToolPromptStep` bookkeeping (the whole `step`/`liveBaselineTokens`
block) so it only calls `applyTranscriptEvent`. Add the usage reducer:

```ts
function applyUsageEvent(runtime: ChatSessionRuntime, usage: ChatStreamUsageEvent): ChatSessionRuntime {
  return { ...runtime, latestUsage: usage };
}
```

Wire `applyUsageEvent` into the transition switch, and remove `liveToolPromptStep` from the
initial-runtime factory, replacing it with `latestUsage: null`.

Remove the now-unused `sumLiveTokenDisplays` and `LiveToolPromptStep` imports.

- [ ] **Step 4: Run test to verify it passes**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard chat-session-runtime-store.test.ts
```

Expected: PASS. Other dashboard tests referencing `liveToolPromptStep` will fail to compile — Task 8
removes their last consumer, so fix them there.

- [ ] **Step 5: Prepare the commit (ask before running)**

```powershell
git add dashboard/src/lib/chat-session-runtime-store.ts dashboard/src/lib/chat-live-messages.ts dashboard/tests/chat-session-runtime-store.test.ts
git commit -m "refactor: store the usage frame instead of reconstructing a tool prompt baseline"
```

---

## Task 8: One code path for the badge, calibrated tail for the context bar

**Files:**
- Modify: `dashboard/src/lib/format.ts:179-200`
- Modify: `dashboard/src/lib/contextBar.ts:31-69`
- Modify: `dashboard/src/tabs/ChatTab.tsx:851`
- Test: `dashboard/tests/lib/turn-token-parity.test.ts` (create)
- Test: `dashboard/tests/lib/contextBar.test.ts`
- Test: `dashboard/tests/chat-tab.test.tsx`

This task carries the headline invariant. `getTurnTokenDisplay` loses its `turn.isLive` branch
entirely — one path means live and settled cannot differ.

- [ ] **Step 1: Write the failing regression test**

Create `dashboard/tests/lib/turn-token-parity.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { getTurnTokenDisplay } from '../../src/lib/format';
import type { ChatMessage } from '../../src/types';
import type { ChatTurn } from '../../src/lib/chatTurns';

function thinkingMessage(id: string, tokens: number): ChatMessage {
  return {
    id, role: 'assistant', kind: 'assistant_thinking', content: 'reasoning text',
    inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: tokens,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
    createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
  };
}

function toolMessage(id: string, outputTokens: number): ChatMessage {
  return {
    id, role: 'assistant', kind: 'assistant_tool_call', content: 'grep foo',
    toolCallCommand: 'grep foo', toolCallActivityKind: 'search',
    toolCallActivitySubject: { kind: 'none' }, toolCallTurn: 1, toolCallMaxTurns: 20,
    toolCallExitCode: 0, toolCallStatus: 'done',
    inputTokensEstimate: 0, outputTokensEstimate: outputTokens, thinkingTokens: 0,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
    createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
  };
}

function answerMessage(id: string, outputTokens: number): ChatMessage {
  return {
    id, role: 'assistant', kind: 'assistant_answer', content: 'the answer',
    inputTokensEstimate: 0, outputTokensEstimate: outputTokens, thinkingTokens: 0,
    inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
    createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
  };
}

test('the badge is identical across the live to settled transition', () => {
  const messages = [
    thinkingMessage('t1', 120),
    toolMessage('c1', 340),
    thinkingMessage('t2', 95),
    toolMessage('c2', 210),
    answerMessage('a1', 60),
  ];
  const live: ChatTurn = { key: 'live', isLive: true, messages, main: null, liveThinking: [] };
  const settled: ChatTurn = {
    key: 'run:run-1', isLive: false, messages, main: messages[4], liveThinking: [],
  };
  assert.equal(getTurnTokenDisplay(live).tokenCount, getTurnTokenDisplay(settled).tokenCount);
  assert.equal(getTurnTokenDisplay(settled).tokenCount, 120 + 340 + 95 + 210 + 60);
});

test('a settled turn counts every per-step thinking row, not just the answer row', () => {
  const messages = [thinkingMessage('t1', 120), thinkingMessage('t2', 95), answerMessage('a1', 60)];
  const settled: ChatTurn = {
    key: 'run:run-1', isLive: false, messages, main: messages[2], liveThinking: [],
  };
  assert.equal(getTurnTokenDisplay(settled).tokenCount, 275);
});

test('the display is inexact when any contributing row is estimated', () => {
  const estimated = { ...thinkingMessage('t1', 120), thinkingTokensEstimated: true };
  const settled: ChatTurn = {
    key: 'run:run-1', isLive: false, messages: [estimated], main: null, liveThinking: [],
  };
  assert.equal(getTurnTokenDisplay(settled).exact, false);
});
```

Match `ChatTurn`'s real shape by reading `dashboard/src/lib/chatTurns.ts` before writing this — adjust
the object literals if the type has fields beyond `key`, `isLive`, `messages`, `main`, `liveThinking`.

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard turn-token-parity.test.ts
```

Expected: FAIL — the settled branch reads only `main`, so it returns 60, not 825.

- [ ] **Step 3: Rewrite `getTurnTokenDisplay` with a single path**

In `dashboard/src/lib/format.ts`, replace the whole `getTurnTokenDisplay` function (lines 179-200)
with:

```ts
export function getTurnTokenDisplay(turn: ChatTurn): { tokenCount: number; exact: boolean } {
  return sumLiveTokenDisplays(turn.messages);
}
```

`sumLiveTokenDisplays` already folds `getLiveMessageTokenDisplay` over the messages, which sums input,
output, thinking, and images per row with correct exactness propagation. The `main`-only branch, the
`associatedToolTokens` read, and the separate image reduction all go away — they were compensating for
the aggregate-on-answer-row shape that Task 9 removes.

Rename the function to `getTurnTokenDisplay` in place; do not leave the old name as an alias.

- [ ] **Step 4: Relabel the badge**

In `dashboard/src/tabs/ChatTab.tsx:851`, change:

```tsx
    ? formatTokenLabel(aggregateTokens.tokenCount, 'context tokens')
    : `~${formatNumber(aggregateTokens.tokenCount)} context tokens`;
```

to:

```tsx
    ? formatTokenLabel(aggregateTokens.tokenCount, 'run tokens')
    : `~${formatNumber(aggregateTokens.tokenCount)} run tokens`;
```

Update the assertions in `dashboard/tests/chat-tab.test.tsx` that match on `context tokens` for this
badge. Leave assertions about the composer's `ctx-label` alone — that is the context bar and keeps its
own wording.

- [ ] **Step 5: Rewrite `resolveLiveContextUsage` against the usage frame**

In `dashboard/src/lib/contextBar.ts`, replace the whole `resolveLiveContextUsage` function with:

```ts
export function resolveLiveContextUsage(input: {
  contextUsage: ContextUsage | null;
  latestUsage: ChatStreamUsageEvent | null;
  streamedCharsSinceUsage: number;
  busy: boolean;
}): LiveContextUsage | null {
  const { contextUsage } = input;
  if (!contextUsage || contextUsage.contextWindowTokens <= 0) {
    return null;
  }
  const contextWindowTokens = contextUsage.contextWindowTokens;
  const finish = (usedTokens: number, exact: boolean): LiveContextUsage => ({
    usedTokens,
    contextWindowTokens,
    ratio: Math.min(1, Math.max(0, usedTokens / contextWindowTokens)),
    exact,
  });
  if (!input.busy || !input.latestUsage) {
    return finish(contextUsage.totalUsedTokens, true);
  }
  // The frame is exact up to the last turn boundary. Only the tail streamed since then is
  // estimated, sized by the ratio the previous turn actually measured.
  const usage = input.latestUsage;
  const tailTokens = Math.ceil(input.streamedCharsSinceUsage / usage.charsPerToken);
  return finish(usage.record.promptTokens + tailTokens, tailTokens === 0);
}
```

Delete the `LiveToolPromptStep` type and its export — Task 7 removed its only producer.

Update `dashboard/src/tabs/ChatTab.tsx:557` to pass `latestUsage` and `streamedCharsSinceUsage` from
the runtime store instead of `liveMessages` and `liveToolPromptStep`. Track
`streamedCharsSinceUsage` in the runtime store as a counter that accumulates delta text lengths and
resets to 0 on each `usage` transition.

- [ ] **Step 6: Update the context bar tests**

Rewrite the cases in `dashboard/tests/lib/contextBar.test.ts` that construct `liveToolPromptStep` and
`liveMessages` to construct a `latestUsage` frame and a `streamedCharsSinceUsage` count instead. Add:

```ts
test('the in-flight tail converges to the exact count at the turn boundary', () => {
  const usage = {
    turn: 2, maxTurns: 20,
    record: {
      turn: 2, promptTokens: 5000, thinkingTokens: 100, outputTokens: 0, toolTokens: 0,
      generatedChars: 400, thinkingTokensEstimated: false, outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 5000, thinkingTokens: 100, outputTokens: 0, toolTokens: 0,
      thinkingTokensEstimatedCount: 0, outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4,
  };
  const contextUsage = { contextWindowTokens: 155_000, totalUsedTokens: 4000 } as ContextUsage;
  const mid = resolveLiveContextUsage({
    contextUsage, latestUsage: usage, streamedCharsSinceUsage: 800, busy: true,
  });
  assert.equal(mid?.usedTokens, 5200);
  assert.equal(mid?.exact, false);

  const atBoundary = resolveLiveContextUsage({
    contextUsage, latestUsage: usage, streamedCharsSinceUsage: 0, busy: true,
  });
  assert.equal(atBoundary?.usedTokens, 5000);
  assert.equal(atBoundary?.exact, true);
});
```

- [ ] **Step 7: Run tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js --dashboard turn-token-parity.test.ts
node .\dist\test-runner\run-tests.js --dashboard contextBar.test.ts
node .\dist\test-runner\run-tests.js --dashboard chat-tab.test.tsx
npm run test:dashboard
```

Expected: PASS.

- [ ] **Step 8: Prepare the commit (ask before running)**

```powershell
git add dashboard/src/lib/format.ts dashboard/src/lib/contextBar.ts dashboard/src/tabs/ChatTab.tsx dashboard/tests
git commit -m "fix: give the turn badge one code path and label it run tokens"
```

---

## Task 9: The persist layer writes per-row counts from records

**Files:**
- Modify: `packages/contracts/src/chat.ts` (remove `associatedToolTokens`)
- Modify: `src/status-server/chat.ts:636-790`
- Modify: `src/status-server/chat-repo-operation-runner.ts:279-300`
- Modify: `src/status-server/routes/chat.ts:901, 938, 1203-1221`
- Modify: `src/state/chat-sessions.ts` (drop the `associated_tool_tokens` column from insert and read)
- Test: `tests/chat-persist-token-parity.test.ts` (create)

This is the task that makes defect D3 unrepresentable.

- [ ] **Step 1: Write the failing test**

Create `tests/chat-persist-token-parity.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChatSessionWithAppendedTurn } from '../src/status-server/chat.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset } from './helpers/mock-config.js';

function createSession(): ChatSession {
  return {
    id: 'persist-parity',
    title: 'parity',
    modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default' }),
    model: null,
    contextWindowTokens: 155_000,
    planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-09-04T00:00:00.000Z',
    updatedAtUtc: '2026-09-04T00:00:00.000Z',
    messages: [],
  };
}

const turnRecords = [
  {
    turn: 1, promptTokens: 500, thinkingTokens: 120, outputTokens: 0, toolTokens: 340,
    generatedChars: 480, thinkingTokensEstimated: false, outputTokensEstimated: false,
  },
  {
    turn: 2, promptTokens: 900, thinkingTokens: 95, outputTokens: 60, toolTokens: 210,
    generatedChars: 620, thinkingTokensEstimated: false, outputTokensEstimated: false,
  },
];

test('the answer row never carries aggregate thinking; step rows own it', () => {
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer', {}, {
      turns: [
        { thinkingText: 'first reasoning', toolMessages: [], thinkingTokens: 120 },
        { thinkingText: 'second reasoning', toolMessages: [], thinkingTokens: 95 },
      ],
      turnRecords,
    },
  );
  const answer = session.messages.find((message) => message.kind === 'assistant_answer');
  assert.ok(answer);
  assert.equal(answer.thinkingTokens, 0);

  const thinkingRows = session.messages.filter((message) => message.kind === 'assistant_thinking');
  assert.deepEqual(thinkingRows.map((row) => row.thinkingTokens), [120, 95]);
});

test('the turn total equals the sum of the rows, with no denormalized accumulator', () => {
  const session = buildChatSessionWithAppendedTurn(
    createSession(), 'question', 'answer', {}, {
      turns: [{ thinkingText: 'reasoning', toolMessages: [], thinkingTokens: 120 }],
      turnRecords: [turnRecords[0]],
    },
  );
  const assistantRows = session.messages.filter((message) => message.role === 'assistant');
  const summed = assistantRows.reduce(
    (total, row) => total + row.thinkingTokens + row.outputTokensEstimate, 0,
  );
  assert.equal(summed, 120);
  for (const row of assistantRows) {
    assert.equal('associatedToolTokens' in row, false);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-persist-token-parity.test.ts
```

Expected: FAIL — `turnRecords` is not an `AppendChatOptions` field, and the rows still carry
`associatedToolTokens`.

- [ ] **Step 3: Remove `associatedToolTokens` from the contract**

In `packages/contracts/src/chat.ts`, delete this field from `ChatMessageBaseSchema`:

```ts
  associatedToolTokens: z.number().nullable().optional(),
```

Run `npm run typecheck` and let the compiler enumerate every reader. Delete each one — do not leave a
fallback that reads `?? 0`.

- [ ] **Step 4: Rewrite the persist path**

In `src/status-server/chat.ts`:

Add `turnRecords: TurnTokenRecord[]` to `AppendChatOptions`, importing the type from
`../repo-search/engine/turn-token-record.js`.

Delete the `let associatedToolTokens = 0;` declaration, the `associatedToolTokens += toolOutputTokens;`
line in the tool loop, and the `associatedToolTokens,` property on the answer row push.

Replace the answer row's thinking assignment. Where it currently reads:

```ts
  const thinkingTokens = explicitThinkingTokens ?? usageThinkingTokens ?? 0;
```

replace with:

```ts
  // Per-step rows own thinking. The answer row owns only the answer, so no path can both
  // aggregate onto the answer row and emit step rows for the same tokens.
  const thinkingTokens = 0;
  const thinkingTokensEstimated = false;
```

Delete `usageThinkingTokens`, `explicitThinkingTokens`, and the `thinkingTokensEstimated` ternary that
depended on them, plus `options.thinkingTokens` / `options.thinkingTokensEstimated` from
`AppendChatOptions`.

- [ ] **Step 5: Update all four call sites to pass `turnRecords`**

- `src/status-server/chat-repo-operation-runner.ts:279` — add `turnRecords: options.engineResult.turnRecords` to the options object. Thread `turnRecords` out of the engine result; if `executeRepoSearch` does not yet return them, add them to its result type alongside `scorecard`.
- `src/status-server/routes/chat.ts:901` — delete `thinkingTokens` and `thinkingTokensEstimated` from the `usage` literal; add `turnRecords` to the `ChatTurnContent` type and pass it through `persistAndRespond`.
- `src/status-server/routes/chat.ts:938` — pass `turnRecords: []`.
- `src/status-server/routes/chat.ts:1203` — delete `thinkingTokens` and `thinkingTokensEstimated` from the `usage` literal; add `turnRecords` to the options object.

- [ ] **Step 6: Drop the database column**

In `src/state/chat-sessions.ts`, remove `associated_tool_tokens` from the `INSERT` column list, remove
the matching `?` placeholder, and remove the
`toNullableNonNegativeInteger(message.associatedToolTokens),` bind value. Remove it from the row-read
mapping as well. Task 10 drops the column itself.

- [ ] **Step 7: Run tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js chat-persist-token-parity.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Prepare the commit (ask before running)**

```powershell
git add packages/contracts/src/chat.ts src/status-server src/state/chat-sessions.ts tests/chat-persist-token-parity.test.ts
git commit -m "refactor: persist per-row token counts and drop the answer-row aggregate"
```

---

## Task 10: `ContextUsageBuilder` reads stored fields

**Files:**
- Modify: `src/status-server/chat.ts:61-75, 220-245`
- Test: `tests/dashboard-status-server.test.ts` or `tests/chat-sessions-db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/context-usage-stored-fields.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContextUsage } from '../src/status-server/chat.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import type { ChatSession } from '../src/state/chat-sessions.js';
import { mockModelPreset } from './helpers/mock-config.js';

test('context usage sums the stored token fields rather than re-estimating the text', () => {
  const session: ChatSession = {
    id: 'ctx', title: 'ctx', modelPresetId: 'default',
    modelPreset: mockModelPreset({ id: 'default' }), model: null,
    contextWindowTokens: 155_000, planRepoRoot: 'C:/repo',
    createdAtUtc: '2026-09-04T00:00:00.000Z', updatedAtUtc: '2026-09-04T00:00:00.000Z',
    messages: [
      {
        id: 'm1', role: 'assistant', kind: 'assistant_thinking',
        // Deliberately short text with a large stored count: if the builder re-estimates
        // from text this assertion fails.
        content: 'hi',
        inputTokensEstimate: 0, outputTokensEstimate: 0, thinkingTokens: 5000,
        inputTokensEstimated: false, outputTokensEstimated: false, thinkingTokensEstimated: false,
        createdAtUtc: '2026-09-04T00:00:00.000Z', sourceRunId: 'run-1',
      },
    ],
  };
  const usage = buildContextUsage(getDefaultConfigObject(), session);
  assert.ok(usage.thinkingUsedTokens >= 5000);
});
```

Match the exported builder entry point's real name by reading `src/status-server/chat.ts:190-245`; if
the class is not exported directly, call whatever function wraps it (the one used by
`buildChatSessionResponse`).

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js context-usage-stored-fields.test.ts
```

Expected: FAIL — `thinkingUsedTokens` is about 1, from `estimateTokenCount('hi')`.

- [ ] **Step 3: Write the implementation**

In `src/status-server/chat.ts`, replace both estimator helpers:

```ts
function getMessageContextTokenEstimate(message: PersistedChatTranscriptMessage): number {
  if (message.kind === 'assistant_thinking') {
    return message.thinkingTokens;
  }
  return message.inputTokensEstimate
    + message.outputTokensEstimate
    + getMessageThinkingTokenEstimate(message)
    + sumImageTokens(message.imageMeta);
}

function getMessageThinkingTokenEstimate(message: PersistedChatTranscriptMessage): number {
  return message.thinkingTokens;
}
```

Update `getMessageToolTokenEstimate` the same way — read `outputTokensEstimate` on
`assistant_tool_call` rows rather than re-estimating `toolCallOutput`. Read the current body before
editing so the tool-row selector is preserved.

`formatChatMessageForPrompt` stays: it serves prompt construction, not counting.

- [ ] **Step 4: Run tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js context-usage-stored-fields.test.ts
npm run test
```

Expected: PASS. Fixture-based context-usage assertions elsewhere will shift — this is risk 1 in the
spec. Update those expected numbers to the stored-field values; do not reintroduce text estimation to
keep an old number green.

- [ ] **Step 5: Prepare the commit (ask before running)**

```powershell
git add src/status-server/chat.ts tests/context-usage-stored-fields.test.ts
git commit -m "refactor: compute context usage from stored token fields"
```

---

## Task 11: Migration 62 — backfill and drop the column

**Files:**
- Modify: `src/state/migrations/registry.ts`
- Modify: `src/state/migrations/app-config-migrations.ts`
- Test: `tests/migrations/token-accounting-backfill.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/migrations/token-accounting-backfill.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { migrateChatMessagesToPerRowTokens } from '../../src/state/migrations/app-config-migrations.js';

function createLegacyDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE chat_messages (
      session_id TEXT, id TEXT, kind TEXT, thinking_tokens INTEGER,
      output_tokens_estimate INTEGER, associated_tool_tokens INTEGER, position INTEGER
    );
  `);
  return database;
}

test('the answer row aggregate is zeroed when step rows survive', () => {
  const database = createLegacyDatabase();
  database.exec(`
    INSERT INTO chat_messages VALUES
      ('s1', 'm1', 'assistant_thinking', 120, 0, NULL, 0),
      ('s1', 'm2', 'assistant_thinking', 95, 0, NULL, 1),
      ('s1', 'm3', 'assistant_answer', 215, 60, 340, 2);
  `);
  migrateChatMessagesToPerRowTokens(database);
  const answer = database.prepare("SELECT thinking_tokens FROM chat_messages WHERE id = 'm3'").get();
  assert.deepEqual(answer, { thinking_tokens: 0 });
});

test('the aggregate moves to the last surviving thinking row when retention pruned the rest', () => {
  const database = createLegacyDatabase();
  database.exec(`
    INSERT INTO chat_messages VALUES
      ('s2', 'm1', 'assistant_thinking', 95, 0, NULL, 0),
      ('s2', 'm2', 'assistant_answer', 215, 60, 340, 1);
  `);
  migrateChatMessagesToPerRowTokens(database);
  const surviving = database.prepare("SELECT thinking_tokens FROM chat_messages WHERE id = 'm1'").get();
  const answer = database.prepare("SELECT thinking_tokens FROM chat_messages WHERE id = 'm2'").get();
  assert.deepEqual(surviving, { thinking_tokens: 215 });
  assert.deepEqual(answer, { thinking_tokens: 0 });
});

test('the associated_tool_tokens column is dropped', () => {
  const database = createLegacyDatabase();
  database.exec("INSERT INTO chat_messages VALUES ('s3', 'm1', 'assistant_answer', 0, 10, 500, 0);");
  migrateChatMessagesToPerRowTokens(database);
  const columns = database.prepare('PRAGMA table_info(chat_messages)').all();
  assert.equal(columns.some((column) => column.name === 'associated_tool_tokens'), false);
});
```

Match the repo's existing migration-test helpers — read a sibling test under `tests/` that exercises
`app-config-migrations` and reuse its database setup style rather than hand-rolling one if a helper
exists.

- [ ] **Step 2: Run test to verify it fails**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js token-accounting-backfill.test.ts
```

Expected: FAIL — `migrateChatMessagesToPerRowTokens` is not exported.

- [ ] **Step 3: Write the migration**

In `src/state/migrations/app-config-migrations.ts`, add:

```ts
/**
 * Per-row token accounting: the answer row no longer carries a run-wide thinking aggregate,
 * and tool tokens are read from the tool rows that own them instead of a denormalized column.
 */
export function migrateChatMessagesToPerRowTokens(database: Database.Database): void {
  if (!tableExists(database, 'chat_messages')) {
    return;
  }
  if (tableHasColumn(database, 'chat_messages', 'associated_tool_tokens')) {
    const answerRows = database.prepare(`
      SELECT session_id, id, thinking_tokens, position
      FROM chat_messages
      WHERE kind = 'assistant_answer' AND thinking_tokens > 0
    `).all();
    const findLatestThinking = database.prepare(`
      SELECT id FROM chat_messages
      WHERE session_id = ? AND kind = 'assistant_thinking' AND position < ?
      ORDER BY position DESC LIMIT 1
    `);
    const countThinking = database.prepare(`
      SELECT COUNT(*) AS thinkingRowCount FROM chat_messages
      WHERE session_id = ? AND kind = 'assistant_thinking' AND position < ?
    `);
    const setThinking = database.prepare('UPDATE chat_messages SET thinking_tokens = ? WHERE id = ?');
    for (const answer of answerRows) {
      const counted = countThinking.get(answer.session_id, answer.position);
      // Exactly one surviving thinking row means retention pruned the rest, so that row must
      // absorb the aggregate or the tokens are lost. More than one means the step rows are
      // already complete and the aggregate is pure duplication.
      if (counted.thinkingRowCount === 1) {
        const latest = findLatestThinking.get(answer.session_id, answer.position);
        setThinking.run(answer.thinking_tokens, latest.id);
      }
      setThinking.run(0, answer.id);
    }
    database.exec('ALTER TABLE chat_messages DROP COLUMN associated_tool_tokens;');
  }
}
```

Type the `.all()` and `.get()` results by parsing them with a Zod schema rather than asserting — the
repo forbids type assertions. Define the row schemas at the top of the function and use
`z.infer`, matching how the sibling migrations in this file already handle row reads.

- [ ] **Step 4: Register it**

In `src/state/migrations/registry.ts`, import `migrateChatMessagesToPerRowTokens` alongside the other
migration functions and append after version 61:

```ts
  {
    version: 62,
    up: (database) => {
      migrateChatMessagesToPerRowTokens(database);
    },
  },
```

- [ ] **Step 5: Run tests to verify they pass**

```powershell
npm run build:test
node .\dist\test-runner\run-tests.js token-accounting-backfill.test.ts
npm run test
```

Expected: PASS.

- [ ] **Step 6: Prepare the commit (ask before running)**

```powershell
git add src/state/migrations tests/migrations/token-accounting-backfill.test.ts
git commit -m "feat: migrate chat messages to per-row token accounting"
```

---

## Task 12: Full verification

- [ ] **Step 1: Run the whole gate**

```powershell
npm run typecheck
npm run test
npm run test:dashboard
```

Expected: all green. If `npm run test` output is large, route it through
`siftkit summary --question "Return pass/fail, failing tests, root errors, and relevant file:line anchors."`
per the repo's large-output rule.

- [ ] **Step 2: Confirm the invariant by hand**

Start the dev server, open a chat session, and run a repo-search operation with enough steps to reach
turn 10 or more. Watch the badge across the live to settled transition at the end of the run.

Expected: the badge number does not change when the turn settles. Before this work it dropped on the
repo-operation path.

- [ ] **Step 3: Confirm no orphaned references remain**

```powershell
git grep -n "associatedToolTokens\|associated_tool_tokens\|liveToolPromptStep\|LiveToolPromptStep\|context tokens"
```

Expected: no hits outside this plan and the spec. Any hit is an incomplete replacement and must be
removed, not left as a compatibility path.

---

## Self-review notes

**Spec coverage:** Architecture items 1-7 map to Tasks 2, 3+4, 5, 7, 9, 10, 8 respectively. Migration
maps to Task 11. All five spec test requirements are covered: headline regression (Task 8 Step 1),
four-call-site parity (Task 9 Step 1), context bar from stored fields (Task 10 Step 1), migration
backfill (Task 11 Step 1), calibration convergence (Task 8 Step 6).

**Known judgement calls left to the implementer**, each flagged inline at the point of use rather than
deferred:

- The exact `ChatTurn` shape in Task 8's test fixtures — read `chatTurns.ts` and match.
- The exported entry point for `ContextUsageBuilder` in Task 10 — read `chat.ts:190-245` and match.
- Whether `executeRepoSearch`'s result already carries `turnRecords` in Task 9 Step 5 — thread it
  through if not.
- The migration row-schema definitions in Task 11 Step 3 — follow the sibling migrations' existing
  Zod-parsing style.

**Deferred from the spec:** whether the provider streams one chunk per token. If it does, the
calibrated tail in Task 8 could later be replaced by an exact count. It does not block this plan.
