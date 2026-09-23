import { z } from './zod.js';

/** The model an operation asks for; null fields inherit the operation preset or the applied model. */
export const ModelRequestIntentSchema = z.object({
  presetId: z.string().trim().min(1).nullable(),
  model: z.string().trim().min(1).nullable(),
}).strict();
export type ModelRequestIntent = z.infer<typeof ModelRequestIntentSchema>;
