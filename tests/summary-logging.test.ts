// @ts-nocheck - Uses shared CommonJS runtime test helpers.
const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeRequest } = require('../dist/summary.js');
const {
  captureStdout,
  withStubServer,
  withTempEnv,
} = require('./_runtime-helpers.js');

test('summary logs preflight tokenization timing source and retry count', async () => {
  await withTempEnv(async () => {
    await withStubServer(async () => {
      const lines = await captureStdout(async () => {
        await summarizeRequest({
          question: 'summarize this',
          inputText: 'A'.repeat(5_000),
          format: 'text',
          policyProfile: 'general',
          backend: 'llama.cpp',
          model: 'mock-model',
        });
      });

      assert.ok(
        lines.some((line) => /summary preflight_tokenize_start request_id=.* phase=leaf chunk=undefined\/undefined prompt_chars=\d+ timeout_ms=10000 retry_max_wait_ms=30000/u.test(line)),
        lines.join('\n'),
      );
      assert.ok(
        lines.some((line) => /summary preflight_tokenize_done request_id=.* phase=leaf chunk=undefined\/undefined prompt_tokens=456 source=llama\.cpp elapsed_ms=\d+ retry_count=0/u.test(line)),
        lines.join('\n'),
      );
    }, {
      tokenizeTokenCount: () => 456,
      metrics: {
        inputCharactersTotal: 3_461_904,
        inputTokensTotal: 1_865_267,
        outputCharactersTotal: 0,
        outputTokensTotal: 0,
        thinkingTokensTotal: 0,
        completedRequestCount: 0,
        requestDurationMsTotal: 0,
      },
    });
  });
});
