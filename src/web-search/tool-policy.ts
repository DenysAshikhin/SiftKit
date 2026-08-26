import type { WebSearchConfig } from './types.js';
import { hasUsableWebSearchProvider } from './web-search-provider.js';

export type WebToolPolicy = {
  webSearch: boolean;
  webFetch: boolean;
};

/**
 * `WebSearch.EnabledDefault` is a default, not a lock: a caller that expresses per-run intent
 * (a chat session toggle) wins. `web_fetch` needs no provider — it is a direct HTTP GET — so the
 * enable flag is the only thing standing between a "web disabled" config and outbound egress.
 */
export function resolveWebToolPolicy(
  config: WebSearchConfig,
  explicitEnabled: boolean | undefined,
): WebToolPolicy {
  const enabled = explicitEnabled ?? config.EnabledDefault;
  return {
    webFetch: enabled,
    webSearch: enabled && hasUsableWebSearchProvider(config),
  };
}

export function applyWebToolPolicy(toolNames: readonly string[], policy: WebToolPolicy): string[] {
  return toolNames.filter((toolName) => {
    if (toolName === 'web_search') return policy.webSearch;
    if (toolName === 'web_fetch') return policy.webFetch;
    return true;
  });
}
