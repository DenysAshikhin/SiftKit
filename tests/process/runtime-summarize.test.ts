import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommand } from '../helpers/run-command-for-test.js';
import { parseRuntimeArtifactUri, readRuntimeArtifact } from '../../src/state/runtime-artifacts.js';

import {
  withTempEnv,
  withStubServer,
} from '../_runtime-helpers.js';

test('runCommand saves a raw log and respects no-summarize mode when the external server is available', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await runCommand({
        Command: 'node',
        ArgumentList: ['-e', "console.log('stdout line'); console.error('stderr line');"],
        Question: 'what failed?',
        Provider: 'mock',
        NoSummarize: true,
      });

      assert.equal(result.WasSummarized, false);
      assert.ok(result.RawLogPath);
      const artifactId = parseRuntimeArtifactUri(result.RawLogPath);
      assert.ok(artifactId);
      const rawLogArtifact = readRuntimeArtifact(artifactId);
      assert.ok(rawLogArtifact);
      const rawLog = rawLogArtifact.contentText || '';
      assert.match(rawLog, /stdout line/u);
      assert.match(rawLog, /stderr line/u);
    });
  });
});

test('runCommand classifies missing executables as command failures with raw review required', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const result = await runCommand({
        Command: 'definitely-not-a-real-command-siftkit',
        ArgumentList: [],
        Question: 'Summarize the main result and any actionable failures.',
        Provider: 'mock',
      });

      assert.equal(result.WasSummarized, true);
      assert.equal(result.PolicyDecision, 'model-command-failure');
      assert.equal(result.Classification, 'command_failure');
      assert.equal(result.RawReviewRequired, true);
      assert.equal(result.ModelCallSucceeded, true);
      assert.ok(result.Summary !== null);
      assert.match(result.Summary, /command failed before producing a usable result/i);
    });
  });
});
