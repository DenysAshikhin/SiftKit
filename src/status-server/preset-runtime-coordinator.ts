import type {
  InferenceBackendId,
  InferenceRuntimeErrorPhase,
  InferenceRuntimeStatus,
  ModelLifecycleActionResult,
} from '@siftkit/contracts';
import type { ModelRuntimePreset, SiftConfig } from '../config/types.ts';
import type { ManagedInferenceRuntime } from './managed-inference-runtime.ts';
import type { ModelRequestLock } from './server-types.ts';
import type { AppliedModelPresetState } from './applied-model-preset-state.ts';
import { persistAppliedModelSelection, readConfig, restorePreviousModelSelection } from './config-store.ts';

const MODEL_RESIDENCY_TRANSITION_BUSY_ERROR = 'A model residency transition is in progress; retry once it completes.';

/** Raised when a restart is asked of a preset whose server SiftKit did not launch. */
export class ExternalServerRestartError extends Error {}

/** Administrative switches apply a saved selection; requested ones persist theirs inside the switch; restarts force a new process. */
type SwitchKind = 'administrative' | 'requested' | 'restart';

export class PresetRuntimeCoordinator {
  private pendingSwitch: { target: ModelRuntimePreset; kind: SwitchKind } | null = null;
  private switchPromise: Promise<void> | null = null;
  private errorPhase: InferenceRuntimeErrorPhase | null = null;
  private error: string | null = null;
  private rollback: string | null = null;
  private idleDeadlineUtc: string | null = null;
  private residencyActionInProgress = false;
  private admissionBlockerCount = 0;
  private admissionBlockerPromise: Promise<void> = Promise.resolve();
  private resolveAdmissionBlocker: (() => void) | null = null;

  private readonly configPath: string;
  private readonly runtime: ManagedInferenceRuntime;
  /** The server's live in-flight request map and the single owner of that fact,
   * so nothing has to notify the coordinator when it changes. */
  private readonly activeModelRequests: ReadonlyMap<string, ModelRequestLock>;
  private readonly appliedModelPresetState: AppliedModelPresetState;

  constructor(
    configPath: string,
    runtime: ManagedInferenceRuntime,
    activeModelRequests: ReadonlyMap<string, ModelRequestLock>,
    appliedModelPresetState: AppliedModelPresetState,
  ) {
    this.configPath = configPath;
    this.runtime = runtime;
    this.activeModelRequests = activeModelRequests;
    this.appliedModelPresetState = appliedModelPresetState;
    this.appliedModelPresetState.applyPreset(this.getConfiguredPreset());
  }

  /** The runtime that owns the applied preset right now. Read-only: asking never starts one. */
  getActiveRuntime(): ManagedInferenceRuntime {
    return this.runtime;
  }

  async initialize(): Promise<void> {
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.runtime;
    try {
      await runtime.ensurePresetReady(preset);
    } catch (error) {
      this.fail('process-start', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async applyPreset(presetId: string): Promise<'ready' | 'queued'> {
    if (this.residencyActionInProgress) throw new Error(MODEL_RESIDENCY_TRANSITION_BUSY_ERROR);
    const target = this.getPreset(presetId);
    if (
      this.appliedModelPresetState.isApplied(target)
      && this.pendingSwitch === null
      && this.runtime.getModelState() === 'ready'
    ) {
      this.publishReadyPreset(target);
      return 'ready';
    }
    if (this.switchPromise) throw new Error('A preset switch is already in progress.');
    this.setPendingSwitch(target, 'administrative');
    if (this.hasActiveModelRequests() && !this.hasReadyResidency(target)) return 'queued';
    await this.startPendingSwitch();
    return 'ready';
  }

  // Keep the target frozen while joining existing lifecycle work and preserve newer config saves.
  async ensureRequestPresetReady(target: ModelRuntimePreset): Promise<void> {
    const requested = structuredClone(target);
    while (!this.canGrantModelRequest()) {
      if (this.switchPromise !== null) await this.switchPromise;
      else await this.waitForCurrentAdmissionBlocker();
    }
    const currentConfig = readConfig(this.configPath);
    this.findPreset(currentConfig, requested.id);
    if (this.appliedModelPresetState.isApplied(requested)) {
      if (this.runtime.getModelState() !== 'ready') await this.restoreAppliedPreset(requested);
      this.publishReadyPreset(requested);
      persistAppliedModelSelection(this.configPath, currentConfig, requested);
      return;
    }
    if (this.hasActiveModelRequests() && !this.hasReadyResidency(requested)) {
      throw new Error(
        `${this.activeModelRequests.size} model request(s) are in progress; a requested model switch must wait for them to complete.`,
      );
    }
    this.setPendingSwitch(requested, 'requested');
    await this.startPendingSwitch();
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
    this.setPendingSwitch(configured, 'restart');
    await this.startPendingSwitch();
  }

  async ensureActivePresetReady(): Promise<void> {
    // Join a running switch and re-check, since config can be re-saved mid-switch. A queued switch is
    // not joined: it waits on in-flight model requests, which may be the caller (or a minutes-long run).
    for (;;) {
      while (this.switchPromise) await this.switchPromise;
      const configuredPreset = this.getConfiguredPreset();
      if (this.appliedModelPresetState.isApplied(configuredPreset)) break;
      if (await this.applyPreset(configuredPreset.id) === 'queued') break;
    }
    if (this.runtime.getModelState() === 'ready') {
      this.errorPhase = null;
      this.error = null;
      return;
    }
    await this.restoreAppliedPreset(this.appliedModelPresetState.getPreset());
  }

  // Reloads the applied preset in place; nothing else was resident, so a failure has nothing to roll back to.
  private async restoreAppliedPreset(preset: ModelRuntimePreset): Promise<void> {
    this.beginResidencyAction();
    try {
      await this.runtime.ensurePresetReady(preset);
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
    return this.pendingSwitch === null && this.switchPromise === null && !this.residencyActionInProgress;
  }

  waitForCurrentAdmissionBlocker(): Promise<void> {
    if (this.canGrantModelRequest()) return Promise.resolve();
    return this.admissionBlockerPromise;
  }

  setIdleDeadlineUtc(deadlineUtc: string | null): void {
    this.idleDeadlineUtc = deadlineUtc;
  }

  async applyIdleResidencyAction(presetId: string, action: 'unload'): Promise<boolean> {
    if (presetId !== this.appliedModelPresetState.getPreset().id || this.hasActiveModelRequests() || this.pendingSwitch !== null) return false;
    if (this.residencyActionInProgress) return false;
    const runtime = this.runtime;
    if (runtime.getModelState() !== 'ready') return false;
    this.beginResidencyAction();
    try {
      await runtime.unloadPreset();
      return true;
    } catch (error) {
      this.fail('model-unload', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.endResidencyAction();
    }
  }

  private refuseIfBusy(): ModelLifecycleActionResult | null {
    if (this.switchPromise !== null || this.pendingSwitch !== null) {
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
    const runtime = this.runtime;
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

  async loadActivePresetNow(): Promise<ModelLifecycleActionResult> {
    const busy = this.refuseIfBusy();
    if (busy) return busy;
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.runtime;
    if (runtime.getModelState() === 'ready') return { status: 'noop' };
    this.beginResidencyAction();
    try {
      await runtime.ensurePresetReady(preset);
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
    if (!this.hasActiveModelRequests() && this.pendingSwitch !== null) await this.startPendingSwitch();
  }

  getStatus(): InferenceRuntimeStatus {
    const preset = this.appliedModelPresetState.getPreset();
    const runtime = this.runtime;
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
    const runtime = this.runtime;
    if (runtime.getModelState() !== 'unloaded') {
      try {
        await runtime.unloadPreset();
      } catch {
        // Continue with best-effort process shutdown after a failed model unload.
      }
    }
    await runtime.stopProcess();
    this.pendingSwitch = null;
  }

  private setPendingSwitch(target: ModelRuntimePreset, kind: SwitchKind): void {
    if (this.pendingSwitch === null) this.beginAdmissionBlocker();
    this.pendingSwitch = { target: structuredClone(target), kind };
    this.errorPhase = null;
    this.error = null;
    this.rollback = null;
  }

  private async startPendingSwitch(): Promise<void> {
    if (this.switchPromise) return this.switchPromise;
    if (this.pendingSwitch === null) return;
    const { target, kind } = this.pendingSwitch;
    try {
      const expected = readConfig(this.configPath);
      this.findPreset(expected, target.id);
      this.switchPromise = this.executeSwitch(target, kind, expected);
      await this.switchPromise;
    } finally {
      this.switchPromise = null;
      this.pendingSwitch = null;
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

  private async executeSwitch(target: ModelRuntimePreset, kind: SwitchKind, expected: SiftConfig): Promise<void> {
    const previous = this.appliedModelPresetState.getPreset();
    const runtime = this.runtime;
    const forceRestart = kind === 'restart';
    const reuseResidency = !forceRestart && this.hasReadyResidency(target);
    try {
      if (!reuseResidency) await runtime.unloadPreset();
      if (forceRestart) await runtime.stopProcess();
      await runtime.ensurePresetReady(target);
      this.publishReadyPreset(target);
      // Persist before admission reopens so a joined readiness check never sees the old selection; compare-and-set keeps a newer save.
      if (kind === 'requested') persistAppliedModelSelection(this.configPath, expected, target);
    } catch (error) {
      this.fail('preset-switch', error instanceof Error ? error.message : String(error));
      let cleanupError: string | null = null;
      try {
        if (runtime.getProcessState() === 'ready') {
          try {
            await runtime.unloadPreset();
          } catch (targetCleanupError) {
            cleanupError = targetCleanupError instanceof Error
              ? targetCleanupError.message
              : String(targetCleanupError);
          }
        }
        if (forceRestart && runtime.getProcessState() !== 'stopped') {
          await runtime.stopProcess();
        }
        // Restore the previous selection only while the config is unchanged; a newer save keeps its intent.
        const restored = restorePreviousModelSelection(this.configPath, expected, previous);
        await runtime.ensurePresetReady(previous);
        this.appliedModelPresetState.applyPreset(previous);
        const warning = cleanupError ? ` Target cleanup warning: ${cleanupError}` : '';
        this.rollback = restored
          ? `Restored preset '${previous.id}'.${warning}`
          : `Kept the newer saved selection; running preset is '${previous.id}'.${warning}`;
      } catch (rollbackError) {
        this.rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      }
      throw error;
    }
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

  private hasReadyResidency(target: ModelRuntimePreset): boolean {
    return this.runtime.getModelState() === 'ready'
      && this.runtime.getPresetResidencyKey(target)
        === this.runtime.getPresetResidencyKey(this.appliedModelPresetState.getPreset());
  }

  private publishReadyPreset(target: ModelRuntimePreset): void {
    this.appliedModelPresetState.applyPreset(target);
    this.errorPhase = null;
    this.error = null;
  }

  private fail(phase: InferenceRuntimeErrorPhase, error: string): void {
    this.errorPhase = phase;
    this.error = error;
  }
}
