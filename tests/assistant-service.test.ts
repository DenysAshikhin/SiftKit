import test from 'node:test';
import assert from 'node:assert/strict';

import type { EnvironmentStateDto } from '@siftkit/contracts';
import type {
  AssistantInferenceClient, AssistantInferenceResult,
} from '../src/assistant/inference/client.js';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.js';
import { closeRuntimeDatabase } from '../src/state/runtime-db.js';
import { buildAssistantService } from './helpers/assistant-fixture.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';

/** Blocks every model call until the test releases it, so a drain can be caught in flight. */
class GateInference implements AssistantInferenceClient {
  calls = 0;
  release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
  private resolveCallStarted: () => void = () => undefined;
  /** Resolves as the first statement of `complete()`, so a test knows the drain is inside the model call. */
  readonly callStarted = new Promise<void>((resolve) => { this.resolveCallStarted = resolve; });

  async complete(): Promise<AssistantInferenceResult> {
    this.calls += 1;
    this.resolveCallStarted();
    await this.gate;
    return { text: '{}', backendId: 'fake', modelId: 'fake-model' };
  }
}

test('maintenance waits for the drain already in flight before it mutates anything', async () => {
  try {
    const inference = new GateInference();
    const service = buildAssistantService({ inference });
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
    const service = buildAssistantService();
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
    const service = buildAssistantService();
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
    const service = buildAssistantService({ enabled: false });
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
    service.graph.jobs.enqueue({
      ownerId: service.ownerId,
      jobType: 'capture_retention',
      payload: { reason: 'schedule' },
      idempotencyKey: 'capture_retention:disabled',
    }, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities.CaptureRetention);
    await service.drainJobs();
    const queued = service.graph.jobs.listByStatus(service.ownerId, 'queued');
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.attempts, 0, 'disabled assistants must not claim deterministic work');
    assert.equal(service.listBackgroundWorkDecisions()[0]?.reason, 'assistant_disabled');

    service.refreshConfig({ ...DEFAULT_ASSISTANT_CONFIG, Enabled: true });
    assert.equal(service.enabled, true);
    assert.notEqual(service.ownerPersonNodeId, null);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a chat turn is ingested without any model call', () => {
  try {
    const service = buildAssistantService();
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

test('an unavailable image runtime is not logged when no capture is waiting', async () => {
  try {
    const service = buildAssistantService();

    await service.drainJobs();

    assert.deepEqual(service.listBackgroundWorkDecisions(), []);
  } finally {
    closeRuntimeDatabase();
  }
});

test('retrieval on an empty graph returns an empty block', async () => {
  try {
    const service = buildAssistantService();
    const result = await service.retrieveMemoryContext('what shell do I use?');
    assert.equal(result.renderedBlock, '');
  } finally {
    closeRuntimeDatabase();
  }
});

test('an ingestion failure never throws at the caller', () => {
  try {
    const service = buildAssistantService();
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
    const service = buildAssistantService();
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
      mouseIdleSeconds: 2, keyboardIdleSeconds: 2,
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
      secondsSinceMouseInput: 30, secondsSinceKeyboardInput: 30,
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

test('a residency change preempts the drain and waits for it to finish', async () => {
  try {
    const inference = new GateInference();
    const service = buildAssistantService({ inference });
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_residency',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });

    const order: string[] = [];
    const drain = service.drainJobs();
    void drain.then(() => order.push('drain'));
    await inference.callStarted;

    const residency = service.onModelResidencyChanging().then(() => order.push('residency'));
    inference.release();
    await drain;
    await residency;

    assert.deepEqual(order, ['drain', 'residency']);
  } finally {
    closeRuntimeDatabase();
  }
});

test('a residency change blocks a second drain while the first drain is unwinding', async () => {
  try {
    const inference = new GateInference();
    const service = buildAssistantService({ inference });
    for (const index of [1, 2]) {
      service.ingestChatTurn({
        ownerId: service.ownerId, sessionId: `chat_residency_${index}`,
        capturedAtUtc: '2026-08-05T09:00:00.000Z',
        userMessageId: `u${index}`, userText: `I use tool ${index}.`,
        assistantMessageId: `a${index}`, assistantText: 'Noted.',
      });
    }

    const firstDrain = service.drainJobs();
    await inference.callStarted;
    const residency = service.onModelResidencyChanging();
    const secondDrain = service.drainJobs();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(inference.calls, 1, 'no new model call may start during a residency change');
    assert.equal(service.listBackgroundWorkDecisions()[0]?.reason, 'drain_blocked');

    inference.release();
    await Promise.all([firstDrain, secondDrain, residency]);
  } finally {
    closeRuntimeDatabase();
  }
});

test('concurrent drain ticks do not start overlapping model calls', async () => {
  try {
    const inference = new GateInference();
    const service = buildAssistantService({ inference });
    for (const index of [1, 2]) {
      service.ingestChatTurn({
        ownerId: service.ownerId, sessionId: `chat_tick_${index}`,
        capturedAtUtc: '2026-08-05T09:00:00.000Z',
        userMessageId: `u${index}`, userText: `I use tool ${index}.`,
        assistantMessageId: `a${index}`, assistantText: 'Noted.',
      });
    }

    const firstDrain = service.drainJobs();
    await inference.callStarted;
    const secondDrain = service.drainJobs();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(inference.calls, 1, 'periodic ticks must not overlap active drains');
    assert.equal(service.listBackgroundWorkDecisions()[0]?.reason, 'drain_already_running');

    inference.release();
    await Promise.all([firstDrain, secondDrain]);
  } finally {
    closeRuntimeDatabase();
  }
});

test('private mode does not block queued background work', async () => {
  try {
    const inference = new FakeAssistantInference(['{"statements":[]}']);
    const service = buildAssistantService({ inference, privateMode: true });
    service.ingestChatTurn({
      ownerId: service.ownerId, sessionId: 'chat_private',
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      userMessageId: 'm1', userText: 'I use PowerShell.',
      assistantMessageId: 'm2', assistantText: 'Noted.',
    });

    await service.drainJobs();

    assert.ok(inference.requests.length > 0);
  } finally {
    closeRuntimeDatabase();
  }
});

test("the owner's configured display name becomes an alias of the owner node", () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const ownerNodeId = service.ownerPersonNodeId;
    if (ownerNodeId === null) throw new Error('Enabled service did not create its owner node.');

    const aliases = service.graph.nodes.listAliases(ownerNodeId).map((row) => row.normalized_alias);
    assert.ok(aliases.includes('denys'), `owner aliases were ${aliases.join(', ')}`);
    assert.ok(aliases.includes('the user'));
    assert.ok(aliases.includes('myself'));
  } finally {
    closeRuntimeDatabase();
  }
});

test('an owner node created before the display name was set picks the alias up on refresh', () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: '' });
    const ownerNodeId = service.ownerPersonNodeId;
    if (ownerNodeId === null) throw new Error('Enabled service did not create its owner node.');
    assert.ok(
      !service.graph.nodes.listAliases(ownerNodeId)
        .some((row) => row.normalized_alias === 'denys'),
    );

    service.refreshConfig({
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, DisplayName: 'Denys' },
    });

    assert.equal(service.ownerPersonNodeId, ownerNodeId);
    assert.ok(
      service.graph.nodes.listAliases(ownerNodeId)
        .some((row) => row.normalized_alias === 'denys'),
    );
  } finally {
    closeRuntimeDatabase();
  }
});

test('renaming the owner retires the previous configured alias but keeps learned ones', () => {
  try {
    const service = buildAssistantService({ ownerDisplayName: 'Denys' });
    const ownerNodeId = service.ownerPersonNodeId;
    if (ownerNodeId === null) throw new Error('Enabled service did not create its owner node.');
    service.graph.nodes.addAlias({
      ownerId: service.ownerId, nodeId: ownerNodeId, alias: 'derys',
      aliasType: 'name', sourceEvidenceId: null,
    });

    service.refreshConfig({
      ...DEFAULT_ASSISTANT_CONFIG,
      Enabled: true,
      Owner: { ...DEFAULT_ASSISTANT_CONFIG.Owner, DisplayName: 'Dennis' },
    });

    const aliases = service.graph.nodes.listAliases(ownerNodeId).map((row) => row.normalized_alias);
    assert.ok(aliases.includes('dennis'));
    assert.ok(!aliases.includes('denys'), `stale configured alias survived: ${aliases.join(', ')}`);
    assert.ok(aliases.includes('derys'), 'a name learned from data is not a config alias');
    assert.ok(aliases.includes('the user'));
    assert.equal(service.graph.identity.getOwner().display_name, 'Dennis');
  } finally {
    closeRuntimeDatabase();
  }
});
