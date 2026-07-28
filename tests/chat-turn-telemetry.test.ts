import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getActiveModelPreset } from '../src/config/index.js';
import { ChatTurnTelemetry } from '../src/status-server/chat-turn-telemetry.js';
import type { ChatSession } from '../src/state/chat-sessions.js';

function createSession(): ChatSession {
  return {
    id: 'telemetry-session',
    modelPresetId: 'default',
    thinkingEnabled: true,
  };
}

test('chat turn telemetry counts input and thinking with one explicit policy owner', async () => {
  const config = getDefaultConfigObject();
  const telemetry = new ChatTurnTelemetry(config, undefined);
  const input = await telemetry.countInputTokens('12345678');
  const turns = await telemetry.countThinkingTokens([
    { thinkingText: '12345678', toolMessages: [] },
    { thinkingText: '   ', toolMessages: [] },
  ]);

  assert.deepEqual(input, { tokenCount: 2, estimated: true });
  assert.deepEqual(turns, [
    {
      thinkingText: '12345678',
      thinkingTokens: 2,
      thinkingTokensEstimated: true,
      toolMessages: [],
    },
    { thinkingText: '   ', toolMessages: [] },
  ]);
});

test('chat turn telemetry requires session thinking and active reasoning retention', () => {
  const config = getDefaultConfigObject();
  const preset = getActiveModelPreset(config);
  preset.Reasoning = 'on';
  preset.MaintainPerStepThinking = true;
  const telemetry = new ChatTurnTelemetry(config, undefined);
  const session = createSession();

  assert.equal(telemetry.shouldMaintainPerStepThinking(session), true);
  assert.equal(
    telemetry.shouldMaintainPerStepThinking({ ...session, thinkingEnabled: false }),
    false,
  );

  preset.Reasoning = 'off';
  assert.equal(telemetry.shouldMaintainPerStepThinking(session), false);

  preset.Reasoning = 'on';
  preset.MaintainPerStepThinking = false;
  assert.equal(telemetry.shouldMaintainPerStepThinking(session), false);
});
