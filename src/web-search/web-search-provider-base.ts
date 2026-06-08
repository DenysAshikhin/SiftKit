import type { HttpClient } from '../lib/http-client.js';
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
