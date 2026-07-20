import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { InferenceRuntimeStatusSchema } from '@siftkit/contracts';
import { z } from 'zod';

import { getConfigPath } from '../src/config/index.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { parseJsonObjectText, parseJsonValueText } from '../src/lib/json.js';
import type { JsonObject, JsonValue } from '../src/lib/json-types.js';
import { startStatusServer } from '../src/status-server/index.js';
import { writeConfig } from '../src/status-server/config-store.js';
import { readBody } from '../src/status-server/http-utils.js';
import { getAddressInfo } from './helpers/dashboard-http.js';
import { getFreePort, withTempEnv } from './_runtime-helpers.js';

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for inference lifecycle state.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('remote chat wakes idle-unloaded EXL3 while model catalog remains no-wake', async () => {
  await withTempEnv(async (tempRoot) => {
    let resident = false;
    let loadCount = 0;
    let unloadCount = 0;
    let chatCount = 0;
    let blockNextUnload = false;
    let unloadMayFinish = false;
    const tokenBodies: JsonValue[] = [];
    const tabby = http.createServer(async (request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end('{"data":[]}');
        return;
      }
      if (request.url === '/v1/model' && request.method === 'GET') {
        if (!resident) {
          response.statusCode = 400;
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end('{"id":"model-a"}');
        return;
      }
      if (request.url === '/v1/model/load' && request.method === 'POST') {
        loadCount += 1;
        resident = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
        return;
      }
      if (request.url === '/v1/model/unload' && request.method === 'POST') {
        unloadCount += 1;
        if (blockNextUnload) {
          while (!unloadMayFinish) await new Promise((resolve) => setTimeout(resolve, 10));
          blockNextUnload = false;
        }
        resident = false;
        response.statusCode = 200;
        response.end();
        return;
      }
      if (request.url === '/v1/chat/completions' && request.method === 'POST') {
        chatCount += 1;
        response.setHeader('content-type', 'application/json');
        response.end('{"choices":[{"message":{"content":"ok"}}]}');
        return;
      }
      if (request.url === '/v1/token/encode' && request.method === 'POST') {
        tokenBodies.push(parseJsonValueText(await readBody(request)));
        response.setHeader('content-type', 'application/json');
        response.end('{"tokens":[10,20]}');
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => tabby.listen(0, '127.0.0.1', resolve));
    const tabbyBaseUrl = `http://127.0.0.1:${getAddressInfo(tabby).port}`;
    let statusServer: ReturnType<typeof startStatusServer> | null = null;
    try {
      const statusPort = await getFreePort();
      process.env.SIFTKIT_STATUS_PORT = String(statusPort);
      const config = getDefaultConfigObject();
      const preset = config.Server.ModelPresets.Presets[0];
      if (!preset) throw new Error('Default model preset is missing');
      config.Server.Engines.Exl3 = {
        Managed: false,
        WorkingDirectory: tempRoot,
        PythonPath: process.execPath,
        Entrypoint: 'unused',
        ConfigPath: 'config.yml',
        ModelRoot: tempRoot,
        ShutdownTimeoutMs: 1_000,
      };
      config.Server.ModelPresets.Presets = [{
        ...preset,
        id: 'exl3-main',
        Backend: 'exl3',
        BaseUrl: tabbyBaseUrl,
        Model: 'model-a',
        ModelPath: path.join(tempRoot, 'model-a'),
        SleepIdleSeconds: 1,
      }];
      config.Server.ModelPresets.ActivePresetId = 'exl3-main';
      writeConfig(getConfigPath(), config);
      statusServer = startStatusServer();
      await statusServer.startupPromise;
      const siftBaseUrl = `http://127.0.0.1:${getAddressInfo(statusServer).port}`;
      assert.equal(loadCount, 1);
      const firstChat = await fetch(`${siftBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'first' }] }),
      });
      assert.equal(firstChat.status, 200);

      const tokenize = await fetch(`${siftBaseUrl}/tokenize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'first tokens' }),
      });
      assert.equal(tokenize.status, 200);
      assert.deepEqual(z.object({ count: z.number() }).parse(await tokenize.json()), { count: 2 });

      const tokenEncode = await fetch(`${siftBaseUrl}/v1/token/encode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'second tokens' }),
      });
      assert.equal(tokenEncode.status, 200);
      assert.deepEqual(
        z.object({ tokens: z.array(z.number()), length: z.number() }).parse(await tokenEncode.json()),
        { tokens: [10, 20], length: 2 },
      );
      assert.deepEqual(tokenBodies, [{ text: 'first tokens' }, { text: 'second tokens' }]);

      await waitFor(() => unloadCount === 1);
      await waitFor(async () => {
        const response = await fetch(`${siftBaseUrl}/runtime/inference`);
        return InferenceRuntimeStatusSchema.parse(await response.json()).modelState === 'unloaded';
      });

      const runtimeStatusResponse = await fetch(`${siftBaseUrl}/runtime/inference`);
      assert.equal(runtimeStatusResponse.status, 200);
      assert.deepEqual(InferenceRuntimeStatusSchema.parse(await runtimeStatusResponse.json()), {
        activePresetId: 'exl3-main',
        activePresetLabel: preset.label,
        backend: 'exl3',
        processState: 'ready',
        modelState: 'unloaded',
        model: 'model-a',
        idleDeadlineUtc: null,
        errorPhase: null,
        error: null,
        rollback: null,
      });

      const catalog = await fetch(`${siftBaseUrl}/v1/models`);
      assert.equal(catalog.status, 200);
      assert.deepEqual(await catalog.json(), { data: [{ id: 'model-a', object: 'model' }] });
      assert.equal(loadCount, 1);

      const wakeChat = await fetch(`${siftBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'wake' }] }),
      });
      assert.equal(wakeChat.status, 200);
      assert.equal(loadCount, 2);
      assert.equal(chatCount, 2);

      blockNextUnload = true;
      await waitFor(() => unloadCount === 2);
      const racingChatPromise = fetch(`${siftBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'during unload' }] }),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(loadCount, 2);
      assert.equal(chatCount, 2);

      unloadMayFinish = true;
      const racingChat = await racingChatPromise;
      assert.equal(racingChat.status, 200);
      assert.equal(loadCount, 3);
      assert.equal(chatCount, 3);
    } finally {
      const serverToClose = statusServer;
      if (serverToClose) await new Promise<void>((resolve) => serverToClose.close(() => resolve()));
      await new Promise<void>((resolve) => tabby.close(() => resolve()));
    }
  });
});

test('chat queued during a preset switch is translated for the target backend', async () => {
  await withTempEnv(async (tempRoot) => {
    let releaseLlamaChat = false;
    let llamaChatCount = 0;
    let tabbyResident = false;
    const tabbyChatBodies: JsonObject[] = [];
    const llama = http.createServer(async (request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end('{"data":[{"id":"llama-model"}]}');
        return;
      }
      if (request.url === '/v1/chat/completions' && request.method === 'POST') {
        llamaChatCount += 1;
        while (!releaseLlamaChat) await new Promise((resolve) => setTimeout(resolve, 10));
        response.setHeader('content-type', 'application/json');
        response.end('{"choices":[{"message":{"content":"llama"}}]}');
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const tabby = http.createServer(async (request, response) => {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json');
        response.end('{"data":[]}');
        return;
      }
      if (request.url === '/v1/model' && request.method === 'GET') {
        response.statusCode = tabbyResident ? 200 : 400;
        response.setHeader('content-type', 'application/json');
        response.end(tabbyResident ? '{"id":"tabby-model"}' : '{}');
        return;
      }
      if (request.url === '/v1/model/load' && request.method === 'POST') {
        tabbyResident = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"model_type":"model","module":1,"modules":1,"status":"finished"}\n\n');
        return;
      }
      if (request.url === '/v1/model/unload' && request.method === 'POST') {
        tabbyResident = false;
        response.statusCode = 200;
        response.end();
        return;
      }
      if (request.url === '/v1/chat/completions' && request.method === 'POST') {
        tabbyChatBodies.push(parseJsonObjectText(await readBody(request)));
        response.setHeader('content-type', 'application/json');
        response.end('{"choices":[{"message":{"content":"tabby"}}]}');
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await Promise.all([
      new Promise<void>((resolve) => llama.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => tabby.listen(0, '127.0.0.1', resolve)),
    ]);
    let statusServer: ReturnType<typeof startStatusServer> | null = null;
    try {
      process.env.SIFTKIT_STATUS_PORT = String(await getFreePort());
      const config = getDefaultConfigObject();
      const basePreset = config.Server.ModelPresets.Presets[0];
      if (!basePreset) throw new Error('Default model preset is missing');
      const llamaPreset = {
        ...basePreset,
        id: 'llama-main',
        Backend: 'llama' as const,
        ExternalServerEnabled: true,
        BaseUrl: `http://127.0.0.1:${getAddressInfo(llama).port}`,
        Model: 'llama-model',
        RepetitionPenalty: 1.01,
      };
      const exl3Preset = {
        ...basePreset,
        id: 'exl3-main',
        Backend: 'exl3' as const,
        BaseUrl: `http://127.0.0.1:${getAddressInfo(tabby).port}`,
        Model: 'tabby-model',
        ModelPath: path.join(tempRoot, 'tabby-model'),
        RepetitionPenalty: 1.23,
        Reasoning: 'on' as const,
        ReasoningContent: true,
        PreserveThinking: true,
      };
      config.Server.Engines.Exl3 = {
        Managed: false,
        WorkingDirectory: tempRoot,
        PythonPath: process.execPath,
        Entrypoint: 'unused',
        ConfigPath: 'config.yml',
        ModelRoot: tempRoot,
        ShutdownTimeoutMs: 1_000,
      };
      config.Server.ModelPresets = {
        ActivePresetId: llamaPreset.id,
        Presets: [llamaPreset, exl3Preset],
      };
      writeConfig(getConfigPath(), config);
      statusServer = startStatusServer();
      await statusServer.startupPromise;
      const siftBaseUrl = `http://127.0.0.1:${getAddressInfo(statusServer).port}`;

      const activeChatPromise = fetch(`${siftBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'active' }] }),
      });
      await waitFor(() => llamaChatCount === 1);
      config.Server.ModelPresets.ActivePresetId = exl3Preset.id;
      const update = await fetch(`${siftBaseUrl}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
      assert.equal(update.status, 200);
      const tools = [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather.',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }];
      const responseFormat = {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' } },
      };
      const queuedChatPromise = fetch(`${siftBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'queued' }],
          tools,
          parallel_tool_calls: true,
          response_format: responseFormat,
          cache_prompt: true,
          id_slot: 4,
          timings_per_token: true,
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseLlamaChat = true;

      assert.equal((await activeChatPromise).status, 200);
      assert.equal((await queuedChatPromise).status, 200);
      assert.equal(tabbyChatBodies.length, 1);
      assert.equal(tabbyChatBodies[0]?.repetition_penalty, 1.23);
      assert.equal(tabbyChatBodies[0]?.repeat_penalty, undefined);
      assert.deepEqual(tabbyChatBodies[0]?.tools, tools);
      assert.equal(tabbyChatBodies[0]?.parallel_tool_calls, true);
      assert.deepEqual(tabbyChatBodies[0]?.response_format, responseFormat);
      assert.equal(tabbyChatBodies[0]?.cache_prompt, undefined);
      assert.equal(tabbyChatBodies[0]?.id_slot, undefined);
      assert.equal(tabbyChatBodies[0]?.timings_per_token, undefined);
      assert.deepEqual(tabbyChatBodies[0]?.chat_template_kwargs, {
        enable_thinking: true,
        preserve_thinking: true,
      });
    } finally {
      releaseLlamaChat = true;
      const serverToClose = statusServer;
      if (serverToClose) await new Promise<void>((resolve) => serverToClose.close(() => resolve()));
      await Promise.all([
        new Promise<void>((resolve) => llama.close(() => resolve())),
        new Promise<void>((resolve) => tabby.close(() => resolve())),
      ]);
    }
  });
});
