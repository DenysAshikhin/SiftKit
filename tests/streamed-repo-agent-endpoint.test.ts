import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { requestSse } from './helpers/sse-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { RepoSearchExecutionResultSchema } from '../src/repo-search/types.js';
import { ActivitySummaryProgressEventSchema } from '../src/repo-search/engine/activity-summary-collector.js';
import { asObject } from './helpers/dashboard-http.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
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

test('POST /repo-agent (approval on): approves a write via the shared /repo-search/approval endpoint', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-approve-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'interactive',
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
});

test('POST /repo-agent (approval on): a denied write never runs and the run continues', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-deny-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'interactive',
      availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"denied.txt","content":"should never land"}',
        '{"action":"finish","output":"gave up"}',
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
    onProgress: async (event) => {
      if (event.kind !== 'approval_request') return;
      const submitted = await postJson(`${harness.baseUrl}/repo-search/approval`, {
        requestId: String(event.requestId), approvalId: String(event.approvalId),
        decision: 'deny', reason: 'out of scope',
      });
      assert.equal(submitted.statusCode, 200);
    },
  });
  assert.ok(response.result, response.rawBody);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'denied.txt')), false);
  // A denial is not a failure: the model is told why and the run finishes normally.
  const parsed = RepoSearchExecutionResultSchema.parse(response.result);
  assert.equal(parsed.scorecard.tasks[0]?.finalOutput, 'gave up');
});

test('POST /repo-agent (approval on): an aborted write ends the run with an error', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-abort-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'interactive',
      availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"aborted.txt","content":"should never land"}',
        '{"action":"finish","output":"unreachable"}',
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
    onProgress: async (event) => {
      if (event.kind !== 'approval_request') return;
      const submitted = await postJson(`${harness.baseUrl}/repo-search/approval`, {
        requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'abort',
      });
      assert.equal(submitted.statusCode, 200);
    },
  });
  assert.equal(response.result, null, response.rawBody);
  assert.match(String(response.errorMessage), /Aborted by user/u);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'aborted.txt')), false);
});

// Ten turns of `read`, which is approval-exempt, so this proves the summary and nothing else.
// Routing it through an approval-requiring tool would make every turn depend on the reviewer and
// burn two extra mock responses per turn on verdict attempts.
test('POST /repo-agent emits activity_summary after ten tool turns', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-activity-', t);
  const mockResponses: string[] = [];
  const readPaths: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const readPath = `src${i}.ts`;
    readPaths.push(readPath);
    fs.writeFileSync(path.join(process.cwd(), readPath), `export const marker${i} = ${i};\n`, 'utf8');
    mockResponses.push(`{"action":"read","path":"${readPath}"}`);
  }
  mockResponses.push('{"action":"finish","output":"done"}');
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'find x',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 12,
      availableModels: ['mock-model'],
      mockResponses,
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  assert.equal(response.statusCode, 200);
  assert.ok(response.result, response.rawBody);
  const summaryEvents = response.progress.filter((event) => event.kind === 'activity_summary');
  assert.equal(summaryEvents.length, 1);
  const summary = ActivitySummaryProgressEventSchema.parse(summaryEvents[0]);
  assert.equal(summary.turn, 10);
  assert.equal(summary.maxTurns, 12);
  assert.deepEqual(
    summary.entries,
    readPaths.map((readPath) => ({ category: 'read_files', label: readPath, failed: false })),
  );
});

test('POST /repo-agent defaults omitted approval to auto review', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-default-auto-', t);
  const written = path.join(process.cwd(), 'default-auto.txt');
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 4,
      availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"default-auto.txt","content":"safe"}',
        '{"verdict":"approve","reason":"task-scoped write"}',
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
    onProgress: async (event) => {
      if (event.kind !== 'approval_request') {
        return;
      }
      await postJson(`${harness.baseUrl}/repo-search/approval`, {
        requestId: String(event.requestId),
        approvalId: String(event.approvalId),
        decision: 'abort',
      });
      assert.fail('Omitted repo-agent approval unexpectedly required manual review.');
    },
  });
  assert.ok(response.result, response.rawBody);
  assert.equal(fs.readFileSync(written, 'utf8'), 'safe');
  assert.equal(
    response.progress.filter((event) => event.kind === 'approval_request').length,
    0,
  );
  const autoFrames = response.progress.filter(
    (event) => event.kind === 'approval_auto',
  );
  assert.equal(autoFrames.length, 1);
  assert.equal(autoFrames[0].verdict, 'approve');
  fs.rmSync(written, { force: true });
});

test('POST /repo-agent with approval:"off" runs autonomously with no approval frames', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-auto-', t);
  const written = path.join(process.cwd(), 'agent-endpoint-auto.txt');
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'off',
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
});

test('POST /repo-agent with approval:"auto": reviewer approves; no approval_request frames', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-llm-auto-', t);
  const written = path.join(process.cwd(), 'agent-endpoint-llm-auto.txt');
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'auto',
      availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"agent-endpoint-llm-auto.txt","content":"auto"}',
        '{"verdict":"approve","reason":"task-scoped write"}',
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
  const autoFrames = response.progress.filter((event) => event.kind === 'approval_auto');
  assert.equal(autoFrames.length, 1);
  assert.equal(autoFrames[0].verdict, 'approve');
});

test('POST /repo-agent: read-only tools execute without approval frames', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-ro-bypass-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'inspect files', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 8,
      availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"read","path":"package.json","offset":1,"limit":2}',
        '{"action":"grep","pattern":"\\"name\\"","path":"package.json","literal":true,"limit":2}',
        '{"action":"find","pattern":"package.json","path":".","limit":2}',
        '{"action":"ls","path":".","limit":2}',
        '{"action":"finish","output":"inspected"}',
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
    onProgress: async (event) => {
      if (event.kind !== 'approval_request') return;
      await postJson(`${harness.baseUrl}/repo-search/approval`, {
        requestId: String(event.requestId), approvalId: String(event.approvalId), decision: 'approve',
      });
    },
  });
  assert.ok(response.result, response.rawBody);
  const parsed = RepoSearchExecutionResultSchema.parse(response.result);
  assert.equal(parsed.scorecard.tasks[0]?.finalOutput, 'inspected');
  const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
  assert.equal(approvalFrames.length, 0);
});

test('POST /repo-agent with a boolean approval value fails loudly', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-bool-approval-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: false,
      availableModels: ['mock-model'],
      mockResponses: ['{"action":"finish","output":"unreachable"}'],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  assert.equal(response.result, null);
  assert.match(String(response.errorMessage), /approval must be one of: interactive, auto, off/u);
});
