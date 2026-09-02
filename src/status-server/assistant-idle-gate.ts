import type {
  BackgroundWorkAdmissionDecision, InteractivityGate,
} from '../assistant/jobs/job-runner.js';
import type { DesktopInputIdle } from '../assistant/observation/environment-cache.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../config/defaults.js';
import { isIdle } from './server-ops.js';
import type { ServerContext, TerminalMetadataState } from './server-types.js';

export function secondsSinceModelActivity(
  metadata: Pick<TerminalMetadataState, 'lastModelRequestFinishedAtMs' | 'serverStartedAtMs'>,
  nowMs: number,
): number {
  const lastActivityMs = metadata.lastModelRequestFinishedAtMs ?? metadata.serverStartedAtMs;
  return Math.floor((nowMs - lastActivityMs) / 1000);
}

/**
 * Ordered truth table, first match wins: server busy, heartbeat missing, model recently active,
 * mouse, keyboard, allowed. Every blocked branch names the signal holding the gate so the
 * decision history shows which one to look at (design §3.5).
 */
export function evaluateIdleDecision(
  busy: boolean,
  inputIdle: DesktopInputIdle | null,
  thresholdSeconds: number,
  modelQuietSeconds: number,
): BackgroundWorkAdmissionDecision {
  if (busy) {
    return { kind: 'blocked', reason: 'server_busy', details: {} };
  }
  if (inputIdle === null) {
    return { kind: 'blocked', reason: 'environment_heartbeat_missing', details: {} };
  }
  if (modelQuietSeconds < thresholdSeconds) {
    return {
      kind: 'blocked',
      reason: 'model_recently_active',
      details: { secondsSinceModelActivity: modelQuietSeconds, requiredIdleSeconds: thresholdSeconds },
    };
  }
  if (inputIdle.mouse < thresholdSeconds) {
    return {
      kind: 'blocked',
      reason: 'mouse_idle_below_threshold',
      details: { mouseIdleSeconds: inputIdle.mouse, requiredIdleSeconds: thresholdSeconds },
    };
  }
  if (inputIdle.keyboard < thresholdSeconds) {
    return {
      kind: 'blocked',
      reason: 'keyboard_idle_below_threshold',
      details: { keyboardIdleSeconds: inputIdle.keyboard, requiredIdleSeconds: thresholdSeconds },
    };
  }
  return { kind: 'allowed' };
}

export class StatusServerIdleGate implements InteractivityGate {
  private reportedMissingInputData = false;

  constructor(private readonly ctx: ServerContext) {}

  evaluate(): BackgroundWorkAdmissionDecision {
    const control = this.ctx.assistantControl;
    const background = control === null
      ? DEFAULT_ASSISTANT_CONFIG.Background
      : control.config.Background;
    const inputIdle = control === null ? null : control.desktopInputIdle();
    if (inputIdle === null && control !== null && control.enabled) {
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
      !isIdle(this.ctx),
      inputIdle,
      background.IdleSecondsBeforeProcessing,
      secondsSinceModelActivity(this.ctx.terminalMetadata, Date.now()),
    );
  }
}
