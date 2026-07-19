import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeLaunchSnapshot } from '../src/status-server/config-store.js';
import { mockConfig } from './_runtime-helpers.js';

test('buildRuntimeLaunchSnapshot copies runtime-relevant fields from the active preset', () => {
  const config = mockConfig({
    Server: {
      ModelPresets: {
        ActivePresetId: 'p',
        Presets: [{
          id: 'p', label: 'P', Model: 'm.gguf', BaseUrl: 'http://127.0.0.1:8097',
          NumCtx: 85000, Temperature: 0.7, TopP: 0.8, TopK: 20, MinP: 0,
          PresencePenalty: 1.5, RepetitionPenalty: 1, MaxTokens: 15000,
          GpuLayers: 999, Threads: -1, NcpuMoe: 10, FlashAttention: true,
          ParallelSlots: 1, Reasoning: 'off',
        }],
      },
    },
  });
  const snapshot = buildRuntimeLaunchSnapshot(config);
  assert.equal(snapshot.Model, 'm.gguf');
  assert.equal(snapshot.LlamaCpp.NumCtx, 85000);
  assert.equal(snapshot.LlamaCpp.Reasoning, 'off');
  assert.equal(snapshot.LlamaCpp.BaseUrl, 'http://127.0.0.1:8097');
});
