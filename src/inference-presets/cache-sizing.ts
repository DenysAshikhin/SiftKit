import type { CacheGeometry, ModelRuntimePreset } from '@siftkit/contracts';
import { getExl3CacheModes, type Exl3KvLayout } from './preset-compatibility.ts';

const MIB = 1024 * 1024;
/** exllamav3's default recurrent checkpoint spacing; architectures with wider spacing are over-provisioned. */
const RECURRENT_CHECKPOINT_TOKENS = 2048;

export type CacheTierSizes = { cacheRamMiB: number; recurrentRamMiB: number };
type SizingPreset = Pick<ModelRuntimePreset, 'NumCtx' | 'CacheContexts' | 'KvCacheQuantization' | 'SpeculativeEnabled'>;

/** Bytes of one token in one attention layer; quantized pages add one fp16 scale per 32 values of K and of V. */
function kvBytesPerLayerToken(layout: Exl3KvLayout, kvTokenDim: number): number {
  return layout.bits === null ? 4 * kvTokenDim : (kvTokenDim * (layout.bits[0] + layout.bits[1])) / 8 + kvTokenDim / 8;
}

/**
 * RAM-tier sizes holding CacheContexts full contexts: KV pages of the target and draft caches, and
 * recurrent snapshots. Yields why instead when the geometry is unknown or the draft cache has no mode.
 */
export function resolveCacheTierSizes(preset: SizingPreset, geometry: CacheGeometry | string): CacheTierSizes | string {
  if (typeof geometry === 'string') return geometry;
  const modes = getExl3CacheModes(preset.KvCacheQuantization);
  let draftBytes = 0;
  if (preset.SpeculativeEnabled) {
    if (modes.draft === null) return `KvCacheQuantization ${preset.KvCacheQuantization} has no draft cache mode for speculative decoding`;
    draftBytes = geometry.mtpLayers * kvBytesPerLayerToken(modes.draft, geometry.kvTokenDim);
  }
  const tokenBytes = geometry.attentionLayers * kvBytesPerLayerToken(modes.cache, geometry.kvTokenDim) + draftBytes;
  const tokens = preset.CacheContexts * preset.NumCtx;
  const snapshots = Math.ceil(tokens / RECURRENT_CHECKPOINT_TOKENS);
  return {
    cacheRamMiB: Math.ceil((tokens * tokenBytes) / MIB),
    recurrentRamMiB: Math.ceil((snapshots * geometry.recurrentSnapshotBytes) / MIB),
  };
}
