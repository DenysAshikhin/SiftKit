import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionResponseSchema, ChatMessageSchema } from '@siftkit/contracts';

const message = {
  id: 'm1', role: 'user', content: 'hi',
  inputTokensEstimate: 1, outputTokensEstimate: 0, thinkingTokens: 0,
  createdAtUtc: '2026-01-01T00:00:00Z', sourceRunId: null,
};

test('ChatMessageSchema accepts a minimal user message', () => {
  assert.deepEqual(ChatMessageSchema.parse(message), message);
});

test('ChatSessionResponseSchema requires contextUsage', () => {
  const session = {
    id: 's1', title: 't', model: null, contextWindowTokens: 4096,
    condensedSummary: '', createdAtUtc: 'x', updatedAtUtc: 'y', messages: [message],
  };
  assert.throws(() => ChatSessionResponseSchema.parse({ session }));
});
