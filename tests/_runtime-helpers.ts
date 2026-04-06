// @ts-nocheck — Shared runtime test infrastructure. Full typing deferred.
// Auto-generated from runtime.test.js infrastructure block.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getExecutionServerState,
  getChunkThresholdCharacters,
  getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken,
  initializeRuntime,
  getStatusServerUnavailableMessage,
  SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT,
} from '../dist/config/index.js';
import {
  summarizeRequest,
  buildPrompt,
  getSummaryDecision,
  planTokenAwareLlamaCppChunks,
  getPlannerPromptBudget,
  buildPlannerToolDefinitions,
  UNSUPPORTED_INPUT_MESSAGE,
} from '../dist/summary.js';
import { runCommand } from '../dist/command.js';
import { runBenchmarkSuite } from '../dist/benchmark/index.js';
import {
  readMatrixManifest,
  buildLaunchSignature,
  buildLauncherArgs,
  buildBenchmarkArgs,
  pruneOldLauncherLogs,
  runMatrix,
  runMatrixWithInterrupt,
} from '../dist/benchmark-matrix/index.js';
import {
  countLlamaCppTokens,
  listLlamaCppModels,
  generateLlamaCppResponse,
} from '../dist/providers/llama-cpp.js';
import { withExecutionLock } from '../dist/execution-lock.js';
import {
  buildIdleMetricsLogMessage,
  buildStatusRequestLogMessage,
  formatElapsed,
  getIdleSummarySnapshotsPath,
  startStatusServer,
} from '../dist/status-server/index.js';
import { runDebugRequest } from '../dist/scripts/run-benchmark-fixture-debug.js';
import { runFixture60MalformedJsonRepro } from '../dist/scripts/repro-fixture60-malformed-json.js';

const TEST_USE_EXISTING_SERVER = process.env.SIFTKIT_TEST_USE_EXISTING_SERVER === '1';
const EXISTING_SERVER_STATUS_URL = process.env.SIFTKIT_STATUS_BACKEND_URL;
const EXISTING_SERVER_CONFIG_URL = process.env.SIFTKIT_CONFIG_SERVICE_URL;
const RUN_LIVE_LLAMA_TOKENIZE_TESTS = process.env.SIFTKIT_RUN_LIVE_LLAMA_TOKENIZE_TESTS === '1';
const LIVE_LLAMA_BASE_URL = process.env.SIFTKIT_LIVE_LLAMA_BASE_URL?.trim() || 'http://127.0.0.1:8097';
const LIVE_CONFIG_SERVICE_URL = process.env.SIFTKIT_CONFIG_SERVICE_URL?.trim() || 'http://127.0.0.1:4765/config';
const FAST_LEASE_STALE_MS = 200;
const FAST_LEASE_WAIT_MS = 350;

function deriveServiceUrl(configuredUrl, nextPath) {
  const target = new URL(configuredUrl);
  target.pathname = nextPath;
  target.search = '';
  target.hash = '';
  return target.toString();
}

function getDefaultConfig() {
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    Model: 'qwen3.5-9b-instruct-q4_k_m',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    LlamaCpp: {
      BaseUrl: 'http://127.0.0.1:8080',
      NumCtx: 128000,
      ModelPath: null,
      Temperature: 0.2,
      TopP: 0.95,
      TopK: 20,
      MinP: 0.0,
      PresencePenalty: 0.0,
      RepetitionPenalty: 1.0,
      MaxTokens: 4096,
      GpuLayers: 999,
      Threads: -1,
      FlashAttention: true,
      ParallelSlots: 1,
      Reasoning: 'off',
    },
    Thresholds: {
      MinCharactersForSummary: 500,
      MinLinesForSummary: 16,
    },
    Interactive: {
      Enabled: true,
      WrappedCommands: ['git', 'less', 'vim', 'sqlite3'],
      IdleTimeoutMs: 900000,
      MaxTranscriptCharacters: 60000,
      TranscriptRetention: true,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getChatRequestText(request) {
  if (!request || !Array.isArray(request.messages)) {
    return '';
  }

  return request.messages.map((message) => {
    const parts = [];
    if (typeof message.content === 'string' && message.content) {
      parts.push(message.content);
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => (part && typeof part === 'object' && typeof part.text === 'string') ? part.text : '')
        .join('');
      if (text) {
        parts.push(text);
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.function?.name) {
          parts.push(String(toolCall.function.name));
        }
        if (toolCall?.function?.arguments) {
          parts.push(String(toolCall.function.arguments));
        }
      }
    }
    if (message.function_call?.name) {
      parts.push(String(message.function_call.name));
    }
    if (message.function_call?.arguments) {
      parts.push(String(message.function_call.arguments));
    }
    if (typeof message.tool_call_id === 'string' && message.tool_call_id) {
      parts.push(message.tool_call_id);
    }
    return parts.join('\n');
  }).join('\n');
}

function setManagedLlamaBaseUrl(config, baseUrl) {
  config.LlamaCpp.BaseUrl = baseUrl;
  config.Runtime ??= {};
  config.Runtime.Model ??= config.Model;
  config.Runtime.LlamaCpp = {
    ...(config.Runtime.LlamaCpp || {}),
    BaseUrl: baseUrl,
  };
}

function mergeConfig(baseValue, patchValue) {
  if (Array.isArray(baseValue) && Array.isArray(patchValue)) {
    return patchValue.slice();
  }

  if (
    baseValue
    && patchValue
    && typeof baseValue === 'object'
    && typeof patchValue === 'object'
    && !Array.isArray(baseValue)
    && !Array.isArray(patchValue)
  ) {
    const merged = { ...baseValue };
    for (const [key, value] of Object.entries(patchValue)) {
      merged[key] = key in merged ? mergeConfig(merged[key], value) : value;
    }
    delete merged.Paths;
    delete merged.Effective;
    if (merged.Thresholds && typeof merged.Thresholds === 'object') {
      delete merged.Thresholds.MaxInputCharacters;
    }
    return merged;
  }

  return patchValue;
}

function extractPromptSection(promptText, header) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escaped}\\n([\\s\\S]*?)(?:\\n[A-Z][^\\n]*:\\n|$)`, 'u').exec(promptText);
  return match ? match[1].trim() : '';
}

function buildOversizedTransitionsInput(targetCharacters) {
  const transitions = [
    {
      id: 9001,
      label: 'Lumbridge Castle Staircase',
      type: 'stairs',
      from: { worldX: 3205, worldY: 3214, plane: 0 },
      to: { worldX: 3205, worldY: 3214, plane: 1 },
      bidirectional: true,
      note: 'exact castle match',
    },
    {
      id: 9002,
      label: 'Lumbridge Castle Courtyard Gate',
      type: 'gate',
      from: { worldX: 3212, worldY: 3221, plane: 0 },
      to: { worldX: 3213, worldY: 3221, plane: 0 },
      bidirectional: false,
      note: 'exact castle match',
    },
  ];

  let index = 0;
  while (JSON.stringify(transitions).length < targetCharacters) {
    transitions.push({
      id: 10000 + index,
      label: `Padding Transition ${index}`,
      type: 'padding',
      from: { worldX: 3300 + (index % 50), worldY: 3300 + (index % 50), plane: 0 },
      to: { worldX: 3400 + (index % 50), worldY: 3400 + (index % 50), plane: 0 },
      bidirectional: Boolean(index % 2),
      note: 'P'.repeat(1800),
    });
    index += 1;
  }

  return JSON.stringify(transitions);
}

function buildOversizedRunnerStateHistoryInput(targetCharacters) {
  const states = [
    {
      timestamp: '2026-03-30T18:39:59Z',
      lifecycle_state: 'idle',
      bridge_state: 'connected',
      scenario_id: null,
      step_id: null,
      state_json: JSON.stringify({
        navigation: { status: 'idle' },
        blocker: null,
      }),
    },
    {
      timestamp: '2026-03-30T18:42:57Z',
      lifecycle_state: 'running',
      bridge_state: 'connected',
      scenario_id: 'poi_verification',
      step_id: 'walk_to_door',
      state_json: JSON.stringify({
        navigation: { status: 'navigating' },
        blocker: { type: 'door', action: 'open' },
      }),
    },
    {
      timestamp: '2026-03-30T18:45:22Z',
      lifecycle_state: 'paused',
      bridge_state: 'connected',
      scenario_id: 'poi_verification',
      step_id: 'walk_to_door',
      state_json: JSON.stringify({
        navigation: { status: 'blocked' },
        blocker: { type: 'door', action: 'open', failureReason: 'Hover confirmation failed for Open on Door.' },
      }),
    },
    {
      timestamp: '2026-03-30T18:50:01Z',
      lifecycle_state: 'idle',
      bridge_state: 'connected',
      scenario_id: null,
      step_id: null,
      state_json: JSON.stringify({
        navigation: { status: 'failed' },
        blocker: null,
      }),
    },
  ];

  let index = 0;
  while (JSON.stringify({ count: states.length, states }).length < targetCharacters) {
    states.push({
      timestamp: `2026-03-30T19:${String(index % 60).padStart(2, '0')}:00Z`,
      lifecycle_state: 'idle',
      bridge_state: 'connected',
      scenario_id: `padding_${index}`,
      step_id: `padding_step_${index}`,
      state_json: JSON.stringify({
        navigation: { status: 'idle' },
        note: 'P'.repeat(1800),
      }),
    });
    index += 1;
  }

  return JSON.stringify({
    count: states.length,
    states,
  });
}

function getRuntimeRootFromStatusPath(statusPath) {
  const absoluteStatusPath = path.resolve(statusPath);
  const statusDirectory = path.dirname(absoluteStatusPath);
  if (path.basename(statusDirectory).toLowerCase() === 'status') {
    return path.dirname(statusDirectory);
  }

  return statusDirectory;
}

function getPlannerLogsPath() {
  const statusPath = process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH;
  return statusPath && statusPath.trim()
    ? path.join(getRuntimeRootFromStatusPath(statusPath), 'logs')
    : path.join(process.cwd(), '.siftkit', 'logs');
}

function getFailedLogsPath() {
  return path.join(getPlannerLogsPath(), 'failed');
}

function getRequestLogsPath() {
  return path.join(getPlannerLogsPath(), 'requests');
}

function buildStructuredStubDecision(promptText) {
  const inputText = extractPromptSection(promptText, 'Input:');

  if (!inputText.trim() || /unsupported fixture marker/u.test(inputText)) {
    return {
      classification: 'unsupported_input',
      raw_review_required: false,
      output: UNSUPPORTED_INPUT_MESSAGE,
    };
  }

  if (/Unable to resolve external command/u.test(inputText)) {
    return {
      classification: 'command_failure',
      raw_review_required: true,
      output: 'The command failed before producing a usable result. The executable could not be resolved in the current environment.\nRaw review required.',
    };
  }

  return {
    classification: 'summary',
    raw_review_required: false,
    output: `summary:${String(promptText).slice(0, 24)}`,
  };
}

function resolveAssistantContent(option, promptText, parsed, requestIndex) {
  if (typeof option === 'function') {
    return option(promptText, parsed, requestIndex);
  }

  if (Array.isArray(option)) {
    const item = option[Math.min(requestIndex - 1, option.length - 1)];
    return typeof item === 'function' ? item(promptText, parsed, requestIndex) : item;
  }

  return option;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function resolveArtifactLogPathFromStatusPost(parsedBody) {
  if (!parsedBody || typeof parsedBody !== 'object') {
    return null;
  }

  const artifactType = typeof parsedBody.artifactType === 'string'
    ? parsedBody.artifactType.trim()
    : '';
  const artifactRequestId = typeof parsedBody.artifactRequestId === 'string'
    ? parsedBody.artifactRequestId.trim()
    : '';
  if (!artifactType || !artifactRequestId) {
    return null;
  }

  const statusPath = typeof parsedBody.statusPath === 'string' && parsedBody.statusPath.trim()
    ? parsedBody.statusPath
    : (process.env.sift_kit_status || process.env.SIFTKIT_STATUS_PATH || '');
  if (!statusPath) {
    return null;
  }

  const logsPath = path.join(getRuntimeRootFromStatusPath(statusPath), 'logs');
  if (artifactType === 'summary_request') {
    return path.join(logsPath, 'requests', `request_${artifactRequestId}.json`);
  }
  if (artifactType === 'planner_failed') {
    return path.join(logsPath, 'failed', `request_failed_${artifactRequestId}.json`);
  }
  if (artifactType === 'planner_debug') {
    return path.join(logsPath, `planner_debug_${artifactRequestId}.json`);
  }

  return null;
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseText += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${response.statusCode}: ${responseText}`));
            return;
          }

          resolve(responseText ? JSON.parse(responseText) : {});
        });
      }
    );

    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeDirectoryWithRetries(targetPath, attempts = 40, delayMs = 100) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
      if (code !== 'EPERM' && code !== 'EBUSY') {
        throw error;
      }
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function spawnProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
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

async function waitForTextMatch(getText, pattern, timeoutMs = 2000) {
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

async function startStubStatusServer(options = {}) {
  const state = {
    config: mergeConfig(getDefaultConfig(), options.config || {}),
    statusPosts: [],
    artifactPosts: [],
    chatRequests: [],
    tokenizeRequests: [],
    running: Boolean(options.running),
    executionLeaseToken: null,
    metrics: {
      inputCharactersTotal: 3461904,
      outputCharactersTotal: 0,
      inputTokensTotal: 1865267,
      outputTokensTotal: 0,
      thinkingTokensTotal: 0,
      requestDurationMsTotal: 0,
      completedRequestCount: 0,
      updatedAtUtc: null,
      ...(options.metrics || {}),
    },
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: state.running, status: state.running ? 'true' : 'false', metrics: state.metrics }));
      return;
    }

    if (req.method === 'GET' && req.url === '/execution') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ busy: Boolean(state.executionLeaseToken) }));
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ id: state.config.Model }],
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
      state.config = mergeConfig(getDefaultConfig(), parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.config));
      return;
    }

    if (req.method === 'POST' && req.url === '/status') {
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
      state.running = Boolean(parsed.running);
      if (!parsed.running && !hasArtifactPayload) {
        state.metrics.inputCharactersTotal += Number.isFinite(parsed.promptCharacterCount) ? Number(parsed.promptCharacterCount) : 0;
        state.metrics.outputCharactersTotal += Number.isFinite(parsed.outputCharacterCount) ? Number(parsed.outputCharacterCount) : 0;
        state.metrics.inputTokensTotal += Number.isFinite(parsed.inputTokens) ? Number(parsed.inputTokens) : 0;
        state.metrics.outputTokensTotal += Number.isFinite(parsed.outputTokens) ? Number(parsed.outputTokens) : 0;
        state.metrics.thinkingTokensTotal += Number.isFinite(parsed.thinkingTokens) ? Number(parsed.thinkingTokens) : 0;
        state.metrics.requestDurationMsTotal += Number.isFinite(parsed.requestDurationMs) ? Number(parsed.requestDurationMs) : 0;
        state.metrics.completedRequestCount += 1;
        state.metrics.updatedAtUtc = new Date().toISOString();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running: Boolean(parsed.running) }));
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/acquire') {
      if (state.executionLeaseToken) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, acquired: false, busy: true }));
        return;
      }

      state.executionLeaseToken = `lease-${Date.now()}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, acquired: true, busy: true, token: state.executionLeaseToken }));
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/heartbeat') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const ok = typeof parsed.token === 'string' && parsed.token === state.executionLeaseToken;
      res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, busy: ok }));
      return;
    }

    if (req.method === 'POST' && req.url === '/execution/release') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const released = typeof parsed.token === 'string' && parsed.token === state.executionLeaseToken;
      if (released) {
        state.executionLeaseToken = null;
      }
      res.writeHead(released ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: released, released, busy: Boolean(state.executionLeaseToken) }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (state.config.LlamaCpp && typeof state.config.LlamaCpp === 'object') {
    state.config.LlamaCpp.BaseUrl = `http://127.0.0.1:${port}`;
  }

  return {
    port,
    healthUrl: `http://127.0.0.1:${port}/health`,
    statusUrl: `http://127.0.0.1:${port}/status`,
    configUrl: `http://127.0.0.1:${port}/config`,
    state,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function withTempEnv(fn) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-node-test-'));
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
  };

  process.env.USERPROFILE = tempRoot;
  process.env.sift_kit_status = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  process.env.SIFTKIT_STATUS_PATH = process.env.sift_kit_status;
  process.env.SIFTKIT_CONFIG_PATH = path.join(tempRoot, '.siftkit', 'config.json');
  delete process.env.SIFTKIT_TEST_PROVIDER_BEHAVIOR;
  delete process.env.SIFTKIT_TEST_PROVIDER_LOG_PATH;
  delete process.env.SIFTKIT_TEST_PROVIDER_SLEEP_MS;
  delete process.env.SIFTKIT_CONFIG_SERVICE_URL;
  delete process.env.SIFTKIT_STATUS_BACKEND_URL;
  delete process.env.SIFTKIT_STATUS_PORT;
  delete process.env.SIFTKIT_STATUS_HOST;
  process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = path.join(tempRoot, '.siftkit', 'status', 'idle-summary.sqlite');
  process.env.SIFTKIT_TEST_PROVIDER = 'mock';

  const cleanup = async () => {
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

async function withStubServer(fn, options = {}) {
  const server = await startStubStatusServer(options);
  process.env.SIFTKIT_STATUS_BACKEND_URL = server.statusUrl;
  process.env.SIFTKIT_CONFIG_SERVICE_URL = server.configUrl;
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

async function withSummaryTestServer(fn, options = {}) {
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
    usingExistingServer: true,
  });
}

async function withRealStatusServer(fn, options = {}) {
  const previous = {
    SIFTKIT_STATUS_HOST: process.env.SIFTKIT_STATUS_HOST,
    SIFTKIT_STATUS_PORT: process.env.SIFTKIT_STATUS_PORT,
    sift_kit_status: process.env.sift_kit_status,
    SIFTKIT_STATUS_PATH: process.env.SIFTKIT_STATUS_PATH,
    SIFTKIT_CONFIG_PATH: process.env.SIFTKIT_CONFIG_PATH,
    SIFTKIT_IDLE_SUMMARY_DB_PATH: process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH,
    SIFTKIT_EXECUTION_LEASE_STALE_MS: process.env.SIFTKIT_EXECUTION_LEASE_STALE_MS,
  };

  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.sift_kit_status = options.statusPath;
  process.env.SIFTKIT_STATUS_PATH = options.statusPath;
  process.env.SIFTKIT_CONFIG_PATH = options.configPath;
  if (options.idleSummaryDbPath) {
    process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH = options.idleSummaryDbPath;
  } else {
    delete process.env.SIFTKIT_IDLE_SUMMARY_DB_PATH;
  }
  if (options.executionLeaseStaleMs) {
    process.env.SIFTKIT_EXECUTION_LEASE_STALE_MS = String(options.executionLeaseStaleMs);
  } else {
    delete process.env.SIFTKIT_EXECUTION_LEASE_STALE_MS;
  }

  const server = startStatusServer({
    disableManagedLlamaStartup: Boolean(options.disableManagedLlamaStartup),
  });
  try {
    const address = await new Promise((resolve) => {
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
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startStatusServerProcess(options) {
  const childEnv = {
    ...process.env,
    SIFTKIT_STATUS_HOST: '127.0.0.1',
    SIFTKIT_STATUS_PORT: '0',
    sift_kit_status: options.statusPath,
    SIFTKIT_STATUS_PATH: options.statusPath,
    SIFTKIT_CONFIG_PATH: options.configPath,
    ...(options.idleSummaryDbPath ? { SIFTKIT_IDLE_SUMMARY_DB_PATH: options.idleSummaryDbPath } : {}),
    ...(options.idleSummaryDelayMs ? { SIFTKIT_IDLE_SUMMARY_DELAY_MS: String(options.idleSummaryDelayMs) } : {}),
    ...(options.executionLeaseStaleMs ? { SIFTKIT_EXECUTION_LEASE_STALE_MS: String(options.executionLeaseStaleMs) } : {}),
  };
  const args = [path.join(process.cwd(), 'dist', 'status-server', 'index.js')];
  if (options.disableManagedLlamaStartup) {
    args.push('--disable-managed-llama-startup');
  }
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  const stderrLines = [];
  let stdoutBuffer = '';
  let startupResolved = false;
  let closeResolved = false;
  let resolveStartup;
  let rejectStartup;
  let resolveClose;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });

  function handleStdoutChunk(chunk) {
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

  child.stdout.on('data', handleStdoutChunk);
  child.stderr.on('data', (chunk) => {
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

  const startupInfo = await startup;

  return {
    port: startupInfo.port,
    statusUrl: `http://127.0.0.1:${startupInfo.port}/status`,
    configUrl: `http://127.0.0.1:${startupInfo.port}/config`,
    executionUrl: `http://127.0.0.1:${startupInfo.port}/execution`,
    stdoutLines,
    stderrLines,
    idleSummaryDbPath: options.idleSummaryDbPath || path.join(path.dirname(options.statusPath), 'idle-summary.sqlite'),
    async waitForStdoutMatch(pattern, timeoutMs = 2000) {
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
    async waitForExit(timeoutMs = 5000) {
      return await Promise.race([
        closePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for status server exit after ${timeoutMs} ms.`)), timeoutMs)),
      ]);
    },
    async close() {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      child.kill('SIGINT');
      await new Promise((resolve) => child.once('close', resolve));
    },
  };
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/gu, '');
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines = [];
  let buffer = '';
  process.stdout.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += text;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (line.trim()) {
        lines.push(line);
      }
    }
    return originalWrite(chunk, encoding, callback);
  };

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

function readIdleSummarySnapshots(dbPath) {
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.prepare(`
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
  } finally {
    database.close();
  }
}

function getIdleSummaryBlock(stdoutLines, requestsPattern) {
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function toSingleQuotedPowerShellLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function writeManagedLlamaScripts(tempRoot, port, modelId = 'managed-test-model', options = {}) {
  const fakeServerPath = path.join(tempRoot, 'fake-llama-server.js');
  const startupScriptPath = path.join(tempRoot, 'start-llama.ps1');
  const shutdownScriptPath = path.join(tempRoot, 'stop-llama.ps1');
  const pidFilePath = path.join(tempRoot, 'fake-llama.pid');
  const readyFilePath = path.join(tempRoot, 'fake-llama.ready');
  const syncOnlyMarkerPath = path.join(tempRoot, 'fake-llama.sync-only');
  const launchMarkerPath = path.join(tempRoot, 'fake-llama.launch');

  fs.writeFileSync(fakeServerPath, `
const http = require('node:http');
const fs = require('node:fs');
const port = ${JSON.stringify(port)};
const modelId = ${JSON.stringify(modelId)};
const readyFilePath = ${JSON.stringify(readyFilePath)};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: modelId }] }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(readyFilePath, String(process.pid), 'utf8');
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`, 'utf8');

  fs.writeFileSync(startupScriptPath, `
param(
  [string]$ConfigPath,
  [string]$ConfigUrl,
  [string]$StatusPath,
  [string]$StatusUrl,
  [string]$HealthUrl,
  [string]$RuntimeRoot,
  [string]$ScriptPath
)

$pidFile = ${toSingleQuotedPowerShellLiteral(pidFilePath)}
$nodePath = ${toSingleQuotedPowerShellLiteral(process.execPath)}
$serverScript = ${toSingleQuotedPowerShellLiteral(fakeServerPath)}
$startupLogLine = ${toSingleQuotedPowerShellLiteral(options.startupLogLine || '')}
$llamaLogLine = ${toSingleQuotedPowerShellLiteral(options.llamaLogLine || '')}
$launchHangingProcess = ${options.launchHangingProcess ? '$true' : '$false'}
$preflightConfigGet = ${options.preflightConfigGet ? '$true' : '$false'}
$emitManagedStartupFlag = ${options.emitManagedStartupFlag ? '$true' : '$false'}
$emitVerboseEnvFlags = ${options.emitVerboseEnvFlags ? '$true' : '$false'}
$supportsSyncOnly = ${options.supportsSyncOnly === false ? '$false' : '$true'}
$syncOnlyModel = ${toSingleQuotedPowerShellLiteral(options.syncOnlyModel || '')}
$syncOnlyMarkerPath = ${toSingleQuotedPowerShellLiteral(syncOnlyMarkerPath)}
$launchMarkerPath = ${toSingleQuotedPowerShellLiteral(launchMarkerPath)}
$writeLaunchMarker = ${options.writeLaunchMarker ? '$true' : '$false'}

function Set-Json {
  param(
    [string]$Url,
    [object]$Body
  )

  $json = $Body | ConvertTo-Json -Depth 20
  Invoke-RestMethod -Uri $Url -Method Put -ContentType 'application/json' -Body $json -TimeoutSec 10 | Out-Null
}

$syncOnly = $supportsSyncOnly -and ($env:SIFTKIT_MANAGED_LLAMA_SYNC_ONLY -eq '1')
if ($syncOnly) {
  Set-Content -LiteralPath $syncOnlyMarkerPath -Value '1' -Encoding utf8 -NoNewline
  if ($ConfigUrl -and $syncOnlyModel) {
    $config = Invoke-RestMethod -Uri $ConfigUrl -Method Get -TimeoutSec 10
    if (-not $config.Runtime) {
      $config | Add-Member -MemberType NoteProperty -Name Runtime -Value @{} -Force
    }
    $config.Model = $syncOnlyModel
    $config.Runtime.Model = $syncOnlyModel
    Set-Json -Url $ConfigUrl -Body $config
  }
  exit 0
}

if (Test-Path -LiteralPath $pidFile) {
  try {
    $existingPid = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
    $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    if ($existing) {
      exit 0
    }
  }
  catch {
  }
}

if ($startupLogLine) {
  Write-Output $startupLogLine
}
if ($emitManagedStartupFlag) {
  Write-Output \"managed_startup=$($env:SIFTKIT_MANAGED_LLAMA_STARTUP)\"
}
if ($emitVerboseEnvFlags) {
  Write-Output \"verbose_logging_env=$($env:SIFTKIT_LLAMA_VERBOSE_LOGGING)\"
  Write-Output \"verbose_args_env=$($env:SIFTKIT_LLAMA_VERBOSE_ARGS_JSON)\"
}
if ($llamaLogLine -and $env:SIFTKIT_LLAMA_STDOUT_PATH) {
  Set-Content -LiteralPath $env:SIFTKIT_LLAMA_STDOUT_PATH -Value $llamaLogLine -Encoding utf8 -NoNewline
}
if ($preflightConfigGet -and $ConfigUrl) {
  try {
    Invoke-RestMethod -Uri $ConfigUrl -Method Get -TimeoutSec 10 | Out-Null
  }
  catch {
  }
}

if ($writeLaunchMarker) {
  Set-Content -LiteralPath $launchMarkerPath -Value '1' -Encoding utf8 -NoNewline
}

$child = if ($launchHangingProcess) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
} else {
  Start-Process -FilePath $nodePath -ArgumentList @($serverScript) -PassThru -WindowStyle Hidden
}
Set-Content -LiteralPath $pidFile -Value ([string]$child.Id) -Encoding utf8 -NoNewline
exit 0
`, 'utf8');

  fs.writeFileSync(shutdownScriptPath, `
param(
  [string]$ConfigPath,
  [string]$ConfigUrl,
  [string]$StatusPath,
  [string]$StatusUrl,
  [string]$HealthUrl,
  [string]$RuntimeRoot,
  [string]$ScriptPath
)

$pidFile = ${toSingleQuotedPowerShellLiteral(pidFilePath)}
if (Test-Path -LiteralPath $pidFile) {
  try {
    $pidValue = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  catch {
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
exit 0
`, 'utf8');

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    fakeServerPath,
    startupScriptPath,
    shutdownScriptPath,
    pidFilePath,
    readyFilePath,
    syncOnlyMarkerPath,
    launchMarkerPath,
  };
}

async function waitForAsyncExpectation(expectation, timeoutMs = 2000) {
  const startedAt = Date.now();
  let lastError = null;
  for (;;) {
    try {
      await expectation();
      return;
    } catch (error) {
      lastError = error;
    }

    if ((Date.now() - startedAt) >= timeoutMs) {
      throw lastError;
    }

    await sleep(25);
  }
}

function runPowerShellScript(scriptPath) {
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
  loadConfig, saveConfig, getConfigPath, getExecutionServerState,
  getChunkThresholdCharacters, getConfiguredLlamaNumCtx,
  getEffectiveInputCharactersPerContextToken, initializeRuntime,
  getStatusServerUnavailableMessage,
  SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT,
  SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT,
  summarizeRequest, buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks,
  getPlannerPromptBudget, buildPlannerToolDefinitions, UNSUPPORTED_INPUT_MESSAGE,
  runCommand, runBenchmarkSuite,
  readMatrixManifest, buildLaunchSignature, buildLauncherArgs, buildBenchmarkArgs,
  pruneOldLauncherLogs, runMatrix, runMatrixWithInterrupt,
  countLlamaCppTokens, listLlamaCppModels, generateLlamaCppResponse,
  withExecutionLock,
  buildIdleMetricsLogMessage, buildStatusRequestLogMessage, formatElapsed,
  getIdleSummarySnapshotsPath, startStatusServer,
  runDebugRequest, runFixture60MalformedJsonRepro,
  // Local helpers
  TEST_USE_EXISTING_SERVER, EXISTING_SERVER_STATUS_URL, EXISTING_SERVER_CONFIG_URL,
  RUN_LIVE_LLAMA_TOKENIZE_TESTS, LIVE_LLAMA_BASE_URL, LIVE_CONFIG_SERVICE_URL,
  FAST_LEASE_STALE_MS, FAST_LEASE_WAIT_MS,
  deriveServiceUrl, getDefaultConfig, clone, getChatRequestText, setManagedLlamaBaseUrl,
  mergeConfig, extractPromptSection, buildOversizedTransitionsInput,
  buildOversizedRunnerStateHistoryInput, getRuntimeRootFromStatusPath,
  getPlannerLogsPath, getFailedLogsPath, getRequestLogsPath,
  buildStructuredStubDecision, resolveAssistantContent, readBody,
  resolveArtifactLogPathFromStatusPost, requestJson, sleep,
  removeDirectoryWithRetries, spawnProcess, waitForTextMatch,
  startStubStatusServer, withTempEnv, withStubServer, withSummaryTestServer,
  withRealStatusServer, startStatusServerProcess, stripAnsi, captureStdout,
  readIdleSummarySnapshots, getIdleSummaryBlock, getFreePort,
  toSingleQuotedPowerShellLiteral, writeManagedLlamaScripts,
  waitForAsyncExpectation, runPowerShellScript,
};
