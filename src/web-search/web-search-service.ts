import { httpClient, type HttpClient } from '../lib/http-client.js';
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';
import { createWebSearchProvider, type WebSearchProvider } from './web-search-provider.js';

export class WebSearchService {
  private readonly provider: WebSearchProvider;

  constructor(
    private readonly config: WebSearchConfig,
    private readonly client: HttpClient = httpClient,
    provider?: WebSearchProvider,
  ) {
    this.provider = provider ?? createWebSearchProvider(config);
  }

  async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('web_search requires query.');
    }
    const results = await this.provider.search(
      { query, timeFilter: args.timeFilter },
      { resultCount: this.config.ResultCount, timeoutMs: this.config.TimeoutMs, client: this.client },
    );
    return results.slice(0, this.config.ResultCount);
  }
}
