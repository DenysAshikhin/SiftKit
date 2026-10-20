import { z } from './zod.ts';
import { ModelPresetReferenceSchema } from '@siftkit/contracts';

/** The model an operation asks for; null fields inherit the operation preset or the applied model. */
export const ModelRequestIntentSchema = z.object({
  presetId: z.string().trim().min(1).nullable(),
  model: z.string().trim().min(1).nullable(),
  modelPresetId: ModelPresetReferenceSchema.optional(),
}).strict();
export type ModelRequestIntent = z.infer<typeof ModelRequestIntentSchema>;
