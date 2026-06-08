# Brave Web Search Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SearXNG/DuckDuckGo web-search stack with a pluggable provider architecture whose only implementation is the Brave Search API, configurable from a new dashboard Web Search settings page, with monthly + all-time search-count tracking surfaced on the dashboard.

**Architecture:** A `WebSearchProvider` abstract class plus an explicit `createWebSearchProvider` factory selects a provider from config (`brave` today). `WebSearchService` keeps orchestration and delegates the fetch. Search counts reuse the existing per-request `toolStats['web_search'].calls` metadata already sent to the status server; a new `web_search_usage` table buckets them by calendar month and the timeseries endpoint exposes them to the dashboard.

**Tech Stack:** TypeScript (Node `node:test` + `tsx`), better-sqlite3 (`getRuntimeDatabase`), undici (`HttpClient`), React 19 dashboard.

---

## Conventions

- **Tests:** run a single file with `npx tsx --test .\tests\<file>.ts` (or `.\dashboard\tests\<file>.tsx`). Full suite: `npm test`. Typecheck: `npm run typecheck`.
- **Compiled artifacts:** `*.js` / `*.d.ts` next to sources are build output. Do **not** hand-edit them — `npm run build` regenerates them. Only edit `*.ts`/`*.tsx`.
- **No legacy:** SearXNG/DuckDuckGo code, types, and tests are deleted outright. Anything missed must fail loud (type errors / throwing factory), never silently fall back.

## File Structure

**Create:**
- `src/web-search/web-search-provider.ts` — `WebSearchProvider` abstract class, `WebSearchProviderOptions`, `createWebSearchProvider` factory.
- `src/web-search/brave-search-provider.ts` — `BraveSearchProvider` + Brave result normalization.
- `src/status-server/web-search-usage.ts` — `recordWebSearchUsage`, `readWebSearchUsage`, `getUsageMonthKey`, `WebSearchUsage` type.
- `tests/web-search-usage.test.ts` — usage store tests.

**Modify:**
- `src/web-search/types.ts` — `WebSearchProviderId`, new `WebSearchConfig`, `WebSearchResult.source`.
- `src/web-search/html-text.ts` — export shared `stripHtml`.
- `src/web-search/web-search-service.ts` — delegate to provider.
- `src/config/types.ts` — mirror `WebSearchConfig`.
- `src/config/defaults.ts` — Brave defaults.
- `src/status-server/config-store.ts` — `DEFAULT_WEB_SEARCH_CONFIG`, `normalizeWebSearchConfig`.
- `src/repo-search/engine.ts` — `DEFAULT_ENGINE_WEB_SEARCH_CONFIG`.
- `src/state/runtime-db.ts` — `web_search_usage` table.
- `src/status-server/routes/core.ts` — increment usage at both ingestion sites.
- `src/status-server/routes/dashboard.ts` — add `webSearchUsage` to timeseries response.
- `dashboard/src/types.ts` — `DashboardWebSearchConfig`, `WebSearchUsage`, `MetricsResponse`.
- `dashboard/src/settings-sections.ts` — `web-search` section + order + fields.
- `dashboard/src/tabs/SettingsTab.tsx` — render web-search section.
- `dashboard/src/tabs/MetricsTab.tsx` — usage card.
- `dashboard/src/App.tsx` — thread `webSearchUsage` to tabs.
- `tests/web-search.test.ts` — rewrite for Brave.
- `tests/dashboard-status-server.test.ts` — usage increment + timeseries field.
- `dashboard/tests/tab-components.test.tsx` — section + card.

---

## Task 1: Config types → Brave shape

**Files:**
- Modify: `src/web-search/types.ts:1-29`
- Modify: `src/config/types.ts:100-108`
- Modify: `src/config/defaults.ts:98-106`
- Modify: `src/status-server/config-store.ts:34-42, 138-152`
- Modify: `src/repo-search/engine.ts:120-128`
- Test: `tests/config-store.test.ts` (add cases if file exists; otherwise add to `tests/dashboard-status-server.test.ts` — see Step 1)

- [ ] **Step 1: Write the failing test for normalization**

Add to `tests/dashboard-status-server.test.ts` (top-level, after existing imports). If `normalizeWebSearchConfig` is not yet imported there, add `import { normalizeWebSearchConfig } from '../src/status-server/config-store.js';`:

```ts
test('normalizeWebSearchConfig produces Brave defaults and clamps ResultCount to 20', () => {
  const normalized = normalizeWebSearchConfig({ ResultCount: 999, BraveApiKey: '  abc  ', SearxngBaseUrl: 'http://x' });
  assert.equal(normalized.Provider, 'brave');
  assert.equal(normalized.ResultCount, 20);
  assert.equal(normalized.BraveApiKey, 'abc');
  assert.equal('SearxngBaseUrl' in normalized, false);
});

test('normalizeWebSearchConfig defaults an empty Brave key', () => {
  const normalized = normalizeWebSearchConfig({});
  assert.equal(normalized.BraveApiKey, '');
  assert.equal(normalized.EnabledDefault, true);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npx tsx --test .\tests\dashboard-status-server.test.ts`
Expected: FAIL — `Provider` is `'searxng'` / `BraveApiKey` undefined / `SearxngBaseUrl` present.

- [ ] **Step 3: Update `src/web-search/types.ts`**

Replace lines 1-29 with:

```ts
export type WebSearchProviderId = 'brave';

export type WebSearchConfig = {
  EnabledDefault: boolean;
  Provider: WebSearchProviderId;
  BraveApiKey: string;
  ResultCount: number;
  FetchMaxPages: number;
  TimeoutMs: number;
  FetchMaxCharacters: number;
};

export type WebSearchToolArgs = {
  query: string;
  timeFilter?: 'day' | 'week' | 'month' | 'year';
};

export type WebFetchToolArgs = {
  url: string;
};

export type WebToolArgs = WebSearchToolArgs | WebFetchToolArgs;

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: WebSearchProviderId;
};
```

(Leave `WebFetchResult` and `WebToolExecutionResult` below unchanged.)

- [ ] **Step 4: Update `src/config/types.ts:100-108`**

```ts
export type WebSearchConfig = {
  EnabledDefault: boolean;
  Provider: 'brave';
  BraveApiKey: string;
  ResultCount: number;
  FetchMaxPages: number;
  TimeoutMs: number;
  FetchMaxCharacters: number;
};
```

- [ ] **Step 5: Update `src/config/defaults.ts:98-106`**

```ts
    WebSearch: {
      EnabledDefault: true,
      Provider: 'brave',
      BraveApiKey: '',
      ResultCount: 5,
      FetchMaxPages: 3,
      TimeoutMs: 15000,
      FetchMaxCharacters: 12000,
    },
```

- [ ] **Step 6: Update `src/status-server/config-store.ts`**

Replace `DEFAULT_WEB_SEARCH_CONFIG` (lines 34-42):

```ts
export const DEFAULT_WEB_SEARCH_CONFIG = {
  EnabledDefault: true,
  Provider: 'brave',
  BraveApiKey: '',
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
} as const;
```

Replace `normalizeWebSearchConfig` (lines 138-152):

```ts
export function normalizeWebSearchConfig(value: unknown): Dict {
  const record = (value && typeof value === 'object' && !Array.isArray(value)) ? value as Dict : {};
  return {
    EnabledDefault: typeof record.EnabledDefault === 'boolean'
      ? record.EnabledDefault
      : DEFAULT_WEB_SEARCH_CONFIG.EnabledDefault,
    Provider: 'brave',
    BraveApiKey: (getNullableTrimmedString(record.BraveApiKey) || ''),
    ResultCount: clampInteger(record.ResultCount, DEFAULT_WEB_SEARCH_CONFIG.ResultCount, 1, 20),
    FetchMaxPages: clampInteger(record.FetchMaxPages, DEFAULT_WEB_SEARCH_CONFIG.FetchMaxPages, 1, 8),
    TimeoutMs: clampInteger(record.TimeoutMs, DEFAULT_WEB_SEARCH_CONFIG.TimeoutMs, 1000, 60000),
    FetchMaxCharacters: clampInteger(record.FetchMaxCharacters, DEFAULT_WEB_SEARCH_CONFIG.FetchMaxCharacters, 1000, 50000),
  };
}
```

(`getNullableTrimmedString` returns a trimmed string or `null`; `|| ''` yields `''` when unset, and `SearxngBaseUrl` is simply not copied, so it disappears.)

- [ ] **Step 7: Update `src/repo-search/engine.ts:120-128`**

```ts
const DEFAULT_ENGINE_WEB_SEARCH_CONFIG: WebSearchConfig = {
  EnabledDefault: false,
  Provider: 'brave',
  BraveApiKey: '',
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};
```

- [ ] **Step 8: Run the normalization tests to verify pass**

Run: `npx tsx --test .\tests\dashboard-status-server.test.ts`
Expected: the two new tests PASS. (Other tests in this file may still fail until later tasks — that is expected; confirm only the two new ones pass.)

- [ ] **Step 9: Commit**

```bash
git add src/web-search/types.ts src/config/types.ts src/config/defaults.ts src/status-server/config-store.ts src/repo-search/engine.ts tests/dashboard-status-server.test.ts
git commit -m "feat: switch web search config to Brave provider shape"
```

---

## Task 2: Provider abstraction + Brave provider

**Files:**
- Modify: `src/web-search/html-text.ts` (export `stripHtml`)
- Create: `src/web-search/web-search-provider.ts`
- Create: `src/web-search/brave-search-provider.ts`
- Test: `tests/web-search.test.ts`

- [ ] **Step 1: Write failing tests (replace `tests/web-search.test.ts` entirely)**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicHttpUrl } from '../src/web-search/url-safety.js';
import { WebSearchService } from '../src/web-search/web-search-service.js';
import { WebFetchService } from '../src/web-search/web-fetch-service.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';
import { BraveSearchProvider } from '../src/web-search/brave-search-provider.js';
import { createWebSearchProvider, WebSearchProvider } from '../src/web-search/web-search-provider.js';
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from '../src/web-search/types.js';
import type { HttpClient } from '../src/lib/http-client.js';

const webConfig: WebSearchConfig = {
  EnabledDefault: false,
  Provider: 'brave',
  BraveApiKey: 'test-key',
  ResultCount: 2,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};

class StubHttpClient implements Pick<HttpClient, 'fetch'> {
  readonly calls: Array<{ url: string; init?: RequestInit }> = [];
  constructor(private readonly handler: (url: string | URL, init?: RequestInit) => Promise<Response>) {}
  fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    this.calls.push({ url: String(url), init });
    return this.handler(url, init);
  }
}

function braveBody(): string {
  return JSON.stringify({
    web: {
      results: [
        { title: 'One', url: 'https://example.com/1', description: 'First <strong>result</strong>.' },
        { title: 'Two', url: 'https://example.com/2', description: 'Second result.' },
        { title: 'Three', url: 'https://example.com/3', description: 'Third result.' },
      ],
    },
  });
}

test('assertPublicHttpUrl rejects non-http schemes', () => {
  assert.throws(() => assertPublicHttpUrl('file:///c:/secret.txt'), /http/i);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/file.txt'), /http/i);
});

test('assertPublicHttpUrl rejects loopback and private hosts', () => {
  assert.throws(() => assertPublicHttpUrl('http://localhost:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://10.0.0.5'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://192.168.1.1'), /private|internal|local/i);
});

test('createWebSearchProvider returns a Brave provider', () => {
  const provider = createWebSearchProvider(webConfig);
  assert.ok(provider instanceof BraveSearchProvider);
  assert.equal(provider.id, 'brave');
});

test('createWebSearchProvider throws on an unknown provider', () => {
  assert.throws(
    () => createWebSearchProvider({ ...webConfig, Provider: 'bing' as WebSearchConfig['Provider'] }),
    /Unsupported web search provider: bing/,
  );
});

test('BraveSearchProvider sends key header, count, freshness and normalizes results', async () => {
  const httpClient = new StubHttpClient(async () => new Response(braveBody(), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  const provider = new BraveSearchProvider('test-key');

  const results = await provider.search(
    { query: 'siftkit', timeFilter: 'week' },
    { resultCount: 2, timeoutMs: 15000, client: httpClient as unknown as HttpClient },
  );

  const call = httpClient.calls[0];
  assert.match(call.url, /api\.search\.brave\.com\/res\/v1\/web\/search/);
  assert.match(call.url, /[?&]q=siftkit/);
  assert.match(call.url, /[?&]count=2/);
  assert.match(call.url, /[?&]freshness=pw/);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get('x-subscription-token'), 'test-key');
  assert.equal(results[0].title, 'One');
  assert.equal(results[0].snippet, 'First result.');
  assert.equal(results[0].source, 'brave');
});

test('BraveSearchProvider throws when the key is missing', async () => {
  const provider = new BraveSearchProvider('');
  await assert.rejects(
    () => provider.search({ query: 'x' }, { resultCount: 5, timeoutMs: 1000, client: new StubHttpClient(async () => new Response('')) as unknown as HttpClient }),
    /Brave API key not configured/,
  );
});

test('BraveSearchProvider throws on non-2xx', async () => {
  const httpClient = new StubHttpClient(async () => new Response('nope', { status: 429 }));
  const provider = new BraveSearchProvider('test-key');
  await assert.rejects(
    () => provider.search({ query: 'x' }, { resultCount: 5, timeoutMs: 1000, client: httpClient as unknown as HttpClient }),
    /Brave search failed with HTTP 429/,
  );
});

test('WebSearchService delegates to a provider and caps to ResultCount', async () => {
  class FakeProvider extends WebSearchProvider {
    readonly id = 'brave' as const;
    readonly received: WebSearchToolArgs[] = [];
    async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
      this.received.push(args);
      return [
        { title: 'a', url: 'https://example.com/a', snippet: '', source: 'brave' },
        { title: 'b', url: 'https://example.com/b', snippet: '', source: 'brave' },
        { title: 'c', url: 'https://example.com/c', snippet: '', source: 'brave' },
      ];
    }
  }
  const provider = new FakeProvider();
  const service = new WebSearchService(webConfig, undefined, provider);

  const results = await service.search({ query: '  spaced  ', timeFilter: 'day' });

  assert.equal(results.length, 2);
  assert.equal(provider.received[0].query, 'spaced');
  assert.equal(provider.received[0].timeFilter, 'day');
});

test('WebSearchService rejects an empty query', async () => {
  const service = new WebSearchService(webConfig);
  await assert.rejects(() => service.search({ query: '   ' }), /web_search requires query/);
});

test('WebFetchService extracts title and capped body text', async () => {
  const httpClient = new StubHttpClient(async (): Promise<Response> => new Response(
    '<html><head><title>Example Title</title><style>x{}</style></head><body><script>x()</script><main>Hello   world</main></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  ));
  const service = new WebFetchService({ ...webConfig, FetchMaxCharacters: 5 }, httpClient as unknown as HttpClient);

  const result = await service.fetch({ url: 'https://example.com/page' });

  assert.equal(result.title, 'Example Title');
  assert.equal(result.text, 'Hello');
  assert.equal(result.truncated, true);
});

test('WebResearchTools formats web_search output', async () => {
  class FakeProvider extends WebSearchProvider {
    readonly id = 'brave' as const;
    async search(): Promise<WebSearchResult[]> {
      return [{ title: 'Result', url: 'https://example.com', snippet: 'Snippet', source: 'brave' }];
    }
  }
  const tools = new WebResearchTools(webConfig, undefined, new FakeProvider());

  const result = await tools.execute('web_search', { query: 'example' });

  assert.equal(result.command, 'web_search query="example"');
  assert.match(result.output, /Result/);
  assert.match(result.output, /https:\/\/example.com/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .\tests\web-search.test.ts`
Expected: FAIL — `brave-search-provider.js` / `web-search-provider.js` not found; `WebSearchService`/`WebResearchTools` do not accept a provider arg yet.

- [ ] **Step 3: Export `stripHtml` from `src/web-search/html-text.ts`**

Append to the end of the file:

```ts
/**
 * Removes `<script>`/`<style>` blocks and all remaining tags, decodes entities,
 * and collapses whitespace.
 */
export function stripHtml(value: string): string {
  const withoutTags = value
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ');
  return decodeHtmlEntities(withoutTags).replace(/\s+/gu, ' ').trim();
}
```

- [ ] **Step 4: Create `src/web-search/web-search-provider.ts`**

```ts
import type { HttpClient } from '../lib/http-client.js';
import { BraveSearchProvider } from './brave-search-provider.js';
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

export function createWebSearchProvider(config: WebSearchConfig): WebSearchProvider {
  if (config.Provider === 'brave') {
    return new BraveSearchProvider(config.BraveApiKey);
  }
  throw new Error(`Unsupported web search provider: ${String(config.Provider)}`);
}
```

- [ ] **Step 5: Create `src/web-search/brave-search-provider.ts`**

```ts
import type { Dict } from '../lib/types.js';
import { stripHtml } from './html-text.js';
import { WebSearchProvider, type WebSearchProviderOptions } from './web-search-provider.js';
import type { WebSearchResult, WebSearchToolArgs } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const FRESHNESS_BY_TIME_FILTER: Record<NonNullable<WebSearchToolArgs['timeFilter']>, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};

function getText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBraveResult(item: unknown): WebSearchResult | null {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Dict : {};
  const title = stripHtml(getText(record.title));
  const url = getText(record.url);
  const snippet = stripHtml(getText(record.description));
  if (!title || !url) {
    return null;
  }
  try {
    assertPublicHttpUrl(url);
  } catch {
    return null;
  }
  return { title, url, snippet, source: 'brave' };
}

export class BraveSearchProvider extends WebSearchProvider {
  readonly id = 'brave' as const;

  constructor(private readonly apiKey: string) {
    super();
  }

  async search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) {
      throw new Error('Brave API key not configured.');
    }
    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set('q', args.query);
    url.searchParams.set('count', String(opts.resultCount));
    if (args.timeFilter) {
      url.searchParams.set('freshness', FRESHNESS_BY_TIME_FILTER[args.timeFilter]);
    }
    const response = await opts.client.fetch(url, {
      timeoutMs: opts.timeoutMs,
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    });
    if (!response.ok) {
      throw new Error(`Brave search failed with HTTP ${response.status}.`);
    }
    const body = await response.json() as Dict;
    const web = body.web && typeof body.web === 'object' && !Array.isArray(body.web) ? body.web as Dict : {};
    const results = Array.isArray(web.results) ? web.results : [];
    return results
      .map((entry) => normalizeBraveResult(entry))
      .filter((entry): entry is WebSearchResult => entry !== null);
  }
}
```

- [ ] **Step 6: Run provider/factory tests**

Run: `npx tsx --test .\tests\web-search.test.ts`
Expected: provider + factory tests PASS; the `WebSearchService`/`WebResearchTools` delegation tests still FAIL (updated in Task 3). Confirm no compile errors in the two new files.

- [ ] **Step 7: Commit**

```bash
git add src/web-search/html-text.ts src/web-search/web-search-provider.ts src/web-search/brave-search-provider.ts tests/web-search.test.ts
git commit -m "feat: add pluggable web search provider with Brave implementation"
```

---

## Task 3: Delegate `WebSearchService` / `WebResearchTools` to the provider

**Files:**
- Modify: `src/web-search/web-search-service.ts` (full rewrite)
- Modify: `src/web-search/web-research-tools.ts:27-37`
- Test: `tests/web-search.test.ts` (already written in Task 2)

- [ ] **Step 1: Rewrite `src/web-search/web-search-service.ts`**

```ts
import { httpClient, type HttpClient } from '../lib/http-client.js';
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';
import { createWebSearchProvider, type WebSearchProvider } from './web-search-provider.js';

export class WebSearchService {
  private readonly provider: WebSearchProvider;

  constructor(
    private readonly config: WebSearchConfig,
    private readonly client: HttpClient = httpClient,
    provider?: WebSearchProvider,
  ) {
    this.provider = provider ?? createWebSearchProvider(config);
  }

  async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('web_search requires query.');
    }
    const results = await this.provider.search(
      { query, timeFilter: args.timeFilter },
      { resultCount: this.config.ResultCount, timeoutMs: this.config.TimeoutMs, client: this.client },
    );
    return results.slice(0, this.config.ResultCount);
  }
}
```

- [ ] **Step 2: Update `src/web-search/web-research-tools.ts:27-37`**

Thread an optional provider through so it reaches the search service:

```ts
export class WebResearchTools {
  private readonly searchService: WebSearchService;
  private readonly fetchService: WebFetchService;

  constructor(
    private readonly config: WebSearchConfig,
    client: HttpClient = httpClient,
    provider?: WebSearchProvider,
  ) {
    this.searchService = new WebSearchService(config, client, provider);
    this.fetchService = new WebFetchService(config, client);
  }
```

Add the import at the top of `web-research-tools.ts` (next to the other imports):

```ts
import type { WebSearchProvider } from './web-search-provider.js';
```

- [ ] **Step 3: Run the full web-search test file**

Run: `npx tsx --test .\tests\web-search.test.ts`
Expected: ALL tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/web-search/web-search-service.ts src/web-search/web-research-tools.ts
git commit -m "feat: delegate web search service to the provider seam"
```

---

## Task 4: Usage store + schema

**Files:**
- Modify: `src/state/runtime-db.ts:124` (after the `app_config` table, inside the same `exec` block)
- Create: `src/status-server/web-search-usage.ts`
- Test: `tests/web-search-usage.test.ts`

- [ ] **Step 1: Write the failing test `tests/web-search-usage.test.ts`**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordWebSearchUsage, readWebSearchUsage, getUsageMonthKey } from '../src/status-server/web-search-usage.js';

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-usage-'));
  return path.join(dir, 'runtime.db');
}

test('getUsageMonthKey formats UTC YYYY-MM', () => {
  assert.equal(getUsageMonthKey(new Date('2026-06-08T23:00:00Z')), '2026-06');
  assert.equal(getUsageMonthKey(new Date('2026-12-31T12:00:00Z')), '2026-12');
});

test('recordWebSearchUsage buckets by month and accumulates all-time', () => {
  const dbPath = tempDbPath();
  recordWebSearchUsage(dbPath, 2, new Date('2026-06-08T10:00:00Z'));
  recordWebSearchUsage(dbPath, 3, new Date('2026-06-20T10:00:00Z'));
  recordWebSearchUsage(dbPath, 5, new Date('2026-07-01T10:00:00Z'));

  const june = readWebSearchUsage(dbPath, new Date('2026-06-25T10:00:00Z'));
  assert.equal(june.currentMonth, '2026-06');
  assert.equal(june.currentMonthCount, 5);
  assert.equal(june.allTimeCount, 10);

  const july = readWebSearchUsage(dbPath, new Date('2026-07-15T10:00:00Z'));
  assert.equal(july.currentMonthCount, 5);
  assert.equal(july.allTimeCount, 10);
});

test('recordWebSearchUsage ignores non-positive deltas', () => {
  const dbPath = tempDbPath();
  recordWebSearchUsage(dbPath, 0, new Date('2026-06-08T10:00:00Z'));
  recordWebSearchUsage(dbPath, -4, new Date('2026-06-08T10:00:00Z'));
  const usage = readWebSearchUsage(dbPath, new Date('2026-06-08T10:00:00Z'));
  assert.equal(usage.allTimeCount, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .\tests\web-search-usage.test.ts`
Expected: FAIL — `web-search-usage.js` not found.

- [ ] **Step 3: Add the table to `src/state/runtime-db.ts`**

Immediately after the `app_config` table block closes (`);` on line 124) and before `CREATE TABLE IF NOT EXISTS runtime_status`, insert:

```sql
    CREATE TABLE IF NOT EXISTS web_search_usage (
      month TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );

```

- [ ] **Step 4: Create `src/status-server/web-search-usage.ts`**

```ts
import { getRuntimeDatabase } from '../state/runtime-db.js';

export type WebSearchUsage = {
  currentMonth: string;
  currentMonthCount: number;
  allTimeCount: number;
};

export function getUsageMonthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function recordWebSearchUsage(metricsPath: string, delta: number, at: Date): void {
  if (!Number.isFinite(delta) || delta <= 0) {
    return;
  }
  const database = getRuntimeDatabase(metricsPath);
  database.prepare(`
    INSERT INTO web_search_usage (month, count) VALUES (?, ?)
    ON CONFLICT(month) DO UPDATE SET count = count + excluded.count
  `).run(getUsageMonthKey(at), Math.trunc(delta));
}

export function readWebSearchUsage(metricsPath: string, at: Date): WebSearchUsage {
  const database = getRuntimeDatabase(metricsPath);
  const month = getUsageMonthKey(at);
  const monthRow = database
    .prepare('SELECT count FROM web_search_usage WHERE month = ?')
    .get(month) as { count: number } | undefined;
  const totalRow = database
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM web_search_usage')
    .get() as { total: number };
  return {
    currentMonth: month,
    currentMonthCount: Number(monthRow?.count ?? 0),
    allTimeCount: Number(totalRow.total ?? 0),
  };
}
```

- [ ] **Step 5: Run usage tests to verify pass**

Run: `npx tsx --test .\tests\web-search-usage.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state/runtime-db.ts src/status-server/web-search-usage.ts tests/web-search-usage.test.ts
git commit -m "feat: add web_search_usage store with monthly + all-time counts"
```

---

## Task 5: Increment usage during metrics ingestion

**Files:**
- Modify: `src/status-server/routes/core.ts` (import + two ingestion sites near lines 415 and 1309)
- Test: `tests/dashboard-status-server.test.ts`

There are two ingestion sites that call `writeMetrics(...)` after merging `metadata.toolStats`: the inline path (~line 415, `writeMetrics(ctx.metricsPath, ctx.metrics)`) and the worker path (~line 1309, `writeMetrics(metricsPath, ctx.metrics)`). Both must record usage.

- [ ] **Step 1: Write the failing test**

Add to `tests/dashboard-status-server.test.ts`. This test posts a status update carrying a `web_search` tool-call and asserts the timeseries endpoint reports it. Mirror the existing helper(s) in that file for starting the server and posting status updates — reuse whatever `postStatusUpdate`/`startTestServer` helpers already exist there rather than re-implementing. The assertion core:

```ts
test('web_search tool calls increment web search usage', async () => {
  const harness = await startTestServer();             // existing helper in this file
  try {
    await postStatusUpdate(harness, {                  // existing helper in this file
      running: false,
      requestId: 'req-websearch-1',
      metadata: {
        taskKind: 'chat',
        terminalState: true,
        requestCompleted: true,
        toolStats: { web_search: { calls: 3 } },
      },
    });

    const timeseries = await harness.getJson('/dashboard/metrics/timeseries');
    assert.equal(timeseries.webSearchUsage.allTimeCount, 3);
    assert.equal(timeseries.webSearchUsage.currentMonthCount, 3);
    assert.match(timeseries.webSearchUsage.currentMonth, /^\d{4}-\d{2}$/);
  } finally {
    await harness.close();
  }
});
```

If this file does not already expose `startTestServer`/`postStatusUpdate`/`getJson` helpers, adapt the test to the patterns it does use (search the file for how other tests post a status update and read JSON). Keep the three `assert`s on `webSearchUsage`.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .\tests\dashboard-status-server.test.ts`
Expected: FAIL — `timeseries.webSearchUsage` is `undefined`.

- [ ] **Step 3: Import the recorder in `core.ts`**

Add near the metrics import (`import { normalizeMetrics, writeMetrics, ... } from '../metrics.js';`):

```ts
import { recordWebSearchUsage } from '../web-search-usage.js';
```

- [ ] **Step 4: Record usage at the inline ingestion site (~line 415)**

Directly after `writeMetrics(ctx.metricsPath, ctx.metrics);`:

```ts
      recordWebSearchUsage(ctx.metricsPath, Number(metadata.toolStats?.web_search?.calls) || 0, new Date());
```

- [ ] **Step 5: Record usage at the worker ingestion site (~line 1309)**

Directly after `writeMetrics(metricsPath, ctx.metrics);`:

```ts
      recordWebSearchUsage(metricsPath, Number(metadata.toolStats?.web_search?.calls) || 0, new Date());
```

(If `metadata.toolStats` is typed such that `.web_search` is not indexable, use `Number((metadata.toolStats as Record<string, { calls?: number }> | undefined)?.web_search?.calls) || 0`.)

- [ ] **Step 6: Run the test (still expect the assertion to need Task 6 for the endpoint field)**

Run: `npx tsx --test .\tests\dashboard-status-server.test.ts`
Expected: still FAIL on `webSearchUsage` being undefined — the increment now happens but the endpoint does not yet return the field. Proceed to Task 6, then re-run. (Do not commit a failing test alone; commit Task 5 + Task 6 together at the end of Task 6.)

---

## Task 6: Expose usage on the timeseries endpoint

**Files:**
- Modify: `src/status-server/routes/dashboard.ts:205-216`
- Test: `tests/dashboard-status-server.test.ts` (from Task 5)

- [ ] **Step 1: Import the reader in `dashboard.ts`**

Add to the imports at the top:

```ts
import { readWebSearchUsage } from '../web-search-usage.js';
import { getMetricsPath } from '../paths.js';
```

(If `getMetricsPath` is already imported in this file, do not duplicate it.)

- [ ] **Step 2: Add `webSearchUsage` to the timeseries response (lines 205-215)**

```ts
  if (req.method === 'GET' && pathname === '/dashboard/metrics/timeseries') {
    const config = readConfig(ctx.configPath) as SiftConfig;
    const days = buildDashboardDailyMetrics(
      runtimeRoot,
      idleSummaryDatabase,
      ctx.metrics
    );
    const taskDays = buildDashboardTaskDailyMetrics(idleSummaryDatabase, ctx.metrics);
    const toolStats = buildDashboardToolStats(idleSummaryDatabase, ctx.metrics, config);
    const webSearchUsage = readWebSearchUsage(getMetricsPath(), new Date());
    sendJson(res, 200, { days, taskDays, toolStats, webSearchUsage });
    return true;
  }
```

- [ ] **Step 3: Run the ingestion + endpoint test to verify pass**

Run: `npx tsx --test .\tests\dashboard-status-server.test.ts`
Expected: the new `web_search tool calls increment web search usage` test PASSES.

- [ ] **Step 4: Commit (Tasks 5 + 6)**

```bash
git add src/status-server/routes/core.ts src/status-server/routes/dashboard.ts tests/dashboard-status-server.test.ts
git commit -m "feat: record and expose web search usage counts"
```

---

## Task 7: Dashboard types + Web Search settings section

**Files:**
- Modify: `dashboard/src/types.ts:117-121, 381-389`
- Modify: `dashboard/src/settings-sections.ts:1-6, 26-32, 34, end`
- Modify: `dashboard/src/tabs/SettingsTab.tsx`
- Modify: `dashboard/src/App.tsx:483-485, 1268, 1307`
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `dashboard/tests/tab-components.test.tsx`. Reuse the file's existing render harness and a `DashboardConfig` factory if present; otherwise build a minimal config object matching `DashboardConfig`. Core assertions:

```ts
test('SettingsTab web-search section renders Brave key (masked) and usage', () => {
  const config = makeDashboardConfig();                 // existing/local factory
  config.WebSearch = {
    EnabledDefault: true,
    Provider: 'brave',
    BraveApiKey: 'secret-key',
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  };
  const html = renderSettingsTab({                      // existing/local render helper
    config,
    activeSettingsSection: 'web-search',
    webSearchUsage: { currentMonth: '2026-06', currentMonthCount: 12, allTimeCount: 99 },
  });
  assert.match(html, /Brave API key/);
  assert.match(html, /type="password"/);                // key field is masked
  assert.match(html, /12/);                             // current-month usage
  assert.match(html, /99/);                             // all-time usage
});
```

Match the file's actual render utility (search for how `SettingsTab` is currently rendered to string in this test file — e.g. `renderToStaticMarkup`). Pass the new `webSearchUsage` prop through whatever props object the existing helper uses.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .\dashboard\tests\tab-components.test.tsx`
Expected: FAIL — `'web-search'` is not a valid `SettingsSectionId`; `webSearchUsage` prop unknown.

- [ ] **Step 3: Update `dashboard/src/types.ts`**

`MetricsResponse` (lines 117-121):

```ts
export type MetricsResponse = {
  days: MetricDay[];
  taskDays: TaskMetricDay[];
  toolStats: ToolStatsByTask;
  webSearchUsage: WebSearchUsage;
};

export type WebSearchUsage = {
  currentMonth: string;
  currentMonthCount: number;
  allTimeCount: number;
};
```

`DashboardWebSearchConfig` (lines 381-389):

```ts
export type DashboardWebSearchConfig = {
  EnabledDefault: boolean;
  Provider: 'brave';
  BraveApiKey: string;
  ResultCount: number;
  FetchMaxPages: number;
  TimeoutMs: number;
  FetchMaxCharacters: number;
};
```

- [ ] **Step 4: Update `dashboard/src/settings-sections.ts`**

Add `'web-search'` to the union (lines 1-6):

```ts
export type SettingsSectionId =
  | 'general'
  | 'tool-policy'
  | 'presets'
  | 'interactive'
  | 'web-search'
  | 'model-presets';
```

Add to `SETTINGS_SECTION_ORDER` (after `'interactive'`):

```ts
  'interactive',
  'web-search',
  'model-presets',
```

Add the section descriptor to `SETTINGS_SECTIONS` (insert before `'model-presets'`):

```ts
  'web-search': {
    id: 'web-search',
    icon: 'W',
    title: 'Web Search',
    summary: 'Brave Search provider, API key, result limits, and usage.',
    fields: [
      { label: 'Provider', layout: 'half', helpText: 'Web search backend. Brave is the only provider today.' },
      { label: 'Web search enabled by default', layout: 'half', helpText: 'Whether new chat/research sessions start with web search turned on.' },
      { label: 'Brave API key', layout: 'full', helpText: 'Subscription token from the Brave Search API dashboard. Sent as the X-Subscription-Token header; never written to logs.' },
      { label: 'Result count', layout: 'quarter', helpText: 'Number of results requested per search (Brave allows 1-20).' },
      { label: 'Timeout ms', layout: 'quarter', helpText: 'Per-request timeout for Brave search and page fetches.' },
      { label: 'Fetch max pages', layout: 'quarter', helpText: 'Maximum pages a single research step will fetch.' },
      { label: 'Fetch max characters', layout: 'quarter', helpText: 'Maximum characters retained from a fetched page.' },
      { label: 'Usage', layout: 'full', helpText: 'Searches executed this calendar month and all-time.' },
    ],
  },
```

- [ ] **Step 5: Render the section in `dashboard/src/tabs/SettingsTab.tsx`**

Add `WebSearchUsage` to the imported types from `../types` and add a prop:

```ts
import type { DashboardConfig, DashboardManagedLlamaPreset, DashboardPreset, WebSearchUsage } from '../types';
```

Add to `SettingsTabProps`:

```ts
  webSearchUsage: WebSearchUsage | null;
```

Destructure it in the component body alongside the other props (`const { ..., webSearchUsage } = props;`).

Add a reveal-state hook at the top of the component:

```ts
  const [showBraveKey, setShowBraveKey] = React.useState(false);
```

Add the render function (next to `renderInteractiveSection`):

```ts
  const renderWebSearchSection = (): ReactNode => {
    if (!dashboardConfig) {
      return null;
    }
    const web = dashboardConfig.WebSearch;
    return (
      <div className="settings-live-grid">
        {renderField('web-search', 'Provider', (
          <select
            value={web.Provider}
            onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.Provider = event.target.value as 'brave'; })}
          >
            <option value="brave">brave</option>
          </select>
        ))}
        {renderField('web-search', 'Web search enabled by default', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={web.EnabledDefault}
              onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.EnabledDefault = event.target.checked; })}
            />
            <span>{web.EnabledDefault ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('web-search', 'Brave API key', (
          <div className="settings-live-nav-control">
            <input
              type={showBraveKey ? 'text' : 'password'}
              value={web.BraveApiKey}
              onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.BraveApiKey = event.target.value; })}
            />
            <button type="button" onClick={() => setShowBraveKey((value) => !value)}>
              {showBraveKey ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
        {renderField('web-search', 'Result count', (
          <input
            type="number"
            value={web.ResultCount}
            onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.ResultCount = parseIntegerInput(event.target.value, next.WebSearch.ResultCount); })}
          />
        ))}
        {renderField('web-search', 'Timeout ms', (
          <input
            type="number"
            value={web.TimeoutMs}
            onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.TimeoutMs = parseIntegerInput(event.target.value, next.WebSearch.TimeoutMs); })}
          />
        ))}
        {renderField('web-search', 'Fetch max pages', (
          <input
            type="number"
            value={web.FetchMaxPages}
            onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.FetchMaxPages = parseIntegerInput(event.target.value, next.WebSearch.FetchMaxPages); })}
          />
        ))}
        {renderField('web-search', 'Fetch max characters', (
          <input
            type="number"
            value={web.FetchMaxCharacters}
            onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.FetchMaxCharacters = parseIntegerInput(event.target.value, next.WebSearch.FetchMaxCharacters); })}
          />
        ))}
        {renderField('web-search', 'Usage', (
          <span>
            {webSearchUsage
              ? `${formatNumber(webSearchUsage.currentMonthCount)} this month (${webSearchUsage.currentMonth}) / ${formatNumber(webSearchUsage.allTimeCount)} all-time`
              : 'No usage recorded yet.'}
          </span>
        ))}
      </div>
    );
  };
```

Ensure `formatNumber` is imported from `../lib/format` (the file already imports `parseIntegerInput`/`parseFloatInput` from there; add `formatNumber` to that import).

Wire it into `renderSettingsSection`, before the final `model-presets` fallback:

```ts
    if (activeSettingsSection === 'interactive') return renderInteractiveSection();
    if (activeSettingsSection === 'web-search') return renderWebSearchSection();
    return (
      <ManagedLlamaSection
```

- [ ] **Step 6: Pass `webSearchUsage` from `App.tsx`**

Add state near the other metrics state (line ~120):

```ts
  const [webSearchUsage, setWebSearchUsage] = useState<WebSearchUsage | null>(null);
```

Import `WebSearchUsage` from `./types` in App.tsx's type imports.

Set it where metrics are applied (lines 483-485):

```ts
          setMetrics(response.days);
          setTaskMetrics(Array.isArray(response.taskDays) ? response.taskDays : []);
          setToolMetrics(response.toolStats || null);
          setWebSearchUsage(response.webSearchUsage || null);
```

Pass to `<SettingsTab>` (line ~1307) as a prop:

```tsx
          webSearchUsage={webSearchUsage}
```

- [ ] **Step 7: Run the settings test**

Run: `npx tsx --test .\dashboard\tests\tab-components.test.tsx`
Expected: the new web-search settings test PASSES.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/types.ts dashboard/src/settings-sections.ts dashboard/src/tabs/SettingsTab.tsx dashboard/src/App.tsx dashboard/tests/tab-components.test.tsx
git commit -m "feat: add Web Search settings section with Brave key and usage"
```

---

## Task 8: MetricsTab usage card

**Files:**
- Modify: `dashboard/src/tabs/MetricsTab.tsx:12-28`
- Modify: `dashboard/src/App.tsx:1268` (`<MetricsTab>` props)
- Test: `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `dashboard/tests/tab-components.test.tsx`, using the file's existing MetricsTab render helper:

```ts
test('MetricsTab renders the web search usage card', () => {
  const html = renderMetricsTab({                       // existing/local render helper
    metrics: [],
    idleSummarySnapshots: [],
    recentIdlePoints: [],
    latestIdleSnapshot: null,
    sortedToolMetricRows: [],
    taskRunsGraphSeries: [],
    webSearchUsage: { currentMonth: '2026-06', currentMonthCount: 7, allTimeCount: 42 },
  });
  assert.match(html, /Web Search/);
  assert.match(html, /7/);
  assert.match(html, /42/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test .\dashboard\tests\tab-components.test.tsx`
Expected: FAIL — `webSearchUsage` is not a `MetricsTabProps` field.

- [ ] **Step 3: Add the prop + card to `MetricsTab.tsx`**

Extend the imports:

```ts
import type { IdleSummarySnapshot, MetricDay, WebSearchUsage } from '../types';
```

Extend `MetricsTabProps`:

```ts
  taskRunsGraphSeries: InteractiveSeries[];
  webSearchUsage: WebSearchUsage | null;
```

Destructure `webSearchUsage` in the component signature. Add a card inside the `idle-top-row` section, after the `Tool Metrics` `</section>` and before the closing `</div>` of `idle-top-row`:

```tsx
          <section className="idle-summary-panel idle-summary-compact">
            <h3>Web Search</h3>
            {webSearchUsage ? (
              <div className="idle-summary-cards">
                <article className="idle-card throughput">
                  <span>This month ({webSearchUsage.currentMonth})</span>
                  <strong>{formatNumber(webSearchUsage.currentMonthCount)}</strong>
                  <span>All-time: {formatNumber(webSearchUsage.allTimeCount)}</span>
                </article>
              </div>
            ) : (
              <p className="hint">No searches recorded yet.</p>
            )}
          </section>
```

(`formatNumber` is already imported in MetricsTab.)

- [ ] **Step 4: Pass the prop from `App.tsx` (`<MetricsTab>` ~line 1268)**

```tsx
          webSearchUsage={webSearchUsage}
```

- [ ] **Step 5: Run the test to verify pass**

Run: `npx tsx --test .\dashboard\tests\tab-components.test.tsx`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/tabs/MetricsTab.tsx dashboard/src/App.tsx dashboard/tests/tab-components.test.tsx
git commit -m "feat: show web search usage card on the metrics tab"
```

---

## Task 9: Full typecheck + suite + build

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run: `npm run typecheck`
Expected: no errors. Fix any residual `searxng`/`SearxngBaseUrl`/`duckduckgo` references the compiler surfaces (e.g. lingering `WebSearchResult.source` comparisons). Search the repo for `searxng`, `duckduckgo`, `SearxngBaseUrl` (case-insensitive) and remove dead references in `.ts`/`.tsx` only.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: PASS. (`npm test` runs `typecheck:test`, `build:test`, then the compiled runner — this also regenerates `.js`/`.d.ts` artifacts.)

- [ ] **Step 3: Build (regenerates dashboard + dist artifacts)**

Run: `npm run build`
Expected: completes without errors.

- [ ] **Step 4: Commit any regenerated artifacts**

```bash
git add -A
git commit -m "chore: rebuild artifacts for Brave web search"
```

---

## Self-Review Notes

- **Spec coverage:** provider seam (T2/T3), Brave impl (T2), config (T1), usage store (T4), ingestion increment (T5), endpoint (T6), settings page incl. masked key + provider dropdown + usage (T7), metrics card (T8). All spec sections mapped.
- **Type consistency:** `WebSearchProviderId` = `'brave'`; `WebSearchConfig.Provider` uses it; `createWebSearchProvider`, `BraveSearchProvider.id`, `WebSearchResult.source`, and dashboard `DashboardWebSearchConfig.Provider` all agree. `WebSearchUsage` shape (`currentMonth`/`currentMonthCount`/`allTimeCount`) is identical in `web-search-usage.ts` and `dashboard/src/types.ts`.
- **No fallback:** empty Brave key throws; unknown provider throws; no searxng/ddg code remains.
- **Key safety:** key travels in the `X-Subscription-Token` header; `logHttpClientBoundary` logs only method + path, so it is never logged.
