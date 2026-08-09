import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolAction } from '../src/repo-search/planner-protocol.js';
import { z } from '../src/lib/zod.js';
import type { ApprovalRequester } from '../src/repo-search/engine/approval-gate.js';
import { buildRepoToolRequestedCommand } from '../src/repo-search/engine/repo-tools.js';
import { decayInvalidResponses } from '../src/repo-search/engine/task-loop-support.js';
import { REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT } from '../src/repo-search/engine/validation-command-output-policy.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { makeProcessor } from './helpers/tool-action-processor.js';
import type { RepoSearchMockCommandResult } from '../src/repo-search/types.js';

const NOISY_VALIDATION_LINE_COUNT = REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT + 10;
const NOISY_VALIDATION_OUTPUT = Array.from(
  { length: NOISY_VALIDATION_LINE_COUNT },
  (_, index) => `validation-line-${index + 1}`,
).join('\n');
const VALIDATION_COMMAND = buildRepoToolRequestedCommand('run', { command: 'npm test', outputMode: 'full' });
const STABLE_COMMAND = buildRepoToolRequestedCommand('run', { command: 'Write-Output stable' });
const VALIDATION_MOCK_COMMAND_RESULTS = {
  [VALIDATION_COMMAND]: { exitCode: 1, stdout: NOISY_VALIDATION_OUTPUT, stderr: '' },
  [STABLE_COMMAND]: { exitCode: 0, stdout: 'stable\n', stderr: '' },
} satisfies Record<string, RepoSearchMockCommandResult>;

function writeNoisyValidationRepo(root: string): void {
  fs.writeFileSync(
    path.join(root, 'validation.cjs'),
    [
      `for (let index = 1; index <= ${NOISY_VALIDATION_LINE_COUNT}; index += 1) console.log(\`validation-line-\${index}\`);`,
      'process.exitCode = 1;',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'node validation.cjs' } }),
    'utf8',
  );
}

const TurnCommandResultSchema = z.object({ perToolCapTokens: z.number() });

function perToolCapTokensFromEvents(events: JsonObject[]): number[] {
  return events
    .filter((event) => event.kind === 'turn_command_result')
    .map((event) => TurnCommandResultSchema.parse(event).perToolCapTokens);
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

test('non-image command records omit optional image fields from their JSON shape', async () => {
  const root = createManagedTempDir('siftkit-tool-command-image-fields-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'alpha\n', 'utf8');
  const { processor, commands } = makeProcessor(root);

  await processor.executeBatch(
    1,
    [{ action: 'tool', tool_name: 'ls', args: { path: '.' } }],
    '',
    0,
    false,
  );

  const [command] = commands;
  assert.ok(command);
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'imageDataUrls'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(command, 'imageMeta'), false);
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

  const single = makeProcessor(root, ['grep']);
  // Both runs start from an empty command log, so the progress term is at its floor
  // and the only difference between them is how the turn share is split.
  const singleCallCapTokens = single.budget.perToolCapTokens(0, 1);
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
  const { processor, commands, events, budget } = makeProcessor(root, ['grep']);
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
  // The share is the one 3 completed commands earn, split 3 ways — not re-derived here.
  assert.equal(caps[0], budget.perToolCapTokens(3, 3));
});

// The gate's whole retry affordance depends on the duplicate screen letting the granted
// back-to-back identical `run` through; only the third identical call is a duplicate again.
test('a downgraded full run may be retried once despite duplicate screening', async () => {
  const root = createManagedTempDir('siftkit-run-full-retry-');
  writeNoisyValidationRepo(root);
  const { processor, commands } = makeProcessor(root, ['run'], REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT);
  const runAction: ToolAction = { action: 'tool', tool_name: 'run', args: { command: 'npm test', outputMode: 'full' } };

  await processor.executeBatch(1, [{ ...runAction, args: { ...runAction.args } }], '', 0, false);
  await processor.executeBatch(2, [{ ...runAction, args: { ...runAction.args } }], '', 0, false);
  await processor.executeBatch(3, [{ ...runAction, args: { ...runAction.args } }], '', 0, false);

  assert.equal(commands.length, 3);
  assert.equal(commands[0]?.safe, true);
  assert.match(commands[0]?.output ?? '', /Notice: outputMode "full"/u);
  assert.doesNotMatch(commands[0]?.output ?? '', /validation-line-1\b/u);
  assert.equal(commands[1]?.safe, true);
  assert.equal(commands[1]?.reason, null);
  assert.match(commands[1]?.output ?? '', /validation-line-1\b/u);
  assert.equal(commands[2]?.reason, 'duplicate command');
});

test('a mocked full validation run uses the same downgrade and retry shaping', async () => {
  const root = createManagedTempDir('siftkit-run-full-mock-');
  const command = buildRepoToolRequestedCommand('run', { command: 'npm test', outputMode: 'full' });
  const output = Array.from(
    { length: NOISY_VALIDATION_LINE_COUNT },
    (_, index) => `validation-line-${index + 1}`,
  ).join('\n');
  const { processor, commands } = makeProcessor(
    root,
    ['run'],
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
    null,
    { [command]: { exitCode: 1, stdout: output, stderr: '' } },
  );
  const validation: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm test', outputMode: 'full' },
  };

  await processor.executeBatch(1, [validation], '', 0, false);
  await processor.executeBatch(2, [validation], '', 0, false);

  assert.match(commands[0]?.output ?? '', /Notice: outputMode "full"/u);
  assert.doesNotMatch(commands[0]?.output ?? '', /validation-line-1\b/u);
  assert.match(commands[1]?.output ?? '', /validation-line-1\b/u);
  assert.doesNotMatch(commands[1]?.output ?? '', /Notice: outputMode "full"/u);
});

test('a duplicate-rejected intervening run forfeits the pending full retry', async () => {
  const root = createManagedTempDir('siftkit-run-full-forfeit-');
  const { processor, commands } = makeProcessor(
    root,
    ['run'],
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
    null,
    VALIDATION_MOCK_COMMAND_RESULTS,
  );
  const stable: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'Write-Output stable' },
  };
  const validation: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm test', outputMode: 'full' },
  };

  await processor.executeBatch(1, [stable], '', 0, false);
  await processor.executeBatch(2, [validation], '', 0, false);
  await processor.executeBatch(3, [stable, stable], '', 0, false);
  await processor.executeBatch(4, [validation], '', 0, false);

  assert.equal(commands[3]?.reason, 'duplicate command');
  assert.match(commands[4]?.output ?? '', /Notice: outputMode "full"/u);
  assert.doesNotMatch(commands[4]?.output ?? '', /validation-line-1\b/u);
});

test('an approval-denied granted retry is consumed', async () => {
  let requestCount = 0;
  const approvalGate: ApprovalRequester = {
    request(): Promise<{ kind: 'approve' } | { kind: 'deny'; reason: string }> {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 2
          ? { kind: 'deny', reason: 'test denial' }
          : { kind: 'approve' },
      );
    },
  };
  const root = createManagedTempDir('siftkit-run-full-denied-');
  const { processor, commands } = makeProcessor(
    root,
    ['run'],
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
    approvalGate,
    VALIDATION_MOCK_COMMAND_RESULTS,
  );
  const validation: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm test', outputMode: 'full' },
  };

  await processor.executeBatch(1, [validation], '', 0, false);
  await processor.executeBatch(2, [validation], '', 0, false);
  await processor.executeBatch(3, [validation], '', 0, false);

  assert.match(commands[1]?.reason ?? '', /test denial/u);
  assert.equal(commands[2]?.reason, 'duplicate command');
});

test('a non-run tool between downgrade and retry preserves the full grant', async () => {
  const root = createManagedTempDir('siftkit-run-full-non-run-');
  const { processor, commands } = makeProcessor(
    root,
    ['run', 'ls'],
    REPO_AGENT_VALIDATION_OUTPUT_LINE_LIMIT,
    null,
    VALIDATION_MOCK_COMMAND_RESULTS,
  );
  const validation: ToolAction = {
    action: 'tool',
    tool_name: 'run',
    args: { command: 'npm test', outputMode: 'full' },
  };

  await processor.executeBatch(1, [validation], '', 0, false);
  await processor.executeBatch(2, [{ action: 'tool', tool_name: 'ls', args: {} }], '', 0, false);
  await processor.executeBatch(3, [validation], '', 0, false);

  assert.match(commands[2]?.output ?? '', /validation-line-1\b/u);
  assert.doesNotMatch(commands[2]?.output ?? '', /Notice: outputMode "full"/u);
});
