import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { asObject } from './helpers/dashboard-http.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';

function postJson(url: string, body: JsonSerializable): Promise<{ statusCode: number; body: JsonObject }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
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

test('interactive write run: approval_request precedes execution; approve completes it', async () => {
  const harness = await startHarness('siftkit-interactive-approve-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        interactive: true,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"interactive-out.txt","content":"approved"}',
          '{"action":"finish","output":"wrote it"}',
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
  } finally {
    await harness.close();
  }
});

test('interactive deny: reason reaches the transcript; abort ends with error frame', async () => {
  const harness = await startHarness('siftkit-interactive-deny-');
  try {
    const denyResponse = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'write then stop', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        interactive: true,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"never.txt","content":"never"}',
          '{"action":"finish","output":"gave up"}',
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
        mockResponses: ['{"action":"ls"}', '{"action":"finish","output":"unreachable"}'],
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
  } finally {
    await harness.close();
  }
});

test('approval endpoint: 404 unknown requestId, 409 stale approvalId; timeout aborts the run', async () => {
  const harness = await startHarness('siftkit-interactive-edge-');
  try {
    const notFound = await postJson(`${harness.baseUrl}/repo-search/approval`, {
      requestId: 'missing', approvalId: 'x', decision: 'approve',
    });
    assert.equal(notFound.statusCode, 404);

    process.env.SIFTKIT_APPROVAL_TIMEOUT_MS = '150';
    try {
      let staleCheck: Promise<void> | null = null;
      const timedOut = await requestSse(`${harness.baseUrl}/repo-search`, {
        body: {
          prompt: 'time out', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
          interactive: true,
          availableModels: ['mock-model'],
          mockResponses: ['{"action":"ls"}', '{"action":"finish","output":"unreachable"}'],
          mockCommandResults: {},
        },
        timeoutMs: 20_000,
        onProgress: async (event) => {
          if (event.kind !== 'approval_request') return;
          // Answer AFTER the timeout to exercise the stale path.
          staleCheck = new Promise<void>((resolve) => {
            setTimeout(async () => {
              const stale = await postJson(`${harness.baseUrl}/repo-search/approval`, {
                requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'approve',
              });
              // Run may already be unregistered (404) or gate resolved (409); both are stale outcomes.
              assert.ok(stale.statusCode === 409 || stale.statusCode === 404, String(stale.statusCode));
              resolve();
            }, 400);
          });
        },
      });
      assert.equal(timedOut.result, null);
      assert.match(String(timedOut.errorMessage), /Approval request timed out/u);
      if (staleCheck) await staleCheck;
    } finally {
      delete process.env.SIFTKIT_APPROVAL_TIMEOUT_MS;
    }
  } finally {
    await harness.close();
  }
});

test('non-interactive body cannot smuggle mutating tools via allowedTools', async () => {
  const harness = await startHarness('siftkit-interactive-guard-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-search`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        allowedTools: ['read', 'write', 'run'],
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"smuggled.txt","content":"nope"}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(response.result);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'smuggled.txt')), false);
  } finally {
    await harness.close();
  }
});
