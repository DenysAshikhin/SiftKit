import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_COMMAND_CATALOG } from '../src/cli/command-catalog.js';

test('explicit hidden command resolves with one canonical definition', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['eval', '--model', 'mock-model']);
  assert.deepEqual(invocation, {
    command: {
      name: 'eval',
      exposed: false,
      serverDependent: true,
      modelLock: true,
    },
    args: ['--model', 'mock-model'],
  });
});

test('--prompt shorthand resolves to repo-search and preserves all tokens', () => {
  const argv = ['--prompt', 'find things'];
  const invocation = CLI_COMMAND_CATALOG.resolve(argv);
  assert.equal(invocation.command.name, 'repo-search');
  assert.deepEqual(invocation.args, argv);
});

test('unknown first token resolves to implicit summary and preserves all tokens', () => {
  const argv = ['raw output'];
  const invocation = CLI_COMMAND_CATALOG.resolve(argv);
  assert.equal(invocation.command.name, 'summary');
  assert.deepEqual(invocation.args, argv);
});

test('registered public command exposes its server and model-lock behavior', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['repo-agent', '--prompt', 'inspect']);
  assert.deepEqual(invocation.command, {
    name: 'repo-agent',
    exposed: true,
    serverDependent: true,
    modelLock: true,
  });
  assert.deepEqual(invocation.args, ['--prompt', 'inspect']);
});

test('catalog lists every exposed command in definition order', () => {
  assert.deepEqual(CLI_COMMAND_CATALOG.exposedCommandNames, [
    'summary',
    'repo-search',
    'repo-agent',
    'preset',
    'run',
    'find-files',
    'internal',
  ]);
});
