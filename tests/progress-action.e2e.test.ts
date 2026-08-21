import test from 'node:test';
import assert from 'node:assert/strict';

import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('a progress action emits a progress_update event and the run continues to finish', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const progressWriter = new CollectingProgressWriter<RepoSearchProgressEvent>();
    const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
      prompt: 'find build scripts',
      repoRoot: tempRoot,
      maxTurns: 3,
      progressWriter,
      mockResponses: [
        '{"action":"progress","output":"scanning scripts next"}',
        '{"action":"git","command":"git status --short"}',
        '{"action":"finish","output":"Found scripts"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '' },
      },
    });

    assert.equal(result.scorecard.verdict, 'pass');
    const progressEvents = progressWriter.events.filter((event) => event.kind === 'progress_update');
    assert.equal(progressEvents.length, 1);
    assert.equal(progressEvents[0]?.progressText, 'scanning scripts next');
    assert.equal(progressEvents[0]?.turn, 1);
  });
});
