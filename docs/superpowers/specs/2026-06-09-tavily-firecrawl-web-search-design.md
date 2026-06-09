# Tavily + Firecrawl Web Search & Local Page Loader — Design

Date: 2026-06-09
Status: Approved (brainstorming)

## Goal

Replace the Brave web-search provider (no free tier) with **two failover search
providers** — Tavily (primary) and Firecrawl (fallback) — and replace the
HTML-stripping page loader with a **local Readability + Turndown** loader (no API,
no key). Surface **remote provider quota** (used / limit / remaining) on the
dashboard alongside the existing local executed-count.

All Brave code is deleted outright — no legacy compatibility, no shims.

## Decisions (locked)

- **Search depth:** Tavily `search_depth: 'basic'` (1 credit/search, free-tier friendly).
- **Providers:** per-provider Enabled toggle + API key; failover order via `ProviderOrder`.
- **Failover trigger:** any error (quota, 429/402, network, non-2xx) advances to the
  next provider; aggregated error only if all enabled providers fail.
- **Page loader:** fully local via `jsdom` + `@mozilla/readability` + `turndown`.
- **Quota display:** query Tavily `/usage` and Firecrawl `/v1/team/credit-usage`;
  show used/limit/remaining where the API exposes it; keep the local SQLite counter.
- **Provider-order UI:** primary-provider dropdown (two providers; the unselected one
  is the fallback). `ProviderOrder` defaults to `['tavily','firecrawl']`.

## Config shape

```ts
// src/web-search/types.ts  and mirrored in src/config/types.ts + dashboard/src/types.ts
export type WebSearchProviderId = 'tavily' | 'firecrawl';
export type WebSearchProviderSettings = { Enabled: boolean; ApiKey: string };

export type WebSearchConfig = {
  EnabledDefault: boolean;
  Providers: Record<WebSearchProviderId, WebSearchProviderSettings>;
  ProviderOrder: WebSearchProviderId[];
  ResultCount: number;
  FetchMaxPages: number;
  TimeoutMs: number;
  FetchMaxCharacters: number;
};
```

A provider is active iff `Providers[id].Enabled && Providers[id].ApiKey.trim()`,
walked in `ProviderOrder`. Inactive/unknown ids are skipped.

Defaults (`src/config/defaults.ts`, `src/status-server/config-store.ts`
`DEFAULT_WEB_SEARCH_CONFIG`, and `src/repo-search/engine.ts` literal):

```ts
{
  EnabledDefault: true,
  Providers: {
    tavily:    { Enabled: false, ApiKey: '' },
    firecrawl: { Enabled: false, ApiKey: '' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
}
```

`normalizeWebSearchConfig` validates each provider sub-record (boolean Enabled,
trimmed-string ApiKey), filters `ProviderOrder` to known ids and de-dupes,
appending any missing known ids so order is always complete.

## Search providers

Base (`web-search-provider-base.ts`):

```ts
export type ProviderQuota = {
  provider: WebSearchProviderId;
  used: number | null;
  limit: number | null;
  remaining: number | null;
};

export abstract class WebSearchProvider {
  abstract readonly id: WebSearchProviderId;
  abstract search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]>;
  abstract getQuota(opts: WebSearchProviderOptions): Promise<ProviderQuota>;
}
```

`WebSearchProviderOptions` keeps `{ resultCount, timeoutMs, client }`; each concrete
provider stores its own API key (constructor arg).

### TavilySearchProvider (`tavily-search-provider.ts`)

- `POST https://api.tavily.com/search`, headers `Authorization: Bearer <key>`,
  `Content-Type: application/json`, `Accept: application/json`.
- Body: `{ query, max_results: resultCount, search_depth: 'basic', time_range? }`.
  `timeFilter` (`day|week|month|year`) maps 1:1 to Tavily `time_range`.
- Response `results[]` → `{ title, url, snippet: content, source: 'tavily' }`,
  filtered through `assertPublicHttpUrl`; drop entries missing title/url.
- Errors: missing key → `Tavily API key not configured.`; non-2xx →
  `Tavily search failed with HTTP <status>.`
- `getQuota`: `GET https://api.tavily.com/usage` (Bearer). Parse account plan
  usage/limit → `{ used, limit, remaining: limit - used }` best-effort; null when absent.

### FirecrawlSearchProvider (`firecrawl-search-provider.ts`)

- `POST https://api.firecrawl.dev/v1/search`, headers `Authorization: Bearer <key>`,
  `Content-Type: application/json`.
- Body: `{ query, limit: resultCount, tbs? }`. `timeFilter` → `tbs`:
  `day→qdr:d, week→qdr:w, month→qdr:m, year→qdr:y`.
- Response `data[]` → `{ title, url, snippet: description, source: 'firecrawl' }`,
  filtered through `assertPublicHttpUrl`.
- Errors: missing key → `Firecrawl API key not configured.`; `success:false` or
  non-2xx → `Firecrawl search failed with HTTP <status>.`
- `getQuota`: `GET https://api.firecrawl.dev/v1/team/credit-usage` (Bearer) →
  `{ remaining: data.remaining_credits, limit: data.plan_credits ?? null, used: limit-remaining (when both) }`.

### Factory + chain

```ts
// web-search-provider.ts
export function createWebSearchProviders(config: WebSearchConfig): WebSearchProvider[];
```

Returns concrete providers for active ids in `ProviderOrder`. `WebSearchService`
takes `WebSearchProvider[]`; `search()` tries each in order, collecting errors;
returns the first provider's non-throwing result (capped to `ResultCount`,
existing behavior). If the list is empty → `No web search provider configured.`
If all throw → aggregated `Error` naming each provider + its message.

## Page loader (`web-fetch-service.ts`)

Keep the class + `WebFetchResult` shape (`{ url, finalUrl, title, text, truncated }`)
and the `web_fetch` tool name. Rewrite internals:

1. `assertPublicHttpUrl(originalUrl)`; manual redirect loop (≤3) with `redirect:'manual'`
   and per-hop `assertPublicHttpUrl` re-validation (SSRF protection retained).
2. On the final 2xx response, branch on content-type:
   - `text/plain` / `text/markdown` → `{ title: finalUrl, text: raw }` (passthrough).
   - `text/html` / `application/xhtml+xml` → `new JSDOM(html, { url: finalUrl })`,
     `new Readability(dom.window.document).parse()`; title = `article.title || document.title || finalUrl`;
     markdown via `new TurndownService({ headingStyle:'atx', codeBlockStyle:'fenced' }).turndown(article.content || body.innerHTML)`.
   - else → throw `web_fetch unsupported content type: <type>.`
3. `text` = markdown; truncate to `FetchMaxCharacters` (`truncated` flag).

Reuse the shared `HttpClient` (UA, undici dispatcher, `TimeoutMs`). Delete
`src/web-search/html-text.ts` (only Brave + old fetch used it).

New deps: `jsdom`, `@mozilla/readability`, `turndown`; dev: `@types/jsdom`, `@types/turndown`.

## Quota route + dashboard

- `WebSearchQuotaService` (status-server): builds providers via `createWebSearchProviders`,
  calls each `getQuota`, returns `ProviderQuota[]`; short in-memory TTL cache
  (e.g. 60s) keyed on provider+key to avoid burning credits.
- New route `GET /dashboard/web-search-quota` → `{ quotas: ProviderQuota[] }`.
  Called on Settings/Metrics tab mount — NOT in the main dashboard poll.
- `MetricsTab` + Settings usage field render per-provider used/limit/remaining cards
  next to the existing local executed-count (`webSearchUsage`, unchanged).

## Settings UI (`settings-sections.ts`, `SettingsTab.tsx`)

Web Search section fields: primary-provider dropdown (`ProviderOrder[0]`),
Tavily Enabled toggle + API key (show/hide), Firecrawl Enabled toggle + API key
(show/hide), result count, timeout, fetch max pages, fetch max characters, usage.
All Brave copy/state (`showBraveKey`, `X-Subscription-Token` text) removed.

## Out of scope (unchanged)

`WebSearchService` query trim/cap contract, `web-research-tools` formatting,
`url-safety`, `web-tool-command`, local usage SQLite (`web-search-usage.ts`),
planner tool registration, the historical Brave spec/plan docs (kept as record).

## Test plan (TDD)

Core rewrite `tests/web-search.test.ts`:
- Tavily: request body (query, max_results, search_depth, time_range), Bearer header,
  `content`→snippet, `source:'tavily'`, missing-key + non-2xx throws.
- Firecrawl: body (query, limit, tbs), Bearer header, `description`→snippet,
  `source:'firecrawl'`, `success:false`/non-2xx throws.
- Chain: provider 1 throws → provider 2 result; all throw → aggregated error;
  empty config → `No web search provider configured.`
- `getQuota` parsing for both providers (full fields + partial/omitted).
- `WebFetchService`: html→markdown via Readability/Turndown, plain passthrough,
  redirect + per-hop SSRF rejection, unsupported content-type, truncation.

Updated: `config-normalization.test.ts` (new shape, order normalization),
`settings-sections.test.ts`, `dashboard-status-server.test.ts` (+ quota route),
`repo-search-loop.core.test.ts`, `repo-search-chat-execute.test.ts`,
`dashboard/tests/tab-components.test.tsx`.
