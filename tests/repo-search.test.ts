import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import { executeRepoSearchRequest } from '../dist/repo-search/index.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('executeRepoSearchRequest throws on empty prompt', async () => {
  await withTestEnvAndServer(async () => {
    await assert.rejects(
      () => executeRepoSearchRequest({ prompt: '', repoRoot: process.cwd() }),
      /--prompt is required/u,
    );
  });
});

test('executeRepoSearchRequest throws on whitespace-only prompt', async () => {
  await withTestEnvAndServer(async () => {
    await assert.rejects(
      () => executeRepoSearchRequest({ prompt: '   ', repoRoot: process.cwd() }),
      /--prompt is required/u,
    );
  });
});

test('executeRepoSearchRequest success path writes transcript and artifact', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const result = await executeRepoSearchRequest({
      prompt: 'find test patterns',
      repoRoot: tempRoot,
      maxTurns: 1,
      mockResponses: [
        '{"action":"finish","output":"Found test patterns in tests/","confidence":0.9}',
      ],
      mockCommandResults: {},
    });
    assert.equal(typeof result.requestId, 'string');
    assert.ok(result.requestId.length > 0);
    assert.equal(typeof result.transcriptPath, 'string');
    assert.equal(typeof result.artifactPath, 'string');
    assert.ok(fs.existsSync(result.artifactPath));
    const artifact = JSON.parse(fs.readFileSync(result.artifactPath, 'utf8')) as { prompt: string; verdict: string };
    assert.equal(artifact.prompt, 'find test patterns');
    assert.equal(typeof artifact.verdict, 'string');
  });
});

test('executeRepoSearchRequest with mock command executes and returns scorecard', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const result = await executeRepoSearchRequest({
      prompt: 'find build scripts',
      repoRoot: tempRoot,
      maxTurns: 2,
      mockResponses: [
        '{"action":"tool","tool_name":"run_repo_cmd","args":{"command":"echo hello"}}',
        '{"action":"finish","output":"Found scripts","confidence":0.8}',
      ],
      mockCommandResults: {
        'echo hello': { exitCode: 0, stdout: 'hello', stderr: '' },
      },
    });
    assert.equal(typeof result.scorecard, 'object');
    assert.equal(result.scorecard.verdict, 'pass');
  });
});

test('executeRepoSearchRequest with empty mock responses still completes', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const result = await executeRepoSearchRequest({
      prompt: 'find something',
      repoRoot: tempRoot,
      maxTurns: 1,
      mockResponses: [],
      mockCommandResults: {},
    });
    assert.equal(typeof result.requestId, 'string');
    assert.equal(typeof result.scorecard, 'object');
  });
});

test('executeRepoSearchRequest handles invalid mock response gracefully', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const result = await executeRepoSearchRequest({
      prompt: 'trigger error handling',
      repoRoot: tempRoot,
      maxTurns: 1,
      mockResponses: [
        'not valid json at all',
      ],
      mockCommandResults: {},
    });
    assert.equal(typeof result.requestId, 'string');
    assert.equal(typeof result.scorecard, 'object');
    assert.ok(fs.existsSync(result.artifactPath));
  });
});

test('executeRepoSearchRequest trace output when SIFTKIT_TRACE_REPO_SEARCH=1', async () => {
  const prev = process.env.SIFTKIT_TRACE_REPO_SEARCH;
  process.env.SIFTKIT_TRACE_REPO_SEARCH = '1';
  try {
    await withTestEnvAndServer(async ({ tempRoot }) => {
      const result = await executeRepoSearchRequest({
        prompt: 'find something with tracing',
        repoRoot: tempRoot,
        maxTurns: 1,
        mockResponses: [
          '{"action":"finish","output":"done","confidence":0.5}',
        ],
        mockCommandResults: {},
      });
      assert.equal(typeof result.requestId, 'string');
    });
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_TRACE_REPO_SEARCH = prev;
    } else {
      delete process.env.SIFTKIT_TRACE_REPO_SEARCH;
    }
  }
});
