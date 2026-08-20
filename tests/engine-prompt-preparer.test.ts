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

// Sized to the worst case a real turn can produce at a 9000-token window: over the
// 4500-token prompt budget, but inside the 6750 tokens the compaction reserve
// guarantees the summarizer can still swallow in one shot.
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
  assert.equal(transcript.render().includes(COMPACTION_SUMMARY_MARKER), true);
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
    // Never dropped, so the compacted prompt still overflows.
    systemPromptContent: 'S'.repeat(200_000),
    historyMessages: [{ role: 'assistant', content: 'H'.repeat(14_000) }],
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
