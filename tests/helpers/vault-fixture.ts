import path from 'node:path';

import { FixedClock } from '../../src/assistant/clock.ts';
import { SequentialIdGenerator } from '../../src/assistant/ids.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase, type RuntimeDatabase } from '../../src/state/runtime-db.ts';
import type { VaultNoteInput, VaultWriteMeta, VaultWriteSource } from '@siftkit/contracts';

import { VaultNoteStore } from '../../src/vault/note-store.ts';
import { createManagedTempDir } from './temp-dirs.ts';

export interface VaultTestContext {
  readonly database: RuntimeDatabase;
  readonly clock: FixedClock;
  readonly store: VaultNoteStore;
  readonly runtimeRoot: string;
}

export const VAULT_FIXTURE_START = '2026-10-24T09:00:00.000Z';
export const TEST_META: VaultWriteMeta = { actor: 'you', summary: 'test write', sourceRef: null };
export const TEST_SOURCE: VaultWriteSource = { actor: 'you', sourceRef: null };

export function entityInput(title: string, body: string, overrides: Partial<VaultNoteInput> = {}): VaultNoteInput {
  return { title, folder: 'Software', kind: 'entity', types: ['software'], aliases: [], tags: [], body, ...overrides };
}

/** Isolated runtime database with the vault schema and a store over it. */
export function withVault<T>(body: (context: VaultTestContext) => T): T {
  const runtimeRoot = createManagedTempDir('siftkit-vault-');
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  try {
    const clock = new FixedClock(VAULT_FIXTURE_START);
    const store = new VaultNoteStore(database, clock, new SequentialIdGenerator());
    return body({ database, clock, store, runtimeRoot });
  } finally {
    closeAllRuntimeDatabases();
  }
}
