import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackendSwitchCoordinator,
  type BackendSelectionStore,
} from '../src/status-server/backend-switch-coordinator.js';
import { ManagedInferenceRuntime } from '../src/status-server/managed-inference-runtime.js';
import type { InferenceBackendId } from '../src/config/types.js';

class MemorySelectionStore implements BackendSelectionStore {
  selected: InferenceBackendId = 'llama';

  getSelectedBackend(): InferenceBackendId {
    return this.selected;
  }

  saveSelectedBackend(backend: InferenceBackendId): void {
    this.selected = backend;
  }
}

class RecordingRuntime extends ManagedInferenceRuntime {
  private startCount = 0;

  constructor(id: InferenceBackendId, private readonly events: string[]) {
    super(id, `http://127.0.0.1:${id === 'llama' ? '8097' : '8098'}`, `${id}-model`, {
      chatTemplateKwargs: true,
      reasoningContent: true,
      toolCalling: true,
      jsonSchema: true,
      speculativeMode: id === 'exl3' ? 'mtp' : 'ngram',
      reusablePrefixCache: 'unknown',
    });
  }

  async start(): Promise<void> {
    this.startCount += 1;
    this.events.push(`start:${this.id}`);
    this.transitionTo('ready');
  }

  async stop(): Promise<void> {
    this.events.push(`stop:${this.id}`);
    this.transitionTo('stopped');
  }

  async waitUntilReady(): Promise<void> {
    assert.equal(this.getState(), 'ready');
  }

  getStartCount(): number {
    return this.startCount;
  }
}

class FailingRuntime extends ManagedInferenceRuntime {
  private startCount = 0;

  constructor(
    id: InferenceBackendId,
    private readonly events: string[],
    private readonly failOnStartNumber: number,
  ) {
    super(id, `http://127.0.0.1:${id === 'llama' ? '8097' : '8098'}`, `${id}-model`, {
      chatTemplateKwargs: true,
      reasoningContent: true,
      toolCalling: true,
      jsonSchema: true,
      speculativeMode: 'none',
      reusablePrefixCache: 'unknown',
    });
  }

  async start(): Promise<void> {
    this.startCount += 1;
    this.events.push(`start:${this.id}`);
    if (this.startCount === this.failOnStartNumber) {
      this.transitionTo('failed');
      throw new Error(`${this.id} start ${this.startCount} failed`);
    }
    this.transitionTo('ready');
  }

  async stop(): Promise<void> {
    this.events.push(`stop:${this.id}`);
    this.transitionTo('stopped');
  }

  async waitUntilReady(): Promise<void> {
    if (this.getState() !== 'ready') {
      throw new Error(`${this.id} is not ready`);
    }
  }
}

test('backend switch drains the active request before stopping llama and starting EXL3', async () => {
  const events: string[] = [];
  const store = new MemorySelectionStore();
  const coordinator = new BackendSwitchCoordinator(
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
    store,
  );
  await coordinator.initialize();
  coordinator.setModelRequestActive(true);

  const selection = await coordinator.select('exl3');

  assert.equal(selection, 'queued');
  assert.equal(coordinator.getStatus().state, 'draining');
  assert.equal(coordinator.canGrantModelRequest(), false);
  assert.deepEqual(events, ['start:llama']);

  coordinator.setModelRequestActive(false);
  await coordinator.onModelRequestReleased();
  await coordinator.waitForBackend('exl3');

  assert.deepEqual(events, ['start:llama', 'stop:llama', 'start:exl3']);
  assert.equal(coordinator.getStatus().active, 'exl3');
  assert.equal(coordinator.getStatus().state, 'ready');
  assert.equal(coordinator.canGrantModelRequest(), true);
});

test('selecting the active backend while draining cancels the pending switch', async () => {
  const events: string[] = [];
  const store = new MemorySelectionStore();
  const coordinator = new BackendSwitchCoordinator(
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
    store,
  );
  await coordinator.initialize();
  coordinator.setModelRequestActive(true);
  await coordinator.select('exl3');

  const result = await coordinator.select('llama');

  assert.equal(result, 'ready');
  assert.equal(coordinator.getStatus().pending, null);
  assert.equal(coordinator.getStatus().state, 'ready');
  assert.equal(coordinator.canGrantModelRequest(), true);
  assert.deepEqual(events, ['start:llama']);
});

test('idle switch is immediate and duplicate selection is idempotent', async () => {
  const events: string[] = [];
  const store = new MemorySelectionStore();
  const llama = new RecordingRuntime('llama', events);
  const exl3 = new RecordingRuntime('exl3', events);
  const coordinator = new BackendSwitchCoordinator(llama, exl3, store);
  await coordinator.initialize();

  assert.equal(await coordinator.select('exl3'), 'ready');
  assert.equal(await coordinator.select('exl3'), 'ready');

  assert.deepEqual(events, ['start:llama', 'stop:llama', 'start:exl3']);
  assert.equal(exl3.getStartCount(), 1);
  assert.equal(store.selected, 'exl3');
});

test('startup restores the persisted selected backend', async () => {
  const events: string[] = [];
  const store = new MemorySelectionStore();
  store.selected = 'exl3';
  const coordinator = new BackendSwitchCoordinator(
    new RecordingRuntime('llama', events),
    new RecordingRuntime('exl3', events),
    store,
  );

  await coordinator.initialize();

  assert.deepEqual(events, ['start:exl3']);
  assert.equal(coordinator.getStatus().active, 'exl3');
});

test('failed startup can retry the selected backend while its request owns admission', async () => {
  const events: string[] = [];
  const store = new MemorySelectionStore();
  const coordinator = new BackendSwitchCoordinator(
    new FailingRuntime('llama', events, 1),
    new RecordingRuntime('exl3', events),
    store,
  );
  await assert.rejects(coordinator.initialize(), /llama start 1 failed/u);
  assert.equal(coordinator.canGrantModelRequest(), true);
  coordinator.setModelRequestActive(true);

  await coordinator.retrySelectedBackend();

  assert.deepEqual(events, ['start:llama', 'start:llama']);
  assert.equal(coordinator.getStatus().active, 'llama');
  assert.equal(coordinator.getStatus().state, 'ready');
  assert.equal(coordinator.getStatus().pending, null);
});

test('failed target startup rolls back once and resumes the previous backend', async () => {
  const events: string[] = [];
  const store = new MemorySelectionStore();
  const coordinator = new BackendSwitchCoordinator(
    new RecordingRuntime('llama', events),
    new FailingRuntime('exl3', events, 1),
    store,
  );
  await coordinator.initialize();

  await assert.rejects(coordinator.select('exl3'), /exl3 start 1 failed/u);

  assert.deepEqual(events, ['start:llama', 'stop:llama', 'start:exl3', 'start:llama']);
  assert.equal(coordinator.getStatus().active, 'llama');
  assert.equal(coordinator.getStatus().selected, 'exl3');
  assert.equal(coordinator.getStatus().pending, null);
  assert.equal(coordinator.getStatus().state, 'ready');
  assert.equal(coordinator.getStatus().rollback, "Restored 'llama'.");
  assert.equal(coordinator.canGrantModelRequest(), true);
});

test('failed target and failed rollback leave the coordinator failed', async () => {
  const events: string[] = [];
  const store = new MemorySelectionStore();
  const coordinator = new BackendSwitchCoordinator(
    new FailingRuntime('llama', events, 2),
    new FailingRuntime('exl3', events, 1),
    store,
  );
  await coordinator.initialize();

  await assert.rejects(coordinator.select('exl3'), /exl3 start 1 failed/u);

  assert.equal(coordinator.getStatus().active, null);
  assert.equal(coordinator.getStatus().state, 'failed');
  assert.equal(coordinator.getStatus().rollback, 'llama start 2 failed');
  assert.equal(coordinator.canGrantModelRequest(), false);
});
