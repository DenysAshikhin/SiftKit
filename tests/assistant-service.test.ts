import test from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';

import type { EnvironmentStateDto } from '@siftkit/contracts';
import type {
  AssistantInferenceClient, AssistantInferenceResult,
} from '../src/assistant/inference/client.ts';
import type { AssistantService } from '../src/assistant/assistant-service.ts';
import { FakeAssistantInference } from './helpers/assistant-inference-fake.ts';
import { closeAllRuntimeDatabases, getRuntimeDatabase } from '../src/state/runtime-db.ts';
import { buildAssistantService } from './helpers/assistant-fixture.ts';
import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.ts';
import type { AssistantConfig } from '../src/config/types.ts';
import type { VaultChatTurn } from '../src/vault/note-writer/chat-writer.ts';
import { requireCapture, setCaptureState } from '../src/vault/captures.ts';
import { findOwnerNote } from '../src/vault/owner-identity.ts';
import { StubImageCapability, vaultCaptureDto } from './helpers/vault-capture-fixture.ts';

process.env.TZ = 'UTC';

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
    return { text: NO_OPERATIONS, backendId: 'fake', modelId: 'fake-model' };
  }
}

const NO_OPERATIONS = JSON.stringify({ operations: [] });
const ENABLED: AssistantConfig = { ...DEFAULT_ASSISTANT_CONFIG, Enabled: true };
const named = (DisplayName: string): AssistantConfig => ({ ...ENABLED, Owner: { ...ENABLED.Owner, DisplayName } });

const turn = (index: number, overrides: Partial<VaultChatTurn> = {}): VaultChatTurn => ({
  sessionId: `chat_${index}`, sessionTitle: 'Shell', userMessageId: `u${index}`, capturedAtUtc: '2026-08-05T09:00:00.000Z',
  userText: `I use tool ${index}.`, assistantText: 'Noted.', ...overrides,
});
const queuedTypes = (service: AssistantService) => service.graph.jobs.listByStatus(service.ownerId, 'queued').map((job) => job.job_type);
/** The service's own connection: the runtime database cache hands back the same handle. */
const serviceDatabase = (service: AssistantService) => getRuntimeDatabase(path.join(service.graph.runtimeRoot, 'runtime.sqlite'));
const ownerNote = (service: AssistantService) => findOwnerNote(serviceDatabase(service));

/** Runs `body` against a service and closes its database afterwards. */
async function withService(options: Parameters<typeof buildAssistantService>[0], body: (service: AssistantService) => Promise<void> | void) {
  try {
    await body(buildAssistantService(options));
  } finally {
    closeAllRuntimeDatabases();
  }
}

test('maintenance waits for the drain already in flight before it mutates anything', async () => {
  const inference = new GateInference();
  await withService({ inference }, async (service) => {
    service.ingestChatTurn(turn(1));
    const order: string[] = [];
    const drain = service.drainJobs();
    void drain.then(() => order.push('drain'));
    await inference.callStarted;
    const maintenance = service.runMaintenance(async () => { order.push('maintenance'); });
    // An unserialized implementation would run the work in this window, before the drain ends.
    await new Promise((resolve) => setImmediate(resolve));
    inference.release();
    await Promise.all([drain, maintenance]);
    assert.deepEqual(order, ['drain', 'maintenance']);
  });
});

test('concurrent maintenance operations run one at a time', async () => {
  await withService({}, async (service) => {
    const order: string[] = [];
    const first = service.runMaintenance(async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first-end');
    });
    const second = service.runMaintenance(async () => { order.push('second'); });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  });
});

test('an enabled service keeps exactly one #me owner note titled with the display name', async () => {
  await withService({ ownerDisplayName: 'Denys' }, (service) => {
    assert.equal(ownerNote(service)?.title, 'Denys');
    service.refreshConfig(named('Denys'));
    assert.deepEqual(service.vaultQueries.allNotes().filter((note) => note.tags.includes('me')).map((note) => note.title), ['Denys']);
  });
});

test('renaming the owner renames the owner note and keeps the old title as an alias', async () => {
  await withService({ ownerDisplayName: 'Denys' }, (service) => {
    const before = ownerNote(service);
    service.refreshConfig(named('Dennis'));
    const after = ownerNote(service);
    assert.deepEqual([after?.id, after?.title, after?.aliases], [before?.id, 'Dennis', ['Denys']]);
  });
});

test('a deleted owner note is recreated by the note-writer under the current name, not the startup one', async () => {
  const userUsesGit = JSON.stringify({ operations: [{ op: 'add_facts', note: 'the user', label: 'Uses', values: ['Git'] }] });
  await withService({ ownerDisplayName: 'Denys', inference: new FakeAssistantInference([userUsesGit]) }, async (service) => {
    service.refreshConfig(named('Dennis'));
    const owner = ownerNote(service);
    service.vaultNotes.delete(owner?.id ?? '', owner?.revision ?? 0);
    service.ingestChatTurn(turn(1));
    await service.drainJobs();
    assert.equal(ownerNote(service)?.title, 'Dennis');
  });
});

test('an owner note made before the name was set takes the name on refresh', async () => {
  await withService({ ownerDisplayName: '' }, (service) => {
    assert.equal(ownerNote(service)?.title, 'Owner');
    service.refreshConfig(named('Denys'));
    assert.equal(ownerNote(service)?.title, 'Denys');
  });
});

test('a disabled service is inert until a validated config refresh enables it', async () => {
  await withService({ enabled: false }, async (service) => {
    assert.equal(ownerNote(service), null);
    service.ingestChatTurn(turn(1));
    assert.deepEqual(queuedTypes(service), []);
    assert.equal((await service.retrieveMemoryContext('tool')).renderedBlock, '');
    assert.deepEqual(service.status(), { available: true, enabled: false, ownerId: service.ownerId });
    service.graph.jobs.enqueue(service.ownerId, { jobType: 'capture_retention', payload: {} }, DEFAULT_ASSISTANT_CONFIG.Background.JobPriorities);
    await service.drainJobs();
    assert.equal(service.graph.jobs.listByStatus(service.ownerId, 'queued')[0]?.attempts, 0, 'disabled assistants must not claim deterministic work');
    assert.equal(service.listBackgroundWorkDecisions()[0]?.reason, 'assistant_disabled');

    service.refreshConfig(ENABLED);
    assert.equal(service.enabled, true);
    assert.notEqual(ownerNote(service), null);
  });
});

test('a chat turn enqueues one chat note job without any model call', async () => {
  const inference = new FakeAssistantInference([]);
  await withService({ inference }, (service) => {
    service.ingestChatTurn(turn(1));
    service.ingestChatTurn(turn(1));
    const jobs = service.graph.jobs.listByStatus(service.ownerId, 'queued');
    assert.deepEqual(jobs.map((job) => [job.job_type, JSON.parse(job.payload_json).sessionTitle]), [['chat_note', 'Shell']]);
    assert.equal(inference.requests.length, 0);
  });
});

test('an invalid chat turn never throws at the caller and is audited', async () => {
  await withService({}, (service) => {
    assert.doesNotThrow(() => service.ingestChatTurn(turn(1, { capturedAtUtc: 'not-a-date' })));
    assert.deepEqual(queuedTypes(service), []);
    assert.equal(service.graph.audit.listAuditEvents(service.ownerId, 5)[0]?.event_type, 'ingestion_failed');
  });
});

test('retrieval reads the vault: the owner note alone at first, the matching note once it exists', async () => {
  await withService({}, async (service) => {
    assert.doesNotMatch((await service.retrieveMemoryContext('Tell me about PowerShell')).renderedBlock, /PowerShell/);
    service.vaultNotes.create({
      title: 'PowerShell', folder: 'Software', kind: 'entity', types: ['software'], aliases: [], tags: [], body: 'PowerShell is your shell.',
    }, { actor: 'you', summary: 'test', sourceRef: null });
    assert.match((await service.retrieveMemoryContext('Tell me about PowerShell')).renderedBlock, /PowerShell is your shell\./);
  });
});

test('a drained chat turn becomes its chat note and the daily note', async () => {
  const inference = new FakeAssistantInference([NO_OPERATIONS]);
  await withService({ inference }, async (service) => {
    service.ingestChatTurn(turn(1));
    await service.drainJobs();
    assert.equal(service.vaultNotes.resolve('Chat 2026-08-05 · Shell')?.kind, 'chat');
    assert.equal(service.vaultNotes.resolve('2026-08-05')?.kind, 'daily');
  });
});

test('an unavailable image runtime is not logged when no capture is waiting', async () => {
  await withService({}, async (service) => {
    await service.drainJobs();
    assert.deepEqual(service.listBackgroundWorkDecisions(), []);
  });
});

test('a capture accepted while the runtime is capable queues its capture note job', async () => {
  await withService({ imageCapability: new StubImageCapability(true), screenshotsEnabled: true }, (service) => {
    const outcome = service.ingestCapture(vaultCaptureDto({ capturedAtUtc: '2026-08-05T08:59:30.000Z' }));
    assert.equal(outcome.kind, 'accepted');
    assert.deepEqual(queuedTypes(service), ['capture_note']);
  });
});

test('a capture that pushes stored bytes over the cap queues a capacity retention run', async () => {
  await withService({ imageCapability: new StubImageCapability(true), screenshotsEnabled: true }, (service) => {
    service.ingestCapture(vaultCaptureDto({ capturedAtUtc: '2026-08-05T08:59:30.000Z' }));
    assert.deepEqual(queuedTypes(service), ['capture_note'], 'under the cap nothing is evicted');
    service.refreshConfig({ ...service.config, Observation: { ...service.config.Observation, RawStorageLimitGb: 1e-12 } });
    service.ingestCapture(vaultCaptureDto({ capturedAtUtc: '2026-08-05T08:59:40.000Z', pixelSha256: 'b'.repeat(64), foregroundContextKey: 'app:other' }));
    assert.deepEqual(queuedTypes(service).sort(), ['capture_note', 'capture_note', 'capture_retention']);
  });
});

test('waiting and stranded captures are processed once the runtime is capable', async () => {
  const capability = new StubImageCapability(false);
  const inference = new FakeAssistantInference([NO_OPERATIONS, NO_OPERATIONS]);
  await withService({ imageCapability: capability, inference, screenshotsEnabled: true }, async (service) => {
    const waiting = service.ingestCapture(vaultCaptureDto({ capturedAtUtc: '2026-08-05T08:59:30.000Z' }));
    const stranded = service.ingestCapture(vaultCaptureDto({
      capturedAtUtc: '2026-08-05T08:59:40.000Z', pixelSha256: 'b'.repeat(64), perceptualHash: '0000000000000000', foregroundContextKey: 'app:other',
    }));
    if (waiting.kind !== 'accepted' || stranded.kind !== 'accepted') throw new Error('fixture captures were not accepted');
    await service.drainJobs();
    assert.equal(service.listBackgroundWorkDecisions()[0]?.reason, 'image_capability_unavailable');

    setCaptureState(serviceDatabase(service), stranded.attachmentId, 'processing');
    capability.setCapable(true);
    await service.drainJobs();
    const states = [waiting, stranded].map((capture) => requireCapture(serviceDatabase(service), capture.attachmentId).state);
    assert.deepEqual(states, ['processed', 'processed']);
  });
});

test('the environment heartbeat closes a foreground session that simply stopped reporting', async () => {
  await withService({}, (service) => {
    service.ingestActivity({
      schemaVersion: 1,
      capturedAtUtc: '2026-08-05T09:00:00.000Z',
      foreground: {
        processName: 'Code.exe', executablePath: 'C:/Program Files/Microsoft VS Code/Code.exe',
        applicationId: 'app:code', normalizedTitle: 'SiftKit - Visual Studio Code', fullscreen: false,
      },
      mouseIdleSeconds: 2, keyboardIdleSeconds: 2,
      sessionLocked: false,
    });
    const heartbeat = (capturedAtUtc: string): EnvironmentStateDto => ({
      schemaVersion: 1, capturedAtUtc, fullscreen: false, locked: false, doNotDisturb: false, presenting: false, excludedApplication: false,
      secondsSinceMouseInput: 30, secondsSinceKeyboardInput: 30,
      power: { kind: 'available', onBattery: false, batteryPercent: 90 },
    });
    const sessionEvidence = (): number => service.graph.evidence.list(service.ownerId, 50, 0)
      .filter((row) => row.source_type === 'desktop_activity').length;

    service.ingestEnvironment(heartbeat('2026-08-05T09:04:00.000Z'));
    assert.equal(sessionEvidence(), 0, 'still inside the session gap');
    service.ingestEnvironment(heartbeat('2026-08-05T09:06:00.000Z'));
    assert.equal(sessionEvidence(), 1, 'the stalled session closed and emitted its observation');
  });
});

test('a residency change preempts the drain and waits for it to finish', async () => {
  const inference = new GateInference();
  await withService({ inference }, async (service) => {
    service.ingestChatTurn(turn(1));
    const order: string[] = [];
    const drain = service.drainJobs();
    void drain.then(() => order.push('drain'));
    await inference.callStarted;
    const residency = service.onModelResidencyChanging().then(() => order.push('residency'));
    inference.release();
    await drain;
    await residency;
    assert.deepEqual(order, ['drain', 'residency']);
  });
});

test('a residency change blocks a second drain while the first drain is unwinding', async () => {
  const inference = new GateInference();
  await withService({ inference }, async (service) => {
    service.ingestChatTurn(turn(1));
    service.ingestChatTurn(turn(2));
    const firstDrain = service.drainJobs();
    await inference.callStarted;
    const residency = service.onModelResidencyChanging();
    const secondDrain = service.drainJobs();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inference.calls, 1, 'no new model call may start during a residency change');
    assert.equal(service.listBackgroundWorkDecisions()[0]?.reason, 'drain_blocked');
    inference.release();
    await Promise.all([firstDrain, secondDrain, residency]);
  });
});

test('concurrent drain ticks do not start overlapping model calls', async () => {
  const inference = new GateInference();
  await withService({ inference }, async (service) => {
    service.ingestChatTurn(turn(1));
    service.ingestChatTurn(turn(2));
    const firstDrain = service.drainJobs();
    await inference.callStarted;
    const secondDrain = service.drainJobs();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inference.calls, 1, 'periodic ticks must not overlap active drains');
    assert.equal(service.listBackgroundWorkDecisions()[0]?.reason, 'drain_already_running');
    inference.release();
    await Promise.all([firstDrain, secondDrain]);
  });
});

test('private mode does not block queued background work', async () => {
  const inference = new FakeAssistantInference([NO_OPERATIONS]);
  await withService({ inference, privateMode: true }, async (service) => {
    service.ingestChatTurn(turn(1));
    await service.drainJobs();
    assert.equal(inference.requests.length, 1);
  });
});
