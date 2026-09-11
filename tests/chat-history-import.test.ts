import assert from 'node:assert/strict';
import test from 'node:test';
import { readChatHistoryArchive, reconstructChatArchiveContext } from '../src/status-server/chat-history-archive.js';
import type { JsonObject } from '../src/lib/json-types.js';
import { createChatHistoryArchiveFixture } from './helpers/chat-history-archive-fixture.js';
import { linkChatArchiveContext, projectChatHistoryArchive } from '../src/status-server/chat-history-archive-projection.js';
import { applyChatHistoryRepair, prepareChatHistoryRepair, ChatHistoryRepairReportSchema, type ChatHistoryRepairInputSchema } from '../src/status-server/chat-history-repair.js';
import { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { createTestChatSession } from './helpers/chat-sessions.js';
import { getRuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession, readChatSessionFromDatabase } from '../src/state/chat-sessions.js';
import { ChatRuntimeOwner } from '../src/state/chat-runtime-owner.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { buildRecoveredChatHistory } from '../src/status-server/chat-context-replay.js';
import { join } from 'node:path';
import { ChatMessageQueueStore } from '../src/state/chat-message-queue.js';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeAllRuntimeDatabases } from '../src/state/runtime-db.js';

const at = '2026-09-10T11:00:00.000Z';
function archive(extra: readonly JsonObject[] = []) {
  return [
    { kind: 'run_start', operationType: 'repo-agent', toolResultFormat: 'identified-v1' },
    { kind: 'turn_new_messages', turn: 1, messages: [{ role: 'user', content: 'inspect fixture' }] },
    { kind: 'turn_model_response', turn: 1, text: 'Inspecting.', thinkingText: '', promptTokens: 10, completionTokens: 2 },
    ...extra,
  ].map(event => JSON.stringify({ at, ...event })).join('\n');
}
function source(text: string, sourceId = 'artifact') {
  return { sourceKind: 'runtime_artifact' as const, sourceId, text };
}

test('archive import compares every exact source and counts matching copies once', () => {
  const text = archive();
  const result = readChatHistoryArchive('request', [source(text), { sourceKind: 'run_log', sourceId: 'archive', text }]);
  assert.equal(result.modelTurns, 1);
  assert.equal(result.sources.length, 2);
  assert.equal(result.completedToolResults, 0);
});

test('archive import rejects conflicting copies instead of preferring the live artifact', () => {
  assert.throws(() => readChatHistoryArchive('request', [source(archive()), source(archive().replace('Inspecting.', 'Changed.'), 'other')]), /conflicting/iu);
});

test('archive import rejects malformed and unrecognized events instead of dropping evidence', () => {
  for (const line of ['null', '{}', '{', JSON.stringify({ at, kind: 'new_context_replacement' })]) {
    assert.throws(() => readChatHistoryArchive('request', [source(`${archive()}\n${line}`)]), /line/iu);
  }
});

test('archive import rejects a turn gap and malformed native context', () => {
  assert.throws(() => readChatHistoryArchive('request', [source(archive([
    { kind: 'turn_new_messages', turn: 3, messages: [] },
  ]))]), /turn/iu);
  assert.throws(() => readChatHistoryArchive('request', [source(archive([
    { kind: 'turn_new_messages', turn: 2, messages: [{ role: 'invalid', content: 'no' }] },
  ]))]), /line/iu);
});

test('archive import counts a durable rejection as a result without claiming execution', () => {
  const result = readChatHistoryArchive('request', [source(archive([
    { kind: 'turn_command_start', turn: 1, toolCallId: 'tc_0', toolName: 'run', commandToRun: 'echo fixture' },
    { kind: 'turn_command_result', turn: 1, toolCallId: 'tc_0', toolName: 'run', command: 'echo fixture',
      exitCode: null, output: 'Duplicate rejected.', rejectionKind: 'duplicate', rejectionReason: 'already run' },
  ]))]);
  assert.equal(result.completedToolResults, 1);
});

test('historical native replay preserves parallel tool grouping and full outputs', () => {
  const parsed = readChatHistoryArchive('request', [source(archive([
    { kind: 'turn_new_messages', turn: 2, messages: [
      { role: 'assistant', content: 'Inspecting.', tool_calls: [
        { id: 'native-a', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        { id: 'native-b', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
      ] },
      { role: 'tool', tool_call_id: 'native-a', content: 'full a' },
      { role: 'tool', tool_call_id: 'native-b', content: 'full b' },
    ] },
    { kind: 'turn_model_response', turn: 2, text: 'Finished.', thinkingText: '' },
  ]))]);
  const context = reconstructChatArchiveContext(parsed);
  assert.equal(context.messages.length, 5);
  assert.equal(context.messages[1]?.tool_calls?.length, 2);
  assert.equal(context.messages[2]?.content, 'full a');
  assert.equal(context.messages[3]?.content, 'full b');
  assert.equal(context.messages[4]?.content, 'Finished.');
});

test('historical compaction replaces context with the logged summary and retained tail', () => {
  const parsed = readChatHistoryArchive('request', [source(archive([
    { kind: 'turn_preflight_compaction_applied', turn: 2, droppedMessageCount: 1 },
    { kind: 'turn_new_messages', turn: 2, messages: [
      { role: 'system', content: 'fixture policy' },
      { role: 'assistant', content: 'Retained summary.' },
      { role: 'user', content: 'steer once' },
    ] },
    { kind: 'turn_model_response', turn: 2, text: 'Continuing.', thinkingText: '' },
  ]))]);
  const context = reconstructChatArchiveContext(parsed);
  assert.deepEqual(context.messages.map(message => message.content), ['fixture policy', 'Retained summary.', 'steer once', 'Continuing.']);
  assert.equal(context.compactions, 1);
});

test('sanitized incident reconstructs 103 turns, 116 outcomes, steering, and compaction', () => {
  const fixture = createChatHistoryArchiveFixture();
  const parsed = readChatHistoryArchive('request', [source(fixture.text)]);
  const context = reconstructChatArchiveContext(parsed);
  assert.equal(parsed.modelTurns, 103);
  assert.equal(parsed.completedToolResults, 116);
  assert.equal(parsed.executedToolResults, 115);
  assert.equal(parsed.rejectedToolResults, 1);
  assert.equal(parsed.events.filter(event => event.kind === 'queued_user_message').length, 1);
  assert.equal(context.compactions, 1);
  assert.equal(context.continuationReady, true);
  assert.equal(context.messages.at(-1)?.content, 'Fixture turn 103.');
});

test('archive projection preserves full outcomes, turn-41 identity, reasoning policy, and final partial text', () => {
  const fixture = createChatHistoryArchiveFixture();
  const parsed = readChatHistoryArchive('request', [source(fixture.text)]);
  const projected = projectChatHistoryArchive(parsed, { requestId: 'request', maxTurns: 200, includeThinking: false });
  const tools = projected.messages.filter(message => message.kind === 'assistant_tool_call');
  assert.equal(tools.length, 116);
  assert.equal(tools.filter(message => message.toolCallExecutionState === 'rejected').length, 1);
  assert.equal(tools.filter(message => message.toolCallExecutionState === 'completed').length, 115);
  assert.ok(tools.every(message => typeof message.toolCallOutput === 'string' && message.toolCallOutput.length > 200));
  assert.equal(projected.messages.filter(message => message.id === fixture.queueId).length, 1);
  assert.equal(projected.messages.filter(message => message.kind === 'compaction_summary').length, 1);
  assert.equal(projected.messages.some(message => message.kind === 'assistant_thinking'), false);
  assert.equal(projected.messages.at(-1)?.content, 'Fixture turn 103.');
});

test('retained native messages link to exact display IDs for deletion and enforce reasoning policy', () => {
  const fixture = createChatHistoryArchiveFixture();
  const parsed = readChatHistoryArchive('request', [source(fixture.text)]);
  const linked = linkChatArchiveContext(parsed, { requestId: 'request', includeThinking: false });
  assert.equal(linked.messages.some(message => message.reasoning_content !== undefined), false);
  assert.ok(linked.messages.filter(message => message.role === 'tool').every(message => message.chatMessageId?.startsWith('stopped-request-tool-tc_')));
  assert.equal(linked.messages.at(-1)?.chatMessageId, 'stopped-request-narration-103');
});

test('native-to-display binding rejects an output mismatch instead of pairing by rendered commands', () => {
  const fixture = createChatHistoryArchiveFixture();
  const parsed = readChatHistoryArchive('request', [source(fixture.text)]);
  const context = parsed.events.find(entry => entry.kind === 'turn_new_messages' && entry.event.turn === 103);
  assert.ok(context);
  context.event.messages = [{ role: 'assistant', content: 'Fixture turn 102.', tool_calls: [
    { id: 'native-102-0', type: 'function', function: { name: 'read', arguments: '{}' } },
  ] }, { role: 'tool', tool_call_id: 'native-102-0', content: 'truncated' }];
  assert.throws(() => linkChatArchiveContext(parsed, { requestId: 'request', includeThinking: true }), /matching full outcomes/iu);
});

test('native batch identity uses its logged turn boundary even when two calls return identical output', () => {
  const fixture = createChatHistoryArchiveFixture({ repeatedOutcomes: true });
  const parsed = readChatHistoryArchive('request', [source(fixture.text)]);
  const linked = linkChatArchiveContext(parsed, { requestId: 'request', includeThinking: false });
  const repeated = linked.messages.filter(message => message.role === 'tool' && message.content === 'Identical successful result.');
  assert.equal(repeated.length, 2);
  assert.equal(new Set(repeated.map(message => message.chatMessageId)).size, 2);
});

function repairInput(): z.input<typeof ChatHistoryRepairInputSchema> {
  const fixture = createChatHistoryArchiveFixture();
  const runId = '074bbeb7-1111-4111-8111-111111111111';
  return { sessionId: 'session', requestId: 'request', sources: [source(fixture.text)], savedMessages: [],
    includeThinking: true, maxTurns: 200,
    request: { runId, task: 'Inspect fixture safely.', repoRoot: 'C:\\fixture', approval: 'auto', images: [] },
    state: { runId, revision: 3, updatedAtUtc: '2026-09-10T12:20:00.000Z', status: 'approval_timeout', pid: 123,
      approval: { approvalId: 'e08682f5-1111-4111-8111-111111111111', toolName: 'run', command: 'Remove-Item fixture.tmp', reviewPayload: null } },
  };
}

function seedRepairArchive(database: ReturnType<typeof getRuntimeDatabase>) {
  const input = repairInput();
  for (const archive of input.sources) database.prepare(`INSERT INTO runtime_artifacts
    (id, artifact_kind, request_id, title, content_text, content_json, created_at_utc, updated_at_utc)
    VALUES (?, 'repo_search_transcript', ?, 'fixture', ?, NULL, ?, ?)`)
    .run(archive.sourceId, input.requestId, archive.text, at, at);
}

test('repair report keeps a timed-out proposal separate from all 116 recorded outcomes', () => {
  const prepared = prepareChatHistoryRepair(repairInput());
  assert.equal(prepared.report.completedToolResults, 116);
  assert.equal(prepared.report.pendingProposals, 1);
  assert.equal(prepared.report.terminalCause, 'approval_timeout');
  assert.equal(prepared.report.executedToolsDuringImport, 0);
  assert.ok(prepared.report.knownGaps.length > 0, 'missing final native arguments must be disclosed');
});

test('repair rejects mismatched repo-agent state and original submission provenance', () => {
  const input = repairInput();
  assert.throws(() => prepareChatHistoryRepair({ ...input, state: { ...input.state, runId: '074bbeb7-2222-4222-8222-222222222222' } }), /identity/iu);
  assert.throws(() => prepareChatHistoryRepair({ ...input, request: { ...input.request, task: 'Different request.' } }), /submission/iu);
});

test('repair applies atomically and an identical repeat cannot duplicate the transcript', () => {
  const root = createManagedTempDir('chat-archive-repair-');
  const databasePath = join(root, 'runtime.sqlite');
  saveChatSession(root, { ...createTestChatSession(root), id: 'session' });
  const owner = ChatRuntimeOwner.acquire(getRuntimeDatabase(databasePath), 'repair');
  const database = getRuntimeDatabase(databasePath);
  seedRepairArchive(database);
  const prepared = prepareChatHistoryRepair(repairInput());
  assert.equal(applyChatHistoryRepair(database, prepared, prepared.report.expectedDigest, owner).changed, true);
  const session = readChatSessionFromDatabase(database, 'session');
  assert.equal(session?.messages?.length, prepared.messages.length);
  assert.equal(applyChatHistoryRepair(database, prepared, prepared.report.expectedDigest, owner).changed, false);
  assert.equal(new ChatJournalStore(database).listSessionRuns('session').length, 1);
  const history = buildRecoveredChatHistory(database, 'session');
  assert.equal(history.status, 'ok');
  assert.match(JSON.stringify(history.messages), /proposal was not executed/iu);
  owner.release();
});

test('repair rejects a stale digest before creating any journal or display row', () => {
  const root = createManagedTempDir('chat-archive-repair-stale-');
  const databasePath = join(root, 'runtime.sqlite');
  saveChatSession(root, { ...createTestChatSession(root), id: 'session' });
  const owner = ChatRuntimeOwner.acquire(getRuntimeDatabase(databasePath), 'repair');
  const database = getRuntimeDatabase(databasePath);
  seedRepairArchive(database);
  const prepared = prepareChatHistoryRepair(repairInput());
  assert.throws(() => applyChatHistoryRepair(database, prepared, '0'.repeat(64), owner), /digest/iu);
  assert.equal(new ChatJournalStore(database).listSessionRuns('session').length, 0);
  assert.equal(readChatSessionFromDatabase(database, 'session')?.messages?.length, 0);
  owner.release();
});

test('repair validates queue turn provenance and rolls projection failures back with the ledger', () => {
  const root = createManagedTempDir('chat-archive-repair-rollback-');
  const databasePath = join(root, 'runtime.sqlite');
  saveChatSession(root, { ...createTestChatSession(root), id: 'session' });
  const owner = ChatRuntimeOwner.acquire(getRuntimeDatabase(databasePath), 'repair');
  const database = getRuntimeDatabase(databasePath);
  seedRepairArchive(database);
  const queue = new ChatMessageQueueStore(database);
  const fixture = createChatHistoryArchiveFixture();
  queue.enqueue('session', { id: fixture.queueId, content: 'Preserve fixture data.', images: [], options: { operationKind: 'repo-agent' } });
  queue.claim('session', { requestId: 'request', turn: 42, ids: null });
  const prepared = prepareChatHistoryRepair(repairInput());
  assert.throws(() => applyChatHistoryRepair(database, prepared, prepared.report.expectedDigest, owner), /queue.*turn/iu);
  database.prepare('UPDATE chat_pending_messages SET delivered_turn=41 WHERE id=?').run(fixture.queueId);
  database.exec(`CREATE TRIGGER fail_repair_projection BEFORE INSERT ON chat_messages
    BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`);
  assert.throws(() => applyChatHistoryRepair(database, prepared, prepared.report.expectedDigest, owner), /projection failed/iu);
  assert.equal(new ChatJournalStore(database).listSessionRuns('session').length, 0);
  assert.equal(queue.listDelivered('session', 'request').length, 1);
  database.exec('DROP TRIGGER fail_repair_projection');
  assert.equal(applyChatHistoryRepair(database, prepared, prepared.report.expectedDigest, owner).changed, true);
  assert.equal(queue.listDelivered('session', 'request').length, 0);
  assert.equal(readChatSessionFromDatabase(database, 'session')?.messages?.filter(message => message.id === fixture.queueId).length, 1);
  owner.release();
});

test('repair refuses source text changed since the reviewed plan even if display rows are unchanged', () => {
  const root = createManagedTempDir('chat-archive-repair-source-drift-');
  const databasePath = join(root, 'runtime.sqlite');
  saveChatSession(root, { ...createTestChatSession(root), id: 'session' });
  const owner = ChatRuntimeOwner.acquire(getRuntimeDatabase(databasePath), 'repair');
  const database = getRuntimeDatabase(databasePath);
  seedRepairArchive(database);
  const prepared = prepareChatHistoryRepair(repairInput());
  database.prepare('UPDATE runtime_artifacts SET content_text=content_text || ? WHERE id=?').run('\n', 'artifact');
  assert.throws(() => applyChatHistoryRepair(database, prepared, prepared.report.expectedDigest, owner), /source.*digest/iu);
  assert.equal(new ChatJournalStore(database).listSessionRuns('session').length, 0);
  owner.release();
});

test('recovery command defaults to dry-run and leaves its source database unchanged', () => {
  const root = createManagedTempDir('chat-recovery-command-');
  const databasePath = join(root, 'runtime.sqlite');
  saveChatSession(root, { ...createTestChatSession(root), id: 'session' });
  const database = getRuntimeDatabase(databasePath);
  seedRepairArchive(database);
  const input = repairInput();
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify(input.state));
  writeFileSync(join(root, 'request.json'), JSON.stringify(input.request));
  closeAllRuntimeDatabases();
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/recover-web-chat.ts'),
    '--database', databasePath, '--session-id', 'session', '--request-id', 'request', '--repo-agent-state', statePath, '--max-turns', '200'],
  { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = ChatHistoryRepairReportSchema.extend({ mode: z.literal('dry-run') }).parse(JSON.parse(result.stdout));
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.completedToolResults, 116);
  const reopened = getRuntimeDatabase(databasePath);
  assert.equal(new ChatJournalStore(reopened).listSessionRuns('session').length, 0);
  assert.equal(readChatSessionFromDatabase(reopened, 'session')?.messages?.length, 0);
});

function runRecoveryCommand(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/recover-web-chat.ts'), ...args], { encoding: 'utf8', timeout: 60_000 });
}

test('recovery command applies once under a verified backup, repeats as a no-op, and refuses stale or incomplete input', () => {
  const root = createManagedTempDir('chat-recovery-command-apply-');
  const databasePath = join(root, 'runtime.sqlite');
  saveChatSession(root, { ...createTestChatSession(root), id: 'session' });
  const database = getRuntimeDatabase(databasePath);
  seedRepairArchive(database);
  const input = repairInput();
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify(input.state));
  writeFileSync(join(root, 'request.json'), JSON.stringify(input.request));
  closeAllRuntimeDatabases();
  const target = ['--database', databasePath, '--session-id', 'session', '--request-id', 'request', '--repo-agent-state', statePath, '--max-turns', '200'];
  const dryRun = runRecoveryCommand(target);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = ChatHistoryRepairReportSchema.extend({ mode: z.literal('dry-run') }).parse(JSON.parse(dryRun.stdout));

  const backupPath = join(root, 'backups', 'before-repair.sqlite');
  const missingBackup = runRecoveryCommand([...target, '--apply', '--expected-digest', plan.expectedDigest]);
  assert.equal(missingBackup.status, 1);
  assert.match(missingBackup.stderr, /backup/iu);
  const staleDigest = runRecoveryCommand([...target, '--apply', '--expected-digest', '0'.repeat(64), '--backup', backupPath]);
  assert.equal(staleDigest.status, 1);
  assert.match(staleDigest.stderr, /digest/iu);
  assert.equal(existsSync(backupPath), false, 'a refused apply must not leave a backup behind');
  assert.equal(new ChatJournalStore(getRuntimeDatabase(databasePath)).listSessionRuns('session').length, 0);
  closeAllRuntimeDatabases();

  const applied = runRecoveryCommand([...target, '--apply', '--expected-digest', plan.expectedDigest, '--backup', backupPath]);
  assert.equal(applied.status, 0, applied.stderr);
  const appliedReport = ChatHistoryRepairReportSchema.extend({ mode: z.literal('apply'), changed: z.boolean(), backupPath: z.string() }).parse(JSON.parse(applied.stdout));
  assert.equal(appliedReport.changed, true);
  assert.equal(appliedReport.executedToolsDuringImport, 0);
  assert.equal(existsSync(backupPath), true);
  const backup = getRuntimeDatabase(backupPath);
  assert.equal(new ChatJournalStore(backup).listSessionRuns('session').length, 0, 'the backup captures the pre-repair state');
  closeAllRuntimeDatabases();
  const repaired = getRuntimeDatabase(databasePath);
  assert.equal(new ChatJournalStore(repaired).listSessionRuns('session').length, 1);
  const messageCount = readChatSessionFromDatabase(repaired, 'session')?.messages?.length ?? 0;
  assert.ok(messageCount > 0);
  closeAllRuntimeDatabases();

  const repeated = runRecoveryCommand([...target, '--apply', '--expected-digest', plan.expectedDigest, '--backup', join(root, 'backups', 'second.sqlite')]);
  assert.equal(repeated.status, 0, repeated.stderr);
  const repeatReport = z.object({ mode: z.literal('apply'), alreadyApplied: z.literal(true), changed: z.literal(false), messages: z.number() }).parse(JSON.parse(repeated.stdout));
  assert.equal(repeatReport.messages, messageCount);
  assert.equal(existsSync(join(root, 'backups', 'second.sqlite')), false, 'a no-op repeat takes no backup');
  const reopened = getRuntimeDatabase(databasePath);
  assert.equal(new ChatJournalStore(reopened).listSessionRuns('session').length, 1);
  assert.equal(readChatSessionFromDatabase(reopened, 'session')?.messages?.length, messageCount);
  closeAllRuntimeDatabases();

  const missingState = runRecoveryCommand(['--database', databasePath, '--session-id', 'session', '--request-id', 'request', '--repo-agent-state', join(root, 'absent.json')]);
  assert.equal(missingState.status, 1);
  const wrongSession = runRecoveryCommand([...target.slice(0, 2), '--session-id', 'absent', ...target.slice(4)]);
  assert.equal(wrongSession.status, 1);
  assert.match(wrongSession.stderr, /session/iu);
});
