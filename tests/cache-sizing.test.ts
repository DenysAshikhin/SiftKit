import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCacheTierSizes } from '../src/inference-presets/cache-sizing.ts';
import { FLASH_NEXT_GEOMETRY } from '../dashboard/tests/fixtures.ts';

const base = { NumCtx: 200_000, CacheContexts: 1.5, KvCacheQuantization: 'f16', SpeculativeEnabled: true } as const;

test('Flash-Next sizes both RAM tiers from its geometry, its cache modes, and its draft cache', () => {
  assert.deepEqual(resolveCacheTierSizes(base, FLASH_NEXT_GEOMETRY), { cacheRamMiB: 7618, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes({ ...base, SpeculativeEnabled: false }, FLASH_NEXT_GEOMETRY), { cacheRamMiB: 7032, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes({ ...base, KvCacheQuantization: 'q8_0/q4_0' }, FLASH_NEXT_GEOMETRY), { cacheRamMiB: 3168, recurrentRamMiB: 8352 });
  assert.deepEqual(resolveCacheTierSizes({ ...base, CacheContexts: 2.2 }, FLASH_NEXT_GEOMETRY), { cacheRamMiB: 11_172, recurrentRamMiB: 12_215 });
});

test('a model without linear attention needs no recurrent RAM and sizes round up to a whole MiB', () => {
  const dense = { attentionLayers: 2, kvTokenDim: 64, mtpLayers: 0, recurrentSnapshotBytes: 0 };
  assert.deepEqual(resolveCacheTierSizes({ ...base, NumCtx: 1000, CacheContexts: 1.1 }, dense), { cacheRamMiB: 1, recurrentRamMiB: 0 });
});

test('sizing yields why it cannot size: an unknown geometry, or a speculative preset without a draft cache mode', () => {
  assert.equal(resolveCacheTierSizes(base, 'MLA attention (kv_lora_rank) is not modelled'), 'MLA attention (kv_lora_rank) is not modelled');
  assert.equal(resolveCacheTierSizes({ ...base, KvCacheQuantization: 'q5_0' }, FLASH_NEXT_GEOMETRY),
    'KvCacheQuantization q5_0 has no draft cache mode for speculative decoding');
  assert.deepEqual(resolveCacheTierSizes({ ...base, KvCacheQuantization: 'q5_0', SpeculativeEnabled: false }, FLASH_NEXT_GEOMETRY),
    { cacheRamMiB: 2417, recurrentRamMiB: 8352 });
});
