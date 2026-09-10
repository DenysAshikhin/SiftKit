import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { buildLiveTokenDisplays } from '../src/lib/chat-live-token-display';
import { formatLiveMessageTokenLabel, getTurnTokenDisplay } from '../src/lib/format';
import { groupMessagesIntoTurns } from '../src/lib/chatTurns';
import { buildUsageFrame } from './usage-frame';

function start() {
  return new ChatSessionRuntimeStore().ensureSession('s', '').ensureSession('other', '')
    .apply({ kind: 'prompt', sessionId: 's', prompt: { turn: 1, maxTurns: 20, promptTokens: 50, charsPerToken: 4 } });
}

test('estimates use reconstructed content and the prompt belonging to each turn', () => {
  let store = start();
  for (const [offset, text, expected] of [
    [0, 'x'.repeat(400), 100], [400, 'x'.repeat(400), 200],
    [0, 'x'.repeat(800), 200], [4, 'xxxx', 2], [0, '', 0],
  ] as const) {
    store = store.apply({ kind: 'thinking', sessionId: 's', delta: { turn: 1, offset, text } });
    assert.deepEqual(buildLiveTokenDisplays(store.get('s')).get('live-thinking-1'), { tokenCount: expected, exact: false, imageTokens: 0 });
    assert.equal(store.get('s').liveMessages[0]?.thinkingTokens, 0);
  }
  store = store.apply({ kind: 'thinking', sessionId: 's', delta: { turn: 1, offset: 0, text: 'x'.repeat(400) } })
    .apply({ kind: 'prompt', sessionId: 's', prompt: { turn: 2, maxTurns: 20, promptTokens: 50, charsPerToken: 8 } })
    .apply({ kind: 'thinking', sessionId: 's', delta: { turn: 2, offset: 0, text: 'x'.repeat(400) } });
  const displays = buildLiveTokenDisplays(store.get('s'));
  assert.equal(displays.get('live-thinking-1')?.tokenCount, 100);
  assert.equal(displays.get('live-thinking-2')?.tokenCount, 50);
  assert.equal(buildLiveTokenDisplays(store.get('other')).size, 0);
});

for (const estimated of [false, true]) {
  for (const count of [0, 187]) {
    test(`usage before text restores ${count} thinking tokens with precision ${estimated}`, () => {
      const usage = buildUsageFrame({ turn: 1, record: { thinkingTokens: count, thinkingTokensEstimated: estimated } });
      const store = new ChatSessionRuntimeStore().ensureSession('s', '')
        .apply({ kind: 'usage', sessionId: 's', usage })
        .apply({ kind: 'usage', sessionId: 's', usage })
        .apply({ kind: 'thinking', sessionId: 's', delta: { turn: 1, offset: 0, text: 'x'.repeat(800) } })
        .apply({ kind: 'usage', sessionId: 's', usage: buildUsageFrame({ turn: 2, record: { thinkingTokens: 999 } }) });
      const display = buildLiveTokenDisplays(store.get('s')).get('live-thinking-1');
      assert.deepEqual(display, { tokenCount: count, exact: !estimated, imageTokens: 0 });
      assert.equal(store.get('s').tokenTurns.size, 2);
    });
  }
}

test('answer promotion estimates only the current answer plus preceding output, then replaces the total', () => {
  let store = start()
    .apply({ kind: 'usage', sessionId: 's', usage: buildUsageFrame({ turn: 1, record: { outputTokens: 60 } }) })
    .apply({ kind: 'prompt', sessionId: 's', prompt: { turn: 2, maxTurns: 20, promptTokens: 50, charsPerToken: 4 } })
    .apply({ kind: 'narration', sessionId: 's', delta: { turn: 2, offset: 0, text: 'x'.repeat(400) } });
  assert.equal(buildLiveTokenDisplays(store.get('s')).get('live-narration-2')?.tokenCount, 0);
  store = store.apply({ kind: 'answer', sessionId: 's', delta: { turn: 2, offset: 0, text: 'x'.repeat(400) } });
  assert.equal(buildLiveTokenDisplays(store.get('s')).get('live-narration-2')?.tokenCount, 160);
  store = store.apply({ kind: 'usage', sessionId: 's', usage: buildUsageFrame({ turn: 2, totals: { outputTokens: 155, outputTokensEstimatedCount: 1 } }) });
  assert.deepEqual(buildLiveTokenDisplays(store.get('s')).get('live-narration-2'), { tokenCount: 155, exact: false, imageTokens: 0 });
  assert.equal(store.get('s').liveMessages.length, 1);
});

test('missing calibration propagates unavailability through aggregate badges until usage recovers', () => {
  let store = new ChatSessionRuntimeStore().ensureSession('s', '')
    .apply({ kind: 'thinking', sessionId: 's', delta: { turn: 1, offset: 0, text: 'replayed' } });
  const runtime = store.get('s');
  const displays = buildLiveTokenDisplays(runtime);
  const turn = groupMessagesIntoTurns(runtime.liveMessages, new Set(runtime.liveMessages.map((message) => message.id)))[0];
  assert.ok(turn);
  assert.deepEqual(getTurnTokenDisplay(turn, displays), { tokenCount: null, exact: false });
  const display = displays.get('live-thinking-1');
  assert.ok(display);
  assert.equal(formatLiveMessageTokenLabel(display), 'tokens unavailable');
  store = store.apply({ kind: 'usage', sessionId: 's', usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 3 } }) });
  assert.equal(buildLiveTokenDisplays(store.get('s')).get('live-thinking-1')?.tokenCount, 3);
});
