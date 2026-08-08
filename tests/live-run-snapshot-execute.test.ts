import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { getLiveRunSnapshotPath } from '../src/config/paths.js';
import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import { LiveRunSnapshotSchema } from '../src/repo-search/live-snapshot/schemas.js';
import { withTestEnvAndServer } from './_test-helpers.js';

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test('transcript records preflight start and command start events for every turn', async () => {
  await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      prompt: 'find build scripts',
      repoRoot,
      maxTurns: 2,
      mockResponses: [
        '{"action":"git","command":"git status --short"}',
        '{"action":"finish","output":"Found scripts"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '' },
      },
    });
    assert.equal(result.scorecard.verdict, 'pass');
  });
});

test('a live snapshot exists while the run is in flight and is removed once it finishes', async () => {
  await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
    const requestId = 'live-inflight-1';
    const snapshotPath = getLiveRunSnapshotPath(requestId, repoRoot);

    const pending = executeRepoSearchRequest({
      presetId: 'repo-search',
      requestId,
      prompt: 'find build scripts',
      repoRoot,
      maxTurns: 2,
      mockResponses: [
        '{"action":"git","command":"git status --short"}',
        '{"action":"finish","output":"Found scripts"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '', delayMs: 1500 },
      },
    });

    const appeared = await waitForFile(snapshotPath, 3000);
    assert.equal(appeared, true, 'expected a live snapshot while the run is in flight');

    const snapshot = LiveRunSnapshotSchema.parse(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')));
    assert.equal(snapshot.requestId, requestId);
    assert.equal(snapshot.pid, process.pid);
    assert.equal(snapshot.turns.length > 0, true);
    assert.ok(['prompt_preflight', 'model_request', 'tool_execute', 'idle'].includes(snapshot.phase.name));

    const result = await pending;
    assert.equal(result.scorecard.verdict, 'pass');
    assert.equal(fs.existsSync(snapshotPath), false, 'a finished run must not leave a snapshot behind');
  });
});

test('a failed run removes its live snapshot', async () => {
  await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
    const requestId = 'live-failed-1';
    const snapshotPath = getLiveRunSnapshotPath(requestId, repoRoot);

    await assert.rejects(executeRepoSearchRequest({
      presetId: 'this-preset-does-not-exist',
      requestId,
      prompt: 'find build scripts',
      repoRoot,
      maxTurns: 1,
      mockResponses: ['{"action":"finish","output":"never runs"}'],
    }));

    assert.equal(fs.existsSync(snapshotPath), false);
  });
});

test('the live snapshot is skipped when SIFTKIT_LIVE_SNAPSHOT=0', async () => {
  const previous = process.env.SIFTKIT_LIVE_SNAPSHOT;
  process.env.SIFTKIT_LIVE_SNAPSHOT = '0';
  try {
    await withTestEnvAndServer(async ({ tempRoot: repoRoot }) => {
      const requestId = 'live-disabled-1';
      const snapshotPath = getLiveRunSnapshotPath(requestId, repoRoot);

      const result = await executeRepoSearchRequest({
        presetId: 'repo-search',
        requestId,
        prompt: 'find build scripts',
        repoRoot,
        maxTurns: 2,
        mockResponses: [
          '{"action":"git","command":"git status --short"}',
          '{"action":"finish","output":"Found scripts"}',
        ],
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: '', stderr: '' },
        },
      });

      assert.equal(result.scorecard.verdict, 'pass');
      assert.equal(fs.existsSync(snapshotPath), false);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.SIFTKIT_LIVE_SNAPSHOT;
    } else {
      process.env.SIFTKIT_LIVE_SNAPSHOT = previous;
    }
  }
});
