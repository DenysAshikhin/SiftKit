import type { InteractivityGate } from '../assistant/jobs/job-runner.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../config/defaults.js';
import { isIdle } from './server-ops.js';
import type { ServerContext } from './server-types.js';

/**
 * Idle means: the server is serving/queueing nothing right now, AND the user's keyboard/mouse
 * (shell-reported seconds since last OS input) have been quiet for the configured threshold.
 * No fresh shell heartbeat means no input data, which means not idle — background work waits
 * for the shell instead of guessing (§12.4).
 */
export function evaluateIdle(
  busy: boolean,
  inputIdleSeconds: number | null,
  thresholdSeconds: number,
): boolean {
  if (busy || inputIdleSeconds === null) {
    return false;
  }
  return inputIdleSeconds >= thresholdSeconds;
}

export class StatusServerIdleGate implements InteractivityGate {
  private reportedMissingInputData = false;

  constructor(private readonly ctx: ServerContext) {}

  isIdle(): boolean {
    const control = this.ctx.assistantControl;
    const background = control === null
      ? DEFAULT_ASSISTANT_CONFIG.Background
      : control.config.Background;
    const inputIdleSeconds = control === null ? null : control.desktopInputIdleSeconds();
    if (inputIdleSeconds === null && control !== null && control.enabled) {
      if (!this.reportedMissingInputData) {
        this.reportedMissingInputData = true;
        process.stderr.write(
          '[assistant] no fresh desktop input heartbeats; background work is paused until the shell reports.\n',
        );
      }
    } else {
      this.reportedMissingInputData = false;
    }
    return evaluateIdle(!isIdle(this.ctx), inputIdleSeconds, background.IdleSecondsBeforeProcessing);
  }
}
