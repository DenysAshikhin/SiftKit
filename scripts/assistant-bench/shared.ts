import path from 'node:path';

import type { ActivityEventDto } from '@siftkit/contracts';
import { AssistantGraph } from '../../src/assistant/assistant-graph.js';
import { SystemClock } from '../../src/assistant/clock.js';
import { FileKeyProvider } from '../../src/assistant/crypto/key-provider.js';
import { RandomIdGenerator } from '../../src/assistant/ids.js';
import { assistantKeyFile } from '../../src/assistant/layout.js';
import { ActivityLog } from '../../src/assistant/observation/activity-log.js';
import { LOCAL_OWNER_ID } from '../../src/assistant/storage/schema.js';
import { getRuntimeDatabase, type RuntimeDatabase } from '../../src/state/runtime-db.js';

export const DEFAULT_BENCH_ROOT = '.bench-assistant';
export const OWNER_ID = LOCAL_OWNER_ID;

export interface BenchContext {
  readonly root: string;
  readonly database: RuntimeDatabase;
  readonly clock: SystemClock;
  readonly graph: AssistantGraph;
  readonly activity: ActivityLog;
}

/** The same composition `withAssistantContext` uses, on a real clock and a persistent root. */
export function openBench(root: string): BenchContext {
  const absoluteRoot = path.resolve(root);
  const database = getRuntimeDatabase(path.join(absoluteRoot, 'runtime.sqlite'));
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const graph = new AssistantGraph({
    database, clock, ids,
    keys: new FileKeyProvider(assistantKeyFile(absoluteRoot)),
    runtimeRoot: absoluteRoot,
  });
  return {
    root: absoluteRoot,
    database,
    clock,
    graph,
    activity: new ActivityLog({
      database, clock, ids, evidence: graph.evidence, observations: graph.observations,
    }),
  };
}

export function activityEvent(index: number, capturedAtUtc: string): ActivityEventDto {
  return {
    schemaVersion: 1,
    capturedAtUtc,
    foreground: {
      processName: `App${index % 20}.exe`,
      executablePath: `C:/Apps/App${index % 20}.exe`,
      applicationId: `app:app-${index % 20}`,
      normalizedTitle: `Window ${index % 200}`,
      fullscreen: false,
    },
    idleSeconds: index % 30,
    sessionLocked: false,
  };
}

export function readNumberArg(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} requires a positive number.`);
  }
  return Math.trunc(value);
}

export function readStringArg(argv: readonly string[], flag: string, fallback: string): string {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function formatSeconds(startedAtMs: number): string {
  return `${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`;
}
