import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { writeConfig } from '../src/status-server/config-store.js';
import {
  getConfigPath,
  getDefaultConfig,
  getFreePort,
  sleep,
  startStatusServerProcess,
  withTempEnv,
} from './_runtime-helpers.js';

function writeVictimScript(root: string, port: number): string {
  const scriptPath = path.join(root, 'victim-tabby.cjs');
  fs.writeFileSync(scriptPath, `
const http = require('node:http');
const server = http.createServer((request, response) => {
  if (request.url === '/v1/model' && request.method === 'GET') {
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end('{"id":"model-a"}');
    return;
  }
  if (request.url === '/v1/model/load' && request.method === 'POST') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\\n\\n');
    return;
  }
  if (request.url === '/v1/model/unload' && request.method === 'POST') {
    response.statusCode = 200;
    response.end();
    return;
  }
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end('{"object":"list","data":[{"id":"model-a"}]}');
});
server.listen(${port}, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
`, 'utf8');
  return scriptPath;
}

async function victimAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function postJson(url: string): Promise<{ statusCode: number; body: { ok?: boolean; restarted?: boolean; error?: string } }> {
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  return { statusCode: res.status, body: text ? JSON.parse(text) : {} };
}

test('managed llama startup cleanup does not reap the TabbyAPI process on the shared port when an exl3 preset is active', async () => {
  await withTempEnv(async (tempRoot) => {
    const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
    const configPath = getConfigPath();
    const port = await getFreePort();
    const scriptPath = writeVictimScript(tempRoot, port);

    // Long-lived external "TabbyAPI" process on the shared port. Before the fix, the
    // legacy config.Backend='llama.cpp' gate made the managed-llama startup cleanup
    // reap whatever listened on this port — killing this process.
    const victim: ChildProcess = spawn(process.execPath, [scriptPath], {
      stdio: 'ignore',
      windowsHide: true,
    });

    try {
      for (let i = 0; i < 50 && !(await victimAlive(port)); i += 1) await sleep(50);
      assert.equal(await victimAlive(port), true, 'victim failed to start');

      const config = getDefaultConfig();
      const basePreset = config.Server.ModelPresets.Presets[0];
      if (!basePreset) throw new Error('Default model preset is missing');
      const exl3Preset = {
        ...basePreset,
        id: 'exl3-main',
        Backend: 'exl3' as const,
        BaseUrl: `http://127.0.0.1:${port}`,
        Model: 'model-a',
        ModelPath: path.join(tempRoot, 'model-a'),
        ExecutablePath: path.join(tempRoot, 'unused-llama.exe'),
        ExternalServerEnabled: false,
        HealthcheckTimeoutMs: 500,
        HealthcheckIntervalMs: 25,
      };
      config.Backend = 'llama.cpp';
      config.Server.Engines.Exl3 = {
        Managed: false,
        WorkingDirectory: tempRoot,
        PythonPath: process.execPath,
        Entrypoint: 'unused',
        ConfigPath: 'config.yml',
        ModelRoot: tempRoot,
        AdminApiKey: '',
        ShutdownTimeoutMs: 1_000,
      };
      config.Server.ModelPresets = {
        ActivePresetId: exl3Preset.id,
        Presets: [exl3Preset, basePreset],
      };
      writeConfig(configPath, config);

      const statusServer = await startStatusServerProcess({ statusPath, configPath, workingDirectory: tempRoot });
      try {
        // Startup (which runs the managed-llama preexisting cleanup) has completed by now.
        assert.equal(await victimAlive(port), true, 'startup cleanup reaped the exl3/TabbyAPI process on the shared port');

        // The managed-llama restart endpoint must refuse under an active exl3 preset
        // (llama.cpp-only) instead of tearing down the coordinator-owned runtime.
        const restart = await postJson(`${statusServer.statusUrl}/restart`);
        assert.equal(restart.statusCode, 400, 'restart endpoint must reject under an active exl3 preset');
        assert.equal(restart.body.ok, false);
        assert.equal(restart.body.restarted, false);
        assert.equal(restart.body.error, 'Backend restart is only supported for an active llama.cpp preset.');
        assert.equal(await victimAlive(port), true, 'restart attempt reaped the exl3/TabbyAPI process on the shared port');
      } finally {
        await statusServer.close();
      }

      // The coordinator owns exl3 shutdown (API unload only); it must never force-kill the external process.
      assert.equal(await victimAlive(port), true, 'server shutdown reaped the external exl3/TabbyAPI process');
    } finally {
      if (victim.exitCode === null && !victim.killed) victim.kill('SIGTERM');
    }
  });
});
