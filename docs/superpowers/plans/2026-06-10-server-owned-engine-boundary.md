# Server-Owned Engine Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use worktrees.

**Goal:** Make the status server the only owner of SiftKit engine execution while keeping the CLI as a thin HTTP client that may only capture local command output before sending it to the server.

**Architecture:** The CLI parses arguments, reads stdin/files, runs local commands when requested, and sends typed HTTP payloads to the status server. The server owns summary, repo-search, chat, preset execution, command-output analysis, artifact writes, DB writes, metrics, model queueing, deterministic fast paths, and repo-search executor loading through static imports. All client-side imports of engine modules are removed.

**Tech Stack:** TypeScript, Node HTTP, existing `httpClient`, `node:test`, `tsx`, existing status-server route style.

---

## Current Boundary Evidence

- `src/cli/run-summary.ts` imports `summarizeRequest`, `isPassFailQuestion`, and `parseDeterministicTestOutput`; deterministic command-output summaries currently execute locally.
- `src/cli/run-command.ts` imports `runCommand` and `summarizeRequest`; `runCommand` captures and analyzes output locally through `src/command.ts`.
- `src/cli/run-capture.ts` imports `runInteractiveCapture` and `summarizeRequest`; `runInteractiveCapture` captures and analyzes transcripts locally through `src/interactive.ts`.
- `src/cli/run-preset.ts` imports server config helpers, preset helpers, summary engine, repo-search engine, and status-server chat builders.
- `src/cli/run-internal.ts` imports `analyzeCommandOutput`, `runCommand`, `runEvaluation`, `runInteractiveCapture`, `executeRepoSearchRequest`, and `summarizeRequest`.
- `src/status-server/chat.ts` defines `loadRepoSearchExecutor()` with `require.resolve`, `delete require.cache[...]`, and runtime duck typing.
- `src/status-server/routes/core.ts` already owns `/summary` and `/repo-search`, but `/repo-search` reaches the engine through the dynamic loader.

## Target Boundary

Client allowed responsibilities:

- Parse CLI arguments.
- Read stdin and files needed to build request payloads.
- Execute local external commands for `siftkit run` and internal command-capture operations.
- Capture stdout, stderr, exit code, transcript text, and command text.
- Send typed HTTP requests to server endpoints.
- Format the returned server response for stdout.

Client forbidden responsibilities:

- Import `summary/core`, `summary/measure`, `summary/test-output`, `repo-search/*` engine modules, `command.ts` analysis helpers, `interactive.ts`, `eval.ts`, status-server chat builders, status-server config-store, or execution-lock code.
- Decide deterministic summary fast paths.
- Write runtime artifacts or run metrics.
- Build repo-search, plan, or chat system prompts.

Server-owned responsibilities:

- Summary execution and deterministic summary fast paths.
- Repo-search, plan, and chat execution.
- Preset resolution and preset prompt construction.
- Command-output analysis and artifact writes.
- Eval execution.
- Model request queueing and managed llama readiness.
- Runtime DB writes, metrics, status, artifacts, and diagnostic events.
- Static engine imports.

## File Structure

Create:

- `src/cli/status-server-api-client.ts` - explicit CLI HTTP client class with methods for summary, repo-search, preset run, command-output analysis, eval run, and config read.
- `src/cli/input.ts` - CLI-only text/file/stdin reader moved out of `summary/core`.
- `src/command-output/types.ts` - typed request/result shapes for command-output and transcript-output analysis.
- `src/eval-types.ts` - typed eval request/result shapes shared by CLI HTTP client and server engine without importing `eval.ts`.
- `src/command-output/analyzer.ts` - server-side `CommandOutputAnalyzer` class migrated from `src/command.ts` analysis logic.
- `src/status-server/engine-service.ts` - server-only class that statically imports and calls summary, repo-search, command-output analysis, and eval engines.
- `src/status-server/preset-runner.ts` - server-only class that resolves presets from config and calls `StatusEngineService`.
- `tests/cli-engine-boundary.test.ts` - static import-boundary tests.
- `tests/cli-http-boundary.test.ts` - runtime CLI HTTP-boundary tests.

Modify:

- `src/status-server/server-types.ts` - add `engineService: StatusEngineService`.
- `src/status-server/index.ts` - instantiate `StatusEngineService`.
- `src/status-server/chat.ts` - delete `loadRepoSearchExecutor()` and its type.
- `src/status-server/routes/core.ts` - use `ctx.engineService`; add `/command-output/analyze`, `/preset/run`, and `/eval/run`.
- `src/status-server/routes/chat.ts` - replace `loadRepoSearchExecutor()` calls with `ctx.engineService.executeRepoSearch(...)`.
- `src/cli/run-summary.ts` - always send `/summary`.
- `src/cli/run-command.ts` - run local command, POST output to `/command-output/analyze`.
- `src/cli/run-capture.ts` - capture local transcript, POST output to `/command-output/analyze`.
- `src/cli/run-preset.ts` - send `/preset/run`.
- `src/cli/run-internal.ts` - route engine-owning internal ops over HTTP.
- `src/cli/run-eval.ts` - send `/eval/run`.
- `src/cli/run-preset-list.ts` - read server-formatted preset list through HTTP.
- `src/cli/help.ts` - stop reading status-server config directly.
- `src/cli/dispatch.ts` and `src/cli/args.ts` - mark `summary`, `run`, `eval`, and `preset` execution paths as server-dependent where they need HTTP.
- `tests/_test-helpers.ts` - teach the stub server new routes.
- Existing CLI/server tests - update expectations that currently assume direct local engine execution.

Delete or shrink:

- `src/command.ts` - remove local analysis and `withExecutionLock`; keep no engine-owning public path.
- `src/interactive.ts` - remove local analysis path; keep no engine-owning public path.
- Any CLI tests that import `dist/command.js` as an engine API; replace with server route or analyzer unit tests.

---

### Task 1: Add Static Boundary Guard Tests

**Files:**

- Create: `tests/cli-engine-boundary.test.ts`

- [ ] **Step 1: Write the failing static boundary tests**

Create `tests/cli-engine-boundary.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

type SourceFile = {
  path: string;
  text: string;
};

const FORBIDDEN_CLI_IMPORTS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'summary engine', pattern: /from\s+['"]\.\.\/summary\/core\.js['"]/u },
  { label: 'summary deterministic helpers', pattern: /from\s+['"]\.\.\/summary\/(?:measure|test-output)\.js['"]/u },
  { label: 'repo-search engine', pattern: /from\s+['"]\.\.\/repo-search\/(?:index|execute)\.js['"]/u },
  { label: 'local command engine', pattern: /from\s+['"]\.\.\/command\.js['"]/u },
  { label: 'local interactive engine', pattern: /from\s+['"]\.\.\/interactive\.js['"]/u },
  { label: 'local eval engine', pattern: /from\s+['"]\.\.\/eval\.js['"]/u },
  { label: 'status-server internals', pattern: /from\s+['"]\.\.\/status-server\//u },
  { label: 'preset internals', pattern: /from\s+['"]\.\.\/presets\.js['"]/u },
  { label: 'execution lock', pattern: /from\s+['"]\.\.\/execution-lock\.js['"]/u },
];

function listTypeScriptFiles(root: string): SourceFile[] {
  const result: SourceFile[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push({
        path: fullPath.replace(/\\/gu, '/'),
        text: fs.readFileSync(fullPath, 'utf8'),
      });
    }
  }
  return result;
}

test('CLI modules do not import engine or status-server internals', () => {
  const cliFiles = listTypeScriptFiles(path.join(process.cwd(), 'src', 'cli'));
  const violations: string[] = [];

  for (const file of cliFiles) {
    for (const rule of FORBIDDEN_CLI_IMPORTS) {
      if (rule.pattern.test(file.text)) {
        violations.push(`${file.path}: forbidden ${rule.label}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('status server does not dynamically load repo-search engine', () => {
  const statusServerFiles = listTypeScriptFiles(path.join(process.cwd(), 'src', 'status-server'));
  const violations = statusServerFiles
    .filter((file) => /require\.cache|require\.resolve\(['"]\.\.\/repo-search\/index\.js['"]\)|loadRepoSearchExecutor/u.test(file.text))
    .map((file) => file.path);

  assert.deepEqual(violations, []);
});
```

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```powershell
npm test -- tests/cli-engine-boundary.test.ts
```

Expected: FAIL. The failure lists current CLI imports in `src/cli/run-summary.ts`, `src/cli/run-command.ts`, `src/cli/run-capture.ts`, `src/cli/run-preset.ts`, `src/cli/run-internal.ts`, `src/cli/run-eval.ts`, `src/cli/run-preset-list.ts`, `src/cli/help.ts`, and dynamic loading in `src/status-server/chat.ts`.

- [ ] **Step 3: Commit the failing boundary tests**

```powershell
git add tests/cli-engine-boundary.test.ts
git commit -m "test: add CLI engine boundary guards"
```

---

### Task 2: Add Runtime HTTP Boundary Tests

**Files:**

- Create: `tests/cli-http-boundary.test.ts`
- Modify: `tests/_test-helpers.ts`

- [ ] **Step 1: Write the failing runtime tests**

Create `tests/cli-http-boundary.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { runCli } from '../dist/cli/index.js';
import { getDefaultConfig } from '../dist/status-server/config-store.js';
import { makeCaptureStream } from './_test-helpers.js';

type CapturedRequest = {
  route: string;
  body: Record<string, unknown>;
};

type BoundaryServer = {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function startBoundaryServer(): Promise<BoundaryServer> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      const config = getDefaultConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }

    if (req.method === 'GET' && req.url === '/preset/list') {
      requests.push({ route: '/preset/list', body: {} });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        presets: [
          { id: 'summary', presetKind: 'summary', operationMode: 'summary', deletable: false, label: 'Summary' },
        ],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/summary') {
      const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
      requests.push({ route: '/summary', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        RequestId: 'summary-boundary',
        WasSummarized: false,
        PolicyDecision: 'deterministic-test-output',
        Backend: 'mock',
        Model: 'mock-model',
        Summary: 'server summary response',
        Classification: 'summary',
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        ProviderError: null,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/command-output/analyze') {
      const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
      requests.push({ route: '/command-output/analyze', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ExitCode: Number(body.exitCode || 0),
        RawLogPath: 'db://command-output/raw',
        ReducedLogPath: null,
        WasSummarized: false,
        PolicyDecision: 'no-summarize',
        Classification: 'no-summarize',
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        ProviderError: null,
        Summary: 'server command analysis',
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
      requests.push({ route: '/repo-search', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        requestId: 'repo-boundary',
        transcriptPath: 'db://repo-search/transcript',
        artifactPath: 'db://repo-search/artifact',
        scorecard: { tasks: [{ finalOutput: 'server repo-search response' }] },
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/preset/run') {
      const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
      requests.push({ route: '/preset/run', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ outputText: 'server preset response' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/eval/run') {
      const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>;
      requests.push({ route: '/eval/run', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Backend: 'mock',
        Model: 'mock-model',
        ResultPath: 'db://eval/result',
        Results: [],
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    requests,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function withBoundaryServer(fn: (server: BoundaryServer) => Promise<void>): Promise<void> {
  const server = await startBoundaryServer();
  const previousStatusUrl = process.env.SIFTKIT_STATUS_BACKEND_URL;
  const previousConfigUrl = process.env.SIFTKIT_CONFIG_SERVICE_URL;
  const previousSourceKind = process.env.SIFTKIT_SUMMARY_SOURCE_KIND;
  const previousExitCode = process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE;
  process.env.SIFTKIT_STATUS_BACKEND_URL = `${server.baseUrl}/status`;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = `${server.baseUrl}/config`;
  try {
    await fn(server);
  } finally {
    if (previousStatusUrl === undefined) delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    else process.env.SIFTKIT_STATUS_BACKEND_URL = previousStatusUrl;
    if (previousConfigUrl === undefined) delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    else process.env.SIFTKIT_CONFIG_SERVICE_URL = previousConfigUrl;
    if (previousSourceKind === undefined) delete process.env.SIFTKIT_SUMMARY_SOURCE_KIND;
    else process.env.SIFTKIT_SUMMARY_SOURCE_KIND = previousSourceKind;
    if (previousExitCode === undefined) delete process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE;
    else process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = previousExitCode;
    await server.close();
  }
}

test('summary pass/fail command output is delegated to the server', async () => {
  await withBoundaryServer(async (server) => {
    process.env.SIFTKIT_SUMMARY_SOURCE_KIND = 'command-output';
    process.env.SIFTKIT_SUMMARY_COMMAND_EXIT_CODE = '0';
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['summary', '--question', 'Did the tests pass?'],
      stdinText: 'PASS tests/unit/example.test.ts\n',
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'server summary response\n');
    assert.equal(stderr.read(), '');
    assert.equal(server.requests.filter((request) => request.route === '/summary').length, 1);
    assert.equal(server.requests[0].body.sourceKind, 'command-output');
    assert.equal(server.requests[0].body.commandExitCode, 0);
  });
});

test('run command executes locally and sends captured output to server', async () => {
  await withBoundaryServer(async (server) => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: [
        'run',
        '--command',
        'node',
        '--arg',
        '-e',
        '--arg',
        'process.stdout.write("client-ran-command")',
        '--question',
        'What happened?',
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.match(stdout.read(), /server command analysis/u);
    assert.equal(stderr.read(), '');
    const commandRequest = server.requests.find((request) => request.route === '/command-output/analyze');
    assert.ok(commandRequest);
    assert.equal(commandRequest.body.combinedText, 'client-ran-command');
    assert.equal(commandRequest.body.exitCode, 0);
    assert.match(String(commandRequest.body.commandText), /^node -e/u);
  });
});

test('repo-search internal op posts to the server endpoint', async () => {
  await withBoundaryServer(async (server) => {
    const requestFile = `${process.cwd()}\\tmp-cli-boundary-repo-search.json`;
    await import('node:fs').then((fs) => fs.writeFileSync(requestFile, JSON.stringify({
      Prompt: 'find planner tools',
      RepoRoot: process.cwd(),
      MaxTurns: 1,
    }), 'utf8'));
    try {
      const stdout = makeCaptureStream();
      const stderr = makeCaptureStream();
      const code = await runCli({
        argv: ['internal', '--op', 'repo-search', '--request-file', requestFile],
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      assert.equal(code, 0);
      assert.equal(stderr.read(), '');
      assert.match(stdout.read(), /repo-boundary/u);
      const repoRequest = server.requests.find((request) => request.route === '/repo-search');
      assert.ok(repoRequest);
      assert.equal(repoRequest.body.prompt, 'find planner tools');
    } finally {
      await import('node:fs').then((fs) => fs.rmSync(requestFile, { force: true }));
    }
  });
});

test('run preset posts unresolved preset execution to the server', async () => {
  await withBoundaryServer(async (server) => {
    const stdout = makeCaptureStream();
    const stderr = makeCaptureStream();
    const code = await runCli({
      argv: ['run', '--preset', 'summary', '--question', 'What happened?', '--text', 'Build output'],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(code, 0);
    assert.equal(stdout.read(), 'server preset response\n');
    assert.equal(stderr.read(), '');
    const presetRequest = server.requests.find((request) => request.route === '/preset/run');
    assert.ok(presetRequest);
    assert.equal(presetRequest.body.presetId, 'summary');
    assert.equal(presetRequest.body.question, 'What happened?');
    assert.equal(presetRequest.body.inputText, 'Build output');
  });
});
```

- [ ] **Step 2: Add new stub-server routes for existing tests**

In `tests/_test-helpers.ts`, inside `startMiniStubServer`, add handlers after the existing `/summary` handler:

```ts
    if (req.method === 'POST' && req.url === '/command-output/analyze') {
      const bodyText = await readBody(req);
      const parsed = (bodyText ? JSON.parse(bodyText) : {}) as Dict;
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ExitCode: Number(parsed.exitCode || 0),
        RawLogPath: 'db://command-output/raw',
        ReducedLogPath: null,
        WasSummarized: false,
        PolicyDecision: 'no-summarize',
        Classification: 'no-summarize',
        RawReviewRequired: false,
        ModelCallSucceeded: false,
        ProviderError: null,
        Summary: 'mock command output analysis',
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/repo-search') {
      const bodyText = await readBody(req);
      const parsed = (bodyText ? JSON.parse(bodyText) : {}) as Dict;
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        requestId: 'stub-repo-search',
        transcriptPath: 'db://repo-search/transcript',
        artifactPath: 'db://repo-search/artifact',
        scorecard: { tasks: [{ finalOutput: 'stub repo-search output' }] },
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/preset/run') {
      const bodyText = await readBody(req);
      const parsed = (bodyText ? JSON.parse(bodyText) : {}) as Dict;
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ outputText: 'mock preset output' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/preset/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        presets: [
          { id: 'summary', presetKind: 'summary', operationMode: 'summary', deletable: false, label: 'Summary' },
        ],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/eval/run') {
      const bodyText = await readBody(req);
      const parsed = (bodyText ? JSON.parse(bodyText) : {}) as Dict;
      state.chatRequests.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Backend: 'mock',
        Model: 'mock-model',
        ResultPath: 'db://eval/result',
        Results: [],
      }));
      return;
    }
```

- [ ] **Step 3: Run runtime boundary tests and verify they fail**

Run:

```powershell
npm test -- tests/cli-http-boundary.test.ts
```

Expected: FAIL. `summary` pass/fail does not POST, `run` does not POST `/command-output/analyze`, internal repo-search runs directly, and preset execution is resolved client-side.

- [ ] **Step 4: Commit the failing runtime tests**

```powershell
git add tests/cli-http-boundary.test.ts tests/_test-helpers.ts
git commit -m "test: capture CLI HTTP execution boundary"
```

---

### Task 3: Add Typed CLI Input Reader and Status Server API Client

**Files:**

- Create: `src/cli/input.ts`
- Create: `src/cli/status-server-api-client.ts`
- Modify: `src/lib/http-client.ts`

- [ ] **Step 1: Move input reading out of summary engine**

Create `src/cli/input.ts`:

```ts
import * as fs from 'node:fs';
import { decodeTextBuffer } from '../lib/text-encoding.js';
import { normalizeInputText } from '../summary/measure.js';

export function readCliTextInput(options: {
  text?: string;
  file?: string;
  stdinText?: string | Buffer;
}): string | null {
  if (options.text !== undefined) {
    return normalizeInputText(options.text);
  }

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      if (options.stdinText !== undefined) {
        return normalizeInputText(
          Buffer.isBuffer(options.stdinText)
            ? decodeTextBuffer(options.stdinText)
            : options.stdinText,
        );
      }
      throw new Error(`Input file not found: ${options.file}`);
    }
    return normalizeInputText(decodeTextBuffer(fs.readFileSync(options.file)));
  }

  if (options.stdinText !== undefined) {
    return normalizeInputText(
      Buffer.isBuffer(options.stdinText)
        ? decodeTextBuffer(options.stdinText)
        : options.stdinText,
    );
  }

  return null;
}
```

- [ ] **Step 2: Add shared eval types**

Create `src/eval-types.ts`:

```ts
import type { SummaryClassification } from './summary/types.js';

export type EvalRequest = {
  FixtureRoot?: string;
  RealLogPath?: string[];
  Backend?: string;
  Model?: string;
};

export type EvalCaseResult = {
  Name: string;
  SourcePath: string;
  WasSummarized: boolean;
  PolicyDecision: string;
  Classification: SummaryClassification;
  RawReviewRequired: boolean;
  ModelCallSucceeded: boolean;
  Summary: string;
  Recall: number | null;
  Precision: number | null;
  Faithfulness: number | null;
  Format: number | null;
  Compression: number | null;
  Total: number | null;
  Notes: string;
};

export type EvaluationResult = {
  Backend: string;
  Model: string;
  ResultPath: string;
  Results: EvalCaseResult[];
};
```

In `src/eval.ts`, remove local `EvalRequest`, `EvalCaseResult`, and `EvaluationResult` type declarations and import them:

```ts
import type { EvalCaseResult, EvalRequest, EvaluationResult } from './eval-types.js';
```

- [ ] **Step 3: Add command-output types used by the API client**

Create `src/command-output/types.ts`:

```ts
import type { ShellName } from '../capture/process.js';
import type { SummaryClassification, SummaryPolicyProfile } from '../summary/types.js';

export type CommandOutputKind = 'command' | 'interactive';

export type CommandOutputRiskLevel = 'informational' | 'debug' | 'risky';

export type CommandOutputReducerProfile = 'smart' | 'errors' | 'tail' | 'diff' | 'none';

export type CommandOutputAnalyzeRequest = {
  outputKind: CommandOutputKind;
  exitCode: number;
  combinedText: string;
  commandText?: string;
  question?: string;
  riskLevel?: CommandOutputRiskLevel;
  reducerProfile?: CommandOutputReducerProfile;
  format?: 'text' | 'json';
  policyProfile?: SummaryPolicyProfile;
  backend?: string;
  model?: string;
  noSummarize?: boolean;
  shell?: ShellName;
};

export type CommandOutputAnalyzeResult = {
  ExitCode: number;
  RawLogPath: string;
  ReducedLogPath: string | null;
  WasSummarized: boolean;
  PolicyDecision: string;
  Classification: SummaryClassification | 'no-summarize';
  RawReviewRequired: boolean;
  ModelCallSucceeded: boolean;
  ProviderError: string | null;
  Summary: string | null;
};

export type PresetRunRequest = {
  presetId: string;
  prompt?: string;
  question?: string;
  inputText?: string;
  format?: 'text' | 'json';
  backend?: string;
  model?: string;
  profile?: string;
  repoRoot?: string;
  maxTurns?: number;
  logFile?: string;
};

export type PresetRunResult = {
  outputText: string;
};

export type PresetListItem = {
  id: string;
  presetKind: string;
  operationMode: string;
  deletable: boolean;
  label: string;
};

export type PresetListResult = {
  presets: PresetListItem[];
};
```

- [ ] **Step 4: Extend HTTP client logging task names**

In `src/lib/http-client.ts`, replace:

```ts
export type LoggedHttpClientTask = 'repo-search' | 'summary';
```

with:

```ts
export type LoggedHttpClientTask = 'repo-search' | 'summary' | 'command-output' | 'preset' | 'eval';
```

Replace `getLoggedHttpClientTask` with:

```ts
function getLoggedHttpClientTask(target: URL): LoggedHttpClientTask | null {
  if (target.pathname === '/repo-search') {
    return 'repo-search';
  }
  if (target.pathname === '/summary') {
    return 'summary';
  }
  if (target.pathname === '/command-output/analyze') {
    return 'command-output';
  }
  if (target.pathname === '/preset/run') {
    return 'preset';
  }
  if (target.pathname === '/eval/run') {
    return 'eval';
  }
  return null;
}
```

- [ ] **Step 5: Create explicit API client class**

Create `src/cli/status-server-api-client.ts`:

```ts
import {
  getStatusBackendUrl,
  getStatusServerUnavailableMessage,
} from '../config/index.js';
import {
  httpClient,
  logHttpClientBoundary,
  type HttpClient,
  type LoggedHttpClientTask,
} from '../lib/http-client.js';
import type { SiftConfig } from '../config/index.js';
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
import type { SummaryRequest, SummaryResult } from '../summary/types.js';
import type {
  CommandOutputAnalyzeRequest,
  CommandOutputAnalyzeResult,
  PresetListResult,
  PresetRunRequest,
  PresetRunResult,
} from '../command-output/types.js';
import type { EvalRequest, EvaluationResult } from '../eval-types.js';

const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class StatusServerApiClient {
  private readonly client: HttpClient;

  constructor(client: HttpClient = httpClient) {
    this.client = client;
  }

  async getConfig(): Promise<SiftConfig> {
    return this.requestConfig();
  }

  async requestSummary(request: SummaryRequest): Promise<SummaryResult> {
    const startedAt = Date.now();
    const result = await this.postSummary(request);
    logHttpClientBoundary(
      'summary',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  async requestRepoSearch(request: Record<string, unknown>): Promise<RepoSearchExecutionResult> {
    const startedAt = Date.now();
    const result = await this.postRepoSearch(request);
    logHttpClientBoundary(
      'repo-search',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  async analyzeCommandOutput(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    const startedAt = Date.now();
    const result = await this.postCommandOutput(request);
    logHttpClientBoundary(
      'command-output',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  async runPreset(request: PresetRunRequest): Promise<PresetRunResult> {
    const startedAt = Date.now();
    const result = await this.postPresetRun(request);
    logHttpClientBoundary(
      'preset',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  async listPresets(): Promise<PresetListResult> {
    return this.requestPresetList();
  }

  async runEvaluation(request: EvalRequest): Promise<EvaluationResult> {
    const startedAt = Date.now();
    const result = await this.postEvalRun(request);
    logHttpClientBoundary(
      'eval',
      'caller_response_received',
      `elapsed_ms=${Math.max(0, Date.now() - startedAt)} no_awaited_flush_before_next=true`,
    );
    return result;
  }

  private getServiceUrl(pathname: string): string {
    const target = new URL(getStatusBackendUrl());
    target.pathname = pathname;
    target.search = '';
    target.hash = '';
    return target.toString();
  }

  private async requestConfig(): Promise<SiftConfig> {
    try {
      return await this.client.requestJson<SiftConfig>({
        url: this.getServiceUrl('/config'),
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postSummary(request: SummaryRequest): Promise<SummaryResult> {
    try {
      return await this.client.requestJson<SummaryResult>({
        url: this.getServiceUrl('/summary'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postRepoSearch(request: Record<string, unknown>): Promise<RepoSearchExecutionResult> {
    try {
      return await this.client.requestJson<RepoSearchExecutionResult>({
        url: this.getServiceUrl('/repo-search'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postCommandOutput(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    try {
      return await this.client.requestJson<CommandOutputAnalyzeResult>({
        url: this.getServiceUrl('/command-output/analyze'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postPresetRun(request: PresetRunRequest): Promise<PresetRunResult> {
    try {
      return await this.client.requestJson<PresetRunResult>({
        url: this.getServiceUrl('/preset/run'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async requestPresetList(): Promise<PresetListResult> {
    try {
      return await this.client.requestJson<PresetListResult>({
        url: this.getServiceUrl('/preset/list'),
        method: 'GET',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private async postEvalRun(request: EvalRequest): Promise<EvaluationResult> {
    try {
      return await this.client.requestJson<EvaluationResult>({
        url: this.getServiceUrl('/eval/run'),
        method: 'POST',
        timeoutMs: DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/^HTTP \d+:/u.test(message)) {
      return error instanceof Error ? error : new Error(message);
    }
    if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|timed out|socket hang up/iu.test(message)) {
      return new Error(getStatusServerUnavailableMessage());
    }
    return error instanceof Error ? error : new Error(message);
  }
}
```

- [ ] **Step 6: Run focused typecheck and test**

Run:

```powershell
npm run typecheck
npm test -- tests/cli-engine-boundary.test.ts
```

Expected: `typecheck` passes. Boundary test still fails because callers are not refactored yet.

- [ ] **Step 7: Commit the API client**

```powershell
git add src/cli/input.ts src/cli/status-server-api-client.ts src/command-output/types.ts src/eval-types.ts src/eval.ts src/lib/http-client.ts
git commit -m "feat: add typed status server API client"
```

---

### Task 4: Add Server Engine Service and Remove Dynamic Repo-Search Loading

**Files:**

- Create: `src/status-server/engine-service.ts`
- Modify: `src/status-server/server-types.ts`
- Modify: `src/status-server/index.ts`
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/status-server/routes/chat.ts`

- [ ] **Step 1: Create the static engine service**

Create `src/status-server/engine-service.ts`:

```ts
import { executeRepoSearchRequest } from '../repo-search/index.js';
import type {
  RepoSearchExecutionRequest,
  RepoSearchExecutionResult,
} from '../repo-search/types.js';
import { summarizeRequest } from '../summary/core.js';
import type { SummaryRequest, SummaryResult } from '../summary/types.js';
import { runEvaluation } from '../eval.js';
import type { EvalRequest, EvaluationResult } from '../eval-types.js';
import { CommandOutputAnalyzer } from '../command-output/analyzer.js';
import type {
  CommandOutputAnalyzeRequest,
  CommandOutputAnalyzeResult,
} from '../command-output/types.js';

export class StatusEngineService {
  private readonly commandOutputAnalyzer: CommandOutputAnalyzer;

  constructor(commandOutputAnalyzer: CommandOutputAnalyzer = new CommandOutputAnalyzer()) {
    this.commandOutputAnalyzer = commandOutputAnalyzer;
  }

  executeRepoSearch(request: RepoSearchExecutionRequest): Promise<RepoSearchExecutionResult> {
    return executeRepoSearchRequest(request);
  }

  summarize(request: SummaryRequest): Promise<SummaryResult> {
    return summarizeRequest(request);
  }

  analyzeCommandOutput(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    return this.commandOutputAnalyzer.analyze(request);
  }

  runEvaluation(request: EvalRequest): Promise<EvaluationResult> {
    return runEvaluation(request);
  }
}
```

This step intentionally fails until `src/command-output/analyzer.ts` exists in Task 5. Keep the file staged only when Task 5 is complete if the build is required between tasks.

- [ ] **Step 2: Add service to `ServerContext`**

In `src/status-server/server-types.ts`, add:

```ts
import type { StatusEngineService } from './engine-service.js';
```

Then add to `ServerContext`:

```ts
  readonly engineService: StatusEngineService;
```

- [ ] **Step 3: Instantiate the service**

In `src/status-server/index.ts`, add:

```ts
import { StatusEngineService } from './engine-service.js';
```

In the `ctx: ServerContext` initializer, add:

```ts
    engineService: new StatusEngineService(),
```

- [ ] **Step 4: Replace dynamic repo-search loading in core route**

In `src/status-server/routes/core.ts`, remove:

```ts
import { loadRepoSearchExecutor } from '../chat.js';
```

Replace:

```ts
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const config = readConfig(configPath);
      const result = await executeRepoSearchRequest({
```

with:

```ts
      const config = readConfig(configPath);
      const result = await ctx.engineService.executeRepoSearch({
```

- [ ] **Step 5: Replace dynamic repo-search loading in chat route**

In `src/status-server/routes/chat.ts`, remove `loadRepoSearchExecutor` from the import from `../chat.js`.

Replace each of these patterns:

```ts
      const executeRepoSearchRequest = loadRepoSearchExecutor();
      const result = await executeRepoSearchRequest({
```

with:

```ts
      const result = await ctx.engineService.executeRepoSearch({
```

Apply this to all route branches currently calling `loadRepoSearchExecutor()`.

- [ ] **Step 6: Delete dynamic loader**

In `src/status-server/chat.ts`, delete:

```ts
export type RepoSearchExecuteFn = (request: Dict) => Promise<RepoSearchExecutionResult>;

export function loadRepoSearchExecutor(): RepoSearchExecuteFn {
  const modulePath = require.resolve('../repo-search/index.js');
  delete require.cache[modulePath];
  const loadedModule = require(modulePath) as { executeRepoSearchRequest?: unknown };
  if (!loadedModule || typeof loadedModule.executeRepoSearchRequest !== 'function') {
    throw new Error('repo-search module does not export executeRepoSearchRequest.');
  }
  return loadedModule.executeRepoSearchRequest as RepoSearchExecuteFn;
}
```

Remove now-unused imports from `src/status-server/chat.ts`:

```ts
import type { RepoSearchExecutionResult } from '../repo-search/types.js';
```

- [ ] **Step 7: Run focused validation**

Run:

```powershell
npm run typecheck
npm test -- tests/cli-engine-boundary.test.ts
```

Expected: typecheck may still fail until Task 5 adds `CommandOutputAnalyzer`. Boundary test should stop reporting `require.cache` and `loadRepoSearchExecutor` once Task 5 compiles.

- [ ] **Step 8: Commit after Task 5 compiles this service**

Use the combined commit in Task 5 if this task cannot compile alone.

---

### Task 5: Move Command-Output Analysis Into Server-Owned Analyzer

**Files:**

- Create: `src/command-output/analyzer.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `tests/command.test.ts`
- Modify: `tests/summary-status-server.test.ts`

- [ ] **Step 1: Create server-owned analyzer**

Create `src/command-output/analyzer.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { getConfiguredModel, initializeRuntime, loadConfig } from '../config/index.js';
import { summarizeRequest } from '../summary/core.js';
import { getDeterministicExcerpt } from '../summary/measure.js';
import { getSummaryDecision } from '../summary/decision.js';
import { upsertRuntimeTextArtifact } from '../state/runtime-artifacts.js';
import type {
  CommandOutputAnalyzeRequest,
  CommandOutputAnalyzeResult,
  CommandOutputReducerProfile,
} from './types.js';

function compressRepeatedLines(lines: string[]): string[] {
  if (lines.length === 0) {
    return [];
  }

  const result: string[] = [];
  let current = lines[0];
  let count = 1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === current) {
      count += 1;
      continue;
    }
    if (count > 3) {
      result.push(`${current} [repeated ${count} times]`);
    } else {
      for (let repeat = 0; repeat < count; repeat += 1) {
        result.push(current);
      }
    }
    current = lines[index];
    count = 1;
  }

  if (count > 3) {
    result.push(`${current} [repeated ${count} times]`);
  } else {
    for (let repeat = 0; repeat < count; repeat += 1) {
      result.push(current);
    }
  }

  return result;
}

function getErrorContextLines(lines: string[]): string[] {
  const pattern = /(error|exception|failed|fatal|denied|timeout|traceback|panic|duplicate key|destroy)/iu;
  const indexes = lines.reduce<number[]>((result, line, index) => {
    if (pattern.test(line)) {
      result.push(index);
    }
    return result;
  }, []);

  if (indexes.length === 0) {
    return [];
  }

  const selected: string[] = [];
  const seen = new Set<number>();
  for (const index of indexes) {
    const start = Math.max(index - 2, 0);
    const end = Math.min(index + 2, lines.length - 1);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (!seen.has(cursor)) {
        seen.add(cursor);
        selected.push(lines[cursor]);
      }
    }
  }

  return selected;
}

function reduceText(text: string, reducerProfile: CommandOutputReducerProfile): string {
  if (reducerProfile === 'none') {
    return text;
  }

  const lines = text.length > 0 ? text.replace(/\r\n/gu, '\n').split('\n') : [];
  if (lines.length <= 200) {
    return text;
  }

  const compressed = compressRepeatedLines(lines);
  switch (reducerProfile) {
    case 'errors': {
      const context = getErrorContextLines(compressed);
      return context.length > 0 ? context.join('\n') : compressed.slice(-120).join('\n');
    }
    case 'tail':
      return compressed.slice(-160).join('\n');
    case 'diff': {
      const diffLines = compressed.filter((line) => /^(diff --git|\+\+\+|---|@@|\+[^+]|-[^-]|index\s|rename |new file mode|deleted file mode)/u.test(line));
      return diffLines.length > 0 ? diffLines.join('\n') : compressed.slice(0, 80).join('\n');
    }
    default: {
      const context = getErrorContextLines(compressed);
      if (context.length > 0) {
        return [...compressed.slice(0, 20), '', ...context, '', ...compressed.slice(-40)].join('\n');
      }
      return [...compressed.slice(0, 40), '', ...compressed.slice(-80)].join('\n');
    }
  }
}

export class CommandOutputAnalyzer {
  async analyze(request: CommandOutputAnalyzeRequest): Promise<CommandOutputAnalyzeResult> {
    const config = await loadConfig({ ensure: true });
    const backend = request.backend || config.Backend;
    const model = request.model || getConfiguredModel(config);
    void initializeRuntime();

    const maxInteractiveCharacters = Number(config.Interactive?.MaxTranscriptCharacters || 0);
    const combinedText = request.outputKind === 'interactive' && maxInteractiveCharacters > 0 && request.combinedText.length > maxInteractiveCharacters
      ? request.combinedText.substring(request.combinedText.length - maxInteractiveCharacters)
      : request.combinedText || '';
    const rawArtifactKind = request.outputKind === 'interactive' ? 'interactive_raw' : 'command_raw';
    const reducedArtifactKind = request.outputKind === 'interactive' ? 'interactive_reduced' : 'command_reduced';
    const rawLogPath = upsertRuntimeTextArtifact({
      id: randomUUID(),
      artifactKind: rawArtifactKind,
      content: combinedText,
    }).uri;

    const question = request.question || 'Summarize the main result and any actionable failures.';
    const riskLevel = request.riskLevel || 'informational';
    const reducerProfile = request.reducerProfile || 'smart';
    const format = request.format || 'text';
    const policyProfile = request.policyProfile || 'general';
    const decision = getSummaryDecision(combinedText, question, riskLevel, config, {
      sourceKind: 'command-output',
      commandExitCode: request.exitCode,
    });
    const reducedText = reduceText(combinedText, reducerProfile);
    const deterministicExcerpt = getDeterministicExcerpt(combinedText, question);

    let reducedLogPath: string | null = null;
    if (reducedText !== combinedText) {
      reducedLogPath = upsertRuntimeTextArtifact({
        id: randomUUID(),
        artifactKind: reducedArtifactKind,
        content: reducedText,
      }).uri;
    }

    if (request.noSummarize || !decision.ShouldSummarize) {
      return {
        ExitCode: request.exitCode,
        RawLogPath: rawLogPath,
        ReducedLogPath: reducedLogPath,
        WasSummarized: false,
        PolicyDecision: request.noSummarize ? 'no-summarize' : decision.Reason,
        Classification: 'no-summarize',
        RawReviewRequired: decision.RawReviewRequired,
        ModelCallSucceeded: false,
        ProviderError: null,
        Summary: deterministicExcerpt ? `Raw review required.\nRaw log: ${rawLogPath}\n${deterministicExcerpt}` : null,
      };
    }

    const effectiveProfile = ((riskLevel === 'debug' || riskLevel === 'risky') && policyProfile === 'general')
      ? 'risky-operation'
      : policyProfile;
    const summaryResult = await summarizeRequest({
      question,
      inputText: combinedText,
      format,
      policyProfile: effectiveProfile,
      backend,
      model,
      sourceKind: 'command-output',
      commandExitCode: request.exitCode,
      debugCommand: request.commandText,
      skipExecutionLock: true,
      config,
    });
    const summaryText = summaryResult.RawReviewRequired && summaryResult.Classification !== 'unsupported_input' && summaryResult.Summary.trim()
      ? `${summaryResult.Summary.trim()}\nRaw log: ${rawLogPath}`
      : summaryResult.Summary;

    return {
      ExitCode: request.exitCode,
      RawLogPath: rawLogPath,
      ReducedLogPath: reducedLogPath,
      WasSummarized: summaryResult.WasSummarized,
      PolicyDecision: summaryResult.PolicyDecision,
      Classification: summaryResult.Classification,
      RawReviewRequired: summaryResult.RawReviewRequired,
      ModelCallSucceeded: summaryResult.ModelCallSucceeded,
      ProviderError: summaryResult.ProviderError,
      Summary: summaryText,
    };
  }
}
```

- [ ] **Step 2: Add `/command-output/analyze` route**

In `src/status-server/routes/core.ts`, add this helper near the other normalizers:

```ts
function normalizeCommandOutputKind(value: unknown): 'command' | 'interactive' {
  return value === 'interactive' ? 'interactive' : 'command';
}

function normalizeCommandOutputRiskLevel(value: unknown): 'informational' | 'debug' | 'risky' | undefined {
  return value === 'informational' || value === 'debug' || value === 'risky' ? value : undefined;
}

function normalizeCommandOutputReducerProfile(value: unknown): 'smart' | 'errors' | 'tail' | 'diff' | 'none' | undefined {
  return value === 'smart' || value === 'errors' || value === 'tail' || value === 'diff' || value === 'none' ? value : undefined;
}
```

Add this route before `/repo-search`:

```ts
  if (req.method === 'POST' && req.url === '/command-output/analyze') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const combinedText = typeof parsedBody.combinedText === 'string' ? parsedBody.combinedText : '';
    const exitCode = Number.isFinite(Number(parsedBody.exitCode)) ? Number(parsedBody.exitCode) : 1;
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 503, { error: 'Timed out waiting for model request queue.', modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return true;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return true;
      }
      const result = await ctx.engineService.analyzeCommandOutput({
        outputKind: normalizeCommandOutputKind(parsedBody.outputKind),
        exitCode,
        combinedText,
        commandText: getOptionalString(parsedBody.commandText),
        question: getOptionalString(parsedBody.question),
        riskLevel: normalizeCommandOutputRiskLevel(parsedBody.riskLevel),
        reducerProfile: normalizeCommandOutputReducerProfile(parsedBody.reducerProfile),
        format: normalizeSummaryFormat(parsedBody.format),
        policyProfile: normalizeSummaryPolicyProfile(parsedBody.policyProfile),
        backend: getOptionalString(parsedBody.backend),
        model: getOptionalString(parsedBody.model),
        noSummarize: parsedBody.noSummarize === true,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return true;
  }
```

- [ ] **Step 3: Move command analyzer tests**

In `tests/command.test.ts`, replace imports:

```ts
import { analyzeCommandOutput, runCommand } from '../dist/command.js';
```

with:

```ts
import { CommandOutputAnalyzer } from '../dist/command-output/analyzer.js';
import { invokeProcess, invokeShellProcess } from '../dist/capture/process.js';
```

Add helper:

```ts
function createAnalyzer(): CommandOutputAnalyzer {
  return new CommandOutputAnalyzer();
}
```

For every `analyzeCommandOutput({ ... })` call, replace it with:

```ts
const result = await createAnalyzer().analyze({
  outputKind: 'command',
  exitCode: 0,
  combinedText: 'Build completed successfully.\nAll 42 tests passed.',
  question: 'Did the build pass?',
  noSummarize: true,
});
```

Use lower-camel-case request properties exactly as defined in `CommandOutputAnalyzeRequest`.

For `runCommand invokes a real command and produces a result`, replace the test body with:

```ts
const processResult = invokeProcess('node', ['-e', 'console.log("hello from test")']);
const result = await createAnalyzer().analyze({
  outputKind: 'command',
  exitCode: processResult.ExitCode,
  combinedText: processResult.Combined,
  commandText: 'node -e console.log("hello from test")',
  question: 'What was printed?',
  noSummarize: true,
});
assert.equal(result.ExitCode, 0);
assert.equal(result.WasSummarized, false);
assert.equal(typeof result.RawLogPath, 'string');
```

For the shell-mode test, replace direct `runCommand` with:

```ts
const script = process.platform === 'win32'
  ? '$x = ""; if ($x) { Write-Output "non-empty" } else { Write-Output "shell-mode-clean" }'
  : 'x=""; if [ -z "$x" ]; then echo shell-mode-clean; else echo non-empty; fi';
const processResult = invokeShellProcess(script, 'auto');
const result = await createAnalyzer().analyze({
  outputKind: 'command',
  exitCode: processResult.ExitCode,
  combinedText: processResult.Combined,
  commandText: `[auto] ${script}`,
  question: 'What was printed?',
  noSummarize: true,
  shell: 'auto',
});
assert.equal(result.ExitCode, 0);
assert.equal(result.WasSummarized, false);
assert.equal(typeof result.RawLogPath, 'string');
```

- [ ] **Step 4: Add server route integration test**

In `tests/summary-status-server.test.ts`, add:

```ts
test('command-output endpoint analyzes captured command output on the server', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-command-output-route-'));
  const previousCwd = process.cwd();
  fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'siftkit', version: '0.1.0' }), 'utf8');
  process.chdir(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup: Record<string, string | undefined> = {
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
  };
  process.env.sift_kit_status = statusPath;
  process.env.SIFTKIT_STATUS_PATH = statusPath;
  process.env.SIFTKIT_CONFIG_PATH = configPath;
  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';

  const server = startStatusServer({ disableManagedLlamaStartup: true });
  await server.startupPromise;
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await requestJson(`${baseUrl}/command-output/analyze`, {
      method: 'POST',
      body: JSON.stringify({
        outputKind: 'command',
        exitCode: 0,
        combinedText: 'Build completed. All tests passed.',
        question: 'Did it pass?',
        noSummarize: true,
      }),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ExitCode, 0);
    assert.equal(response.body.WasSummarized, false);
    assert.equal(typeof response.body.RawLogPath, 'string');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm test -- tests/command.test.ts tests/summary-status-server.test.ts tests/cli-engine-boundary.test.ts
```

Expected: command analyzer tests and command-output route pass. Static boundary still fails until CLI callers are refactored.

- [ ] **Step 6: Commit command-output server analysis**

```powershell
git add src/command-output src/status-server tests/command.test.ts tests/summary-status-server.test.ts
git commit -m "feat: move command output analysis to status server"
```

---

### Task 6: Refactor Summary and Repo-Search CLI to HTTP Client

**Files:**

- Modify: `src/cli/run-summary.ts`
- Modify: `src/cli/run-repo-search.ts`
- Modify: `src/cli/dispatch.ts`
- Modify: `src/cli/args.ts`
- Modify: `tests/summary-cli.test.ts`
- Modify: `tests/cli-http-boundary.test.ts`

- [ ] **Step 1: Refactor `run-summary.ts`**

Replace imports in `src/cli/run-summary.ts`:

```ts
import type { SummaryRequest } from '../summary/types.js';
import { getCommandArgs, parseArguments } from './args.js';
import { readCliTextInput } from './input.js';
import { StatusServerApiClient } from './status-server-api-client.js';
```

Delete these imports:

```ts
import { getStatusBackendUrl, getStatusServerUnavailableMessage } from '../config/index.js';
import { httpClient, logHttpClientBoundary } from '../lib/http-client.js';
import { readSummaryInput, summarizeRequest } from '../summary/core.js';
import { isPassFailQuestion } from '../summary/measure.js';
import { parseDeterministicTestOutput } from '../summary/test-output.js';
import type { SummaryRequest, SummaryResult } from '../summary/types.js';
```

Replace the deterministic branch:

```ts
  const deterministicTestSummary = sourceKind === 'command-output' && isPassFailQuestion(question)
    ? parseDeterministicTestOutput({ inputText: request.inputText, commandExitCode })
    : null;
  const result = deterministicTestSummary
    ? await summarizeRequest(request)
    : await requestSummaryThroughStatusServer(request);
```

with:

```ts
  const result = await new StatusServerApiClient().requestSummary(request);
```

Delete `getSummaryServiceUrl()` and `requestSummaryThroughStatusServer()`.

- [ ] **Step 2: Keep repo-search CLI on HTTP client class**

In `src/cli/run-repo-search.ts`, keep `RepoSearchOutputFormatter` for formatting only, but replace direct `httpClient` usage with:

```ts
import { StatusServerApiClient } from './status-server-api-client.js';
```

Then replace:

```ts
  const response = await httpClient.requestJson<{
```

through the request body with:

```ts
  const response = await new StatusServerApiClient().requestRepoSearch({
    prompt,
    repoRoot: process.cwd(),
    model: parsed.model,
    logFile: parsed.logFile,
  });
```

Delete `getRepoSearchServiceUrl()` if it is unused.

- [ ] **Step 3: Mark summary and run as server-dependent**

In `src/cli/args.ts`, change:

```ts
export const SERVER_DEPENDENT_COMMANDS = new Set([
```

to include:

```ts
  'summary',
  'run',
  'preset',
  'eval',
```

Keep `repo-search` in the set.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm test -- tests/summary-cli.test.ts tests/cli-http-boundary.test.ts tests/cli-engine-boundary.test.ts
```

Expected: summary CLI tests pass, repo-search CLI stays HTTP. Boundary test still fails for command, capture, preset, internal, eval, help, and preset-list.

- [ ] **Step 5: Commit summary/repo-search CLI refactor**

```powershell
git add src/cli/run-summary.ts src/cli/run-repo-search.ts src/cli/args.ts tests/summary-cli.test.ts tests/cli-http-boundary.test.ts
git commit -m "refactor(cli): delegate summary execution to status server"
```

---

### Task 7: Refactor Command and Capture CLI to Local Capture Plus HTTP Analysis

**Files:**

- Modify: `src/cli/run-command.ts`
- Modify: `src/cli/run-capture.ts`
- Modify: `src/command.ts`
- Modify: `src/interactive.ts`
- Modify: `tests/cli-http-boundary.test.ts`
- Modify: `tests/runtime-summarize.test.ts`

- [ ] **Step 1: Refactor command CLI**

Replace `src/cli/run-command.ts` with:

```ts
import { invokeProcess, invokeShellProcess } from '../capture/process.js';
import { getCommandArgs, parseArguments } from './args.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runCommandCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const command = parsed.command || parsed.positionals[0];
  if (!command) {
    throw new Error('A command is required.');
  }

  const argList = (parsed.argList && parsed.argList.length > 0)
    ? parsed.argList
    : parsed.positionals.slice(1);
  const processResult = parsed.shell
    ? invokeShellProcess(command, parsed.shell)
    : invokeProcess(command, argList);
  const commandText = parsed.shell
    ? `[${parsed.shell}] ${command}`
    : [command, ...argList].join(' ');
  const result = await new StatusServerApiClient().analyzeCommandOutput({
    outputKind: 'command',
    exitCode: processResult.ExitCode,
    combinedText: processResult.Combined,
    commandText,
    question: parsed.question,
    riskLevel: parsed.risk,
    reducerProfile: parsed.reducer,
    format: parsed.format === 'json' ? 'json' : 'text',
    policyProfile: parsed.profile === 'pass-fail'
      || parsed.profile === 'unique-errors'
      || parsed.profile === 'buried-critical'
      || parsed.profile === 'json-extraction'
      || parsed.profile === 'diff-summary'
      || parsed.profile === 'risky-operation'
      || parsed.profile === 'general'
      ? parsed.profile
      : 'general',
    backend: parsed.backend,
    model: parsed.model,
    shell: parsed.shell,
  });

  if (result.Summary) {
    options.stdout.write(`${result.Summary}\n`);
  } else {
    options.stdout.write('No summary generated.\n');
  }
  options.stdout.write(`Raw log: ${result.RawLogPath}\n`);
  return 0;
}
```

- [ ] **Step 2: Refactor capture CLI**

Replace `src/cli/run-capture.ts` with:

```ts
import { resolveExternalCommand } from '../capture/command-path.js';
import { captureWithTranscript } from '../capture/process.js';
import { getCommandArgs, parseArguments } from './args.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runCaptureInternalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const command = parsed.command || parsed.positionals[0];
  if (!command) {
    throw new Error('A command is required.');
  }

  const argList = (parsed.argList && parsed.argList.length > 0)
    ? parsed.argList
    : parsed.positionals.slice(1);
  const resolvedCommand = resolveExternalCommand(command);
  const captured = captureWithTranscript(resolvedCommand, argList);
  const fallbackTranscript = `Interactive command completed without a captured transcript.\nCommand: ${command} ${argList.join(' ')}\nExitCode: ${captured.ExitCode}`;
  const transcriptText = captured.Transcript.trim() ? captured.Transcript : fallbackTranscript;
  const result = await new StatusServerApiClient().analyzeCommandOutput({
    outputKind: 'interactive',
    exitCode: captured.ExitCode,
    combinedText: transcriptText,
    commandText: [command, ...argList].join(' '),
    question: parsed.question,
    format: parsed.format === 'json' ? 'json' : 'text',
    policyProfile: parsed.profile === 'pass-fail'
      || parsed.profile === 'unique-errors'
      || parsed.profile === 'buried-critical'
      || parsed.profile === 'json-extraction'
      || parsed.profile === 'diff-summary'
      || parsed.profile === 'risky-operation'
      || parsed.profile === 'general'
      ? parsed.profile
      : 'general',
    backend: parsed.backend,
    model: parsed.model,
  });
  const outputText = `${(result.Summary || 'No summary generated.').trim()}\nRaw transcript: ${result.RawLogPath}`;
  options.stdout.write(`${outputText}\n`);
  return 0;
}
```

- [ ] **Step 3: Remove engine-owning command module**

Delete `src/command.ts` after all production imports are gone:

```powershell
git rm src/command.ts
```

If tests still need direct local command capture, import from `src/capture/process.ts` or `dist/capture/process.js`.

- [ ] **Step 4: Remove engine-owning interactive module**

Delete `src/interactive.ts` after all production imports are gone:

```powershell
git rm src/interactive.ts
```

If tests still need transcript capture, import `captureWithTranscript` from `src/capture/process.ts`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm test -- tests/cli-http-boundary.test.ts tests/command.test.ts tests/runtime-summarize.test.ts tests/cli-engine-boundary.test.ts
```

Expected: command boundary tests pass. Static boundary no longer reports `src/cli/run-command.ts` or `src/cli/run-capture.ts`.

- [ ] **Step 6: Commit command/capture CLI refactor**

```powershell
git add src/cli/run-command.ts src/cli/run-capture.ts src/command-output tests
git add -u src/command.ts src/interactive.ts
git commit -m "refactor(cli): post captured command output to server"
```

---

### Task 8: Add Server Preset Runner and Refactor Preset CLI

**Files:**

- Create: `src/status-server/preset-runner.ts`
- Modify: `src/status-server/routes/core.ts`
- Modify: `src/cli/run-preset.ts`
- Modify: `src/cli/run-preset-list.ts`
- Modify: `src/cli/help.ts`
- Modify: `tests/cli-preset.test.ts`
- Modify: `tests/cli-http-boundary.test.ts`

- [ ] **Step 1: Create server-owned preset runner**

Create `src/status-server/preset-runner.ts`:

```ts
import type { SiftConfig } from '../config/index.js';
import {
  findPresetById,
  getPresetsForSurface,
  normalizeOperationModeAllowedTools,
  normalizePresets,
  resolvePresetAllowedTools,
} from '../presets.js';
import { RepoSearchOutputFormatter } from '../repo-search/output-format.js';
import {
  buildChatSystemContent,
  buildPlanMarkdownFromRepoSearch,
  buildPlanRequestPrompt,
  buildRepoSearchMarkdown,
} from './chat.js';
import { resolveEffectiveAgentsMd, resolveEffectiveRepoFileListing } from './routes/chat.js';
import type { StatusEngineService } from './engine-service.js';
import type { PresetRunRequest, PresetRunResult } from '../command-output/types.js';

function getPromptPrefix(config: SiftConfig, presetPromptPrefix: string): string {
  return presetPromptPrefix.trim() || String(config.PromptPrefix || '').trim();
}

function getAllowedSummaryTools(allowedTools: string[]): Array<'find_text' | 'read_lines' | 'json_filter'> {
  return allowedTools.filter((toolName): toolName is 'find_text' | 'read_lines' | 'json_filter' => (
    toolName === 'find_text' || toolName === 'read_lines' || toolName === 'json_filter'
  ));
}

export class StatusPresetRunner {
  private readonly engineService: StatusEngineService;

  constructor(engineService: StatusEngineService) {
    this.engineService = engineService;
  }

  async run(request: PresetRunRequest, config: SiftConfig): Promise<PresetRunResult> {
    const presets = getPresetsForSurface(normalizePresets(config.Presets), 'cli');
    const preset = findPresetById(presets, request.presetId);
    if (!preset) {
      throw new Error(`Unknown CLI preset: ${request.presetId}`);
    }
    const effectiveAllowedTools = resolvePresetAllowedTools(
      preset,
      normalizeOperationModeAllowedTools(config.OperationModeAllowedTools),
    );

    if (preset.presetKind === 'summary') {
      const question = request.question || request.prompt || '';
      if (!question.trim()) {
        throw new Error('A question is required.');
      }
      const inputText = request.inputText || '';
      if (!inputText.trim()) {
        throw new Error('stdin, --text or --file required');
      }
      const result = await this.engineService.summarize({
        question,
        inputText,
        format: request.format === 'json' ? 'json' : 'text',
        policyProfile: request.profile === 'pass-fail'
          || request.profile === 'unique-errors'
          || request.profile === 'buried-critical'
          || request.profile === 'json-extraction'
          || request.profile === 'diff-summary'
          || request.profile === 'risky-operation'
          || request.profile === 'general'
          ? request.profile
          : 'general',
        backend: request.backend,
        model: request.model,
        promptPrefix: getPromptPrefix(config, preset.promptPrefix),
        allowedPlannerTools: getAllowedSummaryTools(effectiveAllowedTools),
        sourceKind: 'standalone',
        skipExecutionLock: true,
        config,
      });
      return { outputText: result.Summary };
    }

    const prompt = String(request.prompt || request.question || '').trim();
    if (!prompt) {
      throw new Error('A prompt is required.');
    }
    const repoRoot = String(request.repoRoot || process.cwd()).trim() || process.cwd();
    if (preset.presetKind === 'chat') {
      const ephemeralSession = {
        id: 'cli-ephemeral',
        title: preset.label,
        model: request.model,
        contextWindowTokens: 150000,
        thinkingEnabled: true,
        presetId: preset.id,
        mode: 'chat' as const,
        planRepoRoot: repoRoot,
        condensedSummary: '',
        createdAtUtc: new Date().toISOString(),
        updatedAtUtc: new Date().toISOString(),
        messages: [],
      };
      const result = await this.engineService.executeRepoSearch({
        taskKind: 'chat',
        prompt,
        repoRoot,
        config,
        model: request.model,
        systemPrompt: buildChatSystemContent(config, ephemeralSession, {
          promptPrefix: preset.promptPrefix.trim() || undefined,
        }),
        history: [],
        thinkingEnabled: true,
        allowedTools: [],
      });
      const tasks = ((result.scorecard as { tasks?: Array<{ finalOutput?: string }> }).tasks) || [];
      return { outputText: RepoSearchOutputFormatter.formatFinalOutputs(tasks.map((task) => task.finalOutput || '')) };
    }

    const result = await this.engineService.executeRepoSearch({
      taskKind: preset.presetKind === 'plan' ? 'plan' : 'repo-search',
      prompt: preset.presetKind === 'plan' ? buildPlanRequestPrompt(prompt) : prompt,
      promptPrefix: preset.presetKind === 'repo-search' ? preset.promptPrefix : '',
      repoRoot,
      config,
      model: request.model,
      maxTurns: Number.isFinite(request.maxTurns) && Number(request.maxTurns) > 0 ? Number(request.maxTurns) : preset.maxTurns ?? undefined,
      logFile: request.logFile,
      allowedTools: effectiveAllowedTools,
      includeAgentsMd: resolveEffectiveAgentsMd(config, preset),
      includeRepoFileListing: resolveEffectiveRepoFileListing(config, preset),
    });
    const output = preset.presetKind === 'plan'
      ? buildPlanMarkdownFromRepoSearch(prompt, repoRoot, result.scorecard)
      : buildRepoSearchMarkdown(prompt, repoRoot, result.scorecard);
    return { outputText: output };
  }
}
```

- [ ] **Step 2: Add `/preset/run` route**

In `src/status-server/routes/core.ts`, import:

```ts
import { StatusPresetRunner } from '../preset-runner.js';
```

Add route before `/repo-search`:

```ts
  if (req.method === 'POST' && req.url === '/preset/run') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const presetId = getOptionalString(parsedBody.presetId);
    if (!presetId) {
      sendJson(res, 400, { error: 'Expected presetId.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 503, { error: 'Timed out waiting for model request queue.', modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return true;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return true;
      }
      const runner = new StatusPresetRunner(ctx.engineService);
      const result = await runner.run({
        presetId,
        prompt: getOptionalString(parsedBody.prompt),
        question: getOptionalString(parsedBody.question),
        inputText: typeof parsedBody.inputText === 'string' ? parsedBody.inputText : undefined,
        format: normalizeSummaryFormat(parsedBody.format),
        backend: getOptionalString(parsedBody.backend),
        model: getOptionalString(parsedBody.model),
        profile: getOptionalString(parsedBody.profile),
        repoRoot: getOptionalString(parsedBody.repoRoot),
        maxTurns: getOptionalNumber(parsedBody.maxTurns),
        logFile: getOptionalString(parsedBody.logFile),
      }, readConfig(configPath) as SiftConfig);
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return true;
  }
```

- [ ] **Step 3: Add `/preset/list` route**

In `src/status-server/routes/core.ts`, add imports:

```ts
import { getPresetsForSurface, normalizePresets } from '../../presets.js';
```

Add route before `/preset/run`:

```ts
  if (req.method === 'GET' && req.url === '/preset/list') {
    const config = readConfig(configPath) as SiftConfig;
    const presets = getPresetsForSurface(normalizePresets(config.Presets), 'cli');
    sendJson(res, 200, {
      presets: presets.map((preset) => ({
        id: preset.id,
        presetKind: preset.presetKind,
        operationMode: preset.operationMode,
        deletable: preset.deletable,
        label: preset.label,
      })),
    });
    return true;
  }
```

- [ ] **Step 4: Refactor preset CLI**

Replace `src/cli/run-preset.ts` with:

```ts
import { getCommandArgs, parseArguments } from './args.js';
import { readCliTextInput } from './input.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runPresetCli(options: {
  argv: string[];
  stdinText?: string | Buffer;
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const presetId = String(parsed.preset || '').trim();
  if (!presetId) {
    throw new Error('A --preset is required.');
  }

  const inputText = readCliTextInput({
    text: parsed.text,
    file: parsed.file,
    stdinText: options.stdinText,
  });
  const result = await new StatusServerApiClient().runPreset({
    presetId,
    prompt: String(parsed.prompt || parsed.positionals.join(' ')).trim() || undefined,
    question: parsed.question || parsed.positionals[0],
    inputText: inputText ?? undefined,
    format: parsed.format === 'json' ? 'json' : 'text',
    backend: parsed.backend,
    model: parsed.model,
    profile: parsed.profile,
    repoRoot: String(parsed.repoRoot || parsed.path || process.cwd()).trim() || process.cwd(),
    maxTurns: Number.isFinite(parsed.maxTurns) && Number(parsed.maxTurns) > 0 ? Number(parsed.maxTurns) : undefined,
    logFile: parsed.logFile,
  });
  options.stdout.write(`${result.outputText}\n`);
  return 0;
}
```

- [ ] **Step 5: Refactor preset list to HTTP route**

Replace `src/cli/run-preset-list.ts` with:

```ts
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runPresetList(options: {
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const result = await new StatusServerApiClient().listPresets();
  for (const preset of result.presets) {
    options.stdout.write(
      `${preset.id}\t${preset.presetKind}\t${preset.operationMode}\t${preset.deletable ? 'custom' : 'builtin'}\t${preset.label}\n`,
    );
  }
  return 0;
}
```

In `src/cli/dispatch.ts`, change:

```ts
return runPresetList({ stdout });
```

to:

```ts
return await runPresetList({ stdout });
```

- [ ] **Step 6: Refactor help to static output**

Replace `src/cli/help.ts` with:

```ts
export function showHelp(stdout: NodeJS.WritableStream): void {
  stdout.write([
    'SiftKit CLI',
    '',
    'Usage:',
    '  siftkit "question"',
    '  siftkit summary --question "..." [--text "..."] [--file path]',
    '  siftkit repo-search --prompt "find x y z in this repo"',
    '  siftkit -prompt "find x y z in this repo"',
    '  siftkit preset list',
    '  siftkit run --preset <id> ...',
    '  siftkit run --command <cmd> [--arg <a> ...] --question "..."',
    '  siftkit run --shell <auto|pwsh|powershell|bash|sh|cmd> --command "<script>" --question "..."',
    '',
    'Run `siftkit preset list` to read server-managed CLI presets.',
    '',
  ].join('\n'));
}
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm test -- tests/cli-preset.test.ts tests/cli-http-boundary.test.ts tests/cli-engine-boundary.test.ts
```

Expected: preset route tests pass. Static guard no longer reports `run-preset.ts`, `run-preset-list.ts`, or `help.ts`.

- [ ] **Step 8: Commit preset boundary refactor**

```powershell
git add src/status-server/preset-runner.ts src/status-server/routes/core.ts src/cli/run-preset.ts src/cli/run-preset-list.ts src/cli/help.ts src/cli/dispatch.ts tests
git commit -m "refactor(cli): delegate preset execution to status server"
```

---

### Task 9: Refactor Internal and Eval CLI Paths to HTTP

**Files:**

- Modify: `src/status-server/routes/core.ts`
- Modify: `src/cli/run-internal.ts`
- Modify: `src/cli/run-eval.ts`
- Modify: `tests/cli-internal.test.ts`
- Modify: `tests/cli-http-boundary.test.ts`

- [ ] **Step 1: Add `/eval/run` route**

In `src/status-server/routes/core.ts`, add route before `/repo-search`:

```ts
  if (req.method === 'POST' && req.url === '/eval/run') {
    let parsedBody: Dict;
    try {
      parsedBody = parseJsonBody(await readBody(req));
    } catch {
      sendJson(res, 400, { error: 'Expected valid JSON object.' });
      return true;
    }
    const modelRequestLock = await acquireModelRequestWithWait(ctx, 'summary', req, res);
    if (!modelRequestLock) {
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 503, { error: 'Timed out waiting for model request queue.', modelRequests: getModelRequestQueueDiagnostics(ctx) });
      }
      return true;
    }
    try {
      try {
        await ensureManagedLlamaReadyForModelRequest(ctx);
      } catch (error) {
        sendServerErrorJson(req, res, 503, error, { taskKind: 'summary' });
        return true;
      }
      const result = await ctx.engineService.runEvaluation({
        FixtureRoot: getOptionalString(parsedBody.FixtureRoot),
        RealLogPath: Array.isArray(parsedBody.RealLogPath) ? (parsedBody.RealLogPath as unknown[]).map((value) => String(value)) : [],
        Backend: getOptionalString(parsedBody.Backend),
        Model: getOptionalString(parsedBody.Model),
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendServerErrorJson(req, res, 500, error, { taskKind: 'summary' });
    } finally {
      releaseModelRequest(ctx, modelRequestLock.token);
    }
    return true;
  }
```

- [ ] **Step 2: Refactor eval CLI**

Replace `src/cli/run-eval.ts` with:

```ts
import { formatPsList, getCommandArgs, parseArguments } from './args.js';
import { StatusServerApiClient } from './status-server-api-client.js';

export async function runEvalCli(options: {
  argv: string[];
  stdout: NodeJS.WritableStream;
}): Promise<number> {
  const parsed = parseArguments(getCommandArgs(options.argv));
  const result = await new StatusServerApiClient().runEvaluation({
    FixtureRoot: parsed.fixtureRoot,
    Backend: parsed.backend,
    Model: parsed.model,
  });
  options.stdout.write(formatPsList(result));
  return 0;
}
```

- [ ] **Step 3: Refactor internal engine operations**

In `src/cli/run-internal.ts`, remove imports:

```ts
import { analyzeCommandOutput, runCommand } from '../command.js';
import { runEvaluation } from '../eval.js';
import { runInteractiveCapture } from '../interactive.js';
import { executeRepoSearchRequest } from '../repo-search/index.js';
import { summarizeRequest } from '../summary/core.js';
```

Add imports:

```ts
import { invokeProcess, invokeShellProcess } from '../capture/process.js';
import { resolveExternalCommand } from '../capture/command-path.js';
import { captureWithTranscript } from '../capture/process.js';
import { StatusServerApiClient } from './status-server-api-client.js';
```

Before the switch, add:

```ts
  const apiClient = new StatusServerApiClient();
```

Replace `case 'summary'` with:

```ts
    case 'summary': {
      const text = request.TextFile ? readTextFileWithEncoding(String(request.TextFile)) : String(request.Text || '');
      result = await apiClient.requestSummary({
        question: String(request.Question),
        inputText: text,
        format: request.Format === 'json' ? 'json' : 'text',
        policyProfile: request.PolicyProfile === 'pass-fail'
          || request.PolicyProfile === 'unique-errors'
          || request.PolicyProfile === 'buried-critical'
          || request.PolicyProfile === 'json-extraction'
          || request.PolicyProfile === 'diff-summary'
          || request.PolicyProfile === 'risky-operation'
          || request.PolicyProfile === 'general'
          ? request.PolicyProfile
          : 'general',
        backend: request.Backend ? String(request.Backend) : undefined,
        model: request.Model ? String(request.Model) : undefined,
      });
      break;
    }
```

Replace `case 'command'` with:

```ts
    case 'command': {
      const command = String(request.Command);
      const argumentList = Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [];
      const shell = request.Shell === 'auto'
        || request.Shell === 'pwsh'
        || request.Shell === 'powershell'
        || request.Shell === 'bash'
        || request.Shell === 'sh'
        || request.Shell === 'cmd'
        ? request.Shell
        : undefined;
      const processResult = shell
        ? invokeShellProcess(command, shell)
        : invokeProcess(command, argumentList);
      result = await apiClient.analyzeCommandOutput({
        outputKind: 'command',
        exitCode: processResult.ExitCode,
        combinedText: processResult.Combined,
        commandText: shell ? `[${shell}] ${command}` : [command, ...argumentList].join(' '),
        question: request.Question ? String(request.Question) : undefined,
        riskLevel: request.RiskLevel === 'informational' || request.RiskLevel === 'debug' || request.RiskLevel === 'risky' ? request.RiskLevel : undefined,
        reducerProfile: request.ReducerProfile === 'smart' || request.ReducerProfile === 'errors' || request.ReducerProfile === 'tail' || request.ReducerProfile === 'diff' || request.ReducerProfile === 'none' ? request.ReducerProfile : undefined,
        format: request.Format === 'json' ? 'json' : 'text',
        policyProfile: request.PolicyProfile === 'pass-fail'
          || request.PolicyProfile === 'unique-errors'
          || request.PolicyProfile === 'buried-critical'
          || request.PolicyProfile === 'json-extraction'
          || request.PolicyProfile === 'diff-summary'
          || request.PolicyProfile === 'risky-operation'
          || request.PolicyProfile === 'general'
          ? request.PolicyProfile
          : undefined,
        backend: request.Backend ? String(request.Backend) : undefined,
        model: request.Model ? String(request.Model) : undefined,
        noSummarize: Boolean(request.NoSummarize),
        shell,
      });
      break;
    }
```

Replace `case 'command-analyze'` with:

```ts
    case 'command-analyze': {
      const text = request.RawTextFile ? readTextFileWithEncoding(String(request.RawTextFile)) : String(request.RawText || '');
      result = await apiClient.analyzeCommandOutput({
        outputKind: 'command',
        exitCode: Number(request.ExitCode || 0),
        combinedText: text,
        question: request.Question ? String(request.Question) : undefined,
        riskLevel: request.RiskLevel === 'informational' || request.RiskLevel === 'debug' || request.RiskLevel === 'risky' ? request.RiskLevel : undefined,
        reducerProfile: request.ReducerProfile === 'smart' || request.ReducerProfile === 'errors' || request.ReducerProfile === 'tail' || request.ReducerProfile === 'diff' || request.ReducerProfile === 'none' ? request.ReducerProfile : undefined,
        format: request.Format === 'json' ? 'json' : 'text',
        policyProfile: request.PolicyProfile === 'pass-fail'
          || request.PolicyProfile === 'unique-errors'
          || request.PolicyProfile === 'buried-critical'
          || request.PolicyProfile === 'json-extraction'
          || request.PolicyProfile === 'diff-summary'
          || request.PolicyProfile === 'risky-operation'
          || request.PolicyProfile === 'general'
          ? request.PolicyProfile
          : undefined,
        backend: request.Backend ? String(request.Backend) : undefined,
        model: request.Model ? String(request.Model) : undefined,
        noSummarize: Boolean(request.NoSummarize),
      });
      break;
    }
```

Replace `case 'eval'` with:

```ts
    case 'eval':
      result = await apiClient.runEvaluation({
        FixtureRoot: request.FixtureRoot ? String(request.FixtureRoot) : undefined,
        RealLogPath: Array.isArray(request.RealLogPath) ? request.RealLogPath.map(String) : [],
        Backend: request.Backend ? String(request.Backend) : undefined,
        Model: request.Model ? String(request.Model) : undefined,
      });
      break;
```

Replace `case 'interactive-capture'` with:

```ts
    case 'interactive-capture': {
      const command = String(request.Command);
      const argumentList = Array.isArray(request.ArgumentList) ? request.ArgumentList.map(String) : [];
      const resolvedCommand = resolveExternalCommand(command);
      const captured = captureWithTranscript(resolvedCommand, argumentList);
      const fallbackTranscript = `Interactive command completed without a captured transcript.\nCommand: ${command} ${argumentList.join(' ')}\nExitCode: ${captured.ExitCode}`;
      result = await apiClient.analyzeCommandOutput({
        outputKind: 'interactive',
        exitCode: captured.ExitCode,
        combinedText: captured.Transcript.trim() ? captured.Transcript : fallbackTranscript,
        commandText: [command, ...argumentList].join(' '),
        question: request.Question ? String(request.Question) : undefined,
        format: request.Format === 'json' ? 'json' : 'text',
        policyProfile: request.PolicyProfile === 'pass-fail'
          || request.PolicyProfile === 'unique-errors'
          || request.PolicyProfile === 'buried-critical'
          || request.PolicyProfile === 'json-extraction'
          || request.PolicyProfile === 'diff-summary'
          || request.PolicyProfile === 'risky-operation'
          || request.PolicyProfile === 'general'
          ? request.PolicyProfile
          : undefined,
        backend: request.Backend ? String(request.Backend) : undefined,
        model: request.Model ? String(request.Model) : undefined,
      });
      break;
    }
```

Replace `case 'repo-search'` with:

```ts
    case 'repo-search':
      result = await apiClient.requestRepoSearch({
        prompt: String(request.Prompt || ''),
        repoRoot: String(request.RepoRoot || process.cwd()),
        model: request.Model ? String(request.Model) : undefined,
        maxTurns: request.MaxTurns === undefined ? undefined : Number(request.MaxTurns),
        logFile: request.LogFile ? String(request.LogFile) : undefined,
        availableModels: Array.isArray(request.AvailableModels) ? request.AvailableModels.map(String) : undefined,
        mockResponses: Array.isArray(request.MockResponses) ? request.MockResponses.map(String) : undefined,
        mockCommandResults: (
          request.MockCommandResults
          && typeof request.MockCommandResults === 'object'
          && !Array.isArray(request.MockCommandResults)
        ) ? request.MockCommandResults as Record<string, { exitCode?: number; stdout?: string; stderr?: string }> : undefined,
      });
      break;
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm test -- tests/cli-internal.test.ts tests/cli-http-boundary.test.ts tests/cli-engine-boundary.test.ts
```

Expected: internal engine ops use HTTP. Static boundary no longer reports `src/cli/run-internal.ts` or `src/cli/run-eval.ts`.

- [ ] **Step 5: Commit internal/eval boundary refactor**

```powershell
git add src/status-server/routes/core.ts src/cli/run-internal.ts src/cli/run-eval.ts tests
git commit -m "refactor(cli): route internal engine ops through status server"
```

---

### Task 10: Delete Local Engine Compatibility and Clean Tests

**Files:**

- Modify: `tests/_runtime-helpers.ts`
- Modify: runtime tests that import `runCommand` from `dist/command.js`
- Modify: `tsconfig.json`
- Modify: `ARCHITECTURE-REVIEW.md`

- [ ] **Step 1: Remove `dist/command.js` test expectations**

Search:

```powershell
rg -n "dist/command|runCommand|analyzeCommandOutput|runInteractiveCapture|dist/interactive" tests src
```

Every remaining test that needs command capture should use:

```ts
import { invokeProcess, invokeShellProcess } from '../dist/capture/process.js';
```

Every remaining test that needs server-side command analysis should use:

```ts
import { CommandOutputAnalyzer } from '../dist/command-output/analyzer.js';
```

No test should import `../dist/command.js` or `../dist/interactive.js`.

- [ ] **Step 2: Remove local engine entrypoints from source**

Run:

```powershell
rg -n "from './command|from '../command|from './interactive|from '../interactive|from '../eval|from './eval" src tests
```

Expected after edits: no production CLI import of command, interactive, or eval engines. `src/status-server/engine-service.ts` may import `../eval.js` because eval execution is now server-owned.

- [ ] **Step 3: Update architecture review**

In `ARCHITECTURE-REVIEW.md`, under F8, add:

```md
Addressed 2026-06-10: status-server routes now call `StatusEngineService`, which statically imports the repo-search engine. The cache-busting `loadRepoSearchExecutor()` path was deleted.
```

Under F12, add:

```md
Addressed 2026-06-10: CLI execution paths are thin HTTP clients. Summary, repo-search, preset, eval, command-output analysis, and internal engine operations execute on the status server. The CLI only parses arguments, reads input files, runs local external commands when requested, captures command output, and formats server responses.
```

- [ ] **Step 4: Run boundary grep**

Run:

```powershell
rg -n "summarizeRequest|executeRepoSearchRequest|loadRepoSearchExecutor|require\\.cache|from '../status-server|from '../repo-search|from '../summary|from '../command|from '../interactive|from '../eval|withExecutionLock" src\cli src\status-server\chat.ts src\status-server\routes src\command.ts src\interactive.ts
```

Expected:

- No `src/cli` result importing forbidden modules.
- No `loadRepoSearchExecutor`.
- No `require.cache`.
- `src/status-server/routes` may reference `ctx.engineService`, not direct dynamic loaders.
- `src/command.ts` and `src/interactive.ts` do not exist.

- [ ] **Step 5: Run focused and full validation**

Run:

```powershell
npm run typecheck
npm test -- tests/cli-engine-boundary.test.ts tests/cli-http-boundary.test.ts tests/summary-cli.test.ts tests/cli-internal.test.ts tests/command.test.ts tests/summary-status-server.test.ts
npm test
```

Expected: all commands pass.

- [ ] **Step 6: Commit final cleanup**

```powershell
git add ARCHITECTURE-REVIEW.md tests src tsconfig.json
git add -u
git commit -m "refactor: collapse execution ownership to status server"
```

---

## Risks and Constraints

- The first implementation pass intentionally keeps local command execution in the CLI because that is the required security and ergonomics boundary. The server only receives captured output.
- `/command-output/analyze` initially acquires the model request queue before analysis. This is conservative and matches existing `/summary` queue behavior. If raw-only command analysis later needs to avoid queue waits, split `CommandOutputAnalyzer` into a `prepare` step and a `summarize` step inside the server, not the client.
- CLI input reading lives in `src/cli/input.ts`; CLI code must not import `summary/core` for input helpers.
- `RepoSearchOutputFormatter` remains importable by CLI because it is response formatting only. If the static guard is made stricter later, move final-output extraction into `src/cli/repo-search-output.ts`.
- `eval.ts` remains an engine module, but only the server imports it through `StatusEngineService`.
- Do not add local fallback execution. If the server is unavailable, the CLI should fail with the existing status-server unavailable message.

## Self-Review Checklist

- Spec coverage: the plan covers F8 dynamic loading, F12 split-brain summary/repo-search/command/capture/preset/internal/eval execution, and the clarified command-output boundary.
- Placeholder scan: no task relies on unspecified future work; each route/client/test has concrete code or exact replacements.
- Type consistency: request properties use lower-camel-case for HTTP payloads; legacy internal request files remain PascalCase at the file boundary and are converted in `run-internal.ts`.
- Boundary consistency: CLI is allowed to import capture helpers and formatting helpers only; server owns all engine calls.
- Validation: static import guards, runtime HTTP-boundary tests, focused tests, typecheck, and full `npm test` are included.
