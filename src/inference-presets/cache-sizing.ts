import type { CacheGeometry, ModelProfile, ModelRuntimePreset } from '@siftkit/contracts';
import { getExl3CacheModes } from './preset-compatibility.ts';

const MIB = 1024 * 1024;
/** exllamav3's default recurrent checkpoint spacing; architectures with wider spacing are over-provisioned. */
const RECURRENT_CHECKPOINT_TOKENS = 2048;

export type CacheTierSizes = { cacheRamMiB: number; recurrentRamMiB: number };
type SizingPreset = Pick<ModelRuntimePreset, 'NumCtx' | 'CacheContexts' | 'KvCacheQuantization' | 'SpeculativeEnabled'>;

function kvBits(mode: string): readonly [number, number] | null {
  if (mode === 'FP16') return null;
  if (mode === 'Q8') return [8, 8];
  if (mode === 'Q4') return [4, 4];
  const match = /^(\d+),(\d+)$/u.exec(mode);
  if (match === null) throw new Error(`Unknown exllamav3 cache mode '${mode}'`);
  return [Number(match[1]), Number(match[2])];
}

/** Bytes of one token in one attention layer; quantized pages add one fp16 scale per 32 values of K and of V. */
function kvBytesPerLayerToken(mode: string, kvTokenDim: number): number {
  const bits = kvBits(mode);
  return bits === null ? 4 * kvTokenDim : (kvTokenDim * (bits[0] + bits[1])) / 8 + kvTokenDim / 8;
}

/** RAM-tier sizes holding CacheContexts full contexts: KV pages of target and draft caches, and recurrent snapshots. */
export function resolveCacheTierSizes(geometry: CacheGeometry, preset: SizingPreset): CacheTierSizes {
  const modes = getExl3CacheModes(preset.KvCacheQuantization);
  const draftBytes = preset.SpeculativeEnabled && modes.draft !== null
    ? geometry.mtpLayers * kvBytesPerLayerToken(modes.draft, geometry.kvTokenDim) : 0;
  const tokenBytes = geometry.attentionLayers * kvBytesPerLayerToken(modes.cache, geometry.kvTokenDim) + draftBytes;
  const tokens = preset.CacheContexts * preset.NumCtx;
  const snapshots = Math.ceil(tokens / RECURRENT_CHECKPOINT_TOKENS);
  return {
    cacheRamMiB: Math.ceil((tokens * tokenBytes) / MIB),
    recurrentRamMiB: Math.ceil((snapshots * geometry.recurrentSnapshotBytes) / MIB),
  };
}

/** The sizes for a profiled model, or why they cannot be computed. */
export function resolveProfileCacheSizes(preset: SizingPreset, profile: ModelProfile | null): CacheTierSizes | string {
  if (profile === null) return 'the model has not been profiled';
  return typeof profile.cacheGeometry === 'string' ? profile.cacheGeometry : resolveCacheTierSizes(profile.cacheGeometry, preset);
}
