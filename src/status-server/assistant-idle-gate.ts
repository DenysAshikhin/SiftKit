import type { InteractivityGate } from '../assistant/jobs/job-runner.js';
import { DEFAULT_ASSISTANT_CONFIG } from '../config/defaults.js';
import { isIdle } from './server-ops.js';
import type { ServerContext } from './server-types.js';

/**
 * Pure quiet-window bookkeeping: idle means the server is not busy now AND has been
 * continuously quiet for the configured threshold. Busyness or reported activity
 * restarts the window.
 */
export class QuietWindowTracker {
  private lastActiveAtMs: number;

  constructor(nowMs: number) {
    this.lastActiveAtMs = nowMs;
  }

  noteActivity(nowMs: number): void {
    this.lastActiveAtMs = nowMs;
  }

  isIdle(busy: boolean, thresholdSeconds: number, nowMs: number): boolean {
    if (busy) {
      this.lastActiveAtMs = nowMs;
      return false;
    }
    return nowMs - this.lastActiveAtMs >= thresholdSeconds * 1000;
  }
}

/**
 * Idle means: the server is not doing anything right now, and the user has not touched
 * keyboard/mouse for the threshold (shell-reported). Without fresh shell heartbeats the
 * server-quiet window decides instead, so headless setups still drain.
 */
export function evaluateIdle(
  quietWindow: QuietWindowTracker,
  busy: boolean,
  inputIdleSeconds: number | null,
  thresholdSeconds: number,
  nowMs: number,
): boolean {
  if (busy) {
    quietWindow.noteActivity(nowMs);
    return false;
  }
  if (inputIdleSeconds !== null) {
    return inputIdleSeconds >= thresholdSeconds;
  }
  return quietWindow.isIdle(false, thresholdSeconds, nowMs);
}

/**
 * Background assistant work runs only when the server is doing nothing else (§12.4) and has
 * stayed that way for Background.IdleSecondsBeforeProcessing, read live from the service
 * config so the dashboard knob applies without a restart.
 */
export class StatusServerIdleGate implements InteractivityGate {
  private readonly quietWindow = new QuietWindowTracker(Date.now());

  constructor(private readonly ctx: ServerContext) {}

  /** Stamped on every incoming model request, so bursts between drain polls still count. */
  noteActivity(): void {
    this.quietWindow.noteActivity(Date.now());
  }

  isIdle(): boolean {
    const background = this.ctx.assistantControl === null
      ? DEFAULT_ASSISTANT_CONFIG.Background
      : this.ctx.assistantControl.config.Background;
    const inputIdleSeconds = this.ctx.assistantControl === null
      ? null
      : this.ctx.assistantControl.desktopInputIdleSeconds();
    return evaluateIdle(
      this.quietWindow,
      !isIdle(this.ctx),
      inputIdleSeconds,
      background.IdleSecondsBeforeProcessing,
      Date.now(),
    );
  }
}
