import type { HttpClient } from '../lib/http-client.js';
import { BraveSearchProvider } from './brave-search-provider.js';
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';

export type WebSearchProviderOptions = {
  resultCount: number;
  timeoutMs: number;
  client: HttpClient;
};

export abstract class WebSearchProvider {
  abstract readonly id: WebSearchConfig['Provider'];
  abstract search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]>;
}

export function createWebSearchProvider(config: WebSearchConfig): WebSearchProvider {
  if (config.Provider === 'brave') {
    return new BraveSearchProvider(config.BraveApiKey);
  }
  throw new Error(`Unsupported web search provider: ${String(config.Provider)}`);
}
