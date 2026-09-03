import path from 'node:path';

import type { KeyCustody } from '@siftkit/contracts';
import {
  AssistantService, type AssistantConfigWriter,
} from '../../src/assistant/assistant-service.js';
import type { AssistantInferenceClient } from '../../src/assistant/inference/client.js';
import { EstimateTokenCounter } from '../../src/assistant/domain/tokens.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.js';
import { FakeAssistantInference } from './assistant-inference-fake.js';
import { ALWAYS_IDLE, ALWAYS_RESIDENT } from './assistant-gates.js';
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

/** Durable-enough config store for unit tests: the service only needs its own flip to stick. */
export class MemoryAssistantConfigWriter implements AssistantConfigWriter {
  constructor(public persisted: AssistantConfig) {}

  writeKeyCustody(custody: KeyCustody): AssistantConfig {
    this.persisted = { ...this.persisted, KeyCustody: custody };
    return this.persisted;
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

export interface BuildAssistantServiceOptions {
  readonly enabled?: boolean;
  readonly inference?: AssistantInferenceClient;
  readonly privateMode?: boolean;
  readonly ownerDisplayName?: string;
}

/** A service on a fresh temp database at the fixture instant. Callers close the database. */
export function buildAssistantService(
  options: BuildAssistantServiceOptions = {},
): AssistantService {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-service-');
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    Enabled: options.enabled ?? true,
    Owner: {
      ...DEFAULT_ASSISTANT_CONFIG.Owner,
      DisplayName: options.ownerDisplayName ?? DEFAULT_ASSISTANT_CONFIG.Owner.DisplayName,
    },
    PrivateMode: { ...DEFAULT_ASSISTANT_CONFIG.PrivateMode, Active: options.privateMode ?? false },
  };
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock: new FixedClock(FIXTURE_START_INSTANT),
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference: options.inference ?? new FakeAssistantInference([]),
    tokens: new EstimateTokenCounter(4),
    idleGate: ALWAYS_IDLE,
    residencyGate: ALWAYS_RESIDENT,
    config,
  });
}

export interface ProposePersonUsesInput {
  readonly subjectName: string;
  readonly objectName: string;
  readonly sourceEventId: string;
  readonly sourceType: 'screenshot' | 'conversation_message';
  readonly basis: 'passive_observation' | 'explicit_user_statement';
  readonly confidence: number;
}

/** Evidence → observation → `USES` candidate for one person subject. Returns the candidate id. */
export function proposePersonUses(
  context: Pick<AssistantTestContext, 'graph' | 'ownerId'>, input: ProposePersonUsesInput,
): string {
  const { graph, ownerId } = context;
  const evidence = graph.evidence.recordTextEvidence({
    ownerId, deviceId: null, sourceType: input.sourceType, parentEvidenceId: null,
    sourceEventId: input.sourceEventId,
    sourceRef: input.sourceType === 'screenshot' ? 'app:code' : 'chat_1',
    sourceTimezone: null, capturedAtUtc: FIXTURE_START_INSTANT, sensitivity: 'personal',
    retentionUntilUtc: null, metadata: {}, text: `${input.subjectName} uses ${input.objectName}.`,
  });
  const observation = graph.observations.record({
    ownerId, evidenceId: evidence.id, observationType: 'screenshot_extraction',
    payload: {}, confidence: input.confidence, sensitivity: 'personal',
    extractorName: 'image_extraction', extractorVersion: '1',
  });
  const candidate = graph.candidates.propose({
    ownerId, observationId: observation.id,
    subject: { nodeType: 'person', displayName: input.subjectName },
    predicate: 'USES',
    object: { kind: 'unresolved', nodeType: 'software', displayName: input.objectName },
    scope: null, basis: input.basis, confidence: input.confidence, sensitivity: 'personal',
    validFromUtc: null, validToUtc: null,
    rationale: `${input.subjectName} uses ${input.objectName}.`,
  });
  if (candidate === null) throw new Error('Candidate proposal was deduplicated unexpectedly.');
  return candidate.id;
}
