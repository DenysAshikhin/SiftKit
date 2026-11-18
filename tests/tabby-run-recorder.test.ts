import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.ts';
import { TabbyRunRecorder } from '../src/status-server/tabby-run-recorder.ts';
import { listEngineEvents } from '../src/state/engine-events.ts';
import { getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { withTempEnv } from './_runtime-helpers.ts';
import { DEAD_BASE_URL } from './helpers/dead-endpoints.ts';

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

const ASGI_ERROR = [
  '23:19:36.937 ERROR:    Exception in ASGI application\n',
  '  + Exception Group Traceback (most recent call last):\n',
  '  |   File "C:\\tabby\\endpoints.py", line 9, in stream\n',
  '  | RuntimeError: CUDA error: an illegal memory access was encountered\n',
  '  +------------------------------------\n',
  '23:19:37.002 INFO:     #1313 chat/completions (stream): 10 tokens generated\n',
].join('');

/** The record TabbyAPI logs when it writes a reply to a client that already hung up. */
const clientDisconnectError = (state: 'closing' | 'closed') => [
  '12:49:12.791 ERROR:    Exception in ASGI application\n',
  '                         File "winloop/handles/stream.pyx", line 703, in winloop.loop.UVStream.write\n',
  `                       RuntimeError: Cannot call write() when UVStream is ${state}\n`,
  '12:49:12.861 INFO:     #2 chat/completions: 1 tokens generated\n',
].join('');

const engineEvents = () => listEngineEvents(getRuntimeDatabase(), 20);

test('an engine ERROR record split across chunks becomes one engine_error event', async () => {
  await withTabbyRecorder((recorder, { stdout }) => {
    stdout.write(ASGI_ERROR.slice(0, 70));
    stdout.write(ASGI_ERROR.slice(70));

    const events = engineEvents();
    assert.deepEqual(events.map((event) => [event.kind, event.inferenceRunId, event.summary]), [[
      'engine_error', recorder.runId, 'Exception in ASGI application — RuntimeError: CUDA error: an illegal memory access was encountered',
    ]]);
    assert.match(events[0]?.detail ?? '', /endpoints\.py/u);
    assert.doesNotMatch(events[0]?.detail ?? '', /tokens generated/u);
  });
});

test('a reply written to a client that already hung up is not an engine error', async () => {
  await withTabbyRecorder((recorder, { stdout, stderr }) => {
    stdout.write(clientDisconnectError('closing'));
    stderr.write(clientDisconnectError('closed'));
    assert.deepEqual(engineEvents(), []);
    assert.equal(recorder.lastEngineError(), null);
  });
});

test('INFO and WARNING records are not engine errors', async () => {
  await withTabbyRecorder((_recorder, { stdout, stderr }) => {
    stdout.write('08:53:57.716 WARNING:  No sampler overrides are configured\n08:53:58.000 INFO:     Loaded\n');
    stderr.write('08:54:18.879 WARNING:  Disabling authentication makes your instance vulnerable.\n');
    assert.deepEqual(engineEvents(), []);
  });
});

test('an ERROR record still open when its stream ends is recorded', async () => {
  await withTabbyRecorder(async (recorder, { stderr }) => {
    stderr.write('01:00:00.000 CRITICAL: Model load failed\nTraceback (most recent call last):\nOSError: [WinError 1450] Insufficient system resources exist');
    stderr.end();
    await recorder.waitForEngineStderrEnd(1_000);
    assert.deepEqual(engineEvents().map((event) => event.summary), ['Model load failed — OSError: [WinError 1450] Insufficient system resources exist']);
  });
});

test('an engine that exits on its own after becoming ready records one engine_exit event', async () => {
  await withTabbyRecorder((recorder, { stderr }) => {
    recorder.finish({ status: 'ready', baseUrl: DEAD_BASE_URL });
    stderr.write(TRACEBACK);
    recorder.finish({ status: 'failed', exitCode: 1 });

    const events = engineEvents();
    assert.deepEqual(events.map((event) => [event.kind, event.summary]), [[
      'engine_exit', 'Engine exited with code 1: RuntimeError: Insufficient VRAM in split for model and cache',
    ]]);
    assert.match(events[0]?.detail ?? '', /Traceback/u);
  });
});

test('a requested stop or a failure before ready records no engine_exit', async () => {
  await withTabbyRecorder((recorder) => {
    recorder.finish({ status: 'failed', exitCode: 1 });
    recorder.finish({ status: 'ready', baseUrl: DEAD_BASE_URL });
    recorder.finish({ status: 'stopped', exitCode: 0 });
    assert.deepEqual(engineEvents(), []);
  });
});
