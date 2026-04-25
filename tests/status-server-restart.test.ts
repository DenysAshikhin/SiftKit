// @ts-nocheck
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writeConfig } = require('../dist/status-server/config-store.js');

const {
  getDefaultConfig,
  getFreePort,
  requestJson,
  setManagedLlamaBaseUrl,
  waitForAsyncExpectation,
  withRealStatusServer,
  withTempEnv,
  writeManagedLlamaLauncher,
} = require('./_runtime-helpers.js');

function requestJsonAllowError(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = require('node:http').request(
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
          let body = {};
          try {
            body = responseText ? JSON.parse(responseText) : {};
          } catch {
            body = { raw: responseText };
          }
          resolve({
            statusCode: response.statusCode || 0,
            body,
          });
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

test('real status server backend restart endpoint restarts managed llama.cpp and returns the live config', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaLauncher(tempRoot, llamaPort);
    const config = getDefaultConfig();

    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        ExecutablePath: managed.executablePath,
        BaseUrl: managed.baseUrl,
        BindHost: '127.0.0.1',
        Port: llamaPort,
        ModelPath: managed.modelPath,
        NumCtx: 32000,
        GpuLayers: 999,
        Threads: 2,
        FlashAttention: true,
        ParallelSlots: 1,
        BatchSize: 512,
        UBatchSize: 512,
        CacheRam: 8192,
        KvCacheQuantization: 'q8_0',
        MaxTokens: 15000,
        Temperature: 0.6,
        TopP: 0.95,
        TopK: 20,
        MinP: 0,
        PresencePenalty: 0,
        RepetitionPenalty: 1,
        Reasoning: 'on',
        ReasoningBudget: 10000,
        ReasoningBudgetMessage: 'Thinking budget exhausted. You have to provide the answer now.',
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
        VerboseLogging: false,
      },
    };
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      const initialInvocation = JSON.parse(fs.readFileSync(managed.invocationLogPath, 'utf8'));
      assert.deepEqual(
        initialInvocation.argv.filter((entry) => (
          entry === '--cache-type-k'
          || entry === '--cache-type-v'
          || entry === 'q8_0'
        )),
        ['--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0'],
      );
      assert.equal(initialInvocation.argv.includes('--reasoning-budget-message'), true);
      assert.equal(
        initialInvocation.argv[initialInvocation.argv.indexOf('--reasoning-budget-message') + 1],
        'Thinking budget exhausted. You have to provide the answer now.',
      );

      const initialPid = fs.readFileSync(managed.readyFilePath, 'utf8').trim();
      assert.match(initialPid, /^\d+$/u);

      const restartResponse = await requestJson(new URL('/status/restart', statusUrl).toString(), {
        method: 'POST',
      });

      assert.equal(restartResponse.ok, true);
      assert.equal(restartResponse.restarted, true);
      assert.equal(restartResponse.config.Server.LlamaCpp.BaseUrl, managed.baseUrl);
      assert.equal(restartResponse.config.Server.LlamaCpp.ExecutablePath, managed.executablePath);

      await waitForAsyncExpectation(async () => {
        const nextPid = fs.readFileSync(managed.readyFilePath, 'utf8').trim();
        assert.match(nextPid, /^\d+$/u);
        assert.notEqual(nextPid, initialPid);
        const models = await requestJson(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
    });
  });
});

test('real status server backend restart endpoint returns structured GPU OOM details when managed llama.cpp exits during startup', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaLauncher(tempRoot, llamaPort, 'managed-test-model', {
      startupLogLine: 'llama_params_fit_impl: projected to use 25293 MiB of device memory vs. 22842 MiB of free device memory',
      llamaLogLine: 'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9376.00 MiB on device 0: cudaMalloc failed: out of memory',
      exitAfterLog: true,
      exitCode: 7,
    });
    const config = getDefaultConfig();

    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        ExecutablePath: managed.executablePath,
        BaseUrl: managed.baseUrl,
        BindHost: '127.0.0.1',
        Port: llamaPort,
        ModelPath: managed.modelPath,
        NumCtx: 150000,
        GpuLayers: 999,
        Threads: 2,
        FlashAttention: true,
        ParallelSlots: 1,
        BatchSize: 512,
        UBatchSize: 512,
        CacheRam: 8192,
        KvCacheQuantization: 'f16',
        MaxTokens: 15000,
        Temperature: 0.6,
        TopP: 0.95,
        TopK: 20,
        MinP: 0,
        PresencePenalty: 0,
        RepetitionPenalty: 1,
        Reasoning: 'on',
        ReasoningBudget: 10000,
        ReasoningBudgetMessage: 'Thinking budget exhausted. You have to provide the answer now.',
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
        VerboseLogging: false,
      },
    };
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      const restartResponse = await requestJsonAllowError(new URL('/status/restart', statusUrl).toString(), {
        method: 'POST',
      });

      assert.equal(restartResponse.statusCode, 503);
      assert.equal(restartResponse.body.ok, false);
      assert.equal(restartResponse.body.restarted, false);
      assert.equal(restartResponse.body.startupFailure.kind, 'gpu_memory_oom');
      assert.equal(restartResponse.body.startupFailure.requiredMiB, 25293);
      assert.equal(restartResponse.body.startupFailure.availableMiB, 22842);
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
    });
  });
});

test('real status server omits -t when the active managed preset sets Threads to 0', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    const llamaPort = await getFreePort();
    const managed = writeManagedLlamaLauncher(tempRoot, llamaPort);
    const config = getDefaultConfig();

    setManagedLlamaBaseUrl(config, managed.baseUrl);
    config.Server = {
      LlamaCpp: {
        ExecutablePath: managed.executablePath,
        BaseUrl: managed.baseUrl,
        BindHost: '127.0.0.1',
        Port: llamaPort,
        ModelPath: managed.modelPath,
        NumCtx: 32000,
        GpuLayers: 999,
        Threads: -1,
        FlashAttention: true,
        ParallelSlots: 1,
        BatchSize: 512,
        UBatchSize: 512,
        CacheRam: 8192,
        KvCacheQuantization: 'f16',
        MaxTokens: 15000,
        Temperature: 0.6,
        TopP: 0.95,
        TopK: 20,
        MinP: 0,
        PresencePenalty: 0,
        RepetitionPenalty: 1,
        Reasoning: 'on',
        ReasoningBudget: 10000,
        ReasoningBudgetMessage: 'Thinking budget exhausted. You have to provide the answer now.',
        StartupTimeoutMs: 5000,
        HealthcheckTimeoutMs: 100,
        HealthcheckIntervalMs: 10,
        VerboseLogging: false,
        Presets: [
          {
            id: 'default',
            label: 'Default',
            ExecutablePath: managed.executablePath,
            BaseUrl: managed.baseUrl,
            BindHost: '127.0.0.1',
            Port: llamaPort,
            ModelPath: managed.modelPath,
            NumCtx: 32000,
            GpuLayers: 999,
            Threads: 0,
            FlashAttention: true,
            ParallelSlots: 1,
            BatchSize: 512,
            UBatchSize: 512,
            CacheRam: 8192,
            KvCacheQuantization: 'f16',
            MaxTokens: 15000,
            Temperature: 0.6,
            TopP: 0.95,
            TopK: 20,
            MinP: 0,
            PresencePenalty: 0,
            RepetitionPenalty: 1,
            Reasoning: 'on',
            ReasoningBudget: 10000,
            ReasoningBudgetMessage: 'Thinking budget exhausted. You have to provide the answer now.',
            StartupTimeoutMs: 5000,
            HealthcheckTimeoutMs: 100,
            HealthcheckIntervalMs: 10,
            VerboseLogging: false,
          },
        ],
        ActivePresetId: 'default',
      },
    };
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async () => {
      await waitForAsyncExpectation(async () => {
        const invocation = JSON.parse(fs.readFileSync(managed.invocationLogPath, 'utf8'));
        assert.equal(invocation.argv.includes('-t'), false);
      }, 5000);
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
    });
  });
});
