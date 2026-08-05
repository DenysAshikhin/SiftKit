import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildIgnorePolicy } from '../src/repo-search/command-safety.js';
import { ChatGroundingPolicy } from '../src/repo-search/chat-grounding-policy.js';
import type { TaskCommand } from '../src/repo-search/prompts.js';
import type { ToolAction } from '../src/repo-search/planner-protocol.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { DuplicateTracker } from '../src/repo-search/engine/duplicate-tracker.js';
import { ForcedFinishController } from '../src/repo-search/engine/forced-finish.js';
import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import { ReadWindowGovernor } from '../src/repo-search/engine/read-window-governor.js';
import { TokenUsageTracker } from '../src/repo-search/engine/token-usage.js';
import { ToolActionProcessor } from '../src/repo-search/engine/tool-action-processor.js';
import { ToolResultBudgeter } from '../src/repo-search/engine/tool-result-budgeter.js';
import { decayInvalidResponses, type LoopCounters } from '../src/repo-search/engine/task-loop-support.js';
import { ToolStatsRecorder } from '../src/repo-search/engine/tool-stats.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import { TurnBudget } from '../src/repo-search/engine/turn-budget.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { makeMockWebTools } from './helpers/mock-web-tools.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function makeProcessor(
  root: string,
  allowedPlannerToolNames: string[] = ['ls'],
): {
  processor: ToolActionProcessor;
  commands: TaskCommand[];
  counters: LoopCounters;
  tokenUsage: TokenUsageTracker;
  events: Array<Record<string, JsonSerializable>>;
} {
  const commands: TaskCommand[] = [];
  const counters: LoopCounters = { invalidResponses: 0, commandFailures: 0, safetyRejects: 0, reason: '' };
  const tokenUsage = new TokenUsageTracker(undefined, true);
  const events: Array<Record<string, JsonSerializable>> = [];
  const processor = new ToolActionProcessor({
    task: { id: 'task-alignment', question: 'q', signals: ['done'] },
    repoRoot: root,
    config: undefined,
    logger: {
      path: 'memory',
      write(event: Record<string, JsonSerializable>): void {
        events.push(event);
      },
    },
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
    tokenUsage,
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
  return { processor, commands, counters, tokenUsage, events };
}

function perToolCapTokensFromEvents(events: Array<Record<string, JsonSerializable>>): number[] {
  return events
    .filter((event) => event.kind === 'turn_command_result')
    .map((event) => Number(event.perToolCapTokens));
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

test('decayInvalidResponses steps the counter down and floors at zero', () => {
  const counters = { invalidResponses: 2, commandFailures: 0, safetyRejects: 0, reason: 'max_turns' };

  decayInvalidResponses(counters);
  assert.equal(counters.invalidResponses, 1);
  decayInvalidResponses(counters);
  assert.equal(counters.invalidResponses, 0);
  decayInvalidResponses(counters);
  assert.equal(counters.invalidResponses, 0);
});

test('a valid tool action decays the invalid-response counter', async () => {
  const root = createManagedTempDir('siftkit-decay-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, counters } = makeProcessor(root);
  counters.invalidResponses = 2;

  await processor.executeBatch(1, [{ action: 'tool', tool_name: 'ls', args: { path: '.' } }], '', 0, false);

  assert.equal(counters.invalidResponses, 1);
});

test('an invalid action followed by two valid ones leaves the counter at zero', async () => {
  const root = createManagedTempDir('siftkit-decay-streak-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, counters } = makeProcessor(root);

  await processor.executeBatch(
    1,
    [
      { action: 'tool', tool_name: 'frobnicate', args: {} },
      { action: 'tool', tool_name: 'ls', args: { path: '.' } },
      { action: 'tool', tool_name: 'ls', args: { path: '.' } },
    ],
    '',
    0,
    false,
  );

  assert.equal(counters.invalidResponses, 0);
});

test('a valid action whose command exits non-zero still decays the counter', async () => {
  const root = createManagedTempDir('siftkit-decay-red-');
  const { processor, commands, counters } = makeProcessor(root, ['git']);
  counters.invalidResponses = 2;

  await processor.executeBatch(
    1,
    [{ action: 'tool', tool_name: 'git', args: { command: 'git log --oneline -1' } }],
    '',
    0,
    false,
  );

  assert.notEqual(commands[0]?.exitCode, 0);
  assert.equal(counters.invalidResponses, 1);
});

test('a duplicate-rejected action does not decay the invalid-response counter', async () => {
  const root = createManagedTempDir('siftkit-decay-duplicate-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, commands, counters } = makeProcessor(root);
  counters.invalidResponses = 2;

  await processor.executeBatch(
    1,
    [
      { action: 'tool', tool_name: 'ls', args: { path: '.' } },
      { action: 'tool', tool_name: 'ls', args: { path: '.' } },
    ],
    '',
    0,
    false,
  );

  assert.equal(commands[1]?.reason, 'duplicate command');
  assert.equal(counters.invalidResponses, 1);
});

// Rejected actions used to buy back a strike, so a model alternating malformed actions with
// unsafe-but-distinct commands never reached the limit and only `max_turns` ended the run.
test('malformed actions alternating with safety-rejected ones still hit the invalid-response limit', async () => {
  const root = createManagedTempDir('siftkit-decay-unsafe-');
  const { processor, counters } = makeProcessor(root, ['ls', 'git']);
  const actions: ToolAction[] = [];
  for (let index = 0; index < 3; index += 1) {
    actions.push({ action: 'tool', tool_name: 'frobnicate', args: {} });
    actions.push({ action: 'tool', tool_name: 'git', args: { command: `git push origin branch-${index}` } });
  }

  await processor.executeBatch(1, actions, '', 0, false);

  assert.equal(counters.invalidResponses, 3);
  assert.equal(counters.reason, 'invalid_response_limit');
});

// A 3-wide batch must not consume more prompt budget than one call would have been
// allowed on its own: the per-turn tool share is divided across the batch, not
// granted to each member. Regression guard for batches eating the context window.
test('a parallel batch spends no more tool budget in total than a single call is allowed', async () => {
  const root = createManagedTempDir('siftkit-batch-budget-');
  const lines: string[] = [];
  for (let index = 0; index < 4000; index += 1) {
    lines.push(`export const alpha${index} = 'beta${index} gamma${index} delta${index}';`);
  }
  fs.writeFileSync(path.join(root, 'big.ts'), `${lines.join('\n')}\n`, 'utf8');

  // Both runs start from an empty command log, so the progress term is at its floor
  // and the only difference between them is how the turn share is split.
  const singleCallCapTokens = new TurnBudget({ totalContextTokens: 20000, maxTurns: 5 }).perToolCapTokens(0, 1);

  const single = makeProcessor(root, ['grep']);
  await single.processor.executeBatch(
    1,
    [{ action: 'tool', tool_name: 'grep', args: { pattern: 'alpha', path: '.' } }],
    '',
    0,
    false,
  );
  const singleCallToolTokens = single.tokenUsage.snapshot().toolTokens;
  assert.ok(singleCallToolTokens > 0, 'the single grep produced no tool tokens');
  assert.ok(
    singleCallToolTokens <= singleCallCapTokens,
    `single grep spent ${singleCallToolTokens} tool tokens, above its own cap ${singleCallCapTokens}`,
  );

  const batch = makeProcessor(root, ['grep']);
  await batch.processor.executeBatch(
    1,
    [
      { action: 'tool', tool_name: 'grep', args: { pattern: 'alpha', path: '.' } },
      { action: 'tool', tool_name: 'grep', args: { pattern: 'beta', path: '.' } },
      { action: 'tool', tool_name: 'grep', args: { pattern: 'gamma', path: '.' } },
    ],
    '',
    0,
    false,
  );
  assert.equal(batch.commands.length, 3);
  for (const command of batch.commands) {
    assert.equal(command.safe, true);
  }
  const batchToolTokens = batch.tokenUsage.snapshot().toolTokens;

  assert.ok(
    batchToolTokens <= singleCallCapTokens,
    `batch of 3 spent ${batchToolTokens} tool tokens, above the single-call cap ${singleCallCapTokens}`,
  );
});

// The turn share grows with commands completed *before* the turn. Reading that counter
// live would let it climb inside a batch, handing each successive member a larger cap
// than the one before and breaking the even split.
test('every member of a batch is capped at the same share regardless of position', async () => {
  const root = createManagedTempDir('siftkit-batch-cap-snapshot-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha beta gamma\n', 'utf8');
  const { processor, commands, events } = makeProcessor(root, ['grep']);
  // Put the run far enough along that the progress term, not the floor, sets the share.
  for (let index = 0; index < 3; index += 1) {
    commands.push({ command: `ls prior-${index}`, turn: index + 1, safe: true, reason: null, exitCode: 0, output: 'prior' });
  }

  await processor.executeBatch(
    4,
    [
      { action: 'tool', tool_name: 'grep', args: { pattern: 'alpha', path: '.' } },
      { action: 'tool', tool_name: 'grep', args: { pattern: 'beta', path: '.' } },
      { action: 'tool', tool_name: 'grep', args: { pattern: 'gamma', path: '.' } },
    ],
    '',
    0,
    false,
  );

  const caps = perToolCapTokensFromEvents(events);
  assert.equal(caps.length, 3);
  assert.deepEqual(caps, [caps[0], caps[0], caps[0]]);
  // maxTurns 5, usable 16000, 3 commands completed -> share max(0.075, 3/5) = 0.6, split 3 ways.
  assert.equal(caps[0], Math.floor((16000 * 0.6) / 3));
});
