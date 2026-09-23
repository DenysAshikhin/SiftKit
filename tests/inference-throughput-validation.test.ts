import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import type { JsonObject } from '../src/lib/json-types.js';
import { readTabbyThroughput } from '../src/lib/inference-throughput.js';
import { runValidation, ValidationConfigSchema, type ValidationConfig } from '../scripts/verify-inference-throughput.js';
import { closeHttpServer, getAddressInfo } from './helpers/dashboard-http.js';
import { buildTabbyUsage } from './helpers/streaming-client.js';

const SECRET_PROMPT = 'super-secret-prompt-text';

type FakeTabbyOptions = { usage?: JsonObject | null; holdAfterFirstFrame?: boolean; rawUsageFrame?: string };
type FakeServer = { baseUrl: string; requests: () => number; close: () => Promise<void> };

function sseFrame(packet: JsonObject): string {
  return `data: ${JSON.stringify(packet)}\n\n`;
}

/** Streams one content delta, then the configured usage frame (or holds the stream open). */
function startFakeTabby(options: FakeTabbyOptions): Promise<FakeServer> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseFrame({ choices: [{ delta: { content: 'answer text that must not be recorded' } }] }));
      if (options.holdAfterFirstFrame) return;
      res.write(sseFrame({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      if (options.rawUsageFrame !== undefined) res.write(`data: ${options.rawUsageFrame}\n\n`);
      else if (options.usage !== null) res.write(sseFrame({ choices: [], usage: options.usage ?? buildTabbyUsage({ promptTokens: 100, completionTokens: 50, completionTime: 2 }) }));
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
      requests: () => requests,
      close: () => closeHttpServer(server),
    }));
  });
}

type FakeStatusOptions = { activeCount?: number; answer?: JsonObject };

/** The status-server surface the harness touches: slot status and the chat session routes. */
function startFakeStatusServer(options: FakeStatusOptions): Promise<FakeServer> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      requests += 1;
      const send = (payload: JsonObject): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/status') {
        send({ running: false, modelRequests: { activeCount: options.activeCount ?? 0, activeRequests: [] } });
      } else if (req.method === 'POST' && req.url === '/dashboard/chat/sessions') {
        send({ session: { id: 'session-1' } });
      } else if (req.method === 'POST' && req.url === '/dashboard/chat/sessions/session-1/messages') {
        assert.match(body, /super-secret-prompt-text/u);
        send({ ok: true });
      } else if (req.method === 'GET' && req.url === '/dashboard/chat/sessions/session-1') {
        send({ session: { id: 'session-1', modelPresetId: 'preset-a', messages: [
          { id: 'u', role: 'user', kind: 'user', content: SECRET_PROMPT },
          { id: 'a', role: 'assistant', kind: 'assistant_answer', content: 'answer', ...(options.answer ?? {}) },
        ] } });
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
      requests: () => requests,
      close: () => closeHttpServer(server),
    }));
  });
}

function config(overrides: Partial<ValidationConfig> & Pick<ValidationConfig, 'serverBaseUrl' | 'tabbyBaseUrl'>): ValidationConfig {
  return ValidationConfigSchema.parse({
    model: 'verify-model',
    workloads: [{ id: 'direct', kind: 'tabby_direct', prompt: SECRET_PROMPT, maxTokens: 32 }],
    repetitions: 1,
    outputPath: 'unused.json',
    runTimeoutMs: 5_000,
    ...overrides,
  });
}

async function withServers(
  tabby: FakeTabbyOptions,
  status: FakeStatusOptions,
  run: (servers: { tabby: FakeServer; status: FakeServer }) => Promise<void>,
): Promise<void> {
  const tabbyServer = await startFakeTabby(tabby);
  const statusServer = await startFakeStatusServer(status);
  try {
    await run({ tabby: tabbyServer, status: statusServer });
  } finally {
    await tabbyServer.close();
    await statusServer.close();
  }
}

test('the harness detects a backend rate that drifts more than five percent from its own counts', async () => {
  const drifting = { ...buildTabbyUsage({ promptTokens: 100, completionTokens: 50, completionTime: 2 }), completion_tokens_per_sec: 30 };
  await withServers({ usage: drifting }, {}, async ({ tabby, status }) => {
    const artifact = await runValidation(config({ serverBaseUrl: status.baseUrl, tabbyBaseUrl: tabby.baseUrl, repetitions: 2 }));
    assert.equal(artifact.runs.length, 2);
    const run = artifact.runs[0];
    assert.ok(run);
    assert.equal(run.status, 'measured');
    assert.equal(run.emittedTokens, 50);
    assert.equal(run.internalDecodeRate, 25);
    assert.equal(run.tabbyDecodeRate, 30);
    assert.equal(run.comparison.decode?.kind, 'mismatch');
    assert.equal(run.comparison.pp?.kind, 'match');
    assert.ok(run.delivery.firstByteMs !== null && run.delivery.wallMs >= run.delivery.firstByteMs);
    assert.doesNotMatch(JSON.stringify(artifact), /super-secret|answer text/u, 'the artifact must carry no prompt or answer text');
    assert.equal(tabby.requests(), 2, 'runs are sequential repetitions of the same workload');
  });
});

test('a busy inference slot is recorded as unverified and the workload is never sent', async () => {
  await withServers({}, { activeCount: 1 }, async ({ tabby, status }) => {
    const artifact = await runValidation(config({ serverBaseUrl: status.baseUrl, tabbyBaseUrl: tabby.baseUrl }));
    assert.equal(artifact.runs[0]?.status, 'unverified');
    assert.equal(artifact.runs[0]?.reason, 'busy_slot');
    assert.equal(artifact.runs[0]?.internalDecodeRate, null);
    assert.equal(tabby.requests(), 0);
  });
});

test('a run that exceeds its timeout is unverified rather than a throughput result', async () => {
  await withServers({ holdAfterFirstFrame: true }, {}, async ({ tabby, status }) => {
    const artifact = await runValidation(config({ serverBaseUrl: status.baseUrl, tabbyBaseUrl: tabby.baseUrl, runTimeoutMs: 300 }));
    assert.equal(artifact.runs[0]?.status, 'unverified');
    assert.equal(artifact.runs[0]?.reason, 'timeout');
    assert.equal(artifact.runs[0]?.publishedDecodeRate, null);
  });
});

test('malformed or missing usage never yields a rate', async () => {
  await withServers({ rawUsageFrame: '{"choices":[],"usage":{"completion_tokens":"many","completion_time":"soon"}}' }, {}, async ({ tabby, status }) => {
    const malformed = await runValidation(config({ serverBaseUrl: status.baseUrl, tabbyBaseUrl: tabby.baseUrl }));
    assert.equal(malformed.runs[0]?.status, 'unverified');
    assert.equal(malformed.runs[0]?.reason, 'incomplete_telemetry');
    assert.equal(malformed.runs[0]?.internalDecodeRate, null);
    assert.equal(malformed.runs[0]?.comparison.decode?.kind, 'unverifiable');
  });
  await withServers({ usage: null }, {}, async ({ tabby, status }) => {
    const missing = await runValidation(config({ serverBaseUrl: status.baseUrl, tabbyBaseUrl: tabby.baseUrl }));
    assert.equal(missing.runs[0]?.status, 'unverified');
    assert.equal(missing.runs[0]?.reason, 'missing_usage');
    assert.equal(missing.runs[0]?.internalDecodeRate, null);
    assert.equal(missing.runs[0]?.publishedDecodeRate, null);
  });
});

test('a transport failure keeps its underlying cause in the unverified reason', async () => {
  const server = http.createServer((req) => { req.socket.destroy(); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const baseUrl = `http://127.0.0.1:${getAddressInfo(server).port}`;
    const artifact = await runValidation(config({ serverBaseUrl: baseUrl, tabbyBaseUrl: baseUrl }));
    assert.equal(artifact.runs[0]?.status, 'unverified');
    assert.match(artifact.runs[0]?.reason ?? '', /^error:fetch failed \(.+\)$/u);
  } finally {
    await closeHttpServer(server);
  }
});

test('a SiftKit chat run compares the published answer rates with the persisted backend reference', async () => {
  const fold = readTabbyThroughput({ usage: buildTabbyUsage({ promptTokens: 3365, completionTokens: 754, promptTime: 3.88, completionTime: 35.07 }) });
  const answer = { throughput: fold, promptTokensPerSecond: 3365 / 3.88, generationTokensPerSecond: 16.5198, promptCacheTokens: 0 };
  await withServers({}, { answer }, async ({ tabby, status }) => {
    const artifact = await runValidation(config({
      serverBaseUrl: status.baseUrl, tabbyBaseUrl: tabby.baseUrl,
      workloads: [{ id: 'chat', kind: 'siftkit_chat', prompt: SECRET_PROMPT }],
    }));
    const run = artifact.runs[0];
    assert.ok(run);
    assert.equal(run.status, 'measured');
    assert.equal(run.presetId, 'preset-a');
    assert.equal(run.internalDecodeRate, 754 / 35.07);
    assert.equal(run.publishedDecodeRate, 16.5198);
    assert.equal(run.comparison.decode?.kind, 'mismatch');
    assert.equal(run.comparison.pp?.kind, 'match');
    assert.equal(tabby.requests(), 0, 'a SiftKit run never contacts Tabby directly');
    assert.doesNotMatch(JSON.stringify(artifact), /super-secret/u);
  });
});
