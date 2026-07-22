import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandOutputAnalyzeResultSchema, PresetRunResultSchema } from '../src/command-output/types.js';
import { requestSse } from './helpers/sse-http.js';
import { asObjectArray, requestJson } from './helpers/dashboard-http.js';
import { startHarness } from './helpers/streamed-op-harness.js';

test('command-output/analyze streams progress and a schema-valid result', async () => {
  const harness = await startHarness('siftkit-streamed-cmd-');
  try {
    const response = await requestSse(`${harness.baseUrl}/command-output/analyze`, {
      body: {
        outputKind: 'command',
        exitCode: 0,
        combinedText: 'all tests passed',
        question: 'did it pass?',
        backend: 'mock',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.result, response.rawBody);
    CommandOutputAnalyzeResultSchema.parse(response.result);
    assert.ok(response.progress.length >= 1, 'expected forwarded summary progress');
  } finally {
    await harness.close();
  }
});

test('preset/run streams a schema-valid result for a summary preset', async () => {
  const harness = await startHarness('siftkit-streamed-preset-');
  try {
    const list = await requestJson(`${harness.baseUrl}/preset/list`);
    const presets = asObjectArray(list.body.presets);
    const summaryPreset = presets.find((preset) => preset.presetKind === 'summary');
    assert.ok(summaryPreset, JSON.stringify(list.body));
    const response = await requestSse(`${harness.baseUrl}/preset/run`, {
      body: {
        presetId: String(summaryPreset.id),
        question: 'did it pass?',
        inputText: 'output text here',
        backend: 'mock',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.result, response.rawBody);
    PresetRunResultSchema.parse(response.result);
  } finally {
    await harness.close();
  }
});

test('eval/run answers over SSE with a terminal frame', async () => {
  const harness = await startHarness('siftkit-streamed-eval-');
  try {
    const response = await requestSse(`${harness.baseUrl}/eval/run`, {
      body: { RealLogPath: [], Backend: 'mock' },
      timeoutMs: 20_000,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.result !== null || response.errorMessage !== null, response.rawBody);
  } finally {
    await harness.close();
  }
});
