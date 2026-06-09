import { httpClient, type HttpClient } from '../lib/http-client.js';
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';
import { createWebSearchProviders, type WebSearchProvider } from './web-search-provider.js';

export class WebSearchService {
  private readonly providers: WebSearchProvider[];

  constructor(
    private readonly config: WebSearchConfig,
    private readonly client: HttpClient = httpClient,
    providers?: WebSearchProvider[],
  ) {
    this.providers = providers ?? createWebSearchProviders(config);
  }

  async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('web_search requires query.');
    }
    if (this.providers.length === 0) {
      throw new Error('No web search provider configured.');
    }
    const opts = { resultCount: this.config.ResultCount, timeoutMs: this.config.TimeoutMs, client: this.client };
    const failures: string[] = [];
    for (const provider of this.providers) {
      try {
        const results = await provider.search({ query, timeFilter: args.timeFilter }, opts);
        return results.slice(0, this.config.ResultCount);
      } catch (error) {
        failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All web search providers failed. ${failures.join('; ')}`);
  }
}
