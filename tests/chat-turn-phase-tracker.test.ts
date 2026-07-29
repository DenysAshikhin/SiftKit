import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatTurnPhaseTracker } from '../src/status-server/chat-turn-phase-tracker.js';

const REQUEST_STARTED_AT_UTC = '2026-07-29T00:00:00.000Z';

test('chat phase tracker starts empty and ignores whitespace', () => {
  const tracker = new ChatTurnPhaseTracker(REQUEST_STARTED_AT_UTC);

  tracker.observeThinking(' \n');
  tracker.observeAnswer('\t');

  assert.deepEqual(tracker.snapshot(), {
    requestStartedAtUtc: REQUEST_STARTED_AT_UTC,
    thinkingStartedAtUtc: null,
    thinkingEndedAtUtc: null,
    answerStartedAtUtc: null,
    answerEndedAtUtc: null,
  });
});

test('chat phase tracker retains phase starts across later content', () => {
  const tracker = new ChatTurnPhaseTracker(REQUEST_STARTED_AT_UTC);

  tracker.observeThinking('first thought');
  const firstThinking = tracker.snapshot();
  assert.equal(typeof firstThinking.thinkingStartedAtUtc, 'string');
  assert.equal(typeof firstThinking.thinkingEndedAtUtc, 'string');

  tracker.observeThinking('second thought');
  const secondThinking = tracker.snapshot();
  assert.equal(secondThinking.thinkingStartedAtUtc, firstThinking.thinkingStartedAtUtc);
  assert.equal(typeof secondThinking.thinkingEndedAtUtc, 'string');

  tracker.observeAnswer('first answer');
  const firstAnswer = tracker.snapshot();
  assert.equal(typeof firstAnswer.answerStartedAtUtc, 'string');
  assert.equal(typeof firstAnswer.answerEndedAtUtc, 'string');

  tracker.observeAnswer('second answer');
  const secondAnswer = tracker.snapshot();
  assert.equal(secondAnswer.answerStartedAtUtc, firstAnswer.answerStartedAtUtc);
  assert.equal(typeof secondAnswer.answerEndedAtUtc, 'string');
});
