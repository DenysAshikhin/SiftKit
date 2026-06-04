import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export declare class WebSearchService {
    private readonly config;
    private readonly fetchImpl;
    constructor(config: WebSearchConfig, fetchImpl?: FetchLike);
    search(args: WebSearchToolArgs): Promise<WebSearchResult[]>;
    private searchSearxng;
    private searchDuckDuckGo;
}
export {};
