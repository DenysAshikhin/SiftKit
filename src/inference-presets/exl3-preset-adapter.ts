import { win32 } from 'node:path';
import { z } from 'zod';
import type { ModelRuntimePreset } from '@siftkit/contracts';
import {
  buildPresetRequestDefaults,
  getExl3CacheMode,
  type PresetRequestDefaults,
} from './preset-compatibility.js';

export const Exl3LoadRequestSchema = z.object({
  model_name: z.string(),
  max_seq_len: z.number(),
  cache_size: z.number(),
  cache_mode: z.string(),
});
export type Exl3LoadRequest = z.infer<typeof Exl3LoadRequestSchema>;

export class Exl3PresetAdapter {
  constructor(private readonly modelRoot: string) {}

  validatePreset(preset: ModelRuntimePreset): void {
    if (preset.Backend !== 'exl3') {
      throw new Error(`preset=${preset.id} backend=${preset.Backend} cannot use the EXL3 adapter`);
    }
    this.getRelativeModelPath(preset);
    this.getCacheMode(preset);
  }

  buildLoadRequest(preset: ModelRuntimePreset): Exl3LoadRequest {
    this.validatePreset(preset);
    return {
      model_name: this.getRelativeModelPath(preset).replaceAll('\\', '/'),
      max_seq_len: preset.NumCtx,
      cache_size: Math.ceil(preset.NumCtx / 256) * 256,
      cache_mode: this.getCacheMode(preset),
    };
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

  private getCacheMode(preset: ModelRuntimePreset): string {
    const cacheMode = getExl3CacheMode(preset.KvCacheQuantization);
    if (cacheMode === null) {
      throw new Error(
        `preset=${preset.id} backend=exl3 KvCacheQuantization=${preset.KvCacheQuantization} is not supported`,
      );
    }
    return cacheMode;
  }
}
