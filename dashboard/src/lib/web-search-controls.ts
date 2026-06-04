import type { WebSearchOverride } from '../types';

export function getNextWebSearchOverride(value: WebSearchOverride): WebSearchOverride {
  if (value === 'default') return 'on';
  if (value === 'on') return 'off';
  return 'default';
}

export function resolveEffectiveWebSearchEnabled(sessionEnabled: boolean, override: WebSearchOverride): boolean {
  if (override === 'on') return true;
  if (override === 'off') return false;
  return sessionEnabled;
}
