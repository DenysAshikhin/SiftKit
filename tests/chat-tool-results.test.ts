import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { getRuntimeDatabase, closeAllRuntimeDatabases, type RuntimeDatabase } from '../src/state/runtime-db.js';
import {
  ChatToolResultsError,
  requireDurableToolResult,
  type ChatToolResultsFailure,
} from '../src/status-server/chat-tool-results.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { readChatToolResults } from './helpers/chat-tool-results.js';

function isReaderFailure(reason: ChatToolResultsFailure): (error: Error) => boolean {
  return (error) => error instanceof ChatToolResultsError && error.reason === reason;
}

const SENTINEL = 'sentinel-after-character-200';
const LONG_OUTPUT = `${'x'.repeat(240)}\n${SENTINEL}\nline three`;

function openDatabase(): RuntimeDatabase {
  closeAllRuntimeDatabases();
  return getRuntimeDatabase(path.join(createManagedTempDir('siftkit-chat-tool-results-'), 'runtime.sqlite'));
}

type TranscriptEvent = Record<string, string | number | null>;

function startEvent(toolCallId: string, turn: number, command: string): TranscriptEvent {
  return { kind: 'turn_command_start', turn, toolCallId, toolName: 'read', commandToRun: command };
}

function executedEvent(options: {
  toolCallId: string;
  turn: number;
  requestedCommand: string;
  executedCommand?: string;
  exitCode?: number;
  output: string;
}): TranscriptEvent {
  const executedCommand = options.executedCommand ?? options.requestedCommand;
  return {
    kind: 'turn_command_result',
    turn: options.turn,
    toolCallId: options.toolCallId,
    command: executedCommand,
    requestedCommand: options.requestedCommand,
    executedCommand,
    exitCode: options.exitCode ?? 0,
    output: options.output,
    insertedResultText: options.output,
  };
}

function rejectedEvent(toolCallId: string, turn: number, command: string, output: string): TranscriptEvent {
  return {
    kind: 'turn_command_result',
    turn,
    toolCallId,
    command,
    toolName: 'write',
    exitCode: null,
    output,
    rejectionKind: 'safety',
    rejectionReason: 'denied',
  };
}

function toJsonl(events: readonly TranscriptEvent[]): string {
  return events.map((event) => `${JSON.stringify({ at: '2026-09-09T00:00:00.000Z', ...event })}\n`).join('');
}

function seedArtifact(database: RuntimeDatabase, requestId: string, text: string, id = `artifact:${requestId}`): void {
  database.prepare(`
    INSERT INTO runtime_artifacts (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
    VALUES (?, 'repo_search_transcript', ?, 'transcript', ?, NULL, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')
  `).run(id, requestId, text);
}

function seedRunLog(database: RuntimeDatabase, requestId: string, text: string | null, runId = requestId): void {
  database.prepare(`
    INSERT INTO run_logs (
      run_id, request_id, run_kind, run_group, terminal_state, title,
      repo_search_transcript_jsonl, source_paths_json, flushed_at_utc
    ) VALUES (?, ?, 'repo_search', 'repo_search', 'completed', 'run', ?, '[]', '2026-09-09T00:00:00.000Z')
  `).run(runId, requestId, text);
}

test('a canonical outcome keeps the exact model-visible text past the preview cut', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-full', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: LONG_OUTPUT }),
  ]));
  const results = readChatToolResults(database, 'req-full');
  assert.equal(results.source, 'runtime_artifact');
  assert.equal(results.outcomes.length, 1);
  const outcome = results.outcomes[0];
  assert.ok(outcome);
  assert.equal(outcome.output, LONG_OUTPUT);
  assert.equal(outcome.output.includes(SENTINEL), true);
  assert.equal(results.startedWithoutResult.length, 0);
});

test('empty, Unicode and legitimately truncated outputs survive unchanged', () => {
  const database = openDatabase();
  const unicode = 'héllo\n\n世界 — line\n';
  const truncated = 'first line\n[output truncated]\n...';
  seedArtifact(database, 'req-shapes', toJsonl([
    startEvent('tc_0', 1, 'run command="true"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'run command="true"', output: '' }),
    startEvent('tc_1', 1, 'read path="u.ts"'),
    executedEvent({ toolCallId: 'tc_1', turn: 1, requestedCommand: 'read path="u.ts"', output: unicode }),
    startEvent('tc_2', 2, 'read path="big.ts"'),
    executedEvent({ toolCallId: 'tc_2', turn: 2, requestedCommand: 'read path="big.ts"', output: truncated }),
  ]));
  const outputs = readChatToolResults(database, 'req-shapes').outcomes.map((outcome) => outcome.output);
  assert.deepEqual(outputs, ['', unicode, truncated]);
});

test('an adjusted read keeps its requested and effective commands apart', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-adjusted', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts" offset=1 limit=400'),
    executedEvent({
      toolCallId: 'tc_0',
      turn: 1,
      requestedCommand: 'read path="a.ts" offset=1 limit=400',
      executedCommand: 'read path="a.ts" offset=1 limit=120',
      output: 'partial window',
    }),
  ]));
  const outcome = readChatToolResults(database, 'req-adjusted').outcomes[0];
  assert.ok(outcome);
  assert.equal(outcome.requestedCommand, 'read path="a.ts" offset=1 limit=400');
  assert.equal(outcome.effectiveCommand, 'read path="a.ts" offset=1 limit=120');
});

test('two calls in one turn with identical command text stay separate outcomes', () => {
  const database = openDatabase();
  const command = 'run command="npm test"';
  seedArtifact(database, 'req-pair', toJsonl([
    startEvent('tc_0', 3, command),
    executedEvent({ toolCallId: 'tc_0', turn: 3, requestedCommand: command, output: 'first result' }),
    startEvent('tc_1', 3, command),
    executedEvent({ toolCallId: 'tc_1', turn: 3, requestedCommand: command, exitCode: 1, output: 'second result' }),
  ]));
  const [first, second] = readChatToolResults(database, 'req-pair').outcomes;
  assert.ok(first && second);
  assert.notEqual(first.toolCallId, second.toolCallId);
  assert.equal(first.output, 'first result');
  assert.equal(second.output, 'second result');
  assert.equal(second.exitCode, 1);
});

test('a rejected call is an outcome with a null exit code and no execution start', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-rejected', toJsonl([
    rejectedEvent('tc_0', 2, 'write path="x.ts"', 'Rejected command: user denied this command'),
  ]));
  const results = readChatToolResults(database, 'req-rejected');
  assert.equal(results.startedWithoutResult.length, 0);
  const outcome = results.outcomes[0];
  assert.ok(outcome);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.output, 'Rejected command: user denied this command');
});

for (const historical of [false, true]) {
  for (const output of [null, undefined]) {
    test(`${historical ? 'historical' : 'identified'} rejection with ${String(output)} output is not full evidence`, () => {
      const database = openDatabase();
      const event = rejectedEvent('tc_0', 1, 'write path="x.ts"', 'original');
      if (historical) delete event.toolCallId;
      if (output === undefined) delete event.output;
      else event.output = output;
      seedArtifact(database, 'req-missing-rejection', toJsonl([event]));
      assert.throws(() => readChatToolResults(database, 'req-missing-rejection'), isReaderFailure('malformed'));
    });
  }
}

test('an explicit empty rejection output is preserved', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-empty-rejection', toJsonl([rejectedEvent('tc_0', 1, 'write path="x.ts"', '')]));
  assert.equal(readChatToolResults(database, 'req-empty-rejection').outcomes[0]?.output, '');
});

test('a start without a result is reported instead of being invented as an outcome', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-stopped', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'done' }),
    startEvent('tc_1', 2, 'run command="sleep"'),
  ]));
  const results = readChatToolResults(database, 'req-stopped');
  assert.deepEqual(results.outcomes.map((outcome) => outcome.toolCallId), ['tc_0']);
  assert.deepEqual(results.startedWithoutResult, ['tc_1']);
});

test('the durable artifact answers before the run-log projection is filled', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-race', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: LONG_OUTPUT }),
  ]));
  seedRunLog(database, 'req-race', null);
  const results = readChatToolResults(database, 'req-race');
  assert.equal(results.source, 'runtime_artifact');
  assert.equal(results.outcomes[0]?.output, LONG_OUTPUT);
});

test('an archived run with no artifact reads from the retained run-log transcript', () => {
  const database = openDatabase();
  seedRunLog(database, 'req-archived', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: LONG_OUTPUT }),
  ]));
  const results = readChatToolResults(database, 'req-archived');
  assert.equal(results.source, 'run_log');
  assert.equal(results.outcomes[0]?.output, LONG_OUTPUT);
});

test('a run with no retained transcript fails as unavailable', () => {
  const database = openDatabase();
  assert.throws(
    () => readChatToolResults(database, 'req-missing'),
    isReaderFailure('unavailable'),
  );
});

test('two differing transcript artifacts for one run fail instead of picking one', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-conflict', toJsonl([
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'left' }),
  ]), 'artifact-a');
  seedArtifact(database, 'req-conflict', toJsonl([
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'right' }),
  ]), 'artifact-b');
  assert.throws(
    () => readChatToolResults(database, 'req-conflict'),
    isReaderFailure('conflicting_sources'),
  );
});

test('a malformed outcome fails loudly instead of being skipped', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-malformed', `${JSON.stringify({
    kind: 'turn_command_result', turn: 1, toolCallId: 'tc_0', command: 'read path="a.ts"', exitCode: 0, output: 'x',
  })}\n`);
  assert.throws(
    () => readChatToolResults(database, 'req-malformed'),
    isReaderFailure('malformed'),
  );
});

test('two outcomes claiming one identity fail as a duplicate', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-duplicate', toJsonl([
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'one' }),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'two' }),
  ]));
  assert.throws(
    () => readChatToolResults(database, 'req-duplicate'),
    isReaderFailure('duplicate_identity'),
  );
});

test('two starts claiming one identity fail even when only one result exists', () => {
  const database = openDatabase();
  const command = 'read path="a.ts"';
  seedArtifact(database, 'req-duplicate-start', toJsonl([
    startEvent('tc_0', 1, command),
    startEvent('tc_0', 1, command),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: command, output: 'result' }),
  ]));
  assert.throws(() => readChatToolResults(database, 'req-duplicate-start'), isReaderFailure('duplicate_identity'));
});

test('a finalization replaces only its exact completed call output', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-finalization', toJsonl([
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'base' }),
    { kind: 'turn_command_result_finalized', toolCallId: 'tc_0', turn: 1, insertedResultText: 'base\n\n[tool budget] notice' },
  ]));
  assert.equal(readChatToolResults(database, 'req-finalization').outcomes[0]?.output, 'base\n\n[tool budget] notice');
});

for (const corruption of ['unmatched_call', 'wrong_turn', 'missing_text', 'duplicate', 'missing_identity'] as const) {
  test(`a result finalization with ${corruption} is an integrity error`, () => {
    const database = openDatabase();
    const finalization: TranscriptEvent = { kind: 'turn_command_result_finalized', toolCallId: 'tc_0', turn: 1, insertedResultText: 'final' };
    if (corruption === 'unmatched_call') finalization.toolCallId = 'tc_other';
    if (corruption === 'wrong_turn') finalization.turn = 2;
    if (corruption === 'missing_text') delete finalization.insertedResultText;
    if (corruption === 'missing_identity') delete finalization.toolCallId;
    seedArtifact(database, 'req-bad-finalization', toJsonl([
      executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'base' }),
      finalization,
      ...(corruption === 'duplicate' ? [finalization] : []),
    ]));
    assert.throws(() => readChatToolResults(database, 'req-bad-finalization'), ChatToolResultsError);
  });
}

test('only the named run is read, never a neighbouring one', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-other', toJsonl([
    executedEvent({ toolCallId: 'tc_9', turn: 1, requestedCommand: 'read path="other.ts"', output: 'other run' }),
  ]));
  seedArtifact(database, 'req-target', toJsonl([
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'target run' }),
  ]));
  const outcomes = readChatToolResults(database, 'req-target').outcomes;
  assert.deepEqual(outcomes.map((outcome) => outcome.output), ['target run']);
});

test('a transcript that omits identity everywhere is a historical-unidentified transcript', () => {
  const database = openDatabase();
  const legacyResult: TranscriptEvent = {
    kind: 'turn_command_result',
    turn: 2,
    command: 'read path="legacy.ts" offset=1 limit=120',
    requestedCommand: 'read path="legacy.ts" offset=1 limit=400',
    executedCommand: 'read path="legacy.ts" offset=1 limit=120',
    exitCode: 0,
    output: LONG_OUTPUT,
    insertedResultText: LONG_OUTPUT,
  };
  seedArtifact(database, 'req-legacy', toJsonl([
    {
      kind: 'turn_command_start',
      turn: 2,
      toolName: 'read',
      requestedCommand: 'read path="legacy.ts" offset=1 limit=400',
      commandToRun: 'read path="legacy.ts" offset=1 limit=400',
    },
    legacyResult,
  ]));
  const results = readChatToolResults(database, 'req-legacy');
  assert.equal(results.format, 'historical-unidentified');
  assert.equal(results.operationType, null);
  const outcome = results.outcomes[0];
  assert.ok(outcome);
  assert.equal(outcome.toolCallId, null);
  assert.equal(outcome.output, LONG_OUTPUT);
  assert.equal(outcome.effectiveCommand, 'read path="legacy.ts" offset=1 limit=120');
  // An identity-less start pairs with nothing, so it cannot be reported as a stopped call.
  assert.deepEqual(results.startedWithoutResult, []);
});

function runStartEvent(fields: TranscriptEvent = {}): TranscriptEvent {
  return { kind: 'run_start', repoRoot: 'C:/repo', configuredModel: 'model-a', baseUrl: 'http://127.0.0.1:5000', ...fields };
}

test('an explicit identified-v1 header classifies the transcript and carries its operation', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-modern', toJsonl([
    runStartEvent({ operationType: 'repo-agent', toolResultFormat: 'identified-v1' }),
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: LONG_OUTPUT }),
  ]));
  const results = readChatToolResults(database, 'req-modern');
  assert.equal(results.format, 'identified-v1');
  assert.equal(results.operationType, 'repo-agent');
  assert.equal(results.outcomes[0]?.toolCallId, 'tc_0');
  assert.equal(results.outcomes[0]?.output, LONG_OUTPUT);
});

test('a pre-marker transcript whose events carry identities is identified, with unknown provenance', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-premarker', toJsonl([
    runStartEvent(),
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'seen' }),
  ]));
  const results = readChatToolResults(database, 'req-premarker');
  assert.equal(results.format, 'identified-v1');
  assert.equal(results.operationType, null);
  assert.equal(results.outcomes[0]?.toolCallId, 'tc_0');
});

test('an identified header with an unidentified event is an integrity failure, not history', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-marker-mixed', toJsonl([
    runStartEvent({ operationType: 'repo-agent', toolResultFormat: 'identified-v1' }),
    {
      kind: 'turn_command_result', turn: 1, command: 'read path="a.ts"', requestedCommand: 'read path="a.ts"',
      executedCommand: 'read path="a.ts"', exitCode: 0, output: 'x', insertedResultText: 'x',
    },
  ]));
  assert.throws(() => readChatToolResults(database, 'req-marker-mixed'), isReaderFailure('mixed_identity'));
});

test('mixed identified and unidentified events without a header are an integrity failure', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-mixed', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'x' }),
    {
      kind: 'turn_command_result', turn: 2, command: 'read path="b.ts"', requestedCommand: 'read path="b.ts"',
      executedCommand: 'read path="b.ts"', exitCode: 0, output: 'y', insertedResultText: 'y',
    },
  ]));
  assert.throws(() => readChatToolResults(database, 'req-mixed'), isReaderFailure('mixed_identity'));
});

for (const [label, identity] of [['null', null], ['empty', '']] as const) {
  test(`an explicit ${label} identity is invalid, never historical`, () => {
    const database = openDatabase();
    seedArtifact(database, `req-${label}-id`, toJsonl([
      executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'x' }),
      { ...executedEvent({ toolCallId: 'tc_1', turn: 2, requestedCommand: 'read path="b.ts"', output: 'y' }), toolCallId: identity },
    ]));
    assert.throws(() => readChatToolResults(database, `req-${label}-id`), isReaderFailure('invalid_identity'));
  });
}

test('an unknown format marker is refused instead of being read as either era', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-unknown-format', toJsonl([
    runStartEvent({ operationType: 'repo-agent', toolResultFormat: 'identified-v2' }),
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'x' }),
  ]));
  assert.throws(() => readChatToolResults(database, 'req-unknown-format'), isReaderFailure('unsupported_format'));
});

test('unsupported format diagnostics do not echo arbitrary marker content', () => {
  const database = openDatabase();
  const privateContent = 'private tool output hidden in a marker';
  seedArtifact(database, 'req-private-marker', toJsonl([runStartEvent({ toolResultFormat: privateContent })]));
  assert.throws(() => readChatToolResults(database, 'req-private-marker'), (error: Error) => (
    error instanceof ChatToolResultsError
      && error.reason === 'unsupported_format'
      && !error.message.includes(privateContent)
  ));
});

test('a header naming an operation outside the canonical union is malformed', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-bad-operation', toJsonl([
    runStartEvent({ operationType: 'benchmark', toolResultFormat: 'identified-v1' }),
  ]));
  assert.throws(() => readChatToolResults(database, 'req-bad-operation'), isReaderFailure('malformed'));
});

test('a transcript with no tool events reads as identified with no outcomes', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-no-tools', toJsonl([runStartEvent({ operationType: 'chat', toolResultFormat: 'identified-v1' })]));
  const results = readChatToolResults(database, 'req-no-tools');
  assert.equal(results.format, 'identified-v1');
  assert.equal(results.operationType, 'chat');
  assert.deepEqual(results.outcomes, []);
});

test('requireDurableToolResult accepts the empty string and refuses a missing result by identifier only', () => {
  assert.equal(requireDurableToolResult({ id: 'row-1', sourceRunId: 'req-1', toolCallOutput: '' }), '');
  assert.throws(
    () => requireDurableToolResult({ id: 'row-2', sourceRunId: 'req-1', toolCallOutput: null }),
    (error: Error) => error instanceof ChatToolResultsError
      && error.reason === 'missing_result'
      && error.message.includes('row-2'),
  );
});
