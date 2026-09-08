import { RepoAgentTurnsInputSchema } from '@siftkit/contracts';
import { z } from 'zod';
import type { ChatSession } from '../types';

export const PLAN_MAX_TURNS_VALIDATION_ERROR = 'Enter a whole number from 1 to 9007199254740991.';

export const PlanMaxTurnsOverrideSchema = z.string().trim().pipe(
  z.union([
    z.literal('').transform(() => ({})),
    RepoAgentTurnsInputSchema.transform((maxTurns) => ({ maxTurns })),
  ]),
);
export type ParsedMaxTurnsOverride = z.infer<typeof PlanMaxTurnsOverrideSchema>;

export function parsePlanMaxTurnsOverride(input: string): ParsedMaxTurnsOverride {
  const parsed = PlanMaxTurnsOverrideSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(PLAN_MAX_TURNS_VALIDATION_ERROR);
  }
  return parsed.data;
}

export function resolveRepoRoot(planRepoRootInput: string, fallback: string): string {
  const trimmed = planRepoRootInput.trim();
  if (trimmed) {
    return trimmed;
  }
  return fallback;
}

export function requireSelectedSession(session: ChatSession | null): ChatSession {
  if (!session) {
    throw new Error('chat composer: selectedSession is required');
  }
  return session;
}
