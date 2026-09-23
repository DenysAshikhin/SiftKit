import test from 'node:test';
import assert from 'node:assert/strict';

import { ActiveStatusRunSchema } from '@siftkit/contracts';
import { z } from '../../src/lib/zod.js';
import type { JsonValue } from '../../src/lib/json-types.js';
import {
  fs,
  path,
  spawnProcess,
  requestJson,
  sleep,
  postStatusComplete,
  withTempEnv,
  withSummaryTestServer,
} from '../_runtime-helpers.js';

const repoRoot = process.cwd();

const ConcurrentStatusResponseSchema = z.object({
  activeRuns: z.array(ActiveStatusRunSchema).optional(),
}).loose();

test('concurrent oversized CLI summary requests are serialized until the first request fully completes', async () => {
  await withTempEnv(async (tempRoot) => {
    await withSummaryTestServer(async (server) => {
      process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR = 'recursive-merge';
      process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS = '100';
      const logPath = path.join(tempRoot, 'provider-events-concurrent.jsonl');
      process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH = logPath;

      const firstInputPath = path.join(tempRoot, 'oversized-a.txt');
      const secondInputPath = path.join(tempRoot, 'oversized-b.txt');
      fs.writeFileSync(firstInputPath, 'A'.repeat(300_001), 'utf8');
      fs.writeFileSync(secondInputPath, 'B'.repeat(300_001), 'utf8');

      const cliPath = path.join(repoRoot, 'dist', 'cli', 'main.js');
      const childEnv = {
        ...process.env,
        SIFTKIT_TEST_PROVIDER: 'mock',
        SIFTKIT_TEST_PROVIDER_BEHAVIOR: 'recursive-merge',
        SIFTKIT_TEST_PROVIDER_SLEEP_MS: '100',
        SIFTKIT_TEST_PROVIDER_LOG_PATH: logPath,
      };

      const firstProcess = spawnProcess(process.execPath, [
          cliPath,
          'summary',
          '--question',
          'summarize oversized request A',
          '--file',
          firstInputPath,
          '--provider',
          'mock',
          '--model',
          'mock-model',
        ], {
          cwd: process.cwd(),
          env: childEnv,
        });
      const secondProcess = spawnProcess(process.execPath, [
          cliPath,
          'summary',
          '--question',
          'summarize oversized request B',
          '--file',
          secondInputPath,
          '--provider',
          'mock',
          '--model',
          'mock-model',
        ], {
          cwd: process.cwd(),
          env: childEnv,
        });

      const summaryRequestIds = new Set<string>();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const status = ConcurrentStatusResponseSchema.parse(await requestJson(server.statusUrl));
        if (status.activeRuns) {
          for (const run of status.activeRuns) {
            if (run.taskKind === 'summary') summaryRequestIds.add(run.requestId);
          }
        }
        if (server.state) {
          for (const post of server.state.statusPosts) {
            if (post.running === true && post.taskKind === 'summary' && typeof post.requestId === 'string') {
              summaryRequestIds.add(post.requestId);
            }
          }
        }
        if (summaryRequestIds.size >= 2) break;
        await sleep(10);
      }
      assert.equal(summaryRequestIds.size, 2);

      const dashboardRequestId = 'dashboard-concurrent-status';
      await requestJson(server.statusUrl, {
        method: 'POST',
        body: JSON.stringify({
          running: true,
          requestId: dashboardRequestId,
          taskKind: 'chat',
          rawInputCharacterCount: 1,
          promptCharacterCount: 1,
          promptTokenCount: 1,
        }),
      });
      const overlappingRequestIds = new Set(summaryRequestIds);
      const overlapStatus = ConcurrentStatusResponseSchema.parse(await requestJson(server.statusUrl));
      if (overlapStatus.activeRuns) {
        for (const run of overlapStatus.activeRuns) overlappingRequestIds.add(run.requestId);
      }
      if (server.state) {
        for (const post of server.state.statusPosts) {
          if (post.running === true && typeof post.requestId === 'string') overlappingRequestIds.add(post.requestId);
        }
      }
      assert.equal(overlappingRequestIds.has(dashboardRequestId), true);
      assert.equal(overlappingRequestIds.size, 3);
      await postStatusComplete(server.statusUrl, {
        requestId: dashboardRequestId,
        terminalState: 'completed',
      });

      const [firstResult, secondResult] = await Promise.all([firstProcess, secondProcess]);

      const events = fs.readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
      const questions = events.map((event) => event.question);
      const firstQuestion = 'summarize oversized request A';
      const secondQuestion = 'summarize oversized request B';
      const referencesFirstRequest = (question: JsonValue) => String(question).includes(firstQuestion);
      const referencesSecondRequest = (question: JsonValue) => String(question).includes(secondQuestion);
      const transitions = questions.filter((question, index) => index === 0 || question !== questions[index - 1]);

      assert.equal(firstResult.code, 0);
      assert.equal(secondResult.code, 0);
      assert.match(firstResult.stdout, /merge summary/u);
      assert.match(secondResult.stdout, /merge summary/u);
      assert.equal(firstResult.stderr, '');
      assert.equal(secondResult.stderr, '');
      assert.equal(questions.some(referencesFirstRequest), true);
      assert.equal(questions.some(referencesSecondRequest), true);
      assert.equal(transitions.length <= 2, true);
      assert.equal(transitions.every((question) => referencesFirstRequest(question) || referencesSecondRequest(question)), true);
    }, {
      running: false,
    });
  });
});
