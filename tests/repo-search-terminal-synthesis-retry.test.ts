import test from 'node:test';
import assert from 'node:assert/strict';

import { runTaskLoop } from '../src/repo-search/engine.js';

type LogEvent = Record<string, unknown> & { kind: string };

test('synthesis succeeds on attempt 1 sets finalOutput and logs a single result event', async () => {
  const events: LogEvent[] = [];
  const result = await runTaskLoop(
    { id: 'task-syn-1', question: 'Any question.', signals: [] },
    {
      maxTurns: 1,
      maxInvalidResponses: 3,
      mockResponses: [
        'not a valid action',
        'The definition lives in src/foo.ts:1.',
      ],
      mockCommandResults: {},
      logger: { write: (event: LogEvent) => { events.push(event); } },
    }
  );
  assert.equal(result.finalOutput, 'The definition lives in src/foo.ts:1.');
  const requestedEvents = events.filter((event) => event.kind === 'task_terminal_synthesis_requested');
  const resultEvents = events.filter((event) => event.kind === 'task_terminal_synthesis_result');
  const retryEvents = events.filter((event) => event.kind === 'task_terminal_synthesis_retry');
  assert.equal(requestedEvents.length, 1);
  assert.equal(resultEvents.length, 1);
  assert.equal(retryEvents.length, 0);
  assert.equal(resultEvents[0].attempt, 1);
});

test('synthesis that returns empty text twice then succeeds on attempt 3 sets finalOutput', async () => {
  const events: LogEvent[] = [];
  const result = await runTaskLoop(
    { id: 'task-syn-3', question: 'Any question.', signals: [] },
    {
      maxTurns: 1,
      maxInvalidResponses: 3,
      mockResponses: [
        'invalid turn response',
        '',
        '',
        'Summary emitted on third attempt.',
      ],
      mockCommandResults: {},
      logger: { write: (event: LogEvent) => { events.push(event); } },
    }
  );
  assert.equal(result.finalOutput, 'Summary emitted on third attempt.');
  const retryEvents = events.filter((event) => event.kind === 'task_terminal_synthesis_retry');
  const resultEvents = events.filter((event) => event.kind === 'task_terminal_synthesis_result');
  assert.equal(retryEvents.length, 2);
  assert.equal(retryEvents[0].attempt, 1);
  assert.equal(retryEvents[1].attempt, 2);
  assert.equal(resultEvents.length, 1);
  assert.equal(resultEvents[0].attempt, 3);
});

test('synthesis that returns empty text 3 times throws a hard-fail error', async () => {
  const events: LogEvent[] = [];
  await assert.rejects(
    runTaskLoop(
      { id: 'task-syn-fail', question: 'Any question.', signals: [] },
      {
        maxTurns: 1,
        maxInvalidResponses: 3,
        mockResponses: [
          'invalid turn response',
          '',
          '',
          '',
        ],
        mockCommandResults: {},
        logger: { write: (event: LogEvent) => { events.push(event); } },
      }
    ),
    /Terminal synthesis produced no usable output after 3 attempts/u
  );
  const retryEvents = events.filter((event) => event.kind === 'task_terminal_synthesis_retry');
  const failedEvents = events.filter((event) => event.kind === 'task_terminal_synthesis_failed');
  assert.equal(retryEvents.length, 3);
  assert.equal(failedEvents.length, 1);
});

test('synthesis with exhausted mocks throws after 3 attempts (no silent dump fallback)', async () => {
  await assert.rejects(
    runTaskLoop(
      { id: 'task-syn-exhaust', question: 'Any question.', signals: [] },
      {
        maxTurns: 1,
        maxInvalidResponses: 3,
        mockResponses: ['invalid turn response'],
        mockCommandResults: {},
      }
    ),
    /Terminal synthesis produced no usable output after 3 attempts/u
  );
});
