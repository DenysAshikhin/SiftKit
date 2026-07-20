import type { InferenceBackendId } from '../config/types.js';

const llamaCompatibility = {
  repetitionPenaltyKey: 'repeat_penalty',
  removedFields: ['repetition_penalty'],
  reasoningContent: true,
} as const;

const exl3Compatibility = {
  repetitionPenaltyKey: 'repetition_penalty',
  removedFields: ['repeat_penalty', 'cache_prompt', 'id_slot', 'timings_per_token'],
  reasoningContent: false,
} as const;

export type InferenceRequestCompatibility = typeof llamaCompatibility | typeof exl3Compatibility;

export function getInferenceRequestCompatibility(
  backend: InferenceBackendId,
): InferenceRequestCompatibility {
  return backend === 'llama' ? llamaCompatibility : exl3Compatibility;
}
