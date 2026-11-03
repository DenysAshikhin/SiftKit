import { IsolatedRuntime } from './helpers/isolated-runtime.ts';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { ModelRuntimePresetSchema } from '@siftkit/contracts';
import { SummaryRequestRunner } from '../src/summary/request-runner.ts';
import { DEFAULT_SUMMARY_PROVIDER } from '../src/summary/types.ts';
import { mockModelPreset, mockSiftConfig } from './helpers/mock-config.ts';
import { DeadEndpointEnv } from './helpers/dead-endpoints.ts';
import { rasterBuffer, toDataUrl } from './helpers/image-fixtures.ts';
import { readDigestFixture } from './helpers/output-digest-fixtures.ts';

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

for (const [fixture, failure] of [
  ['pytest/fail.txt', '✖ test_compares_lists — test_math.py:4'],
  ['dotnet-test/fail.txt', '✖ MathTests.UnitTest1.Compares — C:\\tmp\\rsx\\output-digest-capture\\dotnet\\MathTests\\UnitTest1.cs:9'],
] as const) {
  test(`SummaryRequestRunner answers a pass/fail question about ${fixture} from its digest, with no model call`, async () => {
    const result = await new SummaryRequestRunner({
      repoRoot: process.cwd(),
      question: 'Did the test run pass? Return pass/fail and the failing tests.',
      inputText: readDigestFixture(fixture),
      format: 'text', policyProfile: 'general', sourceKind: 'command-output', commandExitCode: 1,
    }).run();
    assert.equal(result.PolicyDecision, 'deterministic-test-output');
    assert.equal(result.Classification, 'command_failure');
    assert.match(result.Summary, /^FAIL: Digest of the whole output:\n/u);
    assert.ok(result.Summary.includes(failure), result.Summary);
  });
}

test('SummaryRequestRunner fails a pass/fail answer on a non-zero exit even when every recognised tool passed', async () => {
  const result = await new SummaryRequestRunner({
    repoRoot: process.cwd(),
    question: 'Did the test run pass? Return pass/fail.',
    inputText: readDigestFixture('jest/pass.txt'),
    format: 'text', policyProfile: 'general', sourceKind: 'command-output', commandExitCode: 1,
  }).run();
  assert.equal(result.Classification, 'command_failure');
  assert.match(result.Summary, /^FAIL: Digest of the whole output:\njest: passed \(3 tests, 1 skipped, 2 passed\)$/u);
});
