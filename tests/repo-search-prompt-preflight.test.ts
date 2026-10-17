import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIRE_SEGMENT_DRIFT_TOKENS,
  preflightPlannerPromptBudget,
} from '../src/repo-search/prompt-budget.ts';
import { PromptTokenCounter } from '../src/providers/prompt-token-counter.ts';
import type { InferenceBackendId } from '../src/config/types.ts';
import type { SiftConfig } from '../src/config/index.ts';
import { renderWirePrompt, type WirePrompt } from '../src/repo-search/wire-prompt.ts';
import type { ChatMessage } from '../src/repo-search/planner-chat-message.ts';
import type { InferenceToolDefinition } from '../src/llm-protocol/types.ts';
import { withTestEnvAndServer } from './_test-helpers.ts';
import { asRuntimeSiftConfig } from './helpers/mock-config.ts';

function activateEngine(config: SiftConfig, engine: InferenceBackendId): SiftConfig {
  const preset = config.Server.ModelPresets.Presets[0];
  if (!preset) {
    throw new Error('Stub config has no model preset to activate.');
  }
  preset.Backend = engine;
  config.Server.ModelPresets.ActivePresetId = preset.id;
  return config;
}

// The stub counts tokens as content.length so whole-prompt and tail requests are
// distinguishable by both the recorded content and the returned count.
function trackingTokenizer(seen: string[]): (content: string) => number {
  return (content) => {
    seen.push(content);
    return content.length;
  };
}

function wire(messages: ChatMessage[], tools: InferenceToolDefinition[] = []): WirePrompt {
  return renderWirePrompt({ messages, tools, includeReasoningContent: false });
}

const GREP_TOOL = {
  type: 'function',
  function: { name: 'grep', description: 'search the repository', parameters: { type: 'object' } },
} satisfies InferenceToolDefinition;

const TURN_ONE: ChatMessage[] = [{ role: 'user', content: 'turn one' }];
const TURN_TWO: ChatMessage[] = [...TURN_ONE, { role: 'assistant', content: 'turn two' }];

test('preflight counts tool schemas as part of the prompt', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');

    const withoutTools = await preflightPlannerPromptBudget({ config, prompt: wire(TURN_ONE), maxPromptTokens: 8_000 });
    const withTools = await preflightPlannerPromptBudget({ config, prompt: wire(TURN_ONE, [GREP_TOOL]), maxPromptTokens: 8_000 });

    assert.ok(withTools.promptTokenCount > withoutTools.promptTokenCount);
    assert.equal(withTools.promptChars > withoutTools.promptChars, true);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('preflight tokenizes only the appended message blocks across turns', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const promptTokenCounter = new PromptTokenCounter();
    const first = wire(TURN_ONE);
    const second = wire(TURN_TWO);

    await preflightPlannerPromptBudget({ config, prompt: first, maxPromptTokens: 8_000, promptTokenCounter });
    const counted = await preflightPlannerPromptBudget({ config, prompt: second, maxPromptTokens: 8_000, promptTokenCounter });

    assert.deepEqual(seen, [first.text, second.segments[1]]);
    assert.equal(counted.promptTokenCount, second.text.length);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('a reused count whose drift could reach the prompt limit is recounted exactly', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const promptTokenCounter = new PromptTokenCounter();
    const first = wire(TURN_ONE);
    const second = wire(TURN_TWO);
    const maxPromptTokens = second.text.length + WIRE_SEGMENT_DRIFT_TOKENS;

    await preflightPlannerPromptBudget({ config, prompt: first, maxPromptTokens, promptTokenCounter });
    const counted = await preflightPlannerPromptBudget({ config, prompt: second, maxPromptTokens, promptTokenCounter });

    assert.deepEqual(seen, [first.text, second.segments[1], second.text]);
    assert.equal(counted.ok, true);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('a reused count clear of the prompt limit by its drift is kept', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const promptTokenCounter = new PromptTokenCounter();
    const maxPromptTokens = wire(TURN_TWO).text.length + WIRE_SEGMENT_DRIFT_TOKENS + 1;

    await preflightPlannerPromptBudget({ config, prompt: wire(TURN_ONE), maxPromptTokens, promptTokenCounter });
    await preflightPlannerPromptBudget({ config, prompt: wire(TURN_TWO), maxPromptTokens, promptTokenCounter });

    assert.equal(seen.length, 2);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('preflight without a counter counts each prompt whole', async () => {
  const seen: string[] = [];
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');

    await preflightPlannerPromptBudget({ config, prompt: wire(TURN_ONE), maxPromptTokens: 124_000 });
    await preflightPlannerPromptBudget({ config, prompt: wire(TURN_TWO), maxPromptTokens: 124_000 });

    assert.deepEqual(seen, [wire(TURN_ONE).text, wire(TURN_TWO).text]);
  }, { tokenizeTokenCount: trackingTokenizer(seen) });
});

test('an unreachable tokenizer falls back to the estimate and keeps the last good count', async () => {
  const seen: string[] = [];
  let available = true;
  await withTestEnvAndServer(async ({ stub }) => {
    const config = activateEngine(asRuntimeSiftConfig(stub.state.config), 'exl3');
    const promptTokenCounter = new PromptTokenCounter();
    const third = wire([...TURN_TWO, { role: 'user', content: 'turn three' }]);

    await preflightPlannerPromptBudget({ config, prompt: wire(TURN_ONE), maxPromptTokens: 8_000, promptTokenCounter });
    available = false;
    const estimated = await preflightPlannerPromptBudget({ config, prompt: wire(TURN_TWO), maxPromptTokens: 8_000, promptTokenCounter });
    available = true;
    await preflightPlannerPromptBudget({ config, prompt: third, maxPromptTokens: 8_000, promptTokenCounter });

    assert.equal(estimated.tokenCountSource, 'estimate');
    assert.equal(estimated.tokenizationAttempted, true);
    assert.equal(seen.at(-1), third.segments.slice(1).join(''));
  }, {
    tokenizeTokenCount: (content) => {
      seen.push(content);
      return available ? content.length : null;
    },
  });
});
