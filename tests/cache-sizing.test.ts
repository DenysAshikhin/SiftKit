import test from 'node:test';
import assert from 'node:assert/strict';

import { requiredRamDiskBytes, resolveCacheTierSizes, resolveDiskCacheContextBytes } from '../src/inference-presets/cache-sizing.ts';
import { FLASH_NEXT_GEOMETRY, QWEN_27B_GEOMETRY } from '../dashboard/tests/fixtures.ts';

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


test('one full context on disk: KV pages for the whole context plus a snapshot every checkpoint interval', () => {
  assert.deepEqual(resolveDiskCacheContextBytes({ NumCtx: 200_000, KvCacheQuantization: 'f16', SpeculativeEnabled: true,
    DiskCacheCheckpointInterval: 2048 }, FLASH_NEXT_GEOMETRY), { kvBytes: 5_324_800_000, snapshotBytes: 5_838_077_952 });
  assert.deepEqual(resolveDiskCacheContextBytes({ NumCtx: 180_224, KvCacheQuantization: 'q8_0', SpeculativeEnabled: true,
    DiskCacheCheckpointInterval: 4096 }, QWEN_27B_GEOMETRY), { kvBytes: 6_666_846_208, snapshotBytes: 3_494_903_808 });
  assert.equal(resolveDiskCacheContextBytes({ NumCtx: 1000, KvCacheQuantization: 'f16', SpeculativeEnabled: false,
    DiskCacheCheckpointInterval: 2048 }, 'config.json has no head_dim'), 'config.json has no head_dim');
});

test('the RAM disk holds every RAM-disk budget, 1 GiB of overhead, and the 2% free-space floor, in whole MiB', () => {
  assert.equal(requiredRamDiskBytes([11, 11]), 25_200_427_008);
  assert.equal(requiredRamDiskBytes([10]), 12_052_332_544);
});
