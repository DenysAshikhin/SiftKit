import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryProgressReporter, type SummaryProgressEvent } from '../src/summary/progress-reporter.js';

test('emits typed events to the sink with requestId stamped', () => {
  const events: SummaryProgressEvent[] = [];
  const reporter = new SummaryProgressReporter({
    requestId: 'req-1',
    onProgress: (event) => events.push(event),
  });
  reporter.start(120);
  reporter.configStart('load');
  reporter.configDone('llama.cpp', 'test-model');
  reporter.decisionDone('llama.cpp', false, 120);
  reporter.coreStart('llama.cpp');
  reporter.tokenizeStart('planner', 'chunk-1', 900);
  reporter.tokenizeDone('planner', 'chunk-1', 250, 'server');
  reporter.coreDone('llama.cpp');
  reporter.completed('summary');
  assert.deepEqual(events.map((event) => event.kind), [
    'start', 'config_start', 'config_done', 'decision_done', 'core_start',
    'tokenize_start', 'tokenize_done', 'core_done', 'completed',
  ]);
  assert.ok(events.every((event) => event.requestId === 'req-1'));
  assert.equal(events[0]?.inputChars, 120);
  assert.equal(events[2]?.model, 'test-model');
});

test('null sink swallows events', () => {
  const reporter = new SummaryProgressReporter({ requestId: 'req-2', onProgress: null });
  reporter.start(5);
  reporter.failed('boom');
  assert.equal(reporter.enabled, false);
});
