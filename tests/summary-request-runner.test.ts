import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { SummaryRequestRunner } from '../src/summary/request-runner.js';
import { DEFAULT_SUMMARY_PROVIDER } from '../src/summary/types.js';
import { DeadEndpointEnv } from './helpers/dead-endpoints.js';

// The deterministic path still posts terminal status; nothing here asserts on it.
const deadEndpoints = new DeadEndpointEnv();
before(() => { deadEndpoints.apply(); });
after(() => { deadEndpoints.restore(); });

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
