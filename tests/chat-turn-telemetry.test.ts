import assert from 'node:assert/strict';
import test from 'node:test';

import { countChatInputTokens } from '../src/status-server/chat-turn-telemetry.js';

test('chat turn telemetry estimates input tokens when no tokenizer is configured', async () => {
  assert.deepEqual(await countChatInputTokens(undefined, '12345678'), { tokenCount: 2, estimated: true });
});

test('chat turn telemetry counts blank input as exact zero', async () => {
  assert.deepEqual(await countChatInputTokens(undefined, ''), { tokenCount: 0, estimated: false });
});
