import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppendedLiveToolMessage,
  buildCompletedLiveToolMessage,
  createLiveMessage,
  upsertLiveMessageInto,
} from '../src/lib/chat-live-messages';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { groupMessagesIntoTurns, LIVE_THINKING_STACK_DEPTH } from '../src/lib/chatTurns';
import type { ChatTurn } from '../src/lib/chatTurns';
import type { ChatStreamToolEvent } from '../src/lib/chat-stream-parser';

test('upsertLiveMessageInto appends a new entry when the id is unique', () => {
  const initial = createLiveMessage('a', 'assistant_answer', 'assistant', 'one');
  const incoming = createLiveMessage('b', 'assistant_answer', 'assistant', 'two');
  const next = upsertLiveMessageInto([initial], incoming);
  assert.equal(next.length, 2);
  assert.equal(next[1]?.id, 'b');
});

test('upsertLiveMessageInto merges fields onto an existing entry with the same id', () => {
  const initial = createLiveMessage('a', 'assistant_answer', 'assistant', 'one');
  const update = { ...createLiveMessage('a', 'assistant_answer', 'assistant', 'updated'), outputTokensEstimate: 12 };
  const next = upsertLiveMessageInto([initial], update);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.content, 'updated');
  assert.equal(next[0]?.outputTokensEstimate, 12);
});

test('buildAppendedLiveToolMessage marks the tool message as running with prompt token count', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_start',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    toolCallLimit: 4,
    activityKind: 'search',
    activitySubject: { kind: 'none' },
    command: 'rg foo',
    promptTokenCount: 100,
  };
  const built = buildAppendedLiveToolMessage(event);
  assert.equal(built.id, 'live-tool-t1');
  assert.equal(built.toolCallStatus, 'running');
  assert.equal(built.toolCallActivityKind, 'search');
  assert.equal(built.toolCallExitCode, null);
  assert.equal(built.toolCallPromptTokenCount, 100);
  assert.equal(built.outputTokensEstimate, 0);
  assert.equal(built.outputTokensEstimated, false);
});

test('buildCompletedLiveToolMessage marks the tool message as done with output snippet, exit code, and tokens', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_result',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    toolCallLimit: 4,
    activityKind: 'search',
    activitySubject: { kind: 'none' },
    command: 'rg foo',
    promptTokenCount: 100,
    exitCode: 0,
    outputSnippet: 'snippet',
    outputTokens: 32,
    outputTokensEstimated: false,
  };
  const built = buildCompletedLiveToolMessage(event);
  assert.equal(built.toolCallStatus, 'done');
  assert.equal(built.toolCallActivityKind, 'search');
  assert.equal(built.toolCallExitCode, 0);
  assert.equal(built.toolCallOutputSnippet, 'snippet');
  assert.equal(built.outputTokensEstimate, 32);
  assert.equal(built.outputTokensEstimated, false);
  assert.equal(built.associatedToolTokens, 32);
});

test('buildCompletedLiveToolMessage preserves estimated token metadata', () => {
  const event: ChatStreamToolEvent = {
    kind: 'tool_result',
    toolCallId: 't1',
    turn: 1,
    maxTurns: 4,
    toolCallLimit: 4,
    activityKind: 'validate',
    activitySubject: { kind: 'none' },
    command: 'rg foo',
    promptTokenCount: 100,
    exitCode: 0,
    outputSnippet: '',
    outputTokens: 9048,
    outputTokensEstimated: true,
  };
  const built = buildCompletedLiveToolMessage(event);
  assert.equal(built.outputTokensEstimate, 9048);
  assert.equal(built.outputTokensEstimated, true);
});

const REPO_AGENT_OPERATION_ID = '4f9c1f9a-0000-4000-8000-000000000001';

/**
 * The assistant's live turn. ChatTab groups persisted history plus the live tail; a runtime-store
 * session carries only the live tail, so that list is the whole visible input here.
 */
function liveTurnFor(store: ChatSessionRuntimeStore, sessionId: string): ChatTurn {
  const runtime = store.get(sessionId);
  const turns = groupMessagesIntoTurns(
    runtime.liveMessages,
    new Set(runtime.liveMessages.map((message) => message.id)),
  );
  const turn = turns.find((entry) => entry.key === 'live');
  if (!turn) {
    throw new Error('Expected a live turn');
  }
  return turn;
}

test('a live repo-agent turn renders the thinking stack above the recent-activity ring and keeps showRecentActivity true', () => {
  const sessionId = 'session-repo-agent';
  let store = new ChatSessionRuntimeStore()
    .ensureSession(sessionId)
    .apply({ kind: 'begin', sessionId, operationKind: 'repo-agent', operationId: REPO_AGENT_OPERATION_ID });
  for (const turn of [1, 2, 3, 4]) {
    store = store.apply({ kind: 'thinking', sessionId, delta: { turn, offset: 0, text: `thinking turn ${turn}` } });
  }

  assert.deepEqual(store.get(sessionId).activity, {
    kind: 'local',
    operationKind: 'repo-agent',
    operationId: REPO_AGENT_OPERATION_ID,
  });
  let live = liveTurnFor(store, sessionId);
  assert.equal(live.showRecentActivity, true);
  assert.equal(live.liveThinking.length, LIVE_THINKING_STACK_DEPTH);
  assert.deepEqual(live.liveThinking.map((message) => message.content), [
    'thinking turn 2',
    'thinking turn 3',
    'thinking turn 4',
  ]);
  assert.equal(live.recentActivities.length, 0);
  // The cap is a render cap: the store keeps every thinking step for the settled turn.
  assert.equal(
    store.get(sessionId).liveMessages.filter((message) => message.kind === 'assistant_thinking').length,
    4,
  );

  const toolStart: ChatStreamToolEvent = {
    kind: 'tool_start',
    toolCallId: 't1',
    turn: 4,
    maxTurns: 4,
    toolCallLimit: 4,
    activityKind: 'search',
    activitySubject: { kind: 'none' },
    command: 'rg cipher',
    promptTokenCount: 100,
  };
  const toolResult: ChatStreamToolEvent = {
    ...toolStart,
    kind: 'tool_result',
    exitCode: 0,
    outputSnippet: 'cipher: found',
    outputTokens: 32,
    outputTokensEstimated: false,
  };
  store = store
    .apply({ kind: 'tool', sessionId, toolEvent: toolStart })
    .apply({ kind: 'tool', sessionId, toolEvent: toolResult });

  live = liveTurnFor(store, sessionId);
  assert.equal(live.showRecentActivity, true);
  assert.equal(live.liveThinking.length, LIVE_THINKING_STACK_DEPTH);
  assert.equal(live.recentActivities.length, 1);
  assert.equal(live.recentActivities[0]?.activityKind, 'search');
  assert.equal(live.recentActivities[0]?.state, 'active');
});
