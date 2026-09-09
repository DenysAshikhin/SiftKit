import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildChatRunMessageIdPrefix, buildChatToolMessageId } from '@siftkit/contracts';

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
  toolCallId: string;
  turn: number;
  command: string;
  exitCode?: number;
  output: string;
}): TranscriptEvent {
  return {
    kind: 'turn_command_result',
    turn: options.turn,
    toolCallId: options.toolCallId,
    command: options.command,
    requestedCommand: options.command,
    executedCommand: options.command,
    exitCode: options.exitCode ?? 0,
    output: options.output,
    insertedResultText: options.output,
  };
}

function seedTranscript(
  database: RuntimeDatabase,
  requestId: string,
  events: readonly TranscriptEvent[],
  options: { asRunLog?: boolean; text?: string } = {},
): void {
  const text = options.text ?? events
    .map((event) => `${JSON.stringify({ at: '2026-09-09T00:00:00.000Z', ...event })}\n`)
    .join('');
  if (options.asRunLog === true) {
    database.prepare(`
      INSERT INTO run_logs (
        run_id, request_id, run_kind, run_group, terminal_state, title,
        repo_search_transcript_jsonl, source_paths_json, flushed_at_utc
      ) VALUES (?, ?, 'repo_search', 'repo_search', 'completed', 'run', ?, '[]', '2026-09-09T00:00:00.000Z')
    `).run(requestId, requestId, text);
    return;
  }
  database.prepare(`
    INSERT INTO runtime_artifacts (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
    VALUES (?, 'repo_search_transcript', ?, 'transcript', ?, NULL, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')
  `).run(`artifact:${requestId}`, requestId, text);
}

function longOutput(marker: string): string {
  return `${'x'.repeat(240)}\n${marker}`;
}

test('a dry run reports the truncated rows it can restore without writing anything', () => {
  const database = openDatabase();
  const outputs = [longOutput('alpha-tail'), longOutput('beta-tail'), longOutput('gamma-tail')];
  const prefix = buildChatRunMessageIdPrefix(RUN_ID);
  outputs.forEach((output, index) => {
    insertToolRow(database, {
      id: buildChatToolMessageId(prefix, `tc_${index}`),
      sourceRunId: RUN_ID,
      command: `read path="file-${index}.ts"`,
      turn: index + 1,
      exitCode: 0,
      output: toSnippet(output),
    });
  });
  seedTranscript(database, RUN_ID, outputs.map((output, index) => executedEvent({
    toolCallId: `tc_${index}`,
    turn: index + 1,
    command: `read path="file-${index}.ts"`,
    output,
  })));

  const dryRun = repairRepoAgentHistory(database, SESSION_ID, 'dry-run');
  assert.equal(dryRun.changed, 3);
  assert.equal(dryRun.unchanged, 0);
  assert.equal(dryRun.unavailable, 0);
  assert.equal(dryRun.ambiguous, 0);
  assert.equal(dryRun.rows.every((row) => row.sourceRunId === RUN_ID), true);
  assert.equal(readStoredOutput(database, buildChatToolMessageId(prefix, 'tc_0')), toSnippet(outputs[0] ?? ''));

  const applied = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(applied.changed, 3);
  outputs.forEach((output, index) => {
    assert.equal(readStoredOutput(database, buildChatToolMessageId(prefix, `tc_${index}`)), output);
  });

  const again = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(again.changed, 0);
  assert.equal(again.unchanged, 3);
  database.exec('DELETE FROM runtime_artifacts');
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), [], 'explicit apply also completes migration');
});

test('genuine short, exactly-203, empty and ellipsis-tailed results are left alone', () => {
  const database = openDatabase();
  const prefix = buildChatRunMessageIdPrefix(RUN_ID);
  const exactly203 = 'y'.repeat(203);
  const cases = [
    { callId: 'tc_0', output: 'short result' },
    { callId: 'tc_1', output: exactly203 },
    { callId: 'tc_2', output: '' },
    { callId: 'tc_3', output: 'ends with an ellipsis...' },
  ];
  cases.forEach((entry, index) => {
    insertToolRow(database, {
      id: buildChatToolMessageId(prefix, entry.callId),
      sourceRunId: RUN_ID,
      command: `read path="file-${index}.ts"`,
      turn: index + 1,
      exitCode: 0,
      output: entry.output,
    });
  });
  seedTranscript(database, RUN_ID, cases.map((entry, index) => executedEvent({
    toolCallId: entry.callId,
    turn: index + 1,
    command: `read path="file-${index}.ts"`,
    output: entry.output,
  })));

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 0);
  assert.equal(report.unchanged, 4);
  assert.equal(readStoredOutput(database, buildChatToolMessageId(prefix, 'tc_2')), '');
  assert.equal(readStoredOutput(database, buildChatToolMessageId(prefix, 'tc_3')), 'ends with an ellipsis...');
});

test('a historical row without call identity is matched on its run, turn and effective command', () => {
  const database = openDatabase();
  const output = longOutput('historical-tail');
  insertToolRow(database, {
    id: 'legacy-message-id',
    sourceRunId: RUN_ID,
    command: 'read path="legacy.ts" offset=1 limit=120',
    turn: 2,
    exitCode: 0,
    output: toSnippet(output),
  });
  seedTranscript(database, RUN_ID, [executedEvent({
    toolCallId: 'tc_7',
    turn: 2,
    command: 'read path="legacy.ts" offset=1 limit=120',
    output,
  })]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 1);
  assert.equal(readStoredOutput(database, 'legacy-message-id'), output);
});

test('a repeated command in one turn is reported as ambiguous and left untouched', () => {
  const database = openDatabase();
  const command = 'run command="npm test"';
  const stored = toSnippet(longOutput('ambiguous-tail'));
  insertToolRow(database, {
    id: 'legacy-ambiguous',
    sourceRunId: RUN_ID,
    command,
    turn: 3,
    exitCode: 0,
    output: stored,
  });
  seedTranscript(database, RUN_ID, [
    executedEvent({ toolCallId: 'tc_0', turn: 3, command, output: longOutput('ambiguous-tail') }),
    executedEvent({ toolCallId: 'tc_1', turn: 3, command, output: longOutput('ambiguous-tail') }),
  ]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.ambiguous, 1);
  assert.equal(report.changed, 0);
  assert.equal(readStoredOutput(database, 'legacy-ambiguous'), stored);
});

test('a preview that does not prefix the canonical result is refused rather than overwritten', () => {
  const database = openDatabase();
  const stored = toSnippet(longOutput('mismatched-tail'));
  insertToolRow(database, {
    id: 'legacy-mismatch',
    sourceRunId: RUN_ID,
    command: 'read path="a.ts"',
    turn: 1,
    exitCode: 0,
    output: stored,
  });
  seedTranscript(database, RUN_ID, [executedEvent({
    toolCallId: 'tc_0',
    turn: 1,
    command: 'read path="a.ts"',
    output: 'a completely different result',
  })]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.unavailable, 1);
  assert.equal(readStoredOutput(database, 'legacy-mismatch'), stored);
});

test('a missing or malformed transcript reports the run instead of guessing', () => {
  const database = openDatabase();
  insertToolRow(database, {
    id: 'no-source',
    sourceRunId: 'req-gone',
    command: 'read path="a.ts"',
    turn: 1,
    exitCode: 0,
    output: 'preview',
  });
  const missing = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(missing.unavailable, 1);
  assert.deepEqual(missing.rows.map((row) => row.detail), ['unavailable']);

  seedTranscript(database, 'req-broken', [], { text: '{"kind":"turn_command_result"\n' });
  insertToolRow(database, {
    id: 'broken-source',
    sourceRunId: 'req-broken',
    command: 'read path="b.ts"',
    turn: 1,
    exitCode: 0,
    output: 'preview',
  });
  const malformed = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(malformed.unavailable, 2);
  assert.equal(malformed.rows.some((row) => row.detail === 'malformed'), true);
});

test('two source runs in one chat are each read from their own transcript', () => {
  const database = openDatabase();
  const first = longOutput('first-run-tail');
  const second = longOutput('second-run-tail');
  insertToolRow(database, {
    id: buildChatToolMessageId(buildChatRunMessageIdPrefix('req-a'), 'tc_0'),
    sourceRunId: 'req-a',
    command: 'read path="a.ts"',
    turn: 1,
    exitCode: 0,
    output: toSnippet(first),
  });
  insertToolRow(database, {
    id: buildChatToolMessageId(buildChatRunMessageIdPrefix('req-b'), 'tc_0'),
    sourceRunId: 'req-b',
    command: 'read path="b.ts"',
    turn: 1,
    exitCode: 0,
    output: toSnippet(second),
  });
  seedTranscript(database, 'req-a', [executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="a.ts"', output: first })]);
  seedTranscript(
    database,
    'req-b',
    [executedEvent({ toolCallId: 'tc_0', turn: 1, command: 'read path="b.ts"', output: second })],
    { asRunLog: true },
  );

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 2);
  assert.equal(readStoredOutput(database, buildChatToolMessageId(buildChatRunMessageIdPrefix('req-a'), 'tc_0')), first);
  assert.equal(readStoredOutput(database, buildChatToolMessageId(buildChatRunMessageIdPrefix('req-b'), 'tc_0')), second);
});

test('stopped, compacted and run-less rows are never selected for repair', () => {
  const database = openDatabase();
  const prefix = buildChatRunMessageIdPrefix(RUN_ID);
  insertToolRow(database, {
    id: buildChatToolMessageId(prefix, 'tc_0'),
    sourceRunId: RUN_ID,
    command: 'run command="held"',
    turn: 1,
    exitCode: null,
    output: 'partial',
    status: 'stopped',
  });
  insertToolRow(database, {
    id: buildChatToolMessageId(prefix, 'tc_1'),
    sourceRunId: RUN_ID,
    command: 'read path="summarised.ts"',
    turn: 1,
    exitCode: 0,
    output: 'summarised away',
    compressed: true,
  });
  insertToolRow(database, {
    id: 'ordinary-chat-tool',
    sourceRunId: null,
    command: 'read path="ordinary.ts"',
    turn: 1,
    exitCode: 0,
    output: 'ordinary chat output',
  });
  seedTranscript(database, RUN_ID, [executedEvent({
    toolCallId: 'tc_0',
    turn: 1,
    command: 'run command="held"',
    output: 'never replayed',
  })]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.deepEqual(report.rows, []);
  assert.equal(readStoredOutput(database, buildChatToolMessageId(prefix, 'tc_0')), 'partial');
  assert.equal(readStoredOutput(database, buildChatToolMessageId(prefix, 'tc_1')), 'summarised away');
  assert.equal(readStoredOutput(database, 'ordinary-chat-tool'), 'ordinary chat output');
});

test('a run with one unresolved row leaves that run entirely unchanged', () => {
  const database = openDatabase();
  const prefix = buildChatRunMessageIdPrefix(RUN_ID);
  const repairable = longOutput('repairable-tail');
  insertToolRow(database, {
    id: buildChatToolMessageId(prefix, 'tc_0'),
    sourceRunId: RUN_ID,
    command: 'read path="a.ts"',
    turn: 1,
    exitCode: 0,
    output: toSnippet(repairable),
  });
  insertToolRow(database, {
    id: 'legacy-unmatched',
    sourceRunId: RUN_ID,
    command: 'read path="vanished.ts"',
    turn: 4,
    exitCode: 0,
    output: 'stale preview',
  });
  seedTranscript(database, RUN_ID, [executedEvent({
    toolCallId: 'tc_0',
    turn: 1,
    command: 'read path="a.ts"',
    output: repairable,
  })]);

  const report = repairRepoAgentHistory(database, SESSION_ID, 'apply');
  assert.equal(report.changed, 0);
  assert.equal(report.unavailable, 2);
  assert.equal(readStoredOutput(database, buildChatToolMessageId(prefix, 'tc_0')), toSnippet(repairable));
});

test('migration retries unresolved history and stops consulting transcripts after success', () => {
  const database = openDatabase();
  const output = longOutput('migrated-tail');
  insertToolRow(database, {
    id: 'historical-tool', sourceRunId: RUN_ID, command: 'read path="old.ts"',
    turn: 1, exitCode: 0, output: toSnippet(output),
  });
  assert.equal(migrateRepoAgentHistory(database, SESSION_ID).length, 1);
  seedTranscript(database, RUN_ID, [executedEvent({
    toolCallId: 'tc_0', turn: 1, command: 'read path="old.ts"', output,
  })]);
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
  assert.equal(readStoredOutput(database, 'historical-tool'), output);
  database.exec('DROP TABLE runtime_artifacts; DROP TABLE run_logs');
  assert.deepEqual(migrateRepoAgentHistory(database, SESSION_ID), []);
  assert.equal(readStoredOutput(database, 'historical-tool'), output);
});
