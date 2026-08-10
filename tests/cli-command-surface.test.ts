import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.js';
import { parseArguments } from '../src/cli/args.js';
import { CLI_COMMAND_CATALOG } from '../src/cli/command-catalog.js';
import { makeCaptureStream } from './_test-helpers.js';

test('blocked public commands are not accessible', async () => {
  const blocked = ['install', 'test', 'eval', 'config-get', 'config-set'];
  for (const command of blocked) {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: [command],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    const errorText = stderr.read();
    assert.match(errorText, /not exposed in this CLI build/u);
    assert.match(
      errorText,
      /Available commands: summary, repo-search, repo-agent, preset, assistant, run, find-files, internal, help\./u,
    );
  }
});

test('global backend command is absent from the public command surface', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['backend']);
  assert.equal(invocation.command.name, 'summary');
  assert.deepEqual(invocation.args, ['backend']);
});

test('generic argument parsing does not claim repo-agent approval syntax', () => {
  assert.deepEqual(
    parseArguments(['--approval', 'auto']).positionals,
    ['--approval', 'auto'],
  );
});

test('repo-agent owns start preflight so local control commands stay offline', () => {
  const invocation = CLI_COMMAND_CATALOG.resolve(['repo-agent']);
  assert.equal(invocation.command.name, 'repo-agent');
  assert.equal(invocation.command.exposed, true);
  assert.equal(invocation.command.serverDependent, false);
});
