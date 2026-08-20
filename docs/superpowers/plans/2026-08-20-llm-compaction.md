# LLM-Based Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lossy truncation-based prompt compaction and the 2400-character manual chat "condense" with a single LLM-based compactor that summarizes the conversation when the prompt hits the budget, for every loop kind.

**Architecture:** One engine-level `TranscriptCompactor` runs a single summarization request against the active model when `PromptPreparer` sees a preflight overflow, then rebuilds the transcript as `system → summary → latest user message`. The `'compact' | 'fail'` policy split is deleted; every loop kind compacts. `TurnBudget` reserves a fixed compaction budget so the summarization request always fits single-shot. Chat carries the summary out on `TaskResult.compactionSummary` and persists it as a `compaction_summary` chat message with `compressed_into_summary` flags on everything before it; `buildChatHistoryMessages` replays that shape so the next turn neither re-overflows nor double-compacts. The dashboard renders the boundary as a divider + collapsible originals + a summary card.

**Tech Stack:** TypeScript (ESM, NodeNext), zod (`src/lib/zod.js`), `node:test` + `node:assert/strict`, better-sqlite3 runtime DB with numbered migrations, React 19 dashboard tested with `renderToStaticMarkup`.

---

## Deviation from the design spec (read first)

Spec §2.1 asks for a `compaction` run-event on the progress stream that the chat *stream* handler persists. That transport cannot satisfy spec §4's atomicity requirement on the **non-streaming** chat endpoint (`CreateChatMessageEndpoint` → `ChatMessageTurn.runEngineTurn`, `src/status-server/routes/chat.ts:746`), which passes **no** `progressWriter` at all and would silently lose every compaction.

This plan instead carries the summary on the run result — `TaskResult.compactionSummary` → `Scorecard.tasks[].compactionSummary` → both chat endpoints — which is the same channel chat already uses to persist thinking and tool bubbles (`buildPersistTurnsFromRepoSearchResult`). It lands in the same `saveChatSession` write as the turn's messages, exactly as spec §4 requires. Everything else in the spec is implemented as written. The `turn_preflight_compaction_applied` log event still carries the compaction telemetry for non-chat loops.

## File structure

**New files**
- `src/repo-search/engine/transcript-compactor.ts` — the compactor: summarization request with one retry, single-shot fit guarantee, transcript rebuild, marker constant. Also exports the standalone summarizer used by the manual condense endpoint.
- `tests/engine-transcript-compactor.test.ts` — unit tests for the compactor.
- `tests/runtime-db-schema-v50.test.ts` — migration test.

**Modified — engine**
- `src/repo-search/engine/turn-budget.ts` — compaction reserve constants + `usablePromptTokens` math.
- `src/repo-search/prompts.ts` — `buildCompactionSummaryPrompt`.
- `src/repo-search/planner-protocol.ts` — `requestContextCompactionSummary`.
- `src/repo-search/engine/prompt-preparer.ts` — call the compactor; drop the policy branch.
- `src/repo-search/engine/task-loop.ts` — build the compactor; thread the mock cursor; record `compactionSummary`.
- `src/repo-search/engine/task-loop-support.ts` — delete `ContextOverflowPolicy`; add `compactionSummary` to `TaskResultSchema`.
- `src/repo-search/engine.ts`, `src/repo-search/execute.ts`, `src/repo-search/index.ts`, `src/repo-search/prompt-budget.ts` — delete the old compactor and the policy option.

**Modified — persistence**
- `src/state/runtime-db.ts` — schema version 50; base schema drops `condensed_summary`.
- `src/state/migrations/registry.ts` — migration 50.
- `src/state/chat-sessions.ts` — `compaction_summary` kind; drop `condensedSummary`.
- `packages/contracts/src/chat.ts` — same two contract changes.
- `src/status-server/chat.ts` — persist the summary row; replay it; new `condenseChatSession`.
- `src/status-server/routes/chat.ts` — pass `compactionSummary` through both turn paths; rebuild the condense endpoint.
- `src/status-server/repo-search-scorecard-types.ts` — read `compactionSummary`.
- `src/status-server/preset-runner.ts` — drop `condensedSummary`.

**Modified — dashboard**
- `dashboard/src/tabs/ChatTab.tsx` — compaction boundary rendering; remove the old `<pre>` block.
- `dashboard/src/styles/chat.css` — styles for the divider, dimmed originals, summary card.

---

### Task 1: Compaction reserve in `TurnBudget`

The summarization request must always fit in one shot. Today a turn may grow the transcript to `usablePromptTokens + responseReserveTokens` ≈ the whole context window, leaving no room for a summary. Reserving a fixed slice of the tool-result budget bounds the worst-case transcript at `totalContextTokens - compactionReserveTokens`.

**Files:**
- Modify: `src/repo-search/engine/turn-budget.ts:1-40`
- Test: `tests/engine-turn-budget.test.ts:15-95`

- [ ] **Step 1: Write the failing tests**

In `tests/engine-turn-budget.test.ts`, replace the bodies of the four existing numeric tests and add two new ones. The file's head already has:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TURN_TOOL_RESULT_RATIO, TurnBudget } from '../src/repo-search/engine/turn-budget.js';
```

Change that import line to:

```ts
import {
  COMPACTION_RESERVE_TOKENS,
  MIN_TURN_TOOL_RESULT_RATIO,
  TurnBudget,
} from '../src/repo-search/engine/turn-budget.js';
```

Then update these tests to the new expected numbers (the reserve is 10 000, clamped to half of the post-response-reserve budget):

```ts
test('TurnBudget splits context into the shared response reserve and usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, 15_000);
  assert.equal(budget.compactionReserveTokens, 10_000);
  assert.equal(budget.usablePromptTokens, 115_000);
});

test('TurnBudget clamps the reserve to half of a small context', () => {
  const budget = new TurnBudget({ totalContextTokens: 8_000, maxTurns: 45, config: null });
  assert.equal(budget.responseReserveTokens, 4_000);
  // 4000 usable before the compaction reserve, which may never take more than half.
  assert.equal(budget.compactionReserveTokens, 2_000);
  assert.equal(budget.usablePromptTokens, 2_000);
});

test('TurnBudget bounds the reserve by the active preset MaxTokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 140_000, maxTurns: 45, config: configWithMaxTokens(8_000) });
  assert.equal(budget.responseReserveTokens, 8_000);
  assert.equal(budget.usablePromptTokens, 122_000);
});

test('usablePromptTokens never goes negative', () => {
  const budget = new TurnBudget({ totalContextTokens: 1, maxTurns: 45, config: null });
  assert.equal(budget.compactionReserveTokens, 0);
  assert.equal(budget.usablePromptTokens, 0);
});

test('the compaction reserve leaves room for a whole summarization request', () => {
  const budget = new TurnBudget({ totalContextTokens: 150_000, maxTurns: 45, config: null });
  const worstCaseTranscriptTokens = budget.usablePromptTokens + budget.responseReserveTokens;
  assert.equal(worstCaseTranscriptTokens, budget.totalContextTokens - COMPACTION_RESERVE_TOKENS);
});
```

Also update the two per-tool-cap tests that pin absolute numbers (previously `85_000` / `6_375`):

```ts
test('perToolCapTokens grants the floor share of usable prompt tokens', () => {
  const budget = new TurnBudget({ totalContextTokens: 100_000, maxTurns: 45, config: null });
  assert.equal(budget.usablePromptTokens, 75_000);
  assert.equal(budget.perToolCapTokens(0, 1), Math.floor(75_000 * MIN_TURN_TOOL_RESULT_RATIO));
  assert.equal(budget.perToolCapTokens(0, 1), 5_625);
});
```

and, in the "grows with progress" test at line 46, change the `early` expectation from `Math.floor(85_000 * MIN_TURN_TOOL_RESULT_RATIO)` to `Math.floor(75_000 * MIN_TURN_TOOL_RESULT_RATIO)`.

- [ ] **Step 2: Run the tests to verify they fail**

```
npm run build:test
npm run test -- engine-turn-budget.test.ts
```

Expected: FAIL — `COMPACTION_RESERVE_TOKENS` is not exported and `budget.compactionReserveTokens` is `undefined`.

- [ ] **Step 3: Implement the reserve**

In `src/repo-search/engine/turn-budget.ts`, add the constants after `DEFAULT_MAX_TURNS` (line 13):

```ts
// Hard cap on one compaction summary's output. Also the output half of the compaction
// reserve below.
export const COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS = 4_000;

// Withheld from the tool-result budget so a summarization request always fits in one
// shot: the summary's own output plus headroom for the summarization instruction and
// the (tool-free) provider overhead of that request.
export const COMPACTION_RESERVE_TOKENS = 10_000;
```

Then replace the class fields and constructor tail:

```ts
export class TurnBudget {
  readonly totalContextTokens: number;
  readonly responseReserveTokens: number;
  readonly compactionReserveTokens: number;
  readonly usablePromptTokens: number;
  private readonly maxTurns: number;

  constructor(options: { totalContextTokens: number; maxTurns: number; config: SiftConfig | null | undefined }) {
    this.totalContextTokens = Math.max(1, Math.floor(Number(options.totalContextTokens) || 0));
    this.maxTurns = Math.max(1, options.maxTurns);
    this.responseReserveTokens = computeResponseReserveTokens({
      totalContextTokens: this.totalContextTokens,
      config: options.config,
    });
    const promptTokensBeforeCompactionReserve = Math.max(this.totalContextTokens - this.responseReserveTokens, 0);
    // Never more than half the prompt budget: on a tiny context window a fixed 10k
    // reserve would leave no room for any tool result at all.
    this.compactionReserveTokens = Math.min(
      COMPACTION_RESERVE_TOKENS,
      Math.floor(promptTokensBeforeCompactionReserve / 2),
    );
    this.usablePromptTokens = Math.max(promptTokensBeforeCompactionReserve - this.compactionReserveTokens, 0);
  }
```

Leave `perToolCapTokens` and `remainingToolAllowance` unchanged — they already read `usablePromptTokens`.

- [ ] **Step 4: Run the tests to verify they pass**

```
npm run build:test
npm run test -- engine-turn-budget.test.ts
```

Expected: PASS.

- [ ] **Step 5: Repair the loop tests that pinned the old budget math**

Three tests in `tests/mock-repo-search-loop.test.ts` recompute the budget by hand and drift as a result. Replace the hand math with a real `TurnBudget`.

Add to the imports at line 18:

```ts
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
```

and delete the now-unused `MIN_TURN_TOOL_RESULT_RATIO` and `computeResponseReserveTokens` imports (lines 18-19) if nothing else in the file uses them.

In `runTaskLoop truncates oversized rg output to the largest fitting prefix` (line 329), replace lines 331-334 with:

```ts
  const totalContextTokens = 20000;
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 3, config: MOCK_LOOP_DEFAULTS.config });
  const baselinePerToolCapTokens = budget.perToolCapTokens(0, 1);
```

In `runTaskLoop increases per-tool cap as tool-call progress grows` (line 1046), replace lines 1048-1052 with:

```ts
  const totalContextTokens = 20000;
  const budget = new TurnBudget({ totalContextTokens, maxTurns: 10, config: MOCK_LOOP_DEFAULTS.config });
  const baselinePerToolCapTokens = budget.perToolCapTokens(0, 1);
  const expectedThirdCommandCap = budget.perToolCapTokens(2, 1);
```

In `runTaskLoop fits tool output that exceeds remaining token allowance` (line 1094), the scenario is tuned to 25 500 usable prompt tokens. Keep that number by growing the window by the new reserve — replace lines 1096-1098 with:

```ts
  // 15k goes to the shared response reserve and 10k to the compaction reserve, leaving
  // the 25500 usable prompt tokens this scenario is tuned to.
  const totalContextTokens = 50500;
```

- [ ] **Step 6: Run the affected suites**

```
npm run build:test
npm run test -- mock-repo-search-loop.test.ts
npm run test -- line-read-guidance.test.ts
npm run test -- engine-tool-action-processor.test.ts
```

Expected: PASS. (`line-read-guidance` and `engine-tool-action-processor` derive their expectations from `TurnBudget` methods and need no edits.)

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/turn-budget.ts tests/engine-turn-budget.test.ts tests/mock-repo-search-loop.test.ts
git commit -m "feat(budget): reserve prompt budget for single-shot compaction"
```

---

### Task 2: Summarization prompt and provider request

**Files:**
- Modify: `src/repo-search/prompts.ts:352-372` (add after `buildTerminalSynthesisPrompt`)
- Modify: `src/repo-search/planner-protocol.ts:852-884` (add after `requestTerminalSynthesis`)
- Test: `tests/repo-search-prompts.test.ts` (create if absent — check with `ls tests | grep prompts`)

- [ ] **Step 1: Write the failing test**

Create or extend `tests/repo-search-prompts.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCompactionSummaryPrompt } from '../src/repo-search/prompts.js';

test('buildCompactionSummaryPrompt demands every section the resumed model needs', () => {
  const prompt = buildCompactionSummaryPrompt('[user]\nfind the bug\n[tool]\nError: ENOENT foo.ts');

  assert.match(prompt, /Task and goal/u);
  assert.match(prompt, /Current state/u);
  assert.match(prompt, /Key findings/u);
  assert.match(prompt, /file:line/u);
  assert.match(prompt, /Decisions made/u);
  assert.match(prompt, /Tool results that still matter/u);
  assert.match(prompt, /verbatim/u);
  assert.match(prompt, /In-flight work/u);
  assert.match(prompt, /Error: ENOENT foo\.ts/u);
});

test('buildCompactionSummaryPrompt marks an empty transcript instead of emitting nothing', () => {
  assert.match(buildCompactionSummaryPrompt('   '), /\[none\]/u);
});
```

- [ ] **Step 2: Run it to verify it fails**

```
npm run build:test
npm run test -- repo-search-prompts.test.ts
```

Expected: FAIL with `buildCompactionSummaryPrompt is not a function` (or a module-resolution error if the test file is new and unbuilt — re-run `npm run build:test`).

- [ ] **Step 3: Add the prompt builder**

In `src/repo-search/prompts.ts`, directly after `buildTerminalSynthesisPrompt` (ends line 372):

```ts
export function buildCompactionSummaryPrompt(transcriptText: string): string {
  const conversationText = transcriptText.trim() || '[none]';
  return [
    'You are compacting a long working conversation so the same model can resume it from the summary alone.',
    'The conversation below will be deleted and replaced by what you write. Nothing else survives.',
    'Write the summary as plain prose under these headings, in this order:',
    '1. Task and goal — what was asked, in the requester\'s terms.',
    '2. Current state — what is done, what is not.',
    '3. Key findings — concrete evidence, each with a file:line anchor where one exists.',
    '4. Decisions made — choices already settled, and why, so they are not relitigated.',
    '5. Tool results that still matter — reproduce exact error text, command output and identifiers verbatim.',
    '6. In-flight work — pending edits, the current hypothesis, and the next intended command.',
    'Rules:',
    '- Write for the model that must continue the work, not for a reader looking back.',
    '- Never invent a path, line number, symbol or result that is not in the conversation.',
    '- Prefer dropping commentary over dropping a concrete anchor or an exact error string.',
    '- Output the summary only. No preamble, no meta-commentary about summarizing.',
    '',
    'Conversation to compact:',
    conversationText,
  ].join('\n');
}
```

- [ ] **Step 4: Add the provider request**

In `src/repo-search/planner-protocol.ts`, directly after `requestTerminalSynthesis` (ends line 884):

```ts
/**
 * The context-compaction summarization call. Free-form text, no tools and no response
 * schema: the output becomes an assistant message, not a planner action.
 */
export async function requestContextCompactionSummary(options: Partial<PlannerThinkingFlags> & {
  config: SiftConfig;
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  maxTokens: number;
  slotId?: number;
  mockResponses?: string[];
  mockResponseIndex?: number;
  abortSignal?: AbortSignal;
  logger?: JsonLogger | null;
}): Promise<PlannerActionResponse> {
  return requestRepoSearchPlannerProtocolAction({
    config: options.config,
    baseUrl: options.baseUrl,
    model: options.model,
    messages: serializeProtocolMessages([{ role: 'user', content: options.prompt }], options.reasoningContentEnabled === true),
    slotId: options.slotId,
    timeoutMs: options.timeoutMs,
    maxTokens: options.maxTokens,
    thinkingEnabled: options.thinkingEnabled,
    reasoningContentEnabled: options.reasoningContentEnabled,
    preserveThinking: options.preserveThinking,
    mockResponses: options.mockResponses,
    mockResponseIndex: options.mockResponseIndex,
    abortSignal: options.abortSignal,
    logger: options.logger,
    stage: 'context_compaction',
    responseSchema: null,
    toolDefinitions: [],
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```
npm run build:test
npm run test -- repo-search-prompts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repo-search/prompts.ts src/repo-search/planner-protocol.ts tests/repo-search-prompts.test.ts
git commit -m "feat(compaction): add summarization prompt and provider request"
```

---

### Task 3: `TranscriptCompactor`

**Files:**
- Create: `src/repo-search/engine/transcript-compactor.ts`
- Test: `tests/engine-transcript-compactor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/engine-transcript-compactor.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPACTION_SUMMARY_MARKER,
  TranscriptCompactor,
} from '../src/repo-search/engine/transcript-compactor.js';
import type { ChatMessage } from '../src/repo-search/planner-protocol.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';

function makeCompactor(mockResponses: string[] | undefined, totalContextTokens = 32_000): TranscriptCompactor {
  const config = mockOfflineSiftConfig();
  return new TranscriptCompactor({
    config,
    baseUrl: DEAD_BASE_URL,
    model: 'mock-model',
    timeoutMs: 5_000,
    totalContextTokens,
    thinking: { thinkingEnabled: false, reasoningContentEnabled: false, preserveThinking: false },
    useEstimatedTokensOnly: Array.isArray(mockResponses),
    mockResponses,
    tokenUsage: new TokenUsageTracker(config, true),
    logger: null,
    abortSignal: undefined,
  });
}

function transcript(): ChatMessage[] {
  return [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'original question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'git', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'src/a.ts:12: hit' },
    { role: 'user', content: 'latest user intent' },
  ];
}

test('compact rebuilds the transcript as system, summary, latest user message', async () => {
  const compactor = makeCompactor(['SUMMARY BODY']);

  const outcome = await compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0 });

  assert.deepEqual(outcome.messages.map((message) => message.role), ['system', 'assistant', 'user']);
  assert.equal(outcome.messages[0].content, 'SYSTEM PROMPT');
  assert.equal(outcome.messages[1].content, `${COMPACTION_SUMMARY_MARKER}\nSUMMARY BODY`);
  assert.equal(outcome.messages[2].content, 'latest user intent');
  assert.equal(outcome.summaryText, 'SUMMARY BODY');
  assert.equal(outcome.droppedMessageCount, 3);
  assert.equal(outcome.summaryTokenCount > 0, true);
  assert.equal(outcome.nextMockResponseIndex, 1);
});

test('compact sends the transcript minus the system prompt to the summarizer', async () => {
  const compactor = makeCompactor([]);

  // No mock responses left: the request layer reports exhaustion, and the error text
  // must name the stage rather than the transcript.
  await assert.rejects(
    compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0 }),
    /planner_compaction_failed/u,
  );
});

test('compact retries the summarizer once before failing', async () => {
  const compactor = makeCompactor(['', 'RECOVERED SUMMARY']);

  const outcome = await compactor.compact({ taskId: 't1', turn: 4, messages: transcript(), mockResponseIndex: 0 });

  assert.equal(outcome.summaryText, 'RECOVERED SUMMARY');
  assert.equal(outcome.nextMockResponseIndex, 2);
});

test('compact fails hard when the summarization prompt cannot fit single-shot', async () => {
  const compactor = makeCompactor(['SUMMARY BODY'], 5_000);
  const oversized: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'Q'.repeat(40_000) },
  ];

  await assert.rejects(
    compactor.compact({ taskId: 't1', turn: 1, messages: oversized, mockResponseIndex: 0 }),
    /planner_compaction_prompt_overflow prompt_tokens=\d+/u,
  );
});

test('compact keeps a transcript with no user message to system plus summary', async () => {
  const compactor = makeCompactor(['SUMMARY BODY']);
  const messages: ChatMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'assistant', content: 'assistant only' },
  ];

  const outcome = await compactor.compact({ taskId: 't1', turn: 2, messages, mockResponseIndex: 0 });

  assert.deepEqual(outcome.messages.map((message) => message.role), ['system', 'assistant']);
  assert.equal(outcome.droppedMessageCount, 1);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- engine-transcript-compactor.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the compactor**

Create `src/repo-search/engine/transcript-compactor.ts`:

```ts
import type { SiftConfig } from '../../config/index.js';
import { clampToPresetMaxTokens } from '../../lib/dynamic-output-cap.js';
import {
  requestContextCompactionSummary,
  renderTaskTranscript,
  type ChatMessage,
  type PlannerThinkingFlags,
} from '../planner-protocol.js';
import { buildCompactionSummaryPrompt } from '../prompts.js';
import { countTokensWithFallback } from '../prompt-budget.js';
import type { JsonLogger } from '../types.js';
import { TokenUsageTracker } from './token-usage.js';
import { COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS } from './turn-budget.js';

/** Marks the rebuilt assistant message so the model reads it as history, not as its own answer. */
export const COMPACTION_SUMMARY_MARKER = '[CONTEXT COMPACTED — SUMMARY OF PRIOR CONVERSATION]';

/** One backend hiccup is worth retrying; a second identical failure is a real failure. */
const COMPACTION_SUMMARY_ATTEMPTS = 2;

export type CompactionOutcome = {
  messages: ChatMessage[];
  summaryText: string;
  droppedMessageCount: number;
  summaryTokenCount: number;
  summarizerElapsedMs: number;
  nextMockResponseIndex: number;
};

/** The assistant message the rebuilt transcript carries in place of the dropped history. */
export function buildCompactionSummaryMessage(summaryText: string): ChatMessage {
  return { role: 'assistant', content: `${COMPACTION_SUMMARY_MARKER}\n${summaryText}` };
}

export class TranscriptCompactor {
  constructor(private readonly options: {
    config: SiftConfig;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    totalContextTokens: number;
    thinking: PlannerThinkingFlags;
    useEstimatedTokensOnly: boolean;
    mockResponses: string[] | undefined;
    tokenUsage: TokenUsageTracker;
    slotId?: number;
    logger: JsonLogger | null;
    abortSignal: AbortSignal | undefined;
  }) {}

  private get tokenCountConfig(): SiftConfig | undefined {
    return this.options.useEstimatedTokensOnly ? undefined : this.options.config;
  }

  async compact(input: {
    taskId: string;
    turn: number;
    messages: readonly ChatMessage[];
    mockResponseIndex: number;
  }): Promise<CompactionOutcome> {
    const messages = [...input.messages];
    const systemMessage = String(messages[0]?.role || '') === 'system' ? messages[0] : null;
    const summarizableMessages = systemMessage ? messages.slice(1) : messages;
    const prompt = buildCompactionSummaryPrompt(renderTaskTranscript(summarizableMessages));
    const maxOutputTokens = clampToPresetMaxTokens(this.options.config, COMPACTION_SUMMARY_MAX_OUTPUT_TOKENS);
    await this.assertPromptFitsSingleShot(input, prompt, maxOutputTokens);

    const summary = await this.requestSummary(input, prompt, maxOutputTokens);
    const latestUserMessage = findLatestUserMessage(messages);
    const rebuilt: ChatMessage[] = [
      ...(systemMessage ? [systemMessage] : []),
      buildCompactionSummaryMessage(summary.summaryText),
      ...(latestUserMessage ? [latestUserMessage] : []),
    ];
    const keptMessageCount = (systemMessage ? 1 : 0) + (latestUserMessage ? 1 : 0);

    return {
      messages: rebuilt,
      summaryText: summary.summaryText,
      droppedMessageCount: messages.length - keptMessageCount,
      summaryTokenCount: await countTokensWithFallback(this.tokenCountConfig, summary.summaryText),
      summarizerElapsedMs: summary.elapsedMs,
      nextMockResponseIndex: summary.nextMockResponseIndex,
    };
  }

  /**
   * Unreachable unless the TurnBudget compaction reserve regressed: a transcript is
   * capped so this request always fits. Name the real counts rather than silently
   * chunking, so the cap math is what gets fixed.
   */
  private async assertPromptFitsSingleShot(
    input: { taskId: string; turn: number },
    prompt: string,
    maxOutputTokens: number,
  ): Promise<void> {
    const promptTokenCount = await countTokensWithFallback(this.tokenCountConfig, prompt);
    const availableTokens = this.options.totalContextTokens - maxOutputTokens;
    if (promptTokenCount <= availableTokens) {
      return;
    }
    const message = `planner_compaction_prompt_overflow prompt_tokens=${promptTokenCount} `
      + `available_tokens=${availableTokens} total_context_tokens=${this.options.totalContextTokens} `
      + `summary_output_tokens=${maxOutputTokens} turn=${input.turn}`;
    this.options.logger?.write({
      kind: 'turn_compaction_prompt_overflow_fail',
      taskId: input.taskId,
      turn: input.turn,
      promptTokenCount,
      availableTokens,
      totalContextTokens: this.options.totalContextTokens,
      summaryOutputTokens: maxOutputTokens,
      error: message,
    });
    throw new Error(message);
  }

  private async requestSummary(
    input: { taskId: string; turn: number; mockResponseIndex: number },
    prompt: string,
    maxOutputTokens: number,
  ): Promise<{ summaryText: string; nextMockResponseIndex: number; elapsedMs: number }> {
    let mockResponseIndex = input.mockResponseIndex;
    let lastErrorMessage = '';
    for (let attempt = 1; attempt <= COMPACTION_SUMMARY_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await requestContextCompactionSummary({
          config: this.options.config,
          baseUrl: this.options.baseUrl,
          model: this.options.model,
          prompt,
          timeoutMs: this.options.timeoutMs,
          maxTokens: maxOutputTokens,
          slotId: this.options.slotId,
          ...this.options.thinking,
          mockResponses: this.options.mockResponses,
          mockResponseIndex,
          abortSignal: this.options.abortSignal,
          logger: this.options.logger,
        });
        if (typeof response.nextMockResponseIndex === 'number') {
          mockResponseIndex = response.nextMockResponseIndex;
        }
        const resolved = await this.options.tokenUsage.recordModelResponse(response, 0);
        this.options.tokenUsage.addOutputTokens(resolved.completionTokens, resolved.completionTokensEstimated);
        const summaryText = String(response.text || '').trim();
        if (!response.mockExhausted && summaryText) {
          return { summaryText, nextMockResponseIndex: mockResponseIndex, elapsedMs: Date.now() - startedAt };
        }
        lastErrorMessage = response.mockExhausted ? 'mock_exhausted' : 'empty_output';
      } catch (error) {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
      }
      this.options.logger?.write({
        kind: 'turn_compaction_summary_retry',
        taskId: input.taskId,
        turn: input.turn,
        attempt,
        error: lastErrorMessage,
      });
    }
    throw new Error(
      `planner_compaction_failed attempts=${COMPACTION_SUMMARY_ATTEMPTS} turn=${input.turn} `
      + `last_error=${lastErrorMessage || 'unknown'}`,
    );
  }
}

function findLatestUserMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message.role || '') === 'user') {
      return message;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npm run build:test
npm run test -- engine-transcript-compactor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/engine/transcript-compactor.ts tests/engine-transcript-compactor.test.ts
git commit -m "feat(compaction): add the LLM transcript compactor"
```

---

### Task 4: Wire the compactor into `PromptPreparer` and delete the overflow policy

**Files:**
- Modify: `src/repo-search/engine/prompt-preparer.ts` (whole file)
- Modify: `src/repo-search/engine/task-loop.ts:271-284, 393-414`
- Modify: `src/repo-search/engine/task-loop-support.ts:151, 164`
- Modify: `src/repo-search/engine.ts:23, 145, 225`
- Modify: `src/repo-search/execute.ts:402`
- Test: `tests/engine-prompt-preparer.test.ts` (whole file)

- [ ] **Step 1: Rewrite the preparer tests**

Replace `tests/engine-prompt-preparer.test.ts` entirely:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { PromptPreparer } from '../src/repo-search/engine/prompt-preparer.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import {
  COMPACTION_SUMMARY_MARKER,
  TranscriptCompactor,
} from '../src/repo-search/engine/transcript-compactor.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { mockOfflineSiftConfig } from './helpers/mock-config.js';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.js';

const NO_THINKING = { thinkingEnabled: false, reasoningContentEnabled: false, preserveThinking: false };

function makePreparer(
  budget: TurnBudget,
  transcript: TranscriptManager,
  mockResponses: string[] = ['SUMMARY BODY'],
  events: Array<Record<string, JsonSerializable>> = [],
): PromptPreparer {
  const config = mockOfflineSiftConfig();
  const logger = {
    path: 'memory',
    write(event: Record<string, JsonSerializable>): void {
      events.push(event);
    },
  };
  return new PromptPreparer({
    taskId: 't1',
    model: 'mock-model',
    config,
    useEstimatedTokensOnly: true,
    budget,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
    thinking: NO_THINKING,
    transcript,
    compactor: new TranscriptCompactor({
      config,
      baseUrl: DEAD_BASE_URL,
      model: 'mock-model',
      timeoutMs: 5_000,
      totalContextTokens: budget.totalContextTokens,
      thinking: NO_THINKING,
      useEstimatedTokensOnly: true,
      mockResponses,
      tokenUsage: new TokenUsageTracker(config, true),
      logger,
      abortSignal: undefined,
    }),
    progress: new ProgressReporter({
      progressWriter: new SilentProgressWriter<RepoSearchProgressEvent>(),
      taskId: 't1',
      maxTurns: 45,
      taskStartedAt: Date.now(),
    }),
    logger,
    timingRecorder: null,
  });
}

function makeCompactableTranscript(): TranscriptManager {
  return new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'assistant', content: 'H'.repeat(24_000) }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
}

test('prepareTurn returns a token count and output budget for a small prompt', async () => {
  const transcript = new TranscriptManager({ systemPromptContent: 'SYSTEM', historyMessages: [], initialUserContent: 'short question', initialUserImages: [], liveImagePathKeys: new Set<string>() });
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45, config: null }), transcript);

  const prepared = await preparer.prepareTurn(1, 0);

  assert.ok(prepared.promptTokenCount > 0);
  assert.ok(prepared.maxOutputTokens > 0);
  assert.equal(prepared.compactionSummary, null);
  assert.equal(prepared.nextMockResponseIndex, 0);
});

test('prepareTurn compacts an overflowing transcript to system, summary, latest user', async () => {
  const transcript = makeCompactableTranscript();
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45, config: null }),
    transcript,
    ['SUMMARY BODY'],
    events,
  );

  const prepared = await preparer.prepareTurn(1, 0);

  assert.deepEqual(transcript.messageRoles(), ['system', 'assistant', 'user']);
  assert.match(transcript.render(), new RegExp(COMPACTION_SUMMARY_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(transcript.render(), /SUMMARY BODY/u);
  assert.equal(prepared.compactionSummary, 'SUMMARY BODY');
  assert.equal(prepared.nextMockResponseIndex, 1);
  assert.equal(transcript.generation, 1);

  const applied = events.find((event) => event.kind === 'turn_preflight_compaction_applied');
  assert.ok(applied);
  assert.equal(Number(applied.droppedMessageCount) > 0, true);
  assert.equal(Number(applied.summaryTokenCount) > 0, true);
  assert.equal(Number(applied.summarizerElapsedMs) >= 0, true);
});

test('prepareTurn compacts at most once per turn and then reports overflow', async () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'S'.repeat(200_000), // never dropped, so the compacted prompt still overflows
    historyMessages: [{ role: 'assistant', content: 'H'.repeat(24_000) }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45, config: null }),
    transcript,
    ['SUMMARY BODY', 'SECOND SUMMARY'],
    events,
  );

  await assert.rejects(preparer.prepareTurn(1, 0), /planner_preflight_overflow/u);

  assert.equal(events.filter((event) => event.kind === 'turn_preflight_compaction_applied').length, 1);
});

test('prepareTurn releases image guards for attachments dropped by compaction', async () => {
  const liveImagePathKeys = new Set<string>(['repo/shot.png']);
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [
      { role: 'assistant', content: 'H'.repeat(24_000) },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }], imagePathKey: 'repo/shot.png' },
    ],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys,
  });
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45, config: null }), transcript);

  await preparer.prepareTurn(1, 0);

  assert.equal(liveImagePathKeys.has('repo/shot.png'), false);
});

test('prepareTurn surfaces a summarizer failure as planner_compaction_failed', async () => {
  const transcript = makeCompactableTranscript();
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45, config: null }),
    transcript,
    [],
  );

  await assert.rejects(preparer.prepareTurn(1, 0), /planner_compaction_failed/u);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- engine-prompt-preparer.test.ts
```

Expected: FAIL — `PromptPreparer` has no `compactor` option and `prepareTurn` takes one argument.

- [ ] **Step 3: Rewrite `PromptPreparer`**

Replace the whole of `src/repo-search/engine/prompt-preparer.ts`:

```ts
import type { SiftConfig } from '../../config/index.js';
import { getDynamicMaxOutputTokens } from '../../lib/dynamic-output-cap.js';
import type { TemporaryTimingRecorder } from '../../lib/temporary-timing-recorder.js';
import {
  buildPlannerRequestPromptReserveText,
  resolveRepoSearchPlannerToolDefinitions,
  type PlannerThinkingFlags,
} from '../planner-protocol.js';
import { IncrementalTokenCounter } from '../incremental-token-counter.js';
import { preflightPlannerPromptBudget } from '../prompt-budget.js';
import type { JsonLogger } from '../types.js';
import { ProgressReporter } from './progress-reporter.js';
import { TranscriptManager } from './transcript-manager.js';
import { TranscriptCompactor } from './transcript-compactor.js';
import { TurnBudget } from './turn-budget.js';

export type PreparedTurnBudget = {
  promptTokenCount: number;
  maxOutputTokens: number;
  /** The raw summary text when this turn compacted, else null. */
  compactionSummary: string | null;
  nextMockResponseIndex: number;
};

export class PromptPreparer {
  constructor(
    private readonly options: {
      taskId: string;
      model: string;
      config: SiftConfig;
      useEstimatedTokensOnly: boolean;
      budget: TurnBudget;
      plannerToolDefinitions: ReturnType<typeof resolveRepoSearchPlannerToolDefinitions>;
      thinking: PlannerThinkingFlags;
      transcript: TranscriptManager;
      compactor: TranscriptCompactor;
      progress: ProgressReporter;
      logger: JsonLogger | null;
      timingRecorder: TemporaryTimingRecorder | null;
    },
  ) {}

  private readonly transcriptTokenCounter = new IncrementalTokenCounter();
  private readonly reserveTokenCounter = new IncrementalTokenCounter();

  private buildProviderPromptReserveText(messageRoles: readonly string[], maxTokens: number, stream: boolean): string {
    return buildPlannerRequestPromptReserveText({
      config: this.options.config,
      stage: 'planner_action',
      model: String(this.options.model || ''),
      messageRoles,
      toolDefinitions: this.options.plannerToolDefinitions,
      maxTokens,
      ...this.options.thinking,
      stream,
    });
  }

  async prepareTurn(turn: number, mockResponseIndex: number): Promise<PreparedTurnBudget> {
    const { taskId, budget, transcript, progress } = this.options;
    const promptRenderSpan = this.options.timingRecorder?.start('repo.prompt.render', {
      taskId,
      turn,
      messageCount: transcript.length,
    });
    let providerPromptReserveText = this.buildProviderPromptReserveText(
      transcript.messageRoles(),
      budget.totalContextTokens,
      progress.enabled,
    );
    let prompt = transcript.render();
    promptRenderSpan?.end({
      promptChars: prompt.length,
      providerPromptReserveChars: providerPromptReserveText.length,
    });
    const preflightSpan = this.options.timingRecorder?.start('repo.prompt.preflight', {
      taskId,
      turn,
    });
    progress.preflightStart(turn, prompt.length);
    this.options.logger?.write({ kind: 'turn_preflight_start', taskId, turn, promptChars: prompt.length });
    const preflightConfig = this.options.useEstimatedTokensOnly ? undefined : this.options.config;
    if (preflightConfig) {
      progress.tokenizeStart(turn, prompt.length);
    }
    let preflight = await preflightPlannerPromptBudget({
      config: preflightConfig,
      prompt,
      providerPromptReserveText,
      totalContextTokens: budget.totalContextTokens,
      responseReserveTokens: budget.responseReserveTokens,
      transcriptTokenCounter: this.transcriptTokenCounter,
      reserveTokenCounter: this.reserveTokenCounter,
    });
    preflightSpan?.end({
      promptTokenCount: preflight.promptTokenCount,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
    });
    progress.preflightDone(turn, prompt.length, preflight.promptTokenCount);
    if (preflight.tokenizationAttempted) {
      progress.tokenizeDone(turn, prompt.length, preflight);
    }
    let maxOutputTokens = getDynamicMaxOutputTokens({
      config: this.options.config,
      totalContextTokens: budget.totalContextTokens,
      promptTokenCount: preflight.promptTokenCount,
    });

    this.options.logger?.write({
      kind: 'turn_preflight_budget',
      taskId,
      turn,
      promptTokenCount: preflight.promptTokenCount,
      tokenizeElapsedMs: preflight.tokenizeElapsedMs ?? null,
      tokenCountSource: preflight.tokenCountSource,
      transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
      providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
      maxPromptBudget: preflight.maxPromptBudget,
      overflowTokens: preflight.overflowTokens,
      ok: preflight.ok,
      compacted: false,
      maxOutputTokens,
    });

    let compactionSummary: string | null = null;
    let nextMockResponseIndex = mockResponseIndex;

    if (!preflight.ok) {
      const compactionSpan = this.options.timingRecorder?.start('repo.prompt.compact', {
        taskId,
        turn,
        beforePromptTokenCount: preflight.promptTokenCount,
      });
      const compacted = await this.options.compactor.compact({
        taskId,
        turn,
        messages: transcript.getMessages(),
        mockResponseIndex,
      });
      compactionSummary = compacted.summaryText;
      nextMockResponseIndex = compacted.nextMockResponseIndex;
      transcript.replaceWith(compacted.messages);
      const beforeProviderPromptReserveTokenCount = preflight.providerPromptReserveTokenCount;
      providerPromptReserveText = this.buildProviderPromptReserveText(
        transcript.messageRoles(),
        budget.totalContextTokens,
        progress.enabled,
      );
      prompt = transcript.render();
      if (preflightConfig) {
        progress.tokenizeStart(turn, prompt.length);
      }
      const afterCompaction = await preflightPlannerPromptBudget({
        config: preflightConfig,
        prompt,
        providerPromptReserveText,
        totalContextTokens: budget.totalContextTokens,
        responseReserveTokens: budget.responseReserveTokens,
        transcriptTokenCounter: this.transcriptTokenCounter,
        reserveTokenCounter: this.reserveTokenCounter,
      });
      if (afterCompaction.tokenizationAttempted) {
        progress.tokenizeDone(turn, prompt.length, afterCompaction);
      }
      compactionSpan?.end({
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        droppedMessageCount: compacted.droppedMessageCount,
      });
      maxOutputTokens = getDynamicMaxOutputTokens({
        config: this.options.config,
        totalContextTokens: budget.totalContextTokens,
        promptTokenCount: afterCompaction.promptTokenCount,
      });
      this.options.logger?.write({
        kind: 'turn_preflight_compaction_applied',
        taskId,
        turn,
        beforePromptTokenCount: preflight.promptTokenCount,
        afterPromptTokenCount: afterCompaction.promptTokenCount,
        transcriptPromptTokenCount: afterCompaction.transcriptPromptTokenCount,
        beforeProviderPromptReserveTokenCount,
        providerPromptReserveTokenCount: afterCompaction.providerPromptReserveTokenCount,
        maxPromptBudget: afterCompaction.maxPromptBudget,
        droppedMessageCount: compacted.droppedMessageCount,
        summaryTokenCount: compacted.summaryTokenCount,
        summarizerElapsedMs: compacted.summarizerElapsedMs,
        maxOutputTokens,
      });
      preflight = afterCompaction;
    }

    if (!preflight.ok) {
      const overflowError = new Error(
        `planner_preflight_overflow prompt_tokens=${preflight.promptTokenCount} ` +
          `max_prompt_tokens=${preflight.maxPromptBudget} overflow_tokens=${preflight.overflowTokens} ` +
          `max_output_tokens=${maxOutputTokens} total_context_tokens=${budget.totalContextTokens} ` +
          `response_reserve_tokens=${budget.responseReserveTokens} compacted=true`,
      );
      this.options.logger?.write({
        kind: 'turn_preflight_overflow_fail',
        taskId,
        turn,
        promptTokenCount: preflight.promptTokenCount,
        transcriptPromptTokenCount: preflight.transcriptPromptTokenCount,
        providerPromptReserveTokenCount: preflight.providerPromptReserveTokenCount,
        maxPromptBudget: preflight.maxPromptBudget,
        overflowTokens: preflight.overflowTokens,
        maxOutputTokens,
        totalContextTokens: budget.totalContextTokens,
        responseReserveTokens: budget.responseReserveTokens,
        error: overflowError.message,
      });
      throw overflowError;
    }

    return {
      promptTokenCount: preflight.promptTokenCount,
      maxOutputTokens,
      compactionSummary,
      nextMockResponseIndex,
    };
  }
}
```

- [ ] **Step 4: Delete the policy type and option**

In `src/repo-search/engine/task-loop-support.ts`, delete line 151:

```ts
export type ContextOverflowPolicy = 'compact' | 'fail';
```

and delete line 164 from `RunTaskLoopOptions`:

```ts
  contextOverflowPolicy?: ContextOverflowPolicy;
```

In `src/repo-search/engine.ts`:
- line 23: change `import { TaskResultSchema, type ContextOverflowPolicy } from './engine/task-loop-support.js';` to `import { TaskResultSchema } from './engine/task-loop-support.js';`
- line 145: delete `contextOverflowPolicy?: ContextOverflowPolicy;`
- line 225: delete `contextOverflowPolicy: options.contextOverflowPolicy ?? 'compact',`

In `src/repo-search/execute.ts`, delete line 402:

```ts
      contextOverflowPolicy: isAgent ? 'fail' : 'compact',
```

- [ ] **Step 5: Build the compactor in `TaskLoop` and thread the mock cursor**

In `src/repo-search/engine/task-loop.ts`, add to the imports (after the `TranscriptManager` import at line 87):

```ts
import { TranscriptCompactor } from './transcript-compactor.js';
```

Replace the `PromptPreparer` construction at lines 271-284 with:

```ts
    this.promptPreparer = new PromptPreparer({
      taskId: task.id,
      model: String(options.model || ''),
      config: options.config,
      useEstimatedTokensOnly: this.useEstimatedTokensOnly,
      budget: this.budget,
      plannerToolDefinitions: this.plannerToolDefinitions,
      thinking: this.plannerThinking,
      transcript: this.transcript,
      compactor: new TranscriptCompactor({
        config: options.config,
        baseUrl: options.baseUrl,
        model: String(options.model || ''),
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        totalContextTokens: this.budget.totalContextTokens,
        thinking: this.plannerThinking,
        useEstimatedTokensOnly: this.useEstimatedTokensOnly,
        mockResponses: options.mockResponses,
        tokenUsage: this.tokenUsage,
        slotId: this.slotId,
        logger: options.logger || null,
        abortSignal: options.abortSignal,
      }),
      progress: this.progress,
      logger: options.logger || null,
      timingRecorder: options.timingRecorder || null,
    });
```

Add a field next to `private finalOutput = '';` (line 174):

```ts
  private lastCompactionSummary = '';
```

Replace the `prepareTurn` body's preparer call (line 398) so the mock cursor and the summary flow back:

```ts
    const prepared = await this.promptPreparer.prepareTurn(turn, this.mockResponseIndex);
    this.mockResponseIndex = prepared.nextMockResponseIndex;
    if (prepared.compactionSummary !== null) {
      this.lastCompactionSummary = prepared.compactionSummary;
    }
```

- [ ] **Step 6: Run the preparer tests**

```
npm run build:test
npm run test -- engine-prompt-preparer.test.ts
```

Expected: PASS. `npm run typecheck` will still fail until Task 5 removes the old compactor and Task 6 adds `compactionSummary` to the result — that is expected mid-plan.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/prompt-preparer.ts src/repo-search/engine/task-loop.ts src/repo-search/engine/task-loop-support.ts src/repo-search/engine.ts src/repo-search/execute.ts tests/engine-prompt-preparer.test.ts
git commit -m "feat(compaction): compact every loop kind through the LLM compactor"
```

---

### Task 5: Delete the truncation compactor

**Files:**
- Modify: `src/repo-search/prompt-budget.ts:188-320`
- Modify: `src/repo-search/index.ts:28-32`
- Modify: `tests/mock-repo-search-loop.test.ts:20-23, 852-892, 894-935, 982-1044`

- [ ] **Step 1: Rewrite the loop-level compaction tests first**

In `tests/mock-repo-search-loop.test.ts`:

Change the prompt-budget import (lines 20-23) to:

```ts
import { preflightPlannerPromptBudget } from '../src/repo-search/prompt-budget.js';
```

Delete both `compactPlannerMessagesOnce` unit tests (lines 852-892) outright — the behaviour they covered no longer exists.

Replace `runTaskLoop fails with planner_preflight_overflow before provider request when compaction cannot fit` (lines 894-935) with:

```ts
test('runTaskLoop fails before any provider request when the summarization prompt cannot fit', async () => {
  const events: JsonObject[] = [];
  // This loop has no mockResponses, so preflight tokenizes for real: point it at the 404
  // stub so it falls back to the estimate instead of retrying a refused connection.
  const notFound = await startNotFoundServer();
  try {
    await assert.rejects(
      () => runTaskLoop(
        {
          id: 'task-compaction-prompt-overflow',
          question: 'Q'.repeat(20000),
          signals: [],
        },
        {
          ...MOCK_LOOP_DEFAULTS,
          baseUrl: DEAD_BASE_URL,
          model: 'mock-model',
          config: mockLoopConfig({ Runtime: { LlamaCpp: { BaseUrl: notFound.baseUrl } } }),
          maxTurns: 1,
          maxInvalidResponses: 1,
          minToolCallsBeforeFinish: 0,
          totalContextTokens: 7000,
          logger: {
            path: 'memory',
            write(event: Record<string, JsonSerializable>) {
              events.push(parseLoggedEvent(event));
            },
          },
        }
      ),
      /planner_compaction_prompt_overflow/u
    );
  } finally {
    await notFound.close();
  }

  const providerStart = events.find((event) => event.kind === 'provider_request_start');
  assert.equal(Boolean(providerStart), false);
  const overflowEvent = events.find((event) => event.kind === 'turn_compaction_prompt_overflow_fail');
  assert.ok(overflowEvent);
  assert.equal(Number(overflowEvent.promptTokenCount) > Number(overflowEvent.availableTokens), true);
});
```

Replace `runTaskLoop applies one-pass compaction and continues when compacted prompt fits` (lines 982-1044, including the `grepHitLines` helper above it at lines 975-980 if nothing else uses it — check with `rg -n grepHitLines tests/`) with a deterministic history-driven scenario:

```ts
test('runTaskLoop compacts an overflowing history and continues from the summary', async () => {
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    {
      id: 'task-llm-compaction',
      question: 'Find planner references.',
      signals: ['done'],
    },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      // 15k response reserve + 10k compaction reserve leaves a 17000-token prompt
      // budget; the 50k-character history is ~20000 tokens, so turn 1 overflows and
      // the compaction summary is the first mock response consumed.
      totalContextTokens: 32000,
      historyMessages: [{ role: 'assistant', content: 'H'.repeat(50_000) }],
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['git']),
      mockResponses: [
        'SUMMARY: earlier turns collected planner references under src/.',
        '{"action":"finish","output":"done"}',
        '{"verdict":"pass","reason":"supported"}',
      ],
      mockCommandResults: {},
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    }
  );

  const compactionEvents = events.filter((event) => event.kind === 'turn_preflight_compaction_applied');
  assert.equal(compactionEvents.length, 1);
  assert.equal(Number(compactionEvents[0].droppedMessageCount) > 0, true);
  assert.equal(Number(compactionEvents[0].summaryTokenCount) > 0, true);
  assert.equal(
    Number(compactionEvents[0].afterPromptTokenCount) < Number(compactionEvents[0].beforePromptTokenCount),
    true,
  );
  const newMessagesEvents = events.filter((event) => event.kind === 'turn_new_messages');
  const allContent = newMessagesEvents
    .flatMap((event) => asObjectArray(event.messages))
    .map((message) => String(message.content || ''));
  assert.equal(allContent.some((content) => content.includes('[CONTEXT COMPACTED')), true);
  assert.equal(allContent.some((content) => content.includes('SUMMARY: earlier turns collected')), true);
  assert.equal(result.reason, 'finish');
  assert.equal(result.finalOutput, 'done');
  assert.equal(result.compactionSummary, 'SUMMARY: earlier turns collected planner references under src/.');
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- mock-repo-search-loop.test.ts
```

Expected: FAIL — `result.compactionSummary` is `undefined` (added in Task 6) and `[COMPRESSED HISTORICAL EVIDENCE]` still appears.

- [ ] **Step 3: Delete the truncation compactor**

In `src/repo-search/prompt-budget.ts`, delete everything from the `// Message compaction` banner (line 188) to the end of the file (line 320): the `COMPRESSED_HISTORY_MARKER` constant, `summarizeMessageForCompaction`, `buildCompressedHistorySummary`, `buildCompactedMessages`, and `compactPlannerMessagesOnce`.

Then remove the now-unused imports from the top of that file: `ChatMessage` (line 14), `renderTaskTranscript` (line 15) and `extractContentText` from line 17. Line 17 becomes:

```ts
import { countContentImages } from '../llm-protocol/image-attachments.js';
```

Line 15 (`import { renderTaskTranscript } from './planner-protocol.js';`) is still needed by `preflightPlannerPromptBudget`'s `messages` branch — keep it, and keep the `ChatMessage` type import on line 14 for the same reason. Verify with `npm run typecheck:test` at the end of this task; delete only what the compiler reports as unused.

In `src/repo-search/index.ts`, change the export block at lines 28-32 to:

```ts
export {
  countTokensWithFallback,
  preflightPlannerPromptBudget,
} from './prompt-budget.js';
```

- [ ] **Step 4: Confirm no references remain**

```
rg -n "compactPlannerMessagesOnce|COMPRESSED HISTORICAL|ContextOverflowPolicy|contextOverflowPolicy" src tests dashboard packages
```

Expected: no matches outside `docs/`.

- [ ] **Step 5: Commit**

```bash
git add src/repo-search/prompt-budget.ts src/repo-search/index.ts tests/mock-repo-search-loop.test.ts
git commit -m "refactor(compaction): delete the truncation compactor and overflow policy"
```

---

### Task 6: Carry the summary out on `TaskResult`

**Files:**
- Modify: `src/repo-search/engine/task-loop-support.ts:109-145`
- Modify: `src/repo-search/engine/task-loop.ts:751-762`
- Modify: `src/status-server/repo-search-scorecard-types.ts:22-29, 88-109`
- Test: `tests/repo-agent-finish-verification.test.ts:141-146` (pattern to copy), `tests/mock-repo-search-loop.test.ts`

- [ ] **Step 1: Write the failing schema test**

Append to `tests/engine-transcript-compactor.test.ts`:

```ts
import { TaskResultSchema } from '../src/repo-search/engine/task-loop-support.js';
import { buildTaskResultFixture } from './helpers/task-result-fixture.js';

test('TaskResultSchema requires compactionSummary so a missed producer fails loudly', () => {
  const task = buildTaskResultFixture();
  assert.equal(TaskResultSchema.safeParse(task).success, true);

  const { compactionSummary: _compactionSummary, ...withoutCompactionSummary } = task;
  assert.equal(TaskResultSchema.safeParse(withoutCompactionSummary).success, false);
});
```

Look at `tests/repo-agent-finish-verification.test.ts:141-146` for how that file builds its `TaskResult` fixture. If it builds one inline, extract it into `tests/helpers/task-result-fixture.ts` as `buildTaskResultFixture(overrides: Partial<TaskResult> = {}): TaskResult` and have both tests use it; do not duplicate the literal.

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- engine-transcript-compactor.test.ts
```

Expected: FAIL — `compactionSummary` is not part of the schema, so removing it still parses.

- [ ] **Step 3: Add the field to the schema**

In `src/repo-search/engine/task-loop-support.ts`, inside `TaskResultSchema`, add after `finalOutput: z.string(),` (line 123):

```ts
  /** Raw summary text from the run's last compaction; empty when the run never compacted. */
  compactionSummary: z.string(),
```

- [ ] **Step 4: Produce it**

In `src/repo-search/engine/task-loop.ts`, in the returned object of `buildAgentLoopResult` (line 755), add next to `finalOutput`:

```ts
      commands: this.commands, turnThinking: this.turnThinking, finalOutput: this.finalOutput,
      compactionSummary: this.lastCompactionSummary,
```

- [ ] **Step 5: Read it back on the status-server side**

In `src/status-server/repo-search-scorecard-types.ts`, add to `RepoSearchTaskResult` (after `finalOutput: string;`, line 23):

```ts
  compactionSummary: string;
```

and in `normalizeTask` (after `finalOutput: reader.string('finalOutput'),`, line 100):

```ts
    compactionSummary: reader.string('compactionSummary'),
```

- [ ] **Step 6: Run the tests**

```
npm run build:test
npm run test -- engine-transcript-compactor.test.ts
npm run test -- mock-repo-search-loop.test.ts
npm run test -- repo-agent-finish-verification.test.ts
npm run test -- repo-task-output.test.ts
npm run test -- status-server-chat-routes.test.ts
```

Expected: PASS. `tests/status-server-chat-routes.test.ts:136` builds a scorecard through `ScorecardSchema.parse` — add `compactionSummary: ''` to its task literal.

- [ ] **Step 7: Commit**

```bash
git add src/repo-search/engine/task-loop-support.ts src/repo-search/engine/task-loop.ts src/status-server/repo-search-scorecard-types.ts tests/
git commit -m "feat(compaction): carry the compaction summary on the run result"
```

---

### Task 7: Schema migration 50 — drop `condensed_summary`, reset flags

**Files:**
- Modify: `src/state/runtime-db.ts:33, 181`
- Modify: `src/state/migrations/registry.ts:559-576`
- Create: `tests/runtime-db-schema-v50.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `tests/runtime-db-schema-v50.test.ts`:

```ts
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import test from 'node:test';
import { z } from '../src/lib/zod.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { CURRENT_SCHEMA_VERSION, closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const SchemaVersionRowSchema = z.object({ version: z.number() });
const FlagRowsSchema = z.array(z.object({ id: z.string(), compressed_into_summary: z.number() }));
const ColumnRowsSchema = z.array(z.object({ name: z.string() }));

function tempDbPath(prefix: string): string {
  return path.join(createManagedTempDir(prefix), 'runtime.sqlite');
}

// Pre-v50 builds stored a 2400-character condensed tail on the session and flagged the
// messages it replaced.
function seedCondensedSessionDb(dbPath: string): void {
  writeConfig(dbPath, getDefaultConfigObject());
  const database = getRuntimeDatabase(dbPath);
  database.exec("ALTER TABLE chat_sessions ADD COLUMN condensed_summary TEXT NOT NULL DEFAULT '';");
  const timestamp = '2026-01-01T00:00:00.000Z';
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root, condensed_summary,
      created_at_utc, updated_at_utc
    ) VALUES ('session-1', 'Session', 'default', '{}', 0, 1, NULL, 'chat', '.', 'old condensed tail', ?, ?)
  `).run(timestamp, timestamp);
  const insertMessage = database.prepare(`
    INSERT INTO chat_messages (
      session_id, id, role, content,
      input_tokens_estimate, output_tokens_estimate, thinking_tokens,
      input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated,
      created_at_utc, compressed_into_summary, position
    ) VALUES ('session-1', ?, 'assistant', 'message', 0, 0, 0, 1, 1, 1, ?, ?, ?)
  `);
  insertMessage.run('m-1', timestamp, 1, 0);
  insertMessage.run('m-2', timestamp, 1, 1);
  insertMessage.run('m-3', timestamp, 0, 2);
  database.prepare('UPDATE runtime_schema SET version = 49 WHERE id = 1').run();
  closeRuntimeDatabase();
}

function readSessionColumns(dbPath: string): string[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    return ColumnRowsSchema.parse(database.prepare('PRAGMA table_info(chat_sessions)').all())
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

function readFlags(dbPath: string): number[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    return FlagRowsSchema.parse(
      database.prepare('SELECT id, compressed_into_summary FROM chat_messages ORDER BY position').all(),
    ).map((row) => row.compressed_into_summary);
  } finally {
    database.close();
  }
}

function readSchemaVersion(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    return SchemaVersionRowSchema.parse(
      database.prepare('SELECT version FROM runtime_schema WHERE id = 1').get(),
    ).version;
  } finally {
    database.close();
  }
}

test('v50 drops condensed_summary and replays full history until the next compaction', () => {
  const dbPath = tempDbPath('sk-v50-condensed-');
  try {
    seedCondensedSessionDb(dbPath);

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.equal(readSessionColumns(dbPath).includes('condensed_summary'), false);
    assert.deepEqual(readFlags(dbPath), [0, 0, 0]);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});

test('v50 tolerates a chat_sessions table that already lacks condensed_summary', () => {
  const dbPath = tempDbPath('sk-v50-missing-column-');
  try {
    writeConfig(dbPath, getDefaultConfigObject());
    const database = getRuntimeDatabase(dbPath);
    database.prepare('UPDATE runtime_schema SET version = 49 WHERE id = 1').run();
    closeRuntimeDatabase();

    getRuntimeDatabase(dbPath);
    closeRuntimeDatabase();

    assert.equal(readSessionColumns(dbPath).includes('condensed_summary'), false);
    assert.equal(readSchemaVersion(dbPath), CURRENT_SCHEMA_VERSION);
  } finally {
    closeRuntimeDatabase();
  }
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- runtime-db-schema-v50.test.ts
```

Expected: FAIL — the base schema still creates `condensed_summary`, so the first test's `ALTER TABLE ... ADD COLUMN` throws "duplicate column name".

- [ ] **Step 3: Add the migration**

In `src/state/migrations/registry.ts`, append after the version 49 entry (line 575):

```ts
  {
    version: 50,
    up: (database) => {
    // The 2400-character condensed tail is gone: compaction now writes a real
    // summary message. Old sessions have no summary row to replay, so their flags
    // reset and their full history replays until the next compaction writes one.
    if (tableHasColumn(database, 'chat_sessions', 'condensed_summary')) {
      database.exec('ALTER TABLE chat_sessions DROP COLUMN condensed_summary;');
    }
    if (tableHasColumn(database, 'chat_messages', 'compressed_into_summary')) {
      database.exec('UPDATE chat_messages SET compressed_into_summary = 0;');
    }
    },
  },
```

- [ ] **Step 4: Bump the schema version and base schema**

In `src/state/runtime-db.ts`:
- line 33: `export const CURRENT_SCHEMA_VERSION = 50;`
- line 181: delete `      condensed_summary TEXT NOT NULL,` from the `chat_sessions` `CREATE TABLE`.

Leave `src/state/migrations/app-config-migrations.ts:128-141` untouched — those migrations run at versions 33 and 37, where the column still exists.

- [ ] **Step 5: Fix seeds that insert into the current base schema**

Two tests seed rows through the *current* base schema and must stop naming the dropped column.

`tests/runtime-db-schema-v48.test.ts:26-32` — change the insert to:

```ts
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root,
      created_at_utc, updated_at_utc
    ) VALUES ('session-1', 'Session', 'default', '{}', 0, 1, NULL, 'chat', '.', ?, ?)
  `).run(timestamp, timestamp);
```

`tests/model-idle-action-migration.test.ts:65-71` — change to:

```ts
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled,
      web_search_enabled, preset_id, mode, plan_repo_root,
      created_at_utc, updated_at_utc
    ) VALUES ('session-1', 'Session', 'default', ?, 0, 1, NULL, 'chat', '.', ?, ?)
  `).run(JSON.stringify(preset), timestamp, timestamp);
```

`tests/model-idle-action-migration.test.ts:194-200` — change to:

```ts
    database.prepare(`
      INSERT INTO chat_sessions (
        id, title, model_preset_id, model_preset_json, thinking_enabled,
        web_search_enabled, preset_id, mode, plan_repo_root,
        created_at_utc, updated_at_utc
      ) VALUES ('session-1', 'Session', 'default', ?, 0, 1, NULL, 'chat', '.', '2026-01-01', '2026-01-01')
    `).run(JSON.stringify(withoutIdleAction));
```

`tests/runtime-db-schema-v29.test.ts`, `-v33`, `-v37` create their own historical `chat_sessions` tables with `condensed_summary` — leave them alone.

- [ ] **Step 6: Run the migration tests**

```
npm run build:test
npm run test -- runtime-db-schema-v50.test.ts
npm run test -- runtime-db-schema-v48.test.ts
npm run test -- runtime-db-schema-v37.test.ts
npm run test -- runtime-db-schema-v33.test.ts
npm run test -- runtime-db-schema-v29.test.ts
npm run test -- model-idle-action-migration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/state/runtime-db.ts src/state/migrations/registry.ts tests/runtime-db-schema-v50.test.ts tests/runtime-db-schema-v48.test.ts tests/model-idle-action-migration.test.ts
git commit -m "feat(db): schema 50 drops condensed_summary and resets compaction flags"
```

---

### Task 8: `compaction_summary` message kind and chat persistence

**Files:**
- Modify: `src/state/chat-sessions.ts:19, 73-89, 93-106, 216-231, 317-405, 586-741`
- Modify: `packages/contracts/src/chat.ts:7, 42`
- Modify: `src/status-server/chat.ts:277-329, 434-459, 461-645, 648-670`
- Modify: `src/status-server/routes/chat.ts:198, 674`
- Modify: `src/status-server/preset-runner.ts:202`
- Test: `tests/chat-sessions-db.test.ts`, `tests/contracts-chat.test.ts`

- [ ] **Step 1: Write the failing persistence and replay tests**

Append to `tests/chat-sessions-db.test.ts` (follow the file's existing harness for `runtimeRoot`; copy the setup from the test at line 40):

```ts
test('a compacted turn persists a summary row and flags everything before it', () => {
  const runtimeRoot = createManagedTempDir('sk-chat-compaction-');
  const session = makeSession(runtimeRoot, [
    { id: 'u0', role: 'user', kind: 'user_text', content: 'first question' },
    { id: 'a0', role: 'assistant', kind: 'assistant_answer', content: 'first answer' },
  ]);

  const updated = appendChatMessagesWithUsage(
    runtimeRoot,
    session,
    'second question',
    'second answer',
    {},
    { turns: [], compactionSummary: 'SUMMARY OF THE FIRST EXCHANGE' },
  );

  const kinds = (updated.messages ?? []).map((message) => message.kind);
  assert.deepEqual(kinds, ['user_text', 'assistant_answer', 'compaction_summary', 'user_text', 'assistant_answer']);
  const flags = (updated.messages ?? []).map((message) => message.compressedIntoSummary === true);
  assert.deepEqual(flags, [true, true, false, false, false]);
  const summaryRow = (updated.messages ?? [])[2];
  assert.equal(summaryRow.role, 'assistant');
  assert.equal(summaryRow.content, 'SUMMARY OF THE FIRST EXCHANGE');

  const reread = readChatSessionFromPath(getChatSessionPath(runtimeRoot, session.id));
  assert.deepEqual((reread?.messages ?? []).map((message) => message.kind), kinds);
  assert.deepEqual((reread?.messages ?? []).map((message) => message.compressedIntoSummary === true), flags);
});

test('a second compaction supersedes the first summary row', () => {
  const runtimeRoot = createManagedTempDir('sk-chat-compaction-compose-');
  const session = makeSession(runtimeRoot, [
    { id: 'u0', role: 'user', kind: 'user_text', content: 'first question' },
    { id: 's0', role: 'assistant', kind: 'compaction_summary', content: 'FIRST SUMMARY' },
    { id: 'u1', role: 'user', kind: 'user_text', content: 'second question' },
  ]);

  const updated = appendChatMessagesWithUsage(
    runtimeRoot,
    session,
    'third question',
    'third answer',
    {},
    { turns: [], compactionSummary: 'SECOND SUMMARY' },
  );

  const summaryRows = (updated.messages ?? []).filter((message) => message.kind === 'compaction_summary');
  assert.deepEqual(summaryRows.map((message) => message.content), ['FIRST SUMMARY', 'SECOND SUMMARY']);
  assert.equal(summaryRows[0].compressedIntoSummary, true);
  assert.equal(summaryRows[1].compressedIntoSummary, false);
});

test('buildChatHistoryMessages replays the compacted shape without the dropped turns', () => {
  const runtimeRoot = createManagedTempDir('sk-chat-compaction-replay-');
  const session = makeSession(runtimeRoot, [
    { id: 'u0', role: 'user', kind: 'user_text', content: 'first question', compressedIntoSummary: true },
    { id: 'a0', role: 'assistant', kind: 'assistant_answer', content: 'first answer', compressedIntoSummary: true },
    { id: 's0', role: 'assistant', kind: 'compaction_summary', content: 'SUMMARY OF THE FIRST EXCHANGE' },
    { id: 'u1', role: 'user', kind: 'user_text', content: 'second question' },
    { id: 'a1', role: 'assistant', kind: 'assistant_answer', content: 'second answer' },
  ]);

  const history = buildChatHistoryMessages(mockOfflineSiftConfig(), session);

  assert.deepEqual(history.map((message) => message.role), ['assistant', 'user', 'assistant']);
  assert.match(String(history[0].content), /^\[CONTEXT COMPACTED/u);
  assert.match(String(history[0].content), /SUMMARY OF THE FIRST EXCHANGE/u);
  assert.equal(history.some((message) => String(message.content).includes('first answer')), false);
});
```

`makeSession(runtimeRoot, messages)` is a helper you add at the top of the file if it is not already there; it builds a `ChatSession` with `modelPresetId`/`modelPreset` from `mockModelPreset()` and `presetId: 'chat-default'`, calls `saveChatSession`, and returns the session. Fill the required numeric fields (`inputTokensEstimate`, `outputTokensEstimate`, `thinkingTokens`, `createdAtUtc`) with `0`/a fixed timestamp; look at the fixture at `tests/chat-sessions-db.test.ts:54` for the exact shape used elsewhere in the file and reuse it rather than inventing a second one.

Also update `tests/contracts-chat.test.ts:25,33` — delete `condensedSummary: '',` from both session literals, and add a case asserting the new kind parses:

```ts
test('ChatMessageSchema accepts the compaction summary kind', () => {
  const parsed = ChatMessageSchema.safeParse({ ...message, kind: 'compaction_summary' });
  assert.equal(parsed.success, true);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- chat-sessions-db.test.ts
npm run test -- contracts-chat.test.ts
```

Expected: FAIL — `compaction_summary` is not a valid kind and `compactionSummary` is not an `AppendChatOptions` field.

- [ ] **Step 3: Add the kind and drop `condensedSummary` in the state layer**

In `src/state/chat-sessions.ts`:

Line 19 — add the kind:

```ts
export type ChatMessageKind = 'user_text' | 'assistant_answer' | 'assistant_thinking' | 'assistant_tool_call' | 'tool_image' | 'compaction_summary';
```

Line 220-231 — accept it in `normalizeMessageKind`:

```ts
function normalizeMessageKind(value: string | null | undefined, roleValue: string | null | undefined): ChatMessageKind {
  if (
    value === 'user_text'
    || value === 'assistant_answer'
    || value === 'assistant_thinking'
    || value === 'assistant_tool_call'
    || value === 'tool_image'
    || value === 'compaction_summary'
  ) {
    return value;
  }
  return roleValue === 'user' ? 'user_text' : 'assistant_answer';
}
```

Delete `condensedSummary?: string;` from `ChatSession` (line 84), `condensed_summary: z.string(),` from `SessionRowSchema` (line 103), the `condensed_summary,` column from the `readSessionById` SELECT (line 330), `condensedSummary: session.condensed_summary,` from its return (line 400), and from `saveChatSession`: the `condensed_summary,` insert column (line 611), the `condensed_summary = excluded.condensed_summary,` upsert clause (line 624), and the corresponding bind argument (line 638). The insert's `VALUES (?, ?, ...)` list loses one `?`.

In `packages/contracts/src/chat.ts`:
- line 7 — add `'compaction_summary'` to the `kind` enum.
- line 42 — delete `condensedSummary: z.string(),` from `ChatSessionSchema`.

In `src/status-server/routes/chat.ts`, delete `condensedSummary: session.condensedSummary ?? '',` (line 198) and `condensedSummary: '',` (line 674).

In `src/status-server/preset-runner.ts`, delete `condensedSummary: '',` (line 202).

- [ ] **Step 4: Persist the summary row**

In `src/status-server/chat.ts`, add to `AppendChatOptions` (after `sourceRunId?: string | null;`, line 455):

```ts
  /** Raw summary text when this turn compacted; marks every earlier row as compacted. */
  compactionSummary?: string | null;
```

In `appendChatMessagesWithUsage`, replace the `const messages = ...` line (line 470) and the first `messages.push` (the user row, line 498) with a compaction-aware prologue:

```ts
  const compactionSummary = typeof options.compactionSummary === 'string' ? options.compactionSummary.trim() : '';
  // The compaction happened mid-turn against the replayed history, so the boundary is
  // exactly "everything that existed before this turn". Marking here — in the same
  // saveChatSession write as the turn's own rows — is what makes the flags and the
  // summary row impossible to separate.
  const messages = (Array.isArray(session.messages) ? session.messages.slice() : [])
    .map((message) => (compactionSummary ? { ...message, compressedIntoSummary: true } : message));
  if (compactionSummary) {
    messages.push({
      id: randomUUID(),
      role: 'assistant',
      kind: 'compaction_summary',
      content: compactionSummary,
      inputTokensEstimate: 0,
      outputTokensEstimate: estimateTokenCount(compactionSummary),
      thinkingTokens: 0,
      inputTokensEstimated: false,
      outputTokensEstimated: true,
      thinkingTokensEstimated: false,
      createdAtUtc: now,
      sourceRunId: null,
      compressedIntoSummary: false,
    });
  }
```

(The `const now = ...` line at 469 must stay above this block.)

- [ ] **Step 5: Replay the compacted shape**

In `src/status-server/chat.ts`, import the marker at the top:

```ts
import { COMPACTION_SUMMARY_MARKER } from '../repo-search/engine/transcript-compactor.js';
```

In `buildChatHistoryMessages`, inside the `for (const message of messages)` loop, insert immediately after the `kind` is resolved (line 290, before the `assistant_thinking` branch):

```ts
    if (message.compressedIntoSummary === true) {
      // Already inside a summary. Replaying it would re-send the very tokens compaction
      // reclaimed, and the next turn would compact again on the same input.
      continue;
    }
    if (kind === 'compaction_summary') {
      const summaryText = trimText(message.content);
      if (summaryText) {
        history.push({ role: 'assistant', content: `${COMPACTION_SUMMARY_MARKER}\n${summaryText}` });
      }
      pendingThinking = '';
      continue;
    }
```

- [ ] **Step 6: Run the tests**

```
npm run build:test
npm run test -- chat-sessions-db.test.ts
npm run test -- contracts-chat.test.ts
```

Expected: PASS.

- [ ] **Step 7: Sweep the remaining `condensedSummary` fixtures**

```
rg -n "condensedSummary" src tests dashboard packages
```

Delete the `condensedSummary: '',` line from every match. The known list:
`tests/chat-sessions-db.test.ts` (12 sites), `tests/chat-repo-operation-runner.test.ts:129`, `tests/dashboard-status-server.test.ts:403,413`, `tests/dashboard-presets.test.ts:113`, `tests/helpers/chat-sessions.ts:15`, `tests/status-server-route-error.test.ts:32`, `dashboard/tests/api-stream.test.ts:12`, `dashboard/tests/chat-stream-parser.test.ts:85`, `dashboard/tests/chat-composer-inputs.test.ts:16`, `dashboard/tests/chat-tab.test.tsx:44`, `dashboard/tests/chat-session-runtime-store.test.ts:16`, `dashboard/tests/chat-session-state.test.ts:20`, `dashboard/tests/chat-stream-transitions.test.ts:14`, `dashboard/tests/format.test.ts:15,90,165`, `dashboard/tests/hooks/useChatSessions.test.tsx:31`, `dashboard/tests/lib/format.test.ts:27`.

`tests/dashboard-status-server.test.ts:765-772` (the condense assertion) is rewritten in Task 10 — leave it failing for now.

- [ ] **Step 8: Commit**

```bash
git add src/state/chat-sessions.ts packages/contracts/src/chat.ts src/status-server/chat.ts src/status-server/routes/chat.ts src/status-server/preset-runner.ts tests dashboard/tests
git commit -m "feat(chat): persist and replay compaction summary messages"
```

---

### Task 9: Pass the summary through both chat turn paths

**Files:**
- Modify: `src/status-server/routes/chat.ts:685-690, 746-799, 825-859, 1057-1090`
- Test: `tests/status-server-chat-routes.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/status-server-chat-routes.test.ts`, add a case that drives the non-streaming message endpoint with a scorecard carrying a compaction summary and asserts the persisted row. Follow the existing harness in that file (it already builds a scorecard at line 136); add `compactionSummary: 'SUMMARY OF PRIOR CONVERSATION'` to the task literal there in a new test, then:

```ts
test('a chat turn whose run compacted persists the summary row and flags earlier messages', async () => {
  // ... reuse the file's harness to POST /dashboard/chat/sessions/:id/messages twice,
  // the second time with a scorecard whose task carries compactionSummary.
  const messages = asObjectArray(secondResponse.body.session.messages);
  const summaryRow = messages.find((message) => message.kind === 'compaction_summary');
  assert.ok(summaryRow);
  assert.equal(String(summaryRow.content), 'SUMMARY OF PRIOR CONVERSATION');
  const summaryIndex = messages.indexOf(summaryRow);
  assert.equal(messages.slice(0, summaryIndex).every((message) => message.compressedIntoSummary === true), true);
  assert.equal(messages.slice(summaryIndex).every((message) => message.compressedIntoSummary !== true), true);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- status-server-chat-routes.test.ts
```

Expected: FAIL — no `compaction_summary` row is persisted.

- [ ] **Step 3: Read the summary off the scorecard in both paths**

In `src/status-server/routes/chat.ts`, add to `ChatTurnContent` (line 685):

```ts
type ChatTurnContent = {
  assistantContent: string;
  usage: Partial<ChatUsage>;
  persistTurns: PersistTurn[];
  sourceRunId: string | null;
  compactionSummary: string;
};
```

In `ChatMessageTurn.runEngineTurn` (line 773), add to the `persistAndRespond` argument object:

```ts
        compactionSummary: scorecardTasks[0]?.compactionSummary ?? '',
```

In `ChatMessageTurn.runProvidedAssistantTurn` (line 811), add to its literal:

```ts
          compactionSummary: '',
```

In `ChatMessageTurn.persistAndRespond` (line 837), add to the `appendChatMessagesWithUsage` options object:

```ts
        compactionSummary: turn.compactionSummary,
```

In `StreamChatMessageEndpoint.run`, after `const assistantContent = ...` (line 1058), add:

```ts
      const compactionSummary = scorecardTasks[0]?.compactionSummary ?? '';
```

and add to the `appendChatMessagesWithUsage` options object at line 1080:

```ts
        compactionSummary,
```

- [ ] **Step 4: Run the tests**

```
npm run build:test
npm run test -- status-server-chat-routes.test.ts
npm run test -- dashboard-chat-concurrency.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/chat.ts tests/status-server-chat-routes.test.ts
git commit -m "feat(chat): persist run compaction summaries from both turn endpoints"
```

---

### Task 10: Rebuild manual condense on the new summarizer

**Files:**
- Modify: `src/status-server/chat.ts:648-670`
- Modify: `src/status-server/routes/chat.ts:1400-1416`
- Test: `tests/dashboard-status-server.test.ts:765-772`

- [ ] **Step 1: Write the failing test**

Replace `tests/dashboard-status-server.test.ts:765-772` with:

```ts
    const condenseResponse = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/condense`, {
      method: 'POST',
      body: JSON.stringify({ mockResponses: ['CONDENSED: the session discussed a stored assistant response.'] }),
    });
    assert.equal(condenseResponse.statusCode, 200);
    const condensedSession = d(condenseResponse.body.session);
    const condensedMessages = asObjectArray(condensedSession.messages);
    const summaryRow = condensedMessages.find((message) => message.kind === 'compaction_summary');
    assert.ok(summaryRow);
    assert.match(String(summaryRow.content), /stored assistant response/u);
    assert.equal(summaryRow.compressedIntoSummary !== true, true);
    const summaryIndex = condensedMessages.indexOf(summaryRow);
    assert.equal(summaryIndex, condensedMessages.length - 1);
    assert.equal(
      condensedMessages.slice(0, summaryIndex).every((message) => message.compressedIntoSummary === true),
      true,
    );
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- dashboard-status-server.test.ts
```

Expected: FAIL — the endpoint still writes `condensedSummary` and no summary row exists.

- [ ] **Step 3: Rewrite `condenseChatSession`**

In `src/status-server/chat.ts`, add the imports needed for a standalone summarizer call:

```ts
import { randomUUID } from 'node:crypto';
import { getConfiguredLlamaBaseUrl } from '../config/getters.js';
import { TokenUsageTracker } from '../repo-search/engine/token-usage.js';
import {
  COMPACTION_SUMMARY_MARKER,
  TranscriptCompactor,
} from '../repo-search/engine/transcript-compactor.js';
import { resolvePlannerThinkingFlags } from '../repo-search/engine/task-loop-support.js';
```

(`randomUUID` is already imported at line 1; `COMPACTION_SUMMARY_MARKER` was added in Task 8. Check `src/config/getters.js` actually exports `getConfiguredLlamaBaseUrl` — `src/repo-search/engine.ts:5` imports it from `../config/index.js`; use whichever path the rest of `chat.ts` already uses for config getters.)

Replace the whole of `condenseChatSession` (lines 648-670) with:

```ts
const CONDENSE_TIMEOUT_MS = 120_000;

/**
 * Manual condense: the same summarizer the engine runs at budget, invoked directly
 * against the session's replayed history. One summarization call, no planner run.
 */
export async function condenseChatSession(
  runtimeRoot: string,
  config: SiftConfig,
  session: ChatSession,
  mockResponses: string[] | undefined,
): Promise<ChatSession> {
  const effectiveConfig = resolveChatSessionConfig(config, session);
  const history = buildChatHistoryMessages(effectiveConfig, session);
  const compactor = new TranscriptCompactor({
    config: effectiveConfig,
    baseUrl: getConfiguredLlamaBaseUrl(effectiveConfig),
    model: resolveChatSessionModel(config, session),
    timeoutMs: CONDENSE_TIMEOUT_MS,
    totalContextTokens: resolveChatSessionContextWindow(config, session),
    thinking: resolvePlannerThinkingFlags(effectiveConfig, session.thinkingEnabled !== false),
    useEstimatedTokensOnly: Array.isArray(mockResponses),
    mockResponses,
    tokenUsage: new TokenUsageTracker(effectiveConfig, Array.isArray(mockResponses)),
    logger: null,
    abortSignal: undefined,
  });
  const outcome = await compactor.compact({
    taskId: session.id,
    turn: 0,
    // No system message: chat's system prompt is composed per request, and the
    // compactor summarizes everything it is given below the system slot anyway.
    messages: history,
    mockResponseIndex: 0,
  });

  const now = new Date().toISOString();
  const messages = (Array.isArray(session.messages) ? session.messages : [])
    .map((message: PersistedChatMessage) => ({ ...message, compressedIntoSummary: true }));
  messages.push({
    id: randomUUID(),
    role: 'assistant',
    kind: 'compaction_summary',
    content: outcome.summaryText,
    inputTokensEstimate: 0,
    outputTokensEstimate: estimateTokenCount(outcome.summaryText),
    thinkingTokens: 0,
    inputTokensEstimated: false,
    outputTokensEstimated: true,
    thinkingTokensEstimated: false,
    createdAtUtc: now,
    sourceRunId: null,
    compressedIntoSummary: false,
  });
  const updated: ChatSession = { ...session, updatedAtUtc: now, messages };
  saveChatSession(runtimeRoot, updated);
  return updated;
}
```

If `COMPACTION_SUMMARY_MARKER` ends up unused in this file after Task 8's replay change already imported it, keep the single import — do not import it twice.

- [ ] **Step 4: Rewrite the endpoint**

In `src/status-server/routes/chat.ts`, replace `CondenseChatSessionEndpoint` (lines 1400-1416) with:

```ts
class CondenseChatSessionEndpoint extends ChatSessionOperationEndpoint<'condense'> {
  protected readonly operationKind = 'condense' as const;

  protected parseRequest(): 'condense' {
    return 'condense';
  }

  protected async run(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    request: ChatSessionOperationRequest<'condense'>,
  ): Promise<void> {
    // Condense now issues a real model request, so it takes the same lock and
    // readiness gate as any other turn.
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'dashboard_chat_condense', req, res);
    if (!modelRequestLock) {
      return;
    }
    try {
      await ensureActivePresetReadyForModelRequest(ctx);
    } catch (error) {
      releaseModelRequest(ctx, modelRequestLock.token);
      sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const config = readConfig(ctx.configPath);
      const updatedSession = await condenseChatSession(
        getRuntimeRoot(),
        config,
        request.session,
        readRouteStringArray(new JsonRecordReader(request.parsedBody), 'mockResponses'),
      );
      sendJson(res, 200, buildChatSessionResponse(config, updatedSession));
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
  }
}
```

- [ ] **Step 5: Run the tests**

```
npm run build:test
npm run test -- dashboard-status-server.test.ts
npm run test -- dashboard-chat-concurrency.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/status-server/chat.ts src/status-server/routes/chat.ts tests/dashboard-status-server.test.ts
git commit -m "feat(chat): rebuild manual condense on the LLM summarizer"
```

---

### Task 11: Dashboard compaction boundary UI

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx:225-226, 354-359, 361-402`
- Modify: `dashboard/src/styles/chat.css`
- Test: `dashboard/tests/chat-tab.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/tests/chat-tab.test.tsx`:

```ts
const COMPACTED_SESSION = {
  ...SESSION_A,
  id: 'session-compacted',
  messages: [
    msg({ id: 'c1', role: 'user', kind: 'user_text', content: 'old question', compressedIntoSummary: true }),
    msg({ id: 'c2', kind: 'assistant_answer', content: 'old answer', compressedIntoSummary: true }),
    msg({ id: 'c3', kind: 'compaction_summary', content: 'SUMMARY OF THE OLD EXCHANGE' }),
    msg({ id: 'c4', role: 'user', kind: 'user_text', content: 'new question' }),
    msg({ id: 'c5', kind: 'assistant_answer', content: 'new answer' }),
  ],
} satisfies ChatSession;

test('a compacted session renders the divider, the collapsed originals and the summary card', () => {
  const markup = render({
    sessions: [COMPACTED_SESSION],
    selectedSessionId: COMPACTED_SESSION.id,
    selectedSession: COMPACTED_SESSION,
  });

  assert.match(markup, /Context compacted \(2 messages summarized\)/u);
  assert.match(markup, /compaction-originals/u);
  assert.match(markup, /Compacted summary/u);
  assert.match(markup, /SUMMARY OF THE OLD EXCHANGE/u);
  assert.match(markup, /old answer/u);
  assert.match(markup, /new answer/u);
});

test('a session with no compaction renders no divider', () => {
  const markup = render();

  assert.doesNotMatch(markup, /Context compacted/u);
  assert.doesNotMatch(markup, /Compacted summary/u);
});

test('the condensed summary panel is gone', () => {
  const markup = render();

  assert.doesNotMatch(markup, /Condensed Summary/u);
});
```

- [ ] **Step 2: Run to verify failure**

```
npm run build:test
npm run test -- --dashboard
```

Expected: FAIL — no divider is rendered.

- [ ] **Step 3: Split the message list at the compaction boundary**

In `dashboard/src/tabs/ChatTab.tsx`, replace lines 225-226 with:

```tsx
  const persistedMessages = selectedSession ? selectedSession.messages : [];
  // The newest summary row is the boundary: persistence always writes it after the
  // rows it replaced, so everything before it is compacted history.
  const compactionSummaryIndex = persistedMessages.reduce(
    (found, message, index) => (message.kind === 'compaction_summary' ? index : found),
    -1,
  );
  const compactionSummaryMessage = compactionSummaryIndex < 0 ? null : persistedMessages[compactionSummaryIndex];
  const compactedMessages = compactionSummaryIndex < 0 ? [] : persistedMessages.slice(0, compactionSummaryIndex);
  const conversationMessages = compactionSummaryIndex < 0
    ? persistedMessages
    : persistedMessages.slice(compactionSummaryIndex + 1);
  const visibleMessages = [...conversationMessages, ...liveMessages];
```

Delete the `condensedSummary` block at lines 354-359 entirely.

Insert the compaction panel as the first child of `<div className="msgs" ref={chatLogRef}>` (before the `promptContext` block at line 362):

```tsx
              {compactionSummaryMessage ? (
                <CompactedHistoryPanel
                  compactedMessages={compactedMessages}
                  summary={compactionSummaryMessage}
                  sessionId={selectedSessionId}
                  isDirectChatMode={isDirectChatMode}
                  chatBusy={selectedSessionBusy}
                  onDeleteMessage={onDeleteMessage}
                  onDeleteMessageImage={onDeleteMessageImage}
                />
              ) : null}
```

Add the component near `SettingsPopover` (before it, around line 520):

```tsx
function CompactedHistoryPanel(props: {
  compactedMessages: ChatMessage[];
  summary: ChatMessage;
  sessionId: string | null;
  isDirectChatMode: boolean;
  chatBusy: boolean;
  onDeleteMessage(messageId: string): Promise<void>;
  onDeleteMessageImage(messageId: string, imageIndex: number): Promise<void>;
}) {
  const { compactedMessages, summary, sessionId, isDirectChatMode, chatBusy, onDeleteMessage, onDeleteMessageImage } = props;
  const messageCount = compactedMessages.length;
  return (
    <section className="compaction">
      <details className="compaction-history">
        <summary className="compaction-divider">
          — Context compacted ({messageCount} {messageCount === 1 ? 'message' : 'messages'} summarized) —
        </summary>
        <div className="compaction-originals">
          {compactedMessages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              sessionId={sessionId}
              isLive={false}
              isPending={false}
              isDirectChatMode={isDirectChatMode}
              chatBusy={chatBusy}
              onDeleteMessage={onDeleteMessage}
              onDeleteMessageImage={onDeleteMessageImage}
            />
          ))}
        </div>
      </details>
      <article className="msg ai compaction-summary">
        <div className="who">assistant · Compacted summary</div>
        <div className="compaction-summary-body">{summary.content}</div>
      </article>
    </section>
  );
}
```

Match the exact prop names and types of `MessageBubble` as used at `ChatTab.tsx:376-386`; if `sessionId` there is `string` rather than `string | null`, mirror that type instead of widening it.

- [ ] **Step 4: Add the styles**

Append to `dashboard/src/styles/chat.css`:

```css
/* ---- compaction boundary ---- */
.compaction { display: grid; gap: 8px; margin-bottom: 10px; }
.compaction-divider { cursor: pointer; text-align: center; color: var(--dim); font-size: 0.72rem; letter-spacing: 0.04em; border-top: 1px solid var(--line); padding-top: 8px; }
/* Dimmed while expanded: these turns are readable history, not model context. */
.compaction-originals { display: grid; gap: 8px; margin-top: 8px; opacity: 0.55; }
.compaction-summary { border: 1px dashed var(--line); border-radius: 8px; background: var(--panel2); padding: 8px 10px; }
.compaction-summary-body { white-space: pre-wrap; font-size: 0.8rem; }
```

- [ ] **Step 5: Run the dashboard tests**

```
npm run build:test
npm run test -- --dashboard
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/tabs/ChatTab.tsx dashboard/src/styles/chat.css dashboard/tests/chat-tab.test.tsx
git commit -m "feat(dashboard): render the chat compaction boundary"
```

---

### Task 12: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm nothing references the deleted surfaces**

```
rg -n "condensedSummary|condensed_summary|compactPlannerMessagesOnce|COMPRESSED HISTORICAL|ContextOverflowPolicy|contextOverflowPolicy" src tests dashboard packages
```

Expected: the only matches are the historical `condensed_summary` inside `src/state/migrations/app-config-migrations.ts` and the `tests/runtime-db-schema-v29/v33/v37` seeds, which recreate pre-v50 schemas on purpose.

- [ ] **Step 2: Typecheck and lint**

```
npm run typecheck 2>&1 | siftkit summary --question "Return pass/fail, every error with its file:line, and the error category."
```

Expected: pass. (`npm run typecheck` runs `npm run lint` as its last step.)

- [ ] **Step 3: Full test suite**

```
npm run build:test
npm run test 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
npm run test -- --dashboard 2>&1 | siftkit summary --question "Return pass/fail, failing test names, root errors, and relevant file:line anchors."
```

Expected: pass.

- [ ] **Step 4: Commit any residual fixes**

```bash
git add -A
git commit -m "test: settle the suite after LLM compaction"
```

---

## Self-review notes

**Spec coverage**

| Spec section | Task |
| --- | --- |
| §1 trigger point unchanged, policy deleted | 4 |
| §1.1 summarize with fixed sections | 2, 3 |
| §1.2 rebuild `system → summary → latest user` | 3, 4 |
| §1.3 generation bump, image guards, recount, reserve rebuild, new log fields | 4 |
| §1.4 single-shot fit guarantee + compaction reserve | 1, 3 |
| §1.5 at most once per turn, retry then typed failure | 3, 4 |
| §1 deletions | 5 |
| §2.1 compaction reaches chat | 6, 9 (see deviation note) |
| §2.2 persistence shape + migration | 7, 8 |
| §2.3 history replay | 8 |
| §2.4 composition | 8 |
| §2.5 manual condense | 10 |
| §3 dashboard UI | 11 |
| §4 error handling | 3, 4, 10 |
| §5 testing + completion gate | every task, 12 |

**Known risk:** the loop-level compaction test in Task 5 is tuned to `totalContextTokens: 32000` with a 50 000-character history and the default 2.5 characters-per-token estimate (`SIFT_INPUT_CHARACTERS_PER_CONTEXT_TOKEN`, `src/config/constants.ts:61`). If a config in the test path overrides `Effective.InputCharactersPerContextToken`, the history may no longer overflow. If the test does not compact, raise the history length rather than lowering the context window — the summarization prompt must stay under `32000 - 4000` tokens.
