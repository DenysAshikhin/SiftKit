import type { ModelRuntimePreset } from '../config/types.js';
import { resumeModelRequestAdmission } from './server-ops.js';
import type { ServerContext } from './server-types.js';

export class ModelIdleController {
  private timer: NodeJS.Timeout | null = null;
  private presetId: string | null = null;
  private idleAction: 'freeze' | 'unload' | null = null;
  private deadlineUtc: string | null = null;

  constructor(private readonly ctx: ServerContext) {}

  clearForIncomingRequest(): void {
    this.clear();
  }

  armAfterRequest(preset: ModelRuntimePreset, finishedAtMs: number): void {
    this.clear();
    if (preset.IdleAction === 'none' || preset.SleepIdleSeconds <= 0) return;
    const delayMs = preset.SleepIdleSeconds * 1_000;
    this.presetId = preset.id;
    this.idleAction = preset.IdleAction;
    this.deadlineUtc = new Date(finishedAtMs + delayMs).toISOString();
    this.ctx.presetRuntimeCoordinator?.setIdleDeadlineUtc(this.deadlineUtc);
    this.timer = setTimeout(() => { void this.expire(); }, delayMs);
    this.timer.unref?.();
  }

  cancelForPresetChange(): void {
    this.clear();
  }

  getIdleDeadlineUtc(): string | null {
    return this.deadlineUtc;
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.presetId = null;
    this.idleAction = null;
    this.deadlineUtc = null;
    this.ctx.presetRuntimeCoordinator?.setIdleDeadlineUtc(null);
  }

  private async expire(): Promise<void> {
    const expectedPresetId = this.presetId;
    const action = this.idleAction;
    this.timer = null;
    this.deadlineUtc = null;
    this.ctx.presetRuntimeCoordinator?.setIdleDeadlineUtc(null);
    if (!expectedPresetId || !action || this.ctx.activeModelRequests.size > 0 || this.ctx.modelRequestQueue.length > 0) return;
    // `applyIdleResidencyAction` owns applied-preset, request, switch, and ready-state checks;
    // re-deriving those facts from config here would introduce a second source of truth.
    // Background assistant work talks to the inference server directly and cannot wake a frozen
    // model, so it is stopped before residency changes rather than left to fail against it.
    await this.ctx.assistantControl?.onModelResidencyChanging();
    try {
      await this.ctx.presetRuntimeCoordinator?.applyIdleResidencyAction(
        expectedPresetId,
        action,
      );
    } catch (error) {
      process.stderr.write(`[siftKitStatus] Model idle ${action} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      resumeModelRequestAdmission(this.ctx);
    }
  }
}
