import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { PromptPreparer } from '../src/repo-search/engine/prompt-preparer.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

function makePreparer(budget: TurnBudget, transcript: TranscriptManager): PromptPreparer {
  return new PromptPreparer({
    taskId: 't1',
    model: 'mock-model',
    config: undefined,
    useEstimatedTokensOnly: true,
    budget,
    plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(),
    thinkingEnabled: false,
    reasoningContentEnabled: false,
    preserveThinking: false,
    transcript,
    progress: new ProgressReporter({
      progressWriter: new SilentProgressWriter<RepoSearchProgressEvent>(),
      taskId: 't1',
      maxTurns: 45,
      taskStartedAt: Date.now(),
    }),
    logger: null,
    timingRecorder: null,
  });
}

test('prepareTurn returns a token count and output budget for a small prompt', async () => {
  const transcript = new TranscriptManager({ systemPromptContent: 'SYSTEM', historyMessages: [], initialUserContent: 'short question' });
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 32_000, maxTurns: 45 }), transcript);
  const prepared = await preparer.prepareTurn(1);
  assert.ok(prepared.promptTokenCount > 0);
  assert.ok(prepared.maxOutputTokens > 0);
});

test('prepareTurn throws planner_preflight_overflow when even compaction cannot fit', async () => {
  const transcript = new TranscriptManager({
    systemPromptContent: 'S'.repeat(200_000), // system prompt alone overflows and is never dropped
    historyMessages: [],
    initialUserContent: 'question',
  });
  const preparer = makePreparer(new TurnBudget({ totalContextTokens: 9_000, maxTurns: 45 }), transcript);
  await assert.rejects(preparer.prepareTurn(1), /planner_preflight_overflow/u);
});
