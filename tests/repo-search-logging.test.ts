import test from 'node:test';
import assert from 'node:assert/strict';

import { createJsonLogger, resolveRepoSearchLogUri } from '../dist/repo-search/logging.js';
import {
  listRuntimeArtifacts,
  parseRuntimeArtifactUri,
  readRuntimeArtifact,
} from '../dist/state/runtime-artifacts.js';
import { withTestEnvAndServer } from './_test-helpers.js';

test('createJsonLogger buffers transcript events until persist', async () => {
  await withTestEnvAndServer(async () => {
    const logger = createJsonLogger('db://repo-search/request_buffered.jsonl');
    logger.write({ kind: 'first' });
    logger.write({ kind: 'second' });

    assert.equal(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length, 0);

    const transcriptPath = 'db://repo-search/successful/request_buffered.jsonl';
    const transcriptUri = logger.persist(transcriptPath, 'request-buffered');
    const transcriptId = parseRuntimeArtifactUri(transcriptUri);
    assert.ok(transcriptId);
    assert.equal(resolveRepoSearchLogUri(transcriptPath), transcriptUri);

    const artifact = readRuntimeArtifact(transcriptId);
    assert.equal(artifact?.requestId, 'request-buffered');
    assert.equal(artifact?.title, transcriptPath);
    assert.equal(artifact?.contentText, logger.getText());

    const lines = String(artifact?.contentText || '').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] || '{}').kind, 'first');
    assert.equal(JSON.parse(lines[1] || '{}').kind, 'second');
  });
});

test('createJsonLogger persist overwrites the same transcript artifact without duplicating prior content', async () => {
  await withTestEnvAndServer(async () => {
    const logger = createJsonLogger('db://repo-search/request_repeat.jsonl');
    const transcriptPath = 'db://repo-search/successful/request_repeat.jsonl';

    logger.write({ kind: 'first' });
    const firstUri = logger.persist(transcriptPath, 'request-repeat');

    logger.write({ kind: 'second' });
    const secondUri = logger.persist(transcriptPath, 'request-repeat');

    assert.equal(secondUri, firstUri);

    const transcriptId = parseRuntimeArtifactUri(secondUri);
    assert.ok(transcriptId);
    const artifact = readRuntimeArtifact(transcriptId);
    const lines = String(artifact?.contentText || '').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] || '{}').kind, 'first');
    assert.equal(JSON.parse(lines[1] || '{}').kind, 'second');
  });
});
