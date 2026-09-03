import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { PromptPreparer, type PreparedTurnBudget } from '../src/repo-search/engine/prompt-preparer.js';
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
import { RepoSearchRuntimeProfile } from '../src/repo-search/engine/runtime-profile.js';
import type { RepoSearchTaskKind } from '../src/repo-search/task-kind.js';
import type { MockPlannerResponseInput } from '../src/planner-protocol/mock-response.js';
import { toProtocolTools } from '../src/providers/llama-cpp.js';

const NO_THINKING = { thinkingEnabled: false, reasoningContentEnabled: false, preserveThinking: false };
const WITH_PRESERVED_THINKING = { thinkingEnabled: true, reasoningContentEnabled: true, preserveThinking: true };

function makePreparer(
  budget: TurnBudget,
  transcript: TranscriptManager,
  mockResponses: MockPlannerResponseInput[] = [{ content: 'SUMMARY BODY' }],
  events: Array<Record<string, JsonSerializable>> = [],
  thinking: typeof NO_THINKING = NO_THINKING,
  taskKind: RepoSearchTaskKind = 'repo-search',
): PromptPreparer {
  const config = mockOfflineSiftConfig();
  const plannerTools = toProtocolTools(resolveRepoSearchPlannerToolDefinitions());
  const logger = {
    path: 'memory',
    write(event: Record<string, JsonSerializable>): void {
      events.push(event);
    },
  };
  return new PromptPreparer({
    taskId: 't1',
    config,
    useEstimatedTokensOnly: true,
    budget,
    plannerTools,
    thinking,
    transcript,
    runtimeProfile: new RepoSearchRuntimeProfile(taskKind),
    compactor: new TranscriptCompactor({
      config,
      baseUrl: DEAD_BASE_URL,
      model: 'mock-model',
      timeoutMs: 5_000,
      totalContextTokens: budget.totalContextTokens,
      compactionReserveTokens: budget.compactionReserveTokens,
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

function prepareTurn(
  preparer: PromptPreparer,
  turn: number,
  mockResponseIndex: number,
  thinking: typeof NO_THINKING = NO_THINKING,
) {
  return preparer.prepareTurn(turn, mockResponseIndex, {
    kind: 'new_epoch',
    flags: thinking,
    tools: toProtocolTools(resolveRepoSearchPlannerToolDefinitions()),
    slotId: 2,
  });
}

/** Narrows the prepared-turn union without a type assertion; throws on the unexpected variant. */
function withKind(prepared: PreparedTurnBudget, kind: 'ready'): Extract<PreparedTurnBudget, { kind: 'ready' }>;
function withKind(prepared: PreparedTurnBudget, kind: 'context_overflow'): Extract<PreparedTurnBudget, { kind: 'context_overflow' }>;
function withKind(prepared: PreparedTurnBudget, kind: PreparedTurnBudget['kind']): PreparedTurnBudget {
  if (prepared.kind !== kind) {
    throw new Error(`expected prepared turn kind '${kind}', got '${prepared.kind}'`);
  }
  return prepared;
}

// Sized to overflow a 9000-token window: over the 4500-token prompt limit, while the
// physical remainder still leaves the summarizer room to answer in one shot.
function makeCompactableTranscript(): TranscriptManager {
  return new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'assistant', content: 'H'.repeat(14_000) }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
}

test('prepareTurn returns a token count and output budget for a small prompt', async () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'short question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }),
    transcript,
    [{ content: 'SUMMARY BODY' }],
    events,
  );

  const prepared = withKind(await prepareTurn(preparer, 1, 0), 'ready');

  assert.ok(prepared.promptTokenCount > 0);
  assert.ok(prepared.maxOutputTokens > 0);
  assert.equal(prepared.compactionSummary, null);
  assert.equal(prepared.nextMockResponseIndex, 0);
  assert.equal(events.filter((event) => event.kind === 'prompt_cache_epoch_reset').length, 0);
});

test('prepareTurn compacts an overflowing transcript to system, summary, latest user', async () => {
  const transcript = makeCompactableTranscript();
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    [{ content: 'SUMMARY BODY' }],
    events,
    NO_THINKING,
    'repo-agent',
  );

  const prepared = withKind(await prepareTurn(preparer, 1, 0), 'ready');

  assert.deepEqual(transcript.getMessages().map((message) => message.role), ['system', 'assistant', 'user']);
  assert.equal(transcript.render(false).includes(COMPACTION_SUMMARY_MARKER), true);
  assert.match(transcript.render(false), /SUMMARY BODY/u);
  assert.equal(prepared.compactionSummary, 'SUMMARY BODY');
  assert.equal(prepared.nextMockResponseIndex, 1);
  assert.equal(transcript.generation, 1);

  assert.deepEqual(
    events.filter((event) => event.kind === 'prompt_cache_epoch_reset'),
    [{
      kind: 'prompt_cache_epoch_reset',
      taskId: 't1',
      turn: 1,
      reason: 'context_compaction',
      droppedMessageCount: 1,
    }],
  );

  const applied = events.find((event) => event.kind === 'turn_preflight_compaction_applied');
  assert.ok(applied);
  assert.equal(Number(applied.droppedMessageCount) > 0, true);
  assert.equal(Number(applied.summaryTokenCount) > 0, true);
  assert.equal(applied.summaryOutputTokenBudget, 1_500);
  assert.ok(Number(applied.summaryReasoningTokenBudget) > 0);
  assert.equal(
    applied.summaryGenerationTokenBudget,
    Number(applied.summaryReasoningTokenBudget) + Number(applied.summaryOutputTokenBudget),
  );
  assert.equal(Number(applied.summarizerElapsedMs) >= 0, true);
});

test('prepareTurn returns a context_overflow outcome for an overflowing repo-search transcript', async () => {
  const transcript = makeCompactableTranscript();
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    [{ content: 'SUMMARY BODY' }],
    events,
  );

  const prepared = withKind(await prepareTurn(preparer, 1, 0), 'context_overflow');

  assert.ok(prepared.overflowTokens > 0);
  // An overflowed prompt has no generation limit: nothing can be generated from it.
  assert.equal('maxOutputTokens' in prepared, false);
  // The transcript is left exactly as the loop handed it over: no compaction, no epoch reset.
  assert.equal(transcript.generation, 0);
  assert.deepEqual(transcript.getMessages().map((message) => message.role), ['system', 'assistant', 'user']);
  assert.equal(events.filter((event) => event.kind === 'prompt_cache_epoch_reset').length, 0);
  assert.equal(events.filter((event) => event.kind === 'turn_preflight_compaction_applied').length, 0);

  const forced = events.find((event) => event.kind === 'turn_preflight_forced_answer');
  assert.ok(forced);
  assert.equal(forced.taskId, 't1');
  assert.equal(forced.turn, 1);
  assert.ok(Number(forced.promptTokenCount) > Number(forced.maxPromptBudget));
  assert.ok(Number(forced.maxPromptBudget) > 0);
  assert.ok(Number(forced.overflowTokens) > 0);
  assert.equal(forced.maxOutputTokens, undefined);
  assert.equal(Number(forced.totalContextTokens), 9_000);
  assert.ok(Number(forced.compactionReserveTokens) > 0);
});

test('prepareTurn returns context_overflow without calling the compactor when no mock responses remain', async () => {
  const transcript = makeCompactableTranscript();
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    [],
    events,
  );

  // An empty mockResponses array would reject with planner_compaction_failed if the
  // compactor were ever invoked, so context_overflow proves it was not.
  const prepared = withKind(await prepareTurn(preparer, 1, 0), 'context_overflow');

  assert.ok(prepared.overflowTokens > 0);
  assert.equal(transcript.generation, 0);
  assert.equal(events.filter((event) => event.kind === 'turn_preflight_compaction_applied').length, 0);
  assert.equal(events.some((event) => event.kind === 'turn_preflight_forced_answer'), true);
});

test('prepareTurn compacts at most once per turn and then reports overflow', async () => {
  const transcript = new TranscriptManager({
    // The system prompt is never dropped, so the compacted prompt still overflows —
    // while the summary request (system + completed history + instruction) still fits.
    systemPromptContent: 'S'.repeat(18_000),
    historyMessages: [{ role: 'assistant', content: 'H'.repeat(7_000) }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    [{ content: 'SUMMARY BODY' }, { content: 'SECOND SUMMARY' }],
    events,
    NO_THINKING,
    'repo-agent',
  );

  await assert.rejects(prepareTurn(preparer, 1, 0), /planner_preflight_overflow/u);

  assert.equal(events.filter((event) => event.kind === 'turn_preflight_compaction_applied').length, 1);
});

test('prepareTurn releases image guards for attachments dropped by compaction', async () => {
  const liveImagePathKeys = new Set<string>(['repo/shot.png']);
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [
      { role: 'assistant', content: 'H'.repeat(14_000) },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
        imagePathKey: 'repo/shot.png',
      },
    ],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys,
  });
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    [{ content: 'SUMMARY BODY' }],
    [],
    NO_THINKING,
    'repo-agent',
  );

  await prepareTurn(preparer, 1, 0);

  assert.equal(liveImagePathKeys.has('repo/shot.png'), false);
});

test('prepareTurn surfaces a summarizer failure as planner_compaction_failed', async () => {
  const transcript = makeCompactableTranscript();
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }),
    transcript,
    [],
    [],
    NO_THINKING,
    'repo-agent',
  );

  await assert.rejects(prepareTurn(preparer, 1, 0), /planner_compaction_failed/u);
});

test('preflight counts preserved reasoning_content toward the prompt', async () => {
  const reasoning = 'R'.repeat(8_000);
  const makeTranscript = () => new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'assistant', content: 'step done', reasoning_content: reasoning }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });

  const withReasoning = makePreparer(new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }), makeTranscript(), [{ content: 'SUMMARY BODY' }], [], WITH_PRESERVED_THINKING);
  const withoutReasoning = makePreparer(new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }), makeTranscript(), [{ content: 'SUMMARY BODY' }], [], NO_THINKING);

  const counted = withKind(await prepareTurn(withReasoning, 1, 0, WITH_PRESERVED_THINKING), 'ready');
  const uncounted = withKind(await prepareTurn(withoutReasoning, 1, 0), 'ready');

  assert.equal(counted.compactionSummary, null);
  assert.equal(uncounted.compactionSummary, null);
  // ~8k chars of reasoning ≈ 2k estimated tokens; require a decisive gap.
  assert.ok(counted.promptTokenCount > uncounted.promptTokenCount + 1_000);
});

test('preserved reasoning mass triggers compaction that plain content would not', async () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'assistant', content: 'short', reasoning_content: 'R'.repeat(14_000) }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }), transcript, [{ content: 'SUMMARY BODY' }], events, WITH_PRESERVED_THINKING, 'repo-agent');

  const prepared = withKind(await prepareTurn(preparer, 1, 0, WITH_PRESERVED_THINKING), 'ready');

  assert.equal(prepared.compactionSummary, 'SUMMARY BODY');
  assert.ok(events.some((event) => event.kind === 'turn_preflight_compaction_applied'));
});

test('prepareTurn reports the full wire prompt size', async () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'short question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
  });
  const events: Array<Record<string, JsonSerializable>> = [];
  const preparer = makePreparer(
    new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }),
    transcript,
    [{ content: 'SUMMARY BODY' }],
    events,
  );

  const prepared = withKind(await prepareTurn(preparer, 1, 0), 'ready');

  assert.equal(prepared.compactionSummary, null);
  const budgetEvent = events.find((event) => event.kind === 'turn_preflight_budget');
  assert.ok(budgetEvent);
  assert.equal(prepared.promptTokenCount, Number(budgetEvent.promptTokenCount));
});
