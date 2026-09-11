import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildChatRunMessageIdPrefix, buildChatMessageId, type RunOperationType } from '@siftkit/contracts';

import { closeRuntimeDatabase, getRuntimeDatabase, type RuntimeDatabase } from '../src/state/runtime-db.js';
import { migrateRepoAgentHistory, repairRepoAgentHistory } from '../src/status-server/repo-agent-history-repair.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

const SESSION_ID = 'session-under-repair';
const RUN_ID = 'req-0001';

function openDatabase(): RuntimeDatabase {
  closeRuntimeDatabase();
  const database = getRuntimeDatabase(path.join(createManagedTempDir('siftkit-history-repair-'), 'runtime.sqlite'));
  database.prepare(`
    INSERT INTO chat_sessions (
      id, title, model_preset_id, model_preset_json, thinking_enabled, web_search_enabled,
      preset_id, mode, plan_repo_root, created_at_utc, updated_at_utc
    ) VALUES (?, 'Repair', 'default', '{}', 1, 0, 'chat', 'chat', '.', ?, ?)
  `).run(SESSION_ID, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
  return database;
}

function toSnippet(output: string): string {
  return output.length > 200 ? `${output.slice(0, 200)}...` : output;
}

let nextPosition = 0;

function insertToolRow(database: RuntimeDatabase, options: {
  id: string;
  sourceRunId: string | null;
  command: string;
  turn: number;
  exitCode: number | null;
  output: string;
  snippet?: string;
  status?: 'done' | 'stopped';
  compressed?: boolean;
}): void {
  nextPosition += 1;
  database.prepare(`
    INSERT INTO chat_messages (
      session_id, id, role, kind, content,
      input_tokens_estimate, output_tokens_estimate, thinking_tokens,
      input_tokens_estimated, output_tokens_estimated, thinking_tokens_estimated,
      tool_call_command, tool_call_activity_kind, tool_call_activity_subject_kind,
      tool_call_turn, tool_call_max_turns, tool_call_exit_code,
      tool_call_output_snippet, tool_call_output, tool_call_status,
      created_at_utc, source_run_id, compressed_into_summary, position
    ) VALUES (?, ?, 'assistant', 'assistant_tool_call', ?, 0, 0, 0, 0, 0, 0, ?, 'read', 'none', ?, 8, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SESSION_ID,
    options.id,
    options.command,
    options.command,
    options.turn,
    options.exitCode,
    options.snippet ?? toSnippet(options.output),
    options.output,
    options.status ?? 'done',
    '2026-09-09T00:00:00.000Z',
    options.sourceRunId,
    options.compressed === true ? 1 : 0,
    nextPosition,
  );
}

/** A modern row: its id is derived from the run and call identity, the way the live writer builds it. */
function insertIdentifiedRow(database: RuntimeDatabase, runId: string, toolCallId: string, options: {
  command: string;
  turn: number;
  output: string;
  exitCode?: number;
}): string {
  const id = buildChatMessageId(buildChatRunMessageIdPrefix(runId), { kind: 'tool', toolCallId: toolCallId });
  insertToolRow(database, { id, sourceRunId: runId, command: options.command, turn: options.turn, exitCode: options.exitCode ?? 0, output: options.output });
  return id;
}

function readStoredOutput(database: RuntimeDatabase, messageId: string): string | null {
  const row = database.prepare(
    'SELECT tool_call_output FROM chat_messages WHERE session_id = ? AND id = ?',
  ).get(SESSION_ID, messageId);
  if (row === undefined || row === null || typeof row !== 'object') {
    throw new Error(`Missing chat row ${messageId}.`);
  }
  const value = Reflect.get(row, 'tool_call_output');
  return typeof value === 'string' ? value : null;
}

type TranscriptEvent = Record<string, string | number | null>;

function executedEvent(options: {
  toolCallId?: string;
  turn: number;
  command: string;
  exitCode?: number;
  output: string;
}): TranscriptEvent {
  return {
    kind: 'turn_command_result',
    turn: options.turn,
    ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
    command: options.command,
    requestedCommand: options.command,
    executedCommand: options.command,
    exitCode: options.exitCode ?? 0,
    output: options.output,
    insertedResultText: options.output,
  };
}

function modernHeader(operationType: RunOperationType = 'repo-agent'): TranscriptEvent {
  return { kind: 'run_start', repoRoot: 'C:/repo', configuredModel: 'model-a', baseUrl: 'http://127.0.0.1', operationType, toolResultFormat: 'identified-v1' };
}

/** Transcripts written before the header carried a format or an operation. */
function legacyHeader(): TranscriptEvent {
  return { kind: 'run_start', repoRoot: 'C:/repo', configuredModel: 'model-a', baseUrl: 'http://127.0.0.1' };
}

function toJsonl(events: readonly TranscriptEvent[]): string {
  return events.map((event) => `${JSON.stringify({ at: '2026-09-09T00:00:00.000Z', ...event })}\n`).join('');
}

function seedArtifact(database: RuntimeDatabase, requestId: string, text: string): void {
  database.prepare(`
    INSERT INTO runtime_artifacts (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
    VALUES (?, 'repo_search_transcript', ?, 'transcript', ?, NULL, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')
  `).run(`artifact:${requestId}`, requestId, text);
}

/** The retained run identity: what `run_logs` recorded about the request, with or without its archived transcript. */
function seedRunLog(
  database: RuntimeDatabase,
  requestId: string,
  operationType: RunOperationType | null,
  transcript: string | null,
  runId = requestId,
): void {
  database.prepare(`
    INSERT INTO run_logs (
      run_id, request_id, run_kind, run_group, operation_type, terminal_state, title,
      repo_search_transcript_jsonl, source_paths_json, flushed_at_utc
    ) VALUES (?, ?, 'repo_search', 'repo_search', ?, 'completed', 'run', ?, '[]', '2026-09-09T00:00:00.000Z')
  `).run(runId, requestId, operationType, transcript);
}

/** A modern repo-agent transcript, retained as the live artifact. */
function seedModernTranscript(database: RuntimeDatabase, requestId: string, events: readonly TranscriptEvent[]): void {
  seedArtifact(database, requestId, toJsonl([modernHeader(), ...events]));
}

/** A historical transcript: no identities anywhere, origin known only from the run log. */
function seedHistoricalTranscript(database: RuntimeDatabase, requestId: string, events: readonly TranscriptEvent[]): void {
  seedRunLog(database, requestId, 'repo-agent', toJsonl([legacyHeader(), ...events]));
}

function longOutput(marker: string): string {
  return `${'x'.repeat(240)}\n${marker}`;
}

test('a dry run reports the truncated rows it can restore without writing anything', () => {
  const database = openDatabase();
  const outputs = [longOutput('alpha-tail'), longOutput('beta-tail'), longOutput('gamma-tail')];
  const ids = outputs.map((output, index) => insertIdentifiedRow(database, RUN_ID, `tc_${index}`, {
    command: `read path="file-${index}.ts"`, turn: index + 1, output: toSnippet(output),
  }));
  seedModernTranscript(database, RUN_ID, outputs.map((output, index) => executedEvent({
    toolCallId: `tc_${index}`, turn: index + 1, command: `read path="file-${index}.ts"`, output,
  })));

  const dryRun = repairRepoAgentHistory(database, SESSION_ID, 'dry-run');
  assert.equal(dryRun.changed, 3);
  assert.equal(dryRun.unchanged, 0);
  assert.equal(dryRun.unavailable, 0);
  assert.equal(dryRun.ambiguous, 0);
  assert.equal(dryRun.excludedOtherOperation, 0);
  assert.equal(dryRun.unclassifiedOrigin, 0);
  assert.equal(dryRun.rows.every((row) => row.sourceRunId === RUN_ID), true);
  assert.equal(readStoredOutput(database, ids[0] ?? ''), toSnippet(outputs[0] ?? ''));

  const applied = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(applied.changed, 3);
  outputs.forEach((output, index) => {
    assert.equal(readStoredOutput(database, ids[index] ?? ''), output);
  });

  const again = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(again.changed, 0);
  assert.equal(again.unchanged, 3);
  database.exec('DELETE FROM runtime_artifacts');
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), [], 'explicit apply also completes migration');
});

test('genuine short, exactly-203, empty and ellipsis-tailed results are left alone', () => {
  const database = openDatabase();
  const exactly203 = 'y'.repeat(203);
  const cases = [
    { callId: 'tc_0', output: 'short result' },
    { callId: 'tc_1', output: exactly203 },
    { callId: 'tc_2', output: '' },
    { callId: 'tc_3', output: 'ends with an ellipsis...' },
  ];
  const ids = cases.map((entry, index) => insertIdentifiedRow(database, RUN_ID, entry.callId, {
    command: `read path="file-${index}.ts"`, turn: index + 1, output: entry.output,
  }));
  seedModernTranscript(database, RUN_ID, cases.map((entry, index) => executedEvent({
    toolCallId: entry.callId, turn: index + 1, command: `read path="file-${index}.ts"`, output: entry.output,
  })));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 0);
  assert.equal(report.unchanged, 4);
  assert.equal(readStoredOutput(database, ids[2] ?? ''), '');
  assert.equal(readStoredOutput(database, ids[3] ?? ''), 'ends with an ellipsis...');
});

test('a historical row is matched on its run, turn and effective command when the transcript has no identities', () => {
  const database = openDatabase();
  const output = longOutput('historical-tail');
  insertToolRow(database, {
    id: 'legacy-message-id', sourceRunId: RUN_ID, command: 'read path="legacy.ts" offset=1 limit=120',
    turn: 2, exitCode: 0, output: toSnippet(output),
  });
  seedHistoricalTranscript(database, RUN_ID, [
    executedEvent({ turn: 2, command: 'read path="legacy.ts" offset=1 limit=120', output }),
  ]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 1);
  assert.equal(readStoredOutput(database, 'legacy-message-id'), output);
});

test('a modern transcript never falls back to command matching for a row whose identity differs', () => {
  const database = openDatabase();
  const command = 'read path="a.ts"';
  const output = longOutput('wrong-identity-tail');
  // Same command, turn, exit code and preview; only the call identity disagrees.
  const rowId = insertIdentifiedRow(database, RUN_ID, 'tc_0', { command, turn: 1, output: toSnippet(output) });
  seedModernTranscript(database, RUN_ID, [executedEvent({ toolCallId: 'tc_1', turn: 1, command, output })]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 0);
  assert.equal(report.unavailable, 1);
  assert.equal(readStoredOutput(database, rowId), toSnippet(output));
  assert.equal(migrateRepoAgentHistory(database, SESSION_ID).length, 1);
});

test('a pre-marker transcript whose events carry identities is matched by identity, not by command', () => {
  const database = openDatabase();
  const command = 'read path="a.ts"';
  const output = longOutput('pre-marker-tail');
  insertToolRow(database, { id: 'legacy-shaped-id', sourceRunId: RUN_ID, command, turn: 1, exitCode: 0, output: toSnippet(output) });
  const matched = insertIdentifiedRow(database, RUN_ID, 'tc_1', { command: 'read path="b.ts"', turn: 2, output: toSnippet(output) });
  seedRunLog(database, RUN_ID, 'repo-agent', toJsonl([
    legacyHeader(),
    executedEvent({ toolCallId: 'tc_0', turn: 1, command, output }),
    executedEvent({ toolCallId: 'tc_1', turn: 2, command: 'read path="b.ts"', output }),
  ]));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.unavailable, 2, 'the whole run is held back by the unmatched row');
  assert.equal(readStoredOutput(database, matched), toSnippet(output));
});

test('a repeated command in one historical turn is reported as ambiguous and left untouched', () => {
  const database = openDatabase();
  const command = 'run command="npm test"';
  const stored = toSnippet(longOutput('ambiguous-tail'));
  insertToolRow(database, { id: 'legacy-ambiguous', sourceRunId: RUN_ID, command, turn: 3, exitCode: 0, output: stored });
  seedHistoricalTranscript(database, RUN_ID, [
    executedEvent({ turn: 3, command, output: longOutput('ambiguous-tail') }),
    executedEvent({ turn: 3, command, output: longOutput('ambiguous-tail') }),
  ]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.ambiguous, 1);
  assert.equal(report.changed, 0);
  assert.equal(readStoredOutput(database, 'legacy-ambiguous'), stored);
});

test('a historical preview that does not prefix the canonical result is refused rather than overwritten', () => {
  const database = openDatabase();
  const stored = toSnippet(longOutput('mismatched-tail'));
  insertToolRow(database, { id: 'legacy-mismatch', sourceRunId: RUN_ID, command: 'read path="a.ts"', turn: 1, exitCode: 0, output: stored });
  seedHistoricalTranscript(database, RUN_ID, [
    executedEvent({ turn: 1, command: 'read path="a.ts"', output: 'a completely different result' }),
  ]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.unavailable, 1);
  assert.equal(readStoredOutput(database, 'legacy-mismatch'), stored);
});

test('a known repo-agent run with a missing or malformed transcript reports the run instead of guessing', () => {
  const database = openDatabase();
  insertToolRow(database, { id: 'no-source', sourceRunId: 'req-gone', command: 'read path="a.ts"', turn: 1, exitCode: 0, output: 'preview' });
  seedRunLog(database, 'req-gone', 'repo-agent', null);
  const missing = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(missing.unavailable, 1);
  assert.deepEqual(missing.rows.map((row) => row.detail), ['unavailable']);

  seedRunLog(database, 'req-broken', 'repo-agent', '{"kind":"turn_command_result"\n');
  insertToolRow(database, { id: 'broken-source', sourceRunId: 'req-broken', command: 'read path="b.ts"', turn: 1, exitCode: 0, output: 'preview' });
  const malformed = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(malformed.unavailable, 2);
  assert.equal(malformed.rows.some((row) => row.detail === 'malformed'), true);
});

test('two source runs in one chat are each read from their own transcript', () => {
  const database = openDatabase();
  const first = longOutput('first-run-tail');
  const second = longOutput('second-run-tail');
  const firstId = insertIdentifiedRow(database, 'req-a', 'tc_0', { command: 'read path="a.ts"', turn: 1, output: toSnippet(first) });
  const secondId = insertIdentifiedRow(database, 'req-b', 'tc_0', { command: 'read path="b.ts"', turn: 1, output: toSnippet(second) });
  seedModernTranscript(database, 'req-a', [executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output: first })]);
  seedRunLog(database, 'req-b', 'repo-agent', toJsonl([
    modernHeader(),
    executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="b.ts"', output: second }),
  ]));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 2);
  assert.equal(readStoredOutput(database, firstId), first);
  assert.equal(readStoredOutput(database, secondId), second);
});

test('stopped, compacted and run-less rows are never selected for repair', () => {
  const database = openDatabase();
  const prefix = buildChatRunMessageIdPrefix(RUN_ID);
  insertToolRow(database, {
    id: buildChatMessageId(prefix, { kind: 'tool', toolCallId: 'tc_0' }), sourceRunId: RUN_ID, command: 'run command="held"',
    turn: 1, exitCode: null, output: 'partial', status: 'stopped',
  });
  insertToolRow(database, {
    id: buildChatMessageId(prefix, { kind: 'tool', toolCallId: 'tc_1' }), sourceRunId: RUN_ID, command: 'read path="summarised.ts"',
    turn: 1, exitCode: 0, output: 'summarised away', compressed: true,
  });
  insertToolRow(database, { id: 'ordinary-chat-tool', sourceRunId: null, command: 'read path="ordinary.ts"', turn: 1, exitCode: 0, output: 'ordinary chat output' });
  seedModernTranscript(database, RUN_ID, [executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'run command="held"', output: 'never replayed' })]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.deepEqual(report.rows, []);
  assert.equal(readStoredOutput(database, buildChatMessageId(prefix, { kind: 'tool', toolCallId: 'tc_0' })), 'partial');
  assert.equal(readStoredOutput(database, buildChatMessageId(prefix, { kind: 'tool', toolCallId: 'tc_1' })), 'summarised away');
  assert.equal(readStoredOutput(database, 'ordinary-chat-tool'), 'ordinary chat output');
});

test('a run with one unresolved row leaves that run entirely unchanged', () => {
  const database = openDatabase();
  const repairable = longOutput('repairable-tail');
  const repairableId = insertIdentifiedRow(database, RUN_ID, 'tc_0', { command: 'read path="a.ts"', turn: 1, output: toSnippet(repairable) });
  insertToolRow(database, { id: 'legacy-unmatched', sourceRunId: RUN_ID, command: 'read path="vanished.ts"', turn: 4, exitCode: 0, output: 'stale preview' });
  seedModernTranscript(database, RUN_ID, [executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output: repairable })]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 0);
  assert.equal(report.unavailable, 2);
  assert.equal(readStoredOutput(database, repairableId), toSnippet(repairable));
});

test('migration retries unresolved history and stops consulting transcripts after success', () => {
  const database = openDatabase();
  const output = longOutput('migrated-tail');
  insertToolRow(database, { id: 'historical-tool', sourceRunId: RUN_ID, command: 'read path="old.ts"', turn: 1, exitCode: 0, output: toSnippet(output) });
  seedRunLog(database, RUN_ID, 'repo-agent', null);
  assert.equal(migrateRepoAgentHistory(database, SESSION_ID).length, 1);
  database.prepare('UPDATE run_logs SET repo_search_transcript_jsonl = ? WHERE request_id = ?').run(
    toJsonl([legacyHeader(), executedEvent({ turn: 1, command: 'read path="old.ts"', output })]),
    RUN_ID,
  );
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
  assert.equal(readStoredOutput(database, 'historical-tool'), output);
  database.exec('DROP TABLE runtime_artifacts; DROP TABLE run_logs');
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
  assert.equal(readStoredOutput(database, 'historical-tool'), output);
});

test('only positively identified repo-agent rows are repaired in a mixed session', () => {
  const database = openDatabase();
  const agentOutput = longOutput('agent-tail');
  const ordinaryOutput = 'ordinary chat output preview kept as is';
  const searchOutput = 'repo-search output kept as is';
  const agentRow = insertIdentifiedRow(database, 'req-agent', 'tc_0', { command: 'read path="agent.ts"', turn: 1, output: toSnippet(agentOutput) });
  const ordinaryRow = insertIdentifiedRow(database, 'req-chat', 'tc_0', { command: 'web_fetch url="https://example.test"', turn: 1, output: ordinaryOutput });
  const searchRow = insertIdentifiedRow(database, 'req-search', 'tc_0', { command: 'read path="search.ts"', turn: 1, output: searchOutput });
  seedModernTranscript(database, 'req-agent', [executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="agent.ts"', output: agentOutput })]);
  // The other operations are known by identity only; their archives are gone.
  seedRunLog(database, 'req-chat', 'chat', null);
  seedRunLog(database, 'req-search', 'repo-search', null);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 1);
  assert.equal(report.excludedOtherOperation, 2);
  assert.equal(report.unclassifiedOrigin, 0);
  assert.equal(report.unavailable, 0);
  assert.deepEqual(
    report.rows.filter((row) => row.status === 'excluded_other_operation').map((row) => [row.sourceRunId, row.detail]),
    [['req-chat', 'chat'], ['req-search', 'repo-search']],
  );
  assert.equal(readStoredOutput(database, agentRow), agentOutput);
  assert.equal(readStoredOutput(database, ordinaryRow), ordinaryOutput);
  assert.equal(readStoredOutput(database, searchRow), searchOutput);
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), [], 'excluded rows never block the marker');
});

test('a known other operation is excluded without reading its transcript at all', () => {
  const database = openDatabase();
  const rowId = insertIdentifiedRow(database, 'req-plan', 'tc_0', { command: 'read path="plan.ts"', turn: 1, output: 'plan preview' });
  seedRunLog(database, 'req-plan', 'plan', null);
  // A transcript that names the row would have repaired it, had it been read.
  seedArtifact(database, 'req-plan', toJsonl([modernHeader('plan'), executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="plan.ts"', output: longOutput('plan-tail') })]));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'dry-run');
  assert.equal(report.excludedOtherOperation, 1);
  assert.equal(report.changed, 0);
  assert.equal(readStoredOutput(database, rowId), 'plan preview');
});

test('a transcript header establishes origin when the run identity was never retained', () => {
  const database = openDatabase();
  const agentOutput = longOutput('header-agent-tail');
  const agentRow = insertIdentifiedRow(database, 'req-header-agent', 'tc_0', { command: 'read path="a.ts"', turn: 1, output: toSnippet(agentOutput) });
  const chatRow = insertIdentifiedRow(database, 'req-header-chat', 'tc_0', { command: 'read path="c.ts"', turn: 1, output: 'chat preview' });
  seedArtifact(database, 'req-header-agent', toJsonl([modernHeader('repo-agent'), executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output: agentOutput })]));
  seedArtifact(database, 'req-header-chat', toJsonl([modernHeader('chat'), executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="c.ts"', output: longOutput('chat-tail') })]));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 1);
  assert.equal(report.excludedOtherOperation, 1);
  assert.equal(readStoredOutput(database, agentRow), agentOutput);
  assert.equal(readStoredOutput(database, chatRow), 'chat preview');
});

test('unknown origin is reported and excluded, never repaired or inferred from the source-run pointer', () => {
  const database = openDatabase();
  const noEvidence = insertIdentifiedRow(database, 'req-unknown', 'tc_0', { command: 'read path="u.ts"', turn: 1, output: 'unknown preview' });
  const headerless = insertIdentifiedRow(database, 'req-headerless', 'tc_0', { command: 'read path="h.ts"', turn: 1, output: 'headerless preview' });
  // A matching outcome exists, but nothing says which operation produced it.
  seedArtifact(database, 'req-headerless', toJsonl([legacyHeader(), executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="h.ts"', output: longOutput('headerless-tail') })]));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.unclassifiedOrigin, 2);
  assert.equal(report.changed, 0);
  assert.equal(report.unavailable, 0);
  assert.deepEqual(
    report.rows.map((row) => [row.sourceRunId, row.status, row.detail]),
    [['req-unknown', 'unclassified_origin', 'unavailable'], ['req-headerless', 'unclassified_origin', 'no operation provenance']],
  );
  assert.equal(readStoredOutput(database, noEvidence), 'unknown preview');
  assert.equal(readStoredOutput(database, headerless), 'headerless preview');
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
});

test('conflicting provenance is reported explicitly and never resolved by picking a side', () => {
  const database = openDatabase();
  const output = longOutput('conflict-tail');
  const disagreeingLogs = insertIdentifiedRow(database, 'req-two-logs', 'tc_0', { command: 'read path="a.ts"', turn: 1, output: toSnippet(output) });
  seedRunLog(database, 'req-two-logs', 'repo-agent', null, 'run-log-a');
  seedRunLog(database, 'req-two-logs', 'chat', null, 'run-log-b');
  seedArtifact(database, 'req-two-logs', toJsonl([modernHeader(), executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output })]));

  const logVsHeader = insertIdentifiedRow(database, 'req-log-vs-header', 'tc_0', { command: 'read path="b.ts"', turn: 1, output: toSnippet(output) });
  seedRunLog(database, 'req-log-vs-header', 'repo-agent', null);
  seedArtifact(database, 'req-log-vs-header', toJsonl([modernHeader('chat'), executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="b.ts"', output })]));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.unclassifiedOrigin, 2);
  assert.equal(report.changed, 0);
  assert.equal(report.rows.every((row) => row.detail === 'conflicting_provenance'), true);
  assert.equal(readStoredOutput(database, disagreeingLogs), toSnippet(output));
  assert.equal(readStoredOutput(database, logVsHeader), toSnippet(output));
  const blockedRuns = migrateRepoAgentHistory(database, SESSION_ID);
  assert.equal(blockedRuns.length, 2, 'conflicts block migration instead of recording completion');
  assert.equal(blockedRuns.every((entry) => entry.includes('conflicting_provenance')), true);
  database.prepare('DELETE FROM run_logs WHERE run_id = ?').run('run-log-b');
  database.prepare('DELETE FROM runtime_artifacts WHERE request_id = ?').run('req-log-vs-header');
  seedModernTranscript(database, 'req-log-vs-header', [
    executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="b.ts"', output }),
  ]);
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
  assert.equal(readStoredOutput(database, disagreeingLogs), output, 'resolved conflicts remain eligible for repair');
  assert.equal(readStoredOutput(database, logVsHeader), output);
});

for (const corruption of ['invalid_identity', 'unsupported_format', 'malformed_json'] as const) {
  test(`artifact-only repo-agent provenance remains eligible when its results have ${corruption}`, () => {
    const database = openDatabase();
    const output = longOutput('eligible-corrupt-tail');
    const id = insertIdentifiedRow(database, RUN_ID, 'tc_0', { command: 'read path="a.ts"', turn: 1, output: toSnippet(output) });
    const header = corruption === 'unsupported_format'
      ? { ...modernHeader(), toolResultFormat: 'secret output in unsupported marker' }
      : modernHeader();
    const result = executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output });
    seedArtifact(database, RUN_ID, toJsonl([header,
      corruption === 'invalid_identity' ? { ...result, toolCallId: null } : result,
    ]) + (corruption === 'malformed_json' ? '{broken\n' : ''));
    const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
    assert.equal(report.unavailable, 1);
    assert.equal(report.unclassifiedOrigin, 0);
    assert.equal(report.changed, 0);
    assert.equal(migrateRepoAgentHistory(database, SESSION_ID).length, 1);
    assert.equal(readStoredOutput(database, id), toSnippet(output));
    database.prepare('DELETE FROM runtime_artifacts WHERE request_id = ?').run(RUN_ID);
    seedModernTranscript(database, RUN_ID, [result]);
    assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
    assert.equal(readStoredOutput(database, id), output, 'corrupt evidence never completed migration');
  });
}

test('conflicting artifact sources cannot complete a migration without known run provenance', () => {
  const database = openDatabase();
  const output = longOutput('conflicting-sources-tail');
  const id = insertIdentifiedRow(database, RUN_ID, 'tc_0', { command: 'read path="a.ts"', turn: 1, output: toSnippet(output) });
  const result = executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output });
  seedModernTranscript(database, RUN_ID, [result]);
  database.prepare(`
    INSERT INTO runtime_artifacts (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
    VALUES ('conflicting-copy', 'repo_search_transcript', ?, 'transcript', ?, NULL, '2026-09-09', '2026-09-09')
  `).run(RUN_ID, toJsonl([modernHeader(), { ...result, insertedResultText: 'different' }]));
  assert.equal(migrateRepoAgentHistory(database, SESSION_ID).length, 1);
  assert.equal(readStoredOutput(database, id), toSnippet(output));
  database.prepare('DELETE FROM runtime_artifacts WHERE id = ?').run('conflicting-copy');
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
  assert.equal(readStoredOutput(database, id), output);
});

for (const secondOperation of ['repo-agent', 'chat'] as const) {
  test(`artifact-only repeated headers ending in ${secondOperation} block migration`, () => {
    const database = openDatabase();
    const output = longOutput('repeated-header-tail');
    const id = insertIdentifiedRow(database, RUN_ID, 'tc_0', { command: 'read path="a.ts"', turn: 1, output: toSnippet(output) });
    const result = executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output });
    seedArtifact(database, RUN_ID, toJsonl([modernHeader(), modernHeader(secondOperation), result]));
    const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
    assert.equal(report.changed, 0);
    assert.equal(report.rows[0]?.detail, 'conflicting_sources');
    assert.equal(migrateRepoAgentHistory(database, SESSION_ID).length, 1);
    assert.equal(readStoredOutput(database, id), toSnippet(output));
    database.prepare('DELETE FROM runtime_artifacts WHERE request_id = ?').run(RUN_ID);
    seedModernTranscript(database, RUN_ID, [result]);
    assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
    assert.equal(readStoredOutput(database, id), output, 'repeated headers never completed migration');
  });
}
