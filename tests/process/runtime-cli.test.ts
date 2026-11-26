import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { ActiveStatusRunSchema } from '@siftkit/contracts';
import { z } from '../../src/lib/zod.ts';
import type { JsonValue } from '../../src/lib/json-types.ts';
import {
  fs,
  path,
  spawnProcess,
  requestJson,
  sleep,
  postStatusComplete,
  withTempEnv,
  withSummaryTestServer,
} from '../_runtime-helpers.ts';

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

      const cliPath = path.join(repoRoot, 'src', 'cli', 'main.ts');
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

test('non-interactive internal op with an idle stdin pipe exits instead of hanging', async () => {
  const cliPath = path.join(repoRoot, 'src', 'cli', 'main.ts');
  // child.stdin stays an open pipe nothing writes to or ends: the original hang case.
  const child = spawn(process.execPath, [cliPath, 'internal', '--op', 'summary'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderrText = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString();
  });
  child.stdout.resume();
  let timer: NodeJS.Timeout | undefined;
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => { resolve(code); });
  });
  try {
    // The red run hangs on the idle pipe, so bound the wait and fail loudly on the kill.
    const outcome = await Promise.race([
      exitPromise.then((code) => ({ kind: 'exited' as const, code })),
      new Promise<{ kind: 'timed-out' }>((resolve) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ kind: 'timed-out' });
        }, 15_000);
      }),
    ]);
    assert.equal(outcome.kind, 'exited', 'siftkit internal hung on an idle stdin pipe');
    if (outcome.kind === 'exited') {
      assert.equal(outcome.code, 1);
      assert.match(stderrText, /--request-file is required/u);
    }
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
