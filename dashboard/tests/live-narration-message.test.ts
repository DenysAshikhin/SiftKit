import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyNarrationDelta,
  demoteNarrationForTurn,
  liveNarrationMessageId,
  promoteNarrationToAnswer,
} from '../src/lib/live-narration-message';

test('live narration uses stable turn identity across delta, demotion, and promotion', () => {
  const id = liveNarrationMessageId(3);
  const started = applyNarrationDelta([], { turn: 3, offset: 0, text: 'Draft' });
  const extended = applyNarrationDelta(started, { turn: 3, offset: 5, text: ' answer' });
  const demoted = demoteNarrationForTurn(extended, 3);
  const promoted = promoteNarrationToAnswer(demoted, { turn: 3, offset: 0, text: 'Final answer' });

  assert.equal(id, 'assistant-narration-turn-3');
  assert.equal(promoted.length, 1);
  assert.deepEqual({
    id: promoted[0]?.id,
    kind: promoted[0]?.kind,
    content: promoted[0]?.content,
  }, {
    id,
    kind: 'assistant_answer',
    content: 'Final answer',
  });
});
