import type { WebFetchResult, WebFetchToolArgs, WebSearchConfig } from './types.js';
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export declare class WebFetchService {
    private readonly config;
    private readonly fetchImpl;
    constructor(config: WebSearchConfig, fetchImpl?: FetchLike);
    fetch(args: WebFetchToolArgs): Promise<WebFetchResult>;
}
export {};
