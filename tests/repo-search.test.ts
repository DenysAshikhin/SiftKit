import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_REPO_SEARCH_PROMPT_TIMEOUT_MS,
  executeRepoSearchRequest,
} from '../dist/repo-search/index.js';
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

async function startDelayedTerminalStatusServer(delayMs: number): Promise<{
  statusUrl: string;
  terminalPostCount: () => number;
  close: () => Promise<void>;
}> {
  let terminalPosts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/status') {
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
    if (parsed.running === false) {
      terminalPosts += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    statusUrl: `http://127.0.0.1:${address.port}/status`,
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

test('executeRepoSearchRequest does not wait for terminal status notification', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    const statusServer = await startDelayedTerminalStatusServer(300);
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
      assert.ok(durationMs < 250, `expected non-blocking terminal notify, got ${durationMs} ms`);
      const deadline = Date.now() + 1000;
      while (statusServer.terminalPostCount() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(statusServer.terminalPostCount(), 1);
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
        '{"action":"tool","tool_name":"repo_git","args":{"command":"git status --short"}}',
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
    assert.ok(lines.some((line) => /repo_search completed request_id=/u.test(line)), lines.join('\n'));
  });
});

test('executeRepoSearchRequest uses a four-minute default prompt timeout', () => {
  assert.equal(DEFAULT_REPO_SEARCH_PROMPT_TIMEOUT_MS, 240_000);
});

test('executeRepoSearchRequest fails with try-again error when prompt timeout expires', async () => {
  await withTestEnvAndServer(async ({ tempRoot }) => {
    await assert.rejects(
      () => executeRepoSearchRequest({
        prompt: 'find slow command',
        repoRoot: tempRoot,
        maxTurns: 2,
        promptTimeoutMs: 20,
        mockResponses: [
          '{"action":"tool","tool_name":"repo_git","args":{"command":"git status --short"}}',
          '{"action":"finish","output":"done","confidence":0.8}',
        ],
        mockCommandResults: {
          'git status --short': { exitCode: 0, stdout: '', stderr: '', delayMs: 200 },
        },
      }),
      /Repo search prompt exceeded 20 ms\. Please try again\./u,
    );
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
          res.write('data: {"choices":[{"delta":{"content":"{\\"action\\":\\"tool\\",\\"tool_name\\":\\"repo_git\\",\\"args\\":{\\"command\\":\\"git status --short\\"}}"}}]}\n\n');
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
