import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { InferenceRunRecorder } from '../src/status-server/inference-run-recorder.js';
import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.js';
import { LlamaRunRecorder } from '../src/status-server/llama-run-recorder.js';
import { readInferenceRun, readInferenceRunLogTextByStream } from '../src/state/inference-runs.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { withTempEnv } from './_runtime-helpers.js';

/**
 * `withTempEnv` chdirs into a temp root, which is what actually isolates the runtime database:
 * persistence calls that take no explicit path re-resolve it from the working directory.
 */
async function withRecorderDatabase(fn: (flushQueue: InferenceRunFlushQueue) => Promise<void>): Promise<void> {
  await withTempEnv(async () => {
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    try {
      await fn(flushQueue);
    } finally {
      await flushQueue.close();
    }
  });
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

test('finalize records the terminal status and flushes buffered chunks', async () => {
  await withRecorderDatabase(async (flushQueue) => {
    const recorder = new InferenceRunRecorder({
      backend: 'exl3',
      purpose: 'startup',
      entrypointPath: null,
      baseUrl: null,
      flushQueue,
    });

    recorder.appendLine('engine_stderr', 'crashed\n');
    recorder.finalize({ status: 'failed', exitCode: 9, errorMessage: 'crashed' });

    const run = readInferenceRun(recorder.runId);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.exitCode, 9);
    assert.equal(readInferenceRunLogTextByStream(recorder.runId).engine_stderr, 'crashed\n');
  });
});

/**
 * Child exit lands in an EventEmitter handler, where a throw is an unhandled exception that kills
 * the process. Both backends must survive an exit that arrives after the runtime DB has closed.
 */
for (const backend of ['exl3', 'llama'] as const) {
  test(`finalize tolerates a closed runtime database for a ${backend} run`, async () => {
    await withRecorderDatabase(async (flushQueue) => {
      const recorder = backend === 'llama'
        ? new LlamaRunRecorder({
          backend,
          purpose: 'startup',
          entrypointPath: null,
          baseUrl: null,
          flushQueue,
        })
        : new InferenceRunRecorder({
          backend,
          purpose: 'startup',
          entrypointPath: null,
          baseUrl: null,
          flushQueue,
        });

      recorder.appendLine('engine_stderr', 'late\n');
      closeRuntimeDatabase();
      assert.doesNotThrow(() => recorder.finalize({ status: 'stopped', exitCode: 0 }));
    });
  });
}

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
