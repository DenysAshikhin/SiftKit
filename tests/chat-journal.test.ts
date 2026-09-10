import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore } from '../src/state/chat-journal.js';
import type { ChatJournalAppend, ChatJournalEvent, ChatRunStart } from '../src/state/chat-journal-schema.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import type { RuntimeDatabase } from '../src/state/runtime-db.js';
import { saveChatSession } from '../src/state/chat-sessions.js';
import { z } from '../src/lib/zod.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { mockModelPreset } from './helpers/mock-config.js';

const OWNER_EPOCH = 'owner-a:1';
const OTHER_OWNER_EPOCH = 'owner-b:2';
const SESSION_ID = 'journal-session';
const CREATED_AT = '2026-09-10T11:04:54.755Z';

const PragmaRowSchema = z.object({ synchronous: z.number().int() });

type Fixture = { database: RuntimeDatabase; store: ChatJournalStore; databasePath: string };

function openFixture(prefix: string): Fixture {
  const runtimeRoot = createManagedTempDir(prefix);
  const databasePath = path.join(runtimeRoot, 'runtime.sqlite');
  saveChatSession(runtimeRoot, {
    id: SESSION_ID,
    title: 'Journal session',
    modelPresetId: 'preset-a',
    modelPreset: mockModelPreset({ Model: 'model-a', NumCtx: 4096 }),
    presetId: 'chat',
    mode: 'chat',
    planRepoRoot: 'C:/repo',
    createdAtUtc: CREATED_AT,
    updatedAtUtc: CREATED_AT,
    messages: [],
  });
  const database = getRuntimeDatabase(databasePath);
  return { database, store: new ChatJournalStore(database), databasePath };
}

function runStart(overrides: Partial<ChatRunStart> = {}): ChatRunStart {
  return {
    operationId: randomUUID(),
    sessionId: SESSION_ID,
    recordKind: 'execution',
    operationKind: 'repo-agent',
    ownerEpoch: OWNER_EPOCH,
    settings: {
      operationKind: 'repo-agent',
      mode: 'chat',
      modelPresetId: 'preset-a',
      model: 'model-a',
      repoRoot: 'C:/repo',
      approval: 'interactive',
      maxTurns: 120,
      thinkingEnabled: true,
      webSearchEnabled: false,
      contextWindowTokens: 4096,
    },
    provenance: null,
    createdAtUtc: CREATED_AT,
    ...overrides,
  };
}

function proposalEvent(command: string): ChatJournalEvent {
  return {
    kind: 'tool_proposed',
    call: { toolCallId: 'call-1', displayToolCallId: 'tc_0', batchId: 'batch-1', turn: 41, indexInBatch: 0 },
    toolName: 'run',
    arguments: { command },
    command,
    activityKind: 'command',
    activitySubject: { kind: 'file', value: 'research/brawl_sim/physics.py' },
    maxTurns: 120,
    promptTokenCount: 100,
    executionState: 'proposed',
  };
}

function appendInput(
  operationId: string,
  expectedSequence: number,
  event: ChatJournalEvent,
  overrides: Partial<ChatJournalAppend> = {},
): ChatJournalAppend {
  return {
    operationId,
    ownerEpoch: OWNER_EPOCH,
    expectedSequence,
    eventId: 'event-1',
    occurredAtUtc: CREATED_AT,
    event,
    ...overrides,
  };
}

test('a committed event survives reopening and an identical retry does not duplicate it', () => {
  const { store, databasePath } = openFixture('siftkit-chat-journal-commit-');
  const start = runStart();
  const operationId = start.operationId;
  try {
    const run = store.begin(start);
    assert.equal(run.runOrder, 1);
    assert.equal(run.latestSequence, 0);
    assert.equal(run.terminalCause, null);

    const first = store.append(appendInput(operationId, 0, proposalEvent('Remove-Item physics.py')));
    assert.equal(first.sequence, 1);
    assert.equal(store.readAfter(operationId, 0, 100).length, 1);

    const retry = store.append(appendInput(operationId, 0, proposalEvent('Remove-Item physics.py')));
    assert.equal(retry.sequence, first.sequence);
    assert.deepEqual(retry, first);
    assert.equal(store.readAfter(operationId, 0, 100).length, 1);
    assert.equal(store.readRun(operationId)?.latestSequence, 1);
  } finally {
    closeRuntimeDatabase();
  }

  try {
    const reopened = new ChatJournalStore(getRuntimeDatabase(databasePath));
    const events = reopened.readAfter(operationId, 0, 100);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event.kind, 'tool_proposed');
    assert.deepEqual(events[0]?.event, proposalEvent('Remove-Item physics.py'));
    assert.equal(reopened.readRun(operationId)?.latestSequence, 1);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a different payload under an already-used event id is corruption, not a retry', () => {
  const { store } = openFixture('siftkit-chat-journal-conflict-');
  const start = runStart();
  try {
    store.begin(start);
    store.append(appendInput(start.operationId, 0, proposalEvent('Remove-Item physics.py')));
    assert.throws(
      () => store.append(appendInput(start.operationId, 0, proposalEvent('Remove-Item other.py'))),
      /conflicting event/u,
    );
    assert.equal(store.readAfter(start.operationId, 0, 100).length, 1);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a stale sequence or a stale owner cannot append', () => {
  const { store } = openFixture('siftkit-chat-journal-cas-');
  const start = runStart();
  try {
    store.begin(start);
    store.append(appendInput(start.operationId, 0, proposalEvent('first')));

    assert.throws(
      () => store.append(appendInput(start.operationId, 0, proposalEvent('second'), { eventId: 'event-2' })),
      /sequence/u,
    );
    assert.throws(
      () => store.append(appendInput(start.operationId, 1, proposalEvent('second'), {
        eventId: 'event-2',
        ownerEpoch: OTHER_OWNER_EPOCH,
      })),
      /owner/u,
    );
    assert.equal(store.readAfter(start.operationId, 0, 100).length, 1);

    const accepted = store.append(appendInput(start.operationId, 1, proposalEvent('second'), { eventId: 'event-2' }));
    assert.equal(accepted.sequence, 2);
  } finally {
    closeRuntimeDatabase();
  }
});

test('appending to or binding an unknown run fails instead of creating one', () => {
  const { store } = openFixture('siftkit-chat-journal-missing-');
  const missingId = randomUUID();
  try {
    assert.throws(() => store.append(appendInput(missingId, 0, proposalEvent('nothing'))), /is unknown to the chat journal/u);
    assert.throws(() => store.bindEngine({
      operationId: missingId,
      ownerEpoch: OWNER_EPOCH,
      requestId: 'request-1',
      repoAgentSessionId: null,
    }), /is unknown to the chat journal/u);
    assert.equal(store.readRun(missingId), null);
  } finally {
    closeRuntimeDatabase();
  }
});

test('an engine binding is allocated once and cannot be claimed by another run', () => {
  const { store } = openFixture('siftkit-chat-journal-binding-');
  const first = runStart();
  try {
    store.begin(first);
    const bound = store.bindEngine({
      operationId: first.operationId,
      ownerEpoch: OWNER_EPOCH,
      requestId: '706f2e52-01ec-4e62-9dc0-b7ced282e27e',
      repoAgentSessionId: '074bbeb7-88aa-4412-8e38-94ad8bf1cf80',
    });
    assert.equal(bound.requestId, '706f2e52-01ec-4e62-9dc0-b7ced282e27e');
    assert.equal(bound.repoAgentSessionId, '074bbeb7-88aa-4412-8e38-94ad8bf1cf80');

    assert.throws(() => store.bindEngine({
      operationId: first.operationId,
      ownerEpoch: OWNER_EPOCH,
      requestId: 'a-different-request',
      repoAgentSessionId: null,
    }), /already bound/u);

    store.finish({ operationId: first.operationId, ownerEpoch: OWNER_EPOCH, terminalCause: 'completed', updatedAtUtc: CREATED_AT });
    const second = runStart();
    store.begin(second);
    assert.throws(() => store.bindEngine({
      operationId: second.operationId,
      ownerEpoch: OWNER_EPOCH,
      requestId: '706f2e52-01ec-4e62-9dc0-b7ced282e27e',
      repoAgentSessionId: null,
    }), /UNIQUE|already/u);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a session admits one unfinished execution at a time and orders its runs', () => {
  const { store } = openFixture('siftkit-chat-journal-active-');
  const first = runStart();
  const second = runStart();
  try {
    store.begin(first);
    assert.throws(() => store.begin(second), /UNIQUE|active/u);

    store.finish({ operationId: first.operationId, ownerEpoch: OWNER_EPOCH, terminalCause: 'user_stop', updatedAtUtc: CREATED_AT });
    const secondRun = store.begin(second);
    assert.equal(secondRun.runOrder, 2);
    assert.deepEqual(
      store.listSessionRuns(SESSION_ID).map((run) => run.operationId),
      [first.operationId, second.operationId],
    );
    assert.equal(store.readRun(first.operationId)?.terminalCause, 'user_stop');
  } finally {
    closeRuntimeDatabase();
  }
});

test('a stored event whose version this build does not know fails loudly on read', () => {
  const { database, store } = openFixture('siftkit-chat-journal-version-');
  const start = runStart();
  try {
    store.begin(start);
    store.append(appendInput(start.operationId, 0, proposalEvent('first')));
    database.prepare('UPDATE chat_run_events SET version = 2 WHERE operation_id = ?').run(start.operationId);
    assert.throws(() => store.readAfter(start.operationId, 0, 100), /version/u);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a malformed stored body fails loudly instead of returning a partial event', () => {
  const { database, store } = openFixture('siftkit-chat-journal-malformed-');
  const start = runStart();
  try {
    store.begin(start);
    store.append(appendInput(start.operationId, 0, proposalEvent('first')));
    database.prepare('UPDATE chat_run_events SET body_json = ? WHERE operation_id = ?')
      .run('{"kind":"tool_proposed"}', start.operationId);
    assert.throws(() => store.readAfter(start.operationId, 0, 100));
  } finally {
    closeRuntimeDatabase();
  }
});

test('reads are paged from a cursor rather than loading a whole conversation', () => {
  const { store } = openFixture('siftkit-chat-journal-paging-');
  const start = runStart();
  try {
    store.begin(start);
    for (let index = 0; index < 25; index += 1) {
      store.append(appendInput(start.operationId, index, proposalEvent(`command-${String(index)}`), {
        eventId: `event-${String(index)}`,
      }));
    }
    const firstPage = store.readAfter(start.operationId, 0, 10);
    assert.equal(firstPage.length, 10);
    assert.deepEqual(firstPage.map((envelope) => envelope.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const collected: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = store.readAfter(start.operationId, cursor, 10);
      if (page.length === 0) break;
      for (const envelope of page) collected.push(envelope.sequence);
      cursor = page[page.length - 1]?.sequence ?? cursor;
    }
    assert.equal(collected.length, 25);
    assert.deepEqual(collected, Array.from({ length: 25 }, (_value, index) => index + 1));
  } finally {
    closeRuntimeDatabase();
  }
});

test('the journal connection stays fully durable across repeated runtime database access', () => {
  const { database, databasePath } = openFixture('siftkit-chat-journal-durability-');
  try {
    const readSynchronous = (handle: RuntimeDatabase): number => PragmaRowSchema.parse(
      handle.prepare('PRAGMA synchronous').get(),
    ).synchronous;
    assert.equal(readSynchronous(database), 2);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(readSynchronous(getRuntimeDatabase(databasePath)), 2);
    }
  } finally {
    closeRuntimeDatabase();
  }
});

test('a projection failure cannot roll back the source event', () => {
  const { database, store } = openFixture('siftkit-chat-journal-projection-');
  const start = runStart();
  try {
    store.begin(start);
    store.append(appendInput(start.operationId, 0, proposalEvent('first')));
    assert.equal(store.readRun(start.operationId)?.projectedSequence, 0);

    // The projector's own write is what fails here; the committed evidence must not move with it.
    assert.throws(() => database.transaction(() => {
      store.advanceProjection({ operationId: start.operationId, projectedSequence: 1 });
      throw new Error('projection failed');
    })());
    assert.equal(store.readRun(start.operationId)?.projectedSequence, 0);
    assert.equal(store.readAfter(start.operationId, 0, 100).length, 1);

    store.advanceProjection({ operationId: start.operationId, projectedSequence: 1 });
    assert.equal(store.readRun(start.operationId)?.projectedSequence, 1);
  } finally {
    closeRuntimeDatabase();
  }
});
