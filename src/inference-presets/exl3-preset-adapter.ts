import { win32 } from 'node:path';
import { z } from 'zod';
import type { ModelRuntimePreset } from '@siftkit/contracts';
import {
  buildPresetRequestDefaults,
  getExl3CacheModes,
  type Exl3CacheModes,
  type PresetRequestDefaults,
} from './preset-compatibility.js';

export const Exl3LoadRequestSchema = z.object({
  model_name: z.string(),
  max_seq_len: z.number(),
  cache_size: z.number(),
  cache_mode: z.string(),
  chunk_size: z.number(),
});
export type Exl3LoadRequest = z.infer<typeof Exl3LoadRequestSchema>;

export const Exl3LaunchEnvironmentSchema = z.object({
  TABBY_MODEL_MODEL_DIR: z.string(),
  TABBY_MODEL_MODEL_NAME: z.string(),
  TABBY_MODEL_MAX_SEQ_LEN: z.string(),
  TABBY_MODEL_CACHE_SIZE: z.string(),
  TABBY_MODEL_CACHE_MODE: z.string(),
  TABBY_MODEL_MAX_BATCH_SIZE: z.string(),
  TABBY_MODEL_CHUNK_SIZE: z.string(),
  TABBY_DRAFT_MODEL_DRAFT_MODE: z.enum(['disabled', 'mtp']),
  TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: z.string(),
  /** Omitted when speculation is off: the preset owns no draft cache, so config.yml keeps its value. */
  TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: z.string().optional(),
  /**
   * exllamav3 defaults to quant-direct attention kernels for quantized caches; the
   * dequantize-then-attend path is ~7% faster at prefill and decode-neutral for ~240 MiB
   * extra peak VRAM. See docs/exl3-performance-tuning-2026-07-21.md.
   */
  EXL3_QC_ATTN: z.literal('0'),
});
export type Exl3LaunchEnvironment = z.infer<typeof Exl3LaunchEnvironmentSchema>;

export class Exl3PresetAdapter {
  constructor(private readonly modelRoot: string) {}

  validatePreset(preset: ModelRuntimePreset): void {
    if (preset.Backend !== 'exl3') {
      throw new Error(`preset=${preset.id} backend=${preset.Backend} cannot use the EXL3 adapter`);
    }
    this.getRelativeModelPath(preset);
    this.getCacheModes(preset);
  }

  buildLoadRequest(preset: ModelRuntimePreset): Exl3LoadRequest {
    this.validatePreset(preset);
    return {
      model_name: this.getRelativeModelPath(preset).replaceAll('\\', '/'),
      max_seq_len: preset.NumCtx,
      cache_size: Math.ceil(preset.NumCtx / 256) * 256,
      cache_mode: this.getCacheModes(preset).cache,
      chunk_size: preset.UBatchSize,
    };
  }

  buildLaunchEnvironment(preset: ModelRuntimePreset): Exl3LaunchEnvironment {
    const request = this.buildLoadRequest(preset);
    if (preset.SpeculativeEnabled && preset.SpeculativeType !== 'draft-mtp') {
      throw new Error(
        `preset=${preset.id} backend=exl3 SpeculativeType=${preset.SpeculativeType} must be draft-mtp`,
      );
    }
    const draftCacheMode = preset.SpeculativeEnabled ? this.getCacheModes(preset).draft : null;
    return Exl3LaunchEnvironmentSchema.parse({
      TABBY_MODEL_MODEL_DIR: win32.resolve(this.modelRoot),
      TABBY_MODEL_MODEL_NAME: request.model_name,
      TABBY_MODEL_MAX_SEQ_LEN: String(request.max_seq_len),
      TABBY_MODEL_CACHE_SIZE: String(request.cache_size),
      TABBY_MODEL_CACHE_MODE: request.cache_mode,
      TABBY_MODEL_MAX_BATCH_SIZE: String(preset.ParallelSlots),
      TABBY_MODEL_CHUNK_SIZE: String(request.chunk_size),
      TABBY_DRAFT_MODEL_DRAFT_MODE: preset.SpeculativeEnabled ? 'mtp' : 'disabled',
      TABBY_DRAFT_MODEL_DRAFT_NUM_TOKENS: String(preset.SpeculativeDraftMax),
      ...(draftCacheMode === null ? {} : { TABBY_DRAFT_MODEL_DRAFT_CACHE_MODE: draftCacheMode }),
      EXL3_QC_ATTN: '0',
    });
  }

  buildRequestDefaults(preset: ModelRuntimePreset): PresetRequestDefaults {
    this.validatePreset(preset);
    return buildPresetRequestDefaults(preset);
  }

  private getRelativeModelPath(preset: ModelRuntimePreset): string {
    if (preset.ModelPath === null || preset.ModelPath.trim() === '') {
      throw new Error(`preset=${preset.id} backend=exl3 ModelPath is required`);
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
    if (cacheModes === null) {
      throw new Error(
        `preset=${preset.id} backend=exl3 KvCacheQuantization=${preset.KvCacheQuantization} is not supported`,
      );
    }
    if (preset.SpeculativeEnabled && cacheModes.draft === null) {
      throw new Error(
        `preset=${preset.id} backend=exl3 KvCacheQuantization=${preset.KvCacheQuantization} has no EXL3 draft cache mode`,
      );
    }
    return cacheModes;
  }
}
