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

// TabbyAPI reports second-based timings and draft-token counters inside `usage`
// (llama.cpp uses millisecond `timings` and no per-request draft stats). These
// end-to-end tests pin the whole propagation chain for the TabbyAPI shape:
// HTTP body -> provider/protocol usage -> scorecard/completion metrics ->
// terminal status metadata. A field dropped at any single hop fails here.
const TABBY_USAGE = {
  prompt_tokens: 123,
  prompt_tokens_details: { cached_tokens: 100 },
  prompt_time: 0.05,
  prompt_tokens_per_sec: 460,
  completion_tokens: 45,
  completion_time: 0.25,
  completion_tokens_per_sec: 180,
  total_tokens: 168,
  total_time: 0.3,
  draft_accepted_tokens: 36,
  draft_rejected_tokens: 9,
};

const EXPECTED_PROMPT_EVAL_DURATION_MS = 50;
const EXPECTED_GENERATION_DURATION_MS = 250;
const EXPECTED_SPECULATIVE_ACCEPTED_TOKENS = 36;
const EXPECTED_SPECULATIVE_GENERATED_TOKENS = 45;

test('repo-search carries TabbyAPI draft stats and second-based timings into the scorecard and terminal status', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await executeRepoSearchRequest({
        prompt: 'find planner usage',
        repoRoot: process.cwd(),
        statusBackendUrl: server.statusUrl,
        config: {
          ...server.state.config,
          Runtime: {
            ...server.state.config.Runtime,
            LlamaCpp: {
              ...server.state.config.Runtime.LlamaCpp,
              BaseUrl: `http://127.0.0.1:${server.port}`,
              NumCtx: 128000,
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

      await waitForAsyncExpectation(async () => {
        assert.ok(server.state.statusPosts.some((post) => post.running === false && post.taskKind === 'repo-search'));
      }, 1000);
      const completionPost = server.state.statusPosts.filter(
        (post) => post.running === false && post.taskKind === 'repo-search',
      ).at(-1);
      assert.ok(completionPost);
      assert.equal(completionPost.speculativeAcceptedTokens, EXPECTED_SPECULATIVE_ACCEPTED_TOKENS);
      assert.equal(completionPost.speculativeGeneratedTokens, EXPECTED_SPECULATIVE_GENERATED_TOKENS);
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

test('summary carries TabbyAPI draft stats into terminal status metadata', async () => {
  await withTempEnv(async () => {
    await withStubServer(async (server) => {
      const result = await summarizeRequest({
        question: 'summarize this',
        inputText: 'A'.repeat(5000),
        format: 'text',
        policyProfile: 'general',
        backend: 'llama.cpp',
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
