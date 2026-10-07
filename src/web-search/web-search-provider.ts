import { TavilySearchProvider } from './tavily-search-provider.ts';
import { FirecrawlSearchProvider } from './firecrawl-search-provider.ts';
import type { WebSearchConfig, WebSearchProviderId } from './types.ts';
import { WebSearchProvider, type WebSearchProviderOptions } from './web-search-provider-base.ts';

export { WebSearchProvider, type WebSearchProviderOptions };

function buildProvider(id: WebSearchProviderId, apiKey: string): WebSearchProvider {
  if (id === 'tavily') {
    return new TavilySearchProvider(apiKey);
  }
  if (id === 'firecrawl') {
    return new FirecrawlSearchProvider(apiKey);
  }
  throw new Error(`Unsupported web search provider: ${String(id)}`);
}

function usableProviderIds(config: WebSearchConfig): WebSearchProviderId[] {
  return config.ProviderOrder.filter((id) => {
    const provider = config.Providers[id];
    return provider !== undefined && provider.Enabled && provider.ApiKey.trim() !== '';
  });
}

/**
 * The single definition of "this provider can actually run a search". The planner tool surface and
 * WebSearchService both read it, so `web_search` is never advertised to a model that cannot run it.
 */
export function hasUsableWebSearchProvider(config: WebSearchConfig): boolean {
  return usableProviderIds(config).length > 0;
}

export function createWebSearchProviders(config: WebSearchConfig): WebSearchProvider[] {
  return usableProviderIds(config).map((id) => buildProvider(id, config.Providers[id].ApiKey));
}
