import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatusRunStartInput,
  StatusRunRegistry,
  TERMINAL_SNAPSHOT_RETENTION_MS,
  COMPLETED_REQUEST_RETENTION_MS,
  type ActiveRunState,
  type StatusRunStartResult,
} from '../src/status-server/status-run-registry.js';
import { parseStatusMetadata } from '../src/status-server/status-file.js';

function buildStart(requestId: string, nowMs: number) {
  const metadata = parseStatusMetadata(JSON.stringify({
    requestId,
    rawInputCharacterCount: 10,
    promptCharacterCount: 20,
    promptTokenCount: 5,
  }));
  return buildStatusRunStartInput(
    requestId,
    'C:/runtime/status.txt',
    metadata,
    'chat',
    null,
    nowMs,
  );
}

test('parallel requests sharing a status path remain independently active', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.startOrAdvance(buildStart('request-b', 2_000));
  assert.deepEqual(
    registry.getActiveRuns(2_000).map((run) => run.requestId),
    ['request-a', 'request-b'],
  );
});

test('completion moves only the matching request out of active reporting', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.startOrAdvance(buildStart('request-b', 2_000));
  assert.equal(registry.markComplete('request-b', 'completed', 3_000).kind, 'completed');
  assert.deepEqual(registry.getActiveRuns(3_000).map((run) => run.requestId), ['request-a']);
});

test('advance increments stepCount on existing run', () => {
  const registry = new StatusRunRegistry();
  const startResult = registry.startOrAdvance(buildStart('request-a', 1_000));
  assert.equal(startResult.kind, 'started');
  const advanceResult = registry.startOrAdvance(buildStart('request-a', 2_000));
  assert.equal(advanceResult.kind, 'advanced');
  assert.equal(advanceResult.run.stepCount, 2);
});

test('duplicate completion returns duplicate result', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const first = registry.markComplete('request-a', 'completed', 2_000);
  assert.equal(first.kind, 'completed');
  const second = registry.markComplete('request-a', 'completed', 3_000);
  assert.equal(second.kind, 'duplicate');
});

test('metadata before completion finalizes directly from active run', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const resolution = registry.resolveTerminalRun('request-a');
  assert.equal(resolution.kind, 'active');
  const finalize = registry.finalizeTerminal('request-a', 2_000);
  assert.equal(finalize.kind, 'finalized');
  assert.deepEqual(registry.getActiveRuns(2_000).map((r) => r.requestId), []);
});

test('metadata after completion consumes retained snapshot', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const complete = registry.markComplete('request-a', 'completed', 2_000);
  assert.equal(complete.kind, 'completed');
  const resolution = registry.resolveTerminalRun('request-a');
  assert.equal(resolution.kind, 'awaiting');
  const finalize = registry.finalizeTerminal('request-a', 3_000);
  assert.equal(finalize.kind, 'finalized');
});

test('unknown metadata returns unknown result', () => {
  const registry = new StatusRunRegistry();
  const resolution = registry.resolveTerminalRun('unknown-id');
  assert.equal(resolution.kind, 'unknown');
  const finalize = registry.finalizeTerminal('unknown-id', 1_000);
  assert.equal(finalize.kind, 'unknown');
});

test('five-minute terminal snapshot expiry prunes awaiting runs', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  const expired = registry.pruneExpired(2_000 + TERMINAL_SNAPSHOT_RETENTION_MS + 1);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].requestId, 'request-a');
  assert.equal(expired[0].phase, 'awaiting-terminal-metadata');
});

test('fifteen-minute completed tombstone expiry prunes completed runs', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  registry.finalizeTerminal('request-a', 2_000);
  const expired = registry.pruneExpired(2_000 + COMPLETED_REQUEST_RETENTION_MS + 1);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].requestId, 'request-a');
  assert.equal(expired[0].phase, 'completed');
});

test('deterministic ordering by start time then request id', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance({ ...buildStart('request-b', 1_000) });
  registry.startOrAdvance({ ...buildStart('request-a', 1_000) });
  registry.startOrAdvance({ ...buildStart('request-c', 2_000) });
  assert.deepEqual(
    registry.getActiveRuns(2_000).map((run) => run.requestId),
    ['request-a', 'request-b', 'request-c'],
  );
});

test('deterministic ordering reverses when later id precedes earlier id at same time', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance({ ...buildStart('request-z', 1_000) });
  registry.startOrAdvance({ ...buildStart('request-a', 1_000) });
  assert.deepEqual(
    registry.getActiveRuns(1_000).map((run) => run.requestId),
    ['request-a', 'request-z'],
  );
});

test('failed completion moves request out of active reporting', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.startOrAdvance(buildStart('request-b', 2_000));
  const result = registry.markComplete('request-a', 'failed', 3_000);
  assert.equal(result.kind, 'completed');
  assert.deepEqual(registry.getActiveRuns(3_000).map((run) => run.requestId), ['request-b']);
});

test('late start after completion returns late result', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  const late = registry.startOrAdvance(buildStart('request-a', 3_000));
  assert.equal(late.kind, 'late');
});

function requireAdvanced(result: StatusRunStartResult): ActiveRunState {
  if (result.kind !== 'advanced') {
    throw new Error(`Expected advanced result, received ${result.kind}.`);
  }
  return result.run;
}

test('resolveTerminalRun resolves from the request id alone', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const resolution = registry.resolveTerminalRun('request-a');
  assert.equal(resolution.kind, 'active');
});

test('exported ActiveRunState describes the advanced run', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const run = requireAdvanced(registry.startOrAdvance(buildStart('request-a', 2_000)));
  assert.equal(run.requestId, 'request-a');
  assert.equal(run.statusPath, 'C:/runtime/status.txt');
  assert.equal(run.taskKind, 'chat');
  assert.equal(run.outputTokensTotal, 0);
});

test('hasActiveRuns reflects active state', () => {
  const registry = new StatusRunRegistry();
  assert.equal(registry.hasActiveRuns(1_000), false);
  registry.startOrAdvance(buildStart('request-a', 1_000));
  assert.equal(registry.hasActiveRuns(1_000), true);
  registry.markComplete('request-a', 'completed', 2_000);
  assert.equal(registry.hasActiveRuns(2_000), false);
});

test('duplicate finalize returns duplicate result', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  const first = registry.finalizeTerminal('request-a', 3_000);
  assert.equal(first.kind, 'finalized');
  const second = registry.finalizeTerminal('request-a', 4_000);
  assert.equal(second.kind, 'duplicate');
});

test('duplicate resolveTerminalRun returns duplicate result', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  registry.finalizeTerminal('request-a', 3_000);
  const resolution = registry.resolveTerminalRun('request-a');
  assert.equal(resolution.kind, 'duplicate');
});

function buildSparseStart(requestId: string, nowMs: number) {
  const metadata = parseStatusMetadata(JSON.stringify({ requestId }));
  return buildStatusRunStartInput(
    requestId,
    'C:/runtime/status.txt',
    metadata,
    'chat',
    null,
    nowMs,
  );
}

test('advancing with sparse metadata preserves values captured on the first step', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const advanced = registry.startOrAdvance(buildSparseStart('request-a', 2_000));
  if (advanced.kind !== 'advanced') {
    throw new Error(`Expected advanced result, received ${advanced.kind}.`);
  }
  assert.equal(advanced.run.stepCount, 2);
  assert.equal(advanced.run.currentRequestStartedAt, 2_000);
  assert.equal(advanced.run.rawInputCharacterCount, 10);
  assert.equal(advanced.run.promptCharacterCount, 20);
  assert.equal(advanced.run.promptTokenCount, 5);
});

test('advancing with fresh prompt metadata overwrites the previous step values', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  const secondMetadata = parseStatusMetadata(JSON.stringify({
    requestId: 'request-a',
    rawInputCharacterCount: 99,
    promptCharacterCount: 200,
    promptTokenCount: 50,
  }));
  const advanced = registry.startOrAdvance(buildStatusRunStartInput(
    'request-a',
    'C:/runtime/status.txt',
    secondMetadata,
    'chat',
    null,
    2_000,
  ));
  if (advanced.kind !== 'advanced') {
    throw new Error(`Expected advanced result, received ${advanced.kind}.`);
  }
  assert.equal(advanced.run.rawInputCharacterCount, 10);
  assert.equal(advanced.run.promptCharacterCount, 200);
  assert.equal(advanced.run.promptTokenCount, 50);
});

test('completed-without-run when markComplete called without prior start', () => {
  const registry = new StatusRunRegistry();
  const result = registry.markComplete('request-a', 'completed', 1_000);
  assert.equal(result.kind, 'completed-without-run');
});

test('pruneExpired does not remove unexpired awaiting runs', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  const expired = registry.pruneExpired(2_000 + TERMINAL_SNAPSHOT_RETENTION_MS - 1);
  assert.equal(expired.length, 0);
});

test('pruneExpired does not remove unexpired completed tombstones', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  registry.finalizeTerminal('request-a', 2_000);
  const expired = registry.pruneExpired(2_000 + COMPLETED_REQUEST_RETENTION_MS - 1);
  assert.equal(expired.length, 0);
});

test('active runs are excluded from terminal resolution after completion', () => {
  const registry = new StatusRunRegistry();
  registry.startOrAdvance(buildStart('request-a', 1_000));
  registry.markComplete('request-a', 'completed', 2_000);
  const runs = registry.getActiveRuns(2_000);
  assert.equal(runs.length, 0);
});

test('terminal snapshot retention constant is five minutes', () => {
  assert.equal(TERMINAL_SNAPSHOT_RETENTION_MS, 300_000);
});

test('completed request retention constant is fifteen minutes', () => {
  assert.equal(COMPLETED_REQUEST_RETENTION_MS, 900_000);
});
