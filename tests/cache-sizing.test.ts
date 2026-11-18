import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCacheTierSizes, resolveProfileCacheSizes } from '../src/inference-presets/cache-sizing.ts';
import { GLM_PROFILE } from '../dashboard/tests/fixtures.ts';

const FLASH_NEXT = { attentionLayers: 12, kvTokenDim: 512, mtpLayers: 1, recurrentSnapshotBytes: 59_572_224 };
const base = { NumCtx: 200_000, CacheContexts: 1.5, KvCacheQuantization: 'f16', SpeculativeEnabled: true } as const;

test('Flash-Next sizes both RAM tiers from its geometry, its cache modes, and its draft cache', () => {
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, base), { cacheRamMiB: 7618, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, { ...base, SpeculativeEnabled: false }), { cacheRamMiB: 7032, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, { ...base, KvCacheQuantization: 'q8_0/q4_0' }), { cacheRamMiB: 3168, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes(FLASH_NEXT, { ...base, CacheContexts: 2.2 }), { cacheRamMiB: 11_172, recurrentRamMiB: 12_215 });
});

test('a dense model needs no recurrent RAM and sizes round up to a whole MiB', () => {
  const dense = { attentionLayers: 2, kvTokenDim: 64, mtpLayers: 0, recurrentSnapshotBytes: 0 };
  assert.deepEqual(resolveCacheTierSizes(dense, { ...base, NumCtx: 1000, CacheContexts: 1.1 }), { cacheRamMiB: 1, recurrentRamMiB: 0 });
});

test('a profile sizes from its geometry, or yields why it cannot', () => {
  assert.equal(resolveProfileCacheSizes(base, null), 'the model has not been profiled');
  assert.equal(resolveProfileCacheSizes(base, GLM_PROFILE), 'MLA attention (kv_lora_rank) is not modelled');
  assert.deepEqual(resolveProfileCacheSizes(base, { ...GLM_PROFILE, cacheGeometry: FLASH_NEXT }), { cacheRamMiB: 7618, recurrentRamMiB: 8352 });
});
