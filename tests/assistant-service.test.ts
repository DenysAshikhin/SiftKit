import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import type { EnvironmentStateDto } from '@siftkit/contracts';
import { AssistantService } from '../src/assistant/assistant-service.js';
import type {
  AssistantInferenceClient, AssistantInferenceResult,
} from '../src/assistant/inference/client.js';
import { FixedClock } from '../src/assistant/clock.js';
import { SequentialIdGenerator } from '../src/assistant/ids.js';
import { EstimateTokenCounter } from '../src/assistant/domain/tokens.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { closeRuntimeDatabase, getRuntimeDatabase } from '../src/state/runtime-db.js';
import { MemoryAssistantConfigWriter } from './helpers/assistant-fixture.js';
import { createManagedTempDir } from './helpers/temp-dirs.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';

class AlwaysIdle {
  isIdle(): boolean {
    return true;
  }
}

function buildService(
  responses: readonly string[],
  enabled = true,
  inference: AssistantInferenceClient = new FakeAssistantInference(responses),
): AssistantService {
  const runtimeRoot = createManagedTempDir('siftkit-assistant-service-');
  const config = { ...DEFAULT_ASSISTANT_CONFIG, Enabled: enabled };
  return AssistantService.create({
    database: getRuntimeDatabase(path.join(runtimeRoot, 'runtime.sqlite')),
    runtimeRoot,
    clock: new FixedClock('2026-08-05T09:00:00.000Z'),
    ids: new SequentialIdGenerator(),
    configWriter: new MemoryAssistantConfigWriter(config),
    inference,
    tokens: new EstimateTokenCounter(4),
    idleGate: new AlwaysIdle(),
    config,
  });
}

/** Blocks every model call until the test releases it, so a drain can be caught in flight. */
class GateInference implements AssistantInferenceClient {
  release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  async complete(): Promise<AssistantInferenceResult> {
    await this.gate;
    return { text: '{}', backendId: 'fake', modelId: 'fake-model' };
  }
}

test('maintenance waits for the drain already in flight before it mutates anything', async () => {
  try {
    const inference = new GateInference();
    const service = buildService([], true, inference);
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_maintenance',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });

    const order: string[] = [];
    const drain = service.drainJobs();
    void drain.then(() => order.push('drain'));
    // Let the drain claim its job and block on the model call.
    await new Promise((resolve) => setImmediate(resolve));
    const maintenance = service.runMaintenance(async () => { order.push('maintenance'); });
    // An unserialized implementation would run the work in this window, before the drain ends.
    await new Promise((resolve) => setImmediate(resolve));
    inference.release();
    await Promise.all([drain, maintenance]);
    assert.deepEqual(order, ['drain', 'maintenance']);
  } finally {
    closeRuntimeDatabase();
  }
});

test('concurrent maintenance operations run one at a time', async () => {
  try {
    const service = buildService([]);
    const order: string[] = [];
    const first = service.runMaintenance(async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first-end');
    });
    const second = service.runMaintenance(async () => { order.push('second'); });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  } finally {
    closeRuntimeDatabase();
  }
});

test('the service creates the owner person node exactly once', () => {
  try {
    const service = buildService([]);
    const first = service.ownerPersonNodeId;
    if (first === null) throw new Error('Enabled service did not create its owner node.');
    assert.ok(first.length > 0);
    assert.equal(service.ownerPersonNodeId, first);
    assert.equal(
      service.graph.nodes.listNodesByType(service.ownerId, 'person').length, 1,
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('a disabled service is inert until a validated config refresh enables it', async () => {
  try {
    const service = buildService([], false);
    assert.equal(service.enabled, false);
    assert.equal(service.ownerPersonNodeId, null);
    assert.equal(service.graph.nodes.listNodesByType(service.ownerId, 'person').length, 0);
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_disabled',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });
    assert.equal(service.graph.evidence.countEvidence(service.ownerId), 0);
    assert.equal((await service.retrieveMemoryContext('PowerShell')).renderedBlock, '');
    assert.deepEqual(service.status(), {
      available: true, enabled: false, ownerId: service.ownerId,
      pendingQuestionCount: 0, pendingValidationCount: 0,
    });

    service.refreshConfig({ ...DEFAULT_ASSISTANT_CONFIG, Enabled: true });
    assert.equal(service.enabled, true);
    assert.notEqual(service.ownerPersonNodeId, null);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a chat turn is ingested without any model call', () => {
  try {
    const service = buildService([]);
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_1',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });
    assert.equal(service.graph.jobs.countByStatus(service.ownerId, 'queued'), 2);
    assert.equal(service.graph.evidence.countEvidence(service.ownerId), 2);
  } finally {
    closeRuntimeDatabase();
  }
});

test('retrieval on an empty graph returns an empty block', async () => {
  try {
    const service = buildService([]);
    const result = await service.retrieveMemoryContext('what shell do I use?');
    assert.equal(result.renderedBlock, '');
  } finally {
    closeRuntimeDatabase();
  }
});

test('an ingestion failure never throws at the caller', () => {
  try {
    const service = buildService([]);
    assert.doesNotThrow(() => {
      service.ingestChatTurn({
        ownerId: service.ownerId, sessionId: 'chat_1',
        capturedAtUtc: 'not-a-date',
        userMessageId: 'm1', userText: 'I use PowerShell.',
        assistantMessageId: 'm2', assistantText: 'Noted.',
      });
    });
  } finally {
    closeRuntimeDatabase();
  }
});

test('the environment heartbeat closes a foreground session that simply stopped reporting', () => {
  try {
    const service = buildService([]);
    const foreground = {
      processName: 'Code.exe',
      executablePath: 'C:/Program Files/Microsoft VS Code/Code.exe',
      applicationId: 'app:code',
      normalizedTitle: 'SiftKit - Visual Studio Code',
      fullscreen: false,
    };
    service.ingestActivity({
      schemaVersion: 1,
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      foreground,
      idleSeconds: 2,
      sessionLocked: false,
    });

    const heartbeat = (capturedAtUtc: string): EnvironmentStateDto => ({
      schemaVersion: 1,
      capturedAtUtc,
      fullscreen: false,
      locked: false,
      doNotDisturb: false,
      presenting: false,
      excludedApplication: false,
      secondsSinceInput: 30,
      power: { kind: 'available', onBattery: false, batteryPercent: 90 },
    });

    const sessionEvidence = (): number => service.graph.evidence.list(service.ownerId, 50, 0)
      .filter((row) => row.source_type === 'desktop_activity').length;

    service.ingestEnvironment(heartbeat('2026-08-05T09:04:00.000Z'));
    assert.equal(sessionEvidence(), 0, 'still inside the session gap');

    service.ingestEnvironment(heartbeat('2026-08-05T09:06:00.000Z'));
    assert.equal(sessionEvidence(), 1, 'the stalled session closed and emitted its observation');
  } finally {
    closeRuntimeDatabase();
  }
});
