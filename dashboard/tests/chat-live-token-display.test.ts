import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatSessionRuntimeStore } from '../src/lib/chat-session-runtime-store';
import { buildLiveTokenDisplays } from '../src/lib/chat-live-token-display';
import { formatLiveMessageTokenLabel, getTurnTokenDisplay } from '../src/lib/format';
import { groupMessagesIntoTurns } from '../src/lib/chatTurns';
import { buildUsageFrame } from './usage-frame';
import { applyLiveTranscript, liveRowId, type LiveTranscriptStep } from './live-transcript-fixture.js';

const PROMPT_1: LiveTranscriptStep = { kind: 'prompt', prompt: { turn: 1, maxTurns: 20, promptTokens: 50, charsPerToken: 4 } };
const store = () => new ChatSessionRuntimeStore().ensureSession('s', '').ensureSession('other', '');

test('estimates use reconstructed content and the prompt belonging to each turn', () => {
  for (const [text, expected] of [['x'.repeat(400), 100], ['x'.repeat(800), 200], ['xxxx', 1]] as const) {
    const seeded = applyLiveTranscript(store(), 's', [PROMPT_1, { kind: 'thinking', delta: { turn: 1, offset: 0, text } }]);
    assert.deepEqual(buildLiveTokenDisplays(seeded.get('s')).get(liveRowId('thinking', 1)), { tokenCount: expected, exact: false, imageTokens: 0 });
    assert.equal(seeded.get('s').liveMessages[0]?.thinkingTokens, 0);
  }
  const seeded = applyLiveTranscript(store(), 's', [
    PROMPT_1, { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'x'.repeat(400) } },
    { kind: 'prompt', prompt: { turn: 2, maxTurns: 20, promptTokens: 50, charsPerToken: 8 } },
    { kind: 'thinking', delta: { turn: 2, offset: 0, text: 'x'.repeat(400) } },
  ]);
  const displays = buildLiveTokenDisplays(seeded.get('s'));
  assert.equal(displays.get(liveRowId('thinking', 1))?.tokenCount, 100);
  assert.equal(displays.get(liveRowId('thinking', 2))?.tokenCount, 50);
  assert.equal(buildLiveTokenDisplays(seeded.get('other')).size, 0);
});

for (const estimated of [false, true]) {
  for (const count of [0, 187]) {
    test(`usage before text restores ${count} thinking tokens with precision ${estimated}`, () => {
      const usage = buildUsageFrame({ turn: 1, record: { thinkingTokens: count, thinkingTokensEstimated: estimated } });
      const seeded = applyLiveTranscript(store(), 's', [
        { kind: 'usage', usage }, { kind: 'usage', usage },
        { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'x'.repeat(800) } },
        { kind: 'usage', usage: buildUsageFrame({ turn: 2, record: { thinkingTokens: 999 } }) },
      ]);
      const display = buildLiveTokenDisplays(seeded.get('s')).get(liveRowId('thinking', 1));
      assert.deepEqual(display, { tokenCount: count, exact: !estimated, imageTokens: 0 });
      assert.equal(seeded.get('s').tokenTurns.size, 2);
    });
  }
}

test('answer promotion estimates only the current answer plus preceding output, then replaces the total', () => {
  const steps: LiveTranscriptStep[] = [
    PROMPT_1, { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { outputTokens: 60 } }) },
    { kind: 'prompt', prompt: { turn: 2, maxTurns: 20, promptTokens: 50, charsPerToken: 4 } },
    { kind: 'narration', delta: { turn: 2, offset: 0, text: 'x'.repeat(400) } },
  ];
  assert.equal(buildLiveTokenDisplays(applyLiveTranscript(store(), 's', steps).get('s')).get(liveRowId('narration', 2))?.tokenCount, 0);
  steps.push({ kind: 'answer', delta: { turn: 2, offset: 0, text: 'x'.repeat(400) } });
  assert.equal(buildLiveTokenDisplays(applyLiveTranscript(store(), 's', steps).get('s')).get(liveRowId('narration', 2))?.tokenCount, 160);
  steps.push({ kind: 'usage', usage: buildUsageFrame({ turn: 2, totals: { outputTokens: 155, outputTokensEstimatedCount: 1 } }) });
  const settled = applyLiveTranscript(store(), 's', steps).get('s');
  assert.deepEqual(buildLiveTokenDisplays(settled).get(liveRowId('narration', 2)), { tokenCount: 155, exact: false, imageTokens: 0 });
  assert.equal(settled.liveMessages.length, 1);
});

test('missing calibration propagates unavailability through aggregate badges until usage recovers', () => {
  const runtime = applyLiveTranscript(store(), 's', [{ kind: 'thinking', delta: { turn: 1, offset: 0, text: 'replayed' } }]).get('s');
  const displays = buildLiveTokenDisplays(runtime);
  const turn = groupMessagesIntoTurns(runtime.liveMessages, new Set(runtime.liveMessages.map((message) => message.id)))[0];
  assert.ok(turn);
  assert.deepEqual(getTurnTokenDisplay(turn, displays), { tokenCount: null, exact: false });
  const display = displays.get(liveRowId('thinking', 1));
  assert.ok(display);
  assert.equal(formatLiveMessageTokenLabel(display), 'tokens unavailable');
  const recovered = applyLiveTranscript(store(), 's', [
    { kind: 'thinking', delta: { turn: 1, offset: 0, text: 'replayed' } },
    { kind: 'usage', usage: buildUsageFrame({ turn: 1, record: { thinkingTokens: 3 } }) },
  ]).get('s');
  assert.equal(buildLiveTokenDisplays(recovered).get(liveRowId('thinking', 1))?.tokenCount, 3);
});
