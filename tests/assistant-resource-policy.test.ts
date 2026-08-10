import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_ASSISTANT_CONFIG } from '../src/config/defaults.js';
import {
  AssistantResourcePolicy,
  PowerStateSchema,
  type PowerState,
  type PowerStateProvider,
} from '../src/assistant/jobs/resource-policy.js';
import { withAssistantContext } from './helpers/assistant-fixture.js';

class FixedPowerStateProvider implements PowerStateProvider {
  constructor(private state: PowerState) {}

  read(): PowerState {
    return this.state;
  }

  set(state: PowerState): void {
    this.state = state;
  }
}

test('power state is validated and unavailable state preserves Gate B behavior', () => {
  assert.deepEqual(PowerStateSchema.parse({ kind: 'unavailable' }), { kind: 'unavailable' });
  assert.equal(PowerStateSchema.safeParse({ kind: 'available', onBattery: true, batteryPercent: 101 }).success, false);
  withAssistantContext(({ database, clock }) => {
    const policy = new AssistantResourcePolicy({
      database,
      clock,
      background: DEFAULT_ASSISTANT_CONFIG.Background,
      power: new FixedPowerStateProvider({ kind: 'unavailable' }),
    });
    assert.deepEqual(policy.canStartBackgroundWork(), { kind: 'allowed' });
  });
});

test('available battery state enforces AllowOnBattery and MinimumBatteryPercent', () => {
  withAssistantContext(({ database, clock }) => {
    const power = new FixedPowerStateProvider({ kind: 'available', onBattery: true, batteryPercent: 80 });
    const policy = new AssistantResourcePolicy({
      database,
      clock,
      background: DEFAULT_ASSISTANT_CONFIG.Background,
      power,
    });
    assert.deepEqual(policy.canStartBackgroundWork(), { kind: 'blocked', reason: 'on_battery' });

    const allowedOnBattery = new AssistantResourcePolicy({
      database,
      clock,
      background: { ...DEFAULT_ASSISTANT_CONFIG.Background, AllowOnBattery: true },
      power,
    });
    assert.deepEqual(allowedOnBattery.canStartBackgroundWork(), { kind: 'allowed' });
    power.set({ kind: 'available', onBattery: true, batteryPercent: 49 });
    assert.deepEqual(allowedOnBattery.canStartBackgroundWork(), {
      kind: 'blocked', reason: 'battery_below_minimum',
    });
  });
});

test('daily GPU use persists, blocks only model work, and resets on the next local date', () => {
  withAssistantContext(({ database, clock }) => {
    const options = {
      database,
      clock,
      background: { ...DEFAULT_ASSISTANT_CONFIG.Background, MaxGpuMinutesPerDay: 1 },
      power: new FixedPowerStateProvider({ kind: 'unavailable' }),
    };
    const policy = new AssistantResourcePolicy(options);
    policy.recordGpuUse(clock.nowEpochMs(), clock.nowEpochMs() + 60_000);
    const restarted = new AssistantResourcePolicy(options);
    assert.deepEqual(restarted.canStartBackgroundWork(), { kind: 'allowed' });
    assert.deepEqual(restarted.canStartModelWork(), { kind: 'blocked', reason: 'daily_gpu_limit' });

    clock.advanceSeconds(86_400);
    assert.deepEqual(restarted.canStartModelWork(), { kind: 'allowed' });
  });
});
