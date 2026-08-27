import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatSessionResponseSchema,
  ChatMessageSchema,
  ChatSessionSchema,
  ChatSessionBusyResponseSchema,
  ChatSessionOperationKindSchema,
  ImageMetadataSchema,
} from '@siftkit/contracts';

const message = {
  id: 'm1', role: 'user', kind: 'user_text', content: 'hi',
  inputTokensEstimate: 1, outputTokensEstimate: 0, thinkingTokens: 0,
  createdAtUtc: '2026-01-01T00:00:00Z', sourceRunId: null,
};

test('ChatMessageSchema accepts a minimal user message', () => {
  assert.deepEqual(ChatMessageSchema.parse(message), message);
});

test('ChatMessageSchema requires complete tool lifecycle metadata', () => {
  const toolMessage = {
    ...message,
    id: 'tool-1',
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: 'read path="src/index.ts"',
    toolCallCommand: 'read path="src/index.ts"',
    toolCallActivityKind: 'read',
    toolCallActivitySubject: { kind: 'file', value: 'index.ts' },
    toolCallTurn: 1,
    toolCallMaxTurns: 45,
    toolCallExitCode: null,
    toolCallStatus: 'running',
  };

  assert.equal(ChatMessageSchema.parse(toolMessage).kind, 'assistant_tool_call');
  assert.equal(ChatMessageSchema.safeParse({ ...toolMessage, toolCallActivityKind: undefined }).success, false);
  assert.equal(ChatMessageSchema.safeParse({ ...toolMessage, toolCallActivitySubject: undefined }).success, false);
  assert.equal(ChatMessageSchema.safeParse({ ...toolMessage, toolCallStatus: undefined }).success, false);
  assert.equal(ChatMessageSchema.safeParse({ ...toolMessage, toolCallCommand: undefined }).success, false);
});

test('ChatMessageSchema rejects messages without a kind', () => {
  const { kind: _kind, ...kindlessMessage } = message;
  assert.equal(ChatMessageSchema.safeParse(kindlessMessage).success, false);
});

test('ChatMessageSchema accepts a compaction summary row', () => {
  const summary = {
    ...message,
    id: 'm2', role: 'assistant', kind: 'compaction_summary', content: 'summary text',
    compressedIntoSummary: false,
  };
  assert.equal(ChatMessageSchema.parse(summary).kind, 'compaction_summary');
});

test('ChatSessionSchema no longer carries a condensed summary', () => {
  const parsed = ChatSessionSchema.parse({
    id: 's1', title: 't', modelPresetId: 'preset-a', model: 'model-a', contextWindowTokens: 4096,
    createdAtUtc: 'x', updatedAtUtc: 'y', messages: [message],
  });
  assert.equal('condensedSummary' in parsed, false);
});

test('ChatSessionResponseSchema requires contextUsage', () => {
  const session = {
    id: 's1', title: 't', model: null, contextWindowTokens: 4096,
    createdAtUtc: 'x', updatedAtUtc: 'y', messages: [message],
  };
  assert.throws(() => ChatSessionResponseSchema.parse({ session }));
});

test('ChatSessionSchema requires modelPresetId', () => {
  const session = {
    id: 's1', title: 't', model: 'model-a', contextWindowTokens: 4096,
    createdAtUtc: 'x', updatedAtUtc: 'y', messages: [message],
  };

  assert.throws(() => ChatSessionSchema.parse(session));
  assert.equal(
    ChatSessionSchema.parse({ ...session, modelPresetId: 'preset-a' }).modelPresetId,
    'preset-a',
  );
});

test('ChatSessionBusyResponseSchema preserves the conflicting session', () => {
  const parsed = ChatSessionBusyResponseSchema.parse({
    error: 'Chat session already has an active operation.',
    sessionId: 'session-a',
    operationKind: 'message',
  });
  assert.equal(parsed.sessionId, 'session-a');
});

test('chat session operation kinds cover every leased chat endpoint', () => {
  assert.deepEqual(
    ChatSessionOperationKindSchema.options,
    ['message', 'plan', 'repo-search', 'condense'],
  );
});

test('persisted image metadata rejects unsupported MIME values', () => {
  const result = ImageMetadataSchema.safeParse({
    width: 1,
    height: 1,
    originalWidth: 1,
    originalHeight: 1,
    mime: 'image/bmp',
    byteLength: 1,
    tokenEstimate: 1,
    resized: false,
    caption: null,
  });

  assert.equal(result.success, false);
});
