import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore } from '../src/state/chat-journal.js';
import {
  ChatJournalEnvelopeSchema,
  CHAT_JOURNAL_EVENT_VERSION,
  type ChatJournalEnvelope,
  type ChatJournalEvent,
} from '../src/state/chat-journal-schema.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { TranscriptManager } from '../src/repo-search/engine/transcript-manager.js';
import type { ChatContextRecorder } from '../src/repo-search/engine/chat-run-evidence.js';
import { buildCompactionSummaryMessage } from '../src/repo-search/engine/transcript-compactor.js';
import type { ChatContextInit, ChatContextSplice } from '../src/repo-search/planner-chat-message.js';
import { findPlannerContextViolation } from '../src/repo-search/planner-chat-message.js';
import { buildAssistantToolCallMessage, buildToolResultMessage } from '../src/tool-call-messages.js';
import {
  buildRecoveredChatHistory,
  replayChatContext,
} from '../src/status-server/chat-context-replay.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

const OPERATION_ID = randomUUID();
const RECORDED_AT = '2026-09-10T11:04:54.755Z';
const SESSION_ID = 'replay-session';
const OWNER_EPOCH = 'owner-a:1';
const PNG = 'data:image/png;base64,AAAA';

/** Turns the transcript's own mutations into the journal events a recovered run would read back. */
class RecordingContextRecorder implements ChatContextRecorder {
  readonly userMessageId = 'replay-user';
  readonly messageIdPrefix = `stopped-${OPERATION_ID}`;
  readonly historyRevision = 0;
  private readonly toolIds = new Map<string, string>();
  resolveAssistantMessageId(turn: number): string { return `${this.messageIdPrefix}-narration-${turn}`; }
  resolveToolMessageId(toolCallId: string): string {
    const existing = this.toolIds.get(toolCallId);
    if (existing) return existing;
    const id = `${this.messageIdPrefix}-tool-tc_${this.toolIds.size}`;
    this.toolIds.set(toolCallId, id);
    return id;
  }
  readHistoryRevisions() { return []; }
  readonly events: ChatJournalEvent[] = [];

  recordContextInitialized(init: ChatContextInit): void {
    this.events.push({ kind: 'context_initialized', ...init });
  }

  recordContextSpliced(splice: ChatContextSplice): void {
    this.events.push({ kind: 'context_spliced', ...splice });
  }
}

function envelope(sequence: number, event: ChatJournalEvent, operationId = OPERATION_ID): ChatJournalEnvelope {
  return ChatJournalEnvelopeSchema.parse({
    operationId,
    sequence,
    eventId: `event-${String(sequence)}`,
    version: CHAT_JOURNAL_EVENT_VERSION,
    recordedAtUtc: RECORDED_AT,
    event,
    payloadDigest: `digest-${String(sequence)}`,
  });
}

function envelopes(events: readonly ChatJournalEvent[], operationId = OPERATION_ID): ChatJournalEnvelope[] {
  return events.map((event, index) => envelope(index + 1, event, operationId));
}

function toolCall(indexInBatch: number, toolCallId: string) {
  return { toolCallId, displayToolCallId: `tc_${String(indexInBatch)}`, batchId: 'batch-1', turn: 1, indexInBatch };
}

function proposed(indexInBatch: number, toolCallId: string, command: string): Extract<ChatJournalEvent, { kind: 'tool_proposed' }> {
  return {
    kind: 'tool_proposed',
    call: toolCall(indexInBatch, toolCallId),
    toolName: 'run_repo_cmd',
    arguments: { command },
    command,
    activityKind: 'command',
    activitySubject: { kind: 'file', value: 'src/app.ts' },
    maxTurns: 120,
    promptTokenCount: 100,
    executionState: 'proposed',
  };
}

function started(indexInBatch: number, toolCallId: string): ChatJournalEvent {
  return { kind: 'tool_started', call: toolCall(indexInBatch, toolCallId), startedAtUtc: RECORDED_AT };
}

function result(indexInBatch: number, toolCallId: string, output: string): ChatJournalEvent {
  return {
    kind: 'tool_result',
    call: toolCall(indexInBatch, toolCallId),
    executionState: 'completed',
    exitCode: 0,
    output,
    images: [],
    imageMeta: [],
    outputTokens: 4,
    outputTokensEstimated: true,
    promptTokenCount: 100,
    finishedAtUtc: RECORDED_AT,
  };
}

for (const scenario of [
  { name: 'start without proposal', events: [started(0, 'call_a')] },
  { name: 'result with another native identity', events: [proposed(0, 'call_a', 'first'), result(0, 'call_b', 'wrong result')] },
  { name: 'duplicate proposal identity', events: [proposed(0, 'call_a', 'first'), proposed(0, 'call_a', 'second')] },
  { name: 'missing earlier batch member', events: [proposed(1, 'call_b', 'second')] },
  { name: 'conflicting second result', events: [proposed(0, 'call_a', 'first'), result(0, 'call_a', 'first'), result(0, 'call_a', 'second')] },
  { name: 'finalization without full result', events: [proposed(0, 'call_a', 'first'),
    { kind: 'tool_result_finalized', call: toolCall(0, 'call_a'), modelVisibleText: 'invented', contextRevision: 0 }] },
] satisfies { name: string; events: ChatJournalEvent[] }[]) test(`context recovery rejects ${scenario.name}`, () => {
  const recovered = replayChatContext(envelopes([
    { kind: 'context_initialized', contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'task' }] },
    ...scenario.events,
  ]));
  assert.equal(recovered.status, 'recovery_failed');
  assert.equal(recovered.issues[0]?.operationId, OPERATION_ID);
  assert.ok(recovered.issues[0]?.eventId);
});

test('native call IDs may be reused after a closed exchange but not within one open batch', () => {
  const call = { action: { toolName: 'read', args: { path: 'old.ts' } }, toolCallId: 'call_a', toolContent: 'old result' };
  const exchange = [buildAssistantToolCallMessage([call]), buildToolResultMessage(call.toolCallId, call.toolContent)];
  assert.equal(findPlannerContextViolation([...exchange, ...exchange]), null);
  assert.match(findPlannerContextViolation([buildAssistantToolCallMessage([call, call])]) ?? '', /redeclares/u);
});

test('a reused native ID cannot hide the current interrupted proposal behind retained history', () => {
  const prior = [buildAssistantToolCallMessage([{ action: { toolName: 'read', args: { path: 'old.ts' } }, toolCallId: 'call_a', toolContent: 'old result' }]),
    buildToolResultMessage('call_a', 'old result')];
  const recovered = replayChatContext(envelopes([
    { kind: 'context_initialized', contextRevision: 0, turnBoundary: prior.length, messages: [...prior, { role: 'user', content: 'new request' }] },
    proposed(0, 'call_a', 'new effect'), started(0, 'call_a'),
  ]));
  assert.notEqual(recovered.status, 'recovery_failed');
  const results = recovered.messages.filter(message => message.role === 'tool');
  assert.equal(results.length, 2);
  assert.equal(results[0]?.content, 'old result');
  assert.match(String(results[1]?.content), /Outcome uncertain/u);
});

test('two batches in one run keep distinct evidence when their native IDs repeat', () => {
  const firstExchange = [buildAssistantToolCallMessage([{ action: { toolName: 'run_repo_cmd', args: { command: 'first' } }, toolCallId: 'call_a', toolContent: 'first result' }]),
    buildToolResultMessage('call_a', 'first result')];
  const secondCall = { ...toolCall(0, 'call_a'), displayToolCallId: 'second-display', batchId: 'batch-2', turn: 2 };
  const recovered = replayChatContext(envelopes([
    { kind: 'context_initialized', contextRevision: 0, turnBoundary: 0, messages: [{ role: 'user', content: 'request' }] },
    proposed(0, 'call_a', 'first'), started(0, 'call_a'), result(0, 'call_a', 'first result'),
    { kind: 'context_spliced', expectedRevision: 0, contextRevision: 1, startIndex: 1, deleteCount: 0, inserted: firstExchange, turnBoundary: 0, reason: 'append' },
    { ...proposed(0, 'call_a', 'second'), call: secondCall },
    { kind: 'tool_started', call: secondCall, startedAtUtc: RECORDED_AT },
  ]));
  assert.notEqual(recovered.status, 'recovery_failed');
  const results = recovered.messages.filter(message => message.role === 'tool');
  assert.equal(results.length, 2);
  assert.equal(results[0]?.content, 'first result');
  assert.match(String(results[1]?.content), /Outcome uncertain/u);
  assert.deepEqual(recovered.toolExecutions.map(tool => tool.executionState), ['completed', 'uncertain']);
});

test('finalizing a reused native ID replaces the latest exchange without editing retained history', () => {
  const prior = [buildAssistantToolCallMessage([{ action: { toolName: 'read', args: { path: 'old.ts' } }, toolCallId: 'call_a', toolContent: 'old result' }]),
    buildToolResultMessage('call_a', 'old result')];
  const recorder = new RecordingContextRecorder();
  const transcript = new TranscriptManager({ systemPromptContent: 'SYSTEM', historyMessages: prior,
    initialUserContent: 'new request', initialUserImages: [], liveImagePathKeys: new Set<string>(), contextRecorder: recorder });
  transcript.appendBatchExchange([{ action: { toolName: 'read', args: { path: 'new.ts' } }, toolCallId: 'call_a', toolContent: 'new result' }], '');
  transcript.replaceToolResult('call_a', 'finalized new result');
  assert.deepEqual(transcript.getMessages().filter(message => message.role === 'tool').map(message => message.content), ['old result', 'finalized new result']);
  assert.deepEqual(replayChatContext(envelopes(recorder.events)).messages, transcript.getMessages());
});

/** A run that exercises every mutation the engine performs, recorded exactly as it happened. */
function runLiveTranscript(): { transcript: TranscriptManager; recorder: RecordingContextRecorder } {
  const recorder = new RecordingContextRecorder();
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    initialUserContent: 'describe this',
    initialUserImages: [PNG],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });

  const batchStart = transcript.appendBatchExchange(
    [
      { action: { toolName: 'read', args: { path: 'a.png' } }, toolCallId: 'call_a', toolContent: 'image a' },
      { action: { toolName: 'grep', args: { pattern: 'x' } }, toolCallId: 'call_b', toolContent: '' },
    ],
    'batched thinking',
    'looking',
  );
  transcript.pruneThinking(false);
  transcript.insertUserAfter(batchStart + 1, 'image a', [PNG], 'a.png', 'call_a');
  // A rejected repeat rewrites the answer that is already in history.
  transcript.replaceToolResult('call_b', 'duplicate command requested x2');
  transcript.pushUser('steering while the run is live');
  transcript.upsertForcedFinishCountdown('Forced finish attempts remaining: 2.');
  transcript.upsertForcedFinishCountdown('Forced finish attempts remaining: 1.');
  transcript.pushAssistant({ role: 'assistant', content: 'final', reasoning_content: 'final think' });
  transcript.pruneThinking(false);
  transcript.pruneImages(0);

  return { transcript, recorder };
}

test('replay reproduces the live planner context exactly', () => {
  const { transcript, recorder } = runLiveTranscript();

  const replayed = replayChatContext(envelopes(recorder.events));

  assert.deepEqual(replayed.messages, transcript.getMessages());
  assert.equal(replayed.contextRevision, transcript.contextRevision);
  assert.equal(replayed.turnBoundary, transcript.currentTurnStartIndex);
  assert.equal(replayed.status, 'ok');
  assert.deepEqual(replayed.issues, []);
});

test('replay rejects a missing initial journal prefix', () => {
  const event: ChatJournalEvent = { kind: 'context_initialized', messages: [{ role: 'user', content: 'question' }], contextRevision: 0, turnBoundary: 0 };
  const recovered = replayChatContext([envelope(2, event)]);
  assert.equal(recovered.status, 'recovery_failed');
  assert.equal(recovered.issues[0]?.code, 'sequence_gap');
});

test('replay rejects events from different operations even when their sequence is contiguous', () => {
  const recovered = replayChatContext([
    envelope(1, { kind: 'context_initialized', messages: [{ role: 'user', content: 'question' }], contextRevision: 0, turnBoundary: 0 }),
    envelope(2, { kind: 'context_spliced', expectedRevision: 0, contextRevision: 1, startIndex: 1, deleteCount: 0,
      inserted: [{ role: 'assistant', content: 'unrelated' }], turnBoundary: 0, reason: 'append' }, randomUUID()),
  ]);
  assert.equal(recovered.status, 'recovery_failed');
});

for (const mutation of [{ contextRevision: 2, turnBoundary: 0 }, { contextRevision: 1, turnBoundary: 3 }]) {
  test(`replay rejects invalid context mutation bounds ${JSON.stringify(mutation)}`, () => {
    const recovered = replayChatContext(envelopes([
      { kind: 'context_initialized', messages: [{ role: 'user', content: 'question' }], contextRevision: 0, turnBoundary: 0 },
      { kind: 'context_spliced', expectedRevision: 0, ...mutation, startIndex: 1, deleteCount: 0,
        inserted: [{ role: 'assistant', content: 'answer' }], reason: 'append' },
    ]));
    assert.equal(recovered.status, 'recovery_failed');
  });
}

test('replay preserves an unfinished turn across a compaction', () => {
  const recorder = new RecordingContextRecorder();
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }],
    initialUserContent: 'trigger question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  transcript.replaceWith([
    { role: 'system', content: 'SYSTEM' },
    buildCompactionSummaryMessage('summary'),
    { role: 'user', content: 'trigger question' },
  ], 2);
  transcript.pushAssistant({ role: 'assistant', content: 'answer after compaction' });

  const replayed = replayChatContext(envelopes(recorder.events));

  assert.deepEqual(replayed.messages, transcript.getMessages());
  assert.equal(replayed.turnBoundary, 2);
  assert.equal(replayed.messages[2].content, 'trigger question');
});

test('replay reports a sequence gap instead of a partial context', () => {
  const { recorder } = runLiveTranscript();
  const complete = envelopes(recorder.events);
  const gapped = [...complete.slice(0, 2), ...complete.slice(3)];

  const replayed = replayChatContext(gapped);

  assert.equal(replayed.status, 'recovery_failed');
  assert.deepEqual(replayed.messages, []);
  assert.deepEqual(replayed.issues.map((issue) => issue.code), ['sequence_gap']);
  assert.equal(replayed.issues[0].sequence, 4);
});

test('replay refuses a splice recorded against a different revision', () => {
  const recorder = new RecordingContextRecorder();
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  transcript.pushUser('follow up');
  const tampered = recorder.events.map((event) => (
    event.kind === 'context_spliced' ? { ...event, expectedRevision: 7 } : event
  ));

  const replayed = replayChatContext(envelopes(tampered));

  assert.equal(replayed.status, 'recovery_failed');
  assert.deepEqual(replayed.issues.map((issue) => issue.code), ['context_gap']);
  assert.deepEqual(replayed.messages, []);
});

test('replay refuses a splice that reaches past the context it is applied to', () => {
  const recorder = new RecordingContextRecorder();
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  transcript.pushUser('follow up');
  const tampered = recorder.events.map((event) => (
    event.kind === 'context_spliced' ? { ...event, startIndex: 9 } : event
  ));

  const replayed = replayChatContext(envelopes(tampered));

  assert.equal(replayed.status, 'recovery_failed');
  assert.deepEqual(replayed.issues.map((issue) => issue.code), ['context_gap']);
});

test('replay without an initial context reports a context gap', () => {
  const replayed = replayChatContext(envelopes([proposed(0, 'call_a', 'ls')]));

  assert.equal(replayed.status, 'recovery_failed');
  assert.deepEqual(replayed.issues.map((issue) => issue.code), ['context_gap']);
});

test('an interrupted batch is closed with complete results and explicit interruption answers', () => {
  const recorder = new RecordingContextRecorder();
  new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  const events: ChatJournalEvent[] = [
    ...recorder.events,
    proposed(0, 'call_a', 'rg -n foo'),
    proposed(1, 'call_b', 'node build.js'),
    started(0, 'call_a'),
    result(0, 'call_a', 'raw output before finalization'),
    {
      kind: 'tool_result_finalized',
      call: toolCall(0, 'call_a'),
      modelVisibleText: 'rg -n foo\n3 matches, refitted for the model',
      contextRevision: 1,
    },
    started(1, 'call_b'),
  ];

  const replayed = replayChatContext(envelopes(events));

  assert.equal(replayed.status, 'recovery_needed');
  const assistant = replayed.messages.at(-3);
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.tool_calls?.length, 2);
  assert.deepEqual(assistant?.tool_calls?.map((call) => call.id), ['call_a', 'call_b']);
  const answers = replayed.messages.filter((message) => message.role === 'tool');
  assert.equal(answers[0].content, 'rg -n foo\n3 matches, refitted for the model');
  assert.equal(String(answers[1].content).includes('Outcome uncertain'), true);
  assert.deepEqual(replayed.issues.map((issue) => issue.code), []);
});

test('a batch interrupted before execution is closed as never started, not as uncertain', () => {
  const recorder = new RecordingContextRecorder();
  new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  const events: ChatJournalEvent[] = [...recorder.events, proposed(0, 'call_a', 'rm -rf build')];

  const replayed = replayChatContext(envelopes(events));

  const answer = replayed.messages.at(-1);
  assert.equal(answer?.role, 'tool');
  assert.equal(String(answer?.content).includes('never started'), true);
  assert.equal(String(answer?.content).includes('Outcome uncertain'), false);
  assert.deepEqual(replayed.toolExecutions, [
    { toolCallId: 'call_a', executionState: 'not_started' },
  ]);
});

test('replay of a completed batch leaves no interruption answer behind', () => {
  const { transcript, recorder } = runLiveTranscript();
  const [initial, ...mutations] = recorder.events;
  assert.ok(initial);
  const events: ChatJournalEvent[] = [
    initial,
    proposed(0, 'call_a', 'read a.png'),
    proposed(1, 'call_b', 'grep x'),
    started(0, 'call_a'),
    result(0, 'call_a', 'image a'),
    started(1, 'call_b'),
    result(1, 'call_b', ''),
    ...mutations,
  ];

  const replayed = replayChatContext(envelopes(events));

  assert.deepEqual(replayed.messages, transcript.getMessages());
  assert.equal(replayed.status, 'ok');
  assert.deepEqual(
    replayed.toolExecutions.map((execution) => execution.executionState),
    ['completed', 'completed'],
  );
});

test('replay does not re-append a batch that compaction removed from the context', () => {
  const recorder = new RecordingContextRecorder();
  const transcript = new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  transcript.appendBatchExchange(
    [{
      action: { toolName: 'run_repo_cmd', args: { command: 'rg -n foo' } },
      toolCallId: 'call_a',
      toolContent: 'full result that compaction dropped',
    }],
    '',
    'looking',
  );
  transcript.replaceWith([
    { role: 'system', content: 'SYSTEM' },
    buildCompactionSummaryMessage('summary'),
    { role: 'user', content: 'question' },
  ], 2);
  const [initialized, appended, compacted] = recorder.events;
  const events: ChatJournalEvent[] = [
    initialized,
    proposed(0, 'call_a', 'rg -n foo'),
    started(0, 'call_a'),
    result(0, 'call_a', 'full result that compaction dropped'),
    appended,
    compacted,
  ];

  const replayed = replayChatContext(envelopes(events));

  assert.equal(replayed.status, 'ok');
  assert.deepEqual(replayed.messages, transcript.getMessages());
  assert.equal(
    replayed.messages.some((message) => String(message.content).includes('compaction dropped')),
    false,
  );
});

test('a recovered batch keeps the arguments each call was proposed with', () => {
  const recorder = new RecordingContextRecorder();
  new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  const events: ChatJournalEvent[] = [
    ...recorder.events,
    proposed(0, 'call_a', 'rg -n foo'),
    proposed(1, 'call_b', 'node build.js'),
    started(0, 'call_a'),
    result(0, 'call_a', 'three matches'),
    started(1, 'call_b'),
  ];

  const replayed = replayChatContext(envelopes(events));

  const assistant = replayed.messages.find((message) => message.tool_calls !== undefined);
  assert.deepEqual(assistant?.tool_calls?.map((call) => call.function.name), ['run_repo_cmd', 'run_repo_cmd']);
  assert.deepEqual(assistant?.tool_calls?.map((call) => call.function.arguments), [
    JSON.stringify({ command: 'rg -n foo' }),
    JSON.stringify({ command: 'node build.js' }),
  ]);
});

function openSessionDatabase(prefix: string) {
  const runtimeRoot = createManagedTempDir(prefix);
  saveChatSession(runtimeRoot, {
    id: SESSION_ID,
    title: 'Replay session',
    modelPresetId: 'preset-a',
    modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'chat',
    mode: 'chat',
    planRepoRoot: 'C:/repo',
    createdAtUtc: RECORDED_AT,
    updatedAtUtc: RECORDED_AT,
    messages: [],
  });
  return getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
}

function writeRun(store: ChatJournalStore, events: readonly ChatJournalEvent[]): string {
  const operationId = randomUUID();
  store.begin({
    operationId,
    sessionId: SESSION_ID,
    recordKind: 'execution',
    operationKind: 'repo-agent',
    ownerEpoch: OWNER_EPOCH,
    settings: null,
    provenance: null,
    createdAtUtc: RECORDED_AT,
  });
  events.forEach((event, index) => {
    store.append({
      operationId,
      ownerEpoch: OWNER_EPOCH,
      expectedSequence: index,
      eventId: `event-${String(index + 1)}`,
      occurredAtUtc: RECORDED_AT,
      event,
    });
  });
  return operationId;
}

test('recovered history drops the system prompt and carries the interrupted narration once', () => {
  const database = openSessionDatabase('chat-context-replay-history-');
  const store = new ChatJournalStore(database);
  const recorder = new RecordingContextRecorder();
  new TranscriptManager({
    systemPromptContent: 'SYSTEM',
    historyMessages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    initialUserContent: 'question',
    initialUserImages: [],
    liveImagePathKeys: new Set<string>(),
    contextRecorder: recorder,
  });
  const operationId = writeRun(store, [
    ...recorder.events,
    {
      kind: 'display',
      event: { kind: 'narration', delta: { turn: 1, offset: 0, text: 'I checked the ' } },
    },
    {
      kind: 'display',
      event: { kind: 'narration', delta: { turn: 1, offset: 14, text: 'build output' } },
    },
  ]);

  const recovered = buildRecoveredChatHistory(database, SESSION_ID);

  assert.equal(recovered.operationId, operationId);
  assert.equal(recovered.status, 'recovery_needed');
  assert.equal(recovered.messages.some((message) => message.role === 'system'), false);
  const narration = recovered.messages.filter(
    (message) => message.role === 'assistant' && String(message.content).includes('I checked the build output'),
  );
  assert.equal(narration.length, 1);
  assert.equal(String(narration[0].content).includes('[interrupted]'), true);
  assert.deepEqual(recovered.interruptionNotices, [
    'The previous run stopped before it finished its answer; its partial narration is included above.',
  ]);
});

test('recovered history for a session that never ran is empty and clean', () => {
  const database = openSessionDatabase('chat-context-replay-empty-');

  const recovered = buildRecoveredChatHistory(database, SESSION_ID);

  assert.equal(recovered.operationId, null);
  assert.equal(recovered.status, 'ok');
  assert.deepEqual(recovered.messages, []);
  assert.deepEqual(recovered.interruptionNotices, []);
});

test('a submission lost before engine initialization continues from the previous retained context', () => {
  const database = openSessionDatabase('chat-history-before-engine-');
  const store = new ChatJournalStore(database);
  const first = writeRun(store, [{ kind: 'context_initialized', messages: [
    { role: 'user', content: 'earlier request' }, { role: 'assistant', content: 'earlier answer' },
  ], contextRevision: 0, turnBoundary: 0 }]);
  store.finish({ operationId: first, ownerEpoch: OWNER_EPOCH, terminalCause: 'completed', updatedAtUtc: RECORDED_AT });
  const settings = {
    operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetId: 'preset-a', model: 'model-a', repoRoot: 'C:/repo',
    approval: 'interactive', maxTurns: 120, thinkingEnabled: true, webSearchEnabled: false, contextWindowTokens: 4096,
  } as const;
  writeRun(store, [{ kind: 'run_started', sessionId: SESSION_ID, operationKind: 'repo-agent', runOrder: 2,
    userMessageId: 'lost-submission', content: 'new request before provider failure', images: [], imageMeta: [], settings, retainedHistoryRevision: 0 }]);
  const history = buildRecoveredChatHistory(database, SESSION_ID);
  assert.notEqual(history.status, 'recovery_failed');
  assert.deepEqual(history.messages.map(message => message.content), ['earlier request', 'earlier answer', 'new request before provider failure']);
});

test('recovered history reports the integrity failure rather than a truncated context', () => {
  const database = openSessionDatabase('chat-context-replay-broken-');
  const store = new ChatJournalStore(database);
  writeRun(store, [proposed(0, 'call_a', 'ls')]);

  const recovered = buildRecoveredChatHistory(database, SESSION_ID);

  assert.equal(recovered.status, 'recovery_failed');
  assert.deepEqual(recovered.messages, []);
  assert.deepEqual(recovered.issues.map((issue) => issue.code), ['context_gap']);
});
