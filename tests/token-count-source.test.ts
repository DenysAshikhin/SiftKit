import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countTokensWithFallbackDetailed,
  preflightPlannerPromptBudget,
} from '../src/repo-search/prompt-budget.js';
import { renderWirePrompt } from '../src/repo-search/wire-prompt.js';
import type { InferenceBackendId } from '../src/config/types.js';
import type { SiftConfig } from '../src/config/index.js';
import { withTestEnvAndServer } from './_test-helpers.js';
import { asRuntimeSiftConfig } from './helpers/mock-config.js';

const PROMPT = 'count the planner prompt tokens';
const STUB_TOKEN_COUNT = 4242;

function activateEngine(config: SiftConfig, engine: InferenceBackendId): SiftConfig {
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Stub config has no model preset to activate.');
  }
  preset.Backend = engine;
  config.Server.ModelPresets.ActivePresetId = preset.id;
  return config;
}

for (const engine of ['exl3'] as const) {
  test(`a server token count is attributed to the active ${engine} engine`, async () => {
    await withTestEnvAndServer(async ({ stub }) => {
      const config = activateEngine(asRuntimeSiftConfig(stub.state.config), engine);

      const counted = await countTokensWithFallbackDetailed(config, PROMPT);
      assert.equal(counted.tokenCount, STUB_TOKEN_COUNT);
      assert.equal(counted.source, engine);

      const preflight = await preflightPlannerPromptBudget({
        config,
        prompt: renderWirePrompt({
          messages: [{ role: 'user', content: PROMPT }],
          tools: [],
          includeReasoningContent: false,
        }),
        maxPromptTokens: 124_000,
      });
      assert.equal(preflight.promptTokenCount, STUB_TOKEN_COUNT);
      assert.equal(preflight.tokenCountSource, engine);
      assert.equal(preflight.tokenizationAttempted, true);
    }, { tokenizeTokenCount: STUB_TOKEN_COUNT });
  });
}

test('an unreachable server tokenizer falls back to the local estimate, not the engine id', async () => {
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');

    const counted = await countTokensWithFallbackDetailed(config, PROMPT);
    assert.equal(counted.source, 'estimate');
    assert.equal(counted.tokenCount > 0, true);
    assert.equal(counted.inferenceTokenCount?.status, 'http_error');

    const preflight = await preflightPlannerPromptBudget({
      config,
      prompt: renderWirePrompt({
        messages: [{ role: 'user', content: PROMPT }],
        tools: [],
        includeReasoningContent: false,
      }),
      maxPromptTokens: 124_000,
    });
    assert.equal(preflight.tokenCountSource, 'estimate');
  });
});

test('a token count taken without a config reports the estimate source', async () => {
  const counted = await countTokensWithFallbackDetailed(undefined, PROMPT);
  assert.equal(counted.source, 'estimate');
  assert.equal(counted.inferenceTokenCount, null);
});

test('a tokenizer that refuses the wire prompt falls back to the estimate source', async () => {
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');

    const preflight = await preflightPlannerPromptBudget({
      config,
      prompt: renderWirePrompt({
        messages: [{ role: 'user', content: PROMPT }],
        tools: [{ type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } }],
        includeReasoningContent: false,
      }),
      maxPromptTokens: 124_000,
    });
    assert.equal(preflight.tokenCountSource, 'estimate');
  }, {
    // The server only counts the bare prose, never the rendered wire prompt, so preflight must estimate.
    tokenizeTokenCount: (content) => (content === PROMPT ? STUB_TOKEN_COUNT : null),
  });
});
