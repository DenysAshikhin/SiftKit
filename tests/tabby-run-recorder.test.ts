import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { InferenceRunFlushQueue } from '../src/status-server/inference-run-flush-queue.ts';
import { TabbyRunRecorder } from '../src/status-server/tabby-run-recorder.ts';
import { listEngineEvents } from '../src/state/engine-events.ts';
import { getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { serverLogger } from '../src/status-server/server-logger.ts';
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

test('TabbyAPI\'s 503 reply while no model is loaded, which SiftKit\'s post-unload probe expects, is not an engine error', async () => {
  await withTabbyRecorder((_recorder, { stdout }) => {
    stdout.write('11:23:28.216 INFO:     Model unloaded.\r\n11:23:28.219 ERROR:    Sent to request: No models are currently loaded.\r\n');
    stdout.write('11:23:30.808 INFO:     exllamav3 version: 1.6.7\r\n');
    assert.deepEqual(engineEvents(), []);
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

// Recorded from a 27B preset whose 3 GiB disk budget held less than one full context.
const DISK_TIER_BELOW_BUDGET = '11:22:51.000 INFO:     Disk cache tier: saved 90 pages (23040 tokens) and 0 checkpoints, 812 MB of pages (continues). On disk: 208 pages, 0 checkpoints, 1.9 of 3.0 GB\r\n';
const DISK_TIER_AT_BUDGET = '11:23:27.625 INFO:     Disk cache tier: saved 409 pages (104704 tokens) and 7 checkpoints, 3695 MB of pages. On disk: 298 pages, 5 checkpoints, 3.0 of 3.0 GB\r\n';
const DISK_LOAD_AT_BUDGET = '11:24:30.170 INFO:     Disk cache: S:\\exl3-3-8-27b-5bpw\\33c18c1067132e06 holds 298 pages (0 reusable tokens) and 5 recurrent checkpoints, 3.00 GB of 3.00 GB.\r\n';
const DISK_OUT_OF_SPACE = '11:30:00.000 WARNING:  Disk cache tier: page failed ([Errno 28] No space left on device); writes paused for 60 seconds (restores from what is already on disk continue)\r\n';

test('a disk cache tier at its budget records one disk_cache_full event per engine run, and warns', async (t) => {
  const warnings = t.mock.method(serverLogger, 'warning', () => {});
  await withTabbyRecorder((recorder, { stdout }) => {
    stdout.write(DISK_TIER_BELOW_BUDGET);
    assert.deepEqual(engineEvents(), []);
    stdout.write(DISK_TIER_AT_BUDGET);
    stdout.write(DISK_LOAD_AT_BUDGET);
    stdout.write(DISK_TIER_AT_BUDGET);

    const events = engineEvents();
    assert.deepEqual(events.map((event) => [event.kind, event.inferenceRunId, event.summary]), [[
      'disk_cache_full', recorder.runId,
      'Disk cache full (3.0 of 3.0 GB): exllamav3 evicts its oldest pages, so long prompts lose their start. Raise the preset\'s disk cache budget.',
    ]]);
    assert.equal(events[0]?.detail, DISK_TIER_AT_BUDGET.trim());
    assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[0]?.event), ['disk_cache_full']);
  });
});

test('a disk cache found full at load, and a disk out of space, are each recorded once', async (t) => {
  t.mock.method(serverLogger, 'warning', () => {});
  await withTabbyRecorder((_recorder, { stdout }) => {
    stdout.write(DISK_LOAD_AT_BUDGET);
    stdout.write(DISK_OUT_OF_SPACE);
    stdout.write(DISK_OUT_OF_SPACE);
    assert.deepEqual(engineEvents().map((event) => [event.kind, event.summary]).reverse(), [
      ['disk_cache_full', 'Disk cache full (3.00 of 3.00 GB, 0 reusable tokens): exllamav3 evicts its oldest pages, so long prompts lose their start. Raise the preset\'s disk cache budget.'],
      ['disk_cache_full', 'Disk cache out of space: page failed ([Errno 28] No space left on device); exllamav3 paused its writes.'],
    ]);
  });
});
