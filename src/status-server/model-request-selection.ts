import { z } from '../lib/zod.js';

export const ModelRequestCandidateSchema = z.object({
  queueToken: z.string(),
  residencyKey: z.string(),
});
export type ModelRequestCandidate = z.infer<typeof ModelRequestCandidateSchema>;

/**
 * Resident-model selection for the global queue. The oldest waiting request whose loading
 * identity matches the resident model always wins, even over older other-model requests —
 * there is no fairness override. Only when nothing matches and no request is active does the
 * oldest remaining request win, starting a single transition to its target.
 */
export function selectNextModelRequest(
  candidates: readonly ModelRequestCandidate[],
  residentKey: string,
  activeCount: number,
): string | null {
  const matching = candidates.find((candidate) => candidate.residencyKey === residentKey);
  if (matching) return matching.queueToken;
  return activeCount === 0 ? candidates[0]?.queueToken ?? null : null;
}