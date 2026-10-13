import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.ts';
import { TabbyRunRecorder } from '../src/status-server/tabby-run-recorder.ts';
import { withTempEnv } from './_runtime-helpers.ts';

/** Runs `fn` with a Tabby recorder whose engine streams are attached, inside an isolated runtime database. */
async function withTabbyRecorder(
  fn: (recorder: TabbyRunRecorder, streams: { stdout: PassThrough; stderr: PassThrough }) => void | Promise<void>,
): Promise<void> {
  await withTempEnv(async () => {
    const flushQueue = new InferenceRunFlushQueue({ idleDelayMs: 0 });
    try {
      const recorder = new TabbyRunRecorder({
        backend: 'exl3',
        purpose: 'startup',
        entrypointPath: 'C:/tabby/main.py',
        baseUrl: null,
        flushQueue,
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      recorder.attachEngineStdout(stdout);
      recorder.attachEngineStderr(stderr);
      await fn(recorder, { stdout, stderr });
    } finally {
      await flushQueue.close();
    }
  });
}

const TRACEBACK = [
  'Traceback (most recent call last):\r\n',
  '  File "C:\\tabby\\main.py", line 12, in <module>\r\n',
  '    raise RuntimeError("Insufficient VRAM in split for model and cache")\r\n',
  'RuntimeError: Insufficient VRAM in split for model and cache\r\n',
].join('');

test('lastEngineError is null before any stderr arrives', async () => {
  await withTabbyRecorder((recorder) => {
    assert.equal(recorder.lastEngineError(), null);
  });
});

test('lastEngineError names the exception line of a Python traceback', async () => {
  await withTabbyRecorder((recorder, { stderr }) => {
    stderr.write(TRACEBACK);
    assert.equal(recorder.lastEngineError(), 'RuntimeError: Insufficient VRAM in split for model and cache');
  });
});

test('lastEngineError finds an exception line split across chunks', async () => {
  await withTabbyRecorder((recorder, { stderr }) => {
    stderr.write('Traceback (most recent call last):\nOSError: [WinError 1450] Insuff');
    assert.equal(recorder.lastEngineError(), null);
    stderr.write('icient system resources exist\n');
    assert.equal(recorder.lastEngineError(), 'OSError: [WinError 1450] Insufficient system resources exist');
  });
});

test('lastEngineError ignores stdout', async () => {
  await withTabbyRecorder((recorder, { stdout }) => {
    stdout.write('RuntimeError: printed on stdout\n');
    assert.equal(recorder.lastEngineError(), null);
  });
});

test('a later exception line replaces an earlier one, even after the MTP marker', async () => {
  await withTabbyRecorder((recorder, { stderr }) => {
    stderr.write('ValueError: first\n');
    stderr.write('INFO: Using main model MTP component for drafting\n');
    stderr.write('RuntimeError: CPU MoE pinned arena: chunk 42 needs 1024 MiB\n');
    assert.equal(recorder.hasMtpDraftingMarker(), true);
    assert.equal(recorder.lastEngineError(), 'RuntimeError: CPU MoE pinned arena: chunk 42 needs 1024 MiB');
  });
});

test('an unterminated last stderr line is observed when the stream ends', async () => {
  await withTabbyRecorder(async (recorder, { stderr }) => {
    stderr.write('RuntimeError: boom');
    assert.equal(recorder.lastEngineError(), null);
    stderr.end();
    await recorder.waitForEngineStderrEnd(1000);
    assert.equal(recorder.lastEngineError(), 'RuntimeError: boom');
  });
});

test('waitForEngineStderrEnd resolves after its bound when stderr never ends', async () => {
  await withTabbyRecorder(async (recorder) => {
    await recorder.waitForEngineStderrEnd(20);
  });
});
