import path from 'node:path';

import { FixedClock } from '../../src/assistant/clock.js';
import { SequentialIdGenerator } from '../../src/assistant/ids.js';
import { LOCAL_OWNER_ID } from '../../src/assistant/storage/schema.js';
import {
  closeRuntimeDatabase, getRuntimeDatabase, type RuntimeDatabase,
} from '../../src/state/runtime-db.js';
import { createManagedTempDir } from './temp-dirs.js';

export interface AssistantTestContext {
  readonly database: RuntimeDatabase;
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly ownerId: string;
  readonly runtimeRoot: string;
}

export const FIXTURE_START_INSTANT = '2026-08-05T09:00:00.000Z';

/**
 * Creates an isolated runtime database with the assistant schema migrated, runs `body`, then
 * closes the database. The temp directory is swept by the shared registry on process exit.
 */
export function withAssistantContext<T>(body: (context: AssistantTestContext) => T): T {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  try {
    return body({
      database,
      clock: new FixedClock(FIXTURE_START_INSTANT),
      ids: new SequentialIdGenerator(),
      ownerId: LOCAL_OWNER_ID,
      runtimeRoot,
    });
  } finally {
    closeRuntimeDatabase();
  }
}