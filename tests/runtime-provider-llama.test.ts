// @ts-nocheck — Split from runtime.test.js. Full TS typing deferred.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { loadConfig, saveConfig, getConfigPath, getExecutionServerState, getChunkThresholdCharacters, getConfiguredLlamaNumCtx, getEffectiveInputCharactersPerContextToken, initializeRuntime, getStatusServerUnavailableMessage, SIFT_BROKEN_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_FORMER_DEFAULT_LLAMA_STARTUP_SCRIPT, SIFT_PREVIOUS_DEFAULT_LLAMA_STARTUP_SCRIPT } = require('../dist/config/index.js');
const { summarizeRequest, buildPrompt, getSummaryDecision, planTokenAwareLlamaCppChunks, getPlannerPromptBudget, buildPlannerToolDefinitions, UNSUPPORTED_INPUT_MESSAGE } = require('../dist/summary.js');
const { runCommand } = require('../dist/command.js');
const { runBenchmarkSuite } = require('../dist/benchmark/index.js');
const { readMatrixManifest, buildLaunchSignature, buildLauncherArgs, buildBenchmarkArgs, pruneOldLauncherLogs, runMatrix, runMatrixWithInterrupt } = require('../dist/benchmark-matrix/index.js');
const { countLlamaCppTokens, listLlamaCppModels, generateLlamaCppResponse } = require('../dist/providers/llama-cpp.js');
const { withExecutionLock } = require('../dist/execution-lock.js');
const { buildIdleMetricsLogMessage, buildStatusRequestLogMessage, formatElapsed, getIdleSummarySnapshotsPath, startStatusServer } = require('../dist/status-server/index.js');
const { runDebugRequest } = require('../dist/scripts/run-benchmark-fixture-debug.js');
const { runFixture60MalformedJsonRepro } = require('../dist/scripts/repro-fixture60-malformed-json.js');

const {
  TEST_USE_EXISTING_SERVER,
  EXISTING_SERVER_STATUS_URL,
  EXISTING_SERVER_CONFIG_URL,
  RUN_LIVE_LLAMA_TOKENIZE_TESTS,
  LIVE_LLAMA_BASE_URL,
  LIVE_CONFIG_SERVICE_URL,
  FAST_LEASE_STALE_MS,
  FAST_LEASE_WAIT_MS,
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
  readBody,
  resolveArtifactLogPathFromStatusPost,
  requestJson,
  sleep,
  removeDirectoryWithRetries,
  spawnProcess,
  waitForTextMatch,
  startStubStatusServer,
  withTempEnv,
  withStubServer,
  withSummaryTestServer,
  withRealStatusServer,
  startStatusServerProcess,
  stripAnsi,
  captureStdout,
  readIdleSummarySnapshots,
  getIdleSummaryBlock,
  getFreePort,
  toSingleQuotedPowerShellLiteral,
  writeManagedLlamaScripts,
  waitForAsyncExpectation,
  runPowerShellScript,
} = require('./_runtime-helpers.js');

test('llama.cpp provider lists models and parses chat completions from the stub server', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const models = await listLlamaCppModels(config);
      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.deepEqual(models, [config.Model]);
      assert.match(summary.text, /^summary:/u);
      assert.deepEqual(summary.usage, {
        promptTokens: 123,
        completionTokens: 45,
        totalTokens: 168,
        thinkingTokens: null,
        promptCacheTokens: null,
        promptEvalTokens: null,
      });
    });
  });
});

test('llama.cpp provider returns null usage when the server omits token usage', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.equal(summary.usage, null);
      assert.match(summary.text, /^summary:/u);
    }, {
      omitUsage: true,
    });
  });
});

test('llama.cpp provider records thinking tokens separately from completion usage', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.deepEqual(summary.usage, {
        promptTokens: 123,
        completionTokens: 33,
        totalTokens: 168,
        thinkingTokens: 12,
        promptCacheTokens: null,
        promptEvalTokens: null,
      });
      assert.match(summary.text, /^summary:/u);
    }, {
      reasoningTokens: 12,
    });
  });
});

test('llama.cpp provider forwards reasoning mode to chat template kwargs', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'off';

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.equal(server.state.chatRequests.length, 1);
      assert.deepEqual(server.state.chatRequests[0].chat_template_kwargs, {
        enable_thinking: false,
      });
      assert.equal('extra_body' in server.state.chatRequests[0], false);
    });
  });
});

test('llama.cpp provider forwards thinking preservation flags when enabled', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'on';
      config.Server ??= {};
      config.Server.LlamaCpp ??= {};
      config.Server.LlamaCpp.ReasoningContent = true;
      config.Server.LlamaCpp.PreserveThinking = true;

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.equal(server.state.chatRequests.length, 1);
      assert.deepEqual(server.state.chatRequests[0].chat_template_kwargs, {
        enable_thinking: true,
        reasoning_content: true,
        preserve_thinking: true,
      });
      assert.equal('extra_body' in server.state.chatRequests[0], false);
    });
  });
});

test('llama.cpp provider per-call reasoning override takes precedence over config reasoning', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'on';

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
        reasoningOverride: 'off',
      });

      assert.equal(server.state.chatRequests.length, 1);
      assert.deepEqual(server.state.chatRequests[0].chat_template_kwargs, {
        enable_thinking: false,
      });
      assert.equal('extra_body' in server.state.chatRequests[0], false);
    });
  });
});

test('llama.cpp provider omits sampling knobs from the chat request body', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });
      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Temperature = 0.8;
      config.Runtime.LlamaCpp.TopP = 0.9;
      config.Runtime.LlamaCpp.TopK = 25;
      config.Runtime.LlamaCpp.MinP = 0.05;
      config.Runtime.LlamaCpp.PresencePenalty = 0.5;
      config.Runtime.LlamaCpp.RepetitionPenalty = 1.1;

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.equal(server.state.chatRequests.length, 1);
      const requestBody = server.state.chatRequests[0];
      assert.equal('temperature' in requestBody, false);
      assert.equal('top_p' in requestBody, false);
      assert.equal('top_k' in requestBody, false);
      assert.equal('min_p' in requestBody, false);
      assert.equal('presence_penalty' in requestBody, false);
      assert.equal('repeat_penalty' in requestBody, false);
      assert.equal('extra_body' in requestBody, false);
    });
  });
});

test('llama.cpp provider enables explicit prompt caching on a supplied slot', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
        slotId: 7,
      });

      assert.equal(server.state.chatRequests.length, 1);
      assert.equal(server.state.chatRequests[0].cache_prompt, true);
      assert.equal(server.state.chatRequests[0].id_slot, 7);
    });
  });
});

test('llama.cpp provider includes per-request response_format json_schema when structured output is enabled', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
        structuredOutput: { kind: 'siftkit-decision-json' },
      });

      assert.equal(server.state.chatRequests.length, 1);
      const responseFormatText = JSON.stringify(server.state.chatRequests[0]?.response_format || {});
      assert.equal(server.state.chatRequests[0]?.response_format?.type, 'json_schema');
      assert.match(responseFormatText, /classification/u);
      assert.match(responseFormatText, /raw_review_required/u);
      assert.match(responseFormatText, /output/u);
      assert.equal('extra_body' in (server.state.chatRequests[0] || {}), false);
    });
  });
});

test('llama.cpp provider enables parallel tool calls when tools are sent', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
        structuredOutput: {
          kind: 'siftkit-planner-action-json',
          tools: buildPlannerToolDefinitions(),
        },
      });

      assert.equal(server.state.chatRequests.length, 1);
      assert.equal(server.state.chatRequests[0].parallel_tool_calls, true);
    });
  });
});

test('llama.cpp provider does not enable parallel tool calls when no tools are sent', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });

      await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.equal(server.state.chatRequests.length, 1);
      assert.equal('parallel_tool_calls' in server.state.chatRequests[0], false);
    });
  });
});

test('llama.cpp provider gets answer content from qwen-style servers when reasoning is off', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      config.Runtime ??= {};
      config.Runtime.LlamaCpp ??= {};
      config.Runtime.LlamaCpp.Reasoning = 'off';

      const summary = await generateLlamaCppResponse({
        config,
        model: config.Model,
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });

      assert.equal(summary.text, '{"classification":"summary","raw_review_required":false,"output":"ok"}');
    }, {
      assistantContent(promptText, parsed) {
        if (parsed?.chat_template_kwargs?.enable_thinking === false) {
          return '{"classification":"summary","raw_review_required":false,"output":"ok"}';
        }

        return '';
      },
    });
  });
});

test('llama.cpp provider accepts count-only tokenize responses', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const config = await loadConfig({ ensure: true });
      const tokenCount = await countLlamaCppTokens(config, 'A'.repeat(1234));

      assert.equal(tokenCount, 1234);
    }, {
      tokenizeCharsPerToken: 1,
    });
  });
});

test('llama.cpp provider surfaces HTTP 400 errors when json-schema constrained requests are rejected', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const config = await loadConfig({ ensure: true });

      await assert.rejects(
        () => generateLlamaCppResponse({
          config,
          model: config.Model,
          prompt: 'test prompt body',
          timeoutSeconds: 5,
          structuredOutput: { kind: 'siftkit-decision-json' },
        }),
        /llama\.cpp generate failed with HTTP 400/u
      );

      assert.equal(server.state.chatRequests.length, 1);
      const responseFormatText = JSON.stringify(server.state.chatRequests[0]?.response_format || {});
      assert.equal(server.state.chatRequests[0]?.response_format?.type, 'json_schema');
      assert.match(responseFormatText, /classification/u);
    }, {
      rejectPromptCharsOver: 1,
    });
  });
});

test('llama.cpp provider waits for warm-up and retries model-list requests after ECONNREFUSED', async () => {
  await withTempEnv(async () => {
    const port = await getFreePort();
    let modelsRequestCount = 0;
    let delayedServer = null;
    const startTimer = setTimeout(() => {
      delayedServer = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/v1/models') {
          modelsRequestCount += 1;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'warmup-model' }] }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      delayedServer.listen(port, '127.0.0.1');
    }, 300);

    try {
      const config = {
        Backend: 'llama.cpp',
        Runtime: {
          Model: 'warmup-model',
          LlamaCpp: {
            BaseUrl: `http://127.0.0.1:${port}`,
            NumCtx: 10000,
          },
        },
        LlamaCpp: {
          BaseUrl: `http://127.0.0.1:${port}`,
        },
        Thresholds: { MinCharactersForSummary: 500, MinLinesForSummary: 16 },
        Interactive: { Enabled: true, WrappedCommands: [], IdleTimeoutMs: 900000, MaxTranscriptCharacters: 60000, TranscriptRetention: true },
      };

      const models = await listLlamaCppModels(config);
      assert.deepEqual(models, ['warmup-model']);
      assert.equal(modelsRequestCount >= 1, true);
    } finally {
      clearTimeout(startTimer);
      if (delayedServer) {
        await new Promise((resolve) => delayedServer.close(resolve));
      }
    }
  });
});

test('llama.cpp provider waits for warm-up and retries chat-completions after ECONNREFUSED', async () => {
  await withTempEnv(async () => {
    const port = await getFreePort();
    let chatRequestCount = 0;
    let delayedServer = null;
    const startTimer = setTimeout(() => {
      delayedServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
          chatRequestCount += 1;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            choices: [{ message: { content: 'warm-up complete' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
          return;
        }
        if (req.method === 'POST' && req.url === '/tokenize') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ count: 1 }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      delayedServer.listen(port, '127.0.0.1');
    }, 300);

    try {
      const config = {
        Backend: 'llama.cpp',
        Runtime: {
          Model: 'warmup-model',
          LlamaCpp: {
            BaseUrl: `http://127.0.0.1:${port}`,
            NumCtx: 10000,
          },
        },
        LlamaCpp: {
          BaseUrl: `http://127.0.0.1:${port}`,
        },
        Thresholds: { MinCharactersForSummary: 500, MinLinesForSummary: 16 },
        Interactive: { Enabled: true, WrappedCommands: [], IdleTimeoutMs: 900000, MaxTranscriptCharacters: 60000, TranscriptRetention: true },
      };

      const response = await generateLlamaCppResponse({
        config,
        model: 'warmup-model',
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });
      assert.equal(response.text, 'warm-up complete');
      assert.equal(chatRequestCount >= 1, true);
    } finally {
      clearTimeout(startTimer);
      if (delayedServer) {
        await new Promise((resolve) => delayedServer.close(resolve));
      }
    }
  });
});

test('llama.cpp provider retries HTTP 503 Loading model responses for chat-completions', async () => {
  await withTempEnv(async () => {
    const port = await getFreePort();
    let chatRequestCount = 0;
    const loadingServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        chatRequestCount += 1;
        if (chatRequestCount === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Loading model', type: 'unavailable_error', code: 503 } }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: 'model ready' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/tokenize') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ count: 1 }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'warmup-model' }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      loadingServer.listen(port, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
    });

    try {
      const config = {
        Backend: 'llama.cpp',
        Runtime: {
          Model: 'warmup-model',
          LlamaCpp: {
            BaseUrl: `http://127.0.0.1:${port}`,
            NumCtx: 10000,
          },
        },
        LlamaCpp: {
          BaseUrl: `http://127.0.0.1:${port}`,
        },
        Thresholds: { MinCharactersForSummary: 500, MinLinesForSummary: 16 },
        Interactive: { Enabled: true, WrappedCommands: [], IdleTimeoutMs: 900000, MaxTranscriptCharacters: 60000, TranscriptRetention: true },
      };

      const response = await generateLlamaCppResponse({
        config,
        model: 'warmup-model',
        prompt: 'test prompt body',
        timeoutSeconds: 5,
      });
      assert.equal(response.text, 'model ready');
      assert.equal(chatRequestCount, 2);
    } finally {
      await new Promise<void>((resolve) => loadingServer.close(() => resolve()));
    }
  });
});
