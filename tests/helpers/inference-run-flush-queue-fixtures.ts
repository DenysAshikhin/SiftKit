import { type TestContext } from 'node:test';

import { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import { countLogRows } from './runtime-database-probe.js';

/**
 * Makes the *reporting* path fail: `ServerLogger` writes to stdout synchronously, so a sink that
 * throws on the matching line is a report that failed after the database write had already
 * committed — the one failure the restore-and-retry path must never treat as a rejected transaction.
 * Everything else passes through, so the test reporter's own output is untouched.
 */
export function failReportingOn(t: TestContext, marker: string): void {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes(marker)) {
      throw new Error('injected reporting failure');
    }
    if (typeof encodingOrCallback === 'function') {
      return originalWrite(chunk, encodingOrCallback);
    }
    return originalWrite(chunk, encodingOrCallback, callback);
  };
  t.after(() => {
    process.stdout.write = originalWrite;
  });
}

/** Committed chunk rows for `runId`, read straight from the runtime database. */
export function committedRows(runId: string): number {
  return countLogRows(getRuntimeDatabase(), runId);
}

