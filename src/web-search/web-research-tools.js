"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebResearchTools = void 0;
const chat_sessions_js_1 = require("../state/chat-sessions.js");
const web_fetch_service_js_1 = require("./web-fetch-service.js");
const web_search_service_js_1 = require("./web-search-service.js");
function quoteValue(value) {
    return JSON.stringify(value);
}
function formatSearchResults(results) {
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
class WebResearchTools {
    config;
    searchService;
    fetchService;
    constructor(config, fetchImpl = fetch) {
        this.config = config;
        this.searchService = new web_search_service_js_1.WebSearchService(config, fetchImpl);
        this.fetchService = new web_fetch_service_js_1.WebFetchService(config, fetchImpl);
    }
    async search(args) {
        const query = String(args.query || '').trim();
        const results = await this.searchService.search({ query, timeFilter: args.timeFilter });
        const output = formatSearchResults(results);
        return {
            command: `web_search query=${quoteValue(query)}`,
            output,
            outputTokens: (0, chat_sessions_js_1.estimateTokenCount)(output),
        };
    }
    async fetch(args) {
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
            outputTokens: (0, chat_sessions_js_1.estimateTokenCount)(output),
        };
    }
    async execute(toolName, args) {
        if (toolName === 'web_search') {
            return await this.search(args);
        }
        if (toolName === 'web_fetch') {
            return await this.fetch(args);
        }
        throw new Error(`Unsupported web tool: ${String(toolName)}`);
    }
}
exports.WebResearchTools = WebResearchTools;
