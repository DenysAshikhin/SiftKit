import { IsolatedRuntime } from './helpers/isolated-runtime.js';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { ModelRuntimePresetSchema } from '@siftkit/contracts';
import { SummaryRequestRunner } from '../src/summary/request-runner.js';
import { DEFAULT_SUMMARY_PROVIDER } from '../src/summary/types.js';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.js';
import { DeadEndpointEnv } from './helpers/dead-endpoints.js';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.js';

// The deterministic path still posts terminal status; nothing here asserts on it.
const isolatedRuntime = new IsolatedRuntime();
const deadEndpoints = new DeadEndpointEnv();
before(() => { isolatedRuntime.start(); deadEndpoints.apply(); });
after(async () => { await isolatedRuntime.close(); deadEndpoints.restore(); });

test('SummaryRequestRunner accepts an image-only request', async () => {
  const defaultPreset = mockModelPreset();
  const visionPreset = ModelRuntimePresetSchema.parse({
    ...defaultPreset,
    Backend: 'exl3',
    VisionEnabled: true,
    VisionImageRetention: -1,
  });

  const result = await new SummaryRequestRunner({
    repoRoot: process.cwd(),
    question: 'what is in the image?',
    inputText: '',
    images: [toDataUrl('image/png', rasterBuffer('png', 1, 1))],
    format: 'text',
    policyProfile: 'general',
    provider: 'mock',
    config: mockSiftConfig({
      Server: {
        ModelPresets: { Presets: [visionPreset], ActivePresetId: visionPreset.id },
      },
    }),
  }).run();

  assert.equal(result.Provider, 'mock');
});

test('SummaryRequestRunner still rejects an empty request without images', async () => {
  await assert.rejects(
    () => new SummaryRequestRunner({
      repoRoot: process.cwd(),
      question: 'what is this?',
      inputText: '',
      format: 'text',
      policyProfile: 'general',
      provider: 'mock',
    }).run(),
    /Provide --text, --file, or pipe input into siftkit\./u,
  );
});

test('SummaryRequestRunner handles deterministic command-output summaries without model config', async () => {
  const result = await new SummaryRequestRunner({
      repoRoot: process.cwd(),
    question: 'Determine whether the targeted Jest run passes. Return pass/fail and warnings/errors.',
    inputText: [
      'PASS tests/example.test.ts',
      'Test Suites: 1 passed, 1 total',
      'Tests:       7 passed, 7 total',
      'Time:        18.234 s',
    ].join('\n'),
    format: 'text',
    policyProfile: 'general',
    sourceKind: 'command-output',
    commandExitCode: 0,
  }).run();

  assert.equal(result.PolicyDecision, 'deterministic-test-output');
  assert.equal(result.Classification, 'summary');
  assert.equal(result.RawReviewRequired, false);
  assert.equal(result.ModelCallSucceeded, true);
  assert.equal(result.Provider, DEFAULT_SUMMARY_PROVIDER);
});

test('SummaryRequestRunner reports the requested provider on the deterministic path', async () => {
  const result = await new SummaryRequestRunner({
      repoRoot: process.cwd(),
    question: 'Determine whether the targeted Jest run passes. Return pass/fail and warnings/errors.',
    inputText: [
      'FAIL tests/example.test.ts',
      'Test Suites: 1 failed, 1 total',
      'Tests:       2 failed, 5 passed, 7 total',
      'Time:        18.234 s',
    ].join('\n'),
    format: 'text',
    policyProfile: 'general',
    sourceKind: 'command-output',
    commandExitCode: 1,
    provider: 'mock',
  }).run();

  assert.equal(result.PolicyDecision, 'deterministic-test-output');
  assert.equal(result.Provider, 'mock');
});
