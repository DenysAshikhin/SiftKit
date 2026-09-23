import assert from 'node:assert/strict';
import path from 'node:path';

import { AssistantService } from '../../src/assistant/assistant-service.js';
import { FixedClock } from '../../src/assistant/clock.js';
import { EstimateTokenCounter } from '../../src/assistant/domain/tokens.js';
import { SequentialIdGenerator } from '../../src/assistant/ids.js';
import { LIVE_ASSERTION_STATUSES } from '../../src/assistant/storage/assertion-store.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../../src/config/defaults.js';
import { getRuntimeDatabase } from '../../src/state/runtime-db.js';
import {
  FIXTURE_START_INSTANT,
  MemoryAssistantConfigWriter,
  type AssistantTestContext,
} from './assistant-fixture.js';
import { FakeAssistantInference } from './assistant-inference-fake.js';
import { createManagedTempDir } from './temp-dirs.js';
import { ALWAYS_IDLE, ALWAYS_RESIDENT } from './assistant-gates.js';
import { InMemoryDataProtector } from './in-memory-data-protector.js';
import type { AssistantImageCapability, AssistantImageCapabilityProvider } from '../../src/assistant/images/image-capability.js';

class StubImageCapability implements AssistantImageCapabilityProvider {
  read(): AssistantImageCapability {
    return { instanceId: 'exl3:1', visionCapable: true, healthy: true };
  }
}

/** A live service over its own runtime root, plus a context view of the same graph. */
export function buildService(
  prefix: string,
  responses: readonly string[],
): { service: AssistantService; context: AssistantTestContext } {
  const runtimeRoot = createManagedTempDir(prefix);
  const database = getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite'));
  const clock = new FixedClock(FIXTURE_START_INSTANT);
  const ids = new SequentialIdGenerator();
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    Enabled: true,
    Observation: { ...DEFAULT_ASSISTANT_CONFIG.Observation, ScreenshotsEnabled: true },
  };
  const service = AssistantService.create({
    database, runtimeRoot, clock, ids,
    configWriter: new MemoryAssistantConfigWriter(config),
    inference: new FakeAssistantInference(responses),
    tokens: new EstimateTokenCounter(4),
    idleGate: ALWAYS_IDLE,
    residencyGate: ALWAYS_RESIDENT,
    imageCapability: new StubImageCapability(),
    config,
    dataProtector: new InMemoryDataProtector(),
  });
  return {
    service,
    context: { database, clock, ids, ownerId: service.ownerId, runtimeRoot, graph: service.graph },
  };
}

export const PROJECTION_SIGNAL = new AbortController().signal;

/**
 * §7: no projection may cite an assertion that is gone or retired. Every scenario ends here,
 * because a stale citation is the one failure that looks like success from the outside.
 */
export function assertProjectionIntegrity(context: AssistantTestContext): void {
  const live = new Set(
    context.graph.projections.listAllRows(context.ownerId).flatMap(
      (row) => context.graph.projections.readIncludedAssertionIds(row),
    ),
  );
  for (const assertionId of live) {
    const assertion = context.graph.assertions.getAssertion(assertionId);
    assert.ok(assertion !== null, `projection cites missing assertion ${assertionId}`);
    assert.ok(
      LIVE_ASSERTION_STATUSES.includes(assertion.status),
      `projection cites retired assertion ${assertionId} (${assertion.status})`,
    );
  }
}

