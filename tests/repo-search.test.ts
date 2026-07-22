import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';

import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import {
  listRuntimeArtifacts,
  parseRuntimeArtifactUri,
  readRuntimeArtifact,
} from '../src/state/runtime-artifacts.js';
import { JsonRecordReader } from '../src/lib/json-record-reader.js';
import { parseJsonValueText } from '../src/lib/json.js';
import { getErrorMessage } from '../src/lib/errors.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { withTestEnvAndServer, mergeConfig } from './_test-helpers.js';
import { asRuntimeSiftConfig } from './helpers/mock-config.js';
import { asObject, asObjectArray, getAddressInfo } from './helpers/dashboard-http.js';
import { z } from 'zod';
import { ProgressWriter, SilentProgressWriter } from '../src/lib/progress-writer.js';
import type { RepoSearchProgressEvent } from '../src/repo-search/types.js';

// Thrown repo-search errors carry artifact/transcript URIs as own properties
// alongside non-JSON Error internals; validate just those string fields with a
// passthrough schema so unrelated enumerable props don't fail the parse.
const ErrorArtifactPathsSchema = z
  .object({ artifactPath: z.string(), transcriptPath: z.string() })
  .partial()
  .passthrough();

class ArtifactCountProgressWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public readonly counts: number[] = [];
  get enabled(): boolean { return true; }
  write(_event: RepoSearchProgressEvent): void {
    this.counts.push(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length);
  }
}

class FirstProgressTimingWriter extends ProgressWriter<RepoSearchProgressEvent> {
  public firstProgressMs: number | null = null;
  constructor(private readonly startedAt: number) { super(); }
  get enabled(): boolean { return true; }
  write(_event: RepoSearchProgressEvent): void {
    this.firstProgressMs ??= Date.now() - this.startedAt;
  }
}

function readErrorArtifactPaths<T>(error: T): { artifactPath: string; transcriptPath: string } {
  const parsed = ErrorArtifactPathsSchema.safeParse(error);
  const data = parsed.success ? parsed.data : {};
  return {
    artifactPath: typeof data.artifactPath === 'string' ? data.artifactPath : '',
    transcriptPath: typeof data.transcriptPath === 'string' ? data.transcriptPath : '',
  };
}

async function captureStdoutLines(fn: () => Promise<void>): Promise<string[]> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  let buffer = '';
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += text;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) {
        lines.push(line);
      }
    }
    if (typeof encodingOrCallback === 'function') {
      return originalWrite(chunk, encodingOrCallback);
    }
    return originalWrite(chunk, encodingOrCallback, callback);
  };
  const previousLogLevel = process.env.SIFTKIT_LOG_LEVEL;
  process.env.SIFTKIT_LOG_LEVEL = 'debug';
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
    if (previousLogLevel === undefined) {
      delete process.env.SIFTKIT_LOG_LEVEL;
    } else {
      process.env.SIFTKIT_LOG_LEVEL = previousLogLevel;
    }
  }
  if (buffer.trim()) {
    lines.push(buffer.trim());
  }
  return lines;
}

async function waitForRepoSearchRunLogRow(
  databasePath: string,
  requestId: string,
): Promise<JsonObject> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const database = new Database(databasePath, { readonly: true });
      try {
        const row = JsonRecordReader.asObject(database.prepare(`
          SELECT prompt_eval_duration_ms, generation_duration_ms
          FROM run_logs
          WHERE request_id = ?
        `).get(requestId));
        if (row) {
          return row;
        }
      } finally {
        database.close();
      }
    } catch {
      // Row not ready yet; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for repo-search run log row: ${requestId}`);
}

async function startDelayedStatusServer(options: { runningDelayMs?: number; terminalDelayMs?: number }): Promise<{
  statusUrl: string;
  runningPostCount: () => number;
  terminalPostCount: () => number;
  close: () => Promise<void>;
}> {
  const runningDelayMs = Math.max(0, Math.trunc(Number(options.runningDelayMs || 0)));
  const terminalDelayMs = Math.max(0, Math.trunc(Number(options.terminalDelayMs || 0)));
  let runningPosts = 0;
  let terminalPosts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (req.url === '/status/complete') {
      for await (const chunk of req) {
        void chunk;
        // Drain request body.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url !== '/status' && req.url !== '/status/terminal-metadata') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let bodyText = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      bodyText += String(chunk);
    }
    const parsed = bodyText ? asObject(parseJsonValueText(bodyText)) : {};
    if (parsed.running === true) {
      runningPosts += 1;
      await new Promise((resolve) => setTimeout(resolve, runningDelayMs));
    } else if (req.url === '/status/terminal-metadata' && parsed.running === false) {
      terminalPosts += 1;
      await new Promise((resolve) => setTimeout(resolve, terminalDelayMs));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = getAddressInfo(server);
  return {
    statusUrl: `http://127.0.0.1:${address.port}/status`,
    runningPostCount() {
      return runningPosts;
    },
    terminalPostCount() {
      return terminalPosts;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function startDelayedTerminalStatusServer(delayMs: number): Promise<{
  statusUrl: string;
  terminalPostCount: () => number;
  close: () => Promise<void>;
}> {
  const server = await startDelayedStatusServer({ terminalDelayMs: delayMs });
  return {
    statusUrl: server.statusUrl,
    terminalPostCount: server.terminalPostCount,
    close: server.close,
  };
}

async function waitForStatusCount(readCount: () => number, expected: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (readCount() >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(readCount(), expected);
}

test('executeRepoSearchRequest throws on empty prompt', async () => {
  await withTestEnvAndServer(async () => {
    await assert.rejects(
      () => executeRepoSearchRequest({ prompt: '', repoRoot: process.cwd() }),
      /--prompt is required/u,
    );
  });
});

test('executeRepoSearchRequest throws on whitespace-only prompt', async () => {
  await withTestEnvAndServer(async () => {
    await assert.rejects(
      () => executeRepoSearchRequest({ prompt: '   ', repoRoot: process.cwd() }),
      /--prompt is required/u,
    );
  });
});

test('executeRepoSearchRequest forwards an aborted signal to the engine', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const controller = new AbortController();
    controller.abort(new Error('stream disconnected'));
    await assert.rejects(
      () => executeRepoSearchRequest({
        prompt: 'find test patterns',
        repoRoot: tempRoot,
        abortSignal: controller.signal,
        mockResponses: ['{"action":"finish","output":"unexpected"}'],
        mockCommandResults: {},
      }),
      /stream disconnected/u,
    );
  });
});

test('executeRepoSearchRequest success path writes transcript and artifact', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const progressWriter = new ArtifactCountProgressWriter();
    const result = await executeRepoSearchRequest({
      prompt: 'find test patterns',
      repoRoot: tempRoot,
      maxTurns: 1,
      mockResponses: [
        '{"action":"finish","output":"Found test patterns in tests/"}',
      ],
      mockCommandResults: {},
      progressWriter,
    });
    assert.equal(typeof result.requestId, 'string');
    assert.ok(result.requestId.length > 0);
    assert.equal(typeof result.transcriptPath, 'string');
    assert.equal(typeof result.artifactPath, 'string');
    assert.ok(progressWriter.counts.length > 0);
    assert.ok(progressWriter.counts.every((count) => count === 0));

    const transcriptId = parseRuntimeArtifactUri(result.transcriptPath);
    assert.ok(transcriptId);
    const transcript = readRuntimeArtifact(transcriptId);
    assert.equal(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length, 1);
    assert.match(String(transcript?.contentText || ''), /"kind":"run_start"/u);
    assert.match(String(transcript?.contentText || ''), /"kind":"run_done"/u);

    const artifactId = parseRuntimeArtifactUri(result.artifactPath);
    assert.ok(artifactId);
    const artifact = readRuntimeArtifact(artifactId);
    assert.equal(artifact?.contentJson?.prompt, 'find test patterns');
    assert.equal(typeof artifact?.contentJson?.verdict, 'string');
    assert.equal(artifact?.contentJson?.transcriptPath, result.transcriptPath);
  });
});

test('executeRepoSearchRequest does not wait for running status notification response before work starts', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    // The running notify is awaited only at the very end of the request, so the
    // blocking-regression signal is bounded by the 2000ms status client post
    // timeout: hold the running response past it (5000ms) so a regressed engine
    // that awaited the notify before starting work would surface first progress
    // at ~2000ms. Non-blocking first progress is work-start jitter (hundreds of
    // ms even under full-suite load), so the 1500ms threshold separates the two
    // cases with ~900ms / ~500ms margins. Threshold must stay below the 2000ms
    // post timeout.
    const statusServer = await startDelayedStatusServer({ runningDelayMs: 5000 });
    try {
      const startedAt = Date.now();
      const progressWriter = new FirstProgressTimingWriter(startedAt);
      const result = await executeRepoSearchRequest({
        prompt: 'find async running status',
        repoRoot: tempRoot,
        statusBackendUrl: statusServer.statusUrl,
        maxTurns: 1,
        mockResponses: [
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
        progressWriter,
      });

      assert.equal(typeof result.requestId, 'string');
      await waitForStatusCount(statusServer.runningPostCount, 1);
      assert.ok(progressWriter.firstProgressMs !== null, 'expected repo-search progress event');
      assert.ok(progressWriter.firstProgressMs < 1500, `expected work to start before running notify response, got ${progressWriter.firstProgressMs} ms`);
    } finally {
      await statusServer.close();
    }
  });
});

test('executeRepoSearchRequest does not wait for terminal metadata notification response', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    // Terminal-metadata is fire-and-forget (never awaited), so the request must
    // return long before this delayed response. Hold it past the 2000ms status
    // client post timeout (3000ms) so a regressed engine that awaited it would
    // surface at ~2000ms; the 1500ms threshold leaves ~1500ms / ~500ms margins.
    const statusServer = await startDelayedTerminalStatusServer(3000);
    try {
      const startedAt = Date.now();
      const result = await executeRepoSearchRequest({
        prompt: 'find async terminal status',
        repoRoot: tempRoot,
        statusBackendUrl: statusServer.statusUrl,
        maxTurns: 1,
        mockResponses: [
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      });
      const durationMs = Date.now() - startedAt;

      assert.equal(typeof result.requestId, 'string');
      await waitForStatusCount(statusServer.terminalPostCount, 1);
      assert.ok(durationMs < 1500, `expected terminal metadata notify to be fire-and-forget, got ${durationMs} ms`);
    } finally {
      await statusServer.close();
    }
  });
});

test('executeRepoSearchRequest error path flushes transcript once and exposes final transcript URI', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    await assert.rejects(
      () => executeRepoSearchRequest({
        prompt: 'find test patterns',
        repoRoot: tempRoot,
        allowedTools: [],
      }),
      (error) => {
        const errorRecord = readErrorArtifactPaths(error);
        assert.equal(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length, 1);
        assert.equal(typeof errorRecord.artifactPath, 'string');
        assert.equal(typeof errorRecord.transcriptPath, 'string');

        const transcriptId = parseRuntimeArtifactUri(String(errorRecord.transcriptPath || ''));
        assert.ok(transcriptId);
        const transcript = readRuntimeArtifact(transcriptId);
        assert.equal(transcript?.artifactKind, 'repo_search_transcript');

        const artifactId = parseRuntimeArtifactUri(String(errorRecord.artifactPath || ''));
        assert.ok(artifactId);
        const artifact = readRuntimeArtifact(artifactId);
        assert.equal(
          artifact?.contentJson?.transcriptPath,
          errorRecord.transcriptPath,
        );
        return true;
      },
    );
  });
});

test('executeRepoSearchRequest with mock command executes and returns scorecard', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const result = await executeRepoSearchRequest({
      prompt: 'find build scripts',
      repoRoot: tempRoot,
      maxTurns: 2,
      mockResponses: [
        "{\"action\":\"git\",\"command\":\"git status --short\"}",
        '{"action":"finish","output":"Found scripts"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: '', stderr: '' },
      },
    });
    assert.equal(typeof result.scorecard, 'object');
    assert.equal(result.scorecard.verdict, 'pass');
  });
});

test('executeRepoSearchRequest logs lifecycle before provider work starts', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const lines = await captureStdoutLines(async () => {
      await executeRepoSearchRequest({
        prompt: 'find lifecycle logs',
        repoRoot: tempRoot,
        maxTurns: 1,
        mockResponses: [
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      });
    });

    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}start {2}task=\S+ {2}prompt_chars=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}notify_running_start$/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}notify_running_done {2}ok=true/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}run_start$/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}run_done$/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}terminal_persist_start {2}state=completed transcript_chars=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}transcript_persist_done {2}state=completed duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}artifact_persist_done {2}state=completed duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}terminal_persist_done {2}state=completed duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}notify_terminal_start {2}state=completed/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}notify_terminal_done {2}state=completed ok=true duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /rs [\da-f]{8} {2}completed {2}elapsed=/u.test(line)), lines.join('\n'));
  });
});

test('executeRepoSearchRequest logs repo-search preflight tokenization timing', async () => {
  await withTestEnvAndServer(async ({ tempRoot, stub }) => {
    const lines = await captureStdoutLines(async () => {
      await executeRepoSearchRequest({
        prompt: 'find tokenize timing logs',
        repoRoot: tempRoot,
        config: asRuntimeSiftConfig(stub.state.config),
        maxTurns: 1,
        mockCommandResults: {},
      });
    });

    assert.ok(
      lines.some((line) => /rs [\da-f]{8} {2}preflight_tokenize_start {2}t1 {2}prompt_chars=\d+ {2}timeout_ms=10000 {2}retry_max_wait_ms=30000/u.test(line)),
      lines.join('\n'),
    );
    assert.ok(
      lines.some((line) => /rs [\da-f]{8} {2}preflight {2}t1\/\d+ {2}prompt=\d+tok\/\d+\.\dkc {2}tokenize=\d+ms\(llama\.cpp\) {2}elapsed=\d+s$/u.test(line)),
      lines.join('\n'),
    );
  }, {
    assistantContent: '{"action":"finish","output":"done"}',
    tokenizeTokenCount: 321,
  });
});

test('executeRepoSearchRequest does not force finish from elapsed tool-loop time', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const result = await executeRepoSearchRequest({
      prompt: 'find slow command',
      repoRoot: tempRoot,
      maxTurns: 3,
      mockResponses: [
        "{\"action\":\"git\",\"command\":\"git status --short\"}",
        "{\"action\":\"git\",\"command\":\"git status --porcelain\"}",
        '{"action":"finish","output":"budget answer"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: 'slow evidence', stderr: '', delayMs: 40 },
        'git status --porcelain': { exitCode: 0, stdout: 'should not run', stderr: '' },
      },
    });

    const task = result.scorecard.tasks[0];

    assert.equal(task.finalOutput, 'budget answer');
    assert.equal(task.commands.length, 2);
    assert.equal(task.commands[0].output, 'slow evidence');
    assert.equal(task.commands[1].safe, true);
    assert.equal(task.commands[1].output, 'should not run');
  });
});

test('executeRepoSearchRequest fits native reads using per-tool context limits', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const sourcePath = path.join(tempRoot, 'src');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(
      path.join(sourcePath, 'big.ts'),
      Array.from({ length: 900 }, (_, index) => `export const line${index + 1} = "${'x'.repeat(240)}";`).join('\n'),
      'utf8',
    );

    const result = await executeRepoSearchRequest({
      prompt: 'read enough evidence',
      repoRoot: tempRoot,
      maxTurns: 4,
      mockResponses: [
        '{"action":"git","command":"git status --short"}',
        '{"action":"read","path":"src/big.ts","offset":300,"limit":601}',
        '{"action":"finish","output":"budget answer"}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: 'slow evidence', stderr: '', delayMs: 40 },
      },
    });

    const task = result.scorecard.tasks[0];

    assert.equal(task.finalOutput, 'budget answer');
    assert.equal(task.commands.length, 2);
    assert.equal(task.commands[1].safe, true);
    assert.match(task.commands[1].command, /^read path="src\/big\.ts" offset=300 limit=\d+$/u);
    assert.match(task.commands[1].output, /\d+ lines truncated due to per-tool context limit\./u);
    assert.match(task.commands[1].output, /^300: /mu);
  });
});

test('executeRepoSearchRequest persists summed prompt-eval and generation durations for streamed multi-turn runs', async () => {
  await withTestEnvAndServer(async ({ tempRoot, stub }) => {
    let requestCount = 0;
    const modelServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'mock-model' }],
        }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      requestCount += 1;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (requestCount === 1) {
        setTimeout(() => {
          res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"git\\",\\"command\\":\\"git status --short\\"}"}}]}\n\n');
          setTimeout(() => {
            res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":30,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":6},"prompt_tokens_details":{"cached_tokens":20}}}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 20);
        }, 20);
        return;
      }
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish\\",\\"output\\":\\"done\\"}"}}]}\n\n');
        setTimeout(() => {
          res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":22,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":3},"prompt_tokens_details":{"cached_tokens":15}}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }, 20);
      }, 20);
    });
    await new Promise<void>((resolve, reject) => {
      modelServer.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
    });
    try {
      const address = getAddressInfo(modelServer);
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const configValue = structuredClone(asRuntimeSiftConfig(stub.state.config));
      configValue.Runtime.LlamaCpp.BaseUrl = baseUrl;
      const activePreset = configValue.Server.ModelPresets.Presets[0];
      if (!activePreset) throw new Error('Stub config must include a model preset.');
      activePreset.BaseUrl = baseUrl;
      activePreset.Reasoning = 'on';
      const config = asRuntimeSiftConfig(configValue);

      const result = await executeRepoSearchRequest({
        prompt: 'find build scripts',
        repoRoot: tempRoot,
        config,
        statusBackendUrl: stub.statusUrl,
        maxTurns: 2,
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: '', stderr: '' },
        },
        progressWriter: new SilentProgressWriter<RepoSearchProgressEvent>(),
      });

      assert.equal(result.scorecard.verdict, 'pass');
      assert.ok(Number(result.scorecard.totals.promptEvalDurationMs || 0) >= 20);
      assert.ok(Number(result.scorecard.totals.generationDurationMs || 0) >= 20);

      const row = await waitForRepoSearchRunLogRow(`${tempRoot}\\.siftkit\\runtime.sqlite`, result.requestId);
      assert.ok(Number(row.prompt_eval_duration_ms || 0) >= 20);
      assert.ok(Number(row.generation_duration_ms || 0) >= 20);
    } finally {
      await new Promise<void>((resolve, reject) => {
        modelServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

test('executeRepoSearchRequest hard-fails when no mock responses are available and persists a failed artifact', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    let thrown: { message: string; artifactPath: string } | null = null;
    try {
      await executeRepoSearchRequest({
        prompt: 'find something',
        repoRoot: tempRoot,
        maxTurns: 1,
        mockResponses: [],
        mockCommandResults: {},
      });
    } catch (error) {
      thrown = {
        message: getErrorMessage(error),
        artifactPath: readErrorArtifactPaths(error).artifactPath,
      };
    }
    assert.ok(thrown, 'expected executeRepoSearchRequest to throw');
    assert.match(thrown.message, /Terminal synthesis produced no usable output after 3 attempts/u);
    const artifactId = parseRuntimeArtifactUri(thrown.artifactPath || '');
    assert.ok(artifactId);
    assert.ok(readRuntimeArtifact(artifactId));
  });
});

test('executeRepoSearchRequest hard-fails on invalid mock response and persists a failed artifact', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    let thrown: { message: string; artifactPath: string } | null = null;
    try {
      await executeRepoSearchRequest({
        prompt: 'trigger error handling',
        repoRoot: tempRoot,
        maxTurns: 1,
        mockResponses: [
          'not valid json at all',
        ],
        mockCommandResults: {},
      });
    } catch (error) {
      thrown = {
        message: getErrorMessage(error),
        artifactPath: readErrorArtifactPaths(error).artifactPath,
      };
    }
    assert.ok(thrown, 'expected executeRepoSearchRequest to throw');
    assert.match(thrown.message, /Terminal synthesis produced no usable output after 3 attempts/u);
    const artifactId = parseRuntimeArtifactUri(thrown.artifactPath || '');
    assert.ok(artifactId);
    assert.ok(readRuntimeArtifact(artifactId));
  });
});

test('executeRepoSearchRequest trace output when SIFTKIT_TRACE_REPO_SEARCH=1', async () => {
  const prev = process.env.SIFTKIT_TRACE_REPO_SEARCH;
  process.env.SIFTKIT_TRACE_REPO_SEARCH = '1';
  try {
    await withTestEnvAndServer(async ({ tempRoot }) => {
      const result = await executeRepoSearchRequest({
        prompt: 'find something with tracing',
        repoRoot: tempRoot,
        maxTurns: 1,
        mockResponses: [
          '{"action":"finish","output":"done"}',
        ],
        mockCommandResults: {},
      });
      assert.equal(typeof result.requestId, 'string');
    });
  } finally {
    if (prev !== undefined) {
      process.env.SIFTKIT_TRACE_REPO_SEARCH = prev;
    } else {
      delete process.env.SIFTKIT_TRACE_REPO_SEARCH;
    }
  }
});
