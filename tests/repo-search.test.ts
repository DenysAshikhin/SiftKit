import test from 'node:test';
import assert from 'node:assert/strict';

import { executeRepoSearchRequest } from '../dist/repo-search/index.js';
import {
  listRuntimeArtifacts,
  parseRuntimeArtifactUri,
  readRuntimeArtifact,
} from '../dist/state/runtime-artifacts.js';
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
    const midRunTranscriptArtifactCounts: number[] = [];
    const result = await executeRepoSearchRequest({
      prompt: 'find test patterns',
      repoRoot: tempRoot,
      maxTurns: 1,
      mockResponses: [
        '{"action":"finish","output":"Found test patterns in tests/","confidence":0.9}',
      ],
      mockCommandResults: {},
      onProgress(event) {
        if (!event.kind) {
          return;
        }
        midRunTranscriptArtifactCounts.push(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length);
      },
    });
    assert.equal(typeof result.requestId, 'string');
    assert.ok(result.requestId.length > 0);
    assert.equal(typeof result.transcriptPath, 'string');
    assert.equal(typeof result.artifactPath, 'string');
    assert.ok(midRunTranscriptArtifactCounts.length > 0);
    assert.ok(midRunTranscriptArtifactCounts.every((count) => count === 0));

    const transcriptId = parseRuntimeArtifactUri(result.transcriptPath);
    assert.ok(transcriptId);
    const transcript = readRuntimeArtifact(transcriptId as string);
    assert.equal(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length, 1);
    assert.match(String(transcript?.contentText || ''), /"kind":"run_start"/u);
    assert.match(String(transcript?.contentText || ''), /"kind":"run_done"/u);

    const artifactId = parseRuntimeArtifactUri(result.artifactPath);
    assert.ok(artifactId);
    const artifact = readRuntimeArtifact(artifactId as string);
    assert.equal(artifact?.contentJson?.prompt, 'find test patterns');
    assert.equal(typeof artifact?.contentJson?.verdict, 'string');
    assert.equal(artifact?.contentJson?.transcriptPath, result.transcriptPath);
  });
});

test('executeRepoSearchRequest error path flushes transcript once and exposes final transcript URI', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    await assert.rejects(
      () => executeRepoSearchRequest({
        prompt: 'find test patterns',
        repoRoot: tempRoot,
        allowedTools: [],
      }),
      (error: unknown) => {
        assert.equal(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length, 1);
        assert.equal(typeof (error as { artifactPath?: unknown }).artifactPath, 'string');
        assert.equal(typeof (error as { transcriptPath?: unknown }).transcriptPath, 'string');

        const transcriptId = parseRuntimeArtifactUri(String((error as { transcriptPath?: string }).transcriptPath || ''));
        assert.ok(transcriptId);
        const transcript = readRuntimeArtifact(transcriptId as string);
        assert.equal(transcript?.artifactKind, 'repo_search_transcript');

        const artifactId = parseRuntimeArtifactUri(String((error as { artifactPath?: string }).artifactPath || ''));
        assert.ok(artifactId);
        const artifact = readRuntimeArtifact(artifactId as string);
        assert.equal(
          artifact?.contentJson?.transcriptPath,
          (error as { transcriptPath?: string }).transcriptPath,
        );
        return true;
      },
    );
  });
});

test('executeRepoSearchRequest with mock command executes and returns scorecard', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const result = await executeRepoSearchRequest({
      prompt: 'find build scripts',
      repoRoot: tempRoot,
      maxTurns: 2,
      mockResponses: [
        '{"action":"tool","tool_name":"repo_git","args":{"command":"git status --short"}}',
        '{"action":"finish","output":"Found scripts","confidence":0.8}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '' },
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
    const artifactId = parseRuntimeArtifactUri(result.artifactPath);
    assert.ok(artifactId);
    assert.ok(readRuntimeArtifact(artifactId as string));
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
