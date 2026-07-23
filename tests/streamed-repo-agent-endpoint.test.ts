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

test('POST /repo-agent (approval on): approves a write via the shared /repo-search/approval endpoint', async () => {
  const harness = await startHarness('siftkit-repo-agent-approve-');
  try {
    const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"agent-endpoint-out.txt","content":"approved"}',
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
      },
    });
    assert.ok(response.result, response.rawBody);
    const written = path.join(process.cwd(), 'agent-endpoint-out.txt');
    assert.equal(fs.readFileSync(written, 'utf8'), 'approved');
    fs.rmSync(written, { force: true });
    const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
    assert.equal(approvalFrames.length, 1);
    assert.equal(approvalFrames[0].toolName, 'write');
  } finally {
    await harness.close();
  }
});

test('POST /repo-agent with approval:false runs autonomously with no approval frames', async () => {
  const harness = await startHarness('siftkit-repo-agent-auto-');
  try {
    const written = path.join(process.cwd(), 'agent-endpoint-auto.txt');
    const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
      body: {
        prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
        approval: false,
        availableModels: ['mock-model'],
        mockResponses: [
          '{"action":"write","path":"agent-endpoint-auto.txt","content":"auto"}',
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      },
      timeoutMs: 20_000,
    });
    assert.ok(response.result, response.rawBody);
    assert.equal(fs.readFileSync(written, 'utf8'), 'auto');
    fs.rmSync(written, { force: true });
    assert.equal(response.progress.filter((event) => event.kind === 'approval_request').length, 0);
  } finally {
    await harness.close();
  }
});
