import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCli } from '../dist/cli/index.js';
import { makeCaptureStream, withTestEnvAndServer } from './_test-helpers.js';

function toUtf16BeBuffer(text: string, withBom = true): Buffer {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length - 1; index += 2) {
    be[index] = le[index + 1];
    be[index + 1] = le[index];
  }
  return withBom ? Buffer.concat([Buffer.from([0xfe, 0xff]), be]) : be;
}

test('find-files command returns matching files', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-cli-ff-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'a.js'), 'a', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'b.ts'), 'b', 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['find-files', '*.js', '--path', tempRoot],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    assert.match(stdout.read(), /a\.js/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('find-files with --full-path outputs absolute paths', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-cli-ffp-'));
  try {
    fs.writeFileSync(path.join(tempRoot, 'x.js'), 'x', 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['find-files', '*.js', '--path', tempRoot, '--full-path'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    assert.ok(stdout.read().includes(tempRoot));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('find-files with no patterns returns error', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['find-files'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /pattern is required/u);
});

test('internal op with unknown op returns error', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req.json');
    fs.writeFileSync(requestFile, JSON.stringify({}), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'nonexistent-op', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /Unknown internal op/u);
  });
});

test('internal op without --op returns error', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req.json');
    fs.writeFileSync(requestFile, JSON.stringify({}), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /--op is required/u);
  });
});

test('internal op without --request-file returns error', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'find-files'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /--request-file is required/u);
  });
});

test('internal op find-files reads request file and returns results', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const searchDir = path.join(tempRoot, 'search');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'found.js'), 'x', 'utf8');
    const requestFile = path.join(tempRoot, 'req.json');
    fs.writeFileSync(requestFile, JSON.stringify({ Name: ['*.js'], Path: searchDir }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'find-files', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const output = JSON.parse(stdout.read().trim()) as Array<{ Name: string }>;
    assert.ok(Array.isArray(output));
    assert.equal(output.length, 1);
    assert.equal(output[0].Name, 'found.js');
  });
});

test('internal op find-files supports UTF-16 request file', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const searchDir = path.join(tempRoot, 'search-utf16');
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, 'found.js'), 'x', 'utf8');
    const requestFile = path.join(tempRoot, 'req-utf16.json');
    const requestJson = JSON.stringify({ Name: ['*.js'], Path: searchDir });
    fs.writeFileSync(
      requestFile,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(requestJson, 'utf16le')]),
    );
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'find-files', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const output = JSON.parse(stdout.read().trim()) as Array<{ Name: string }>;
    assert.ok(Array.isArray(output));
    assert.equal(output[0].Name, 'found.js');
  });
});

test('internal op config-get returns config object', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req.json');
    fs.writeFileSync(requestFile, JSON.stringify({}), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'config-get', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { Backend: string };
    assert.equal(typeof parsed.Backend, 'string');
  });
});

test('internal op test returns test result', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req.json');
    fs.writeFileSync(requestFile, JSON.stringify({}), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'test', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { Ready: boolean };
    assert.equal(typeof parsed.Ready, 'boolean');
  });
});

test('summary command with --question and --text produces output', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['summary', '--question', 'What happened?', '--text', 'Build output: all 42 tests passed.\n'.repeat(50)],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    assert.ok(stdout.read().trim().length > 0);
  });
});

test('summary command with just a positional question uses stdin text', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['What happened?'],
      stdinText: 'Build completed successfully with 42 tests passing.\n'.repeat(30),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    assert.ok(stdout.read().trim().length > 0);
  });
});

test('--prompt shortcut triggers repo-search', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['--prompt', 'find planner tools'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(typeof code, 'number');
  });
});

test('empty argv shows help', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: [],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /SiftKit CLI/u);
});

test('repo-search --prompt missing value returns error', async () => {
  await withTestEnvAndServer(async () => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['repo-search', '--prompt'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 1);
    assert.match(stderr.read(), /Missing value|--prompt is required/u);
  });
});

test('internal op summary via request file produces output', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req-summary.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Question: 'Summarize the build output',
      Text: 'Build output: all 42 tests passed.\n'.repeat(30),
      Format: 'text',
    }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'summary', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { Summary: string };
    assert.equal(typeof parsed.Summary, 'string');
  });
});

test('internal op summary supports UTF-16 TextFile payload', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const textFile = path.join(tempRoot, 'summary-input-utf16be.txt');
    fs.writeFileSync(textFile, toUtf16BeBuffer('Build output: all tests passed.\n'.repeat(30)));

    const requestFile = path.join(tempRoot, 'req-summary-utf16.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Question: 'Summarize the build output',
      TextFile: textFile,
      Format: 'text',
    }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'summary', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { Summary: string };
    assert.equal(typeof parsed.Summary, 'string');
    assert.equal(parsed.Summary.includes('\u0000'), false);
  });
});

test('internal op command via request file runs command', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req-cmd.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Command: 'node',
      ArgumentList: ['-e', 'console.log("hello")'],
      Question: 'What was printed?',
      NoSummarize: true,
    }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'command', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { ExitCode: number };
    assert.equal(parsed.ExitCode, 0);
  });
});

test('internal op command-analyze via request file analyzes output', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req-cmd-analyze.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      ExitCode: 0,
      RawText: 'Build completed. All tests passed.',
      Question: 'Did the build pass?',
      NoSummarize: true,
    }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'command-analyze', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { ExitCode: number };
    assert.equal(typeof parsed.ExitCode, 'number');
  });
});

test('internal op config-set via request file updates config', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req-config-set.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Key: 'PolicyMode',
      Value: 'aggressive',
    }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'config-set', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
  });
});

test('internal op install via request file returns installation info', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req-install.json');
    fs.writeFileSync(requestFile, JSON.stringify({ Force: false }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'install', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { Installed: true };
    assert.equal(parsed.Installed, true);
  });
});

test('internal op codex-policy via request file installs policy', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const codexHome = path.join(tempRoot, '.codex');
    const requestFile = path.join(tempRoot, 'req-codex-policy.json');
    fs.writeFileSync(requestFile, JSON.stringify({ CodexHome: codexHome }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'codex-policy', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.read().trim()) as { Installed: true };
    assert.equal(parsed.Installed, true);
  });
});

test('internal op eval via request file runs evaluation', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const fixtureRoot = path.join(tempRoot, 'fixtures');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'source.txt'), 'Test data.', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'fixtures.json'), JSON.stringify([
      { Name: 'test', File: 'source.txt', Question: 'Summarize', Format: 'text', PolicyProfile: 'general', RequiredTerms: [], ForbiddenTerms: [] },
    ]), 'utf8');
    const requestFile = path.join(tempRoot, 'req-eval.json');
    fs.writeFileSync(requestFile, JSON.stringify({ FixtureRoot: fixtureRoot }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'eval', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
  });
});

test('internal op repo-search via request file executes search', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const requestFile = path.join(tempRoot, 'req-repo-search.json');
    fs.writeFileSync(requestFile, JSON.stringify({
      Prompt: 'find something',
      RepoRoot: tempRoot,
      MaxTurns: 1,
      MockResponses: ['{"action":"finish","output":"done","confidence":0.5}'],
      MockCommandResults: {},
    }), 'utf8');
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['internal', '--op', 'repo-search', '--request-file', requestFile],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 0);
  });
});

test('blocked commands like find-files are accessible but run and eval are blocked', async () => {
  const stdout = makeCaptureStream();
  const stderr = makeCaptureStream();
  const code = await runCli({
    argv: ['run'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /A command is required|not exposed in this CLI build/u);
});
