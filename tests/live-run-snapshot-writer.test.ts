import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LiveRunSnapshotCollector } from '../src/repo-search/live-snapshot/collector.js';
import { LiveRunSnapshotSchema } from '../src/repo-search/live-snapshot/schemas.js';
import {
  attachLiveRunSnapshot,
  isLiveRunSnapshotEnabled,
  LiveRunSnapshotWriter,
} from '../src/repo-search/live-snapshot/writer.js';
import { createJsonLogger } from '../src/repo-search/logging.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';

function readSnapshot(filePath: string): ReturnType<typeof LiveRunSnapshotSchema.parse> {
  return LiveRunSnapshotSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

test('writer flushes the collector state to disk as parseable json', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-');
  const filePath = path.join(tempRoot, 'live', 'run-req-1.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-1', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });

  try {
    collector.record({ kind: 'turn_model_request', taskId: 't', turn: 7, thinkingEnabled: false });
    await writer.flushNow();

    const snapshot = readSnapshot(filePath);
    assert.equal(snapshot.requestId, 'req-1');
    assert.equal(snapshot.phase.name, 'model_request');
    assert.equal(snapshot.phase.turn, 7);
  } finally {
    writer.stop();
  }
});

test('writer flushes the latest state after scheduled updates', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-scheduled-');
  const filePath = path.join(tempRoot, 'run.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-2', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });

  try {
    for (let turn = 1; turn <= 25; turn += 1) {
      collector.record({ kind: 'turn_preflight_start', taskId: 't', turn, promptChars: turn });
      writer.schedule();
    }
    await writer.flushNow();

    const snapshot = readSnapshot(filePath);
    assert.equal(snapshot.turnsRecorded, 25);
    assert.equal(fs.readdirSync(path.dirname(filePath)).length, 1);
  } finally {
    writer.stop();
  }
});

test('writer removes the snapshot file on remove', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-remove-');
  const filePath = path.join(tempRoot, 'run.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-3', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });

  await writer.flushNow();
  assert.equal(fs.existsSync(filePath), true);

  writer.stop();
  await writer.remove();
  assert.equal(fs.existsSync(filePath), false);
  await writer.remove();
});

test('writer removes the snapshot without yielding to a macrotask', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-remove-order-');
  const filePath = path.join(tempRoot, 'run.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-remove-order',
    taskKind: 'repo-search',
    repoRoot: tempRoot,
    startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });
  let immediateFired = false;
  const immediate = setImmediate(() => {
    immediateFired = true;
  });

  try {
    await writer.remove();
    assert.equal(immediateFired, false);
  } finally {
    clearImmediate(immediate);
    writer.stop();
  }
});

test('writer does not recreate the snapshot after stop', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-writer-stop-');
  const filePath = path.join(tempRoot, 'run.json');
  const collector = new LiveRunSnapshotCollector({
    requestId: 'req-stop', taskKind: 'repo-search', repoRoot: tempRoot, startedAtMs: Date.now(),
  });
  const writer = new LiveRunSnapshotWriter({ filePath, collector });

  writer.schedule();
  writer.stop();
  await writer.flushNow();

  assert.equal(fs.existsSync(filePath), false);
});

test('attachLiveRunSnapshot forwards events to the wrapped logger and the snapshot', async () => {
  const tempRoot = createManagedTempDir('siftkit-live-attach-');
  const filePath = path.join(tempRoot, 'run.json');
  const inner = createJsonLogger('db://repo-search/request_attach.jsonl');
  const attached = attachLiveRunSnapshot({
    logger: inner,
    filePath,
    requestId: 'req-4',
    taskKind: 'repo-agent',
    repoRoot: tempRoot,
    startedAtMs: Date.now(),
  });

  try {
    attached.logger.write({ kind: 'turn_model_request', taskId: 't', turn: 3, thinkingEnabled: false });
    await attached.writer.flushNow();

    assert.equal(attached.logger.path, inner.path);
    assert.ok(inner.getText().includes('"kind":"turn_model_request"'));
    assert.equal(readSnapshot(filePath).phase.turn, 3);
  } finally {
    attached.writer.stop();
  }
});

test('live run snapshot is enabled by default and disabled by SIFTKIT_LIVE_SNAPSHOT=0', () => {
  const previous = process.env.SIFTKIT_LIVE_SNAPSHOT;
  try {
    delete process.env.SIFTKIT_LIVE_SNAPSHOT;
    assert.equal(isLiveRunSnapshotEnabled(), true);

    process.env.SIFTKIT_LIVE_SNAPSHOT = '0';
    assert.equal(isLiveRunSnapshotEnabled(), false);

    process.env.SIFTKIT_LIVE_SNAPSHOT = 'false';
    assert.equal(isLiveRunSnapshotEnabled(), false);

    process.env.SIFTKIT_LIVE_SNAPSHOT = '1';
    assert.equal(isLiveRunSnapshotEnabled(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.SIFTKIT_LIVE_SNAPSHOT;
    } else {
      process.env.SIFTKIT_LIVE_SNAPSHOT = previous;
    }
  }
});
