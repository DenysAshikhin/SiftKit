import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatStreamProgressWriter } from '../src/status-server/chat-stream-progress-writer.js';
import { forwardRepoSearchPromptEvent, forwardRepoSearchUsageEvent } from '../src/status-server/chat-stream-frames.js';
import { ChatStreamPromptEventSchema } from '@siftkit/contracts';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { createTestChatRunRecorder } from './helpers/chat-run-recorder.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { getDefaultConfigObject } from '../src/config/defaults.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { join } from 'node:path';

type WrittenEvent = { eventName: string; payload: JsonSerializable };

test('a failed timer flush stops publication and still records a storage-failure terminal outcome', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const root = createManagedTempDir('chat-stream-flush-failure-');
  const recorder = createTestChatRunRecorder(root, createTestChatSession(root), getDefaultConfigObject());
  const { written, writer } = createRecordingWriter();
  const progress = new ChatStreamProgressWriter(writer, null, true, recorder);
  const database = getRuntimeDatabase(join(root, 'runtime.sqlite'));
  database.exec(`CREATE TRIGGER reject_display BEFORE INSERT ON chat_run_events WHEN NEW.kind='display'
    BEGIN SELECT RAISE(ABORT, 'display storage failed'); END;`);
  progress.write({ kind: 'answer', turn: 1, maxTurns: 2, answerText: 'uncommitted fragment' });
  t.mock.timers.tick(1000);
  assert.equal(recorder.abortSignal.aborted, true);
  assert.deepEqual(written, []);
  recorder.finish({ terminalCause: 'storage_failure', detail: 'display storage failed', usage: null, recoveryStatus: 'recovery_needed' });
  assert.equal(new ChatJournalStore(database).readRun(recorder.operationId)?.terminalCause, 'storage_failure');
});

for (const kind of ['thinking', 'narration', 'answer'] as const) {
  for (const prefix of ['', 'x'.repeat(1024)]) {
    test(`usage flushes buffered ${kind}, prefix=${prefix.length}`, (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
      const { written, writer } = createRecordingWriter();
      const root = createManagedTempDir('chat-stream-journal-');
      const recorder = createTestChatRunRecorder(root, createTestChatSession(root), getDefaultConfigObject());
      const progress = new ChatStreamProgressWriter(writer, null, true, recorder);
      t.after(() => progress.flushPending());
      const text = prefix + 'short';
      if (prefix) progress.write({ kind, turn: 1, maxTurns: 2, thinkingText: prefix, narrationText: prefix, answerText: prefix });
      progress.write({ kind, turn: 1, maxTurns: 2, thinkingText: text, narrationText: text, answerText: text });
      progress.write({
        kind: 'usage', turn: 1, maxTurns: 2, elapsedMs: 1, charsPerToken: 4,
        record: { turn: 1, promptTokens: 10, thinkingTokens: 200, outputTokens: 60, toolTokens: 0, generatedChars: 800, thinkingTokensEstimated: true, outputTokensEstimated: false },
        totals: { promptTokens: 10, thinkingTokens: 200, outputTokens: 60, toolTokens: 0, thinkingTokensEstimatedCount: 1, outputTokensEstimatedCount: 0 },
      });
      progress.flushPending();
      assert.deepEqual(written.map((event) => event.eventName), prefix ? [kind, kind, 'usage'] : [kind, 'usage']);
      const committed = new ChatJournalStore(getRuntimeDatabase(join(root, 'runtime.sqlite')))
        .readAfter(recorder.operationId, 0, 100).filter(envelope => envelope.event.kind === 'display');
      assert.equal(committed.length, written.length);
      const stopped = (recorder.stop('user_stop', '*Stopped by user.*').messages ?? []).filter(message => message.role === 'assistant');
      if (kind === 'thinking') {
        assert.equal(stopped[0]?.thinkingTokens, 200);
        assert.equal(stopped[0]?.thinkingTokensEstimated, true);
      }
      if (kind === 'answer') {
        assert.equal(stopped[0]?.outputTokensEstimate, 60);
        assert.match(stopped[0]?.content ?? '', /Stopped by user/u);
      }
    });
  }
}

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
test('the route forwards the prompt frame as the schema the client parses', () => {
  const { written, writer } = createRecordingWriter();
  forwardRepoSearchPromptEvent(writer, {
    kind: 'prompt',
    turn: 2,
    maxTurns: 20,
    promptTokens: 1200,
    charsPerToken: 4.28,
    elapsedMs: 640,
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].eventName, 'prompt');
  assert.deepEqual(written[0].payload, {
    turn: 2, maxTurns: 20, promptTokens: 1200, charsPerToken: 4.28,
  });
  assert.equal(ChatStreamPromptEventSchema.safeParse(written[0].payload).success, true);
});
