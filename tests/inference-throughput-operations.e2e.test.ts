import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { InferenceThroughputSchema, type InferenceThroughput } from '@siftkit/contracts';
import { getActiveModelPreset } from '../src/config/getters.js';
import { isJsonObject, type JsonObject, type JsonValue, type OptionalJsonValue } from '../src/lib/json-types.js';
import { calculateThroughputRates, mergeInferenceThroughput, readTabbyThroughput, unmeasuredInferenceThroughput } from '../src/lib/inference-throughput.js';
import { InferenceClient } from '../src/llm-protocol/inference-client.js';
import { RepoSearchExecutionResultSchema } from '../src/repo-search/types.js';
import { buildChatAnswerCompletion } from '../src/status-server/chat-run-recorder.js';
import { buildDashboardRunDetail } from '../src/status-server/dashboard-runs.js';
import { buildBenchmarkAttemptMetrics } from '../src/status-server/dashboard-benchmark-runner.js';
import { auditInferenceThroughput } from '../src/status-server/inference-throughput-audit.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { buildStructuredStubDecision, startStubStatusServer } from './_runtime-helpers.js';
import { buildMockScorecard, TEST_THROUGHPUT_AUDIT, TEST_THROUGHPUT_AUDIT_OPERATION } from './_test-helpers.js';
import { DashboardTestServer } from './helpers/dashboard-server-fixture.js';
import { asObject, asObjectArray, closeHttpServer, getAddressInfo, requestJson, requestRawText } from './helpers/dashboard-http.js';
import { mockRunRecord } from './helpers/mock-run-record.js';
import { requestSse } from './helpers/sse-http.js';
import { OutputCapture } from './helpers/stdout-capture.js';
import { buildStreamingTestConfig, buildTabbyUsage } from './helpers/streaming-client.js';

// The investigated dropped-count workload: 754 emitted tokens (tool-call markup included) in
// 35.07 s while the visible text is a handful of tokens. Rates are self-consistent, so a
// correct pipeline audits clean and any reconstruction from visible text mismatches.
const DROPPED_COUNT_USAGE = buildTabbyUsage({ promptTokens: 3365, completionTokens: 754, promptTime: 3.88, completionTime: 35.07 });
const EXPECTED_PP_RATE = 3365 / 3.88;
const EXPECTED_DECODE_RATE = 754 / 35.07;
const FINISH_CONTENT = '{"action":"finish","output":"done"}';

function throughputLines(lines: readonly string[]): string[] {
  return lines.filter((line) => /throughput_/u.test(line));
}

function count(lines: readonly string[], ...patterns: RegExp[]): number {
  return lines.filter((line) => patterns.every((pattern) => pattern.test(line))).length;
}

function parseThroughput(value: OptionalJsonValue): InferenceThroughput {
  return InferenceThroughputSchema.parse(value);
}

type OperationsHarness = {
  server: DashboardTestServer;
  backend: Awaited<ReturnType<typeof startStubStatusServer>>;
  model: string;
  lines: () => string[];
};

/** Summary calls get a structured decision (native finish tool or JSON); every planner gets a finish action. */
function stubAssistantContent(promptText: string, parsed: JsonValue) {
  const tools = isJsonObject(parsed) && Array.isArray(parsed.tools) ? parsed.tools : [];
  const hasFinishTool = tools.some((tool) => isJsonObject(tool) && isJsonObject(tool.function) && tool.function.name === 'finish');
  if (hasFinishTool) return { content: '', toolCalls: [{ name: 'finish', arguments: buildStructuredStubDecision(promptText) }] };
  if (/"classification":"summary|command_failure|unsupported_input"/u.test(promptText)) return JSON.stringify(buildStructuredStubDecision(promptText));
  return FINISH_CONTENT;
}

/** Real status server + HTTP stub Tabby whose usage block is chosen per request from the prompt. */
async function withOperationsServer(
  prefix: string,
  usage: (promptText: string) => JsonObject,
  run: (harness: OperationsHarness) => Promise<void>,
): Promise<void> {
  const backend = await startStubStatusServer({
    tokenizeCharsPerToken: 4,
    assistantContent: stubAssistantContent,
    usage: (promptText) => usage(promptText),
  });
  const model = getActiveModelPreset(backend.state.config).Model;
  assert.ok(model);
  const server = await DashboardTestServer.start(prefix, { baseUrl: `http://127.0.0.1:${backend.port}`, model });
  const capture = OutputCapture.start(process.stdout);
  try {
    await run({ server, backend, model, lines: () => throughputLines(capture.lines) });
  } finally {
    capture.restore();
    await server.close();
    await backend.close();
  }
}

async function createChatSession(baseUrl: string, title: string): Promise<string> {
  const created = await requestJson(`${baseUrl}/dashboard/chat/sessions`, { method: 'POST', body: JSON.stringify({ title }) });
  assert.equal(created.statusCode, 200, JSON.stringify(created.body));
  return String(asObject(created.body.session).id);
}

async function sendChatTurn(baseUrl: string, sessionId: string, content: string): Promise<void> {
  const response = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}/messages`, {
    method: 'POST', timeoutMs: 20_000, body: JSON.stringify({ content }),
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
}

async function readChatSession(baseUrl: string, sessionId: string): Promise<JsonObject> {
  const response = await requestJson(`${baseUrl}/dashboard/chat/sessions/${sessionId}`);
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  return asObject(response.body.session);
}

function lastAnswer(session: JsonObject): JsonObject {
  const answers = asObjectArray(session.messages).filter((message) => message.kind === 'assistant_answer');
  const answer = answers.at(-1);
  assert.ok(answer, 'expected an assistant answer');
  return answer;
}

async function findRun(baseUrl: string, match: (run: JsonObject) => boolean): Promise<JsonObject> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await requestJson(`${baseUrl}/dashboard/runs?limitPerGroup=50`);
    const run = asObjectArray(response.body.runs).find((candidate) => match(candidate) && candidate.status !== 'running');
    if (run) return run;
    await delay(100);
  }
  throw new Error('The run never appeared as completed.');
}

test('every server-routed operation persists and publishes the canonical fold under the dropped-count workload', { timeout: 120_000 }, async () => {
  await withOperationsServer('siftkit-throughput-ops-', () => DROPPED_COUNT_USAGE, async ({ server, model, lines }) => {
    const baseUrl = server.baseUrl;

    // Chat: the answer row carries the fold and the session publishes duration-weighted rates.
    const sessionId = await createChatSession(baseUrl, 'throughput');
    await sendChatTurn(baseUrl, sessionId, 'Summarize the repository layout.');
    const session = await readChatSession(baseUrl, sessionId);
    const answer = lastAnswer(session);
    const answerFold = parseThroughput(answer.throughput);
    assert.equal(answerFold.decode.tokenCount, 754 * answerFold.decode.requestCount);
    assert.equal(answer.generationTokensPerSecond, EXPECTED_DECODE_RATE);
    assert.equal(answer.promptTokensPerSecond, EXPECTED_PP_RATE);
    const sessionThroughput = asObject(session.sessionThroughput);
    assert.equal(sessionThroughput.generationTokensPerSecond, EXPECTED_DECODE_RATE);
    assert.equal(sessionThroughput.promptTokensPerSecond, EXPECTED_PP_RATE);

    // Summary through the same route the CLI client uses.
    const summary = await requestSse(`${baseUrl}/summary`, {
      body: { question: 'what is in the text?', inputText: 'alpha beta gamma delta', repoRoot: process.cwd(), model },
      timeoutMs: 30_000,
    });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.errorMessage, null, summary.rawBody);
    assert.ok(summary.result);
    const summaryRun = await findRun(baseUrl, (run) => run.id === String(summary.result?.RequestId));
    const summaryFold = parseThroughput(summaryRun.throughput);
    assert.ok(summaryFold.decode.requestCount >= 1);
    assert.equal(summaryFold.decode.tokenCount, 754 * summaryFold.decode.requestCount);
    assert.equal(calculateThroughputRates(summaryFold).generationTokensPerSecond, EXPECTED_DECODE_RATE);

    // Repo-search and plan preset runs.
    const repoSearch = await requestSse(`${baseUrl}/repo-search`, {
      body: { prompt: 'find planner usage', repoRoot: process.cwd(), model, maxTurns: 1 },
      timeoutMs: 30_000,
    });
    assert.equal(repoSearch.statusCode, 200);
    assert.equal(repoSearch.errorMessage, null, repoSearch.rawBody);
    const repoSearchResult = RepoSearchExecutionResultSchema.parse(repoSearch.result);
    assert.equal(calculateThroughputRates(repoSearchResult.scorecard.throughput).generationTokensPerSecond, EXPECTED_DECODE_RATE);
    const repoSearchRun = await findRun(baseUrl, (run) => run.id === repoSearchResult.requestId);
    assert.deepEqual(parseThroughput(repoSearchRun.throughput), repoSearchResult.scorecard.throughput);

    const planSessionId = await createChatSession(baseUrl, 'plan');
    const planMode = await requestJson(`${baseUrl}/dashboard/chat/sessions/${planSessionId}`, {
      method: 'PUT', body: JSON.stringify({ presetId: 'plan', planRepoRoot: process.cwd() }),
    });
    assert.equal(planMode.statusCode, 200, JSON.stringify(planMode.body));
    const plan = await requestJson(`${baseUrl}/dashboard/chat/sessions/${planSessionId}/plan`, {
      method: 'POST', timeoutMs: 20_000, body: JSON.stringify({ content: 'plan a change', repoRoot: process.cwd(), maxTurns: 1 }),
    });
    assert.equal(plan.statusCode, 200, JSON.stringify(plan.body));
    const planAnswer = lastAnswer(await readChatSession(baseUrl, planSessionId));
    assert.equal(planAnswer.generationTokensPerSecond, EXPECTED_DECODE_RATE);

    // Repo-agent with the default finish tool; no destructive tool runs.
    const repoAgent = await requestSse(`${baseUrl}/repo-agent`, {
      body: { prompt: 'inspect the manifest', repoRoot: process.cwd(), model, maxTurns: 1, approval: 'off' },
      timeoutMs: 30_000,
    });
    assert.equal(repoAgent.statusCode, 200);
    assert.equal(repoAgent.errorMessage, null, repoAgent.rawBody);
    assert.equal(repoAgent.result?.status, 'completed', repoAgent.rawBody);
    const repoAgentRun = await findRun(baseUrl, (run) => run.operationType === 'repo-agent');
    assert.equal(calculateThroughputRates(parseThroughput(repoAgentRun.throughput)).generationTokensPerSecond, EXPECTED_DECODE_RATE);

    // Passthrough observes the same usage without altering the stream.
    const passthrough = await requestRawText(`${baseUrl}/v1/chat/completions`, {
      messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true },
    });
    assert.equal(passthrough.statusCode, 200, passthrough.text);
    assert.match(passthrough.text, /"completion_tokens":754/u);
    assert.match(passthrough.text, /data: \[DONE\]/u);

    // A benchmark attempt over the persisted repo-search run publishes the same rates.
    const attempt = buildBenchmarkAttemptMetrics(repoSearchResult.requestId, buildDashboardRunDetail(repoSearchResult.requestId), 'repo-search');
    assert.equal(attempt.generationTokensPerSecond, EXPECTED_DECODE_RATE);
    assert.equal(attempt.promptTokensPerSecond, EXPECTED_PP_RATE);

    assert.deepEqual(lines(), []);
  });
});

/** Usage whose reported rates drift from its own counts by the given factors. */
function driftingUsage(ppFactor: number, decodeFactor: number): JsonObject {
  return {
    ...DROPPED_COUNT_USAGE,
    prompt_tokens_per_sec: EXPECTED_PP_RATE * ppFactor,
    completion_tokens_per_sec: EXPECTED_DECODE_RATE * decodeFactor,
  };
}

const MATRIX = {
  'pp-only': { usage: driftingUsage(1.2, 1), pp: true, decode: false },
  'decode-only': { usage: driftingUsage(1, 0.8), pp: false, decode: true },
  'both': { usage: driftingUsage(0.7, 1.3), pp: true, decode: true },
  // Internal 21 vs reported 20 and internal 19 vs reported 20 are exactly 5 %.
  'exactly-five-percent': {
    usage: { ...buildTabbyUsage({ promptTokens: 2100, completionTokens: 1900, promptTime: 100, completionTime: 100 }), prompt_tokens_per_sec: 20, completion_tokens_per_sec: 20 },
    pp: false, decode: false,
  },
  'just-over-five-percent': {
    usage: { ...buildTabbyUsage({ promptTokens: 2101, completionTokens: 1899, promptTime: 100, completionTime: 100 }), prompt_tokens_per_sec: 20, completion_tokens_per_sec: 20 },
    pp: true, decode: true,
  },
} as const;

test('the mismatch matrix yields one red line per drifting metric per audit scope and replay adds none', { timeout: 120_000 }, async () => {
  const usageFor = (promptText: string): JsonObject => {
    const entry = Object.entries(MATRIX).find(([marker]) => promptText.includes(`matrix:${marker}`));
    return entry ? entry[1].usage : DROPPED_COUNT_USAGE;
  };
  await withOperationsServer('siftkit-throughput-matrix-', usageFor, async ({ server, lines }) => {
    const baseUrl = server.baseUrl;
    for (const [marker, expected] of Object.entries(MATRIX)) {
      const before = lines().length;
      const sessionId = await createChatSession(baseUrl, marker);
      await sendChatTurn(baseUrl, sessionId, `matrix:${marker} describe the repo`);
      const session = await readChatSession(baseUrl, sessionId);
      const fold = parseThroughput(lastAnswer(session).throughput);
      const turnLines = lines().slice(before);
      for (const [metric, drifts] of [['pp', expected.pp], ['decode', expected.decode]] as const) {
        const metricPattern = new RegExp(`metric=${metric}`, 'u');
        assert.equal(count(turnLines, /throughput_unverifiable/u, metricPattern), 0, turnLines.join('\n'));
        assert.equal(
          count(turnLines, /throughput_mismatch/u, /scope=request/u, metricPattern),
          drifts ? fold[metric].requestCount : 0,
          `${marker} ${metric} request scope:\n${turnLines.join('\n')}`,
        );
        assert.equal(count(turnLines, /throughput_mismatch/u, /stage=chat_answer/u, metricPattern), drifts ? 1 : 0, `${marker} ${metric} chat_answer`);
        assert.equal(count(turnLines, /throughput_mismatch/u, /stage=chat_session/u, metricPattern), drifts ? 1 : 0, `${marker} ${metric} chat_session`);
      }
      if (marker === 'both') {
        assert.equal(count(turnLines, /stage=chat_answer/u, /metric=pp/u, /delta_pct=\+/u), 1, 'internal above reference is a positive delta');
        assert.equal(count(turnLines, /stage=chat_answer/u, /metric=decode/u, /delta_pct=-/u), 1, 'internal below reference is a negative delta');
      }

      // Replay and repeated readers never re-audit a completed turn.
      const settled = lines().length;
      await readChatSession(baseUrl, sessionId);
      await readChatSession(baseUrl, sessionId);
      await requestJson(`${baseUrl}/dashboard/chat/sessions`);
      await requestJson(`${baseUrl}/dashboard/runs?limitPerGroup=50`);
      assert.equal(lines().length, settled, 'a GET or replay re-audited a completed turn');
    }
  });
});

// Faults injected after normalization at each publication boundary.
function measured(tokens: number, seconds: number, rate: number): InferenceThroughput {
  return readTabbyThroughput({ usage: {
    prompt_tokens: 3365, prompt_time: 3.88, prompt_tokens_per_sec: EXPECTED_PP_RATE,
    completion_tokens: tokens, completion_time: seconds, completion_tokens_per_sec: rate,
  } });
}

function captureAudit<T>(run: () => T): { value: T; lines: string[] } {
  const capture = OutputCapture.start(process.stdout);
  try {
    return { value: run(), lines: throughputLines(capture.lines) };
  } finally {
    capture.restore();
  }
}

function auditLines(run: () => void): string[] {
  return captureAudit(run).lines;
}

const CHAT_AUDIT = { ...TEST_THROUGHPUT_AUDIT_OPERATION, operationType: 'chat', operationId: 'run-fault', requestId: 'run-fault' } as const;

function chatResult(throughput: InferenceThroughput) {
  return { requestId: 'run-fault', transcriptPath: '', artifactPath: '', scorecard: { ...buildMockScorecard('answer'), throughput }, turnRecords: [] };
}

test('a fault after normalization is caught at the chat, benchmark, and session publication boundaries', () => {
  const clean = measured(754, 35.07, EXPECTED_DECODE_RATE);
  assert.deepEqual(auditLines(() => buildChatAnswerCompletion(chatResult(clean), 'answer', CHAT_AUDIT)), []);

  const tamperedCount = { ...clean, decode: { ...clean.decode, tokenCount: 398 } };
  const countLines = auditLines(() => buildChatAnswerCompletion(chatResult(tamperedCount), 'answer', CHAT_AUDIT));
  assert.equal(count(countLines, /throughput_mismatch/u, /stage=chat_answer/u, /metric=decode/u), 1, countLines.join('\n'));

  const tamperedDuration = { ...clean, decode: { ...clean.decode, durationMs: 60_000 } };
  const durationLines = auditLines(() => buildChatAnswerCompletion(chatResult(tamperedDuration), 'answer', CHAT_AUDIT));
  assert.equal(count(durationLines, /throughput_mismatch/u, /metric=decode/u), 1, durationLines.join('\n'));

  // An unmeasured member makes the cohort incomparable: no rate is published for it, none is fabricated.
  const tamperedCohort = mergeInferenceThroughput([clean, unmeasuredInferenceThroughput()]);
  const cohort = captureAudit(() => buildChatAnswerCompletion(chatResult(tamperedCohort), 'answer', CHAT_AUDIT));
  assert.equal(cohort.value.generationTokensPerSecond, null);
  assert.equal(cohort.value.promptTokensPerSecond, null);
  assert.deepEqual(cohort.lines, []);

  const benchmarkLines = auditLines(() => buildBenchmarkAttemptMetrics(
    'run-fault',
    { run: mockRunRecord({ throughput: tamperedCount }) },
    'repo-search',
  ));
  assert.equal(count(benchmarkLines, /throughput_mismatch/u, /stage=benchmark_attempt/u, /metric=decode/u), 1, benchmarkLines.join('\n'));

  const sessionLines = auditLines(() => auditInferenceThroughput(
    { ...CHAT_AUDIT, stage: 'chat_session', scope: 'published' },
    clean,
    { pp: EXPECTED_PP_RATE, decode: 16.5198 },
  ));
  assert.equal(count(sessionLines, /throughput_mismatch/u, /stage=chat_session/u, /metric=decode/u), 1, sessionLines.join('\n'));
});

// SSE shapes through InferenceClient against a raw byte-level stream server.
type RawSseServer = { baseUrl: string; requests: number; close: () => Promise<void> };

function frame(packet: JsonObject): string {
  return `data: ${JSON.stringify(packet)}\n\n`;
}

/** Writes the given SSE text in `chunkSize` slices, yielding between them so the client sees fragments. */
function startRawSseServer(text: string, options: { chunkSize?: number; holdAfterFirstChunk?: boolean } = {}): Promise<RawSseServer> {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', async () => {
      state.requests += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunkSize = options.chunkSize ?? text.length;
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        res.write(text.slice(offset, offset + chunkSize));
        if (options.holdAfterFirstChunk) return;
        await delay(1);
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
        get requests() { return state.requests; },
        close: () => closeHttpServer(server),
      });
    });
  });
}

async function streamThrough(server: RawSseServer, options: { reasoning?: 'on' | 'off'; abortSignal?: AbortSignal } = {}) {
  const config = buildStreamingTestConfig();
  getActiveModelPreset(config).BaseUrl = server.baseUrl;
  return new InferenceClient().chat({
    throughputAudit: TEST_THROUGHPUT_AUDIT,
    config, model: 'local', messages: [{ role: 'user', content: 'hello' }],
    tools: [], maxTokens: 64, allowedToolNames: [],
    retry: false,
    ...(options.reasoning ? { reasoningOverride: options.reasoning } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
}

const FINAL_USAGE = buildTabbyUsage({ promptTokens: 1000, cachedTokens: 900, completionTokens: 40, reasoningTokens: 25, promptTime: 0.5, completionTime: 2 });

test('one-frame and fragmented SSE deliveries fold to the identical observation', async () => {
  const text = frame({ choices: [{ delta: { reasoning_content: 'thinking' } }] })
    + frame({ choices: [{ delta: { content: 'answer' } }] })
    + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })
    + frame({ choices: [], usage: FINAL_USAGE })
    + 'data: [DONE]\n\n';
  const whole = await startRawSseServer(text);
  const fragmented = await startRawSseServer(text, { chunkSize: 5 });
  try {
    const capture = OutputCapture.start(process.stdout);
    let wholeResponse; let fragmentedResponse;
    try {
      wholeResponse = await streamThrough(whole, { reasoning: 'on' });
      fragmentedResponse = await streamThrough(fragmented, { reasoning: 'on' });
    } finally {
      capture.restore();
    }
    assert.deepEqual(throughputLines(capture.lines), []);
    assert.deepEqual(fragmentedResponse.usage.throughput, wholeResponse.usage.throughput);
    // Final usage after finish_reason, cache hits, and reasoning: raw emitted count, processed prompt count.
    assert.equal(wholeResponse.usage.throughput.decode.tokenCount, 40);
    assert.equal(wholeResponse.usage.throughput.pp.tokenCount, 100);
    assert.equal(wholeResponse.usage.throughput.decode.requestCount, 1);
    assert.equal(wholeResponse.text, 'answer');
  } finally {
    await whole.close();
    await fragmented.close();
  }
});

test('repeated cumulative usage frames count one request; reasoning off, tool-only, and empty output fold their emitted counts', async () => {
  const cumulative = await startRawSseServer(
    frame({ choices: [{ delta: { content: 'a' } }], usage: buildTabbyUsage({ promptTokens: 50, completionTokens: 5, completionTime: 0.5 }) })
    + frame({ choices: [{ delta: { content: 'b' } }], usage: buildTabbyUsage({ promptTokens: 50, completionTokens: 10, completionTime: 1 }) })
    + frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: buildTabbyUsage({ promptTokens: 50, completionTokens: 12, completionTime: 1.2 }) })
    + 'data: [DONE]\n\n',
  );
  const toolOnly = await startRawSseServer(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'finish', arguments: '{"output":"done"}' } }] } }] })
    + frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: buildTabbyUsage({ promptTokens: 50, completionTokens: 300, completionTime: 10 }) })
    + 'data: [DONE]\n\n',
  );
  const empty = await startRawSseServer(
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { ...buildTabbyUsage({ promptTokens: 50, completionTokens: 0, completionTime: 0.1 }), completion_tokens_per_sec: 0 } })
    + 'data: [DONE]\n\n',
  );
  try {
    const capture = OutputCapture.start(process.stdout);
    let cumulativeResponse; let toolOnlyResponse; let emptyResponse;
    try {
      cumulativeResponse = await streamThrough(cumulative, { reasoning: 'off' });
      toolOnlyResponse = await streamThrough(toolOnly);
      emptyResponse = await streamThrough(empty);
    } finally {
      capture.restore();
    }
    assert.deepEqual(throughputLines(capture.lines), []);
    assert.equal(cumulativeResponse.usage.throughput.decode.tokenCount, 12);
    assert.equal(cumulativeResponse.usage.throughput.decode.durationMs, 1200);
    assert.equal(cumulativeResponse.usage.throughput.decode.requestCount, 1);
    assert.equal(toolOnlyResponse.text, '');
    assert.equal(toolOnlyResponse.usage.throughput.decode.tokenCount, 300);
    assert.equal(calculateThroughputRates(toolOnlyResponse.usage.throughput).generationTokensPerSecond, 30);
    assert.equal(emptyResponse.usage.throughput.decode.tokenCount, 0);
    assert.equal(calculateThroughputRates(emptyResponse.usage.throughput).generationTokensPerSecond, 0);
  } finally {
    await cumulative.close();
    await toolOnly.close();
    await empty.close();
  }
});

test('a missing usage is unverifiable and a cancelled stream audits nothing and never throws from the audit', async () => {
  const missing = await startRawSseServer(
    frame({ choices: [{ delta: { content: 'answer' } }] }) + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n',
  );
  const held = await startRawSseServer(frame({ choices: [{ delta: { content: 'partial' } }] }), { holdAfterFirstChunk: true });
  try {
    const capture = OutputCapture.start(process.stdout);
    let cancelled = false;
    try {
      const response = await streamThrough(missing);
      assert.equal(response.usage.throughput.decode.missingTabbyRequests, 1);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      await streamThrough(held, { abortSignal: controller.signal }).catch(() => { cancelled = true; });
    } finally {
      capture.restore();
    }
    const lines = throughputLines(capture.lines);
    assert.equal(count(lines, /throughput_unverifiable/u, /metric=pp/u, /scope=request/u), 1, lines.join('\n'));
    assert.equal(count(lines, /throughput_unverifiable/u, /metric=decode/u, /missing=/u), 1, lines.join('\n'));
    assert.equal(cancelled, true, 'the cancelled request must reject');
    assert.equal(lines.length, 2, 'a cancelled request publishes no rate and no audit');
  } finally {
    await missing.close();
    await held.close();
  }
});

// Overhead gate: the audit adds no per-frame logging, tokenization, requests, or database writes.
type FrameCountBackend = { baseUrl: string; model: string; chatRequests: number; tokenizeRequests: number; close: () => Promise<void> };

function startFrameCountBackend(model: string, frames: (promptText: string) => number): Promise<FrameCountBackend> {
  const state = { chatRequests: 0, tokenizeRequests: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
        return;
      }
      if (req.url === '/v1/token/encode') {
        state.tokenizeRequests += 1;
        const text = String(asObject(JSON.parse(body)).text ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Math.max(1, Math.ceil(text.length / 4)) }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        state.chatRequests += 1;
        const total = frames(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (let index = 0; index < total; index += 1) res.write(frame({ choices: [{ delta: { content: index === 0 ? '{"action":"finish","output":"' : 'x' } }] }));
        res.write(frame({ choices: [{ delta: { content: '"}' } }] }));
        res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: buildTabbyUsage({ promptTokens: 100, completionTokens: total + 2, completionTime: 1 }) }));
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${getAddressInfo(server).port}`,
      model,
      get chatRequests() { return state.chatRequests; },
      get tokenizeRequests() { return state.tokenizeRequests; },
      close: () => closeHttpServer(server),
    }));
  });
}

function totalDatabaseChanges(): number {
  const row = getRuntimeDatabase().prepare('SELECT total_changes() AS changes').get();
  return Number(asObject(row === undefined ? {} : JSON.parse(JSON.stringify(row))).changes);
}

test('a 2000-frame stream costs the same logger writes, tokenizer calls, requests, and database writes as a 10-frame stream', { timeout: 120_000 }, async () => {
  const backend = await startFrameCountBackend('frame-count-model', (body) => (body.includes('frames:2000') ? 2000 : 10));
  const server = await DashboardTestServer.start('siftkit-throughput-overhead-', { baseUrl: backend.baseUrl, model: backend.model });
  const capture = OutputCapture.start(process.stdout);
  try {
    const measure = async (marker: string) => {
      const sessionId = await createChatSession(server.baseUrl, marker);
      const before = {
        lines: capture.lines.length,
        chat: backend.chatRequests,
        tokenize: backend.tokenizeRequests,
        changes: totalDatabaseChanges(),
      };
      await sendChatTurn(server.baseUrl, sessionId, `${marker} describe`);
      await server.readMetricsAfterTerminalMetadata(1);
      return {
        lines: capture.lines.length - before.lines,
        chat: backend.chatRequests - before.chat,
        tokenize: backend.tokenizeRequests - before.tokenize,
        changes: totalDatabaseChanges() - before.changes,
        throughputLines: throughputLines(capture.lines.slice(before.lines)).length,
      };
    };
    // First-request warm-up lines (image budget, model inventory) are not part of the token loop.
    await measure('frames:10');
    const small = await measure('frames:10');
    const large = await measure('frames:2000');
    assert.equal(small.throughputLines, 0);
    assert.equal(large.throughputLines, 0);
    assert.equal(large.chat, small.chat);
    assert.equal(large.tokenize, small.tokenize);
    assert.equal(large.lines, small.lines, `logger writes grew with frames: ${small.lines} -> ${large.lines}`);
    // Live-text journaling flushes in 1024-char batches, so row changes may grow by a few; never per frame.
    const extraFrames = 2000 - 10;
    assert.ok(
      large.changes - small.changes < extraFrames / 20,
      `database writes grew per frame: ${small.changes} -> ${large.changes} for ${extraFrames} extra frames`,
    );
  } finally {
    capture.restore();
    await server.close();
    await backend.close();
  }
});
