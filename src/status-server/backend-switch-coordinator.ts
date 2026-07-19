import type { BackendRuntimeStatus } from '@siftkit/contracts';

import type { InferenceBackendId, InferenceRuntimeState } from '../config/types.js';
import type { ManagedInferenceRuntime } from './managed-inference-runtime.js';

export class BackendSwitchCoordinator {
  private activeBackend: InferenceBackendId | null = null;
  private selectedBackend: InferenceBackendId;
  private pendingBackend: InferenceBackendId | null = null;
  private state: InferenceRuntimeState = 'stopped';
  private error: string | null = null;
  private rollback: string | null = null;
  private modelRequestActive = false;
  private switchPromise: Promise<void> | null = null;

  constructor(
    private readonly llamaRuntime: ManagedInferenceRuntime,
    private readonly exl3Runtime: ManagedInferenceRuntime,
    selectedBackend: InferenceBackendId,
  ) {
    this.selectedBackend = selectedBackend;
  }

  async initialize(): Promise<void> {
    const runtime = this.getRuntime(this.selectedBackend);
    this.state = 'starting';
    try {
      await runtime.start();
      await runtime.waitUntilReady();
      this.activeBackend = this.selectedBackend;
      this.state = 'ready';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.state = 'failed';
      throw error;
    }
  }

  setModelRequestActive(active: boolean): void {
    this.modelRequestActive = active;
  }

  canGrantModelRequest(): boolean {
    return (this.state === 'ready' || this.state === 'failed') && this.pendingBackend === null;
  }

  async select(backend: InferenceBackendId): Promise<'ready' | 'queued'> {
    if (backend === this.selectedBackend && backend === this.activeBackend && this.state === 'ready') {
      return 'ready';
    }
    if (backend === this.activeBackend && this.state === 'draining') {
      this.selectedBackend = backend;
      this.pendingBackend = null;
      this.state = 'ready';
      return 'ready';
    }
    if (this.state === 'stopping' || this.state === 'starting') {
      throw new Error(`Backend switch already in progress (${this.state}).`);
    }
    this.selectedBackend = backend;
    this.pendingBackend = backend;
    this.error = null;
    this.rollback = null;
    if (this.modelRequestActive) {
      this.state = 'draining';
      return 'queued';
    }
    await this.startPendingSwitch();
    return 'ready';
  }

  async retrySelectedBackend(): Promise<void> {
    if (this.state !== 'failed' || this.pendingBackend) {
      throw new Error(`Backend retry is unavailable while state is '${this.state}'.`);
    }
    this.pendingBackend = this.selectedBackend;
    this.error = null;
    this.rollback = null;
    await this.startPendingSwitch();
  }

  async onModelRequestReleased(): Promise<void> {
    if (this.modelRequestActive || !this.pendingBackend) {
      return;
    }
    await this.startPendingSwitch();
  }

  async waitForBackend(backend: InferenceBackendId): Promise<void> {
    while (this.activeBackend !== backend || this.state !== 'ready') {
      if (this.state === 'failed') {
        throw new Error(this.error ?? `Backend '${backend}' failed to start.`);
      }
      if (this.pendingBackend !== backend && this.selectedBackend !== backend) {
        throw new Error(`Backend '${backend}' is not selected.`);
      }
      if (this.switchPromise) {
        await this.switchPromise;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async shutdown(): Promise<void> {
    if (this.switchPromise) {
      try {
        await this.switchPromise;
      } catch {
        // The active runtime, if any, is still stopped below.
      }
    }
    if (this.activeBackend) {
      await this.getRuntime(this.activeBackend).stop();
    }
    this.activeBackend = null;
    this.pendingBackend = null;
    this.state = 'stopped';
  }

  getStatus(): BackendRuntimeStatus {
    const runtime = this.activeBackend ? this.getRuntime(this.activeBackend) : null;
    return {
      active: this.activeBackend,
      selected: this.selectedBackend,
      pending: this.pendingBackend,
      state: this.state,
      model: runtime?.getModelId() ?? null,
      error: this.error,
      rollback: this.rollback,
    };
  }

  private async startPendingSwitch(): Promise<void> {
    if (this.switchPromise || !this.pendingBackend) {
      return this.switchPromise ?? Promise.resolve();
    }
    const target = this.pendingBackend;
    this.switchPromise = this.executeSwitch(target);
    try {
      await this.switchPromise;
    } finally {
      this.switchPromise = null;
    }
  }

  private async executeSwitch(target: InferenceBackendId): Promise<void> {
    const previous = this.activeBackend;
    if (previous) {
      this.state = 'stopping';
      await this.getRuntime(previous).stop();
    }
    this.activeBackend = null;
    this.state = 'starting';
    const runtime = this.getRuntime(target);
    try {
      await runtime.start();
      await runtime.waitUntilReady();
      this.activeBackend = target;
      this.pendingBackend = null;
      this.state = 'ready';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.state = 'failed';
      if (previous) {
        try {
          const previousRuntime = this.getRuntime(previous);
          await previousRuntime.start();
          await previousRuntime.waitUntilReady();
          this.activeBackend = previous;
          this.pendingBackend = null;
          this.state = 'ready';
          this.rollback = `Restored '${previous}'.`;
        } catch (rollbackError) {
          this.activeBackend = null;
          this.rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        }
      } else {
        this.pendingBackend = null;
      }
      throw error;
    }
  }

  private getRuntime(backend: InferenceBackendId): ManagedInferenceRuntime {
    return backend === 'llama' ? this.llamaRuntime : this.exl3Runtime;
  }
}
