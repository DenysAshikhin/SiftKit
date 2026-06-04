import { estimateTokenCount } from '../state/chat-sessions.js';
import type {
  WebFetchToolArgs,
  WebSearchConfig,
  WebSearchResult,
  WebSearchToolArgs,
  WebToolArgs,
  WebToolExecutionResult,
} from './types.js';
import { WebFetchService } from './web-fetch-service.js';
import { WebSearchService } from './web-search-service.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function quoteValue(value: string): string {
  return JSON.stringify(value);
}

function formatSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return 'No web search results found.';
  }
  return results.map((result, index) => [
    `${index + 1}. ${result.title}`,
    `URL: ${result.url}`,
    `Snippet: ${result.snippet || '(none)'}`,
    `Source: ${result.source}`,
  ].join('\n')).join('\n\n');
}

export class WebResearchTools {
  private readonly searchService: WebSearchService;
  private readonly fetchService: WebFetchService;

  constructor(
    private readonly config: WebSearchConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    this.searchService = new WebSearchService(config, fetchImpl);
    this.fetchService = new WebFetchService(config, fetchImpl);
  }

  async search(args: WebSearchToolArgs): Promise<WebToolExecutionResult> {
    const query = String(args.query || '').trim();
    const results = await this.searchService.search({ query, timeFilter: args.timeFilter });
    const output = formatSearchResults(results);
    return {
      command: `web_search query=${quoteValue(query)}`,
      output,
      outputTokens: estimateTokenCount(output),
    };
  }

  async fetch(args: WebFetchToolArgs): Promise<WebToolExecutionResult> {
    const url = String(args.url || '').trim();
    const result = await this.fetchService.fetch({ url });
    const output = [
      result.title ? `Title: ${result.title}` : '',
      `URL: ${result.finalUrl}`,
      result.truncated ? 'Truncated: true' : 'Truncated: false',
      '',
      result.text,
    ].filter((part) => part !== '').join('\n');
    return {
      command: `web_fetch url=${quoteValue(url)}`,
      output,
      outputTokens: estimateTokenCount(output),
    };
  }

  async execute(toolName: 'web_search' | 'web_fetch', args: WebToolArgs): Promise<WebToolExecutionResult> {
    if (toolName === 'web_search') {
      return await this.search(args as WebSearchToolArgs);
    }
    if (toolName === 'web_fetch') {
      return await this.fetch(args as WebFetchToolArgs);
    }
    throw new Error(`Unsupported web tool: ${String(toolName)}`);
  }
}
