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
  deriveServiceUrl,
  getDefaultConfig,
  clone,
  getChatRequestText,
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
} from './helpers/runtime-config.ts';
import {
  readBody,
  resolveArtifactLogPathFromStatusPost,
  requestJson,
} from './helpers/runtime-http.ts';

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
import { summarizeRequest, readSummaryInput } from '../dist/summary/core.js';
import { buildPrompt } from '../dist/summary/prompt.js';
import { getSummaryDecision } from '../dist/summary/decision.js';
import { planTokenAwareLlamaCppChunks, getPlannerPromptBudget } from '../dist/summary/chunking.js';
import { buildPlannerToolDefinitions } from '../dist/summary/planner/tools.js';
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
import { writeConfig } from '../dist/status-server/config-store.js';
import { closeRuntimeDatabase } from '../dist/state/runtime-db.js';
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

function scheduleDeferredArtifactWrite(state, parsed, options) {
  if (!Array.isArray(parsed?.deferredArtifacts) || parsed.deferredArtifacts.length === 0) {
    return;
  }
  const deferredArtifacts = parsed.deferredArtifacts
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
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
  const writeArtifacts = (artifacts) => {
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

function applyDeferredStatusMetrics(state, parsed) {
  if (!parsed?.deferredMetadata || typeof parsed.deferredMetadata !== 'object' || Array.isArray(parsed.deferredMetadata)) {
    return;
  }
  const metadata = parsed.deferredMetadata;
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
    if (metadata.toolStats && typeof metadata.toolStats === 'object' && !Array.isArray(metadata.toolStats)) {
      const existing = state.metrics.toolStats[taskKind];
      for (const [toolType, rawStats] of Object.entries(metadata.toolStats)) {
        if (!rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) {
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
          noNewEvidenceCalls: current.noNewEvidenceCalls + (Number.isFinite(stats.noNewEvidenceCalls) ? Number(stats.noNewEvidenceCalls) : 0),
        };
      }
    }
  }
}

function scheduleDeferredStatusMetrics(state, parsed) {
  if (!parsed?.deferredMetadata || typeof parsed.deferredMetadata !== 'object' || Array.isArray(parsed.deferredMetadata)) {
    return;
  }
  setTimeout(() => {
    applyDeferredStatusMetrics(state, parsed);
  }, 25);
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
    healthChecks: 0,
    running: Boolean(options.running),
    executionLeaseToken: null,
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

    if (req.method === 'POST' && req.url === '/summary') {
      const bodyText = await readBody(req);
      const parsed = bodyText ? JSON.parse(bodyText) : {};
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
        const taskKind = parsed.taskKind;
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
          if (parsed.toolStats && typeof parsed.toolStats === 'object' && !Array.isArray(parsed.toolStats)) {
            const existing = state.metrics.toolStats[taskKind];
            for (const [toolType, rawStats] of Object.entries(parsed.toolStats)) {
              if (!rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) {
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
              const stats = rawStats as Record<string, unknown>;
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
  if (!state.config.Runtime || typeof state.config.Runtime !== 'object') {
    state.config.Runtime = {};
  }
  if (!state.config.Runtime.LlamaCpp || typeof state.config.Runtime.LlamaCpp !== 'object') {
    state.config.Runtime.LlamaCpp = {};
  }
  state.config.Runtime.LlamaCpp.BaseUrl = `http://127.0.0.1:${port}`;
  if (!state.config.Server || typeof state.config.Server !== 'object') {
    state.config.Server = {};
  }
  if (!state.config.Server.LlamaCpp || typeof state.config.Server.LlamaCpp !== 'object') {
    state.config.Server.LlamaCpp = {};
  }
  state.config.Server.LlamaCpp.BaseUrl = `http://127.0.0.1:${port}`;

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

let tempEnvQueue = Promise.resolve();

function runWithTempEnv(fn) {
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

function withTempEnv(fn) {
  const queued = tempEnvQueue.then(() => runWithTempEnv(fn), () => runWithTempEnv(fn));
  tempEnvQueue = queued.catch(() => undefined);
  return queued;
}

function seedRuntimeConfigFromJson(configPath) {
  if (!configPath || !fs.existsSync(configPath) || path.extname(configPath).toLowerCase() !== '.json') {
    return;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const serverLlama = config?.Server?.LlamaCpp;
  if (serverLlama && typeof serverLlama === 'object') {
    if (!serverLlama.BaseUrl && config?.Runtime?.LlamaCpp?.BaseUrl) {
      serverLlama.BaseUrl = config.Runtime.LlamaCpp.BaseUrl;
    }
    if (!serverLlama.ExecutablePath && serverLlama.StartupScript) {
      serverLlama.ExecutablePath = serverLlama.StartupScript;
    }
    if (!serverLlama.ModelPath && serverLlama.ExecutablePath) {
      const modelPath = path.join(path.dirname(serverLlama.ExecutablePath), 'managed-test-model.gguf');
      if (!fs.existsSync(modelPath)) {
        fs.writeFileSync(modelPath, 'fake model', 'utf8');
      }
      serverLlama.ModelPath = modelPath;
    }
  }
  writeConfig(getConfigPath(), config);
}

async function withStubServer(fn, options = {}) {
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
    SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS: process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS,
  };

  process.env.SIFTKIT_STATUS_HOST = '127.0.0.1';
  process.env.SIFTKIT_STATUS_PORT = '0';
  process.env.SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS = '0';
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

  seedRuntimeConfigFromJson(options.configPath);
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

async function startStatusServerProcess(options) {
  seedRuntimeConfigFromJson(options.configPath);
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
    SIFTKIT_LLAMA_STARTUP_GRACE_DELAY_MS: '0',
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

  const startupTimeoutMs = options.startupTimeoutMs || 10_000;
  const startupInfo = await Promise.race([
    startup,
    new Promise((_, reject) => setTimeout(() => reject(new Error([
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

      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGINT');
      }
      await Promise.race([closePromise, sleep(2000)]);
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
  const modelPath = path.join(tempRoot, `${modelId}.gguf`);
  const startupScriptPath = path.join(tempRoot, 'start-llama.ps1');
  const shutdownScriptPath = path.join(tempRoot, 'stop-llama.ps1');
  const pidFilePath = path.join(tempRoot, 'fake-llama.pid');
  const readyFilePath = path.join(tempRoot, 'fake-llama.ready');
  const syncOnlyMarkerPath = path.join(tempRoot, 'fake-llama.sync-only');
  const launchMarkerPath = path.join(tempRoot, 'fake-llama.launch');
  const invocationLogPath = path.join(tempRoot, 'fake-llama.invocation.json');

  fs.writeFileSync(modelPath, 'fake model', 'utf8');
  fs.writeFileSync(fakeServerPath, `
const http = require('node:http');
const fs = require('node:fs');
const port = ${JSON.stringify(port)};
const modelId = ${JSON.stringify(modelId)};
const readyFilePath = ${JSON.stringify(readyFilePath)};
const pidFilePath = ${JSON.stringify(pidFilePath)};

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
[string]$ConfigPath = ''
[string]$ConfigUrl = $env:SIFTKIT_CONFIG_SERVICE_URL
[string]$StatusPath = ''
[string]$StatusUrl = ''
[string]$HealthUrl = $env:SIFTKIT_HEALTH_URL
[string]$RuntimeRoot = ''
[string]$ScriptPath = ''
$RemainingArgs = $args

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
$captureInvocation = ${options.captureInvocation ? '$true' : '$false'}
$invocationLogPath = ${toSingleQuotedPowerShellLiteral(invocationLogPath)}

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
if ($llamaLogLine) {
  Write-Output $llamaLogLine
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

if ($captureInvocation) {
  @{
    ConfigPath = $ConfigPath
    ConfigUrl = $ConfigUrl
    StatusPath = $StatusPath
    StatusUrl = $StatusUrl
    HealthUrl = $HealthUrl
    RuntimeRoot = $RuntimeRoot
    ScriptPath = $ScriptPath
    ServerConfigPathEnv = $env:SIFTKIT_SERVER_CONFIG_PATH
    ServerConfigUrlEnv = $env:SIFTKIT_SERVER_CONFIG_URL
    ServerStatusPathEnv = $env:SIFTKIT_SERVER_STATUS_PATH
    ServerStatusUrlEnv = $env:SIFTKIT_SERVER_STATUS_URL
    ServerHealthUrlEnv = $env:SIFTKIT_SERVER_HEALTH_URL
    ServerRuntimeRootEnv = $env:SIFTKIT_SERVER_RUNTIME_ROOT
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $invocationLogPath -Encoding utf8
}

$child = if ($launchHangingProcess) {
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
} else {
  Start-Process -FilePath $nodePath -ArgumentList @($serverScript) -PassThru -WindowStyle Hidden
}
Set-Content -LiteralPath $pidFile -Value ([string]$child.Id) -Encoding utf8 -NoNewline
Wait-Process -Id $child.Id
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
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
    modelPath,
    startupScriptPath,
    shutdownScriptPath,
    pidFilePath,
    readyFilePath,
    syncOnlyMarkerPath,
    launchMarkerPath,
    invocationLogPath,
  };
}

function writeManagedLlamaLauncher(tempRoot, port, modelId = 'managed-test-model', options = {}) {
  const fakeServerPath = path.join(tempRoot, 'fake-llama-server-cli.js');
  const executablePath = path.join(tempRoot, 'fake-llama-launcher.cmd');
  const modelPath = path.join(tempRoot, `${modelId}.gguf`);
  const readyFilePath = path.join(tempRoot, 'fake-llama-cli.ready');
  const launchMarkerPath = path.join(tempRoot, 'fake-llama-cli.launch');
  const invocationLogPath = path.join(tempRoot, 'fake-llama-cli.invocation.json');

  fs.writeFileSync(modelPath, 'fake model', 'utf8');
  fs.writeFileSync(fakeServerPath, `
const http = require('node:http');
const fs = require('node:fs');

const argv = process.argv.slice(2);
const getArg = (flag, fallback = '') => {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? String(argv[index + 1] || '') : fallback;
};

const port = Number.parseInt(getArg('--port', ${JSON.stringify(String(port))}), 10);
const host = getArg('--host', '127.0.0.1') || '127.0.0.1';
const readyFilePath = process.env.SIFTKIT_FAKE_READY_FILE || '';
const modelId = process.env.SIFTKIT_FAKE_MODEL_ID || 'managed-test-model';
const llamaLogLine = process.env.SIFTKIT_FAKE_LLAMA_LOG_LINE || '';
const invocationLogPath = process.env.SIFTKIT_FAKE_INVOCATION_LOG || '';
const startupLogLine = process.env.SIFTKIT_FAKE_STARTUP_LOG_LINE || '';
const emitVerboseEnvFlags = process.env.SIFTKIT_FAKE_EMIT_VERBOSE_ENV_FLAGS === '1';
const writeLaunchMarker = process.env.SIFTKIT_FAKE_WRITE_LAUNCH_MARKER === '1';
const launchMarkerPath = process.env.SIFTKIT_FAKE_LAUNCH_MARKER || '';
const launchHangingProcess = process.env.SIFTKIT_FAKE_LAUNCH_HANGING_PROCESS === '1';
const exitAfterLog = process.env.SIFTKIT_FAKE_EXIT_AFTER_LOG === '1';
const exitCode = Number.parseInt(process.env.SIFTKIT_FAKE_EXIT_CODE || '0', 10) || 0;

if (startupLogLine) {
  process.stdout.write(startupLogLine + '\\n');
}
if (emitVerboseEnvFlags) {
  process.stdout.write('verbose_logging_env=' + String(process.env.SIFTKIT_LLAMA_VERBOSE_LOGGING || '') + '\\n');
}
if (writeLaunchMarker && launchMarkerPath) {
  fs.writeFileSync(launchMarkerPath, '1', 'utf8');
}
if (invocationLogPath) {
  fs.writeFileSync(invocationLogPath, JSON.stringify({
    argv,
    host,
    port,
    verboseLoggingEnv: process.env.SIFTKIT_LLAMA_VERBOSE_LOGGING || '',
  }, null, 2), 'utf8');
}
if (exitAfterLog) {
  if (llamaLogLine) {
    process.stdout.write(String(llamaLogLine) + '\\n');
  }
  process.exit(exitCode);
}
if (launchHangingProcess) {
  setInterval(() => {}, 1000);
  return;
}

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

server.listen(port, host, () => {
  if (readyFilePath) {
    fs.writeFileSync(readyFilePath, String(process.pid), 'utf8');
  }
  if (llamaLogLine) {
    process.stdout.write(String(llamaLogLine) + '\\n');
  }
});

function shutdown() {
  try { fs.rmSync(readyFilePath, { force: true }); } catch {}
  try { fs.rmSync(pidFilePath, { force: true }); } catch {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`, 'utf8');

  fs.writeFileSync(executablePath, `
@echo off
set "NODE_PATH=${String(process.execPath).replace(/"/gu, '""')}"
set "FAKE_SERVER=${String(fakeServerPath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_MODEL_ID=${String(modelId).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_READY_FILE=${String(readyFilePath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_LAUNCH_MARKER=${String(launchMarkerPath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_INVOCATION_LOG=${String(invocationLogPath).replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_STARTUP_LOG_LINE=${String(options.startupLogLine || '').replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_LLAMA_LOG_LINE=${String(options.llamaLogLine || '').replace(/"/gu, '""')}"
set "SIFTKIT_FAKE_EMIT_VERBOSE_ENV_FLAGS=${options.emitVerboseEnvFlags ? '1' : '0'}"
set "SIFTKIT_FAKE_WRITE_LAUNCH_MARKER=${options.writeLaunchMarker ? '1' : '0'}"
set "SIFTKIT_FAKE_LAUNCH_HANGING_PROCESS=${options.launchHangingProcess ? '1' : '0'}"
set "SIFTKIT_FAKE_EXIT_AFTER_LOG=${options.exitAfterLog ? '1' : '0'}"
set "SIFTKIT_FAKE_EXIT_CODE=${Number.isFinite(Number(options.exitCode)) ? String(Math.trunc(Number(options.exitCode))) : '0'}"
"%NODE_PATH%" "%FAKE_SERVER%" %*
`, 'utf8');

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    executablePath,
    fakeServerPath,
    modelPath,
    readyFilePath,
    launchMarkerPath,
    invocationLogPath,
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
  toSingleQuotedPowerShellLiteral, writeManagedLlamaScripts, writeManagedLlamaLauncher,
  waitForAsyncExpectation, runPowerShellScript,
};
