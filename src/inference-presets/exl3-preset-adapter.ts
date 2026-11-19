import { win32 } from 'node:path';
import { z } from 'zod';
import type { ModelRuntimePreset } from '@siftkit/contracts';
import {
  buildPresetRequestDefaults,
  getExl3CacheModes,
  type Exl3CacheModes,
  type PresetRequestDefaults,
} from './preset-compatibility.ts';
import { inspectModelDirectory, readModelCacheGeometry, readTemplateThinking } from './model-profile-inspector.ts';
import { MIB_PER_GIB, RAM_DISK_STAGING_CONTEXTS, resolveCacheTierSizes, type CacheTierSizes } from './cache-sizing.ts';

/** A profile with no ModelPath declares no loading identity, e.g. a model already served externally. */
export class MissingModelPathError extends Error {
  constructor(presetId: string) {
    super(`preset=${presetId} backend=exl3 ModelPath is required`);
    this.name = 'MissingModelPathError';
  }
}

export const Exl3LoadRequestSchema = z.object({
  model_name: z.string(),
  max_seq_len: z.number(),
  cache_size: z.number(),
  cache_mode: z.string(),
  chunk_size: z.number(),
});
export type Exl3LoadRequest = z.infer<typeof Exl3LoadRequestSchema>;

/** TabbyAPI parses its numeric env overrides as plain integers, so a fraction or blank must not launch. */
const NonNegativeIntegerEnv = z.string().regex(/^\d+$/u);

const Exl3BaseLaunchEnvironmentSchema = z.object({
  TABBY_MODEL_MODEL_DIR: z.string(),
  TABBY_MODEL_MODEL_NAME: z.string(),
  TABBY_MODEL_MAX_SEQ_LEN: NonNegativeIntegerEnv,
  TABBY_MODEL_CACHE_SIZE: NonNegativeIntegerEnv,
  TABBY_MODEL_CACHE_MODE: z.string(),
  TABBY_MODEL_MAX_BATCH_SIZE: NonNegativeIntegerEnv,
  TABBY_MODEL_CHUNK_SIZE: NonNegativeIntegerEnv,
  /** MB of pinned host RAM for exllamav3's second-tier K/V cache; '0' disables. */
  TABBY_MEMORY_SYSMEM_KV_CACHE: NonNegativeIntegerEnv,
  /** MB of host RAM for recurrent (linear-attention) states; one state per concurrent slot. */
  TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: NonNegativeIntegerEnv,
  TABBY_DRAFT_MODEL_DRAFT_MODE: z.enum(['disabled', 'mtp']),
  TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: NonNegativeIntegerEnv,
  /** Omitted when speculation is off: the preset owns no draft cache, so config.yml keeps its value. */
  TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: z.string().optional(),
  /** Per-job draft windows adapted from the acceptance EMA, capped by DRAFT_NUM_TOKENS. */
  TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: z.enum(['true', 'false']),
  /** Prompt-lookup draft length; Tabby applies it with or without a draft mode, '0' disables. */
  TABBY_DRAFT_MODEL_HYBRID_DRAFT_TOKENS: NonNegativeIntegerEnv,
  /** Omitted when speculation is off: Tabby ignores a sparse head without a drafter. '0' keeps the full head. */
  TABBY_DRAFT_MODEL_SPARSE_DRAFT_HEAD: NonNegativeIntegerEnv.optional(),
  TABBY_MODEL_VISION: z.enum(['true', 'false']),
  /** Pins the vision tower in host RAM and streams it per request; Tabby ignores it while vision is off. */
  TABBY_MODEL_VISION_OFFLOAD: z.enum(['true', 'false']),
  /**
   * `NcpuMoe` as exllamav3's per-layer expert split: the coldest N routed experts of every
   * eligible MoE layer live in host RAM and run on the CPU worker, overlapping that layer's own
   * GPU expert compute. Higher frees more VRAM. `0` leaves every expert on the GPU. Non-MoE
   * models and layers that fail exllamav3's eligibility probes ignore it.
   */
  TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: NonNegativeIntegerEnv,
  /** `NgramRam`; the tradeoff is stated once in the dashboard help text for the field. */
  TABBY_MODEL_NGRAM_RAM: z.enum(['true', 'false']),
  /**
   * Expandable segments, pinned before the child imports Torch. Both allocator names carry
   * the same value on purpose: Torch reads `PYTORCH_ALLOC_CONF` and falls back to the older
   * `PYTORCH_CUDA_ALLOC_CONF`, while exllamav3 inspects the latter to decide whether the host
   * already configured the allocator. exllamav3's own default returns early on win32, so this
   * is what enables expandable segments here.
   */
  PYTORCH_ALLOC_CONF: z.literal('backend:native,expandable_segments:True'),
  PYTORCH_CUDA_ALLOC_CONF: z.literal('backend:native,expandable_segments:True'),
  /** cudaMallocAsync cannot use expandable segments, so Tabby must not install it. */
  TABBY_MEMORY_CUDA_MALLOC_ASYNC: z.literal('false'),
  /** UTF-8 stdio: on a cp1252 pipe, rich's box-drawn tracebacks fail to encode and loguru drops the record. */
  PYTHONUTF8: z.literal('1'),
  /** Unwrapped engine log lines, so stored logs and the recorder see whole records and exception lines. */
  TABBY_LOG_CONSOLE_WIDTH: z.literal('4096'),
});

// The disk tier is all three variables or none; a partial set must not parse.
const Exl3DiskCacheEnvironment = {
  /** Disk tier behind the RAM tier; omitted unless the preset sets DiskCacheDir. Size is in MiB. */
  TABBY_MEMORY_DISK_CACHE_DIR: z.string(), TABBY_MEMORY_DISK_CACHE_SIZE: NonNegativeIntegerEnv,
  TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: NonNegativeIntegerEnv,
};
const Exl3NoDiskCacheEnvironment = {
  TABBY_MEMORY_DISK_CACHE_DIR: z.undefined().optional(), TABBY_MEMORY_DISK_CACHE_SIZE: z.undefined().optional(),
  TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: z.undefined().optional(),
};

export const Exl3LaunchEnvironmentSchema = z.union([
  Exl3BaseLaunchEnvironmentSchema.extend(Exl3DiskCacheEnvironment),
  Exl3BaseLaunchEnvironmentSchema.extend(Exl3NoDiskCacheEnvironment),
]);
export type Exl3LaunchEnvironment = z.infer<typeof Exl3LaunchEnvironmentSchema>;

/** TabbyAPI reads its env overrides as text, so every boolean setting ships as this exact pair. */
function envFlag(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}

export class Exl3PresetAdapter {
  private readonly modelRoot: string;

  constructor(modelRoot: string) {
    this.modelRoot = modelRoot;
  }

  validatePreset(preset: ModelRuntimePreset): void {
    if (preset.Backend !== 'exl3') {
      throw new Error(`preset=${preset.id} backend=${preset.Backend} cannot use the EXL3 adapter`);
    }
    const relativeModelPath = this.getRelativeModelPath(preset);
    this.getCacheModes(preset);
    if (preset.NcpuMoe < 0) {
      throw new Error(`preset=${preset.id} backend=exl3 NcpuMoe=${preset.NcpuMoe} must not be negative`);
    }
    if (preset.VisionOffload && !preset.VisionEnabled) {
      throw new Error(`preset=${preset.id} backend=exl3 VisionOffload=true requires VisionEnabled=true`);
    }
    if (preset.VisionEnabled) {
      const modelDirectory = win32.resolve(this.modelRoot, relativeModelPath);
      if (!inspectModelDirectory(modelDirectory).vision) {
        throw new Error(
          `preset=${preset.id} backend=exl3 VisionEnabled=true but ${modelDirectory} has no vision_config`,
        );
      }
    }
  }

  /** Launch-time check: thinking settings the chat template ignores would silently not apply. */
  validateTemplateThinking(preset: ModelRuntimePreset): void {
    if (preset.UnlockAllSettings) return;
    const modelDirectory = win32.resolve(this.modelRoot, this.getRelativeModelPath(preset));
    const { reasoningEfforts: efforts, thinkingToggle } = readTemplateThinking(modelDirectory);
    if (preset.Reasoning === 'off' && !thinkingToggle) {
      throw new Error(
        `preset=${preset.id} backend=exl3 Reasoning=off but ${modelDirectory} chat template ignores enable_thinking, `
        + 'so the model always thinks; set Reasoning=on or UnlockAllSettings',
      );
    }
    if (preset.Reasoning === 'on' && efforts.length > 0 && !efforts.includes(preset.ReasoningEffort)) {
      throw new Error(
        `preset=${preset.id} backend=exl3 ReasoningEffort=${preset.ReasoningEffort} is not distinguished by `
        + `${modelDirectory} chat template; use ${efforts.join(', ')} or UnlockAllSettings`,
      );
    }
  }

  buildLoadRequest(preset: ModelRuntimePreset): Exl3LoadRequest {
    this.validatePreset(preset);
    return {
      model_name: this.getRelativeModelPath(preset).replaceAll('\\', '/'),
      max_seq_len: preset.NumCtx,
      cache_size: Math.ceil(preset.NumCtx / 256) * 256,
      cache_mode: this.getCacheModes(preset).cache.mode,
      chunk_size: preset.UBatchSize,
    };
  }

  buildLaunchEnvironment(preset: ModelRuntimePreset, ramDiskLetter: string): Exl3LaunchEnvironment {
    const request = this.buildLoadRequest(preset);
    const draftCacheMode = preset.SpeculativeEnabled ? this.getCacheModes(preset).draft?.mode ?? null : null;
    const cacheSizes = this.getCacheTierSizes(preset);
    return Exl3LaunchEnvironmentSchema.parse({
      TABBY_MODEL_MODEL_DIR: win32.resolve(this.modelRoot),
      TABBY_MODEL_MODEL_NAME: request.model_name,
      TABBY_MODEL_MAX_SEQ_LEN: String(request.max_seq_len),
      TABBY_MODEL_CACHE_SIZE: String(request.cache_size),
      TABBY_MODEL_CACHE_MODE: request.cache_mode,
      // The reviewer lane serves approval verdicts beside a running agent; the scheduler never admits into it.
      TABBY_MODEL_MAX_BATCH_SIZE: String(preset.ParallelSlots + (preset.ReviewerSlot ? 1 : 0)),
      TABBY_MODEL_CHUNK_SIZE: String(request.chunk_size),
      TABBY_MEMORY_SYSMEM_KV_CACHE: String(cacheSizes.cacheRamMiB),
      TABBY_MEMORY_SYSMEM_RECURRENT_CACHE: String(cacheSizes.recurrentRamMiB),
      ...this.getDiskCacheEnvironment(preset, ramDiskLetter),
      TABBY_DRAFT_MODEL_DRAFT_MODE: preset.SpeculativeEnabled ? 'mtp' : 'disabled',
      TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: String(preset.SpeculativeDraftMax),
      ...(draftCacheMode === null ? {} : { TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: draftCacheMode }),
      TABBY_DRAFT_MODEL_DYNAMIC_DRAFT: envFlag(preset.SpeculativeEnabled && preset.SpeculativeDynamic),
      TABBY_DRAFT_MODEL_HYBRID_DRAFT_TOKENS: String(preset.HybridDraftTokens),
      ...(preset.SpeculativeEnabled ? { TABBY_DRAFT_MODEL_SPARSE_DRAFT_HEAD: String(preset.SparseDraftHead) } : {}),
      TABBY_MODEL_VISION: envFlag(preset.VisionEnabled),
      TABBY_MODEL_VISION_OFFLOAD: envFlag(preset.VisionOffload),
      TABBY_MODEL_CPU_MOE_SPLIT_EXPERTS: String(preset.NcpuMoe),
      TABBY_MODEL_NGRAM_RAM: envFlag(preset.NgramRam),
      PYTORCH_ALLOC_CONF: 'backend:native,expandable_segments:True',
      PYTORCH_CUDA_ALLOC_CONF: 'backend:native,expandable_segments:True',
      TABBY_MEMORY_CUDA_MALLOC_ASYNC: 'false',
      PYTHONUTF8: '1',
      TABBY_LOG_CONSOLE_WIDTH: '4096',
    });
  }

  buildRequestDefaults(preset: ModelRuntimePreset): PresetRequestDefaults {
    this.validatePreset(preset);
    return buildPresetRequestDefaults(preset);
  }

  /** TabbyAPI's disk tier: the preset's folder on SiftKit's RAM disk, its own DiskCacheDir, or none. */
  private getDiskCacheEnvironment(preset: ModelRuntimePreset, ramDiskLetter: string): Record<string, string> {
    // Tabby reads disk_cache_size in MB and multiplies by 1024², so MiB passes through unchanged.
    const tier = (directory: string, sizeMiB: number) => ({
      TABBY_MEMORY_DISK_CACHE_DIR: directory,
      TABBY_MEMORY_DISK_CACHE_SIZE: String(sizeMiB),
      TABBY_MEMORY_DISK_CACHE_CHECKPOINT_INTERVAL: String(preset.DiskCacheCheckpointInterval),
    });
    if (preset.RamDiskCache) return tier(win32.join(`${ramDiskLetter}:\\`, preset.id), preset.RamDiskCacheGiB * MIB_PER_GIB);
    return preset.DiskCacheDir === null ? {} : tier(win32.resolve(preset.DiskCacheDir), preset.DiskCacheSizeMiB);
  }

  /** The preset's manual RAM-tier sizes, or with CacheAuto (always, on a RAM disk) the sizes the model's geometry needs. */
  private getCacheTierSizes(preset: ModelRuntimePreset): CacheTierSizes {
    if (preset.RamDiskCache) return this.autoSizeCacheTiers({ ...preset, CacheContexts: RAM_DISK_STAGING_CONTEXTS });
    if (!preset.CacheAuto) return { cacheRamMiB: preset.CacheRam, recurrentRamMiB: preset.CacheRecurrentRam };
    return this.autoSizeCacheTiers(preset);
  }

  private autoSizeCacheTiers(preset: ModelRuntimePreset): CacheTierSizes {
    const modelDirectory = win32.resolve(this.modelRoot, this.getRelativeModelPath(preset));
    const sizes = resolveCacheTierSizes(preset, readModelCacheGeometry(modelDirectory));
    if (typeof sizes === 'string') throw new Error(`preset=${preset.id} backend=exl3 CacheAuto cannot size ${modelDirectory}: ${sizes}`);
    return sizes;
  }

  private getRelativeModelPath(preset: ModelRuntimePreset): string {
    if (preset.ModelPath === null || preset.ModelPath.trim() === '') {
      throw new MissingModelPathError(preset.id);
    }
    const relativePath = win32.relative(win32.resolve(this.modelRoot), win32.resolve(preset.ModelPath));
    if (
      relativePath === ''
      || relativePath === '..'
      || relativePath.startsWith(`..${win32.sep}`)
      || win32.isAbsolute(relativePath)
    ) {
      throw new Error(`preset=${preset.id} backend=exl3 ModelPath must be inside ModelRoot`);
    }
    return relativePath;
  }

  private getCacheModes(preset: ModelRuntimePreset): Exl3CacheModes {
    const cacheModes = getExl3CacheModes(preset.KvCacheQuantization);
    if (preset.SpeculativeEnabled && cacheModes.draft === null) {
      throw new Error(
        `preset=${preset.id} backend=exl3 KvCacheQuantization=${preset.KvCacheQuantization} has no EXL3 draft cache mode`,
      );
    }
    return cacheModes;
  }
}
