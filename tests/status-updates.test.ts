import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ProgressReporter } from '../src/repo-search/engine/progress-reporter.ts';
import {
  STATUS_UPDATE_ASKED_WORDS,
  buildStatusUpdateInstruction, parseStatusUpdate, StatusUpdates, type StatusUpdateRequester,
} from '../src/repo-search/engine/status-updates.ts';
import type { PlannerActionResponse } from '../src/repo-search/planner-protocol.ts';
import type { JsonLogger, RepoSearchProgressEvent } from '../src/repo-search/types.ts';
import { JsonObjectSchema, type JsonObject } from '../src/lib/json-types.ts';
import { parseJsonValueText } from '../src/lib/json.ts';
import { emptyInferenceThroughput } from '../src/lib/inference-throughput.ts';
import { completeLiveContent } from '../src/llm-protocol/live-content-classifier.ts';
import { CLEAN_STREAM_STOP, type InferenceToolCall } from '../src/llm-protocol/types.ts';
import { CollectingProgressWriter } from './helpers/collecting-progress-writer.ts';

type Pending = { instruction: string; abortSignal: AbortSignal; resolve(response: PlannerActionResponse): void; reject(error: Error): void };

/** An engine whose answers the test gives by hand. */
class ScriptedEngine implements StatusUpdateRequester {
  readonly requests: Pending[] = [];
  /** A stalled engine does not react to the cancellation. */
  stalled = false;

  requestStatusUpdate(instruction: string, abortSignal: AbortSignal): Promise<PlannerActionResponse> {
    return new Promise((resolve, reject) => {
      this.requests.push({ instruction, abortSignal, resolve, reject });
      if (!this.stalled) abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }

  latest(): Pending {
    const pending = this.requests.at(-1);
    assert.ok(pending);
    return pending;
  }
}

function reply(text: string, toolCalls: InferenceToolCall[] = []): PlannerActionResponse {
  return {
    ...completeLiveContent(text, toolCalls.length > 0), thinkingText: '', toolCalls, mockExhausted: false,
    throughput: emptyInferenceThroughput(), stop: CLEAN_STREAM_STOP, promptCacheTokens: 900, promptEvalTokens: 40,
  };
}

function setUp(): { engine: ScriptedEngine; updates: StatusUpdates; shown: RepoSearchProgressEvent[]; log: JsonObject[] } {
  const engine = new ScriptedEngine();
  const progress = new CollectingProgressWriter<RepoSearchProgressEvent>();
  const log: JsonObject[] = [];
  const logger: JsonLogger = { path: 'memory', write(event) { log.push(JsonObjectSchema.parse(parseJsonValueText(JSON.stringify(event)))); } };
  const updates = new StatusUpdates({
    requester: engine, logger,
    progress: new ProgressReporter({ progressWriter: progress, taskId: 'task', maxTurns: 10, taskStartedAt: 0 }),
  });
  return { engine, updates, shown: progress.events, log };
}

function start(updates: StatusUpdates, command = 'npm test'): void {
  updates.toolStarted({ turn: 4, toolName: 'run', activityKind: 'validate', command });
}

function read(updates: StatusUpdates): void {
  updates.toolStarted({ turn: 4, toolName: 'read', activityKind: 'read', command: 'read path="a"' });
  updates.toolFinished();
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function mockClock(context: TestContext): void {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
}

test('a check is written about after 3 seconds, once a minute, and never when it ends sooner', async (context) => {
  mockClock(context);
  const { engine, updates, shown, log } = setUp();

  start(updates);
  context.mock.timers.tick(2_999);
  updates.toolFinished();
  context.mock.timers.tick(10_000);
  assert.equal(engine.requests.length, 0);

  // Still due: a plain command is enough to carry the update the check asked for.
  updates.toolStarted({ turn: 5, toolName: 'run', activityKind: 'command', command: 'git status' });
  context.mock.timers.tick(3_000);
  assert.equal(engine.requests.length, 1);
  assert.match(engine.latest().instruction, /^This command is running now: git status\nYour latest steps, oldest first:\n- validate: npm test\n/u);
  engine.latest().resolve(reply('Making sure the fix holds before moving on.'));
  await flush();
  updates.toolFinished();
  assert.equal(shown.length, 1);
  const [event] = shown;
  assert.ok(event && event.kind === 'status_update');
  assert.deepEqual([event.turn, event.text], [5, 'Making sure the fix holds before moving on.']);

  // Requests start at least a minute apart; a window opening sooner waits for the minute.
  start(updates);
  context.mock.timers.tick(56_000);
  assert.equal(engine.requests.length, 1);
  context.mock.timers.tick(4_000);
  assert.equal(engine.requests.length, 2);
  assert.match(engine.latest().instruction, /Your last update was: "Making sure the fix holds before moving on\." Do not repeat it\./u);
  assert.deepEqual(log.map((entry) => [entry.kind, entry.outcome, entry.promptCacheTokens, entry.promptEvalTokens]),
    [['status_update', 'shown', 900, 40]]);
});

test('ten finished calls make an update due, and reads alone never ask for one', (context) => {
  mockClock(context);
  const { engine, updates } = setUp();
  for (let index = 0; index < 9; index += 1) read(updates);
  updates.toolStarted({ turn: 4, toolName: 'run', activityKind: 'command', command: 'node build.js' });
  context.mock.timers.tick(30_000);
  assert.equal(engine.requests.length, 0);
  updates.toolFinished();
  updates.toolStarted({ turn: 4, toolName: 'read', activityKind: 'read', command: 'read path="big"' });
  context.mock.timers.tick(30_000);
  updates.toolFinished();
  assert.equal(engine.requests.length, 0);
  updates.toolStarted({ turn: 4, toolName: 'job', activityKind: 'command', command: 'job action="wait"' });
  context.mock.timers.tick(3_000);
  assert.equal(engine.requests.length, 1);
  // The five newest steps are named, not the running command itself.
  assert.equal(engine.latest().instruction.split('\n').filter((line) => line.startsWith('- ')).length, 5);
});

test('the command ending cancels the request, shows nothing, and asks again only for a later cause', async (context) => {
  mockClock(context);
  const { engine, updates, shown, log } = setUp();
  start(updates);
  context.mock.timers.tick(3_000);
  updates.toolFinished();
  assert.equal(engine.latest().abortSignal.aborted, true);
  await updates.settle();
  assert.equal(shown.length, 0);
  assert.deepEqual(log.map((entry) => entry.outcome), ['cancelled']);
  updates.toolStarted({ turn: 5, toolName: 'run', activityKind: 'command', command: 'node build.js' });
  context.mock.timers.tick(120_000);
  assert.equal(engine.requests.length, 1);
});

test('a stalled engine holds the run up for a second at most, and its late answer is dropped', async () => {
  const { engine, updates, shown, log } = setUp();
  engine.stalled = true;
  start(updates);
  while (engine.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  // Nothing more is asked while that request is out.
  updates.toolFinished();
  const startedAt = performance.now();
  await updates.settle();
  const waitedMs = performance.now() - startedAt;
  assert.ok(waitedMs >= 900 && waitedMs < 1_500, `waited ${waitedMs} ms`);
  engine.latest().resolve(reply('Too late.'));
  await updates.settle();
  assert.equal(shown.length, 0);
  assert.deepEqual(log.map((entry) => entry.outcome), ['late']);
});

test('one request is out at a time, however long the engine holds it', (context) => {
  mockClock(context);
  const { engine, updates } = setUp();
  engine.stalled = true;
  start(updates);
  context.mock.timers.tick(3_000);
  updates.toolFinished();
  context.mock.timers.tick(120_000);
  start(updates);
  context.mock.timers.tick(120_000);
  assert.equal(engine.requests.length, 1);
});

test('a failed request, a tool call and a broken rule show nothing', async (context) => {
  mockClock(context);
  const { engine, updates, shown, log } = setUp();
  const answers: Array<PlannerActionResponse | Error> = [
    new Error('engine down'),
    reply('Reading on.', [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }]),
    reply('Editing src/a.ts now.'),
  ];
  for (const answer of answers) {
    start(updates);
    context.mock.timers.tick(60_000);
    if (answer instanceof Error) engine.latest().reject(answer);
    else engine.latest().resolve(answer);
    await flush();
    updates.toolFinished();
  }
  assert.equal(engine.requests.length, 3);
  assert.equal(shown.length, 0);
  assert.deepEqual(log.map((entry) => entry.outcome).slice(0, 2), ['failed: engine down', 'rejected: it called a tool']);
  assert.match(String(log[2]?.outcome), /^rejected: /u);
});

test('a reply is shown only as one short plain paragraph', () => {
  assert.deepEqual(parseStatusUpdate('  Making sure the two\nparts agree. '), { ok: true, text: 'Making sure the two parts agree.' });
  assert.equal(parseStatusUpdate('I will read the rest and run the check again.').ok, true);
  assert.equal(parseStatusUpdate(Array(45).fill('word').join(' ')).ok, true);
  for (const refused of [
    ' \n ', Array(46).fill('word').join(' '), 'One thing.\n\nAnother thing.', 'Checking `total` now.', 'Editing src/a.ts now.', 'Waiting for run_check.',
  ]) assert.equal(parseStatusUpdate(refused).ok, false, refused);
});

test('the instruction leaves out what there is nothing to say about', () => {
  const bare = buildStatusUpdateInstruction({ command: 'npm test', recent: [], previous: null });
  assert.doesNotMatch(bare, /latest steps|last update/u);
  assert.match(bare, new RegExp(`at most ${STATUS_UPDATE_ASKED_WORDS} words`, 'u'));
  assert.match(bare, /Do not call a tool/u);
});
