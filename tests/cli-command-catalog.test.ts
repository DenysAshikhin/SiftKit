import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_COMMAND_CATALOG } from '../src/cli/command-catalog.js';

const RESOLVED_ARGS_RUNNERS = [
  'run-capture.ts',
  'run-command.ts',
  'run-config.ts',
  'run-eval.ts',
  'run-find-files.ts',
  'run-install.ts',
  'run-internal.ts',
  'run-preset.ts',
  'run-repo-agent.ts',
  'run-repo-search.ts',
  'run-summary.ts',
] as const;

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

test('CLI runners consume resolved args without resolving the command again', () => {
  for (const fileName of RESOLVED_ARGS_RUNNERS) {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'cli', fileName), 'utf8');
    assert.doesNotMatch(source, /command-catalog\.js/u, fileName);
    assert.doesNotMatch(source, /\bargv:\s*string\[\]/u, fileName);
    assert.doesNotMatch(source, /CLI_COMMAND_CATALOG\.resolve/u, fileName);
  }
});
