import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { getRuntimeDatabase, closeRuntimeDatabase, type RuntimeDatabase } from '../src/state/runtime-db.js';
import { PersistedChatTranscriptMessageSchema, buildChatRunMessageIdPrefix, buildChatToolMessageId } from '@siftkit/contracts';
import {
  RepoAgentToolResultsError,
  hydrateRepoAgentToolMessages,
  readRepoAgentToolResults,
  type RepoAgentToolResultsFailure,
} from '../src/status-server/repo-agent-tool-results.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function isReaderFailure(reason: RepoAgentToolResultsFailure): (error: Error) => boolean {
  return (error) => error instanceof RepoAgentToolResultsError && error.reason === reason;
}

const SENTINEL = 'sentinel-after-character-200';
const LONG_OUTPUT = `${'x'.repeat(240)}\n${SENTINEL}\nline three`;

function openDatabase(): RuntimeDatabase {
  closeRuntimeDatabase();
  return getRuntimeDatabase(path.join(createManagedTempDir('siftkit-tool-results-'), 'runtime.sqlite'));
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
  const results = readRepoAgentToolResults(database, 'req-full');
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
  const outputs = readRepoAgentToolResults(database, 'req-shapes').outcomes.map((outcome) => outcome.output);
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
  const outcome = readRepoAgentToolResults(database, 'req-adjusted').outcomes[0];
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
  const [first, second] = readRepoAgentToolResults(database, 'req-pair').outcomes;
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
  const results = readRepoAgentToolResults(database, 'req-rejected');
  assert.equal(results.startedWithoutResult.length, 0);
  const outcome = results.outcomes[0];
  assert.ok(outcome);
  assert.equal(outcome.exitCode, null);
  assert.equal(outcome.output, 'Rejected command: user denied this command');
});

test('a start without a result is reported instead of being invented as an outcome', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-stopped', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'done' }),
    startEvent('tc_1', 2, 'run command="sleep"'),
  ]));
  const results = readRepoAgentToolResults(database, 'req-stopped');
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
  const results = readRepoAgentToolResults(database, 'req-race');
  assert.equal(results.source, 'runtime_artifact');
  assert.equal(results.outcomes[0]?.output, LONG_OUTPUT);
});

test('an archived run with no artifact reads from the retained run-log transcript', () => {
  const database = openDatabase();
  seedRunLog(database, 'req-archived', toJsonl([
    startEvent('tc_0', 1, 'read path="a.ts"'),
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: LONG_OUTPUT }),
  ]));
  const results = readRepoAgentToolResults(database, 'req-archived');
  assert.equal(results.source, 'run_log');
  assert.equal(results.outcomes[0]?.output, LONG_OUTPUT);
});

test('a run with no retained transcript fails as unavailable', () => {
  const database = openDatabase();
  assert.throws(
    () => readRepoAgentToolResults(database, 'req-missing'),
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
    () => readRepoAgentToolResults(database, 'req-conflict'),
    isReaderFailure('conflicting_sources'),
  );
});

test('a malformed outcome fails loudly instead of being skipped', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-malformed', `${JSON.stringify({
    kind: 'turn_command_result', turn: 1, toolCallId: 'tc_0', command: 'read path="a.ts"', exitCode: 0, output: 'x',
  })}\n`);
  assert.throws(
    () => readRepoAgentToolResults(database, 'req-malformed'),
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
    () => readRepoAgentToolResults(database, 'req-duplicate'),
    isReaderFailure('duplicate_identity'),
  );
});

test('only the named run is read, never a neighbouring one', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-other', toJsonl([
    executedEvent({ toolCallId: 'tc_9', turn: 1, requestedCommand: 'read path="other.ts"', output: 'other run' }),
  ]));
  seedArtifact(database, 'req-target', toJsonl([
    executedEvent({ toolCallId: 'tc_0', turn: 1, requestedCommand: 'read path="a.ts"', output: 'target run' }),
  ]));
  const outcomes = readRepoAgentToolResults(database, 'req-target').outcomes;
  assert.deepEqual(outcomes.map((outcome) => outcome.output), ['target run']);
});

test('a transcript written before call identity is still readable, with a null identity', () => {
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
  const results = readRepoAgentToolResults(database, 'req-legacy');
  const outcome = results.outcomes[0];
  assert.ok(outcome);
  assert.equal(outcome.toolCallId, null);
  assert.equal(outcome.output, LONG_OUTPUT);
  assert.equal(outcome.effectiveCommand, 'read path="legacy.ts" offset=1 limit=120');
  // An identity-less start pairs with nothing, so it cannot be reported as a stopped call.
  assert.deepEqual(results.startedWithoutResult, []);
});

test('identity-less outcomes never satisfy a live run hydration', () => {
  const database = openDatabase();
  seedArtifact(database, 'req-legacy-hydrate', toJsonl([{
    kind: 'turn_command_result',
    turn: 1,
    command: 'read path="a.ts"',
    requestedCommand: 'read path="a.ts"',
    executedCommand: 'read path="a.ts"',
    exitCode: 0,
    output: LONG_OUTPUT,
    insertedResultText: LONG_OUTPUT,
  }]));
  const canonical = readRepoAgentToolResults(database, 'req-legacy-hydrate');
  const messages = [PersistedChatTranscriptMessageSchema.parse({
    id: buildChatToolMessageId(buildChatRunMessageIdPrefix('req-legacy-hydrate'), 'tc_0'),
    role: 'assistant',
    kind: 'assistant_tool_call',
    content: 'read path="a.ts"',
    inputTokensEstimate: 0,
    outputTokensEstimate: 0,
    thinkingTokens: 0,
    createdAtUtc: '2026-09-09T00:00:00.000Z',
    sourceRunId: 'req-legacy-hydrate',
    toolCallCommand: 'read path="a.ts"',
    toolCallActivityKind: 'read',
    toolCallActivitySubject: { kind: 'none' },
    toolCallTurn: 1,
    toolCallMaxTurns: 8,
    toolCallExitCode: 0,
    toolCallStatus: 'done',
  })];
  assert.throws(
    () => hydrateRepoAgentToolMessages(messages, canonical),
    isReaderFailure('unmatched_call'),
  );
});
