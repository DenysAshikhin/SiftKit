import test from 'node:test';
import assert from 'node:assert/strict';

import { executeRepoSearchRequest } from '../src/repo-search/index.js';
import type { JsonObject } from '../src/lib/json-types.js';
import {
  summarizeRequest,
  buildStructuredStubDecision,
  withTempEnv,
  withStubServer,
  waitForAsyncExpectation,
} from './_runtime-helpers.js';
import { asObject } from './helpers/dashboard-http.js';
import { buildTabbyUsage } from './helpers/streaming-client.js';
import { readTabbyThroughput } from '../src/lib/inference-throughput.js';
import { InferenceThroughputSchema } from '@siftkit/contracts';

// TabbyAPI reports second-based timings and draft-token counters inside `usage`
// Some OpenAI-compatible engines use millisecond `timings` and no per-request draft stats. These
// end-to-end tests pin the whole propagation chain for the TabbyAPI shape:
// HTTP body -> provider/protocol usage -> scorecard/completion metrics ->
// terminal status metadata. A field dropped at any single hop fails here.
const TABBY_USAGE = {
  prompt_tokens: 123,
  prompt_tokens_details: { cached_tokens: 100 },
  prompt_time: 0.05,
  prompt_tokens_per_sec: 460,
  completion_tokens: 45,
  completion_tokens_details: {
    accepted_prediction_tokens: 36,
    rejected_prediction_tokens: 9,
  },
  completion_time: 0.25,
  completion_tokens_per_sec: 180,
  total_tokens: 168,
  total_time: 0.3,
};

const EXPECTED_PROMPT_EVAL_DURATION_MS = 50;
const EXPECTED_GENERATION_DURATION_MS = 250;
const EXPECTED_SPECULATIVE_ACCEPTED_TOKENS = 36;
const EXPECTED_SPECULATIVE_GENERATED_TOKENS = 45;

test('repo-search carries TabbyAPI draft stats and second-based timings into the scorecard and terminal status', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await executeRepoSearchRequest({
      presetId: 'repo-search',
        prompt: 'find planner usage',
        repoRoot: process.cwd(),
        statusBackendUrl: server.statusUrl,
        config: {
          ...server.state.config,
          Server: {
            ...server.state.config.Server,
            ModelPresets: {
              ...server.state.config.Server.ModelPresets,
              Presets: server.state.config.Server.ModelPresets.Presets.map((preset) => ({
                ...preset,
                BaseUrl: `http://127.0.0.1:${server.port}`,
                NumCtx: 128000,
              })),
            },
            },
        },
        model: 'mock-model',
        maxTurns: 1,
      });

      assert.equal(result.scorecard.verdict, 'pass');
      assert.equal(result.scorecard.totals.promptEvalDurationMs, EXPECTED_PROMPT_EVAL_DURATION_MS);
      assert.equal(result.scorecard.totals.generationDurationMs, EXPECTED_GENERATION_DURATION_MS);
      assert.equal(result.scorecard.totals.speculativeAcceptedTokens, EXPECTED_SPECULATIVE_ACCEPTED_TOKENS);
      assert.equal(result.scorecard.totals.speculativeGeneratedTokens, EXPECTED_SPECULATIVE_GENERATED_TOKENS);
      // The canonical fold keeps the backend's own counts and times: 23 newly processed prompt
      // tokens in 50 ms and 45 emitted tokens in 250 ms, from exactly one request.
      assert.equal(result.scorecard.throughput.pp.tokenCount, 23);
      assert.equal(result.scorecard.throughput.pp.durationMs, EXPECTED_PROMPT_EVAL_DURATION_MS);
      assert.equal(result.scorecard.throughput.decode.tokenCount, 45);
      assert.equal(result.scorecard.throughput.decode.durationMs, EXPECTED_GENERATION_DURATION_MS);
      assert.equal(result.scorecard.throughput.decode.requestCount, 1);

      await waitForAsyncExpectation(async () => {
        assert.ok(server.state.statusPosts.some((post) => post.running === false && post.taskKind === 'repo-search'));
      }, 1000);
      const completionPost = server.state.statusPosts.filter(
        (post) => post.running === false && post.taskKind === 'repo-search',
      ).at(-1);
      assert.ok(completionPost);
      assert.equal(completionPost.speculativeAcceptedTokens, EXPECTED_SPECULATIVE_ACCEPTED_TOKENS);
      assert.equal(completionPost.speculativeGeneratedTokens, EXPECTED_SPECULATIVE_GENERATED_TOKENS);
      assert.deepEqual(completionPost.throughput, result.scorecard.throughput);
      assert.equal(completionPost.promptEvalDurationMs, EXPECTED_PROMPT_EVAL_DURATION_MS);
      assert.equal(completionPost.generationDurationMs, EXPECTED_GENERATION_DURATION_MS);
    }, {
      tokenizeCharsPerToken: 4,
      assistantContent: '{"action":"finish","output":"done"}',
      chatResponse() {
        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '{"action":"finish","output":"done"}' },
          }],
          usage: TABBY_USAGE,
        };
      },
    });
  });
});

test('a tool-call-only turn contributes its emitted tokens to the run throughput', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await executeRepoSearchRequest({
        presetId: 'repo-search',
        prompt: 'read the manifest',
        repoRoot: process.cwd(),
        statusBackendUrl: server.statusUrl,
        config: {
          ...server.state.config,
          Server: {
            ...server.state.config.Server,
            ModelPresets: {
              ...server.state.config.Server.ModelPresets,
              Presets: server.state.config.Server.ModelPresets.Presets.map((preset) => ({
                ...preset,
                BaseUrl: `http://127.0.0.1:${server.port}`,
                NumCtx: 128000,
              })),
            },
          },
        },
        model: 'mock-model',
        maxTurns: 2,
      });

      assert.equal(result.scorecard.verdict, 'pass');
      // Turn one emitted only tool-call markup, turn two the answer: both are backend-emitted
      // tokens, so the run fold counts 600 tokens over two requests and not just the narration.
      assert.equal(result.scorecard.throughput.decode.requestCount, 2);
      assert.equal(result.scorecard.throughput.decode.tokenCount, 600);
      assert.equal(result.scorecard.throughput.decode.durationMs, 3_000);
      assert.equal(result.scorecard.throughput.decode.missingTabbyRequests, 0);
    }, {
      tokenizeCharsPerToken: 4,
      chatResponse(_promptText, _parsed, requestIndex) {
        const usage = buildTabbyUsage({ promptTokens: 40, completionTokens: 300, completionTime: 1.5 });
        const message: JsonObject = requestIndex === 1
          ? {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_read_1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"package.json"}' },
            }],
          }
          : { role: 'assistant', content: '{"action":"finish","output":"done"}' };
        return { id: 'chatcmpl-test', object: 'chat.completion', choices: [{ index: 0, message }], usage };
      },
    });
  });
});

test('summary carries TabbyAPI draft stats into terminal status metadata', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
      repoRoot: process.cwd(),
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        provider: 'real',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      const isSummaryCompletionPost = (post: JsonObject): boolean => (
        post.running === false && post.taskKind === 'summary' && post.terminalState === 'completed'
      );
      await waitForAsyncExpectation(async () => {
        assert.ok(server.state.statusPosts.some(isSummaryCompletionPost));
      }, 2000);
      const completionPost = server.state.statusPosts.slice().reverse().find(isSummaryCompletionPost);
      assert.ok(completionPost);
      const deferredMetadata = asObject(completionPost.deferredMetadata);
      assert.equal(deferredMetadata.speculativeAcceptedTokens, EXPECTED_SPECULATIVE_ACCEPTED_TOKENS);
      assert.equal(deferredMetadata.speculativeGeneratedTokens, EXPECTED_SPECULATIVE_GENERATED_TOKENS);
      assert.equal(deferredMetadata.promptEvalDurationMs, EXPECTED_PROMPT_EVAL_DURATION_MS);
      assert.equal(deferredMetadata.generationDurationMs, EXPECTED_GENERATION_DURATION_MS);
      // One physical request: the operation fold is exactly that request's observation.
      assert.deepEqual(deferredMetadata.throughput, readTabbyThroughput({ usage: TABBY_USAGE }));
    }, {
      chatResponse(promptText) {
        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify(buildStructuredStubDecision(String(promptText))),
            },
          }],
          usage: TABBY_USAGE,
        };
      },
    });
  });
});

test('a summary retried after an empty decision folds both physical requests', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
        repoRoot: process.cwd(),
        question: 'summarize this',
        inputText: 'B'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        provider: 'real',
        model: 'mock-model',
      });

      assert.equal(result.WasSummarized, true);
      const isSummaryCompletionPost = (post: JsonObject): boolean => (
        post.running === false && post.taskKind === 'summary' && post.terminalState === 'completed'
      );
      await waitForAsyncExpectation(async () => {
        assert.ok(server.state.statusPosts.some(isSummaryCompletionPost));
      }, 2000);
      const completionPost = server.state.statusPosts.slice().reverse().find(isSummaryCompletionPost);
      assert.ok(completionPost);
      const throughput = InferenceThroughputSchema.parse(asObject(completionPost.deferredMetadata).throughput);
      // The first attempt returned an empty decision and was retried; the backend still decoded it.
      assert.equal(server.state.chatRequests.length, 2);
      assert.equal(throughput.decode.requestCount, 2);
      assert.equal(throughput.decode.tokenCount, 40);
      assert.equal(throughput.decode.missingTabbyRequests, 0);
      assert.equal(throughput.pp.requestCount, 2);
    }, {
      chatResponse(promptText, _parsed, requestIndex) {
        const content = requestIndex === 1
          ? JSON.stringify({ classification: 'summary', raw_review_required: false, output: '' })
          : JSON.stringify(buildStructuredStubDecision(String(promptText)));
        return {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content } }],
          usage: buildTabbyUsage({ promptTokens: 100, completionTokens: 20 }),
        };
      },
    });
  });
});
