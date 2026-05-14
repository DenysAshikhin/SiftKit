import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import { executeRepoSearchRequest } from '../dist/repo-search/index.js';
import {
  listRuntimeArtifacts,
  parseRuntimeArtifactUri,
  readRuntimeArtifact,
} from '../dist/state/runtime-artifacts.js';
import { withTestEnvAndServer } from './_test-helpers.js';

const requireFromHere = createRequire(__filename);
const Database = requireFromHere('better-sqlite3') as new (path: string, options?: { readonly?: boolean }) => {
  prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined };
  close: () => void;
};

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
    return originalWrite(chunk, encodingOrCallback as BufferEncoding, callback);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  if (buffer.trim()) {
    lines.push(buffer.trim());
  }
  return lines;
}

async function waitForRepoSearchRunLogRow(
  databasePath: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const database = new Database(databasePath, { readonly: true });
      try {
        const row = database.prepare(`
          SELECT prompt_eval_duration_ms, generation_duration_ms
          FROM run_logs
          WHERE request_id = ?
        `).get(requestId) as Record<string, unknown> | undefined;
        if (row) {
          return row;
        }
      } finally {
        database.close();
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (lastError) {
    throw lastError;
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
    const parsed = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
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
  const address = server.address() as AddressInfo;
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
  while (Date.now() - startedAt < 500) {
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

test('executeRepoSearchRequest success path writes transcript and artifact', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const midRunTranscriptArtifactCounts: number[] = [];
    const result = await executeRepoSearchRequest({
      prompt: 'find test patterns',
      repoRoot: tempRoot,
      maxTurns: 1,
      mockResponses: [
        '{"action":"finish","output":"Found test patterns in tests/","confidence":0.9}',
      ],
      mockCommandResults: {},
      onProgress(event) {
        if (!event.kind) {
          return;
        }
        midRunTranscriptArtifactCounts.push(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length);
      },
    });
    assert.equal(typeof result.requestId, 'string');
    assert.ok(result.requestId.length > 0);
    assert.equal(typeof result.transcriptPath, 'string');
    assert.equal(typeof result.artifactPath, 'string');
    assert.ok(midRunTranscriptArtifactCounts.length > 0);
    assert.ok(midRunTranscriptArtifactCounts.every((count) => count === 0));

    const transcriptId = parseRuntimeArtifactUri(result.transcriptPath);
    assert.ok(transcriptId);
    const transcript = readRuntimeArtifact(transcriptId as string);
    assert.equal(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length, 1);
    assert.match(String(transcript?.contentText || ''), /"kind":"run_start"/u);
    assert.match(String(transcript?.contentText || ''), /"kind":"run_done"/u);

    const artifactId = parseRuntimeArtifactUri(result.artifactPath);
    assert.ok(artifactId);
    const artifact = readRuntimeArtifact(artifactId as string);
    assert.equal(artifact?.contentJson?.prompt, 'find test patterns');
    assert.equal(typeof artifact?.contentJson?.verdict, 'string');
    assert.equal(artifact?.contentJson?.transcriptPath, result.transcriptPath);
  });
});

test('executeRepoSearchRequest does not wait for running status notification response before work starts', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const statusServer = await startDelayedStatusServer({ runningDelayMs: 1000 });
    try {
      let firstProgressMs: number | null = null;
      const startedAt = Date.now();
      const result = await executeRepoSearchRequest({
        prompt: 'find async running status',
        repoRoot: tempRoot,
        statusBackendUrl: statusServer.statusUrl,
        maxTurns: 1,
        mockResponses: [
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {},
        onProgress() {
          firstProgressMs ??= Date.now() - startedAt;
        },
      });

      assert.equal(typeof result.requestId, 'string');
      await waitForStatusCount(statusServer.runningPostCount, 1);
      assert.ok(firstProgressMs !== null, 'expected repo-search progress event');
      assert.ok(firstProgressMs < 500, `expected work to start before running notify response, got ${firstProgressMs} ms`);
    } finally {
      await statusServer.close();
    }
  });
});

test('executeRepoSearchRequest does not wait for terminal metadata notification response', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const statusServer = await startDelayedTerminalStatusServer(1000);
    try {
      const startedAt = Date.now();
      const result = await executeRepoSearchRequest({
        prompt: 'find async terminal status',
        repoRoot: tempRoot,
        statusBackendUrl: statusServer.statusUrl,
        maxTurns: 1,
        mockResponses: [
          '{"action":"finish","output":"done","confidence":0.9}',
        ],
        mockCommandResults: {},
      });
      const durationMs = Date.now() - startedAt;

      assert.equal(typeof result.requestId, 'string');
      await waitForStatusCount(statusServer.terminalPostCount, 1);
      assert.ok(durationMs < 500, `expected terminal metadata notify to be fire-and-forget, got ${durationMs} ms`);
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
      (error: unknown) => {
        assert.equal(listRuntimeArtifacts({ artifactKind: 'repo_search_transcript' }).length, 1);
        assert.equal(typeof (error as { artifactPath?: unknown }).artifactPath, 'string');
        assert.equal(typeof (error as { transcriptPath?: unknown }).transcriptPath, 'string');

        const transcriptId = parseRuntimeArtifactUri(String((error as { transcriptPath?: string }).transcriptPath || ''));
        assert.ok(transcriptId);
        const transcript = readRuntimeArtifact(transcriptId as string);
        assert.equal(transcript?.artifactKind, 'repo_search_transcript');

        const artifactId = parseRuntimeArtifactUri(String((error as { artifactPath?: string }).artifactPath || ''));
        assert.ok(artifactId);
        const artifact = readRuntimeArtifact(artifactId as string);
        assert.equal(
          artifact?.contentJson?.transcriptPath,
          (error as { transcriptPath?: string }).transcriptPath,
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
        "{\"action\":\"repo_git\",\"command\":\"git status --short\"}",
        '{"action":"finish","output":"Found scripts","confidence":0.8}',
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
          '{"action":"finish","output":"done","confidence":0.8}',
        ],
        mockCommandResults: {},
      });
    });

    assert.ok(lines.some((line) => /repo_search start request_id=.* prompt_chars=/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search notify_running_start request_id=/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search notify_running_done request_id=.* ok=true/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search run_start request_id=/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search run_done request_id=/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search terminal_persist_start request_id=.* state=completed transcript_chars=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search transcript_persist_done request_id=.* state=completed duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search artifact_persist_done request_id=.* state=completed duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search terminal_persist_done request_id=.* state=completed duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search notify_terminal_start request_id=.* state=completed/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search notify_terminal_done request_id=.* state=completed ok=true duration_ms=\d+/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /repo_search completed request_id=/u.test(line)), lines.join('\n'));
  });
});

test('executeRepoSearchRequest logs repo-search preflight tokenization timing', async () => {
  await withTestEnvAndServer(async ({ tempRoot, stub }) => {
    const lines = await captureStdoutLines(async () => {
      await executeRepoSearchRequest({
        prompt: 'find tokenize timing logs',
        repoRoot: tempRoot,
        config: stub.state.config,
        maxTurns: 1,
        mockCommandResults: {},
      });
    });

    assert.ok(
      lines.some((line) => /repo_search preflight_tokenize_start request_id=.* turn=1 prompt_chars=\d+ timeout_ms=10000 retry_max_wait_ms=30000/u.test(line)),
      lines.join('\n'),
    );
    assert.ok(
      lines.some((line) => /repo_search preflight_tokenize_done request_id=.* turn=1 prompt_tokens=\d+ source=llama\.cpp elapsed_ms=\d+ retry_count=0/u.test(line)),
      lines.join('\n'),
    );
  }, {
    assistantContent: '{"action":"finish","output":"done","confidence":0.8}',
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
        "{\"action\":\"repo_git\",\"command\":\"git status --short\"}",
        "{\"action\":\"repo_git\",\"command\":\"git status --porcelain\"}",
        '{"action":"finish","output":"budget answer","confidence":0.8}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: 'slow evidence', stderr: '', delayMs: 40 },
        'git status --porcelain': { exitCode: 0, stdout: 'should not run', stderr: '' },
      },
    });

    const task = (result.scorecard.tasks as Array<{
      finalOutput: string;
      commands: Array<{ command: string; safe: boolean; output: string; reason: string | null }>;
    }>)[0];

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
        '{"action":"repo_git","command":"git status --short"}',
        '{"action":"repo_read_file","path":"src/big.ts","startLine":300,"endLine":900}',
        '{"action":"finish","output":"budget answer","confidence":0.8}',
      ],
      mockCommandResults: {
        'git status --short': { exitCode: 0, stdout: 'slow evidence', stderr: '', delayMs: 40 },
      },
    });

    const task = (result.scorecard.tasks as Array<{
      finalOutput: string;
      commands: Array<{ command: string; safe: boolean; output: string; reason: string | null }>;
    }>)[0];

    assert.equal(task.finalOutput, 'budget answer');
    assert.equal(task.commands.length, 2);
    assert.equal(task.commands[1].safe, true);
    assert.match(task.commands[1].command, /^repo_read_file path="src\/big\.ts" startLine=300 endLine=\d+$/u);
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
          res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"repo_git\\",\\"command\\":\\"git status --short\\"}"}}]}\n\n');
          setTimeout(() => {
            res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":30,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":6},"prompt_tokens_details":{"cached_tokens":20}}}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 20);
        }, 20);
        return;
      }
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"finish\\",\\"output\\":\\"done\\",\\"confidence\\":0.9}"}}]}\n\n');
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
      const address = modelServer.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const config = structuredClone(stub.state.config) as Record<string, unknown>;
      const runtime = (config.Runtime as Record<string, unknown>) || {};
      config.Runtime = runtime;
      const runtimeLlama = (runtime.LlamaCpp as Record<string, unknown>) || {};
      runtime.LlamaCpp = runtimeLlama;
      runtimeLlama.BaseUrl = baseUrl;
      runtime.Model = 'mock-model';
      const topLlama = (config.LlamaCpp as Record<string, unknown>) || {};
      config.LlamaCpp = topLlama;
      topLlama.BaseUrl = baseUrl;
      topLlama.Reasoning = 'on';

      const result = await executeRepoSearchRequest({
        prompt: 'find build scripts',
        repoRoot: tempRoot,
        config,
        statusBackendUrl: stub.statusUrl,
        maxTurns: 2,
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: '', stderr: '' },
        },
        onProgress() {},
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
    let thrown: Error & { artifactPath?: string } | null = null;
    try {
      await executeRepoSearchRequest({
        prompt: 'find something',
        repoRoot: tempRoot,
        maxTurns: 1,
        mockResponses: [],
        mockCommandResults: {},
      });
    } catch (error) {
      thrown = error as Error & { artifactPath?: string };
    }
    assert.ok(thrown, 'expected executeRepoSearchRequest to throw');
    assert.match(thrown!.message, /Terminal synthesis produced no usable output after 3 attempts/u);
    const artifactId = parseRuntimeArtifactUri(thrown!.artifactPath || '');
    assert.ok(artifactId);
    assert.ok(readRuntimeArtifact(artifactId as string));
  });
});

test('executeRepoSearchRequest hard-fails on invalid mock response and persists a failed artifact', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    let thrown: Error & { artifactPath?: string } | null = null;
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
      thrown = error as Error & { artifactPath?: string };
    }
    assert.ok(thrown, 'expected executeRepoSearchRequest to throw');
    assert.match(thrown!.message, /Terminal synthesis produced no usable output after 3 attempts/u);
    const artifactId = parseRuntimeArtifactUri(thrown!.artifactPath || '');
    assert.ok(artifactId);
    assert.ok(readRuntimeArtifact(artifactId as string));
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
          '{"action":"finish","output":"done","confidence":0.5}',
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
