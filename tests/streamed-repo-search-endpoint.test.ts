import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { RepoSearchExecutionResultSchema } from '../src/repo-search/types.js';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';

const REPO_SEARCH_BODY = {
  prompt: 'find x',
  model: 'mock-model',
  maxTurns: 2,
  availableModels: ['mock-model'],
  mockResponses: [
    '{"action":"git","command":"git grep -n \\"x\\" src"}',
    '{"action":"finish","output":"done"}',
  ],
  mockCommandResults: {
    'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 400 },
  },
};

test('repo-search streams tool progress then a schema-valid result', async () => {
  const harness = await startHarness('siftkit-streamed-rs-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: { ...REPO_SEARCH_BODY, repoRoot: process.cwd() },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.result, response.rawBody);
    const parsed = RepoSearchExecutionResultSchema.parse(response.result);
    assert.equal(parsed.scorecard.tasks[0]?.finalOutput, 'done');
    const kinds = response.progress.map((event) => String(event.kind || ''));
    assert.ok(kinds.includes('tool_start'), kinds.join(','));
    assert.ok(kinds.includes('tool_result'), kinds.join(','));
    assert.ok(!kinds.includes('thinking'), 'thinking frames must be filtered');
    assert.ok(!kinds.includes('answer'), 'answer frames must be filtered');
  } finally {
    await harness.close();
  }
});

test('queued repo-search sees lock_wait progress while a slow run holds the lock', async () => {
  const harness = await startHarness('siftkit-streamed-rs-lock-');
  try {
    const slowBody = {
      ...REPO_SEARCH_BODY,
      repoRoot: process.cwd(),
      mockCommandResults: {
        'git grep -n "x" src': { exitCode: 0, stdout: 'src/example.ts:1:x', stderr: '', delayMs: 3_000 },
      },
    };
    const holder = requestSse(`${harness.baseUrl}/repo-search`, { body: slowBody, timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const queued = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'queued',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 1,
        availableModels: ['mock-model'],
        mockResponses: ['{"action":"finish","output":"queued done"}'],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    const holderResponse = await holder;
    assert.ok(holderResponse.result);
    assert.ok(queued.result);
    assert.ok(
      queued.progress.some((event) => event.kind === 'lock_wait'),
      'expected lock_wait progress while queued',
    );
  } finally {
    await harness.close();
  }
});

test('client disconnect aborts the run and frees the lock', async () => {
  const harness = await startHarness('siftkit-streamed-rs-abort-');
  try {
    const slowBody = JSON.stringify({
      ...REPO_SEARCH_BODY,
      repoRoot: process.cwd(),
      mockCommandResults: {
        'git grep -n "x" src': { exitCode: 0, stdout: 'x', stderr: '', delayMs: 10_000 },
      },
    });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${harness.baseUrl}/repo-search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(slowBody, 'utf8'),
        },
      }, (response) => {
        response.once('data', () => {
          request.destroy();
          resolve();
        });
      });
      request.on('error', reject);
      request.write(slowBody);
      request.end();
    });
    const startedAt = Date.now();
    const followUp = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'after abort',
        repoRoot: process.cwd(),
        model: 'mock-model',
        maxTurns: 1,
        availableModels: ['mock-model'],
        mockResponses: ['{"action":"finish","output":"after abort done"}'],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(followUp.result, followUp.rawBody);
    assert.ok(Date.now() - startedAt < 8_000, 'lock was not freed by the aborted run');
  } finally {
    await harness.close();
  }
});

test('sanity-check failure surfaces as an error frame', async () => {
  const harness = await startHarness('siftkit-streamed-rs-sanity-');
  try {
    const duplicated = [
      'The first result line contains enough implementation detail to exceed the safety threshold.',
      'The second result line confirms the same repository evidence with a stable conclusion.',
      'Conclusion: the duplicated whole-output block must be rejected before transport.',
    ];
    const terms = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const body = {
      prompt: 'find duplicated response',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 8,
      availableModels: ['mock-model'],
      mockResponses: [
        ...terms.map((term) => JSON.stringify({ action: 'git', command: `git grep -n "${term}" src` })),
        JSON.stringify({ action: 'finish', output: [...duplicated, ...duplicated].join('\n') }),
      ],
      mockCommandResults: Object.fromEntries(terms.map((term, index) => [
        `git grep -n "${term}" src`,
        { exitCode: 0, stdout: `src/${index}.ts:1:${term}`, stderr: '' },
      ])),
    };
    const response = await requestSse(`${harness.baseUrl}/repo-search`, { body, timeoutMs: 20_000 });
    assert.equal(response.result, null);
    assert.match(String(response.errorMessage), /sanity check failed/iu);
  } finally {
    await harness.close();
  }
});
