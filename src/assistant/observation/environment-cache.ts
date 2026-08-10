import { DESKTOP_HEARTBEAT_STALENESS_SECONDS, type EnvironmentStateDto } from '@siftkit/contracts';

import type { Clock } from '../clock.js';
import type { PowerState, PowerStateProvider } from '../jobs/resource-policy.js';
import type {
  QuestionEnvironmentState, QuestionEnvironmentStateProvider,
} from '../questions/environment-state.js';

function localTimeOf(epochMs: number): string {
  const now = new Date(epochMs);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * The power seam is a separate object because `PowerStateProvider.read()` and
 * `QuestionEnvironmentStateProvider.read()` return different shapes under the same name.
 */
class DesktopPowerStateProvider implements PowerStateProvider {
  constructor(private readonly cache: DesktopEnvironmentCache) {}

  read(): PowerState {
    return this.cache.readPower();
  }
}

/**
 * The daemon's view of the desktop, refreshed by the shell's environment heartbeat. Both question
 * policy and the background resource policy read through here, so a disconnected or paused shell
 * degrades to `unavailable` — never to a stale "it's fine, ask away" answer.
 */
export class DesktopEnvironmentCache implements QuestionEnvironmentStateProvider {
  /** Power seam for `AssistantResourcePolicy`, backed by the same heartbeat and deadline. */
  readonly power: PowerStateProvider;

  private last: EnvironmentStateDto | null = null;
  private receivedEpochMs = 0;

  constructor(
    private readonly clock: Clock,
    private readonly stalenessSeconds: number = DESKTOP_HEARTBEAT_STALENESS_SECONDS,
  ) {
    this.power = new DesktopPowerStateProvider(this);
  }

  ingest(state: EnvironmentStateDto): void {
    this.last = state;
    this.receivedEpochMs = this.clock.nowEpochMs();
  }

  read(): QuestionEnvironmentState {
    const fresh = this.fresh();
    if (fresh === null) return { kind: 'unavailable' };
    const epochMs = this.clock.nowEpochMs();
    return {
      kind: 'available',
      nowUtc: this.clock.nowUtc(),
      localTime: localTimeOf(epochMs),
      fullscreen: fresh.fullscreen,
      locked: fresh.locked,
      doNotDisturb: fresh.doNotDisturb,
      presenting: fresh.presenting,
      excludedApplication: fresh.excludedApplication,
      secondsSinceInput: fresh.secondsSinceInput,
    };
  }

  readPower(): PowerState {
    const fresh = this.fresh();
    if (fresh === null || fresh.power.kind === 'unavailable') return { kind: 'unavailable' };
    return {
      kind: 'available',
      onBattery: fresh.power.onBattery,
      batteryPercent: fresh.power.batteryPercent,
    };
  }

  private fresh(): EnvironmentStateDto | null {
    if (this.last === null) return null;
    const ageSeconds = (this.clock.nowEpochMs() - this.receivedEpochMs) / 1000;
    return ageSeconds > this.stalenessSeconds ? null : this.last;
  }
}
