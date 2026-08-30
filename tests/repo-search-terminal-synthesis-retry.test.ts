import test from 'node:test';
import assert from 'node:assert/strict';

import { runTaskLoop } from '../src/repo-search/engine.js';
import type { JsonSerializable } from '../src/lib/json-types.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-syn-loop-');

test('synthesis succeeds on attempt 1 sets finalOutput and logs a single result event', async () => {
  const events: Record<string, JsonSerializable>[] = [];
  const result = await runTaskLoop(
    { id: 'task-syn-1', question: 'Any question.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 3,
      mockResponses: [
        // Empty responses strike out at maxInvalidResponses (3), ending the loop
        // inside the finishing-headroom turns; synthesis consumes the next mock.
        {},
        {},
        {},
        { content: 'The definition lives in src/foo.ts:1.' },
      ],
      mockCommandResults: {},
      logger: { path: 'memory', write: (event) => { events.push(event); } },
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
  const events: Record<string, JsonSerializable>[] = [];
  const result = await runTaskLoop(
    { id: 'task-syn-3', question: 'Any question.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      maxTurns: 1,
      maxInvalidResponses: 3,
      mockResponses: [
        // Empty responses strike out at maxInvalidResponses (3), ending the loop
        // inside the finishing-headroom turns; synthesis consumes the next mocks.
        {},
        {},
        {},
        { content: '' },
        { content: '' },
        { content: 'Summary emitted on third attempt.' },
      ],
      mockCommandResults: {},
      logger: { path: 'memory', write: (event) => { events.push(event); } },
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
  const events: Record<string, JsonSerializable>[] = [];
  await assert.rejects(
    runTaskLoop(
      { id: 'task-syn-fail', question: 'Any question.' },
      {
        ...MOCK_LOOP_DEFAULTS,
        maxTurns: 1,
        maxInvalidResponses: 3,
        mockResponses: [
          // Empty responses strike out at maxInvalidResponses (3), ending the loop
          // inside the finishing-headroom turns; synthesis consumes the next mocks.
          {},
          {},
          {},
          { content: '' },
          { content: '' },
          { content: '' },
        ],
        mockCommandResults: {},
        logger: { path: 'memory', write: (event) => { events.push(event); } },
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
      { id: 'task-syn-exhaust', question: 'Any question.' },
      {
        ...MOCK_LOOP_DEFAULTS,
        maxTurns: 1,
        maxInvalidResponses: 3,
        mockResponses: [{}],
        mockCommandResults: {},
      }
    ),
    /Terminal synthesis produced no usable output after 3 attempts/u
  );
});
