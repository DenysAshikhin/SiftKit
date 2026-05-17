import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  applyHostLlamaRuntimeSettings,
  getConfiguredLlamaNumCtx,
  getConfiguredModel,
  resetHostLlamaSettingsCacheForTests,
  type SiftConfig,
} from '../dist/config/index.js';
import { getPlannerPromptBudget } from '../dist/summary.js';

function makeClientConfig(options: {
  externalServer: boolean;
  baseUrl: string;
  localNumCtx: number;
}): SiftConfig {
  const llama = { BaseUrl: options.baseUrl, NumCtx: options.localNumCtx, Reasoning: 'on' };
  return {
    Version: '0.1.0',
    Backend: 'llama.cpp',
    PolicyMode: 'conservative',
    RawLogRetention: true,
    LlamaCpp: { ...llama },
    Runtime: { Model: 'mock-model', LlamaCpp: { ...llama } },
    Thresholds: { MinCharactersForSummary: 500, MinLinesForSummary: 16 },
    Interactive: {
      Enabled: true,
      WrappedCommands: [],
      IdleTimeoutMs: 1000,
      MaxTranscriptCharacters: 1000,
      TranscriptRetention: true,
    },
    Server: { LlamaCpp: { ExternalServerEnabled: options.externalServer, BaseUrl: options.baseUrl } },
  } as unknown as SiftConfig;
}

type HostConfigServer = {
  baseUrl: string;
  requestUrls: string[];
  close: () => Promise<void>;
};

async function startHostConfigServer(
  hostConfigBody: unknown,
  options: { status?: number } = {},
): Promise<HostConfigServer> {
  const requestUrls: string[] = [];
  const server = http.createServer((req, res) => {
    requestUrls.push(req.url || '');
    if ((req.url || '').startsWith('/config')) {
      res.writeHead(options.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hostConfigBody));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requestUrls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('applyHostLlamaRuntimeSettings leaves the config untouched when this SiftKit owns llama.cpp', async () => {
  resetHostLlamaSettingsCacheForTests();
  const config = makeClientConfig({
    externalServer: false,
    baseUrl: 'http://127.0.0.1:1',
    localNumCtx: 150_000,
  });

  const resolved = await applyHostLlamaRuntimeSettings(config);

  assert.equal(resolved, config);
  assert.equal(getConfiguredLlamaNumCtx(resolved), 150_000);
});

test('applyHostLlamaRuntimeSettings overlays the host SiftKit NumCtx/Reasoning/Model in pass-through mode', async () => {
  resetHostLlamaSettingsCacheForTests();
  const host = await startHostConfigServer({
    Runtime: { Model: 'host-loaded-model.gguf', LlamaCpp: { NumCtx: 75_008, Reasoning: 'off' } },
  });
  try {
    const config = makeClientConfig({
      externalServer: true,
      baseUrl: host.baseUrl,
      localNumCtx: 150_000,
    });

    const resolved = await applyHostLlamaRuntimeSettings(config);

    // The client's stale local NumCtx (150k) is replaced by the host's real 75008.
    assert.equal(getConfiguredLlamaNumCtx(resolved), 75_008);
    // The client's stale local model ('mock-model') is replaced by the host's.
    assert.equal(getConfiguredModel(resolved), 'host-loaded-model.gguf');
    // The host config is read without booting the host's managed llama.
    assert.equal(host.requestUrls.some((url) => url.includes('skip_ready=1')), true);

    // Budget math now matches the server that actually serves the request:
    // reserve drops to 10k because the host's Reasoning ('off') was synced too.
    const budget = getPlannerPromptBudget(resolved);
    assert.equal(budget.numCtxTokens, 75_008);
    assert.equal(budget.promptReserveTokens, 10_000);
    assert.equal(budget.usablePromptBudgetTokens, 65_008);
  } finally {
    await host.close();
  }
});

test('applyHostLlamaRuntimeSettings falls back to the local config when the host is not a SiftKit', async () => {
  resetHostLlamaSettingsCacheForTests();
  const host = await startHostConfigServer({}, { status: 404 });
  try {
    const config = makeClientConfig({
      externalServer: true,
      baseUrl: host.baseUrl,
      localNumCtx: 150_000,
    });

    const resolved = await applyHostLlamaRuntimeSettings(config);

    assert.equal(getConfiguredLlamaNumCtx(resolved), 150_000);
    // With no host config to read, the local model is left untouched.
    assert.equal(getConfiguredModel(resolved), 'mock-model');
  } finally {
    await host.close();
  }
});
