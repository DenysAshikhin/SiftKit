import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { requestSse } from './helpers/sse-http.js';
import { startHarness, waitForActiveModelRequestOwner } from './helpers/streamed-op-harness.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { AGENT_RUN_ID_HEADER } from '../src/lib/agent-run-marker.js';
import {
  RepoAgentRunRequestSchema,
  RepoAgentRunResultSchema,
  RepoAgentRunStateSchema,
} from '../src/repo-agent/run-schemas.js';
import { RepoAgentRunStore } from '../src/repo-agent/run-store.js';
import { ActivitySummaryProgressEventSchema } from '../src/repo-search/engine/activity-summary-collector.js';
import { asObject } from './helpers/dashboard-http.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { testHttpAgent } from './helpers/http-agent.js';
import { requestJson } from './helpers/dashboard-http.js';
import { repoAgentFinishResponses } from './helpers/repo-agent-mock-responses.js';

const NON_VERDICT_RESPONSE = '{"action":"git","command":"git grep -n \\"x\\" src2"}';

function runsRoot(): string {
  return path.join(process.cwd(), '.siftkit', 'repo-agent', 'runs');
}

function postJson(
  url: string,
  body: JsonSerializable,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: JsonObject }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
      agent: testHttpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(text, 'utf8'),
        ...headers,
      },
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
        ...repoAgentFinishResponses('wrote it'),
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
  const result = RepoAgentRunResultSchema.parse(response.result);
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    assert.match(result.output, /wrote it/u);
  }
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
        ...repoAgentFinishResponses('gave up'),
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
  const parsed = RepoAgentRunResultSchema.parse(response.result);
  assert.equal(parsed.status, 'completed');
  if (parsed.status === 'completed') {
    assert.match(parsed.output, /gave up/u);
  }
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
  assert.ok(response.result, response.rawBody);
  assert.equal(RepoAgentRunResultSchema.parse(response.result).status, 'aborted');
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
  mockResponses.push(...repoAgentFinishResponses('done'));
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
        ...repoAgentFinishResponses('done'),
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
        ...repoAgentFinishResponses('done'),
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
        ...repoAgentFinishResponses('done'),
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
        ...repoAgentFinishResponses('inspected'),
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
  const parsed = RepoAgentRunResultSchema.parse(response.result);
  assert.equal(parsed.status, 'completed');
  if (parsed.status === 'completed') {
    assert.match(parsed.output, /inspected/u);
  }
  const approvalFrames = response.progress.filter((event) => event.kind === 'approval_request');
  assert.equal(approvalFrames.length, 0);
  // The server log line is built from this stream, so a read-only run must not put one there.
  assert.equal(response.progress.filter((event) => event.kind === 'approval_auto').length, 0);
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
  assert.equal(response.statusCode, 400);
  assert.equal(response.result, null);
  assert.match(response.rawBody, /approval must be one of: interactive, auto, off/u);
});

test('POST /repo-agent rejects non-string model inventory entries instead of coercing them', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-invalid-models-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'finish',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 1,
      approval: 'off',
      availableModels: [42, 'mock-model'],
      mockResponses: ['{"action":"finish","output":"must not run"}'],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.result, null);
});

test('POST /repo-agent rejects zero maxTurns', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-zero-max-turns-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'finish',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: 0,
      approval: 'off',
      availableModels: ['mock-model'],
      mockResponses: ['{"action":"finish","output":"must not run"}'],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.result, null);
});

test('POST /repo-agent rejects null maxTurns', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-null-max-turns-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'finish',
      repoRoot: process.cwd(),
      model: 'mock-model',
      maxTurns: null,
      approval: 'off',
      availableModels: ['mock-model'],
      mockResponses: ['{"action":"finish","output":"must not run"}'],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.result, null);
});

test('POST /repo-agent/decide rejects reasons for approve and abort', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-invalid-decide-', t);
  for (const decision of ['approve', 'abort'] as const) {
    const response = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
      body: { runId: randomUUID(), decision, reason: 'not applicable' },
      timeoutMs: 10_000,
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.result, null);
  }
});

test('POST /repo-agent (auto): an escalated approval parks the run and ends the stream with approval_required', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-park-', t);
  const response = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'auto', availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"parked.txt","content":"needs approval"}',
        NON_VERDICT_RESPONSE,
        NON_VERDICT_RESPONSE,
        ...repoAgentFinishResponses('done after approval'),
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  const boundary = RepoAgentRunResultSchema.parse(response.result);
  assert.equal(boundary.status, 'approval_required');
  if (boundary.status !== 'approval_required') return;
  assert.equal(boundary.approval.toolName, 'write');
  assert.match(boundary.decide.approve, new RegExp(`decide ${boundary.runId} approve`, 'u'));
  assert.equal(response.progress.some((event) => event.kind === 'approval_request'), false);
  const state = RepoAgentRunStateSchema.parse(
    parseJsonValueText(fs.readFileSync(path.join(runsRoot(), boundary.runId, 'state.json'), 'utf8')),
  );
  assert.equal(state.status, 'approval_required');
  const decideResponse = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: boundary.runId, decision: 'approve' },
    timeoutMs: 20_000,
  });
  const final = RepoAgentRunResultSchema.parse(decideResponse.result);
  assert.equal(final.status, 'completed');
  if (final.status === 'completed') {
    assert.match(final.output, /done after approval/u);
  }
  assert.equal(fs.readFileSync(path.join(process.cwd(), 'parked.txt'), 'utf8'), 'needs approval');
  fs.rmSync(path.join(process.cwd(), 'parked.txt'), { force: true });
});

test('POST /repo-agent rejects a nested self-call owned by the active run', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-self-call-', t);
  const parkedResponse = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'auto', availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"self-call.txt","content":"approved later"}',
        NON_VERDICT_RESPONSE,
        NON_VERDICT_RESPONSE,
        ...repoAgentFinishResponses('done after approval'),
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  const boundary = RepoAgentRunResultSchema.parse(parkedResponse.result);
  assert.equal(boundary.status, 'approval_required');
  if (boundary.status !== 'approval_required') return;
  assert.equal(await waitForActiveModelRequestOwner(harness.baseUrl), boundary.runId);

  const rejected = await postJson(
    `${harness.baseUrl}/repo-agent`,
    { prompt: 'nested request' },
    { [AGENT_RUN_ID_HEADER]: boundary.runId },
  );
  assert.equal(rejected.statusCode, 409);
  assert.match(String(rejected.body.error), /would deadlock behind its own run/u);
  assert.equal(asObject(rejected.body.modelRequests).activeCount, 1);

  const completed = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: boundary.runId, decision: 'approve' },
    timeoutMs: 20_000,
  });
  assert.equal(RepoAgentRunResultSchema.parse(completed.result).status, 'completed');
  fs.rmSync(path.join(process.cwd(), 'self-call.txt'), { force: true });
});

test('POST /repo-agent: a client disconnect does not abort the run; it still parks', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-detach-', t);
  const body = JSON.stringify({
    prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
    approval: 'auto', availableModels: ['mock-model'],
    mockResponses: [
      '{"action":"write","path":"detached.txt","content":"still parked"}',
      NON_VERDICT_RESPONSE,
      NON_VERDICT_RESPONSE,
      ...repoAgentFinishResponses('finished later'),
    ],
    mockCommandResults: {},
  });
  await new Promise<void>((resolve, reject) => {
    const request = http.request(`${harness.baseUrl}/repo-agent`, {
      method: 'POST',
      agent: testHttpAgent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
    }, (response) => {
      response.once('data', () => {
        request.destroy();
        resolve();
      });
      response.on('error', () => {});
    });
    request.on('error', (error: Error & { code?: string }) => {
      if (error.message.includes('destroyed') || error.code === 'ECONNRESET') return;
      reject(error);
    });
    request.write(body);
    request.end();
  });
  const deadline = Date.now() + 15_000;
  let parkedRunId = '';
  while (Date.now() < deadline && !parkedRunId) {
    const entries = fs.existsSync(runsRoot()) ? fs.readdirSync(runsRoot()) : [];
    for (const entry of entries) {
      const statePath = path.join(runsRoot(), entry, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      const state = RepoAgentRunStateSchema.parse(parseJsonValueText(fs.readFileSync(statePath, 'utf8')));
      if (state.status === 'approval_required') parkedRunId = state.runId;
    }
    if (!parkedRunId) await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  assert.ok(parkedRunId, 'run never parked after client disconnect');
  const decideResponse = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: parkedRunId, decision: 'approve' },
    timeoutMs: 20_000,
  });
  assert.equal(RepoAgentRunResultSchema.parse(decideResponse.result).status, 'completed');
  fs.rmSync(path.join(process.cwd(), 'detached.txt'), { force: true });
});

test('POST /repo-agent/decide: unknown run 404s; a session-less active run fails loudly as not resumable', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-resume-', t);
  const missing = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: randomUUID(), decision: 'approve' }, timeoutMs: 10_000,
  });
  assert.equal(missing.statusCode, 404);
  const runId = randomUUID();
  const store = new RepoAgentRunStore(runsRoot());
  store.create(RepoAgentRunRequestSchema.parse({
    runId, task: 'orphaned task', repoRoot: process.cwd(), approval: 'auto', images: [],
  }));
  const orphaned = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId, decision: 'approve' }, timeoutMs: 10_000,
  });
  const result = RepoAgentRunResultSchema.parse(orphaned.result);
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.match(result.error, /not resumable/u);
  }
});

test('GET /repo-agent/status reports corrupt state as 500 and absent state as 404', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-status-errors-', t);
  const invalid = await requestJson(`${harness.baseUrl}/repo-agent/status?runId=not-a-uuid`);
  assert.equal(invalid.statusCode, 400);
  const missing = await requestJson(`${harness.baseUrl}/repo-agent/status?runId=${randomUUID()}`);
  assert.equal(missing.statusCode, 404);

  const runId = randomUUID();
  const store = new RepoAgentRunStore(runsRoot());
  store.create(RepoAgentRunRequestSchema.parse({
    runId,
    task: 'corrupt status',
    repoRoot: process.cwd(),
    approval: 'auto',
    images: [],
  }));
  fs.writeFileSync(path.join(runsRoot(), runId, 'state.json'), '{bad', 'utf8');

  const corrupt = await requestJson(`${harness.baseUrl}/repo-agent/status?runId=${runId}`);
  assert.equal(corrupt.statusCode, 500);
  assert.match(String(corrupt.body.error), /Malformed/u);

  const decide = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId, decision: 'approve' },
    timeoutMs: 10_000,
  });
  assert.equal(decide.statusCode, 500);
  assert.equal(decide.frames.length, 0);
});

test('repo-agent status and decide report malformed run paths and injected I/O errors as 500', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-run-path-errors-', t);
  fs.mkdirSync(runsRoot(), { recursive: true });
  const nonDirectoryRunId = randomUUID();
  fs.writeFileSync(path.join(runsRoot(), nonDirectoryRunId), 'not a run directory', 'utf8');

  const nonDirectoryStatus = await requestJson(
    `${harness.baseUrl}/repo-agent/status?runId=${nonDirectoryRunId}`,
  );
  assert.equal(nonDirectoryStatus.statusCode, 500);
  const nonDirectoryDecide = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: nonDirectoryRunId, decision: 'approve' },
    timeoutMs: 10_000,
  });
  assert.equal(nonDirectoryDecide.statusCode, 500);

  const originalHasRun = RepoAgentRunStore.prototype.hasRun;
  RepoAgentRunStore.prototype.hasRun = () => {
    throw new Error('injected hasRun failure');
  };
  try {
    const injectedRunId = randomUUID();
    const injectedStatus = await requestJson(
      `${harness.baseUrl}/repo-agent/status?runId=${injectedRunId}`,
    );
    assert.equal(injectedStatus.statusCode, 500);
    const injectedDecide = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
      body: { runId: injectedRunId, decision: 'approve' },
      timeoutMs: 10_000,
    });
    assert.equal(injectedDecide.statusCode, 500);
  } finally {
    RepoAgentRunStore.prototype.hasRun = originalHasRun;
  }
});

test('status and decide return a retained failed session before reading corrupt durable state', async (t) => {
  const harness = await startHarness('siftkit-repo-agent-retained-failure-', t);
  const parked = await requestSse(`${harness.baseUrl}/repo-agent`, {
    body: {
      prompt: 'write a file', repoRoot: process.cwd(), model: 'mock-model', maxTurns: 4,
      approval: 'auto', availableModels: ['mock-model'],
      mockResponses: [
        '{"action":"write","path":"retained-failure.txt","content":"never runs"}',
        NON_VERDICT_RESPONSE,
        NON_VERDICT_RESPONSE,
        '{"action":"finish","output":"done"}',
      ],
      mockCommandResults: {},
    },
    timeoutMs: 20_000,
  });
  const parkedResult = RepoAgentRunResultSchema.parse(parked.result);
  assert.equal(parkedResult.status, 'approval_required');
  if (parkedResult.status !== 'approval_required') return;
  fs.writeFileSync(path.join(runsRoot(), parkedResult.runId, 'state.json'), '{bad', 'utf8');

  const failed = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: parkedResult.runId, decision: 'approve' },
    timeoutMs: 20_000,
  });
  const failedResult = RepoAgentRunResultSchema.parse(failed.result);
  assert.equal(failedResult.status, 'failed');

  const status = await requestJson(`${harness.baseUrl}/repo-agent/status?runId=${parkedResult.runId}`);
  assert.equal(status.statusCode, 200);
  assert.equal(RepoAgentRunStateSchema.parse(status.body).status, 'failed');

  const repeatedDecision = await requestSse(`${harness.baseUrl}/repo-agent/decide`, {
    body: { runId: parkedResult.runId, decision: 'approve' },
    timeoutMs: 10_000,
  });
  assert.equal(RepoAgentRunResultSchema.parse(repeatedDecision.result).status, 'failed');
});
