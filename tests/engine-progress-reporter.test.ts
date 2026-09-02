import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.js';
import type { ActivitySummaryProgressEvent, RepoSearchProgressEvent } from '../src/repo-search/types.js';
import { SilentProgressWriter } from '../src/lib/progress-writer.js';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.js';

function collect(): { writer: CollectingProgressWriter<RepoSearchProgressEvent>; events: RepoSearchProgressEvent[]; reporter: ProgressReporter } {
  const writer = new CollectingProgressWriter<RepoSearchProgressEvent>();
  const reporter = new ProgressReporter({
    progressWriter: writer,
    taskId: 't1',
    maxTurns: 45,
    taskStartedAt: Date.now(),
  });
  return { writer, events: writer.events, reporter };
}

test('enabled reflects writer behavior; silent writer emits nothing', () => {
  const disabled = new ProgressReporter({
    progressWriter: new SilentProgressWriter<RepoSearchProgressEvent>(),
    taskId: 't1',
    maxTurns: 45,
    taskStartedAt: Date.now(),
  });
  assert.equal(disabled.enabled, false);
  disabled.llmStart(1, 100, 0);
  disabled.thinking(1, 'x');
  const { reporter } = collect();
  assert.equal(reporter.enabled, true);
});

test('preflightStart/preflightDone/llmStart/llmEnd carry task fields and elapsedMs', () => {
  const { writer, events, reporter } = collect();
  reporter.preflightStart(2, 1234);
  reporter.preflightDone(2, 1234, 567);
  reporter.llmStart(2, 567, 42);
  reporter.llmEnd(2, 567, 42);
  assert.deepEqual(events.map((event) => event.kind), ['preflight_start', 'preflight_done', 'llm_start', 'llm_end']);
  const start = writer.ofKind('preflight_start')[0];
  assert.ok(start);
  assert.equal(start.taskId, 't1');
  assert.equal(start.turn, 2);
  assert.equal(start.maxTurns, 45);
  assert.equal(start.promptChars, 1234);
  assert.ok(start.elapsedMs >= 0);
});

test('getMaxTurns returns the configured maximum', () => {
  const { reporter } = collect();
  assert.equal(reporter.getMaxTurns(), 45);
});

test('activitySummary preserves the typed payload', () => {
  const { events, reporter } = collect();
  const summary: ActivitySummaryProgressEvent = {
    kind: 'activity_summary',
    turn: 10,
    maxTurns: 45,
    entries: [
      { category: 'read_files', label: 'src/foo.ts', failed: false },
      { category: 'commands', label: 'npm test', failed: true },
    ],
  };
  reporter.activitySummary(summary);
  assert.equal(events.length, 1);
  const emitted = events[0];
  assert.equal(emitted.kind, 'activity_summary');
  assert.equal(emitted.turn, 10);
  assert.equal(emitted.maxTurns, 45);
  assert.equal(emitted.entries?.length, 2);
  assert.equal(emitted.entries?.[0]?.category, 'read_files');
  assert.equal(emitted.entries?.[0]?.label, 'src/foo.ts');
  assert.equal(emitted.entries?.[0]?.failed, false);
  assert.equal(emitted.entries?.[1]?.category, 'commands');
  assert.equal(emitted.entries?.[1]?.label, 'npm test');
  assert.equal(emitted.entries?.[1]?.failed, true);
});

test('thinking/narration/answer/toolStart/toolResult pass payloads through unchanged', () => {
  const { writer, events, reporter } = collect();
  reporter.thinking(3, 'partial thought');
  reporter.narration(3, 'reading files');
  reporter.answer(3, 'final answer');
  reporter.toolStart('tc_0', 3, 'search', { kind: 'none' }, 'rg -n foo', 500, 77);
  reporter.toolResult({
    toolCallId: 'tc_0', turn: 3, activityKind: 'search', activitySubject: { kind: 'none' }, command: 'rg -n foo', exitCode: 0,
    outputSnippet: 'snippet', outputTokens: 12, outputTokensEstimated: false,
    promptTokenCount: 500, thinkingTokenCount: 77,
  });
  assert.deepEqual(events.map((event) => event.kind), ['thinking', 'narration', 'answer', 'tool_start', 'tool_result']);
  assert.equal(events[1].kind === 'narration' ? events[1].narrationText : null, 'reading files');
  assert.match(JSON.stringify(events[3]), /"activityKind":"search"/u);
  assert.match(JSON.stringify(events[4]), /"activityKind":"search"/u);
  const toolStart = writer.ofKind('tool_start')[0];
  const toolResult = writer.ofKind('tool_result')[0];
  assert.ok(toolStart);
  assert.ok(toolResult);
  assert.equal(toolStart.maxTurns, 45);
  assert.equal(toolResult.maxTurns, 45);
  // The turn cap crosses the wire only as maxTurns; a second name for it is rejected.
  assert.equal(JSON.stringify(toolStart).includes('toolCallLimit'), false);
  assert.equal(JSON.stringify(toolResult).includes('toolCallLimit'), false);
});

test('tokenizeStart/tokenizeDone mirror the preflight tokenize event shape', () => {
  const { events, reporter } = collect();
  reporter.tokenizeStart(1, 999);
  reporter.tokenizeDone(1, 999, {
    promptTokenCount: 40, tokenCountSource: 'exl3',
    tokenizeElapsedMs: 5, tokenizeRetryCount: 0,
    tokenizeTimeoutMs: 10_000, tokenizeRetryMaxWaitMs: 30_000,
    tokenizeStatus: 'ok', tokenizeErrorMessage: null,
  });
  assert.equal(events[0].kind, 'preflight_tokenize_start');
  assert.equal(events[0].tokenizeTimeoutMs, 10_000);
  assert.equal(events[0].tokenizeRetryMaxWaitMs, 30_000);
  assert.equal(events[1].kind, 'preflight_tokenize_done');
  assert.equal(events[1].promptTokenCount, 40);
});

test('tokenizeDone omits optional fields when they are null or absent', () => {
  const { events, reporter } = collect();
  reporter.tokenizeDone(1, 100, {
    promptTokenCount: 12,
    tokenizeElapsedMs: null,
    tokenizeRetryCount: null,
    tokenizeStatus: null,
    tokenizeErrorMessage: null,
  });
  const event = events[0];
  assert.equal(event.kind, 'preflight_tokenize_done');
  assert.equal(event.tokenizeElapsedMs, undefined);
  assert.equal(event.tokenizeRetryCount, undefined);
  assert.equal(event.tokenizeStatus, undefined);
  assert.equal(event.errorMessage, undefined);
});
