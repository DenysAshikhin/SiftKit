import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli/index.js';
import { makeCaptureStream, withTestEnvAndServer } from './_test-helpers.js';
import { parseJsonValueText } from '../src/lib/json.js';
import {
  detectRepoAgentHelpInvocation,
  RepoAgentHelpSchema,
} from '../src/cli/repo-agent-help.js';
import { parseRepoAgentInvocation } from '../src/cli/repo-agent-args.js';

test('CLI accepts --h as help alias', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['--h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /SiftKit CLI/u);
});

test('CLI accepts -help as help alias', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['-help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /Usage:/u);
});

test('CLI help advertises preset commands', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /siftkit preset list/u);
});

test('CLI help lists the repo-agent command with positional syntax', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /siftkit repo-agent "task"/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-search help works without server startup', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '-h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /repo-search/u);
});

test('run help works without executing --help as a command', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['run', '--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /siftkit run --command <cmd>/u);
  assert.equal(stderr.read(), '');
});

test('repo-search rejects unknown flags before startup checks', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '--prmopt', 'find planner tools'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown option for repo-search: --prmopt/u);
});

test('repo-search rejects --max-turns for CLI usage', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-search', '--prompt', 'find planner tools', '--max-turns', '5'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown option for repo-search: --max-turns/u);
});

// summary reaches the status server before it validates its input, so the argument error
// only surfaces against a running backend. The stub supplies one; without it the CLI
// reports "not reachable" and the real assertion never runs.
test('summary requires stdin, --text, or --file', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['summary', '--question', 'hello'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /stdin, --text or --file required/u);
  });
});

test('repo-agent --help returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', '--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /siftkit repo-agent "task"/u);
  assert.match(
    text,
    /siftkit repo-agent decide <run-id> <approve\|deny\|abort> \[--reason <text>\]/u,
  );
  assert.match(text, /siftkit repo-agent status <run-id>/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-agent -h returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', '-h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /siftkit repo-agent "task"/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-agent help returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /siftkit repo-agent "task"/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('help repo-agent returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['help', 'repo-agent'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /siftkit repo-agent "task"/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-agent decide --help returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'decide', '--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /decide/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-agent decide -h returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'decide', '-h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /decide/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-agent status --help returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'status', '--help'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /status/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-agent status -h returns 0 without server', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'status', '-h'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const text = stdout.read();
  assert.match(text, /status/u);
  assert.doesNotMatch(text, /repo-agent --prompt/u);
});

test('repo-agent --help --json parses as RepoAgentHelpSchema', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', '--help', '--json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const help = RepoAgentHelpSchema.parse(parseJsonValueText(stdout.read()));
  assert.equal(help.command, 'repo-agent');
  assert.equal(help.topic, 'root');
  assert.equal(
    help.canonicalInvocation,
    'siftkit repo-agent "task" [options]',
  );
  assert.equal(help.defaultApproval, 'auto');
  assert.equal(help.ttyMode, 'foreground-interactive');
  assert.equal(help.nonTtyMode, 'resumable-json');
  assert.deepEqual(
    help.resultStatuses,
    ['completed', 'approval_required', 'failed', 'aborted'],
  );
  assert.deepEqual(
    help.commands,
    [
      {
        name: 'start',
        synopsis: 'siftkit repo-agent "task" [options]',
        arguments: ['task'],
      },
      {
        name: 'decide',
        synopsis:
          'siftkit repo-agent decide <run-id> <approve|deny|abort> [--reason <text>]',
        arguments: ['run-id', 'decision'],
      },
      {
        name: 'status',
        synopsis: 'siftkit repo-agent status <run-id>',
        arguments: ['run-id'],
      },
    ],
  );
  assert.deepEqual(
    help.results,
    [
      { status: 'completed', exitCode: 0, meaning: 'Task completed.' },
      { status: 'approval_required', exitCode: 0, meaning: 'A decision is required.' },
      { status: 'failed', exitCode: 1, meaning: 'Task failed.' },
      { status: 'aborted', exitCode: 1, meaning: 'Task was aborted.' },
    ],
  );
  assert.ok(help.options.some((option) => option.name === '--approval'));
  assert.ok(help.examples.some((example) => example.includes('deny --reason')));
});

test('repo-agent help --json parses as RepoAgentHelpSchema', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'help', '--json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const help = RepoAgentHelpSchema.parse(parseJsonValueText(stdout.read()));
  assert.equal(help.command, 'repo-agent');
  assert.equal(help.defaultApproval, 'auto');
});

test('help repo-agent --json parses as RepoAgentHelpSchema', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['help', 'repo-agent', '--json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const help = RepoAgentHelpSchema.parse(parseJsonValueText(stdout.read()));
  assert.equal(help.command, 'repo-agent');
  assert.equal(help.defaultApproval, 'auto');
});

test('repo-agent decide --help --json parses as RepoAgentHelpSchema', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'decide', '--help', '--json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const help = RepoAgentHelpSchema.parse(parseJsonValueText(stdout.read()));
  assert.equal(help.command, 'repo-agent');
  assert.equal(help.topic, 'decide');
});

test('repo-agent status --help --json parses as RepoAgentHelpSchema', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['repo-agent', 'status', '--help', '--json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  const help = RepoAgentHelpSchema.parse(parseJsonValueText(stdout.read()));
  assert.equal(help.command, 'repo-agent');
  assert.equal(help.topic, 'status');
});

test('task containing "help" word is not treated as help', () => {
  const result = parseRepoAgentInvocation(['help update the docs']);
  assert.equal(result.kind, 'start');
  assert.equal(result.task, 'help update the docs');
});

test('help detection rejects json without a structural help form', () => {
  assert.equal(
    detectRepoAgentHelpInvocation(['repo-agent', 'fix it', '--json']),
    null,
  );
});
