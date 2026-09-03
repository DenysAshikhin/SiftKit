import { z } from '../../lib/zod.js';
import { SENSITIVE_TOPICS } from '../domain/secrets.js';

/** Why a candidate is parked in `needs_confirmation`, and what answering it needs. */
export const CandidateHoldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('topic'), topic: z.enum(SENSITIVE_TOPICS) }).strict(),
  z.object({ kind: z.literal('possible_owner_alias'), name: z.string().min(1) }).strict(),
]);
export type CandidateHold = z.infer<typeof CandidateHoldSchema>;
