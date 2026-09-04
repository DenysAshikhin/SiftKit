import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getLiveRunSnapshotPath, getLiveRunsDirectory } from '../src/config/paths.js';
import { CLEAN_STREAM_STOP } from '../src/llm-protocol/types.js';
import { runTaskLoop } from '../src/repo-search/engine.js';
import { resolveRepoSearchPlannerToolDefinitions } from '../src/repo-search/planner-protocol.js';
import { LiveRunSnapshotCollector } from '../src/repo-search/live-snapshot/collector.js';
import { LiveRunSnapshotSchema } from '../src/repo-search/live-snapshot/schemas.js';
import type { JsonObject, JsonSerializable } from '../src/lib/json-types.js';
import { createMockLoopDefaults } from './helpers/mock-loop-defaults.js';
import { parseLoggedEvent } from './helpers/logged-events.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const MOCK_LOOP_DEFAULTS = createMockLoopDefaults('siftkit-live-collector-');

function makeCollector(): LiveRunSnapshotCollector {
  return new LiveRunSnapshotCollector({
    requestId: 'req-1',
    taskKind: 'repo-agent',
    repoRoot: 'C:/repo',
    startedAtMs: Date.now(),
  });
}

test('live run snapshot path lives under the run repo .siftkit/live directory', () => {
  const repoRoot = createManagedTempDir('siftkit-live-path-');

  const directory = getLiveRunsDirectory(repoRoot);
  const filePath = getLiveRunSnapshotPath('6f3951dc-c09c-416a-9d48-eb6a9881aeb3', repoRoot);

  assert.equal(path.basename(directory), 'live');
  assert.equal(path.dirname(filePath), directory);
  assert.equal(path.basename(filePath), 'run-6f3951dc-c09c-416a-9d48-eb6a9881aeb3.json');
});

test('live run snapshot path rejects path separators in the request id', () => {
  const repoRoot = createManagedTempDir('siftkit-live-path-unsafe-');

  const filePath = getLiveRunSnapshotPath('../../etc/passwd', repoRoot);

  assert.equal(path.dirname(filePath), getLiveRunsDirectory(repoRoot));
  assert.equal(path.basename(filePath), 'run-etc-passwd.json');
});

test('collector starts in the starting phase with header fields from run_start', () => {
  const collector = makeCollector();

  collector.record({ kind: 'run_start', repoRoot: 'C:/repo', requestedModel: null, configuredModel: 'model-a', baseUrl: 'http://127.0.0.1:5000' });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.requestId, 'req-1');
  assert.equal(snapshot.taskKind, 'repo-agent');
  assert.equal(snapshot.model, 'model-a');
  assert.equal(snapshot.baseUrl, 'http://127.0.0.1:5000');
  assert.equal(snapshot.pid, process.pid);
  assert.equal(snapshot.phase.name, 'starting');
  assert.equal(snapshot.turns.length, 0);
});

test('collector tracks the in-flight phase through preflight, model request and provider stages', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_preflight_start', taskId: 't', turn: 39, promptChars: 206300 });
  assert.equal(collector.build().phase.name, 'prompt_preflight');
  assert.equal(collector.build().phase.turn, 39);

  collector.record({ kind: 'turn_model_request', taskId: 't', turn: 39, thinkingEnabled: false });
  assert.equal(collector.build().phase.name, 'model_request');

  collector.record({ kind: 'provider_request_start', stage: 'approval_verdict', method: 'POST', url: 'u', path: '/v1/chat/completions' });
  const midFlight = collector.build();
  assert.equal(midFlight.phase.name, 'model_request');
  assert.equal(midFlight.phase.detail, 'stage=approval_verdict');
  assert.equal(midFlight.turns[0].providerRequests[0].elapsedMs, null);
  assert.ok(midFlight.phase.elapsedMs >= 0);
});

test('collector records per-turn prompt budget and model token accounting', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_preflight_start', taskId: 't', turn: 39, promptChars: 206300 });
  collector.record({
    kind: 'turn_preflight_budget', taskId: 't', turn: 39, promptTokenCount: 64552,
    tokenizeElapsedMs: 13, tokenCountSource: 'exl3',
    maxPromptBudget: 120000, overflowTokens: 0, maxOutputTokens: 4096, ok: true, compacted: false,
  });
  collector.record({ kind: 'turn_model_request', taskId: 't', turn: 39, thinkingEnabled: false });
  collector.record({ kind: 'provider_request_start', stage: 'planner_action', method: 'POST', url: 'u', path: '/p' });
  collector.record({ kind: 'provider_request_done', stage: 'planner_action', method: 'POST', url: 'u', path: '/p', statusCode: 200, elapsedMs: 123000 });
  collector.record({
    kind: 'turn_model_response', taskId: 't', turn: 39, text: '{}', thinkingText: '', mockExhausted: false,
    promptTokens: 64552, completionTokens: 71, thinkingTokens: 0, promptCacheTokens: 0, promptEvalTokens: 64552,
    stop: CLEAN_STREAM_STOP,
  });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  const turn = snapshot.turns[0];
  assert.equal(turn.turn, 39);
  assert.equal(turn.promptChars, 206300);
  assert.equal(turn.promptTokens, 64552);
  assert.equal(turn.tokenizeMs, 13);
  assert.equal(turn.tokenSource, 'exl3');
  assert.equal(turn.maxPromptBudget, 120000);
  assert.equal(turn.maxOutputTokens, 4096);
  assert.equal(turn.promptEvalTokens, 64552);
  assert.equal(turn.promptCacheTokens, 0);
  assert.equal(turn.completionTokens, 71);
  assert.equal(turn.providerRequests.length, 1);
  assert.equal(turn.providerRequests[0].stage, 'planner_action');
  assert.equal(turn.providerRequests[0].elapsedMs, 123000);
  assert.equal(turn.providerRequests[0].statusCode, 200);
  assert.ok(turn.modelDurationMs !== null && turn.modelDurationMs >= 0);
  assert.equal(snapshot.phase.name, 'idle');
});

test('collector retains the model stop tuple in the live turn snapshot', () => {
  const collector = makeCollector();

  collector.record({
    kind: 'turn_model_response',
    turn: 1,
    stop: { earlyStopReason: null, backendEosReason: 'loop_detected', finishReason: null },
  });

  const turn = LiveRunSnapshotSchema.parse(collector.build()).turns[0];
  assert.deepEqual(turn.stop, {
    earlyStopReason: null,
    backendEosReason: 'loop_detected',
    finishReason: null,
  });
});

test('collector records provider errors without losing the turn', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_model_request', taskId: 't', turn: 1, thinkingEnabled: false });
  collector.record({ kind: 'provider_request_start', stage: 'planner_action', method: 'POST', url: 'u', path: '/p' });
  collector.record({
    kind: 'provider_request_error', stage: 'planner_action', method: 'POST', url: 'u', path: '/p',
    elapsedMs: 900, error: { code: 'ECONNRESET', message: 'socket hang up' },
  });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.counters.providerErrors, 1);
  assert.equal(snapshot.turns[0].providerRequests[0].elapsedMs, 900);
  assert.ok(String(snapshot.turns[0].providerRequests[0].error).includes('ECONNRESET'));
});

test('collector ignores unknown and malformed events', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_new_messages', taskId: 't', turn: 1, messages: [] });
  collector.record({ kind: 'turn_model_request' });
  collector.record({ notAKind: true });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turns.length, 0);
  assert.equal(snapshot.phase.name, 'starting');
});

test('collector snapshots omit the removed command-safety state', () => {
  const collector = makeCollector();
  collector.record({
    kind: 'turn_command_start', taskId: 't', turn: 1, toolName: 'ls',
    requestedCommand: 'ls path="."', commandToRun: 'ls path="."', native: true,
  });

  const snapshot = collector.build();
  assert.equal(Object.hasOwn(snapshot.turns[0], 'safety'), false);
});

test('collector captures tool execution phase, exit code and truncated output edges', () => {
  const collector = makeCollector();
  const longOutput = `${'A'.repeat(500)}${'B'.repeat(500)}${'C'.repeat(500)}`;

  collector.record({ kind: 'turn_command_start', taskId: 't', turn: 39, toolName: 'run', requestedCommand: 'npm run test', commandToRun: 'npm run test', native: false });

  const midFlight = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(midFlight.phase.name, 'tool_execute');
  assert.equal(midFlight.phase.detail, 'npm run test');
  assert.equal(midFlight.turns[0].tool?.durationMs, null);

  collector.record({
    kind: 'turn_command_result', taskId: 't', turn: 39, command: 'npm run test',
    exitCode: 1, output: longOutput, resultTokenCount: 1064,
  });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  const tool = snapshot.turns[0].tool;
  assert.equal(tool?.toolName, 'run');
  assert.equal(tool?.exitCode, 1);
  assert.equal(tool?.outputChars, 1500);
  assert.equal(tool?.outputTokens, 1064);
  assert.equal(tool?.outputHead.length, 300);
  assert.equal(tool?.outputTail.length, 300);
  assert.equal(tool?.outputHead.startsWith('A'), true);
  assert.equal(tool?.outputTail.endsWith('C'), true);
  assert.ok(tool !== null && tool.durationMs !== null && tool.durationMs >= 0);
  assert.equal(snapshot.counters.nonZeroExits, 1);
  assert.equal(snapshot.phase.name, 'idle');
});

test('collector keeps short tool output whole without a tail', () => {
  const collector = makeCollector();

  collector.record({ kind: 'turn_command_start', taskId: 't', turn: 1, toolName: 'run', requestedCommand: 'git status', commandToRun: 'git status', native: false });
  collector.record({ kind: 'turn_command_result', taskId: 't', turn: 1, command: 'git status', exitCode: 0, output: 'clean', resultTokenCount: 2 });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turns[0].tool?.outputHead, 'clean');
  assert.equal(snapshot.turns[0].tool?.outputTail, '');
  assert.equal(snapshot.counters.nonZeroExits, 0);
});

test('collector counters agree with the task result for one run', async () => {
  const repoRoot = createManagedTempDir('siftkit-live-counters-');
  fs.writeFileSync(path.join(repoRoot, 'target.ts'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'task-live-counters', question: 'Read target file and search.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read', 'git']),
      mockResponses: [
        { toolCalls: [{ name: 'read', arguments: { path: 'target.ts', offset: 1, limit: 3 } }] },
        { toolCalls: [{ name: 'read', arguments: { path: 'target.ts', offset: 1, limit: 3 } }] },
        { toolCalls: [{ name: 'git', arguments: { operation: 'grep', pattern: 'line', path: 'src' } }] },
        { content: 'done' },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      mockCommandResults: {
        'git operation="grep" path="src" pattern="line"': { exitCode: 2, stdout: '', stderr: 'boom' },
      },
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    },
  );

  const collector = makeCollector();
  for (const event of events) {
    collector.record(event);
  }

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(result.rejectedCalls, 1);
  assert.equal(result.nonZeroExits, 1);
  assert.equal(snapshot.counters.rejectedCalls, result.rejectedCalls);
  assert.equal(snapshot.counters.nonZeroExits, result.nonZeroExits);
});

test('a screened call counts as a safety reject in both the task result and the snapshot', async () => {
  const repoRoot = createManagedTempDir('siftkit-live-safety-');
  const events: JsonObject[] = [];
  const result = await runTaskLoop(
    { id: 'task-live-safety', question: 'Read a file that does not exist.' },
    {
      ...MOCK_LOOP_DEFAULTS,
      repoRoot,
      maxTurns: 4,
      maxInvalidResponses: 2,
      minToolCallsBeforeFinish: 0,
      totalContextTokens: 20000,
      plannerToolDefinitions: resolveRepoSearchPlannerToolDefinitions(['read']),
      mockResponses: [
        { toolCalls: [{ name: 'read', arguments: { path: 'absent.ts', offset: 1, limit: 5 } }] },
        { content: 'done' },
        { content: '{"verdict":"pass","reason":"supported"}' },
      ],
      logger: {
        path: 'memory',
        write(event: Record<string, JsonSerializable>) {
          events.push(parseLoggedEvent(event));
        },
      },
    },
  );

  const collector = makeCollector();
  for (const event of events) {
    collector.record(event);
  }

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(result.safetyRejects, 1);
  assert.equal(result.rejectedCalls, 0);
  assert.equal(snapshot.counters.safetyRejects, result.safetyRejects);
  assert.equal(snapshot.counters.rejectedCalls, result.rejectedCalls);
});

test('collector counts denied approvals', () => {
  const collector = makeCollector();

  collector.record({ kind: 'approval_verdict', taskId: 't', turn: 2, toolName: 'run', verdict: 'deny', reason: 'destructive' });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.counters.approvalDenials, 1);
  assert.equal(snapshot.counters.safetyRejects, 0);
  assert.equal(snapshot.turns[0].approval?.verdict, 'deny');
});

test('collector truncates a long command string', () => {
  const collector = makeCollector();
  const longCommand = `git log ${'x'.repeat(1000)}`;

  collector.record({ kind: 'turn_command_start', taskId: 't', turn: 1, toolName: 'run', requestedCommand: longCommand, commandToRun: longCommand, native: false });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turns[0].tool?.command.length, 501);
  assert.equal(snapshot.turns[0].tool?.command.endsWith('…'), true);
});

test('collector keeps only the most recent turns but reports the full count', () => {
  const collector = makeCollector();

  for (let turn = 1; turn <= 120; turn += 1) {
    collector.record({ kind: 'turn_preflight_start', taskId: 't', turn, promptChars: turn });
  }

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.turnsRecorded, 120);
  assert.equal(snapshot.turns.length, 100);
  assert.equal(snapshot.turns[0].turn, 21);
  assert.equal(snapshot.turns[99].turn, 120);
});

test('collector totals and slowest lists summarize every recorded turn', () => {
  const collector = makeCollector();

  const recordTurn = (turn: number, promptEval: number, cache: number, completion: number): void => {
    collector.record({ kind: 'turn_preflight_start', taskId: 't', turn, promptChars: 10 });
    collector.record({ kind: 'turn_model_request', taskId: 't', turn, thinkingEnabled: false });
    collector.record({
      kind: 'turn_model_response', taskId: 't', turn, text: '{}', thinkingText: '', mockExhausted: false,
      promptTokens: 100, completionTokens: completion, thinkingTokens: 0,
      promptCacheTokens: cache, promptEvalTokens: promptEval,
      stop: CLEAN_STREAM_STOP,
    });
  };

  recordTurn(1, 500, 0, 10);
  recordTurn(2, 200, 300, 20);

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.totals.promptEvalTokens, 700);
  assert.equal(snapshot.totals.promptCacheTokens, 300);
  assert.equal(snapshot.totals.completionTokens, 30);
  assert.equal(snapshot.slowest.byModelMs.length, 2);
  assert.equal(snapshot.slowest.byToolMs.length, 0);
  assert.equal(snapshot.counters.turns, 2);
  assert.ok(snapshot.totals.modelMs >= 0);
});

test('collector surfaces run and snapshot write errors', () => {
  const collector = makeCollector();

  collector.recordRunError('planner_preflight_overflow');
  collector.recordWriteError('EPERM: operation not permitted');
  collector.record({ kind: 'task_done', taskId: 't', reason: 'finished', turnsUsed: 3, safetyRejects: 0, invalidResponses: 0, rejectedCalls: 0, nonZeroExits: 0 });

  const snapshot = LiveRunSnapshotSchema.parse(collector.build());
  assert.equal(snapshot.health.lastError, 'planner_preflight_overflow');
  assert.equal(snapshot.health.lastSnapshotWriteError, 'EPERM: operation not permitted');
  assert.equal(snapshot.health.finishReason, 'finished');
  assert.equal(snapshot.phase.name, 'done');
});
