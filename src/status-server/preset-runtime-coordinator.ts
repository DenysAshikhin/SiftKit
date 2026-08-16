import type {
  InferenceBackendId,
  InferenceRuntimeErrorPhase,
  InferenceRuntimeStatus,
  ModelLifecycleActionResult,
} from '@siftkit/contracts';
import type { ModelRuntimePreset, SiftConfig } from '../config/types.js';
import type { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import type { ModelRequestLock } from './server-types.js';
import type { AppliedModelPresetState } from './applied-model-preset-state.js';
import { readConfig, writeConfig } from './config-store.js';

const MODEL_RESIDENCY_TRANSITION_BUSY_ERROR = 'A model residency transition is in progress; retry once it completes.';

/** Raised when a restart is asked of a preset whose server SiftKit did not launch. */
export class ExternalServerRestartError extends Error {}

export class PresetRuntimeCoordinator {
  private pendingPresetId: string | null = null;
  private pendingForceRestart = false;
  private switchPromise: Promise<void> | null = null;
  private errorPhase: InferenceRuntimeErrorPhase | null = null;
  private error: string | null = null;
  private rollback: string | null = null;
  private idleDeadlineUtc: string | null = null;
  private residencyActionInProgress = false;
  private admissionBlockerCount = 0;
  private admissionBlockerPromise: Promise<void> = Promise.resolve();
  private resolveAdmissionBlocker: (() => void) | null = null;

  constructor(
    private readonly configPath: string,
    private readonly llamaRuntime: ManagedInferenceRuntime,
    private readonly exl3Runtime: ManagedInferenceRuntime,
    /**
     * The server's live in-flight request map, read on this coordinator's own terms. It is the
     * single owner of that fact: nothing has to remember to notify the coordinator when it changes.
     */
    private readonly activeModelRequests: ReadonlyMap<string, ModelRequestLock>,
    private readonly appliedModelPresetState: AppliedModelPresetState,
  ) {
    this.appliedModelPresetState.applyPreset(this.getConfiguredPreset());
  }

  /** The runtime that owns the applied preset right now. Read-only: asking never starts one. */
  getActiveRuntime(): ManagedInferenceRuntime {
    return this.getRuntime(this.appliedModelPresetState.getPreset());
  }

  async initialize(): Promise<void> {
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    try {
      if (runtime.getModelState() === 'frozen') await runtime.restorePreset();
      else await runtime.ensurePresetReady(preset);
    } catch (error) {
      this.fail('process-start', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async applyPreset(presetId: string): Promise<'ready' | 'queued'> {
    if (this.residencyActionInProgress) throw new Error(MODEL_RESIDENCY_TRANSITION_BUSY_ERROR);
    const target = this.getPreset(presetId);
    if (
      this.presetsEqual(target, this.appliedModelPresetState.getPreset())
      && this.pendingPresetId === null
      && this.getRuntime(this.appliedModelPresetState.getPreset()).getModelState() === 'ready'
    ) return 'ready';
    if (this.switchPromise) throw new Error('A preset switch is already in progress.');
    this.setPendingSwitch(presetId, false);
    if (this.hasActiveModelRequests()) return 'queued';
    await this.startPendingSwitch();
    return 'ready';
  }

  // Stops and re-readies the preset currently persisted in config, even when it is
  // byte-identical to the running one. This is the only path that guarantees a real
  // process restart, so it never short-circuits on an already-ready runtime — and it
  // refuses outright when the server belongs to someone else, because stopping it is
  // then impossible and reporting success would be a lie.
  async restartConfiguredPreset(): Promise<void> {
    if (this.residencyActionInProgress) throw new Error(MODEL_RESIDENCY_TRANSITION_BUSY_ERROR);
    if (this.switchPromise) throw new Error('A preset switch is already in progress.');
    if (this.hasActiveModelRequests()) throw new Error('A model request is in progress; retry once it completes.');
    const configured = this.getConfiguredPreset();
    if (configured.ExternalServerEnabled) {
      throw new ExternalServerRestartError(
        `Preset '${configured.id}' uses an external inference server, so SiftKit does not own its lifecycle and cannot restart it.`,
      );
    }
    this.setPendingSwitch(configured.id, true);
    await this.startPendingSwitch();
  }

  async ensureActivePresetReady(): Promise<void> {
    const configuredPreset = this.getConfiguredPreset();
    if (!this.presetsEqual(configuredPreset, this.appliedModelPresetState.getPreset())) {
      await this.applyPreset(configuredPreset.id);
    }
    if (this.switchPromise) await this.switchPromise;
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    const modelState = runtime.getModelState();
    if (modelState === 'ready') {
      this.errorPhase = null;
      this.error = null;
      return;
    }
    this.beginResidencyAction();
    try {
      if (modelState === 'frozen') await runtime.restorePreset();
      else await runtime.ensurePresetReady(preset);
      this.errorPhase = null;
      this.error = null;
    } catch (error) {
      this.fail('model-load', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.endResidencyAction();
    }
  }

  private hasActiveModelRequests(): boolean {
    return this.activeModelRequests.size > 0;
  }

  getActiveBackend(): InferenceBackendId {
    return this.appliedModelPresetState.getPreset().Backend;
  }

  canGrantModelRequest(): boolean {
    return this.pendingPresetId === null && this.switchPromise === null && !this.residencyActionInProgress;
  }

  waitForCurrentAdmissionBlocker(): Promise<void> {
    if (this.canGrantModelRequest()) return Promise.resolve();
    return this.admissionBlockerPromise;
  }

  setIdleDeadlineUtc(deadlineUtc: string | null): void {
    this.idleDeadlineUtc = deadlineUtc;
  }

  async applyIdleResidencyAction(presetId: string, action: 'freeze' | 'unload'): Promise<boolean> {
    if (presetId !== this.appliedModelPresetState.getPreset().id || this.hasActiveModelRequests() || this.pendingPresetId !== null) return false;
    if (this.residencyActionInProgress) return false;
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() !== 'ready') return false;
    if (action === 'freeze' && preset.Backend !== 'exl3') {
      const error = new Error('Freeze requires the EXL3 backend.');
      this.fail('model-freeze', error.message);
      throw error;
    }
    this.beginResidencyAction();
    try {
      if (action === 'freeze') await runtime.freezePreset();
      else await runtime.unloadPreset();
      return true;
    } catch (error) {
      this.fail(action === 'freeze' ? 'model-freeze' : 'model-unload', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.endResidencyAction();
    }
  }

  private refuseIfBusy(): ModelLifecycleActionResult | null {
    if (this.switchPromise !== null || this.pendingPresetId !== null) {
      return { status: 'busy', reason: 'A preset switch is in progress; retry once it completes.' };
    }
    if (this.hasActiveModelRequests()) {
      return {
        status: 'busy',
        reason: `${this.activeModelRequests.size} model request(s) are in progress; retry once they complete.`,
      };
    }
    if (this.residencyActionInProgress) {
      return { status: 'busy', reason: MODEL_RESIDENCY_TRANSITION_BUSY_ERROR };
    }
    return null;
  }

  async unloadActivePresetNow(): Promise<ModelLifecycleActionResult> {
    const busy = this.refuseIfBusy();
    if (busy) return busy;
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() === 'unloaded') return { status: 'noop' };
    this.beginResidencyAction();
    try {
      await runtime.unloadPreset();
      return { status: 'done' };
    } catch (error) {
      this.fail('model-unload', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.endResidencyAction();
    }
  }

  async freezeActivePresetNow(): Promise<ModelLifecycleActionResult> {
    const busy = this.refuseIfBusy();
    if (busy) return busy;
    const preset = this.appliedModelPresetState.getPreset();
    if (preset.Backend !== 'exl3') {
      return { status: 'unsupported', reason: 'Freeze requires the EXL3 backend.' };
    }
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() === 'frozen') return { status: 'noop' };
    if (runtime.getModelState() !== 'ready') {
      return { status: 'busy', reason: `Cannot freeze a model in state '${runtime.getModelState()}'.` };
    }
    this.beginResidencyAction();
    try {
      await runtime.freezePreset();
      return { status: 'done' };
    } catch (error) {
      this.fail('model-freeze', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.endResidencyAction();
    }
  }

  async loadActivePresetNow(): Promise<ModelLifecycleActionResult> {
    const busy = this.refuseIfBusy();
    if (busy) return busy;
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() === 'ready') return { status: 'noop' };
    this.beginResidencyAction();
    try {
      if (runtime.getModelState() === 'frozen') await runtime.restorePreset();
      else await runtime.ensurePresetReady(preset);
      this.errorPhase = null;
      this.error = null;
      return { status: 'done' };
    } catch (error) {
      this.fail('model-load', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.endResidencyAction();
    }
  }

  async onModelRequestReleased(): Promise<void> {
    if (!this.hasActiveModelRequests() && this.pendingPresetId !== null) await this.startPendingSwitch();
  }

  getStatus(): InferenceRuntimeStatus {
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.getRuntime(preset);
    return {
      activePresetId: preset.id,
      activePresetLabel: preset.label,
      backend: preset.Backend,
      idleAction: preset.IdleAction,
      processState: runtime.getProcessState(),
      modelState: runtime.getModelState(),
      model: preset.Model,
      idleDeadlineUtc: this.idleDeadlineUtc,
      errorPhase: this.errorPhase,
      error: this.error,
      rollback: this.rollback,
    };
  }

  async shutdown(): Promise<void> {
    if (this.switchPromise) {
      try {
        await this.switchPromise;
      } catch {
        // Continue with best-effort shutdown of the active runtime.
      }
    }
    await this.waitForCurrentAdmissionBlocker();
    const runtime = this.getRuntime(this.appliedModelPresetState.getPreset());
    if (runtime.id === 'exl3' && runtime.getModelState() !== 'unloaded') {
      try {
        await runtime.unloadPreset();
      } catch {
        // Continue with best-effort process shutdown after a failed model unload.
      }
    }
    await runtime.stopProcess();
    this.pendingPresetId = null;
  }

  private setPendingSwitch(presetId: string, forceRestart: boolean): void {
    if (this.pendingPresetId === null) this.beginAdmissionBlocker();
    this.pendingPresetId = presetId;
    this.pendingForceRestart = forceRestart;
    this.errorPhase = null;
    this.error = null;
    this.rollback = null;
  }

  private async startPendingSwitch(): Promise<void> {
    if (this.switchPromise || this.pendingPresetId === null) return this.switchPromise ?? Promise.resolve();
    const targetId = this.pendingPresetId;
    this.switchPromise = this.executeSwitch(targetId, this.pendingForceRestart);
    try {
      await this.switchPromise;
    } finally {
      this.switchPromise = null;
      this.pendingForceRestart = false;
      this.endAdmissionBlocker();
    }
  }

  private beginResidencyAction(): void {
    this.residencyActionInProgress = true;
    this.beginAdmissionBlocker();
  }

  private endResidencyAction(): void {
    this.residencyActionInProgress = false;
    this.endAdmissionBlocker();
  }

  private beginAdmissionBlocker(): void {
    if (this.admissionBlockerCount === 0) {
      this.admissionBlockerPromise = new Promise<void>((resolve) => {
        this.resolveAdmissionBlocker = resolve;
      });
    }
    this.admissionBlockerCount += 1;
  }

  private endAdmissionBlocker(): void {
    if (this.admissionBlockerCount === 0) throw new Error('Admission blocker closed without an active blocker.');
    this.admissionBlockerCount -= 1;
    if (this.admissionBlockerCount > 0) return;
    const resolve = this.resolveAdmissionBlocker;
    if (!resolve) throw new Error('Admission blocker resolver is missing.');
    this.resolveAdmissionBlocker = null;
    this.admissionBlockerPromise = Promise.resolve();
    resolve();
  }

  private async executeSwitch(targetId: string, forceRestart: boolean): Promise<void> {
    const previous = this.appliedModelPresetState.getPreset();
    const target = this.getPreset(targetId);
    const previousRuntime = this.getRuntime(previous);
    const targetRuntime = this.getRuntime(target);
    const mustStopPrevious = previous.Backend !== target.Backend
      || forceRestart
      || (previous.Backend === 'llama' && !this.presetsEqual(previous, target));
    try {
      if (previous.Backend === 'exl3') await previousRuntime.unloadPreset();
      if (mustStopPrevious) await previousRuntime.stopProcess();
      await targetRuntime.ensurePresetReady(target);
      // Config already holds the requested preset: it is the saved intent this switch is
      // applying. Writing it back here would clobber a newer save that landed mid-switch.
      this.appliedModelPresetState.applyPreset(target);
      this.pendingPresetId = null;
    } catch (error) {
      this.fail('preset-switch', error instanceof Error ? error.message : String(error));
      let cleanupError: string | null = null;
      try {
        if (targetRuntime.getProcessState() === 'ready' && target.Backend === 'exl3') {
          try {
            await targetRuntime.unloadPreset();
          } catch (targetCleanupError) {
            cleanupError = targetCleanupError instanceof Error
              ? targetCleanupError.message
              : String(targetCleanupError);
          }
        }
        if (mustStopPrevious && targetRuntime.getProcessState() !== 'stopped') {
          await targetRuntime.stopProcess();
        }
        this.restorePreset(previous);
        await previousRuntime.ensurePresetReady(previous);
        this.appliedModelPresetState.applyPreset(previous);
        this.pendingPresetId = null;
        this.rollback = cleanupError
          ? `Restored preset '${previous.id}'. Target cleanup warning: ${cleanupError}`
          : `Restored preset '${previous.id}'.`;
      } catch (rollbackError) {
        this.rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      }
      throw error;
    }
  }

  private restorePreset(preset: ModelRuntimePreset): void {
    const config = readConfig(this.configPath);
    const index = config.Server.ModelPresets.Presets.findIndex((candidate) => candidate.id === preset.id);
    if (index < 0) throw new Error(`Model preset '${preset.id}' cannot be restored because it no longer exists.`);
    config.Server.ModelPresets.Presets[index] = preset;
    config.Server.ModelPresets.ActivePresetId = preset.id;
    writeConfig(this.configPath, config);
  }

  private findPreset(config: SiftConfig, presetId: string): ModelRuntimePreset {
    const preset = config.Server.ModelPresets.Presets.find((candidate) => candidate.id === presetId);
    if (!preset) throw new Error(`Model preset '${presetId}' does not exist.`);
    return preset;
  }

  private getPreset(presetId: string): ModelRuntimePreset {
    return this.findPreset(readConfig(this.configPath), presetId);
  }

  /** The persisted active preset, resolved from a single config read. */
  private getConfiguredPreset(): ModelRuntimePreset {
    const config = readConfig(this.configPath);
    return this.findPreset(config, config.Server.ModelPresets.ActivePresetId);
  }

  private getRuntime(preset: ModelRuntimePreset): ManagedInferenceRuntime {
    return preset.Backend === 'llama' ? this.llamaRuntime : this.exl3Runtime;
  }

  private presetsEqual(left: ModelRuntimePreset, right: ModelRuntimePreset): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private fail(phase: InferenceRuntimeErrorPhase, error: string): void {
    this.errorPhase = phase;
    this.error = error;
  }
}
