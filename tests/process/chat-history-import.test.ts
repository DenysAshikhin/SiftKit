import assert from 'node:assert/strict';
import test from 'node:test';
import { repairInput, seedRepairArchive } from '../helpers/chat-history-archive-fixture.js';
import { ChatHistoryRepairReportSchema } from '../../src/status-server/chat-history-repair.js';
import { z } from '../../src/lib/zod.js';
import { createManagedTempDir } from '../helpers/temp-dirs.js';
import { createTestChatSession } from '../helpers/chat-sessions.js';
import { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { saveChatSession, readChatSessionFromDatabase } from '../../src/state/chat-sessions.js';
import { ChatJournalStore } from '../../src/state/chat-journal.js';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeAllRuntimeDatabases } from '../../src/state/runtime-db.js';

function runRecoveryCommand(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/recover-web-chat.ts'), ...args], { encoding: 'utf8', timeout: 60_000 });
}

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
