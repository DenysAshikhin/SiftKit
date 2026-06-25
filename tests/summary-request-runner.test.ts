import assert from 'node:assert/strict';
import test from 'node:test';

import { SummaryRequestRunner } from '../src/summary/request-runner.js';

test('SummaryRequestRunner handles deterministic command-output summaries without model config', async () => {
  const result = await new SummaryRequestRunner({
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
});
