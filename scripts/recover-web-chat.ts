import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from '../src/lib/zod.js';
import { getRuntimeDatabase, getRuntimeDatabasePath, closeAllRuntimeDatabases } from '../src/state/runtime-db.js';
import { readChatSessionFromDatabase } from '../src/state/chat-sessions.js';
import { ChatJournalStore } from '../src/state/chat-journal.js';
import { ChatRuntimeOwner } from '../src/state/chat-runtime-owner.js';
import { RepoAgentRunRequestSchema, RepoAgentRunStateSchema } from '../src/repo-agent/run-schemas.js';
import { readChatHistoryArchive, readChatHistoryArchiveSources } from '../src/status-server/chat-history-archive.js';
import { prepareChatHistoryRepair, applyChatHistoryRepair } from '../src/status-server/chat-history-repair.js';

const OptionsSchema = z.object({
  'session-id': z.string().min(1), 'request-id': z.string().min(1), 'repo-agent-state': z.string().min(1),
  database: z.string().min(1).optional(), backup: z.string().min(1).optional(),
  'dry-run': z.boolean().optional(), apply: z.boolean().optional(),
  'expected-digest': z.string().length(64).optional(),
  'max-turns': z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().positive()).optional(),
});

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    'session-id': { type: 'string' }, 'request-id': { type: 'string' }, 'repo-agent-state': { type: 'string' },
    database: { type: 'string' }, backup: { type: 'string' }, 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' },
    'expected-digest': { type: 'string' }, 'max-turns': { type: 'string' },
  } });
  const options = OptionsSchema.parse(values);
  if (options.apply && options['dry-run']) throw new Error('Choose --apply or --dry-run, not both.');
  if (options.apply && (!options['expected-digest'] || !options.backup)) throw new Error('--apply requires --expected-digest and a new --backup path.');
  const databasePath = resolve(options.database ?? getRuntimeDatabasePath());
  const statePath = resolve(options['repo-agent-state']);
  const request = RepoAgentRunRequestSchema.parse(JSON.parse(readFileSync(join(dirname(statePath), 'request.json'), 'utf8')));
  const state = RepoAgentRunStateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')));
  const scratchPath = resolve('.scratch/web-chat-recovery');
  mkdirSync(scratchPath, { recursive: true });
  const scratchRoot = realpathSync(scratchPath);
  const previewRoot = mkdtempSync(join(scratchRoot, 'cli-preview-'));
  if (dirname(realpathSync(previewRoot)) !== scratchRoot) throw new Error('Recovery preview escaped its scratch directory.');
  const previewPath = join(previewRoot, 'runtime.sqlite');
  try {
    const source = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { await source.backup(previewPath); } finally { source.close(); }
    // All schema work for a dry run happens on the consistent disposable copy.
    const preview = getRuntimeDatabase(previewPath);
    const session = readChatSessionFromDatabase(preview, options['session-id']);
    if (!session) throw new Error('The exact target session does not exist.');
    const sources = readChatHistoryArchiveSources(preview, options['request-id']);
    const archive = readChatHistoryArchive(options['request-id'], sources);
    const previous = new ChatJournalStore(preview).listSessionRuns(session.id)
      .find(run => run.provenance?.sourceKind === 'run_archive' && run.provenance.sourceId === options['request-id']);
    const prepared = prepareChatHistoryRepair({ sessionId: session.id, requestId: options['request-id'], sources, request, state,
      savedMessages: previous ? [] : session.messages ?? [], includeThinking: session.thinkingEnabled ?? false,
      maxTurns: options['max-turns'] ?? Math.max(1, archive.modelTurns) });
    if (previous?.provenance?.sourceKind === 'run_archive') {
      if (previous.provenance.sourceDigest !== prepared.report.sourceDigest) throw new Error('Existing import has a conflicting source digest.');
      if (options.apply && options['expected-digest'] !== previous.provenance.repairDigest) throw new Error('Reviewed repair digest does not match the existing import.');
      process.stdout.write(`${JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', alreadyApplied: true, changed: false,
        operationId: previous.operationId, sourceDigest: previous.provenance.sourceDigest, expectedDigest: previous.provenance.repairDigest,
        messages: session.messages?.length ?? 0, executedToolsDuringImport: 0 }, null, 2)}\n`);
      return;
    }
    if (options['max-turns'] === undefined) prepared.report.knownGaps.push('The display turn limit uses the observed turn count; supply --max-turns when the historical configured limit is known.');
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify({ mode: 'dry-run', ...prepared.report }, null, 2)}\n`);
      return;
    }
    const expectedDigest = options['expected-digest'];
    const backup = options.backup;
    if (!expectedDigest || !backup) throw new Error('Apply requires the reviewed digest and backup path.');
    if (expectedDigest !== prepared.report.expectedDigest) throw new Error('Current repair digest differs from the reviewed report.');
    const backupPath = resolve(backup);
    if (backupPath === databasePath || existsSync(backupPath)) throw new Error('Backup must be a new file distinct from the source database.');
    mkdirSync(dirname(backupPath), { recursive: true });
    const sourceForBackup = new Database(databasePath, { readonly: true, fileMustExist: true });
    try { await sourceForBackup.backup(backupPath); } finally { sourceForBackup.close(); }
    const verifiedBackup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = z.array(z.object({ integrity_check: z.literal('ok') })).length(1).safeParse(verifiedBackup.prepare('PRAGMA integrity_check').all());
      if (!integrity.success || verifiedBackup.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('Backup integrity validation failed.');
    } finally { verifiedBackup.close(); }
    const database = getRuntimeDatabase(databasePath);
    const owner = ChatRuntimeOwner.acquire(database, `repair-${randomUUID()}`);
    try {
      const applied = applyChatHistoryRepair(database, prepared, expectedDigest, owner);
      process.stdout.write(`${JSON.stringify({ mode: 'apply', changed: applied.changed, backupPath, ...applied.report }, null, 2)}\n`);
    } finally { owner.release(); }
  } finally {
    closeAllRuntimeDatabases();
    rmSync(previewRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof z.ZodError ? 'Recovery input failed schema validation.'
    : error instanceof Error ? error.message : 'Recovery failed.' })}\n`);
  process.exitCode = 1;
});
