# Brave Web Search Integration — Design

**Date:** 2026-06-08
**Status:** Approved

## Goal

Replace the SearXNG + DuckDuckGo web-search stack with a pluggable provider
architecture whose only current implementation is the Brave Search API. The
Brave API key is configured from a new Web Search settings page in the
dashboard. Every executed search is counted (current calendar month + all-time)
and surfaced on the dashboard for free-tier quota awareness.

## Decisions (from brainstorming)

- **Provider model:** Replace SearXNG/DuckDuckGo entirely. No fallback, no legacy.
- **Pluggability:** A `WebSearchProvider` abstract class + explicit
  `createWebSearchProvider` factory. Adding a provider later = one new class +
  one factory branch + one config field. No dynamic function passing.
- **Usage tracking:** Monthly (resets each calendar month, maps to Brave quota)
  **and** all-time lifetime total.
- **Key storage:** Plaintext in the `WebSearch` config (SQLite), returned to the
  dashboard, shown in a masked (password) field with a reveal toggle.

## Architecture

### Provider seam (`src/web-search`)

```ts
export type WebSearchProviderId = 'brave';            // union grows per provider

export type WebSearchProviderOptions = {
  resultCount: number;
  timeoutMs: number;
  client: HttpClient;
};

export abstract class WebSearchProvider {
  abstract readonly id: WebSearchProviderId;
  abstract search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]>;
}

export function createWebSearchProvider(config: WebSearchConfig): WebSearchProvider;
// brave -> new BraveSearchProvider(config.BraveApiKey); else throws.
```

- `BraveSearchProvider` (`id='brave'`): `GET https://api.search.brave.com/res/v1/web/search?q=…&count=N`,
  headers `Accept: application/json` + `X-Subscription-Token: <key>`.
  `timeFilter` → Brave `freshness` (`day→pd`, `week→pw`, `month→pm`, `year→py`).
  Maps `body.web.results[]` `{title, url, description}` → `{title, url, snippet, source:'brave'}`,
  strips HTML, validates with `assertPublicHttpUrl`. Empty key → throws
  `"Brave API key not configured."`. Non-2xx → throws `"Brave search failed with HTTP <n>."`.
- `WebSearchService` keeps orchestration only (query validation, `ResultCount`
  slicing) and delegates the fetch to the provider built by the factory. A
  provider may be injected for tests.
- `WebFetchService` is provider-agnostic — unchanged.

### Config shape

```ts
WebSearchConfig = {
  EnabledDefault: boolean;
  Provider: WebSearchProviderId;   // 'brave'
  BraveApiKey: string;             // '' when unset
  ResultCount: number;             // clamp 1..20 (Brave count max is 20)
  TimeoutMs: number;
  FetchMaxPages: number;
  FetchMaxCharacters: number;
}
```

`SearxngBaseUrl` removed. `WebSearchResult.source: WebSearchProviderId`. Mirrored
in `src/web-search/types.ts`, `src/config/types.ts`, `dashboard/src/types.ts`,
`src/config/defaults.ts`, `config-store.ts` (`DEFAULT_WEB_SEARCH_CONFIG` +
`normalizeWebSearchConfig`), and the engine's `DEFAULT_ENGINE_WEB_SEARCH_CONFIG`.

### Usage counter (reuse existing metadata channel)

Every executed `web_search` already increments `toolStats['web_search'].calls`,
reported per-request to the status server at `routes/core.ts` (both the inline
and worker ingestion sites). Grounding-policy rejections never execute, so this
count equals actual Brave queries.

- New table `web_search_usage(month TEXT PRIMARY KEY, count INTEGER)` in
  `runtime-db.ts` `createTables`.
- New `src/status-server/web-search-usage.ts`: `recordWebSearchUsage(path, delta, at)`
  (UPSERT into the current `YYYY-MM` bucket) and `readWebSearchUsage(path, at)` →
  `{ currentMonth, currentMonthCount, allTimeCount }`.
- In each ingestion site, after `writeMetrics`, compute
  `delta = metadata.toolStats?.['web_search']?.calls ?? 0` and call
  `recordWebSearchUsage(ctx.metricsPath, delta, new Date())`.
- `GET /dashboard/metrics/timeseries` adds `webSearchUsage` to its response.

### Dashboard

- New `web-search` settings section: **Provider** dropdown (only `brave`),
  masked **Brave API key** + reveal, **Enabled by default**, **Result count**
  (1–20), **Timeout ms**, **Fetch max pages**, **Fetch max characters**, and a
  read-only **Usage** line (`"<month> this month / <all-time> all-time"`).
- `MetricsTab` gets a compact **Web Search** usage card (month + all-time).

## Testing

- `tests/web-search.test.ts`: rewritten for Brave — request URL/headers, freshness
  mapping, result normalization, empty-key error, `ResultCount` cap; factory
  returns Brave for `'brave'` and throws on unknown; `WebSearchService` delegates
  to an injected fake provider.
- `tests/web-search-usage.test.ts`: month bucketing, month rollover, all-time sum.
- `tests/dashboard-status-server.test.ts`: posting metadata with a `web_search`
  tool-call increments usage; timeseries response carries `webSearchUsage`.
- `dashboard/tests/tab-components.test.tsx`: web-search section renders, key is
  masked, usage card renders.

## Out of scope

- Per-provider nested config trees (added when a second provider needs them).
- Brave pagination / `offset` (single page, `count` results).
