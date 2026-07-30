import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { z } from 'zod';
import { parseJsonValueText } from '../lib/json.js';

const ModelConfigSchema = z.object({
  vision_config: z.object({}).passthrough(),
});

export class Exl3ModelCapabilities {
  hasVisionTower(modelDirectory: string): boolean {
    try {
      const config = parseJsonValueText(
        readFileSync(win32.join(modelDirectory, 'config.json'), 'utf8'),
      );
      return ModelConfigSchema.safeParse(config).success;
    } catch {
      return false;
    }
  }
}
