import test from 'node:test';
import assert from 'node:assert/strict';

import { IncrementalTokenCounter } from '../src/repo-search/incremental-token-counter.js';
import {
  EXACT_RECOUNT_MARGIN_TOKENS,
  preflightPlannerPromptBudget,
} from '../src/repo-search/prompt-budget.js';
import type { InferenceBackendId } from '../src/config/types.js';
import type { SiftConfig } from '../src/config/index.js';
import { renderWirePrompt } from '../src/repo-search/wire-prompt.js';
import type { ChatMessage } from '../src/repo-search/planner-protocol.js';
import type { LlamaCppToolDefinition } from '../src/llm-protocol/types.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { asRuntimeSiftConfig } from './helpers/mock-config.js';

function activateEngine(config: SiftConfig, engine: InferenceBackendId): SiftConfig {
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Stub config has no model preset to activate.');
  }
  preset.Backend = engine;
  config.Server.ModelPresets.ActivePresetId = preset.id;
  return config;
}

// The stub counts tokens as content.length so full-vs-delta requests are
// distinguishable by both the recorded content and the returned count.
function trackingTokenizer(seen: string[]): (content: string) => number {
  return (content) => {
    seen.push(content);
    return content.length;
  };
}

test('first count tokenizes the full text', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    const result = await counter.count(config, 'alpha beta');
    assert.equal(result.tokenCount, 'alpha beta'.length);
    assert.equal(result.source, 'exl3');
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an appended tail tokenizes only the delta and sums with the cache', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta gamma');
    assert.equal(result.tokenCount, 'alpha beta gamma'.length);
    assert.equal(result.approximate, true);
    assert.deepEqual(seen, ['alpha beta', ' gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an identical text returns the cached count without tokenizing', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta');
    assert.equal(result.tokenCount, 'alpha beta'.length);
    assert.equal(result.llamaTokenCount, null);
    assert.deepEqual(seen, ['alpha beta']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('a changed prefix forces a full re-tokenize', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'ALPHA beta gamma');
    assert.equal(result.tokenCount, 'ALPHA beta gamma'.length);
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta', 'ALPHA beta gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('forceExact re-tokenizes the full text even for a pure append', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    const result = await counter.count(config, 'alpha beta gamma', { forceExact: true });
    assert.equal(result.tokenCount, 'alpha beta gamma'.length);
    assert.equal(result.approximate, false);
    assert.deepEqual(seen, ['alpha beta', 'alpha beta gamma']);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an estimate fallback never updates the cache', async () => {
  const seen: string[] = [];
  let serverUp = true;
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    await counter.count(config, 'alpha beta');
    serverUp = false;
    const estimated = await counter.count(config, 'alpha beta gamma');
    assert.equal(estimated.source, 'estimate');
    assert.equal(estimated.approximate, true);

    serverUp = true;
    // The cache still holds 'alpha beta', so this is a delta from that prefix.
    const recovered = await counter.count(config, 'alpha beta gamma delta');
    assert.equal(recovered.tokenCount, 'alpha beta gamma delta'.length);
    assert.deepEqual(seen, ['alpha beta', ' gamma delta']);
  }, {
    tokenizeTokenCount: (content) => {
      if (!serverUp) {
        return null;
      }
      seen.push(content);
      return content.length;
    },
  });
});

test('no config uses the estimate without caching', async () => {
  const counter = new IncrementalTokenCounter();
  const result = await counter.count(undefined, 'alpha beta');
  assert.equal(result.source, 'estimate');
  assert.equal(result.approximate, false);
  assert.equal(result.tokenCount > 0, true);
});

const GREP_TOOL = {
  type: 'function',
  function: { name: 'grep', description: 'search the repository', parameters: { type: 'object' } },
} satisfies LlamaCppToolDefinition;

const PREFLIGHT_BUDGET = { totalContextTokens: 9_000, responseReserveTokens: 1_000 };

test('preflight counts tool schemas as part of the prompt', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const messages: ChatMessage[] = [{ role: 'user', content: 'turn one' }];

    const withoutTools = await preflightPlannerPromptBudget({
      config,
      messages,
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: new IncrementalTokenCounter(),
    });

    const withTools = await preflightPlannerPromptBudget({
      config,
      messages,
      includeReasoningContent: false,
      tools: [GREP_TOOL],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: new IncrementalTokenCounter(),
    });

    assert.ok(
      withTools.promptTokenCount > withoutTools.promptTokenCount,
      `tool schemas must raise the counted prompt: ${withTools.promptTokenCount} vs ${withoutTools.promptTokenCount}`,
    );
    assert.equal(withTools.promptChars > withoutTools.promptChars, true);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('preflight tokenizes only the appended tail across turns', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const counter = new IncrementalTokenCounter();

    const first = await preflightPlannerPromptBudget({
      config,
      messages: [{ role: 'user', content: 'turn one' }] satisfies ChatMessage[],
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: counter,
    });

    const second = await preflightPlannerPromptBudget({
      config,
      messages: [{ role: 'user', content: 'turn one' }, { role: 'assistant', content: 'turn two' }] satisfies ChatMessage[],
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      ...PREFLIGHT_BUDGET,
      promptTokenCounter: counter,
    });

    assert.ok(second.promptTokenCount > first.promptTokenCount);
    assert.equal(seen.length, 2, 'the second turn must tokenize a tail, not the whole prompt');
    assert.ok(seen[1].length < seen[0].length, 'the second tokenize call must be the shorter tail');
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('a delta-derived count near the budget forces one exact recount', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const promptTokenCounter = new IncrementalTokenCounter();

    const base = 'a'.repeat(500);
    const tail = 'b'.repeat(600);
    const firstMessages: ChatMessage[] = [{ role: 'user', content: base }];
    const secondMessages: ChatMessage[] = [...firstMessages, { role: 'assistant', content: tail }];
    const firstText = renderWirePrompt({ messages: firstMessages, tools: [], responseFormat: null, includeReasoningContent: false });
    const secondText = renderWirePrompt({ messages: secondMessages, tools: [], responseFormat: null, includeReasoningContent: false });
    // maxPromptBudget = 3000; threshold = 3000 - EXACT_RECOUNT_MARGIN_TOKENS = 952.
    // The delta-derived count (~1160) crosses it, so preflight must recount fully.
    assert.equal(3000 - EXACT_RECOUNT_MARGIN_TOKENS, 952);

    await preflightPlannerPromptBudget({
      config,
      messages: firstMessages,
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      totalContextTokens: 3000,
      responseReserveTokens: 0,
      promptTokenCounter,
    });
    const second = await preflightPlannerPromptBudget({
      config,
      messages: secondMessages,
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      totalContextTokens: 3000,
      responseReserveTokens: 0,
      promptTokenCounter,
    });
    assert.equal(second.promptTokenCount, secondText.length);
    assert.deepEqual(seen, [firstText, secondText.slice(firstText.length), secondText]);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('preflight without counters keeps the one-shot behavior', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const firstMessages: ChatMessage[] = [{ role: 'user', content: 'turn one' }];
    const secondMessages: ChatMessage[] = [...firstMessages, { role: 'assistant', content: 'turn two' }];
    const firstText = renderWirePrompt({ messages: firstMessages, tools: [], responseFormat: null, includeReasoningContent: false });
    const secondText = renderWirePrompt({ messages: secondMessages, tools: [], responseFormat: null, includeReasoningContent: false });
    await preflightPlannerPromptBudget({
      config,
      messages: firstMessages,
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      totalContextTokens: 128_000,
      responseReserveTokens: 4_000,
    });
    await preflightPlannerPromptBudget({
      config,
      messages: secondMessages,
      includeReasoningContent: false,
      tools: [],
      responseFormat: null,
      totalContextTokens: 128_000,
      responseReserveTokens: 4_000,
    });
    assert.deepEqual(seen, [firstText, secondText]);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});
