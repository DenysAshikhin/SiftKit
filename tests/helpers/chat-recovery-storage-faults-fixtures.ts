import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from '../../src/lib/zod.ts';
import { getAbortError } from '../../src/lib/abort.ts';
import { ChatJournalStore } from '../../src/state/chat-journal.ts';
import { getRuntimeDatabase } from '../../src/state/runtime-db.ts';
import type { RuntimeDatabase } from '../../src/state/database-handle.ts';
import { saveChatSession } from '../../src/state/chat-sessions.ts';
import { ChatRunRecorder } from '../../src/status-server/chat-run-recorder.ts';
import { createManagedTempDir } from './temp-dirs.ts';
import { mockModelPreset } from './mock-config.ts';

const OWNER_EPOCH = 'owner-fault:1';

export function openSessionDatabase(prefix: string): { database: RuntimeDatabase; databasePath: string } {
  const runtimeRoot = createManagedTempDir(prefix);
  saveChatSession(runtimeRoot, {
    id: SESSION_ID, title: 'Storage faults', modelPresetOverrideId: null, modelPresetId: 'preset-a', modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'repo-agent', mode: 'repo-search', planRepoRoot: 'C:/repo', orchestratorRunId: null, createdAtUtc: AT, updatedAtUtc: AT, messages: [],
  });
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  return { database: getRuntimeDatabase(databasePath), databasePath };
}

/** A run that has published text and proposed one command: the prefix a fault must not lose. */
export function beginProposedRun(databasePath: string): ChatRunRecorder {
  const recorder = ChatRunRecorder.begin(getRuntimeDatabase(databasePath), {
    operationId: randomUUID(), sessionId: SESSION_ID, ownerEpoch: OWNER_EPOCH, operationKind: 'repo-agent',
    userMessageId: 'user-1', content: 'exercise storage faults', images: [], imageMeta: [],
    settings: {
      operationKind: 'repo-agent', mode: 'repo-search', presetId: 'repo-agent', modelPresetOverrideId: null, modelPresetId: 'preset-a', model: 'model-a',
      repoRoot: 'C:/repo', approval: 'interactive', maxTurns: 120, thinkingEnabled: false, webSearchEnabled: false, contextWindowTokens: 4096,
    },
    retainedHistoryRevision: 0, startedAtUtc: AT,
  });
  recorder.bindEngine({ requestId: 'request-fault', repoAgentSessionId: randomUUID() });
  recorder.recordContextInitialized({ messages: [{ role: 'user', content: 'exercise storage faults', chatMessageId: 'user-1' }], contextRevision: 0, turnBoundary: 0 });
  recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 0, text: 'Published before the fault. ' } });
  recorder.recordToolProposed({ call: CALL, toolName: 'run', arguments: { command: 'rm -rf build' }, command: 'rm -rf build',
    activityKind: 'command', activitySubject: { kind: 'none' }, maxTurns: 120, promptTokenCount: 10, executionState: 'proposed' });
  return recorder;
}

export function committedKinds(database: RuntimeDatabase, operationId: string): string[] {
  return [...new ChatJournalStore(database).readAll(operationId)].map(envelope => envelope.event.kind);
}

export const CALL = { toolCallId: 'call_a', displayToolCallId: 'tc_0', batchId: 'batch-1', turn: 1, indexInBatch: 0 };

export const AT = '2026-09-10T11:04:54.755Z';

export function assertPrefixIntact(database: RuntimeDatabase, operationId: string, expectedKinds: readonly string[]): void {
  const run = new ChatJournalStore(database).readRun(operationId);
  assert.ok(run);
  assert.deepEqual(committedKinds(database, operationId), expectedKinds);
  assert.equal(run.latestSequence, expectedKinds.length);
  assert.equal(run.terminalCause, null);
}

export const SESSION_ID = 'storage-fault-session';

/**
 * A failed commit is the run's storage failure wherever it surfaced: execution is fenced, a
 * further write is refused at the same head, and the terminal write names the storage cause.
 */
export function assertStorageFailureIsFatal(database: RuntimeDatabase, recorder: ChatRunRecorder, prefix: readonly string[], code: string): void {
  assert.equal(recorder.abortSignal.aborted, true);
  assert.equal(z.object({ code: z.string() }).parse(getAbortError(recorder.abortSignal)).code, code);
  assert.throws(() => recorder.recordDisplay({ kind: 'narration', delta: { turn: 1, offset: 28, text: 'after the fault' } }), { code });
  assertPrefixIntact(database, recorder.operationId, prefix);
  recorder.finish({ terminalCause: 'completed', detail: null, usage: null, recoveryStatus: 'ok' });
  const run = new ChatJournalStore(database).readRun(recorder.operationId);
  assert.equal(run?.terminalCause, 'storage_failure');
  const finished = [...new ChatJournalStore(database).readAll(recorder.operationId)].at(-1)?.event;
  assert.equal(finished?.kind === 'run_finished' && finished.terminalCause, 'storage_failure');
}

