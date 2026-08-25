import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { CliProgressRenderer } from '../src/cli/progress-renderer.js';
import { buildRepoSearchProgressLogBody, isServerLoggedProgressEvent } from '../src/status-server/dashboard-runs.js';

import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('content alongside a native tool call emits progress and the run continues to finish', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const progressWriter = new CollectingProgressWriter<RepoSearchProgressEvent>();
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      prompt: 'find build scripts',
      repoRoot: tempRoot,
      maxTurns: 2,
      progressWriter,
      mockResponses: [
        {
          content: 'scanning scripts next',
          toolCalls: [{ name: 'git', arguments: { operation: 'status' } }],
        },
        { content: "Found scripts" },
      ],
      mockCommandResults: {
        "git operation=\"status\"": { exitCode: 0, stdout: '', stderr: '' },
      },
    });

    assert.equal(result.scorecard.verdict, 'pass');
    const progressEvents = progressWriter.events.filter((event) => event.kind === 'progress_update');
    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0]?.progressText, 'scanning scripts next');
    assert.equal(progressEvents[0]?.turn, 1);
  });
});

test('cli renderer prints one line per progress_update', () => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback): void {
      lines.push(String(chunk));
      callback();
    },
  });
  const renderer = new CliProgressRenderer(sink, 'rs test');

  renderer.render({ kind: 'progress_update', turn: 12, maxTurns: 100, progressText: 'GREEN: wiring render', elapsedMs: 1000 });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /t12\/100 progress "GREEN: wiring render"/u);
});

test('server log body renders progress_update with turn and text', () => {
  const event: RepoSearchProgressEvent = {
    kind: 'progress_update', taskId: 't1', turn: 12, maxTurns: 100, progressText: 'GREEN: wiring render', elapsedMs: 61_000,
  };
  assert.equal(isServerLoggedProgressEvent(event), true);
  const body = buildRepoSearchProgressLogBody(event);
  assert.equal(body?.event, 'progress');
  assert.match(body?.fields ?? '', /t12\/100 {2}elapsed=/u);
  assert.match(body?.fields ?? '', /"GREEN: wiring render"/u);
});
