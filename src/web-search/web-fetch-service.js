"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebFetchService = void 0;
const url_safety_js_1 = require("./url-safety.js");
function normalizeWhitespace(value) {
    return value.replace(/\s+/gu, ' ').trim();
}
function extractTitle(html) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
    return normalizeWhitespace(match?.[1]?.replace(/<[^>]+>/gu, ' ') || '');
}
function extractText(content, contentType) {
    if (!contentType.toLowerCase().includes('html')) {
        return { title: '', text: normalizeWhitespace(content) };
    }
    const title = extractTitle(content);
    const text = normalizeWhitespace(content
        .replace(/<script[\s\S]*?<\/script>/giu, ' ')
        .replace(/<style[\s\S]*?<\/style>/giu, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
        .replace(/<title[\s\S]*?<\/title>/giu, ' ')
        .replace(/<[^>]+>/gu, ' '));
    return { title, text };
}
class WebFetchService {
    config;
    fetchImpl;
    constructor(config, fetchImpl = fetch) {
        this.config = config;
        this.fetchImpl = fetchImpl;
    }
    async fetch(args) {
        const originalUrl = (0, url_safety_js_1.assertPublicHttpUrl)(String(args.url || '').trim());
        let currentUrl = originalUrl;
        for (let redirect = 0; redirect <= 3; redirect += 1) {
            const response = await this.fetchImpl(currentUrl, {
                redirect: 'manual',
                signal: AbortSignal.timeout(this.config.TimeoutMs),
            });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                if (!location) {
                    throw new Error('Redirect response did not include a Location header.');
                }
                currentUrl = (0, url_safety_js_1.assertPublicHttpUrl)(new URL(location, currentUrl).toString());
                continue;
            }
            if (!response.ok) {
                throw new Error(`web_fetch failed with HTTP ${response.status}.`);
            }
            const rawText = await response.text();
            const extracted = extractText(rawText, response.headers.get('content-type') || '');
            const truncated = extracted.text.length > this.config.FetchMaxCharacters;
            return {
                url: originalUrl.toString(),
                finalUrl: currentUrl.toString(),
                title: extracted.title,
                text: truncated ? extracted.text.slice(0, this.config.FetchMaxCharacters) : extracted.text,
                truncated,
            };
        }
        throw new Error('web_fetch exceeded redirect limit.');
    }
}
exports.WebFetchService = WebFetchService;
