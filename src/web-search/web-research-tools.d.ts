import type { WebFetchToolArgs, WebSearchConfig, WebSearchToolArgs, WebToolArgs, WebToolExecutionResult } from './types.js';
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export declare class WebResearchTools {
    private readonly config;
    private readonly searchService;
    private readonly fetchService;
    constructor(config: WebSearchConfig, fetchImpl?: FetchLike);
    search(args: WebSearchToolArgs): Promise<WebToolExecutionResult>;
    fetch(args: WebFetchToolArgs): Promise<WebToolExecutionResult>;
    execute(toolName: 'web_search' | 'web_fetch', args: WebToolArgs): Promise<WebToolExecutionResult>;
}
export {};
