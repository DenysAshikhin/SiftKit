import { z } from 'zod';
import { ReasoningEffortSchema } from './config.ts';

/** What a model directory's config.json, chat template, and generation_config.json declare. */
export const ModelProfileSchema = z.object({
  name: z.string(), architecture: z.string(),
  moe: z.boolean(), recurrent: z.boolean(), mtp: z.boolean(), vision: z.boolean(), ngram: z.boolean(), mla: z.boolean(),
  /** Levels the chat template distinguishes; empty when it never reads `reasoning_effort`. */
  reasoningEfforts: z.array(ReasoningEffortSchema),
  /** The template reads `enable_thinking`; otherwise it always thinks. */
  thinkingToggle: z.boolean(),
  preserveThinking: z.boolean(),
  sampling: z.object({ temperature: z.number().nullable(), topP: z.number().nullable(), topK: z.number().nullable() }).strict(),
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelProfileRequestSchema = z.object({ modelPath: z.string().trim().min(1) }).strict();
export const ModelProfileResponseSchema = z.object({ profile: ModelProfileSchema }).strict();
export type ModelProfileResponse = z.infer<typeof ModelProfileResponseSchema>;
