import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { InferenceRunRecorder } from '../src/status-server/inference-run-recorder.js';
import { ManagedLlamaFlushQueue } from '../src/status-server/managed-llama-flush-queue.js';
import { readInferenceRun, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';
import { getRuntimeDatabase, closeRuntimeDatabase } from '../src/state/runtime-db.js';

async function withRecorderDatabase(fn: (flushQueue: ManagedLlamaFlushQueue) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-recorder-'));
  getRuntimeDatabase(path.join(root, 'runtime.sqlite'));
  const flushQueue = new ManagedLlamaFlushQueue({ idleDelayMs: 0 });
  try {
    await fn(flushQueue);
  } finally {
    await flushQueue.close();
    closeRuntimeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the recorder captures a run row, its stream text, and its terminal status', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: 'C:/tabby/main.py',
      baseUrl: 'http://127.0.0.1:8098',
      flushQueue,
    });

    const stdout = new PassThrough();
    recorder.attachEngineStdout(stdout);
    stdout.write('loading model\n');
    stdout.end();
    recorder.flush();

    assert.equal(readInferenceRunLogTextByStream(recorder.runId).engine_stdout, 'loading model\n');
    assert.equal(readInferenceRun(recorder.runId)?.status, 'running');
    assert.equal(readInferenceRun(recorder.runId)?.backend, 'exl3');

    recorder.finish({ status: 'ready' });
    assert.equal(readInferenceRun(recorder.runId)?.status, 'ready');
    assert.equal(readInferenceRun(recorder.runId)?.baseUrl, 'http://127.0.0.1:8098');
  });
});

test('the recorder counts stdout and stderr characters separately', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'llama',
      purpose: 'startup',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    recorder.attachLauncherStdout(stdout);
    recorder.attachLauncherStderr(stderr);
    stdout.write('abc');
    stderr.write('de');
    stdout.end();
    stderr.end();

    assert.equal(recorder.progress.stdoutChars, 3);
    assert.equal(recorder.progress.stderrChars, 2);
  });
});

test('a failed run records its exit code and error message', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    recorder.appendLine('engine_stderr', 'boom\n');
    recorder.flush();
    recorder.finish({ status: 'failed', exitCode: 3, errorMessage: 'boom' });

    const run = readInferenceRun(recorder.runId);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.exitCode, 3);
    assert.equal(run?.errorMessage, 'boom');
    assert.equal(readInferenceRunLogTextByStream(recorder.runId).engine_stderr, 'boom\n');
  });
});

test('a null stream is ignored rather than throwing', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'llama',
      purpose: 'shutdown',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    recorder.attachEngineStdout(null);
    recorder.attachEngineStderr(null);
    assert.equal(recorder.progress.stdoutChars, 0);
    assert.equal(recorder.progress.stderrChars, 0);
  });
});

test('chunk flushes reach the queue only once the recorder enables it', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'llama',
      purpose: 'startup',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    recorder.appendLine('launcher_stdout', 'before-ready\n');
    assert.equal(flushQueue.getSnapshot().pendingCount, 0);

    recorder.enableFlushQueue();
    recorder.appendLine('launcher_stdout', 'after-ready\n');
    assert.equal(flushQueue.getSnapshot().pendingCount, 1);

    // Buffered text is readable before the queue drains, and flush() persists it in-process.
    recorder.flush();
    assert.equal(
      readInferenceRunLogTextByStream(recorder.runId).launcher_stdout,
      'before-ready\nafter-ready\n',
    );
  });
});
