import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from '../src/lib/zod.js';
import {
  OPERATION_STREAM_EVENTS,
  StatusServerOperationError,
  classifyOperationStreamFrame,
} from '../src/lib/operation-stream.js';

const ResultSchema = z.object({ requestId: z.string(), value: z.number() });

const ERROR_PAYLOAD = {
  error: 'stream failed',
  errorName: 'TypeError',
  diagnosticId: 'diag-1',
  diagnostic: { name: 'TypeError', message: 'stream failed' },
};

test('classifies a result frame into the parsed result', () => {
  const classified = classifyOperationStreamFrame({
    event: OPERATION_STREAM_EVENTS.result,
    data: JSON.stringify({ requestId: 'run-1', value: 7 }),
  }, ResultSchema);

  assert.equal(classified.kind, 'result');
  if (classified.kind !== 'result') return;
  assert.deepEqual(classified.result, { requestId: 'run-1', value: 7 });
});

test('classifies a progress frame into its payload object', () => {
  const classified = classifyOperationStreamFrame({
    event: OPERATION_STREAM_EVENTS.progress,
    data: JSON.stringify({ kind: 'lock_wait', elapsedMs: 12 }),
  }, ResultSchema);

  assert.equal(classified.kind, 'progress');
  if (classified.kind !== 'progress') return;
  assert.equal(classified.event.kind, 'lock_wait');
  assert.equal(classified.event.elapsedMs, 12);
});

test('throws a typed error for an error frame', () => {
  assert.throws(
    () => classifyOperationStreamFrame({
      event: OPERATION_STREAM_EVENTS.error,
      data: JSON.stringify(ERROR_PAYLOAD),
    }, ResultSchema),
    (error: unknown) => {
      assert.ok(error instanceof StatusServerOperationError);
      assert.equal(error.message, 'stream failed');
      assert.equal(error.name, 'TypeError');
      assert.equal(error.diagnosticId, 'diag-1');
      return true;
    },
  );
});

test('ignores frames that are not part of the operation protocol', () => {
  const classified = classifyOperationStreamFrame({ event: 'message', data: '{}' }, ResultSchema);
  assert.equal(classified.kind, 'ignored');
});

test('rejects a result frame whose payload does not match the schema', () => {
  assert.throws(() => classifyOperationStreamFrame({
    event: OPERATION_STREAM_EVENTS.result,
    data: JSON.stringify({ requestId: 'run-1' }),
  }, ResultSchema));
});
