import type { ModelRuntimePreset } from '../config/types.js';
import { resumeModelRequestAdmission } from './server-ops.js';
import type { ServerContext } from './server-types.js';

export class ModelIdleController {
  private timer: NodeJS.Timeout | null = null;
  private presetId: string | null = null;
  private deadlineUtc: string | null = null;

  constructor(private readonly ctx: ServerContext) {}

  clearForIncomingRequest(): void {
    this.clear();
  }

  armAfterRequest(preset: ModelRuntimePreset, finishedAtMs: number): void {
    this.clear();
    if (preset.Backend !== 'exl3' || preset.SleepIdleSeconds <= 0) return;
    const delayMs = preset.SleepIdleSeconds * 1_000;
    this.presetId = preset.id;
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
    this.deadlineUtc = null;
    this.ctx.presetRuntimeCoordinator?.setIdleDeadlineUtc(null);
  }

  private async expire(): Promise<void> {
    const expectedPresetId = this.presetId;
    this.timer = null;
    this.deadlineUtc = null;
    this.ctx.presetRuntimeCoordinator?.setIdleDeadlineUtc(null);
    if (!expectedPresetId || this.ctx.activeModelRequests.size > 0 || this.ctx.modelRequestQueue.length > 0) return;
    // `unloadActivePresetForIdle` already refuses a preset that is no longer applied or is
    // not EXL3, so re-deriving those facts from config here would only duplicate the check.
    try {
      await this.ctx.presetRuntimeCoordinator?.unloadActivePresetForIdle(expectedPresetId);
    } catch (error) {
      process.stderr.write(`[siftKitStatus] EXL3 idle unload failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      resumeModelRequestAdmission(this.ctx);
    }
  }
}
