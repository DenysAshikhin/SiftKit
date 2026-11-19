import type { CacheGeometry, ModelRuntimePreset } from '@siftkit/contracts';
import { getExl3CacheModes, type Exl3KvLayout } from './preset-compatibility.ts';

const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
export const MIB_PER_GIB = GIB / MIB;
/** exllamav3's default recurrent checkpoint spacing; architectures with wider spacing are over-provisioned. */
const RECURRENT_CHECKPOINT_TOKENS = 2048;
/** Full contexts the RAM tiers stage while the RAM disk holds the cache; the disk tier needs a RAM tier above 0. */
export const RAM_DISK_STAGING_CONTEXTS = 0.2;
/** NTFS metadata and exllamav3's per-model cache indexes on the RAM disk. */
const RAM_DISK_OVERHEAD_GIB = 1;
/** exllamav3 starts no disk write once free space falls below 2% of the file system. */
const RAM_DISK_FREE_FLOOR = 0.02;

export type CacheTierSizes = { cacheRamMiB: number; recurrentRamMiB: number };
export type DiskCacheContextBytes = { kvBytes: number; snapshotBytes: number };
type KvSizingPreset = Pick<ModelRuntimePreset, 'NumCtx' | 'KvCacheQuantization' | 'SpeculativeEnabled'>;
type SizingPreset = KvSizingPreset & Pick<ModelRuntimePreset, 'CacheContexts'>;
type DiskSizingPreset = KvSizingPreset & Pick<ModelRuntimePreset, 'DiskCacheCheckpointInterval'>;

/** Bytes of one token in one attention layer; quantized pages add one fp16 scale per 32 values of K and of V. */
function kvBytesPerLayerToken(layout: Exl3KvLayout, kvTokenDim: number): number {
  return layout.bits === null ? 4 * kvTokenDim : (kvTokenDim * (layout.bits[0] + layout.bits[1])) / 8 + kvTokenDim / 8;
}

/** KV bytes of one token across the target and draft caches, or why it cannot be known. */
function kvTokenBytes(preset: KvSizingPreset, geometry: CacheGeometry): number | string {
  const modes = getExl3CacheModes(preset.KvCacheQuantization);
  let draftBytes = 0;
  if (preset.SpeculativeEnabled) {
    if (modes.draft === null) return `KvCacheQuantization ${preset.KvCacheQuantization} has no draft cache mode for speculative decoding`;
    draftBytes = geometry.mtpLayers * kvBytesPerLayerToken(modes.draft, geometry.kvTokenDim);
  }
  return geometry.attentionLayers * kvBytesPerLayerToken(modes.cache, geometry.kvTokenDim) + draftBytes;
}

/**
 * RAM-tier sizes holding CacheContexts full contexts: KV pages of the target and draft caches, and
 * recurrent snapshots. Yields why instead when the geometry is unknown or the draft cache has no mode.
 */
export function resolveCacheTierSizes(preset: SizingPreset, geometry: CacheGeometry | string): CacheTierSizes | string {
  if (typeof geometry === 'string') return geometry;
  const tokenBytes = kvTokenBytes(preset, geometry);
  if (typeof tokenBytes === 'string') return tokenBytes;
  const tokens = preset.CacheContexts * preset.NumCtx;
  const snapshots = Math.ceil(tokens / RECURRENT_CHECKPOINT_TOKENS);
  return {
    cacheRamMiB: Math.ceil((tokens * tokenBytes) / MIB),
    recurrentRamMiB: Math.ceil((snapshots * geometry.recurrentSnapshotBytes) / MIB),
  };
}

/** One full NumCtx context in the disk tier: its KV pages, and a recurrent snapshot every DiskCacheCheckpointInterval tokens. */
export function resolveDiskCacheContextBytes(preset: DiskSizingPreset, geometry: CacheGeometry | string): DiskCacheContextBytes | string {
  if (typeof geometry === 'string') return geometry;
  const tokenBytes = kvTokenBytes(preset, geometry);
  if (typeof tokenBytes === 'string') return tokenBytes;
  return {
    kvBytes: preset.NumCtx * tokenBytes,
    snapshotBytes: Math.ceil(preset.NumCtx / preset.DiskCacheCheckpointInterval) * geometry.recurrentSnapshotBytes,
  };
}

/** The RAM disk size for these per-preset budgets (GiB), rounded up to a whole MiB. */
export function requiredRamDiskBytes(budgetsGiB: readonly number[]): number {
  const payload = (budgetsGiB.reduce((sum, budget) => sum + budget, 0) + RAM_DISK_OVERHEAD_GIB) * GIB;
  return Math.ceil(payload / (1 - RAM_DISK_FREE_FLOOR) / MIB) * MIB;
}
