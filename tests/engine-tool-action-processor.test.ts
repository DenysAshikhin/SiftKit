import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import { ChatGroundingPolicy } from '../src/repo-search/chat-grounding-policy.js';
import type { TaskCommand } from '../src/repo-search/prompts.js';
import { DuplicateTracker } from '../src/repo-search/engine/duplicate-tracker.js';
import { ForcedFinishController } from '../src/repo-search/engine/forced-finish.js';
import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { ReadWindowGovernor } from '../src/repo-search/engine/read-window-governor.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { ToolActionProcessor } from '../src/repo-search/engine/tool-action-processor.js';
import { ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.js';
import type { LoopCounters } from '../src/repo-search/engine/task-loop-support.js';
import { ToolStatsRecorder } from '../src/repo-search/engine/tool-stats.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { makeMockWebTools } from './helpers/mock-web-tools.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function makeProcessor(
  root: string,
  allowedPlannerToolNames: string[] = ['ls'],
): { processor: ToolActionProcessor; commands: TaskCommand[]; counters: LoopCounters } {
  const commands: TaskCommand[] = [];
  const counters: LoopCounters = { invalidResponses: 0, commandFailures: 0, safetyRejects: 0, reason: '' };
  const processor = new ToolActionProcessor({
    task: { id: 'task-alignment', question: 'q', signals: ['done'] },
    repoRoot: root,
    config: undefined,
    logger: null,
    timingRecorder: null,
    maxInvalidResponses: 3,
    allowedPlannerToolNames,
    approvalGate: null,
    validationCommandOutputLineLimit: null,
    chatWebGroundingEnabled: false,
    chatWebGroundingPolicy: new ChatGroundingPolicy({ enabled: false }),
    ignorePolicy: buildIgnorePolicy(root),
    webTools: makeMockWebTools(),
    budget: new TurnBudget({ totalContextTokens: 20000, maxTurns: 5 }),
    tokenUsage: new TokenUsageTracker(undefined, true),
    toolStats: new ToolStatsRecorder(),
    duplicates: new DuplicateTracker(),
    forcedFinish: new ForcedFinishController(),
    resultBudgeter: new ToolResultBudgeter({ config: undefined, useEstimatedTokensOnly: true, timingRecorder: null }),
    readWindows: new ReadWindowGovernor(),
    maintainPerStepThinking: true,
    progress: new ProgressReporter({
      progressWriter: new SilentProgressWriter(),
      taskId: 'task-alignment',
      maxTurns: 5,
      taskStartedAt: Date.now(),
    }),
    transcript: new TranscriptManager({
      systemPromptContent: 'system',
      historyMessages: [],
      initialUserContent: 'q',
      initialUserImages: [],
    }),
    recentEvidenceKeys: new Set<string>(),
    successfulToolCalls: [],
    commands,
    counters,
  });
  return { processor, commands, counters };
}

// The task loop pairs command results back to tool actions by array index, so every processed
// action — including an invalid one — must append exactly one `commands` entry, in order.
test('executeBatch records one command entry per tool action so results stay aligned', async () => {
  const root = createManagedTempDir('siftkit-tool-actions-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, commands } = makeProcessor(root);
  await processor.executeBatch(
    1,
    [
      { action: 'tool', tool_name: 'frobnicate', args: {} },
      { action: 'tool', tool_name: 'ls', args: { path: '.' } },
    ],
    '',
    0,
    false,
  );
  assert.equal(commands.length, 2);
  assert.equal(commands[0].safe, false);
  assert.equal(commands[0].reason, 'invalid action');
  assert.equal(commands[1].safe, true);
});

test('a git action whose command omits the git token is normalized instead of rejected', async () => {
  const root = createManagedTempDir('siftkit-git-prefix-');
  const { processor, commands, counters } = makeProcessor(root, ['git']);

  await processor.executeBatch(1, [{ action: 'tool', tool_name: 'git', args: { command: 'status' } }], '', 0, false);

  assert.equal(counters.invalidResponses, 0);
  assert.equal(commands[0]?.command, 'git status');
});
