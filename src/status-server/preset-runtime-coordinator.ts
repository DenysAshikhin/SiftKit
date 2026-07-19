import type { InferenceRuntimeErrorPhase, InferenceRuntimeStatus } from '@siftkit/contracts';
import type { ModelRuntimePreset, SiftConfig } from '../config/types.js';
import type { ManagedInferenceRuntime } from './managed-inference-runtime.js';
import { readConfig, writeConfig } from './config-store.js';

export class PresetRuntimeCoordinator {
  private activePreset: ModelRuntimePreset;
  private pendingPresetId: string | null = null;
  private modelRequestActive = false;
  private switchPromise: Promise<void> | null = null;
  private errorPhase: InferenceRuntimeErrorPhase | null = null;
  private error: string | null = null;
  private rollback: string | null = null;
  private idleDeadlineUtc: string | null = null;
  private idleUnloadInProgress = false;

  constructor(
    private readonly configPath: string,
    private readonly llamaRuntime: ManagedInferenceRuntime,
    private readonly exl3Runtime: ManagedInferenceRuntime,
  ) {
    const config = readConfig(configPath);
    const preset = config.Server.ModelPresets.Presets.find(
      (candidate) => candidate.id === config.Server.ModelPresets.ActivePresetId,
    );
    if (!preset) throw new Error(`Model preset '${config.Server.ModelPresets.ActivePresetId}' does not exist.`);
    this.activePreset = preset;
  }

  async initialize(): Promise<void> {
    const preset = this.activePreset;
    const runtime = this.getRuntime(preset);
    try {
      await runtime.ensurePresetReady(preset);
    } catch (error) {
      this.fail('process-start', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async applyPreset(presetId: string): Promise<'ready' | 'queued'> {
    const target = this.getPreset(presetId);
    if (
      this.presetsEqual(target, this.activePreset)
      && this.pendingPresetId === null
      && this.getRuntime(this.activePreset).getModelState() === 'ready'
    ) return 'ready';
    if (this.switchPromise) throw new Error('A preset switch is already in progress.');
    this.pendingPresetId = presetId;
    this.errorPhase = null;
    this.error = null;
    this.rollback = null;
    if (this.modelRequestActive) return 'queued';
    await this.startPendingSwitch();
    return 'ready';
  }

  async applyConfig(config: SiftConfig): Promise<'ready' | 'queued'> {
    const requestedPresetId = config.Server.ModelPresets.ActivePresetId;
    const stagedConfig: SiftConfig = {
      ...config,
      Server: {
        ...config.Server,
        ModelPresets: {
          ...config.Server.ModelPresets,
          ActivePresetId: this.activePreset.id,
        },
      },
    };
    writeConfig(this.configPath, stagedConfig);
    return await this.applyPreset(requestedPresetId);
  }

  async ensureActivePresetReady(): Promise<void> {
    const configuredId = readConfig(this.configPath).Server.ModelPresets.ActivePresetId;
    const configuredPreset = this.getPreset(configuredId);
    if (!this.presetsEqual(configuredPreset, this.activePreset)) await this.applyPreset(configuredId);
    if (this.switchPromise) await this.switchPromise;
    const preset = this.activePreset;
    const runtime = this.getRuntime(preset);
    try {
      await runtime.ensurePresetReady(preset);
      this.errorPhase = null;
      this.error = null;
    } catch (error) {
      this.fail('model-load', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  setModelRequestActive(active: boolean): void {
    this.modelRequestActive = active;
  }

  canGrantModelRequest(): boolean {
    return this.pendingPresetId === null && this.switchPromise === null && !this.idleUnloadInProgress;
  }

  setIdleDeadlineUtc(deadlineUtc: string | null): void {
    this.idleDeadlineUtc = deadlineUtc;
  }

  async unloadActivePresetForIdle(presetId: string): Promise<boolean> {
    if (presetId !== this.activePreset.id || this.modelRequestActive || this.pendingPresetId !== null) return false;
    const preset = this.activePreset;
    if (preset.Backend !== 'exl3') return false;
    const runtime = this.getRuntime(preset);
    if (runtime.getModelState() !== 'ready') return false;
    this.idleUnloadInProgress = true;
    try {
      await runtime.unloadPreset();
      return true;
    } catch (error) {
      this.fail('model-unload', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.idleUnloadInProgress = false;
    }
  }

  async onModelRequestReleased(): Promise<void> {
    if (!this.modelRequestActive && this.pendingPresetId !== null) await this.startPendingSwitch();
  }

  getStatus(): InferenceRuntimeStatus {
    const preset = this.activePreset;
    const runtime = this.getRuntime(preset);
    return {
      activePresetId: preset.id,
      activePresetLabel: preset.label,
      backend: preset.Backend,
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
    const runtime = this.getRuntime(this.activePreset);
    if (runtime.id === 'exl3' && runtime.getModelState() === 'ready') await runtime.unloadPreset();
    await runtime.stopProcess();
    this.pendingPresetId = null;
  }

  private async startPendingSwitch(): Promise<void> {
    if (this.switchPromise || this.pendingPresetId === null) return this.switchPromise ?? Promise.resolve();
    const targetId = this.pendingPresetId;
    this.switchPromise = this.executeSwitch(targetId);
    try {
      await this.switchPromise;
    } finally {
      this.switchPromise = null;
    }
  }

  private async executeSwitch(targetId: string): Promise<void> {
    const previous = this.activePreset;
    const target = this.getPreset(targetId);
    const previousRuntime = this.getRuntime(previous);
    const targetRuntime = this.getRuntime(target);
    const restartSameLlama = previous.Backend === 'llama'
      && target.Backend === 'llama'
      && !this.presetsEqual(previous, target);
    try {
      if (previous.Backend === 'exl3') await previousRuntime.unloadPreset();
      if (previous.Backend !== target.Backend || restartSameLlama) await previousRuntime.stopProcess();
      await targetRuntime.ensurePresetReady(target);
      this.persistActivePreset(target.id);
      this.activePreset = target;
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
        if ((previous.Backend !== target.Backend || restartSameLlama) && targetRuntime.getProcessState() !== 'stopped') {
          await targetRuntime.stopProcess();
        }
        this.restorePreset(previous);
        await previousRuntime.ensurePresetReady(previous);
        this.activePreset = previous;
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

  private persistActivePreset(presetId: string): void {
    const config = readConfig(this.configPath);
    config.Server.ModelPresets.ActivePresetId = presetId;
    writeConfig(this.configPath, config);
  }

  private restorePreset(preset: ModelRuntimePreset): void {
    const config = readConfig(this.configPath);
    const index = config.Server.ModelPresets.Presets.findIndex((candidate) => candidate.id === preset.id);
    if (index < 0) throw new Error(`Model preset '${preset.id}' cannot be restored because it no longer exists.`);
    config.Server.ModelPresets.Presets[index] = preset;
    config.Server.ModelPresets.ActivePresetId = preset.id;
    writeConfig(this.configPath, config);
  }

  private getPreset(presetId: string): ModelRuntimePreset {
    const config = readConfig(this.configPath);
    const preset = config.Server.ModelPresets.Presets.find((candidate) => candidate.id === presetId);
    if (!preset) throw new Error(`Model preset '${presetId}' does not exist.`);
    return preset;
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
