import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivitySummaryCollector } from '../src/repo-search/engine/activity-summary-collector.js';
import type { ToolAction } from '../src/repo-search/planner-protocol.js';
import type { TaskCommand } from '../src/repo-search/prompts.js';

function makeReadAction(path: string): ToolAction {
  return { action: 'tool', tool_name: 'read', args: { path } };
}

function makeGitAction(command: string): ToolAction {
  return { action: 'tool', tool_name: 'git', args: { command } };
}

function makeRunAction(command: string): ToolAction {
  return { action: 'tool', tool_name: 'run', args: { command } };
}

function makeEditAction(path: string): ToolAction {
  return { action: 'tool', tool_name: 'edit', args: { path } };
}

function makeWriteAction(path: string): ToolAction {
  return { action: 'tool', tool_name: 'write', args: { path } };
}

function makeWebSearchAction(query: string): ToolAction {
  return { action: 'tool', tool_name: 'web_search', args: { query } };
}

function makeCommand(command: string, turn: number, safe = true, exitCode = 0): TaskCommand {
  return { command, turn, safe, reason: null, exitCode, output: '' };
}

test('turns 1-9 return null', () => {
  const collector = new ActivitySummaryCollector();
  for (let t = 1; t <= 9; t++) {
    collector.recordBatch(t, [makeReadAction('file.ts')], [makeCommand('read file.ts', t)]);
    assert.equal(collector.takeSummary(t, 45), null);
  }
});

test('turn 10 returns one event with unique entries', () => {
  const collector = new ActivitySummaryCollector();
  // Record some activity in turns 1-9
  collector.recordBatch(1, [makeReadAction('a.ts')], [makeCommand('read a.ts', 1)]);
  collector.recordBatch(2, [makeReadAction('b.ts')], [makeCommand('read b.ts', 2)]);
  collector.recordBatch(3, [makeGitAction('git fetch')], [makeCommand('git fetch', 3)]);
  collector.recordBatch(4, [makeEditAction('c.ts')], [makeCommand('edit c.ts', 4)]);
  collector.recordBatch(5, [makeRunAction('npm test')], [makeCommand('npm test', 5)]);
  collector.recordBatch(6, [makeWebSearchAction('x')], [makeCommand('web_search x', 6)]);
  collector.recordBatch(7, [makeRunAction('echo hello')], [makeCommand('echo hello', 7)]);
  collector.recordBatch(8, [makeReadAction('a.ts')], [makeCommand('read a.ts', 8)]); // duplicate read
  collector.recordBatch(9, [makeRunAction('cargo test')], [makeCommand('cargo test', 9)]);

  // Turn 10: add a failed action
  collector.recordBatch(10, [makeRunAction('fail cmd')], [makeCommand('fail cmd', 10, false, 1)]);

  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  assert.equal(event.kind, 'activity_summary');
  assert.equal(event.turn, 10);
  assert.equal(event.maxTurns, 45);

  const categories = event.entries.map((e) => e.category);
  assert.ok(categories.includes('read_files'), 'expected read_files');
  assert.ok(categories.includes('repository_searches'), 'expected repository_searches');
  assert.ok(categories.includes('commands'), 'expected commands');
  assert.ok(categories.includes('edited_files'), 'expected edited_files');
  assert.ok(categories.includes('tests'), 'expected tests');
  assert.ok(categories.includes('web'), 'expected web');

  // Verify de-duplication: read a.ts appeared twice but should be one entry; b.ts is separate
  const readEntries = event.entries.filter((e) => e.category === 'read_files');
  assert.equal(readEntries.length, 2);
  const readLabels = readEntries.map((e) => e.label).sort();
  assert.deepEqual(readLabels, ['a.ts', 'b.ts']);

  // Verify failed marker
  const failedEntries = event.entries.filter((e) => e.failed);
  assert.equal(failedEntries.length, 1);
});

test('multiple actions in turn-10 batch produce one event', () => {
  const collector = new ActivitySummaryCollector();
  collector.recordBatch(1, [makeReadAction('x.ts')], [makeCommand('read x.ts', 1)]);

  // Turn 10: multiple actions in one batch
  collector.recordBatch(10, [
    makeReadAction('y.ts'),
    makeRunAction('npm run test'),
    makeWriteAction('z.ts'),
  ], [
    makeCommand('read y.ts', 10),
    makeCommand('npm run test', 10),
    makeCommand('write z.ts', 10),
  ]);

  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  assert.equal(event.turn, 10);
  const categories = event.entries.map((e) => e.category);
  assert.ok(categories.includes('read_files'));
  assert.ok(categories.includes('tests'));
  assert.ok(categories.includes('edited_files'));
});

test('turn 20 contains only activity recorded after turn 10', () => {
  const collector = new ActivitySummaryCollector();
  collector.recordBatch(1, [makeReadAction('a.ts')], [makeCommand('read a.ts', 1)]);
  collector.recordBatch(5, [makeRunAction('npm test')], [makeCommand('npm test', 5)]);

  // Turn 10: emit summary
  collector.recordBatch(10, [makeReadAction('b.ts')], [makeCommand('read b.ts', 10)]);
  const event10 = collector.takeSummary(10, 45);
  assert.ok(event10 !== null);

  // Record new activity after turn 10
  collector.recordBatch(11, [makeEditAction('c.ts')], [makeCommand('edit c.ts', 11)]);
  collector.recordBatch(15, [makeGitAction('git log')], [makeCommand('git log', 15)]);

  // Turn 20: emit summary
  collector.recordBatch(20, [makeRunAction('pytest')], [makeCommand('pytest', 20)]);
  const event20 = collector.takeSummary(20, 45);
  assert.ok(event20 !== null);

  // Turn 20 should NOT contain a.ts, b.ts, or the turn-5 npm test
  const labels20 = event20.entries.map((e) => e.label);
  assert.ok(!labels20.includes('a.ts'), 'a.ts from turn 1 must not appear in turn 20');
  assert.ok(!labels20.includes('b.ts'), 'b.ts from turn 10 must not appear in turn 20');

  // Turn 20 should contain c.ts, git log, and pytest
  assert.ok(labels20.includes('c.ts'), 'c.ts from turn 11 must appear in turn 20');
  assert.ok(labels20.includes('git log'), 'git log from turn 15 must appear in turn 20');
});

test('run ending at turn 17 never emits partial summary', () => {
  const collector = new ActivitySummaryCollector();
  for (let t = 1; t <= 17; t++) {
    collector.recordBatch(t, [makeReadAction(`file${t}.ts`)], [makeCommand(`read file${t}.ts`, t)]);
    const result = collector.takeSummary(t, 45);
    if (t === 10) {
      assert.ok(result !== null, 'turn 10 must emit');
    } else {
      assert.equal(result, null, `turn ${t} must not emit`);
    }
  }
});

test('classifies test commands by recognized patterns', () => {
  const collector = new ActivitySummaryCollector();
  const testCommands = [
    'npm test',
    'npm run test',
    'node .\\dist\\test-runner\\run-tests.js',
    'npx vitest',
    'npx jest',
    'pytest',
    'cargo test',
    'go test',
  ];
  for (const cmd of testCommands) {
    collector.recordBatch(1, [makeRunAction(cmd)], [makeCommand(cmd, 1)]);
  }
  collector.recordBatch(10, [makeReadAction('x.ts')], [makeCommand('read x.ts', 10)]);
  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  const testEntries = event.entries.filter((e) => e.category === 'tests');
  assert.equal(testEntries.length, testCommands.length, 'all recognized test commands should be in tests category');
});

test('does not classify arbitrary commands containing substring test', () => {
  const collector = new ActivitySummaryCollector();
  collector.recordBatch(1, [makeRunAction('echo test_output')], [makeCommand('echo test_output', 1)]);
  collector.recordBatch(2, [makeRunAction('cat test.txt')], [makeCommand('cat test.txt', 2)]);
  collector.recordBatch(10, [makeReadAction('x.ts')], [makeCommand('read x.ts', 10)]);
  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  const testEntries = event.entries.filter((e) => e.category === 'tests');
  assert.equal(testEntries.length, 0, 'arbitrary commands with "test" substring must not be classified as tests');
  const cmdEntries = event.entries.filter((e) => e.category === 'commands');
  assert.equal(cmdEntries.length, 2, 'both commands should be in commands category');
});

test('skips actions that produced no command in the batch', () => {
  const collector = new ActivitySummaryCollector();
  collector.recordBatch(
    10,
    [makeReadAction('a.ts'), makeReadAction('b.ts')],
    [makeCommand('read a.ts', 10)],
  );
  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  assert.deepEqual(event.entries, [
    { category: 'read_files', label: 'a.ts', failed: false },
  ]);
});

test('labels actions whose planner args omit the expected field', () => {
  const collector = new ActivitySummaryCollector();
  collector.recordBatch(
    10,
    [
      { action: 'tool', tool_name: 'read', args: {} },
      { action: 'tool', tool_name: 'web_search', args: {} },
      { action: 'tool', tool_name: 'run', args: {} },
    ],
    [makeCommand('read', 10), makeCommand('web_search', 10), makeCommand('run', 10)],
  );
  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  assert.deepEqual(event.entries, [
    { category: 'read_files', label: 'unknown', failed: false },
    { category: 'web', label: 'web', failed: false },
    { category: 'commands', label: 'run', failed: false },
  ]);
});

test('marks entries failed for a missing exit code and for a non-zero exit code', () => {
  const collector = new ActivitySummaryCollector();
  collector.recordBatch(
    10,
    [makeRunAction('killed'), makeRunAction('boom')],
    [
      { command: 'killed', turn: 10, safe: true, reason: null, exitCode: null, output: '' },
      makeCommand('boom', 10, true, 2),
    ],
  );
  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  assert.deepEqual(event.entries, [
    { category: 'commands', label: 'killed', failed: true },
    { category: 'commands', label: 'boom', failed: true },
  ]);
});

test('a repeated label becomes failed once any occurrence fails', () => {
  const collector = new ActivitySummaryCollector();
  collector.recordBatch(1, [makeRunAction('npm test')], [makeCommand('npm test', 1)]);
  collector.recordBatch(2, [makeRunAction('npm test')], [makeCommand('npm test', 2, true, 1)]);
  collector.recordBatch(10, [makeRunAction('npm test')], [makeCommand('npm test', 10)]);
  const event = collector.takeSummary(10, 45);
  assert.ok(event !== null);
  assert.deepEqual(event.entries, [
    { category: 'tests', label: 'npm test', failed: true },
  ]);
});
