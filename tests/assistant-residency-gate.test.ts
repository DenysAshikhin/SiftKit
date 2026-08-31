import test from 'node:test';
import assert from 'node:assert/strict';

import type { InferenceModelState, InferenceRuntimeStatus } from '@siftkit/contracts';
import { StatusServerResidencyGate } from '../src/status-server/assistant-residency-gate.js';

function statusWith(modelState: InferenceModelState): InferenceRuntimeStatus {
  return {
    activePresetId: 'preset_a',
    activePresetLabel: 'Preset A',
    backend: 'exl3',
    idleAction: 'freeze',
    freezeSupported: true,
    processState: 'ready',
    modelState,
    model: 'model-a',
    idleDeadlineUtc: null,
    errorPhase: null,
    error: null,
    rollback: null,
  };
}

test('only a ready model counts as resident', () => {
  const notResident: readonly InferenceModelState[] = [
    'unloaded', 'loading', 'unloading', 'freezing', 'frozen', 'failed',
  ];
  for (const state of notResident) {
    const gate = new StatusServerResidencyGate({ getStatus: () => statusWith(state) });
    assert.equal(gate.isModelResident(), false, state);
  }
  const ready = new StatusServerResidencyGate({ getStatus: () => statusWith('ready') });
  assert.equal(ready.isModelResident(), true);
});

test('an unmanaged runtime is never gated', () => {
  assert.equal(new StatusServerResidencyGate(null).isModelResident(), true);
});
