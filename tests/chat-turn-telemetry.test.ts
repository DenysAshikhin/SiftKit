import assert from 'node:assert/strict';
import test from 'node:test';

import { getDefaultConfigObject } from '../src/config/defaults.js';
import { ChatTurnTelemetry } from '../src/status-server/chat-turn-telemetry.js';

test('chat turn telemetry estimates input tokens when no tokenizer is configured', async () => {
  const telemetry = new ChatTurnTelemetry(getDefaultConfigObject(), undefined);

  assert.deepEqual(await telemetry.countInputTokens('12345678'), { tokenCount: 2, estimated: true });
});

test('chat turn telemetry counts blank input as exact zero', async () => {
  const telemetry = new ChatTurnTelemetry(getDefaultConfigObject(), undefined);

  assert.deepEqual(await telemetry.countInputTokens(''), { tokenCount: 0, estimated: false });
});
