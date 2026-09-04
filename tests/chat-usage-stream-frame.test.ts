import assert from 'node:assert/strict';
import test from 'node:test';

import { forwardRepoSearchUsageEvent } from '../src/status-server/routes/chat.js';
import type { JsonSerializable } from '../src/lib/json-types.js';

type WrittenEvent = { eventName: string; payload: JsonSerializable };

function createRecordingWriter() {
  const written: WrittenEvent[] = [];
  return {
    written,
    writer: {
      writeEvent(eventName: string, payload: JsonSerializable): void {
        written.push({ eventName, payload });
      },
    },
  };
}

test('the route forwards the usage frame without dropping the record or totals', () => {
  const { written, writer } = createRecordingWriter();
  forwardRepoSearchUsageEvent(writer, {
    kind: 'usage',
    turn: 4,
    maxTurns: 20,
    elapsedMs: 900,
    record: {
      turn: 4,
      promptTokens: 1200,
      thinkingTokens: 210,
      outputTokens: 15,
      toolTokens: 80,
      generatedChars: 900,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 4800,
      thinkingTokens: 640,
      outputTokens: 60,
      toolTokens: 320,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4.28,
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].eventName, 'usage');
  assert.deepEqual(written[0].payload, {
    turn: 4,
    maxTurns: 20,
    record: {
      turn: 4,
      promptTokens: 1200,
      thinkingTokens: 210,
      outputTokens: 15,
      toolTokens: 80,
      generatedChars: 900,
      thinkingTokensEstimated: false,
      outputTokensEstimated: false,
    },
    totals: {
      promptTokens: 4800,
      thinkingTokens: 640,
      outputTokens: 60,
      toolTokens: 320,
      thinkingTokensEstimatedCount: 0,
      outputTokensEstimatedCount: 0,
    },
    charsPerToken: 4.28,
  });
});