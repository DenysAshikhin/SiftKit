import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { RestartBackendResponseSchema, SiftConfigSchema } from '@siftkit/contracts';
import { writeConfig } from '../src/status-server/config-store.ts';

import {
  applyManagedScriptConfig,
  getDefaultConfig,
  acquireChildPortLease,
  requestJson,
  waitForAsyncExpectation,
  withRealStatusServer,
  withTempEnv,
  writeManagedEngineHost,
} from './_runtime-helpers.ts';
import { testHttpAgent } from './helpers/http-agent.ts';
import { launchEngineVariables } from './helpers/in-process-tabby.ts';
import type { EngineLaunchSpec, EngineProcess, EngineProcessLauncher } from '../src/status-server/engine-process.ts';

interface ModelsResponse {
  data: { id: string }[];
}

interface RestartResponse {
  ok: boolean;
  restarted: boolean;
  config: {
    Server: { ModelPresets: { Presets: { BaseUrl: string; ModelPath: string }[] } };
  };
}

const RestartFailureResponseSchema = z.object({
  ok: z.boolean(),
  restarted: z.boolean(),
  error: z.string(),
}).passthrough();

class CpuRejectingLauncher implements EngineProcessLauncher {
  readonly attempts: EngineLaunchSpec[] = [];
  private readonly delegate: EngineProcessLauncher;

  constructor(delegate: EngineProcessLauncher) {
    this.delegate = delegate;
  }

  launch(spec: EngineLaunchSpec): EngineProcess {
    this.attempts.push(spec);
    if (spec.environment.EXL3_MOE_CPU_THREADS === '8') throw new Error('CPU thread count rejected');
    return this.delegate.launch(spec);
  }

  terminate(process: EngineProcess): void {
    this.delegate.terminate(process);
  }
}

function requestJsonAllowError<T>(
  url: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: string } = {},
): Promise<{ statusCode: number; body: T }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        agent: testHttpAgent,
        headers: options.body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(options.body, 'utf8'),
        } : undefined,
      },
      (response) => {
        let responseText = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          responseText += chunk;
        });
        response.on('end', () => {
          try {
            resolve({
              statusCode: response.statusCode || 0,
              body: schema.parse(responseText ? JSON.parse(responseText) : {}),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reject(new Error(`Invalid JSON response (${response.statusCode || 0}): ${responseText}; ${message}`));
          }
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

test('real status server backend restart endpoint restarts the managed engine and returns the live config', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    await using enginePortLease = await acquireChildPortLease('status-server-restart');
    const managed = writeManagedEngineHost(tempRoot, enginePortLease.port);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed, {
      NumCtx: 32000,
      UBatchSize: 512,
      KvCacheQuantization: 'q8_0',
      Reasoning: 'on',
    });
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      await waitForAsyncExpectation(async () => {
        const models = await requestJson<ModelsResponse>(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);

      const [initialLaunch] = managed.launcher.launches;
      assert.equal(managed.launcher.launches.length, 1);
      assert.deepEqual(initialLaunch?.args, [managed.engine.Entrypoint]);
      const initialVariables = launchEngineVariables(initialLaunch);
      assert.equal(initialVariables.TABBY_MODEL_MODEL_NAME, 'managed-test-model');
      assert.equal(initialVariables.TABBY_MODEL_MAX_SEQ_LEN, '32000');
      assert.equal(initialVariables.TABBY_MODEL_CHUNK_SIZE, '512');
      assert.equal(initialVariables.TABBY_MODEL_CACHE_MODE, '8,8');

      const restartResponse = await requestJson<RestartResponse>(new URL('/status/restart', statusUrl).toString(), {
        method: 'POST',
      });

      assert.equal(restartResponse.ok, true);
      assert.equal(restartResponse.restarted, true);
      assert.equal(restartResponse.config.Server.ModelPresets.Presets[0].BaseUrl, managed.baseUrl);
      assert.equal(restartResponse.config.Server.ModelPresets.Presets[0].ModelPath, managed.modelPath);

      await waitForAsyncExpectation(async () => {
        // A restart is a second launch, with the first one gone.
        assert.equal(managed.launcher.launches.length, 2);
        assert.equal(managed.launcher.liveProcessCount, 1);
        const models = await requestJson<ModelsResponse>(`${managed.baseUrl}/v1/models`);
        assert.equal(models.data[0].id, 'managed-test-model');
      }, 5000);
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
      managedEngineHost: managed.host,
    });
  });
});

test('saving CPU threads takes effect on backend restart and clearing restores automatic selection', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    await using enginePortLease = await acquireChildPortLease('status-server-cpu-threads');
    const managed = writeManagedEngineHost(tempRoot, enginePortLease.port);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    config.Server.Engines.Exl3.Environment = { EXL3_MOE_CPU_THREADS: '4' };
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      assert.equal(launchEngineVariables(managed.launcher.launches[0]).EXL3_MOE_CPU_THREADS, '4');
      const loaded = await requestJsonAllowError(new URL('/config?skip_ready=1', statusUrl).toString(), SiftConfigSchema);
      assert.equal(loaded.statusCode, 200);
      const savedConfig = loaded.body;
      savedConfig.Server.Engines.Exl3.Environment.EXL3_MOE_CPU_THREADS = '8';
      savedConfig.Server.Engines.Exl3.Entrypoint = 'restarted-tabby.py';
      const saved = await requestJsonAllowError(new URL('/config', statusUrl).toString(), SiftConfigSchema, {
        method: 'PUT', body: JSON.stringify(savedConfig),
      });
      assert.equal(saved.statusCode, 200);
      assert.equal(managed.launcher.launches.length, 1, 'saving must not restart the engine');

      const restarted = await requestJsonAllowError(new URL('/status/restart', statusUrl).toString(), RestartBackendResponseSchema, {
        method: 'POST',
      });
      assert.equal(restarted.statusCode, 200);
      assert.equal(restarted.body.restarted, true);
      assert.equal(managed.launcher.launches.length, 2);
      assert.equal(launchEngineVariables(managed.launcher.launches[1]).EXL3_MOE_CPU_THREADS, '8');
      assert.deepEqual(managed.launcher.launches[1]?.args, ['restarted-tabby.py']);

      delete savedConfig.Server.Engines.Exl3.Environment.EXL3_MOE_CPU_THREADS;
      const automatic = await requestJsonAllowError(new URL('/config', statusUrl).toString(), SiftConfigSchema, {
        method: 'PUT', body: JSON.stringify(savedConfig),
      });
      assert.equal(automatic.statusCode, 200);
      assert.equal(automatic.body.Server.Engines.Exl3.Environment.EXL3_MOE_CPU_THREADS, undefined);
      const restartedAutomatic = await requestJsonAllowError(new URL('/status/restart', statusUrl).toString(), RestartBackendResponseSchema, {
        method: 'POST',
      });
      assert.equal(restartedAutomatic.statusCode, 200);
      assert.equal(restartedAutomatic.body.restarted, true);
      assert.equal(managed.launcher.launches.length, 3);
      assert.equal(launchEngineVariables(managed.launcher.launches[2]).EXL3_MOE_CPU_THREADS, undefined);
    }, { statusPath: runtimeDbPath, configPath: runtimeDbPath, managedEngineHost: managed.host });
  });
});

test('a failed CPU configuration restart restores the previous engine configuration', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    await using enginePortLease = await acquireChildPortLease('status-server-cpu-rollback');
    const managed = writeManagedEngineHost(tempRoot, enginePortLease.port);
    const launcher = new CpuRejectingLauncher(managed.host.launcher);
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed);
    config.Server.Engines.Exl3.Environment = { EXL3_MOE_CPU_THREADS: '4' };
    writeConfig(runtimeDbPath, config);
    await withRealStatusServer(async ({ statusUrl }) => {
      const loaded = await requestJsonAllowError(new URL('/config?skip_ready=1', statusUrl).toString(), SiftConfigSchema);
      loaded.body.Server.Engines.Exl3.Environment.EXL3_MOE_CPU_THREADS = '8';
      loaded.body.Server.Engines.Exl3.Entrypoint = 'rejected-tabby.py';
      const saved = await requestJsonAllowError(new URL('/config', statusUrl).toString(), SiftConfigSchema, {
        method: 'PUT', body: JSON.stringify(loaded.body),
      });
      assert.equal(saved.statusCode, 200);
      const restarted = await requestJsonAllowError(new URL('/status/restart', statusUrl).toString(), RestartFailureResponseSchema, {
        method: 'POST',
      });
      assert.equal(restarted.statusCode, 503);
      assert.match(restarted.body.error, /CPU thread count rejected/u);
      assert.deepEqual(launcher.attempts.map(attempt => attempt.environment.EXL3_MOE_CPU_THREADS), ['4', '8', '4']);
      assert.deepEqual(managed.launcher.launches[1]?.args, [managed.engine.Entrypoint]);
      assert.equal(managed.launcher.liveProcessCount, 1);
    }, { statusPath: runtimeDbPath, configPath: runtimeDbPath, managedEngineHost: { ...managed.host, launcher } });
  });
});

test('real status server backend restart endpoint returns 503 with the exit reason when the managed engine dies during startup', async () => {
  await withTempEnv(async (tempRoot) => {
    const runtimeDbPath = path.join(tempRoot, '.siftkit', 'runtime.sqlite');
    await using enginePortLease = await acquireChildPortLease('status-server-restart');
    const managed = writeManagedEngineHost(tempRoot, enginePortLease.port, 'managed-test-model', {
      engineLogLine: 'torch.cuda.OutOfMemoryError: CUDA out of memory.',
      exitAfterLog: true,
      exitCode: 7,
    });
    const config = getDefaultConfig();
    applyManagedScriptConfig(config, managed, { StartupTimeoutMs: 500 });
    writeConfig(runtimeDbPath, config);

    await withRealStatusServer(async ({ statusUrl }) => {
      const restartResponse = await requestJsonAllowError(new URL('/status/restart', statusUrl).toString(), RestartFailureResponseSchema, {
        method: 'POST',
      });

      assert.equal(restartResponse.statusCode, 503);
      assert.equal(restartResponse.body.ok, false);
      assert.equal(restartResponse.body.restarted, false);
      assert.match(restartResponse.body.error, /TabbyAPI exited unexpectedly \(code=7/u);
    }, {
      statusPath: runtimeDbPath,
      configPath: runtimeDbPath,
      managedEngineHost: managed.host,
    });
  });
});
