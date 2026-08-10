import { z } from '../../lib/zod.js';
import { parseJsonText } from '../../lib/json.js';
import type { AssistantConfig } from '../../config/types.js';
import type { RuntimeDatabase } from '../../state/runtime-db.js';
import type { Clock } from '../clock.js';

export const PowerStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('available'),
    onBattery: z.boolean(),
    batteryPercent: z.number().min(0).max(100),
  }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
]);
export type PowerState = z.infer<typeof PowerStateSchema>;

export interface PowerStateProvider {
  read(): PowerState;
}

export class UnavailablePowerStateProvider implements PowerStateProvider {
  read(): PowerState {
    return { kind: 'unavailable' };
  }
}

export const ResourceDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allowed') }).strict(),
  z.object({
    kind: z.literal('blocked'),
    reason: z.enum(['on_battery', 'battery_below_minimum', 'daily_gpu_limit']),
  }).strict(),
]);
export type ResourceDecision = z.infer<typeof ResourceDecisionSchema>;

const GpuUsageSchema = z.object({
  localDate: z.string(),
  milliseconds: z.number().int().min(0),
}).strict();

const GPU_USAGE_METADATA_KEY = 'assistant.gpu_usage.v1';

interface ResourcePolicyOptions {
  readonly database: RuntimeDatabase;
  readonly clock: Clock;
  readonly background: AssistantConfig['Background'];
  readonly power: PowerStateProvider;
}

export interface ResourcePolicy {
  canStartBackgroundWork(): ResourceDecision;
  canStartModelWork(): ResourceDecision;
  recordGpuUse(startedAtMs: number, finishedAtMs: number): void;
}

export class AssistantResourcePolicy implements ResourcePolicy {
  private background: AssistantConfig['Background'];

  constructor(private readonly options: ResourcePolicyOptions) {
    this.background = options.background;
  }

  refreshBackground(background: AssistantConfig['Background']): void {
    this.background = background;
  }

  canStartBackgroundWork(): ResourceDecision {
    const power = PowerStateSchema.parse(this.options.power.read());
    if (power.kind === 'unavailable' || !power.onBattery) {
      return { kind: 'allowed' };
    }
    if (!this.background.AllowOnBattery) {
      return { kind: 'blocked', reason: 'on_battery' };
    }
    if (power.batteryPercent < this.background.MinimumBatteryPercent) {
      return { kind: 'blocked', reason: 'battery_below_minimum' };
    }
    return { kind: 'allowed' };
  }

  canStartModelWork(): ResourceDecision {
    const background = this.canStartBackgroundWork();
    if (background.kind === 'blocked') {
      return background;
    }
    const limitMs = this.background.MaxGpuMinutesPerDay * 60_000;
    return this.readTodayGpuMilliseconds() >= limitMs
      ? { kind: 'blocked', reason: 'daily_gpu_limit' }
      : { kind: 'allowed' };
  }

  recordGpuUse(startedAtMs: number, finishedAtMs: number): void {
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs) || finishedAtMs < startedAtMs) {
      throw new Error('GPU use requires finite timestamps with finishedAtMs at or after startedAtMs.');
    }
    const localDate = this.localDate(this.options.clock.nowEpochMs());
    const milliseconds = this.readTodayGpuMilliseconds() + Math.round(finishedAtMs - startedAtMs);
    this.options.database.prepare(`
      INSERT INTO runtime_metadata (key, value, updated_at_utc)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc
    `).run(
      GPU_USAGE_METADATA_KEY,
      JSON.stringify({ localDate, milliseconds }),
      this.options.clock.nowUtc(),
    );
  }

  private readTodayGpuMilliseconds(): number {
    const row = this.options.database.prepare(
      'SELECT value FROM runtime_metadata WHERE key = ?',
    ).get(GPU_USAGE_METADATA_KEY);
    if (row === undefined || row === null) {
      return 0;
    }
    const parsedRow = z.object({ value: z.string() }).parse(row);
    const usage = parseJsonText(parsedRow.value, GpuUsageSchema);
    return usage.localDate === this.localDate(this.options.clock.nowEpochMs())
      ? usage.milliseconds
      : 0;
  }

  private localDate(epochMs: number): string {
    const date = new Date(epochMs);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((part) => String(part).padStart(2, '0'))
      .join('-');
  }
}
