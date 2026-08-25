import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { SseFrameParser } from '../src/lib/sse-frame-parser.js';
import { asObject } from './helpers/dashboard-http.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { RepoSearchExecutionResultSchema } from '../src/repo-search/types.js';
import { testHttpAgent } from './helpers/http-agent.js';

function postJson(url: string, body: JsonSerializable): Promise<{ statusCode: number; body: JsonObject }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
      agent: testHttpAgent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text, 'utf8') },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { raw += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body: asObject(parseJsonValueText(raw || '{}')) }));
    });
    request.on('error', reject);
    request.write(text);
    request.end();
  });
}

function disconnectAtApproval(
  url: string,
  body: JsonSerializable,
): Promise<{ requestId: string; approvalId: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const parser = new SseFrameParser();
    let disconnected = false;
    const request = http.request(url, {
      method: 'POST',
      agent: testHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text, 'utf8'),
      },
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        for (const frame of parser.push(chunk)) {
          if (frame.event !== 'progress') continue;
          const event = asObject(parseJsonValueText(frame.data));
          if (event.kind !== 'approval_request') continue;
          disconnected = true;
          request.destroy();
          resolve({
            requestId: String(event.requestId),
            approvalId: String(event.approvalId),
          });
          return;
        }
      });
    });
    request.on('error', (error) => {
      if (!disconnected) reject(error);
    });
    request.write(text);
    request.end();
  });
}

async function waitForApprovalRegistryRemoval(
  baseUrl: string,
  requestId: string,
  approvalId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const stale = await postJson(`${baseUrl}/repo-search/approval`, {
      requestId,
      approvalId: `${approvalId}-stale`,
      decision: 'approve',
    });
    if (stale.statusCode === 404) return;
    assert.equal(stale.statusCode, 409);
    if (Date.now() >= deadline) assert.fail('approval registry was not removed');
    await delay(10);
  }
}

test('default repo-search uses git without approval or repo-agent run control', async (t) => {
  const harness = await startHarness('siftkit-default-search-isolation-', t);
  const runRoot = path.join(
    process.cwd(),
    '.siftkit',
    'repo-agent',
    'runs',
  );
  const response = await requestSse(`${harness.baseUrl}/repo-search`, {
    body: {
      prompt: 'inspect status',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 2,
      availableModels: ['mock-model'],
      mockResponses: [
        { toolCalls: [{ name: "git", arguments: {"operation":"status"} }] },
        { content: "done" },
      ],
      mockCommandResults: {
        "git operation=\"status\"": {
          exitCode: 0,
          stdout: ' M src/example.ts',
          stderr: '',
        },
      },
    },
    timeoutMs: 20_000,
  });

  assert.ok(response.result, response.rawBody);
  const result = RepoSearchExecutionResultSchema.parse(response.result);
  assert.equal(result.scorecard.tasks[0]?.finalOutput, 'done');
  assert.equal(
    response.progress.filter((event) => event.kind === 'approval_request').length,
    0,
  );
  assert.equal(
    response.progress.filter((event) => event.kind === 'approval_auto').length,
    0,
  );
  assert.equal(fs.existsSync(runRoot), false);
});

test('interactive write run: approval_request precedes execution; approve completes it', async (t) => {
  const harness = await startHarness('siftkit-interactive-approve-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-search`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      interactive: true,
      availableModels: ['mock-model'],
      mockResponses: [
        { toolCalls: [{ name: "write", arguments: {"path":"interactive-out.txt","content":"approved"} }] },
        { content: "wrote it" },
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
    onProgress: async (event) => {
      if (event.kind !== 'approval_request') return;
      const submitted = await postJson(`${harness.baseUrl}/repo-search/approval`, {
        requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'approve',
      });
      assert.equal(submitted.statusCode, 200);
      assert.equal(submitted.body.accepted, true);
    },
  });
  assert.ok(response.result, response.rawBody);
  const written = path.join(process.cwd(), 'interactive-out.txt');
  assert.equal(fs.readFileSync(written, 'utf8'), 'approved');
  fs.rmSync(written, { force: true });
  const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
  assert.equal(approvalFrames.length, 1);
  assert.equal(approvalFrames[0].toolName, 'write');
});

test('interactive deny: reason reaches the transcript; abort ends with error frame', async (t) => {
  const harness = await startHarness('siftkit-interactive-deny-', t);
  const denyResponse = await requestSse(`${harness.baseUrl}/repo-search`, {
    body: {
      prompt: 'write then stop', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      interactive: true,
      availableModels: ['mock-model'],
      mockResponses: [
        { toolCalls: [{ name: "write", arguments: {"path":"never.txt","content":"never"} }] },
        { content: "gave up" },
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
    onProgress: async (event) => {
      if (event.kind !== 'approval_request') return;
      await postJson(`${harness.baseUrl}/repo-search/approval`, {
        requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'deny', reason: 'wrong path',
      });
    },
  });
  assert.ok(denyResponse.result);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'never.txt')), false);

  const abortResponse = await requestSse(`${harness.baseUrl}/repo-search`, {
    body: {
      prompt: 'abort me', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      interactive: true,
      availableModels: ['mock-model'],
      mockResponses: [{ toolCalls: [{ name: "ls", arguments: {} }] }, { content: "unreachable" }],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
    onProgress: async (event) => {
      if (event.kind !== 'approval_request') return;
      await postJson(`${harness.baseUrl}/repo-search/approval`, {
        requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'abort',
      });
    },
  });
  assert.equal(abortResponse.result, null);
  assert.match(String(abortResponse.errorMessage), /Aborted by user\./u);
});

test('approval endpoint returns 404 for unknown and disconnected runs', async (t) => {
  const harness = await startHarness('siftkit-interactive-edge-', t);
  const notFound = await postJson(`${harness.baseUrl}/repo-search/approval`, {
    requestId: 'missing', approvalId: 'x', decision: 'approve',
  });
  assert.equal(notFound.statusCode, 404);

  const pending = await disconnectAtApproval(`${harness.baseUrl}/repo-search`, {
    prompt: 'disconnect at approval',
    repoRoot: process.cwd(),
    model: 'mock-model',
    maxTurns: 2,
    interactive: true,
    availableModels: ['mock-model'],
    mockResponses: [{ toolCalls: [{ name: "ls", arguments: {} }] }, { content: "unreachable" }],
    mockCommandResults: {},
  });
  await waitForApprovalRegistryRemoval(
    harness.baseUrl,
    pending.requestId,
    pending.approvalId,
  );

  const followUp = await requestSse(`${harness.baseUrl}/repo-search`, {
    body: {
      prompt: 'after disconnect',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 1,
      availableModels: ['mock-model'],
      mockResponses: [{ content: "after disconnect done" }],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  assert.ok(followUp.result, followUp.rawBody);
});

test('non-interactive body cannot smuggle mutating tools via allowedTools', async (t) => {
  const harness = await startHarness('siftkit-interactive-guard-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-search`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      allowedTools: ['read', 'write', 'run'],
      availableModels: ['mock-model'],
      mockResponses: [
        { toolCalls: [{ name: "write", arguments: {"path":"smuggled.txt","content":"nope"} }] },
        { content: "done" },
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  assert.ok(response.result);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'smuggled.txt')), false);
});
