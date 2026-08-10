import path from 'node:path';

import type { AssistantConfigWriter } from '../../src/assistant/assistant-service.js';
import type { AssistantConfig } from '../../src/config/types.js';
import { AssistantGraph } from '../../src/assistant/assistant-graph.js';
import { FixedClock } from '../../src/assistant/clock.js';
import { FileKeyProvider } from '../../src/assistant/crypto/key-provider.js';
import { SequentialIdGenerator } from '../../src/assistant/ids.js';
import { assistantKeyFile } from '../../src/assistant/layout.js';
import type { AssertionStore } from '../../src/assistant/storage/assertion-store.js';
import { LOCAL_OWNER_ID } from '../../src/assistant/storage/schema.js';
import {
  closeRuntimeDatabase, getRuntimeDatabase, type RuntimeDatabase,
} from '../../src/state/runtime-db.js';
import { createManagedTempDir } from './temp-dirs.js';

/** Durable-enough config sink for unit tests: the service only needs its own write to stick. */
export class MemoryAssistantConfigWriter implements AssistantConfigWriter {
  written: AssistantConfig | null = null;

  write(config: AssistantConfig): void {
    this.written = config;
  }
}

export interface AssistantTestContext {
  readonly database: RuntimeDatabase;
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly ownerId: string;
  readonly runtimeRoot: string;
  readonly graph: AssistantGraph;
}

export const FIXTURE_START_INSTANT = '2026-08-05T09:00:00.000Z';

/**
 * Creates an isolated runtime database with the assistant schema migrated, wires an
 * AssistantGraph over it, runs `body`, then closes the database.
 */
export function withAssistantContext<T>(body: (context: AssistantTestContext) => T): T {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  try {
    const clock = new FixedClock(FIXTURE_START_INSTANT);
    const ids = new SequentialIdGenerator();
    const graph = new AssistantGraph({
      database, clock, ids,
      keys: new FileKeyProvider(assistantKeyFile(runtimeRoot)),
      runtimeRoot,
    });
    return body({ database, clock, ids, ownerId: LOCAL_OWNER_ID, runtimeRoot, graph });
  } finally {
    closeRuntimeDatabase();
  }
}

export async function withAssistantContextAsync<T>(
  body: (context: AssistantTestContext) => Promise<T>,
): Promise<T> {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  try {
    const clock = new FixedClock(FIXTURE_START_INSTANT);
    const ids = new SequentialIdGenerator();
    const graph = new AssistantGraph({
      database, clock, ids,
      keys: new FileKeyProvider(assistantKeyFile(runtimeRoot)),
      runtimeRoot,
    });
    return await body({ database, clock, ids, ownerId: LOCAL_OWNER_ID, runtimeRoot, graph });
  } finally {
    closeRuntimeDatabase();
  }
}

/** The live support weights of an assertion, the shape confidence resolution consumes. */
export function supportWeights(assertions: AssertionStore, assertionId: string): number[] {
  return assertions.listSupportingEvidence(assertionId).map((row) => row.weight);
}
