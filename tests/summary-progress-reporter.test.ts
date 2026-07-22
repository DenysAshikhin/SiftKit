import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryProgressReporter, type SummaryProgressEvent } from '../src/summary/progress-reporter.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';

test('emits typed events to the writer with requestId stamped', () => {
  const writer = new CollectingProgressWriter<SummaryProgressEvent>();
  const reporter = new SummaryProgressReporter({
    requestId: 'req-1',
    progressWriter: writer,
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
  assert.deepEqual(writer.events.map((event) => event.kind), [
    'start', 'config_start', 'config_done', 'decision_done', 'core_start',
    'tokenize_start', 'tokenize_done', 'core_done', 'completed',
  ]);
  assert.ok(writer.events.every((event) => event.requestId === 'req-1'));
  assert.equal(writer.events[0]?.inputChars, 120);
  assert.equal(writer.events[2]?.model, 'test-model');
});

test('silent writer disables and swallows events', () => {
  const reporter = new SummaryProgressReporter({
    requestId: 'req-2',
    progressWriter: new SilentProgressWriter<SummaryProgressEvent>(),
  });
  reporter.start(5);
  reporter.failed('boom');
  assert.equal(reporter.enabled, false);
});
