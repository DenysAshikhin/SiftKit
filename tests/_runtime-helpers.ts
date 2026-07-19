// Shared runtime test infrastructure barrel. Typed re-export surface for the
// ~30 runtime test files. Server-harness primitives live here; managed-llama
// fixture writers live in ./helpers/managed-llama-fixtures.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { z } from '../src/lib/zod.js';
import { toError } from '../src/lib/errors.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../src/lib/json-types.js';
import { mockSiftConfig, asRuntimeSiftConfig } from './helpers/mock-config.js';
import {
  deriveServiceUrl,
  getDefaultConfig,
  clone,
  toJsonValue,
  getChatRequestText,
  type ChatRequest,
  type AssistantResponder,
  setManagedLlamaBaseUrl,
  mergeConfig,
  extractPromptSection,
  buildOversizedTransitionsInput,
  buildOversizedRunnerStateHistoryInput,
  getRuntimeRootFromStatusPath,
  getPlannerLogsPath,
  getFailedLogsPath,
  getRequestLogsPath,
  buildStructuredStubDecision,
  resolveAssistantContent,
} from './helpers/runtime-config.js';
import {
  readBody,
  resolveArtifactLogPathFromStatusPost,
  requestJson,
} from './helpers/runtime-http.js';
import {
  toSingleQuotedPowerShellLiteral,
  writeManagedLlamaScripts,
  writeManagedLlamaLauncher,
} from './helpers/managed-llama-fixtures.js';

import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken,
  initializeRuntime,
  getStatusServerUnavailableMessage,
} from '../src/config/index.js';
import { summarizeRequest } from '../src/summary/core.js';
import { buildPrompt } from '../src/summary/prompt.js';
import { getSummaryDecision } from '../src/summary/decision.js';
import { planTokenAwareLlamaCppChunks, getPlannerPromptBudget } from '../src/summary/chunking.js';
import { buildPlannerToolDefinitions } from '../src/summary/planner/tools.js';
import { runCommand } from './helpers/run-command-for-test.js';
import { runBenchmarkSuite } from '../bench/benchmark/index.js';
import {
  readMatrixManifest,
  buildLaunchSignature,
  buildLauncherArgs,
  buildBenchmarkArgs,
  pruneOldLauncherLogs,
  runMatrix,
  runMatrixWithInterrupt,
} from '../bench/benchmark-matrix/index.js';
import {
  countLlamaCppTokens,
  listLlamaCppModels,
  generateLlamaCppResponse,
} from '../src/providers/llama-cpp.js';
import {
  buildIdleMetricsLogMessage,
  buildStatusRequestLogMessage,
  formatElapsed,
  getIdleSummarySnapshotsPath,
  startStatusServer,
  terminateProcessTree,
} from '../src/status-server/index.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { runDebugRequest } from '../bench/repro/run-benchmark-fixture-debug.js';
import { runFixture60MalformedJsonRepro } from '../bench/repro/repro-fixture60-malformed-json.js';
import type { SiftConfig, ServerManagedLlamaPreset } from '../src/config/types.js';
import type { TaskKind, ToolTypeStats, Metrics } from '../src/status-server/metrics.js';

// Shared view types for the runtime status-server HTTP responses these tests read.
interface RuntimeStatusResponse {
  running: boolean;
  status: string;
  metrics: Metrics;
}

interface LlamaModelsResponse {
  data: { id: string }[];
}

interface HealthCheckResponse {
  ok: boolean;
  disableManagedLlamaStartup: boolean;
}

interface StatusPostAck {
  ok: boolean;
  running?: boolean;
  busy?: boolean;
}

// Rewrites a default config to launch the managed-llama test scripts. Spreads the
// default preset so every required ManagedLlamaSettings field is present, then
// applies the script paths and any per-test overrides.
function applyManagedScriptConfig(
  config: SiftConfig,
  managed: ReturnType<typeof writeManagedLlamaScripts>,
  overrides: Partial<ServerManagedLlamaPreset> = {},
): void {
  const defaultPreset = config.Server.LlamaCpp.Presets[0];
  setManagedLlamaBaseUrl(config, managed.baseUrl);
  config.Server = {
    LlamaCpp: {
      ActivePresetId: 'default',
      Presets: [{
        ...defaultPreset,
        id: 'default',
        label: 'Default',
        BaseUrl: managed.baseUrl,
        ModelPath: managed.modelPath,
        ExecutablePath: managed.startupScriptPath,
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
        ...overrides,
      }],
    },
    Exl3: config.Server.Exl3,
  };
}


const TEST_USE_EXISTING_SERVER = process.env.SIFTKIT_TEST_USE_EXISTING_SERVER === '1';
const EXISTING_SERVER_STATUS_URL = process.env.SIFTKIT_STATUS_BACKEND_URL;
const EXISTING_SERVER_CONFIG_URL = process.env.SIFTKIT_CONFIG_SERVICE_URL;
const RUN_LIVE_LLAMA_TOKENIZE_TESTS = process.env.SIFTKIT_RUN_LIVE_LLAMA_TOKENIZE_TESTS === '1';
const LIVE_LLAMA_BASE_URL = process.env.SIFTKIT_LIVE_LLAMA_BASE_URL?.trim() || 'http://127.0.0.1:8097';
const LIVE_CONFIG_SERVICE_URL = process.env.SIFTKIT_CONFIG_SERVICE_URL?.trim() || 'http://127.0.0.1:4765/config';
const FAST_LEASE_WAIT_MS = 350;

interface StubMetricTotals {
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  promptCacheTokensTotal: number;
  promptEvalTokensTotal: number;
  requestDurationMsTotal: number;
  completedRequestCount: number;
}

interface StubMetrics {
  schemaVersion: number;
  inputCharactersTotal: number;
  outputCharactersTotal: number;
  inputTokensTotal: number;
  outputTokensTotal: number;
  thinkingTokensTotal: number;
  toolTokensTotal: number;
  requestDurationMsTotal: number;
  completedRequestCount: number;
  taskTotals: Record<TaskKind, StubMetricTotals>;
  toolStats: Record<TaskKind, Record<string, ToolTypeStats>>;
  updatedAtUtc: string | null;
}

interface StubArtifactPost {
  type: JsonValue;
  requestId: JsonValue;
  path: string;
}

interface DeferredArtifactEntry {
  running: boolean;
  statusPath: JsonValue;
  artifactType: JsonValue;
  artifactRequestId: JsonValue;
  artifactPayload: JsonValue;
}

interface StubServerState {
  config: SiftConfig;
  statusPosts: JsonObject[];
  artifactPosts: StubArtifactPost[];
  chatRequests: ChatRequest[];
  tokenizeRequests: JsonObject[];
  summaryRouteRequests: JsonObject[];
  healthChecks: number;
  running: boolean;
  metrics: StubMetrics;
}

type StubChatResponder = (promptText: string, parsed: JsonObject, requestIndex: number) => JsonObject | null;
type StubTokenizeTokenCount = (content: string, parsed: JsonObject) => number;

interface StubServerOptions {
  config?: JsonObject;
  running?: boolean;
  metrics?: Partial<StubMetrics>;
  healthFailuresBeforeOk?: number;
  tokenizeTokenCount?: StubTokenizeTokenCount;
  tokenizeCharsPerToken?: number;
  chatDelayMs?: number;
  rejectPromptCharsOver?: number;
  assistantContent?: AssistantResponder;
  assistantReasoningContent?: AssistantResponder;
  omitUsage?: boolean;
  reasoningTokens?: number;
  chatResponse?: StubChatResponder;
  failStatusPosts?: boolean;
  failArtifactPosts?: boolean;
  busyStatusPostCount?: number;
  delayNonTerminalStatusFalseMs?: number;
}

interface StubServer {
  port: number;
  healthUrl: string;
  statusUrl: string;
  configUrl: string;
  state: StubServerState;
  close(): Promise<void>;
}

// Surface guaranteed by withSummaryTestServer. In-process stub mode supplies a full
// StubServer (StubServer is assignable here, so no cast). Existing-server mode
// (SIFTKIT_TEST_USE_EXISTING_SERVER=1) substitutes a live external server and exposes
// URLs only, so stub-only `state` is genuinely optional and the type says so.
interface SummaryTestServer {
  statusUrl: string;
  configUrl: string;
  state?: StubServerState;
}

interface SpawnProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface RealStatusServerOptions {
  statusPath: string;
  configPath: string;
  idleSummaryDbPath?: string;
  terminalMetadataIdleDelayMs?: number;
  managedLlamaFlushIdleDelayMs?: number;
  disableManagedLlamaStartup?: boolean;
  awaitStartup?: boolean;
}

interface RealStatusServerContext {
  server: ReturnType<typeof startStatusServer>;
  port: number;
  statusUrl: string;
  healthUrl: string;
  configUrl: string;
  statusPath: string;
  configPath: string;
  idleSummaryDbPath: string;
}

interface StatusServerProcessOptions {
  statusPath: string;
  configPath: string;
  workingDirectory?: string;
  idleSummaryDbPath?: string;
  idleSummaryDelayMs?: number;
  terminalMetadataIdleDelayMs?: number;
  managedLlamaFlushIdleDelayMs?: number;
  disableManagedLlamaStartup?: boolean;
  startupTimeoutMs?: number;
}

interface StatusServerProcessStartupInfo {
  ok?: boolean;
  port: number;
  startupWarning?: string | null;
}

interface StatusServerProcessCloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const IdleSummarySnapshotRowSchema = z.object({
  emitted_at_utc: z.string(),
  completed_request_count: z.number(),
  input_characters_total: z.number(),
  output_characters_total: z.number(),
  input_tokens_total: z.number(),
  output_tokens_total: z.number(),
  thinking_tokens_total: z.number(),
  saved_tokens: z.number(),
  saved_percent: z.number().nullable(),
  compression_ratio: z.number().nullable(),
  request_duration_ms_total: z.number(),
  avg_request_ms: z.number().nullable(),
  avg_tokens_per_second: z.number().nullable(),
});
type IdleSummarySnapshotRow = z.infer<typeof IdleSummarySnapshotRowSchema>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeDirectoryWithRetries(targetPath: string, attempts = 300, delayMs = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
      if (code !== 'EPERM' && code !== 'EBUSY') {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

function spawnProcess(command: string, args: string[], options: SpawnOptions = {}): Promise<SpawnProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function scheduleDeferredArtifactWrite(state: StubServerState, parsed: JsonObject, options: StubServerOptions): void {
  const rawDeferredArtifacts = parsed.deferredArtifacts;
  if (!Array.isArray(rawDeferredArtifacts) || rawDeferredArtifacts.length === 0) {
    return;
  }
  const deferredArtifacts: DeferredArtifactEntry[] = rawDeferredArtifacts
    .filter((entry): entry is JsonObject => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      running: false,
      statusPath: parsed.statusPath,
      artifactType: entry.artifactType,
      artifactRequestId: entry.artifactRequestId,
      artifactPayload: entry.artifactPayload,
    }));
  if (deferredArtifacts.length === 0) {
    return;
  }
  const writeArtifacts = (artifacts: DeferredArtifactEntry[]): void => {
    for (const artifactPost of artifacts) {
      const artifactPath = resolveArtifactLogPathFromStatusPost(artifactPost);
      if (!artifactPath) {
        continue;
      }
      if (options.failArtifactPosts) {
        continue;
      }
      if (!artifactPost.artifactPayload || typeof artifactPost.artifactPayload !== 'object' || Array.isArray(artifactPost.artifactPayload)) {
        continue;
      }
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, `${JSON.stringify(artifactPost.artifactPayload, null, 2)}\n`, 'utf8');
      state.artifactPosts.push({
        type: artifactPost.artifactType,
        requestId: artifactPost.artifactRequestId,
        path: artifactPath,
      });
    }
  };
  writeArtifacts(deferredArtifacts.filter((artifact) => artifact.artifactType !== 'summary_request'));
  const delayedArtifacts = deferredArtifacts.filter((artifact) => artifact.artifactType === 'summary_request');
  if (delayedArtifacts.length > 0) {
    setTimeout(() => writeArtifacts(delayedArtifacts), 25);
  }
}

function applyDeferredStatusMetrics(state: StubServerState, parsed: JsonObject): void {
  const metadata = parsed.deferredMetadata;
  if (!isJsonObject(metadata)) {
    return;
  }
  state.metrics.inputCharactersTotal += Number.isFinite(metadata.promptCharacterCount) ? Number(metadata.promptCharacterCount) : 0;
  state.metrics.outputCharactersTotal += Number.isFinite(metadata.outputCharacterCount) ? Number(metadata.outputCharacterCount) : 0;
  state.metrics.inputTokensTotal += Number.isFinite(metadata.inputTokens) ? Number(metadata.inputTokens) : 0;
  state.metrics.outputTokensTotal += Number.isFinite(metadata.outputTokens) ? Number(metadata.outputTokens) : 0;
  state.metrics.thinkingTokensTotal += Number.isFinite(metadata.thinkingTokens) ? Number(metadata.thinkingTokens) : 0;
  state.metrics.toolTokensTotal += Number.isFinite(metadata.toolTokens) ? Number(metadata.toolTokens) : 0;
  state.metrics.requestDurationMsTotal += Number.isFinite(metadata.requestDurationMs) ? Number(metadata.requestDurationMs) : 0;
  state.metrics.completedRequestCount += 1;
  const taskKind = parsed.taskKind;
  if (taskKind === 'summary' || taskKind === 'plan' || taskKind === 'repo-search' || taskKind === 'chat') {
    const taskTotals = state.metrics.taskTotals[taskKind];
    taskTotals.inputCharactersTotal += Number.isFinite(metadata.promptCharacterCount) ? Number(metadata.promptCharacterCount) : 0;
    taskTotals.outputCharactersTotal += Number.isFinite(metadata.outputCharacterCount) ? Number(metadata.outputCharacterCount) : 0;
    taskTotals.inputTokensTotal += Number.isFinite(metadata.inputTokens) ? Number(metadata.inputTokens) : 0;
    taskTotals.outputTokensTotal += Number.isFinite(metadata.outputTokens) ? Number(metadata.outputTokens) : 0;
    taskTotals.thinkingTokensTotal += Number.isFinite(metadata.thinkingTokens) ? Number(metadata.thinkingTokens) : 0;
    taskTotals.toolTokensTotal += Number.isFinite(metadata.toolTokens) ? Number(metadata.toolTokens) : 0;
    taskTotals.requestDurationMsTotal += Number.isFinite(metadata.requestDurationMs) ? Number(metadata.requestDurationMs) : 0;
    taskTotals.completedRequestCount += 1;
    const toolStats = metadata.toolStats;
    if (isJsonObject(toolStats)) {
      const existing = state.metrics.toolStats[taskKind];
      for (const [toolType, rawStats] of Object.entries(toolStats)) {
        if (!isJsonObject(rawStats)) {
          continue;
        }
        const current: ToolTypeStats = existing[toolType] || {
          calls: 0,
          outputCharsTotal: 0,
          outputTokensTotal: 0,
          outputTokensEstimatedCount: 0,
          lineReadCalls: 0,
          lineReadLinesTotal: 0,
          lineReadTokensTotal: 0,
          finishRejections: 0,
          semanticRepeatRejects: 0,
          stagnationWarnings: 0,
          forcedFinishFromStagnation: 0,
          promptInsertedTokens: 0,
          rawToolResultTokens: 0,
          newEvidenceCalls: 0,
          noNewEvidenceCalls: 0,
        };
        const stats = rawStats;
        existing[toolType] = {
          calls: current.calls + (Number.isFinite(stats.calls) ? Number(stats.calls) : 0),
          outputCharsTotal: current.outputCharsTotal + (Number.isFinite(stats.outputCharsTotal) ? Number(stats.outputCharsTotal) : 0),
          outputTokensTotal: current.outputTokensTotal + (Number.isFinite(stats.outputTokensTotal) ? Number(stats.outputTokensTotal) : 0),
          outputTokensEstimatedCount: current.outputTokensEstimatedCount + (
            Number.isFinite(stats.outputTokensEstimatedCount) ? Number(stats.outputTokensEstimatedCount) : 0
          ),
          lineReadCalls: current.lineReadCalls + (Number.isFinite(stats.lineReadCalls) ? Number(stats.lineReadCalls) : 0),
          lineReadLinesTotal: current.lineReadLinesTotal + (Number.isFinite(stats.lineReadLinesTotal) ? Number(stats.lineReadLinesTotal) : 0),
          lineReadTokensTotal: current.lineReadTokensTotal + (Number.isFinite(stats.lineReadTokensTotal) ? Number(stats.lineReadTokensTotal) : 0),
          finishRejections: current.finishRejections + (Number.isFinite(stats.finishRejections) ? Number(stats.finishRejections) : 0),
          semanticRepeatRejects: current.semanticRepeatRejects + (
            Number.isFinite(stats.semanticRepeatRejects) ? Number(stats.semanticRepeatRejects) : 0
          ),
          stagnationWarnings: current.stagnationWarnings + (Number.isFinite(stats.stagnationWarnings) ? Number(stats.stagnationWarnings) : 0),
          forcedFinishFromStagnation: current.forcedFinishFromStagnation + (
            Number.isFinite(stats.forcedFinishFromStagnation) ? Number(stats.forcedFinishFromStagnation) : 0
          ),
          promptInsertedTokens: current.promptInsertedTokens + (
            Number.isFinite(stats.promptInsertedTokens) ? Number(stats.promptInsertedTokens) : 0
          ),
          rawToolResultTokens: current.rawToolResultTokens + (
            Number.isFinite(stats.rawToolResultTokens) ? Number(stats.rawToolResultTokens) : 0
          ),
          newEvidenceCalls: current.newEvidenceCalls + (Number.isFinite(stats.newEvidenceCalls) ? Number(stats.newEvidenceCalls) : 0),
          noNewEvidenceCalls: current.noNewEvidenceCalls + (Number.isFinite(stats.noNewEvidenceCalls) ? Number(stats.noNewEvidenceCalls) : 0),
        };
      }
    }
  }
}

function scheduleDeferredStatusMetrics(state: StubServerState, parsed: JsonObject): void {
  if (!parsed.deferredMetadata || typeof parsed.deferredMetadata !== 'object' || Array.isArray(parsed.deferredMetadata)) {
    return;
  }
  setTimeout(() => {
    applyDeferredStatusMetrics(state, parsed);
  }, 25);
}

async function waitForTextMatch(getText: () => string, pattern: RegExp, timeoutMs = 2000): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const text = getText();
    if (pattern.test(text)) {
      return text;
    }

    if ((Date.now() - startedAt) >= timeoutMs) {
      throw new Error(`Timed out waiting for match ${String(pattern)}.\n${text}`);
    }

    await sleep(10);
  }
}

async function startStubStatusServer(options: StubServerOptions = {}): Promise<StubServer> {
  const state: StubServerState = {
    config: asRuntimeSiftConfig(mergeConfig(toJsonValue(getDefaultConfig()), options.config || {})),
    statusPosts: [],
    artifactPosts: [],
    chatRequests: [],
    tokenizeRequests: [],
    summaryRouteRequests: [],
    healthChecks: 0,
    running: Boolean(options.running),
    metrics: {
      schemaVersion: 2,
      inputCharactersTotal: 3461904,
      outputCharactersTotal: 0,
      inputTokensTotal: 1865267,
      outputTokensTotal: 0,
      thinkingTokensTotal: 0,
      toolTokensTotal: 0,
      requestDurationMsTotal: 0,
      completedRequestCount: 0,
      taskTotals: {
        summary: {
          inputCharactersTotal: 0,
          outputCharactersTotal: 0,
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 0,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 0,
          completedRequestCount: 0,
        },
        plan: {
          inputCharactersTotal: 0,
          outputCharactersTotal: 0,
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 0,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 0,
          completedRequestCount: 0,
        },
        'repo-search': {
          inputCharactersTotal: 0,
          outputCharactersTotal: 0,
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 0,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 0,
          completedRequestCount: 0,
        },
        chat: {
          inputCharactersTotal: 0,
          outputCharactersTotal: 0,
          inputTokensTotal: 0,
          outputTokensTotal: 0,
          thinkingTokensTotal: 0,
          toolTokensTotal: 0,
          promptCacheTokensTotal: 0,
          promptEvalTokensTotal: 0,
          requestDurationMsTotal: 0,
          completedRequestCount: 0,
        },
      },
      toolStats: {
        summary: {},
        plan: {},
        'repo-search': {},
        chat: {},
      },
      updatedAtUtc: null,
      ...(options.metrics || {}),
    },
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      state.healthChecks += 1;
      if (state.healthChecks <= Number(options.healthFailuresBeforeOk || 0)) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: state.running, status: state.running ? 'true' : 'false', metrics: state.metrics }));
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }

    if (req.method === 'POST' && req.url === '/summary') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      state.summaryRouteRequests.push(parsed);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      try {
        const result = await summarizeRequest({
          question: String(parsed.question || ''),
          inputText: String(parsed.inputText || ''),
          format: parsed.format === 'json' ? 'json' : 'text',
          policyProfile: parsed.policyProfile || 'general',
          backend: typeof parsed.backend === 'string' ? parsed.backend : undefined,
          model: typeof parsed.model === 'string' ? parsed.model : undefined,
          promptPrefix: typeof parsed.promptPrefix === 'string' ? parsed.promptPrefix : undefined,
          llamaCppOverrides: parsed.llamaCppOverrides && typeof parsed.llamaCppOverrides === 'object' && !Array.isArray(parsed.llamaCppOverrides) && Number.isFinite(Number(parsed.llamaCppOverrides.MaxTokens))
            ? { MaxTokens: Number(parsed.llamaCppOverrides.MaxTokens) }
            : undefined,
          sourceKind: parsed.sourceKind === 'command-output' ? 'command-output' : 'standalone',
          commandExitCode: Number.isFinite(Number(parsed.commandExitCode)) ? Number(parsed.commandExitCode) : undefined,
          timing: parsed.timing && typeof parsed.timing === 'object' && !Array.isArray(parsed.timing) ? parsed.timing : undefined,
          statusBackendUrl: `http://127.0.0.1:${port}/status`,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ id: state.config.Runtime?.Model }],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/tokenize') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const content = String(parsed?.content || '');
      state.tokenizeRequests.push(parsed);
      if (typeof options.tokenizeTokenCount === 'function') {
        const tokenCount = options.tokenizeTokenCount(content, parsed);
        if (!Number.isFinite(tokenCount) || Number(tokenCount) < 0) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'tokenize unavailable' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: Number(tokenCount) }));
        return;
      }
      if (!Number.isFinite(options.tokenizeCharsPerToken) || Number(options.tokenizeCharsPerToken) <= 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tokenize unavailable' }));
        return;
      }
      const tokenCount = content.trim()
        ? Math.max(1, Math.ceil(content.length / Number(options.tokenizeCharsPerToken)))
        : 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: tokenCount }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const promptText = getChatRequestText(parsed);
      state.chatRequests.push(parsed);
      if (Number.isFinite(options.chatDelayMs) && Number(options.chatDelayMs) > 0) {
        await sleep(Number(options.chatDelayMs));
      }
      if (Number.isFinite(options.rejectPromptCharsOver) && String(promptText).length > Number(options.rejectPromptCharsOver)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `prompt too large: ${String(promptText).length}` }));
        return;
      }
      const configuredAssistantContent = resolveAssistantContent(
        options.assistantContent,
        String(promptText),
        parsed,
        state.chatRequests.length,
      );
      const configuredReasoningContent = resolveAssistantContent(
        options.assistantReasoningContent,
        String(promptText),
        parsed,
        state.chatRequests.length,
      );
      const assistantContent = typeof configuredAssistantContent === 'string'
        ? configuredAssistantContent
        : (/"classification":"summary|command_failure|unsupported_input"/u.test(promptText)
          ? JSON.stringify(buildStructuredStubDecision(String(promptText)))
          : `summary:${String(promptText).slice(0, 24)}`);
      const usage = options.omitUsage ? null : {
        prompt_tokens: 123,
        completion_tokens: 45,
        total_tokens: 168,
        ...(options.reasoningTokens === undefined ? {} : {
          completion_tokens_details: {
            reasoning_tokens: options.reasoningTokens,
          },
        }),
      };
      const configuredChatResponse = typeof options.chatResponse === 'function'
        ? options.chatResponse(String(promptText), parsed, state.chatRequests.length)
        : null;
      if (configuredChatResponse && typeof configuredChatResponse === 'object') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(configuredChatResponse));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: assistantContent,
              ...(typeof configuredReasoningContent === 'string'
                ? { reasoning_content: configuredReasoningContent }
                : {}),
            },
          },
        ],
        ...(usage ? { usage } : {}),
      }));
      return;
    }

    if (req.method === 'PUT' && req.url === '/config') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      state.config = asRuntimeSiftConfig(mergeConfig(toJsonValue(getDefaultConfig()), parsed));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }

    if (req.method === 'POST' && req.url === '/status/complete') {
      if (options.failStatusPosts) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'status unavailable' }));
        return;
      }

      await readBody(req);
      state.running = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running: false }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/status' || req.url === '/status/terminal-metadata')) {
      if (options.failStatusPosts) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'status unavailable' }));
        return;
      }

      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const artifactPath = resolveArtifactLogPathFromStatusPost(parsed);
      const hasArtifactPayload = artifactPath !== null;
      if (hasArtifactPayload && options.failArtifactPosts) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'artifact unavailable' }));
        return;
      }
      if (hasArtifactPayload && (!parsed.artifactPayload || typeof parsed.artifactPayload !== 'object' || Array.isArray(parsed.artifactPayload))) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'artifact payload must be a JSON object' }));
        return;
      }
      if (hasArtifactPayload) {
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, `${JSON.stringify(parsed.artifactPayload, null, 2)}\n`, 'utf8');
        state.artifactPosts.push({
          type: parsed.artifactType,
          requestId: parsed.artifactRequestId,
          path: artifactPath,
        });
      }
      state.statusPosts.push(parsed);
      const busyStatusPostCount = Number(options.busyStatusPostCount || 0);
      if (busyStatusPostCount > 0 && state.statusPosts.length <= busyStatusPostCount) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, busy: true }));
        return;
      }
      scheduleDeferredStatusMetrics(state, parsed);
      scheduleDeferredArtifactWrite(state, parsed, options);
      state.running = Boolean(parsed.running);
      if (!parsed.running && !hasArtifactPayload && !parsed.deferredMetadata) {
        state.metrics.inputCharactersTotal += Number.isFinite(parsed.promptCharacterCount) ? Number(parsed.promptCharacterCount) : 0;
        state.metrics.outputCharactersTotal += Number.isFinite(parsed.outputCharacterCount) ? Number(parsed.outputCharacterCount) : 0;
        state.metrics.inputTokensTotal += Number.isFinite(parsed.inputTokens) ? Number(parsed.inputTokens) : 0;
        state.metrics.outputTokensTotal += Number.isFinite(parsed.outputTokens) ? Number(parsed.outputTokens) : 0;
        state.metrics.thinkingTokensTotal += Number.isFinite(parsed.thinkingTokens) ? Number(parsed.thinkingTokens) : 0;
        state.metrics.toolTokensTotal += Number.isFinite(parsed.toolTokens) ? Number(parsed.toolTokens) : 0;
        state.metrics.requestDurationMsTotal += Number.isFinite(parsed.requestDurationMs) ? Number(parsed.requestDurationMs) : 0;
        state.metrics.completedRequestCount += 1;
        const taskKindValue: JsonValue = parsed.taskKind;
        const taskKind = typeof taskKindValue === 'string' ? taskKindValue : '';
        if (taskKind === 'summary' || taskKind === 'plan' || taskKind === 'repo-search' || taskKind === 'chat') {
          const taskTotals = state.metrics.taskTotals[taskKind];
          taskTotals.inputCharactersTotal += Number.isFinite(parsed.promptCharacterCount) ? Number(parsed.promptCharacterCount) : 0;
          taskTotals.outputCharactersTotal += Number.isFinite(parsed.outputCharacterCount) ? Number(parsed.outputCharacterCount) : 0;
          taskTotals.inputTokensTotal += Number.isFinite(parsed.inputTokens) ? Number(parsed.inputTokens) : 0;
          taskTotals.outputTokensTotal += Number.isFinite(parsed.outputTokens) ? Number(parsed.outputTokens) : 0;
          taskTotals.thinkingTokensTotal += Number.isFinite(parsed.thinkingTokens) ? Number(parsed.thinkingTokens) : 0;
          taskTotals.toolTokensTotal += Number.isFinite(parsed.toolTokens) ? Number(parsed.toolTokens) : 0;
          taskTotals.requestDurationMsTotal += Number.isFinite(parsed.requestDurationMs) ? Number(parsed.requestDurationMs) : 0;
          taskTotals.completedRequestCount += 1;
          const parsedToolStats = parsed.toolStats;
          if (isJsonObject(parsedToolStats)) {
            const existing = state.metrics.toolStats[taskKind];
            for (const [toolType, rawStats] of Object.entries(parsedToolStats)) {
              if (!isJsonObject(rawStats)) {
                continue;
              }
              const current = existing[toolType] || {
                calls: 0,
                outputCharsTotal: 0,
                outputTokensTotal: 0,
                outputTokensEstimatedCount: 0,
                lineReadCalls: 0,
                lineReadLinesTotal: 0,
                lineReadTokensTotal: 0,
                finishRejections: 0,
                semanticRepeatRejects: 0,
                stagnationWarnings: 0,
                forcedFinishFromStagnation: 0,
                promptInsertedTokens: 0,
                rawToolResultTokens: 0,
                newEvidenceCalls: 0,
                noNewEvidenceCalls: 0,
              };
              const stats = rawStats;
              existing[toolType] = {
                calls: current.calls + (Number.isFinite(stats.calls) ? Number(stats.calls) : 0),
                outputCharsTotal: current.outputCharsTotal + (Number.isFinite(stats.outputCharsTotal) ? Number(stats.outputCharsTotal) : 0),
                outputTokensTotal: current.outputTokensTotal + (Number.isFinite(stats.outputTokensTotal) ? Number(stats.outputTokensTotal) : 0),
                outputTokensEstimatedCount: current.outputTokensEstimatedCount + (
                  Number.isFinite(stats.outputTokensEstimatedCount) ? Number(stats.outputTokensEstimatedCount) : 0
                ),
                lineReadCalls: current.lineReadCalls + (Number.isFinite(stats.lineReadCalls) ? Number(stats.lineReadCalls) : 0),
                lineReadLinesTotal: current.lineReadLinesTotal + (Number.isFinite(stats.lineReadLinesTotal) ? Number(stats.lineReadLinesTotal) : 0),
                lineReadTokensTotal: current.lineReadTokensTotal + (Number.isFinite(stats.lineReadTokensTotal) ? Number(stats.lineReadTokensTotal) : 0),
                finishRejections: current.finishRejections + (Number.isFinite(stats.finishRejections) ? Number(stats.finishRejections) : 0),
                semanticRepeatRejects: current.semanticRepeatRejects + (
                  Number.isFinite(stats.semanticRepeatRejects) ? Number(stats.semanticRepeatRejects) : 0
                ),
                stagnationWarnings: current.stagnationWarnings + (Number.isFinite(stats.stagnationWarnings) ? Number(stats.stagnationWarnings) : 0),
                forcedFinishFromStagnation: current.forcedFinishFromStagnation + (
                  Number.isFinite(stats.forcedFinishFromStagnation) ? Number(stats.forcedFinishFromStagnation) : 0
                ),
                promptInsertedTokens: current.promptInsertedTokens + (
                  Number.isFinite(stats.promptInsertedTokens) ? Number(stats.promptInsertedTokens) : 0
                ),
                rawToolResultTokens: current.rawToolResultTokens + (
                  Number.isFinite(stats.rawToolResultTokens) ? Number(stats.rawToolResultTokens) : 0
                ),
                newEvidenceCalls: current.newEvidenceCalls + (Number.isFinite(stats.newEvidenceCalls) ? Number(stats.newEvidenceCalls) : 0),
                noNewEvidenceCalls: current.noNewEvidenceCalls + (
                  Number.isFinite(stats.noNewEvidenceCalls) ? Number(stats.noNewEvidenceCalls) : 0
                ),
              };
            }
          }
        }
        state.metrics.updatedAtUtc = new Date().toISOString();
      }
      if (
        Number.isFinite(Number(options.delayNonTerminalStatusFalseMs))
        && Number(options.delayNonTerminalStatusFalseMs) > 0
        && parsed.running === false
        && !parsed.terminalState
        && !parsed.deferredMetadata
        && !hasArtifactPayload
      ) {
        await sleep(Number(options.delayNonTerminalStatusFalseMs));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running: Boolean(parsed.running) }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const stubBaseUrl = `http://127.0.0.1:${port}`;
  state.config.Runtime.LlamaCpp.BaseUrl = stubBaseUrl;
  if (state.config.Server.LlamaCpp.Presets.length === 0) {
    const defaultPreset = getDefaultConfig().Server.LlamaCpp.Presets[0];
    state.config.Server.LlamaCpp.Presets.push({ ...defaultPreset, id: 'default', label: 'Default' });
    state.config.Server.LlamaCpp.ActivePresetId = 'default';
  }
  for (const preset of state.config.Server.LlamaCpp.Presets) {
    preset.BaseUrl = stubBaseUrl;
  }

  return {
    port,
    healthUrl: `http://127.0.0.1:${port}/health`,
    statusUrl: `http://127.0.0.1:${port}/status`,
    configUrl: `http://127.0.0.1:${port}/config`,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
    },
  };
}

let tempEnvQueue: Promise<void> = Promise.resolve();

function runWithTempEnv<R>(fn: (tempRoot: string) => R | Promise<R>): Promise<R> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-node-test-'));
  const previousCwd = process.cwd();
  const previous = {
    USERPROFILE: process.env.USERPROFILE,
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_TEST_PROVIDER: process.env.SIFTKIT_TEST_PROVIDER,
    SIFTKIT_TEST_PROVIDER_BEHAVIOR: process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR,
    SIFTKIT_TEST_PROVIDER_LOG_PATH: process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH,
    SIFTKIT_TEST_PROVIDER_SLEEP_MS: process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS: process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS,
  };

  process.env.USERPROFILE = tempRoot;
  process.env.sift_kit_status = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  process.env.SIFTKIT_STATUS_PATH = process.env.sift_kit_status;
  process.env.SIFTKIT_CONFIG_PATH = path.join(tempRoot, '.siftkit', 'config.json');
  process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS = '0';
  delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  delete process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  delete process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  delete process.env.SIFTKIT_STATUS_PORT;
  delete process.env.SIFTKIT_STATUS_HOST;
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_TEST_PROVIDER = 'mock';
  fs.writeFileSync(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'siftkit', version: '0.1.0' }, null, 2),
    'utf8',
  );
  process.chdir(tempRoot);

  const cleanup = async () => {
    process.chdir(previousCwd);
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeDirectoryWithRetries(tempRoot);
  };

  return Promise.resolve()
    .then(() => fn(tempRoot))
    .finally(cleanup);
}

function withTempEnv<R>(fn: (tempRoot: string) => R | Promise<R>): Promise<R> {
  const queued = tempEnvQueue.then(() => runWithTempEnv(fn), () => runWithTempEnv(fn));
  tempEnvQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

function seedRuntimeConfigFromJson(configPath: string): void {
  if (!configPath || !fs.existsSync(configPath) || path.extname(configPath).toLowerCase() !== '.json') {
    return;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const serverLlama = config?.Server?.LlamaCpp;
  if (serverLlama && typeof serverLlama === 'object') {
    if (!serverLlama.BaseUrl && config?.Runtime?.LlamaCpp?.BaseUrl) {
      serverLlama.BaseUrl = config.Runtime.LlamaCpp.BaseUrl;
    }
    if (!serverLlama.ModelPath && serverLlama.ExecutablePath) {
      const modelPath = path.join(path.dirname(serverLlama.ExecutablePath), 'managed-test-model.gguf');
      if (!fs.existsSync(modelPath)) {
        fs.writeFileSync(modelPath, 'fake model', 'utf8');
      }
      serverLlama.ModelPath = modelPath;
    }
    // Managed-llama settings live on the active preset. Wrap any flat
    // Server.LlamaCpp.* fields from legacy-shaped test fixtures into one preset.
    if (!Array.isArray(serverLlama.Presets) || serverLlama.Presets.length === 0) {
      const { Presets, ActivePresetId, ...managedFields } = serverLlama;
      config.Server.LlamaCpp = {
        ActivePresetId: 'default',
        Presets: [{ id: 'default', label: 'Default', ...managedFields }],
      };
    }
  }
  writeConfig(getConfigPath(), config);
}

async function withStubServer<R>(fn: (server: StubServer) => R | Promise<R>, options: StubServerOptions = {}): Promise<R> {
  const previous = {
    SIFTKIT_STATUS_BACKEND_URL: process.env.SIFTKIT_STATUS_BACKEND_URL,
    SIFTKIT_CONFIG_SERVICE_URL: process.env.SIFTKIT_CONFIG_SERVICE_URL,
  };
  const server = await startStubStatusServer(options);
  process.env.SIFTKIT_STATUS_BACKEND_URL = server.statusUrl;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = server.configUrl;
  try {
    return await fn(server);
  } finally {
    await server.close();
    if (previous.SIFTKIT_STATUS_BACKEND_URL === undefined) {
      delete process.env.SIFTKIT_STATUS_BACKEND_URL;
    } else {
      process.env.SIFTKIT_STATUS_BACKEND_URL = previous.SIFTKIT_STATUS_BACKEND_URL;
    }
    if (previous.SIFTKIT_CONFIG_SERVICE_URL === undefined) {
      delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
    } else {
      process.env.SIFTKIT_CONFIG_SERVICE_URL = previous.SIFTKIT_CONFIG_SERVICE_URL;
    }
  }
}

async function withSummaryTestServer<R>(fn: (server: SummaryTestServer) => R | Promise<R>, options: StubServerOptions = {}): Promise<R> {
  if (!TEST_USE_EXISTING_SERVER) {
    return withStubServer(fn, options);
  }

  assert.ok(EXISTING_SERVER_STATUS_URL, 'SIFTKIT_STATUS_BACKEND_URL is required when SIFTKIT_TEST_USE_EXISTING_SERVER=1.');
  assert.ok(EXISTING_SERVER_CONFIG_URL, 'SIFTKIT_CONFIG_SERVICE_URL is required when SIFTKIT_TEST_USE_EXISTING_SERVER=1.');
  await requestJson(deriveServiceUrl(EXISTING_SERVER_CONFIG_URL, '/health'));

  process.env.SIFTKIT_STATUS_BACKEND_URL = EXISTING_SERVER_STATUS_URL;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = EXISTING_SERVER_CONFIG_URL;
  return fn({
    statusUrl: EXISTING_SERVER_STATUS_URL,
    configUrl: EXISTING_SERVER_CONFIG_URL,
  });
}

function getStatusRouteUrl(statusUrl: string, routePath: string): string {
  return deriveServiceUrl(statusUrl, routePath);
}

async function postStatusTerminalMetadata(statusUrl: string, metadata: JsonObject): Promise<StatusPostAck> {
  return requestJson<StatusPostAck>(getStatusRouteUrl(statusUrl, '/status/terminal-metadata'), {
    method: 'POST',
    body: JSON.stringify({
      running: false,
      ...metadata,
    }),
  });
}

async function postStatusComplete(statusUrl: string, completion: JsonObject): Promise<StatusPostAck> {
  return requestJson<StatusPostAck>(getStatusRouteUrl(statusUrl, '/status/complete'), {
    method: 'POST',
    body: JSON.stringify(completion),
  });
}

async function postCompletedStatus(statusUrl: string, metadata: JsonObject): Promise<{ metadataResponse: StatusPostAck; completeResponse: StatusPostAck }> {
  const requestId = typeof metadata?.requestId === 'string' ? metadata.requestId.trim() : '';
  const terminalState = typeof metadata?.terminalState === 'string' ? metadata.terminalState.trim() : '';
  if (!requestId) {
    throw new Error('postCompletedStatus requires requestId.');
  }
  if (terminalState !== 'completed' && terminalState !== 'failed') {
    throw new Error('postCompletedStatus requires terminalState=completed|failed.');
  }
  const metadataResponse = await postStatusTerminalMetadata(statusUrl, metadata);
  const completeResponse = await postStatusComplete(statusUrl, {
    requestId,
    ...(typeof metadata.taskKind === 'string' ? { taskKind: metadata.taskKind } : {}),
    terminalState,
  });
  return { metadataResponse, completeResponse };
}

function getOptionalNonNegativeInteger(value: number | undefined): number | null {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return Math.max(0, Math.trunc(Number(value)));
}

async function withRealStatusServer<R>(fn: (context: RealStatusServerContext) => R | Promise<R>, options: RealStatusServerOptions): Promise<R> {
  const previous = {
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS,
    SIFTKIT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS: process.env.SIFTKIT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS,
    SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS: process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS,
    SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE: process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE,
  };

  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS = '0';
  process.env.SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE = '1';
  process.env.sift_kit_status = options.statusPath;
  process.env.SIFTKIT_STATUS_PATH = options.statusPath;
  process.env.SIFTKIT_CONFIG_PATH = options.configPath;
  if (options.idleSummaryDbPath) {
    process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = options.idleSummaryDbPath;
  } else {
    delete process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
  }
  const terminalMetadataIdleDelayMs = getOptionalNonNegativeInteger(options.terminalMetadataIdleDelayMs);
  if (terminalMetadataIdleDelayMs !== null) {
    process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS = String(terminalMetadataIdleDelayMs);
  } else {
    delete process.env.SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS;
  }
  const managedLlamaFlushIdleDelayMs = getOptionalNonNegativeInteger(options.managedLlamaFlushIdleDelayMs);
  if (managedLlamaFlushIdleDelayMs !== null) {
    process.env.SIFTKIT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS = String(managedLlamaFlushIdleDelayMs);
  } else {
    delete process.env.SIFTKIT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS;
  }

  seedRuntimeConfigFromJson(options.configPath);
  const server = startStatusServer({
    disableManagedLlamaStartup: Boolean(options.disableManagedLlamaStartup),
    terminalMetadataIdleDelayMs: terminalMetadataIdleDelayMs ?? undefined,
    managedLlamaFlushIdleDelayMs: managedLlamaFlushIdleDelayMs ?? undefined,
  });
  try {
    const address = await new Promise<AddressInfo | string | null>((resolve) => {
      if (server.listening) {
        resolve(server.address());
        return;
      }

      server.once('listening', () => resolve(server.address()));
    });
    const port = typeof address === 'object' && address ? address.port : 0;
    if (options.awaitStartup !== false && server.startupPromise) {
      await server.startupPromise;
    }

    return await fn({
      server,
      port,
      statusUrl: `http://127.0.0.1:${port}/status`,
      healthUrl: `http://127.0.0.1:${port}/health`,
      configUrl: `http://127.0.0.1:${port}/config`,
      statusPath: options.statusPath,
      configPath: options.configPath,
      idleSummaryDbPath: options.idleSummaryDbPath || getIdleSummarySnapshotsPath(),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); });
    closeRuntimeDatabase();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startStatusServerProcess(options: StatusServerProcessOptions) {
  seedRuntimeConfigFromJson(options.configPath);
  const childEnv = {
    ...process.env,
    SIFTKIT_STATUS_HOST: '127.0.0.1',
    SIFTKIT_STATUS_PORT: '0',
    sift_kit_status: options.statusPath,
    SIFTKIT_STATUS_PATH: options.statusPath,
    SIFTKIT_CONFIG_PATH: options.configPath,
    ...(options.idleSummaryDbPath ? { SIFTKIT_IDLE_SUMMARY_DB_PATH: options.idleSummaryDbPath } : {}),
    ...(getOptionalNonNegativeInteger(options.idleSummaryDelayMs) !== null ? { SIFTKIT_IDLE_SUMMARY_DELAY_MS: String(getOptionalNonNegativeInteger(options.idleSummaryDelayMs)) } : {}),
    ...(getOptionalNonNegativeInteger(options.terminalMetadataIdleDelayMs) !== null ? { SIFTKIT_TERMINAL_METADATA_IDLE_DELAY_MS: String(getOptionalNonNegativeInteger(options.terminalMetadataIdleDelayMs)) } : {}),
    ...(getOptionalNonNegativeInteger(options.managedLlamaFlushIdleDelayMs) !== null ? { SIFTKIT_MANAGED_LLAMA_FLUSH_IDLE_DELAY_MS: String(getOptionalNonNegativeInteger(options.managedLlamaFlushIdleDelayMs)) } : {}),
    SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS: '0',
    SIFTKIT_DISABLE_RUNTIME_HISTORY_PRUNE: '1',
  };
  const statusServerEntrypoint = path.resolve(__dirname, '..', 'dist', 'status-server', 'index.js');
  const args = [statusServerEntrypoint];
  if (options.disableManagedLlamaStartup) {
    args.push('--disable-managed-llama-startup');
  }
  const child = spawn(process.execPath, args, {
    cwd: options.workingDirectory || process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let stdoutBuffer = '';
  let startupResolved = false;
  let closeResolved = false;
  let resolveStartup!: (value: StatusServerProcessStartupInfo) => void;
  let rejectStartup!: (reason?: Error) => void;
  let resolveClose!: (value: StatusServerProcessCloseInfo) => void;
  const startup = new Promise<StatusServerProcessStartupInfo>((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  const closePromise = new Promise<StatusServerProcessCloseInfo>((resolve) => {
    resolveClose = resolve;
  });

  function handleStdoutChunk(chunk: Buffer): void {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/u);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      stdoutLines.push(line);
      if (!startupResolved) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.ok === true && Number.isFinite(parsed.port)) {
            startupResolved = true;
            resolveStartup(parsed);
          }
        } catch {
          // Ignore non-JSON log lines before startup resolves.
        }
      }
    }
  }

  child.stdout?.on('data', handleStdoutChunk);
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString());
  });
  child.on('error', (error) => {
    if (!startupResolved) {
      startupResolved = true;
      rejectStartup(error);
    }
  });
  child.on('close', (code, signal) => {
    if (!closeResolved) {
      closeResolved = true;
      resolveClose({ code, signal });
    }
    if (!startupResolved) {
      startupResolved = true;
      rejectStartup(new Error([
        `status server exited before startup (code=${code}, signal=${signal})`,
        `stdout:\n${stdoutLines.join('\n')}`,
        `stderr:\n${stderrLines.join('\n')}`,
      ].join('\n')));
    }
  });

  const startupTimeoutMs = options.startupTimeoutMs || 10_000;
  const startupInfo = await Promise.race([
    startup,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error([
      `Timed out waiting for status server startup after ${startupTimeoutMs} ms.`,
      `stdout:\n${stdoutLines.join('\n')}`,
      `stderr:\n${stderrLines.join('\n')}`,
    ].join('\n'))), startupTimeoutMs)),
  ]).catch(async (error) => {
    if (child.exitCode === null && !child.killed) {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
      await Promise.race([closePromise, sleep(2000)]);
    }
    throw error;
  });

  return {
    port: startupInfo.port,
    startupWarning: startupInfo.startupWarning || null,
    statusUrl: `http://127.0.0.1:${startupInfo.port}/status`,
    configUrl: `http://127.0.0.1:${startupInfo.port}/config`,
    stdoutLines,
    stderrLines,
    idleSummaryDbPath: options.idleSummaryDbPath || path.join(path.dirname(options.statusPath), 'idle-summary.sqlite'),
    async waitForStdoutMatch(pattern: RegExp, timeoutMs = 2000): Promise<string> {
      const startedAt = Date.now();
      for (;;) {
        const matchedLine = stdoutLines.find((line) => pattern.test(line));
        if (matchedLine) {
          return matchedLine;
        }

        if ((Date.now() - startedAt) >= timeoutMs) {
          throw new Error(`Timed out waiting for stdout match ${String(pattern)}.\nstdout:\n${stdoutLines.join('\n')}\nstderr:\n${stderrLines.join('\n')}`);
        }

        await sleep(10);
      }
    },
    async waitForExit(timeoutMs = 5000): Promise<StatusServerProcessCloseInfo> {
      return await Promise.race([
        closePromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for status server exit after ${timeoutMs} ms.`)), timeoutMs)),
      ]);
    },
    async close() {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      if (process.platform === 'win32' && child.pid) {
        assert.equal(terminateProcessTree(child.pid), true);
        await Promise.race([
          closePromise,
          sleep(5000).then(() => {
            throw new Error('Timed out waiting for Windows status-server process-tree termination.');
          }),
        ]);
        return;
      }

      child.kill('SIGINT');
      const gracefulExit = await Promise.race([
        closePromise.then(() => true),
        sleep(5000).then(() => false),
      ]);
      if (gracefulExit) {
        return;
      }
      if (child.exitCode === null && !child.killed && process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
      await Promise.race([closePromise, sleep(5000)]);
    },
  };
}

function stripAnsi(text: string): string {
  return String(text).replace(/\u001b\[[0-9;]*m/gu, '');
}

async function captureStdout(fn: (lines: string[]) => void | Promise<void>): Promise<string[]> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  let buffer = '';
  const patchedWrite = (
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
  process.stdout.write = patchedWrite;

  try {
    await fn(lines);
  } finally {
    process.stdout.write = originalWrite;
  }

  if (buffer.trim()) {
    lines.push(buffer.trim());
  }
  return lines;
}

function readIdleSummarySnapshots(dbPath: string): IdleSummarySnapshotRow[] {
  const database = new Database(dbPath, { readonly: true });
  try {
    const rows = database.prepare(`
      SELECT
        emitted_at_utc,
        completed_request_count,
        input_characters_total,
        output_characters_total,
        input_tokens_total,
        output_tokens_total,
        thinking_tokens_total,
        saved_tokens,
        saved_percent,
        compression_ratio,
        request_duration_ms_total,
        avg_request_ms,
        avg_tokens_per_second
      FROM idle_summary_snapshots
      ORDER BY id ASC
    `).all();
    return z.array(IdleSummarySnapshotRowSchema).parse(rows);
  } finally {
    database.close();
  }
}

function getIdleSummaryBlock(stdoutLines: string[], requestsPattern: RegExp): string[] {
  const strippedLines = stdoutLines.map(stripAnsi);
  const startIndex = strippedLines.findIndex((line) => requestsPattern.test(line));
  assert.notEqual(startIndex, -1, `missing idle summary line matching ${String(requestsPattern)}\n${stdoutLines.join('\n')}`);
  let endIndex = strippedLines.length;
  for (let index = startIndex + 1; index < strippedLines.length; index += 1) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /u.test(strippedLines[index])) {
      endIndex = index;
      break;
    }
  }
  return strippedLines.slice(startIndex, endIndex);
}

async function getFreePort() {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  return port;
}

async function waitForAsyncExpectation(expectation: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  for (;;) {
    try {
      await expectation();
      return;
    } catch (error) {
      lastError = toError(error);
    }

    if ((Date.now() - startedAt) >= timeoutMs) {
      throw lastError ?? new Error('waitForAsyncExpectation timed out');
    }

    await sleep(25);
  }
}

function runPowerShellScript(scriptPath: string): void {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if ((result.status ?? 0) !== 0) {
    throw new Error(`PowerShell script failed (${scriptPath}) with exit code ${result.status ?? 'null'}: ${result.stderr || result.stdout}`);
  }
}


export {
  // Re-exports from dist modules (used by test files)
  assert, fs, http, os, path, spawn, spawnSync, Database,
  loadConfig, saveConfig, getConfigPath,
  getChunkThresholdCharacters, getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken, initializeRuntime,
  getStatusServerUnavailableMessage,
  summarizeRequest, buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks,
  getPlannerPromptBudget, buildPlannerToolDefinitions,
  runCommand, runBenchmarkSuite,
  readMatrixManifest, buildLaunchSignature, buildLauncherArgs, buildBenchmarkArgs,
  pruneOldLauncherLogs, runMatrix, runMatrixWithInterrupt,
  countLlamaCppTokens, listLlamaCppModels, generateLlamaCppResponse,
  buildIdleMetricsLogMessage, buildStatusRequestLogMessage, formatElapsed,
  getIdleSummarySnapshotsPath, startStatusServer,
  runDebugRequest, runFixture60MalformedJsonRepro,
  // Local helpers
  TEST_USE_EXISTING_SERVER, EXISTING_SERVER_STATUS_URL, EXISTING_SERVER_CONFIG_URL,
  RUN_LIVE_LLAMA_TOKENIZE_TESTS, LIVE_LLAMA_BASE_URL, LIVE_CONFIG_SERVICE_URL,
  FAST_LEASE_WAIT_MS,
  deriveServiceUrl, getDefaultConfig, clone, getChatRequestText, setManagedLlamaBaseUrl,
  mergeConfig, extractPromptSection, buildOversizedTransitionsInput,
  buildOversizedRunnerStateHistoryInput, getRuntimeRootFromStatusPath,
  getPlannerLogsPath, getFailedLogsPath, getRequestLogsPath,
  buildStructuredStubDecision, resolveAssistantContent, readBody,
  resolveArtifactLogPathFromStatusPost, requestJson, sleep,
  removeDirectoryWithRetries, spawnProcess, waitForTextMatch,
  startStubStatusServer, withTempEnv, withStubServer, withSummaryTestServer, mockSiftConfig as mockConfig,
  getStatusRouteUrl, postStatusTerminalMetadata, postStatusComplete, postCompletedStatus,
  withRealStatusServer, startStatusServerProcess, stripAnsi, captureStdout,
  readIdleSummarySnapshots, getIdleSummaryBlock, getFreePort,
  toSingleQuotedPowerShellLiteral, writeManagedLlamaScripts, writeManagedLlamaLauncher,
  waitForAsyncExpectation, runPowerShellScript, applyManagedScriptConfig,
};

export type { RuntimeStatusResponse, LlamaModelsResponse, HealthCheckResponse, StatusPostAck };
