import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatTranscriptMessageSchema,
  ChatSessionResponseSchema,
  PersistedChatTranscriptMessageSchema,
  ReplayableChatMessageSchema,
  ChatSessionSchema,
  ChatSessionBusyResponseSchema,
  ChatSessionOperationKindSchema,
  ImageMetadataSchema,
  isDisplayOnlyImageMessage,
  sumContextImageTokens,
} from '@siftkit/contracts';

const NO_SESSION_THROUGHPUT = { promptTokensPerSecond: null, generationTokensPerSecond: null };

const message = {
  id: 'm1', role: 'user', kind: 'user_text', content: 'hi',
  inputTokensEstimate: 1, outputTokensEstimate: 0, thinkingTokens: 0,
  createdAtUtc: '2026-01-01T00:00:00Z', sourceRunId: null,
};

const SESSION_FIXTURE = {
  id: 's1', title: 't', modelPresetId: 'preset-a', modelPresetOverrideId: null,
  defaultModelPreset: { id: 'preset-a', label: 'Preset A' }, model: 'model-a', contextWindowTokens: 4096,
  planRepoRoot: 'C:/repo', orchestratorRunId: null, createdAtUtc: 'x', updatedAtUtc: 'y', messages: [message], sessionThroughput: NO_SESSION_THROUGHPUT,
};

test('PersistedChatTranscriptMessageSchema accepts a minimal user message', () => {
  assert.deepEqual(PersistedChatTranscriptMessageSchema.parse(message), message);
});

test('chat transcript lifecycle schemas distinguish running, stopped, and replayable tools', () => {
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
    toolCallExecutionState: 'executing',
    toolCallStatus: 'running',
  };

  assert.equal(ChatTranscriptMessageSchema.safeParse(toolMessage).success, true);
  // An in-progress row is legitimately durable now; only model replay still insists on a result.
  assert.equal(PersistedChatTranscriptMessageSchema.safeParse(toolMessage).success, true);
  assert.equal(ReplayableChatMessageSchema.safeParse(toolMessage).success, false);
  assert.equal(PersistedChatTranscriptMessageSchema.safeParse({
    ...toolMessage,
    toolCallExecutionState: 'uncertain',
    toolCallStatus: 'stopped',
  }).success, true);
  assert.equal(ReplayableChatMessageSchema.safeParse({
    ...toolMessage,
    toolCallExecutionState: 'completed',
    toolCallStatus: 'done',
  }).success, true);
  assert.equal(ReplayableChatMessageSchema.safeParse({
    ...toolMessage,
    toolCallStatus: 'stopped',
  }).success, false);
  assert.equal(ChatTranscriptMessageSchema.safeParse({ ...toolMessage, toolCallActivityKind: undefined }).success, false);
  assert.equal(ChatTranscriptMessageSchema.safeParse({ ...toolMessage, toolCallActivitySubject: undefined }).success, false);
  assert.equal(ChatTranscriptMessageSchema.safeParse({ ...toolMessage, toolCallStatus: undefined }).success, false);
  assert.equal(ChatTranscriptMessageSchema.safeParse({ ...toolMessage, toolCallExecutionState: undefined }).success, false);
  assert.equal(ChatTranscriptMessageSchema.safeParse({ ...toolMessage, toolCallCommand: undefined }).success, false);
});

test('PersistedChatTranscriptMessageSchema rejects messages without a kind', () => {
  const { kind: _kind, ...kindlessMessage } = message;
  assert.equal(PersistedChatTranscriptMessageSchema.safeParse(kindlessMessage).success, false);
});

test('PersistedChatTranscriptMessageSchema accepts a compaction summary row', () => {
  const summary = {
    ...message,
    id: 'm2', role: 'assistant', kind: 'compaction_summary', content: 'summary text',
    compressedIntoSummary: false,
  };
  assert.equal(PersistedChatTranscriptMessageSchema.parse(summary).kind, 'compaction_summary');
});

test('assistant narration and progress persist with the stopped transcript', () => {
  const narration = { ...message, role: 'assistant', kind: 'assistant_narration', content: 'Inspecting files.' };
  const progress = { ...message, role: 'assistant', kind: 'assistant_progress', content: 'Step 2 of 5' };
  assert.equal(PersistedChatTranscriptMessageSchema.parse(narration).kind, 'assistant_narration');
  assert.equal(PersistedChatTranscriptMessageSchema.parse(progress).kind, 'assistant_progress');
  assert.equal(ChatTranscriptMessageSchema.safeParse(narration).success, true);
  assert.equal(ReplayableChatMessageSchema.safeParse(narration).success, false);
  assert.equal(PersistedChatTranscriptMessageSchema.safeParse({ ...narration, role: 'user' }).success, false);
  assert.equal(PersistedChatTranscriptMessageSchema.safeParse({ ...message, kind: 'assistant_bogus' }).success, false);
  assert.equal(ChatSessionSchema.safeParse({
    ...SESSION_FIXTURE, model: null, messages: [narration, progress],
  }).success, true);
});

test('ChatSessionSchema no longer carries a condensed summary', () => {
  const parsed = ChatSessionSchema.parse({
    ...SESSION_FIXTURE, condensedSummary: 'obsolete summary',
  });
  assert.equal('condensedSummary' in parsed, false);
});

test('ChatSessionResponseSchema requires contextUsage', () => {
  assert.throws(() => ChatSessionResponseSchema.parse({ session: SESSION_FIXTURE }));
});

test('ChatSessionSchema requires modelPresetId', () => {
  const { modelPresetId: _modelPresetId, ...session } = SESSION_FIXTURE;

  assert.throws(() => ChatSessionSchema.parse(session));
  assert.equal(
    ChatSessionSchema.parse({ ...session, modelPresetId: 'preset-a' }).modelPresetId,
    'preset-a',
  );
});

test('ChatSessionSchema requires an explicit model choice and a resolved default', () => {
  assert.throws(() => ChatSessionSchema.parse({ ...SESSION_FIXTURE, modelPresetOverrideId: undefined }));
  assert.throws(() => ChatSessionSchema.parse({ ...SESSION_FIXTURE, defaultModelPreset: undefined }));
  assert.equal(ChatSessionSchema.parse(SESSION_FIXTURE).modelPresetOverrideId, null);
});

test('ChatSessionSchema states the orchestrator run it shows: a run id, or an explicit null', () => {
  const runId = '0b9e1c52-8f0a-4a4e-9a51-3c1f2d6b7e10';
  assert.equal(ChatSessionSchema.parse({ ...SESSION_FIXTURE, orchestratorRunId: runId }).orchestratorRunId, runId);
  assert.throws(() => ChatSessionSchema.parse({ ...SESSION_FIXTURE, orchestratorRunId: undefined }));
  assert.throws(() => ChatSessionSchema.parse({ ...SESSION_FIXTURE, orchestratorRunId: 'not-a-run-id' }));
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
    ['message', 'plan', 'repo-search', 'repo-agent', 'condense'],
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

test('only images shown to the user are display-only and cost no context', () => {
  const imageMeta = [ImageMetadataSchema.parse({ width: 8, height: 8, originalWidth: 8, originalHeight: 8, mime: 'image/png', byteLength: 1, tokenEstimate: 64, resized: false, caption: null })];
  assert.equal(isDisplayOnlyImageMessage({ toolCallActivityKind: 'image' }), true);
  assert.equal(isDisplayOnlyImageMessage({ toolCallActivityKind: 'read' }), false);
  assert.equal(isDisplayOnlyImageMessage({}), false);
  assert.equal(sumContextImageTokens({ toolCallActivityKind: 'image', imageMeta }), 0);
  assert.equal(sumContextImageTokens({ toolCallActivityKind: 'read', imageMeta }), 64);
});
