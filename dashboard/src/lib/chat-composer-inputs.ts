import type { ChatSession } from '../types';

export type ParsedMaxTurnsOverride = { maxTurns: number } | Record<string, never>;

export function parsePlanMaxTurnsOverride(input: string): ParsedMaxTurnsOverride {
  const parsed = Number(input);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { maxTurns: parsed };
  }
  return {};
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