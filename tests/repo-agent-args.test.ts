import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRepoAgentInvocation,
  RepoAgentInvocationSchema,
} from '../src/cli/repo-agent-args.js';

test('parses one positional start task with options on either sides', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      '--approval',
      'interactive',
      'make x',
      '--model',
      'm',
      '--progress',
    ]),
    {
      kind: 'start',
      task: 'make x',
      taskTokenCount: 1,
      model: 'm',
      approval: 'interactive',
      progress: true,
      images: [],
    },
  );
  assert.deepEqual(parseRepoAgentInvocation(['make x']), {
    kind: 'start',
    task: 'make x',
    taskTokenCount: 1,
    approval: 'auto',
    progress: false,
    images: [],
  });
});

test('parses start with log-file option', () => {
  assert.deepEqual(
    parseRepoAgentInvocation(['do the thing', '--log-file', '/tmp/out.log']),
    {
      kind: 'start',
      task: 'do the thing',
      taskTokenCount: 1,
      logFile: '/tmp/out.log',
      approval: 'auto',
      progress: false,
      images: [],
    },
  );
});

test('parses start with all options', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      '--model',
      'gpt-4',
      '--log-file',
      '/tmp/a.log',
      '--approval',
      'off',
      '--progress',
      'fix bug',
    ]),
    {
      kind: 'start',
      task: 'fix bug',
      taskTokenCount: 1,
      model: 'gpt-4',
      logFile: '/tmp/a.log',
      approval: 'off',
      progress: true,
      images: [],
    },
  );
});

for (const [value, maxTurns] of [
  ['1', 1],
  ['1000', 1000],
  ['10000', 10000],
  ['9007199254740991', 9007199254740991],
] as const) {
  test(`repo-agent accepts -turns ${value}`, () => {
    const invocation = parseRepoAgentInvocation(['task', '-turns', value]);
    assert.equal(invocation.kind, 'start');
    if (invocation.kind !== 'start') throw new Error('Expected start invocation');
    assert.equal(invocation.maxTurns, maxTurns);
    assert.equal(invocation.task, 'task');
    assert.equal(invocation.taskTokenCount, 1);
  });
}

for (const value of [
  '0',
  '-1',
  '1.5',
  '1k',
  '1e3',
  '0x10',
  '+1',
  'NaN',
  'Infinity',
  '9007199254740992',
  '',
]) {
  test(`repo-agent rejects invalid -turns ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => parseRepoAgentInvocation(['task', '-turns', value]),
      /turns/u,
    );
  });
}

test('repo-agent rejects duplicate turn overrides', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['task', '-turns', '1', '-turns', '1000']),
    /turns/u,
  );
});

test('repo-agent accepts trimmed leading-zero turn overrides before the task', () => {
  const invocation = parseRepoAgentInvocation([
    '-turns',
    ' 001000 ',
    '--model',
    'gpt-4',
    '--log-file',
    '/tmp/run.log',
    '--approval',
    'off',
    '--image',
    'image.png',
    '--progress',
    'task',
  ]);
  assert.deepEqual(invocation, {
    kind: 'start',
    task: 'task',
    taskTokenCount: 1,
    maxTurns: 1000,
    model: 'gpt-4',
    logFile: '/tmp/run.log',
    approval: 'off',
    progress: true,
    images: ['image.png'],
  });
});

test('repo-agent omits maxTurns when the turn override is absent', () => {
  const invocation = parseRepoAgentInvocation(['task']);
  assert.equal(invocation.kind, 'start');
  assert.equal('maxTurns' in invocation, false);
});

test('repo-agent rejects a missing turn override value', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['task', '-turns']),
    /Missing value for -turns/u,
  );
});

test('decide and status reject turn overrides', () => {
  const runId = '550e8400-e29b-41d4-a716-446655440000';
  assert.throws(
    () => parseRepoAgentInvocation(['decide', runId, 'approve', '-turns', '10']),
    /Unknown option: -turns/u,
  );
  assert.throws(
    () => parseRepoAgentInvocation(['status', runId, '-turns', '10']),
    /Unexpected extra token after status: -turns/u,
  );
});

test('parses decide and status subcommands', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      'decide',
      '550e8400-e29b-41d4-a716-446655440000',
      'deny',
      '--reason',
      'unsafe path',
    ]),
    {
      kind: 'decide',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'deny',
      reason: 'unsafe path',
      progress: false,
    },
  );
  assert.deepEqual(
    parseRepoAgentInvocation([
      'status',
      '550e8400-e29b-41d4-a716-446655440000',
    ]),
    {
      kind: 'status',
      runId: '550e8400-e29b-41d4-a716-446655440000',
    },
  );
});

test('parses decide approve without reason', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      'decide',
      '550e8400-e29b-41d4-a716-446655440000',
      'approve',
    ]),
    {
      kind: 'decide',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'approve',
      progress: false,
    },
  );
});

test('decide accepts --progress', () => {
  const invocation = parseRepoAgentInvocation([
    'decide',
    '550e8400-e29b-41d4-a716-446655440000',
    'approve',
    '--progress',
  ]);
  assert.equal(invocation.kind, 'decide');
  if (invocation.kind === 'decide') {
    assert.equal(invocation.progress, true);
  }
});

test('parses decide abort without reason', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      'decide',
      '550e8400-e29b-41d4-a716-446655440000',
      'abort',
    ]),
    {
      kind: 'decide',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'abort',
      progress: false,
    },
  );
});

test('parses decide deny with reason', () => {
  assert.deepEqual(
    parseRepoAgentInvocation([
      'decide',
      '550e8400-e29b-41d4-a716-446655440000',
      'deny',
      '--reason',
      'out of scope',
    ]),
    {
      kind: 'decide',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'deny',
      reason: 'out of scope',
      progress: false,
    },
  );
});

test('RepoAgentInvocationSchema validates parsed output', () => {
  const start = parseRepoAgentInvocation(['fix it']);
  const parsed = RepoAgentInvocationSchema.parse(start);
  assert.equal(parsed.kind, 'start');
  assert.equal(parsed.task, 'fix it');
  assert.equal(parsed.approval, 'auto');
});

test('rejects zero positional tasks', () => {
  assert.throws(
    () => parseRepoAgentInvocation([]),
    /No task provided/u,
  );
});

test('joins positional task tokens', () => {
  assert.deepEqual(parseRepoAgentInvocation(['task one', 'task two']), {
    kind: 'start',
    task: 'task one task two',
    taskTokenCount: 2,
    approval: 'auto',
    progress: false,
    images: [],
  });
});

test('joins the positional tokens produced by PowerShell argument splitting', () => {
  const invocation = parseRepoAgentInvocation([
    'Implement ONLY Task',
    '1:',
    'Add',
    'widget from docs/plan.md',
  ]);
  assert.equal(invocation.kind, 'start');
  assert.equal(invocation.task, 'Implement ONLY Task 1: Add widget from docs/plan.md');
  assert.equal(invocation.taskTokenCount, 4);
});

test('drops empty positional tokens before joining', () => {
  const invocation = parseRepoAgentInvocation(['a', '', 'b']);
  assert.equal(invocation.kind, 'start');
  assert.equal(invocation.task, 'a b');
  assert.equal(invocation.taskTokenCount, 3);
});

test('rejects --prompt flag', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['--prompt', 'make x']),
    /--prompt is not supported/u,
  );
});

test('rejects -prompt flag', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['-prompt', 'make x']),
    /-prompt is not supported/u,
  );
});

test('rejects unknown option', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['fix it', '--unknown']),
    /Unknown option: --unknown/u,
  );
});

test('rejects missing value for --model', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['fix it', '--model']),
    /Missing value for --model/u,
  );
});

test('rejects another option as the value for --model', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['fix it', '--model', '--progress']),
    /Missing value for --model/u,
  );
});

test('rejects missing value for --approval', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['fix it', '--approval']),
    /Missing value for --approval/u,
  );
});

test('rejects missing value for --log-file', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['fix it', '--log-file']),
    /Missing value for --log-file/u,
  );
});

test('rejects missing value for --reason', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000', 'deny', '--reason']),
    /Missing value for --reason/u,
  );
});

test('rejects invalid approval mode', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['fix it', '--approval', 'bogus']),
    /Invalid --approval value: bogus/u,
  );
});

test('rejects --json outside a structural help invocation', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['fix it', '--json']),
    /Unknown option: --json/u,
  );
});

test('rejects invalid run UUID in decide', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', 'not-a-uuid', 'approve']),
    /Invalid run ID/u,
  );
});

test('rejects invalid run UUID in status', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['status', 'not-a-uuid']),
    /Invalid run ID/u,
  );
});

test('rejects deny without reason', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000', 'deny']),
    /deny requires --reason/u,
  );
});

test('rejects deny with empty reason', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000', 'deny', '--reason', '  ']),
    /deny requires --reason/u,
  );
});

test('rejects approve with --reason', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000', 'approve', '--reason', 'ok']),
    /approve does not accept --reason/u,
  );
});

test('rejects abort with --reason', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000', 'abort', '--reason', 'stop']),
    /abort does not accept --reason/u,
  );
});

test('rejects extra tokens after decide', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000', 'approve', 'extra']),
    /Unexpected extra token/u,
  );
});

test('rejects extra tokens after status', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['status', '550e8400-e29b-41d4-a716-446655440000', 'extra']),
    /Unexpected extra token/u,
  );
});

test('rejects decide with missing run ID', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide']),
    /decide requires a run ID/u,
  );
});

test('rejects decide with missing decision', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000']),
    /decide requires a decision/u,
  );
});

test('rejects status with missing run ID', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['status']),
    /status requires a run ID/u,
  );
});

test('rejects invalid decision value', () => {
  assert.throws(
    () => parseRepoAgentInvocation(['decide', '550e8400-e29b-41d4-a716-446655440000', 'maybe']),
    /Invalid decision: maybe/u,
  );
});
