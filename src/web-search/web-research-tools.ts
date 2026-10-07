import { httpClient, type HttpClient } from '../lib/http-client.ts';
import { estimateTokenCount } from '../state/chat-sessions.ts';
import type {
  WebFetchToolArgs,
  WebSearchConfig,
  WebSearchResult,
  WebSearchToolArgs,
  WebToolArgs,
  WebToolExecutionResult,
} from './types.ts';
import { WebFetchService } from './web-fetch-service.ts';
import { WebSearchService } from './web-search-service.ts';
import type { WebSearchProvider } from './web-search-provider.ts';
import { formatWebFetchCommand, formatWebSearchCommand } from './web-tool-command.ts';

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

  private readonly config: WebSearchConfig;

  constructor(
    config: WebSearchConfig,
    client: HttpClient = httpClient,
    providers?: WebSearchProvider[],
  ) {
    this.config = config;
    this.searchService = new WebSearchService(config, client, providers);
    this.fetchService = new WebFetchService(config, client);
  }

  async search(args: WebSearchToolArgs): Promise<WebToolExecutionResult> {
    const query = String(args.query || '').trim();
    const results = await this.searchService.search({ query, timeFilter: args.timeFilter });
    const output = formatSearchResults(results);
    return {
      command: formatWebSearchCommand(query),
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
      command: formatWebFetchCommand(url),
      output,
      outputTokens: estimateTokenCount(output),
    };
  }

  async execute(toolName: 'web_search' | 'web_fetch', args: WebToolArgs): Promise<WebToolExecutionResult> {
    if (toolName === 'web_search' && 'query' in args) {
      return await this.search(args);
    }
    if (toolName === 'web_fetch' && 'url' in args) {
      return await this.fetch(args);
    }
    throw new Error(`Unsupported web tool: ${String(toolName)}`);
  }
}
