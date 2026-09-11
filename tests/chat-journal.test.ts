import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { ChatJournalStore, ChatJournalIntegrityError, CHAT_JOURNAL_READ_PAGE_BYTES, CHAT_JOURNAL_READ_PAGE_SIZE } from '../src/state/chat-journal.js';
import { CHAT_JOURNAL_EVENT_VERSION, type ChatJournalAppend, type ChatJournalEvent, type ChatRunStart } from '../src/state/chat-journal-schema.js';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.js';
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
      presetId: 'repo-agent',
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

test('a terminal run accepts an identical retry but rejects new evidence', () => {
  const { store } = openFixture('chat-journal-terminal-fence-');
  const run = store.begin(runStart());
  const input = appendInput(run.operationId, 0, proposalEvent('read file'));
  const saved = store.append(input);
  store.finish({ operationId: run.operationId, ownerEpoch: OWNER_EPOCH, terminalCause: 'user_stop', updatedAtUtc: CREATED_AT });
  assert.deepEqual(store.append(input), saved);
  assert.throws(() => store.append({ ...input, eventId: 'late', expectedSequence: 1 }), /terminal|finished/u);
  assert.equal(store.readRun(run.operationId)?.latestSequence, 1);
});

test('journal reads reject altered event bodies even when the altered shape is valid', () => {
  const { store, database } = openFixture('chat-journal-digest-');
  const run = store.begin(runStart());
  store.append(appendInput(run.operationId, 0, proposalEvent('original')));
  database.prepare('UPDATE chat_run_events SET body_json=? WHERE operation_id=?').run(JSON.stringify(proposalEvent('altered')), run.operationId);
  assert.throws(() => store.readAfter(run.operationId, 0, 100), /digest|corrupt/u);
});

test('journal iteration crosses page boundaries and respects its starting cursor', () => {
  const { store, database } = openFixture('chat-journal-pages-');
  const run = store.begin(runStart());
  database.transaction(() => {
    for (let index = 0; index < 503; index += 1) {
      store.append(appendInput(run.operationId, index, proposalEvent('read'), { eventId: `event-${index}` }));
    }
  })();
  assert.deepEqual([...store.readAll(run.operationId)].map(event => event.sequence), Array.from({ length: 503 }, (_, index) => index + 1));
  assert.deepEqual([...store.readAll(run.operationId, 500)].map(event => event.sequence), [501, 502, 503]);
  assert.deepEqual([...store.readAll(run.operationId, 503)], []);
});

test('journal iteration rejects missing runs, gaps, and cursors beyond the committed head', () => {
  const { store, database } = openFixture('chat-journal-page-gaps-');
  assert.throws(() => [...store.readAll(randomUUID())], /does not exist/u);
  const run = store.begin(runStart());
  for (let index = 0; index < 3; index += 1) {
    store.append(appendInput(run.operationId, index, proposalEvent('read'), { eventId: `event-${index}` }));
  }
  assert.throws(() => [...store.readAll(run.operationId, 4)], /cursor/u);
  database.prepare('DELETE FROM chat_run_events WHERE operation_id=? AND sequence=2').run(run.operationId);
  assert.throws(() => [...store.readAll(run.operationId)], /sequence gap/u);
  database.prepare('DELETE FROM chat_run_events WHERE operation_id=? AND sequence=3').run(run.operationId);
  assert.throws(() => [...store.readAll(run.operationId)], /missing committed evidence/u);
});

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
    closeAllRuntimeDatabases();
  }

  try {
    const reopened = new ChatJournalStore(getRuntimeDatabase(databasePath));
    const events = reopened.readAfter(operationId, 0, 100);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event.kind, 'tool_proposed');
    assert.deepEqual(events[0]?.event, proposalEvent('Remove-Item physics.py'));
    assert.equal(reopened.readRun(operationId)?.latestSequence, 1);
  } finally {
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
  }
});

test('a stored event whose version this build does not know fails loudly on read', () => {
  const { database, store } = openFixture('siftkit-chat-journal-version-');
  const start = runStart();
  try {
    store.begin(start);
    store.append(appendInput(start.operationId, 0, proposalEvent('first')));
    database.prepare('UPDATE chat_run_events SET version = ? WHERE operation_id = ?').run(CHAT_JOURNAL_EVENT_VERSION + 1, start.operationId);
    assert.throws(() => store.readAfter(start.operationId, 0, 100), /version/u);
  } finally {
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
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
    closeAllRuntimeDatabases();
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
      store.advanceProjection({ operationId: start.operationId, projectedSequence: 1, projectedDigest: 'digest-1', projectedHistoryRevision: 0 });
      throw new Error('projection failed');
    })());
    assert.equal(store.readRun(start.operationId)?.projectedSequence, 0);
    assert.equal(store.readAfter(start.operationId, 0, 100).length, 1);

    store.advanceProjection({ operationId: start.operationId, projectedSequence: 1, projectedDigest: 'digest-1', projectedHistoryRevision: 2 });
    const advanced = store.readRun(start.operationId);
    assert.equal(advanced?.projectedSequence, 1);
    assert.equal(advanced?.projectedDigest, 'digest-1');
    assert.equal(advanced?.projectedHistoryRevision, 2);
  } finally {
    closeAllRuntimeDatabases();
  }
});

/** Sums the decoded body characters each body fetch returned, as the store's own database sees it. */
function observeBodyFetches(database: RuntimeDatabase): { rows: number; bytes: number }[] {
  const fetches: { rows: number; bytes: number }[] = [];
  const prepare = database.prepare.bind(database);
  const FetchedRowsSchema = z.array(z.object({ body_json: z.string() }));
  database.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!/body_json/u.test(sql) || !/FROM chat_run_events/u.test(sql)) return statement;
    const all = statement.all.bind(statement);
    statement.all = (...parameters: Parameters<typeof all>) => {
      const rows = all(...parameters);
      const parsed = FetchedRowsSchema.safeParse(rows);
      if (parsed.success) fetches.push({ rows: parsed.data.length, bytes: parsed.data.reduce((total, row) => total + row.body_json.length, 0) });
      return rows;
    };
    return statement;
  };
  return fetches;
}

test('readThrough pages by row count and decoded body size, fetching one oversized event alone', () => {
  const { store, database } = openFixture('chat-journal-byte-pages-');
  const run = store.begin(runStart());
  const oversized = 'x'.repeat(CHAT_JOURNAL_READ_PAGE_BYTES + 1024);
  const medium = 'y'.repeat(300 * 1024);
  const events: ChatJournalEvent[] = [
    ...Array.from({ length: 600 }, () => proposalEvent('small')),
    proposalEvent(medium), proposalEvent(medium), proposalEvent(medium), proposalEvent(medium),
    proposalEvent(oversized),
    proposalEvent('after'), proposalEvent('after'),
  ];
  database.transaction(() => {
    for (const [index, event] of events.entries()) store.append(appendInput(run.operationId, index, event, { eventId: `event-${String(index)}` }));
  })();
  const fetches = observeBodyFetches(database);
  const sequences = [...store.readThrough(run.operationId, 0, events.length)].map(envelope => envelope.sequence);
  assert.deepEqual(sequences, Array.from({ length: events.length }, (_, index) => index + 1));
  assert.ok(fetches.length >= 5, JSON.stringify(fetches));
  for (const fetch of fetches) {
    assert.ok(fetch.rows <= CHAT_JOURNAL_READ_PAGE_SIZE, JSON.stringify(fetch));
    assert.ok(fetch.rows === 1 || fetch.bytes <= CHAT_JOURNAL_READ_PAGE_BYTES, JSON.stringify(fetch));
  }
  const single = fetches.find(fetch => fetch.bytes > CHAT_JOURNAL_READ_PAGE_BYTES);
  assert.ok(single);
  assert.equal(single.rows, 1);
  assert.equal(fetches.reduce((total, fetch) => total + fetch.rows, 0), events.length);
});

test('readThrough stops at its captured head, rejects bad cursors, and anchors integrity failures', () => {
  const { store, database } = openFixture('chat-journal-read-through-');
  const run = store.begin(runStart());
  for (let index = 0; index < 5; index += 1) store.append(appendInput(run.operationId, index, proposalEvent('read'), { eventId: `event-${String(index)}` }));
  assert.deepEqual([...store.readThrough(run.operationId, 1, 3)].map(envelope => envelope.sequence), [2, 3]);
  assert.deepEqual([...store.readThrough(run.operationId, 3, 3)], []);
  assert.throws(() => [...store.readThrough(run.operationId, 3, 2)], /cursor/u);
  assert.throws(() => [...store.readThrough(run.operationId, -1, 2)]);
  assert.throws(() => [...store.readThrough(run.operationId, 0, 6)], /missing committed evidence/u);

  // A head captured before a later append never yields the newer row.
  const captured = store.readAll(run.operationId);
  assert.equal(captured.next().value?.sequence, 1);
  store.append(appendInput(run.operationId, 5, proposalEvent('late'), { eventId: 'event-late' }));
  assert.deepEqual([...captured].map(envelope => envelope.sequence), [2, 3, 4, 5]);

  database.prepare('UPDATE chat_run_events SET payload_digest=? WHERE operation_id=? AND sequence=4').run('0'.repeat(64), run.operationId);
  assert.throws(() => [...store.readThrough(run.operationId, 0, 6)], (error) => error instanceof ChatJournalIntegrityError
    && error.code === 'conflicting_event' && error.sequence === 4 && error.eventId === 'event-3');
  database.prepare('UPDATE chat_run_events SET version=? WHERE operation_id=? AND sequence=2').run(CHAT_JOURNAL_EVENT_VERSION + 1, run.operationId);
  assert.throws(() => [...store.readThrough(run.operationId, 0, 6)], (error) => error instanceof ChatJournalIntegrityError
    && error.code === 'unknown_event_version' && error.sequence === 2);
  database.prepare('DELETE FROM chat_run_events WHERE operation_id=? AND sequence=3').run(run.operationId);
  assert.throws(() => [...store.readThrough(run.operationId, 2, 6)], /sequence gap/u);
});
