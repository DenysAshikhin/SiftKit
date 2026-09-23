import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli } from '../src/cli/index.js';
import { makeCaptureStream } from './_test-helpers.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { withBoundaryServer } from './helpers/cli-boundary-server.js';

test('summary pass/fail command output is delegated to the server', async () => {
  await withBoundaryServer(async (server) => {
    process.env.SIFTKIT_SUMMARY_SOURCE_KIND = 'command-output';
    process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = '0';
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['summary', '--question', 'Did the tests pass?'],
      stdinText: 'PASS tests/unit/example.test.ts\n',
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'server summary response\n');
    assert.equal(stderr.read(), '');
    assert.equal(server.requests.filter((request) => request.route === '/summary').length, 1);
    assert.equal(server.requests[0].body.sourceKind, 'command-output');
    assert.equal(server.requests[0].body.commandExitCode, 0);
    assert.equal(server.requests[0].body.repoRoot, process.cwd());
  });
});

test('repo-search internal op posts to the server endpoint', async () => {
  await withBoundaryServer(async (server) => {
    const tempRoot = createManagedTempDir('siftkit-cli-boundary-');
    const requestFile = path.join(tempRoot, 'repo-search.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Prompt: 'find planner tools',
      RepoRoot: process.cwd(),
      MaxTurns: 1,
    }), 'utf8');
    try {
      const stdout = makeCaptureStream();
      const stderr = makeCaptureStream();
      const code = await runCli({
        argv: ['internal', '--op', 'repo-search', '--request-file', requestFile],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0, stderr.read());
      assert.equal(stderr.read(), '');
      assert.match(stdout.read(), /repo-boundary/u);
      const repoRequest = server.requests.find((request) => request.route === '/repo-search');
      assert.ok(repoRequest);
      assert.equal(repoRequest.body.prompt, 'find planner tools');
      assert.equal(repoRequest.body.repoRoot, process.cwd());
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('run preset posts unresolved preset execution to the server', async () => {
  await withBoundaryServer(async (server) => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['run', '--preset', 'summary', '--question', 'What happened?', '--text', 'Build output'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'server preset response\n');
    assert.equal(stderr.read(), '');
    const presetRequest = server.requests.find((request) => request.route === '/preset/run');
    assert.ok(presetRequest);
    assert.equal(presetRequest.body.presetId, 'summary');
    assert.equal(presetRequest.body.question, 'What happened?');
    assert.equal(presetRequest.body.inputText, 'Build output');
  });
});
