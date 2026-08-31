import type {
  BackgroundWorkAdmissionDecision, InteractivityGate,
} from '../assistant/jobs/job-runner.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../config/defaults.js';
import { isIdle } from './server-ops.js';
import type { ServerContext } from './server-types.js';

/**
 * Idle means: the server is serving/queueing nothing right now, AND the user's keyboard/mouse
 * (shell-reported seconds since last OS input) have been quiet for the configured threshold.
 * No fresh shell heartbeat means no input data, which means not idle — background work waits
 * for the shell instead of guessing (§12.4).
 */
export function evaluateIdleDecision(
  busy: boolean,
  inputIdleSeconds: number | null,
  thresholdSeconds: number,
): BackgroundWorkAdmissionDecision {
  if (busy) {
    return { kind: 'blocked', reason: 'server_busy', details: {} };
  }
  if (inputIdleSeconds === null) {
    return { kind: 'blocked', reason: 'environment_heartbeat_missing', details: {} };
  }
  return inputIdleSeconds >= thresholdSeconds
    ? { kind: 'allowed' }
    : {
      kind: 'blocked',
      reason: 'input_idle_below_threshold',
      details: { inputIdleSeconds, requiredIdleSeconds: thresholdSeconds },
    };
}

export class StatusServerIdleGate implements InteractivityGate {
  private reportedMissingInputData = false;

  constructor(private readonly ctx: ServerContext) {}

  evaluate(): BackgroundWorkAdmissionDecision {
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
    return evaluateIdleDecision(
      !isIdle(this.ctx), inputIdleSeconds, background.IdleSecondsBeforeProcessing,
    );
  }
}
