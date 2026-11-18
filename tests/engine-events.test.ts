import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { closeAllRuntimeDatabases, getRuntimeDatabase, pruneRuntimeHistory } from '../src/state/runtime-db.ts';
import {
  countPromptCacheBreaksByRun,
  deleteEngineEventsForInferenceRun,
  deleteEngineEventsForRuns,
  ENGINE_EVENT_DETAIL_MAX_CHARS,
  insertEngineEvent,
  listEngineEvents,
  type EngineEventInput,
} from '../src/state/engine-events.ts';
import { createManagedTempDir } from './helpers/temp-dirs.ts';

const CACHE_BREAK: EngineEventInput = {
  kind: 'prompt_cache_break', inferenceRunId: null, runId: 'run-a', turn: 3,
  summary: 'Turn 3 re-prefilled 9,000 tokens; the prompt grew 100', detail: 'turn: 3',
};
const ENGINE_ERROR: EngineEventInput = {
  kind: 'engine_error', inferenceRunId: 'engine-1', runId: null, turn: null,
  summary: 'Exception in ASGI application', detail: `${'x'.repeat(ENGINE_EVENT_DETAIL_MAX_CHARS + 10)}TAIL`,
};

function openDatabase() {
  const dbPath = path.join(createManagedTempDir('engine-events-'), 'runtime.sqlite');
  return { dbPath, database: getRuntimeDatabase(dbPath) };
}

test('engine events list newest first, count cache breaks per run, and keep the end of a long detail', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { database } = openDatabase();
  insertEngineEvent(database, CACHE_BREAK);
  insertEngineEvent(database, { ...CACHE_BREAK, turn: 5 });
  insertEngineEvent(database, ENGINE_ERROR);

  const events = listEngineEvents(database, 10);
  assert.deepEqual(events.map((event) => [event.kind, event.turn]), [['engine_error', null], ['prompt_cache_break', 5], ['prompt_cache_break', 3]]);
  assert.equal(events[0]?.detail.length, ENGINE_EVENT_DETAIL_MAX_CHARS);
  assert.ok(events[0]?.detail.endsWith('TAIL'));
  assert.equal(listEngineEvents(database, 1).length, 1);
  assert.deepEqual([...countPromptCacheBreaksByRun(database, ['run-a', 'run-b'])], [['run-a', 2]]);
  assert.deepEqual([...countPromptCacheBreaksByRun(database, [])], []);
});

test('engine events are deleted with their runs, with their engine run, and by history pruning', (t) => {
  t.after(closeAllRuntimeDatabases);
  const { dbPath, database } = openDatabase();
  insertEngineEvent(database, CACHE_BREAK);
  insertEngineEvent(database, ENGINE_ERROR);

  assert.equal(deleteEngineEventsForRuns(database, ['run-a']), 1);
  assert.equal(deleteEngineEventsForRuns(database, []), 0);
  assert.equal(deleteEngineEventsForInferenceRun(database, 'engine-1'), 1);

  insertEngineEvent(database, CACHE_BREAK);
  database.prepare("UPDATE engine_events SET occurred_at_utc = '2000-01-01T00:00:00.000Z'").run();
  pruneRuntimeHistory(1, dbPath);
  assert.deepEqual(listEngineEvents(database, 10), []);
});
