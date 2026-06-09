# Tavily + Firecrawl Web Search & Local Page Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Brave web-search provider and replace it with two failover search providers (Tavily primary, Firecrawl fallback), a fully-local Readability+Turndown page loader, and a dashboard that reports remote provider quota (used/limit/remaining).

**Architecture:** `WebSearchConfig` becomes a per-provider record (`Providers: Record<id, {Enabled, ApiKey}>` + `ProviderOrder`). `WebSearchService` walks `createWebSearchProviders(config)` and fails over to the next provider on any error. `WebFetchService` fetches HTML through the existing `HttpClient` (manual redirect loop + per-hop SSRF guard) and converts it to markdown locally via `jsdom` → `@mozilla/readability` → `turndown`. A new `readWebSearchQuotas` + `/dashboard/web-search-quota` route exposes provider credit usage, fetched by the dashboard on Metrics/Settings tab mount only.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:test`, `undici` HttpClient, React dashboard, `jsdom`/`@mozilla/readability`/`turndown`, better-sqlite3 (local usage, unchanged).

**Reference spec:** `docs/superpowers/specs/2026-06-09-tavily-firecrawl-web-search-design.md`

**Commands:**
- Fast single-test iteration: `npx tsx --test .\tests\web-search.test.ts`
- Typecheck: `npm run typecheck`
- Full suite: `npm test`

---

## File Structure

**Create:**
- `src/web-search/tavily-search-provider.ts` — Tavily search + quota
- `src/web-search/firecrawl-search-provider.ts` — Firecrawl search + quota
- `src/status-server/web-search-quota.ts` — aggregates `getQuota` across active providers

**Modify:**
- `src/web-search/types.ts`, `src/config/types.ts`, `dashboard/src/types.ts` — config shape + `ProviderQuota`
- `src/web-search/web-search-provider-base.ts` — add `getQuota` + shared parse helpers
- `src/web-search/web-search-provider.ts` — `createWebSearchProviders`
- `src/web-search/web-search-service.ts` — failover loop
- `src/web-search/web-research-tools.ts` — `providers?` param
- `src/web-search/web-fetch-service.ts` — Readability/Turndown loader
- `src/config/defaults.ts`, `src/status-server/config-store.ts`, `src/repo-search/engine.ts` — defaults + normalizer
- `src/status-server/routes/dashboard.ts` — quota route
- `dashboard/src/api.ts`, `dashboard/src/App.tsx`, `dashboard/src/settings-sections.ts`, `dashboard/src/tabs/SettingsTab.tsx`, `dashboard/src/tabs/MetricsTab.tsx`
- Tests: `tests/web-search.test.ts`, `tests/config-normalization.test.ts`, `tests/dashboard-status-server.test.ts`, `tests/repo-search-chat-execute.test.ts`, `tests/repo-search-loop.core.test.ts`, `tests/settings-sections.test.ts`, `dashboard/tests/tab-components.test.tsx`

**Delete:**
- `src/web-search/brave-search-provider.ts`
- `src/web-search/html-text.ts`

---

## Phase 1 — Config foundation

### Task 1: Web-search config types + ProviderQuota

**Files:**
- Modify: `src/web-search/types.ts`

- [ ] **Step 1: Replace the top of `src/web-search/types.ts`**

Replace lines 1–29 (the `WebSearchProviderId`, `WebSearchConfig`, and `WebSearchResult` blocks) so the file reads:

```ts
export type WebSearchProviderId = 'tavily' | 'firecrawl';

export type WebSearchProviderSettings = {
  Enabled: boolean;
  ApiKey: string;
};

export type WebSearchConfig = {
  EnabledDefault: boolean;
  Providers: Record<WebSearchProviderId, WebSearchProviderSettings>;
  ProviderOrder: WebSearchProviderId[];
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

export type ProviderQuota = {
  provider: WebSearchProviderId;
  used: number | null;
  limit: number | null;
  remaining: number | null;
};
```

Leave the existing `WebFetchResult` and `WebToolExecutionResult` types (currently lines 31–43) unchanged.

- [ ] **Step 2: Typecheck (expect failures elsewhere)**

Run: `npm run typecheck`
Expected: FAILS in `brave-search-provider.ts`, `config/types.ts`, `defaults.ts`, `config-store.ts`, `engine.ts`, `web-search-provider*.ts` — these are fixed in later tasks. Confirm `types.ts` itself reports no error.

- [ ] **Step 3: Commit**

```bash
git add src/web-search/types.ts
git commit -m "feat: model web search config as per-provider record with quota type"
```

### Task 2: Mirror config type in `src/config/types.ts`

**Files:**
- Modify: `src/config/types.ts:100-108`

- [ ] **Step 1: Replace the `WebSearchConfig` block**

```ts
export type WebSearchProviderId = 'tavily' | 'firecrawl';

export type WebSearchProviderSettings = {
  Enabled: boolean;
  ApiKey: string;
};

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

- [ ] **Step 2: Commit**

```bash
git add src/config/types.ts
git commit -m "feat: mirror web search config shape in config types"
```

### Task 3: Defaults + normalizer (config-store) — TDD

**Files:**
- Test: `tests/config-normalization.test.ts:19-53`, `tests/dashboard-status-server.test.ts:29-40`
- Modify: `src/config/defaults.ts:98-106`, `src/status-server/config-store.ts:34-42` and `138-151`

- [ ] **Step 1: Rewrite the failing normalization tests**

In `tests/config-normalization.test.ts` replace the two `WebSearch` tests (lines 19–53) with:

```ts
test('normalizeConfig produces default WebSearch config', () => {
  const normalized = normalizeConfig(getDefaultConfig());
  assert.deepEqual(normalized.WebSearch, {
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: false, ApiKey: '' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  });
});

test('normalizeConfig clamps WebSearch bounds, trims keys, and repairs ProviderOrder', () => {
  const config = getDefaultConfig() as Dict;
  config.WebSearch = {
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: '  t-key  ' },
      firecrawl: { Enabled: 'yes', ApiKey: 42 },
    },
    ProviderOrder: ['firecrawl', 'bing', 'firecrawl'],
    ResultCount: 99,
    FetchMaxPages: 0,
    TimeoutMs: 10,
    FetchMaxCharacters: 999999,
  };
  const normalized = normalizeConfig(config);
  assert.deepEqual(normalized.WebSearch, {
    EnabledDefault: true,
    Providers: {
      tavily: { Enabled: true, ApiKey: 't-key' },
      firecrawl: { Enabled: false, ApiKey: '' },
    },
    ProviderOrder: ['firecrawl', 'tavily'],
    ResultCount: 20,
    FetchMaxPages: 1,
    TimeoutMs: 1000,
    FetchMaxCharacters: 50000,
  });
});
```

In `tests/dashboard-status-server.test.ts` replace the two normalizer tests (lines 29–40) with:

```ts
test('normalizeWebSearchConfig produces provider defaults and clamps ResultCount to 20', () => {
  const normalized = normalizeWebSearchConfig({ ResultCount: 999, Providers: { tavily: { Enabled: true, ApiKey: '  abc  ' } } });
  assert.deepEqual(normalized.ProviderOrder, ['tavily', 'firecrawl']);
  assert.equal(normalized.ResultCount, 20);
  assert.deepEqual(normalized.Providers, {
    tavily: { Enabled: true, ApiKey: 'abc' },
    firecrawl: { Enabled: false, ApiKey: '' },
  });
});

test('normalizeWebSearchConfig defaults empty provider records', () => {
  const normalized = normalizeWebSearchConfig({});
  assert.deepEqual(normalized.Providers, {
    tavily: { Enabled: false, ApiKey: '' },
    firecrawl: { Enabled: false, ApiKey: '' },
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx tsx --test .\tests\config-normalization.test.ts`
Expected: FAIL (assertion mismatch — current normalizer still emits `Provider`/`BraveApiKey`).

- [ ] **Step 3: Update `src/config/defaults.ts`**

Replace the `WebSearch` block (lines 98–106) with:

```ts
    WebSearch: {
      EnabledDefault: true,
      Providers: {
        tavily: { Enabled: false, ApiKey: '' },
        firecrawl: { Enabled: false, ApiKey: '' },
      },
      ProviderOrder: ['tavily', 'firecrawl'],
      ResultCount: 5,
      FetchMaxPages: 3,
      TimeoutMs: 15000,
      FetchMaxCharacters: 12000,
    },
```

- [ ] **Step 4: Update `DEFAULT_WEB_SEARCH_CONFIG` in `src/status-server/config-store.ts`**

Replace lines 34–42 with:

```ts
export const WEB_SEARCH_PROVIDER_IDS = ['tavily', 'firecrawl'] as const;

export const DEFAULT_WEB_SEARCH_CONFIG = {
  EnabledDefault: true,
  Providers: {
    tavily: { Enabled: false, ApiKey: '' },
    firecrawl: { Enabled: false, ApiKey: '' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
} as const;
```

- [ ] **Step 5: Rewrite `normalizeWebSearchConfig` (lines 138–151)**

```ts
function normalizeProviderSettings(value: unknown): Dict {
  const record = (value && typeof value === 'object' && !Array.isArray(value)) ? value as Dict : {};
  return {
    Enabled: record.Enabled === true,
    ApiKey: getNullableTrimmedString(record.ApiKey) || '',
  };
}

function normalizeProviderOrder(value: unknown): string[] {
  const known = WEB_SEARCH_PROVIDER_IDS as readonly string[];
  const requested = Array.isArray(value) ? value.map((entry) => String(entry || '').trim()) : [];
  const ordered = requested.filter((id, index) => known.includes(id) && requested.indexOf(id) === index);
  for (const id of known) {
    if (!ordered.includes(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

export function normalizeWebSearchConfig(value: unknown): Dict {
  const record = (value && typeof value === 'object' && !Array.isArray(value)) ? value as Dict : {};
  const providersInput = (record.Providers && typeof record.Providers === 'object' && !Array.isArray(record.Providers))
    ? record.Providers as Dict
    : {};
  return {
    EnabledDefault: typeof record.EnabledDefault === 'boolean'
      ? record.EnabledDefault
      : DEFAULT_WEB_SEARCH_CONFIG.EnabledDefault,
    Providers: {
      tavily: normalizeProviderSettings(providersInput.tavily),
      firecrawl: normalizeProviderSettings(providersInput.firecrawl),
    },
    ProviderOrder: normalizeProviderOrder(record.ProviderOrder),
    ResultCount: clampInteger(record.ResultCount, DEFAULT_WEB_SEARCH_CONFIG.ResultCount, 1, 20),
    FetchMaxPages: clampInteger(record.FetchMaxPages, DEFAULT_WEB_SEARCH_CONFIG.FetchMaxPages, 1, 8),
    TimeoutMs: clampInteger(record.TimeoutMs, DEFAULT_WEB_SEARCH_CONFIG.TimeoutMs, 1000, 60000),
    FetchMaxCharacters: clampInteger(record.FetchMaxCharacters, DEFAULT_WEB_SEARCH_CONFIG.FetchMaxCharacters, 1000, 50000),
  };
}
```

- [ ] **Step 6: Run both test files, verify pass**

Run: `npx tsx --test .\tests\config-normalization.test.ts .\tests\dashboard-status-server.test.ts`
Expected: the four rewritten tests PASS. (Other `dashboard-status-server` tests using the old `WebSearch` literal are fixed in Task 4/21.)

- [ ] **Step 7: Commit**

```bash
git add src/config/defaults.ts src/status-server/config-store.ts tests/config-normalization.test.ts tests/dashboard-status-server.test.ts
git commit -m "feat: normalize per-provider web search config with order repair"
```

### Task 4: Repo-search engine default literal

**Files:**
- Modify: `src/repo-search/engine.ts:120-128`

- [ ] **Step 1: Replace `DEFAULT_ENGINE_WEB_SEARCH_CONFIG`**

```ts
const DEFAULT_ENGINE_WEB_SEARCH_CONFIG: WebSearchConfig = {
  EnabledDefault: false,
  Providers: {
    tavily: { Enabled: false, ApiKey: '' },
    firecrawl: { Enabled: false, ApiKey: '' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/repo-search/engine.ts
git commit -m "feat: update repo-search engine web search default to provider record"
```

---

## Phase 2 — Search providers

### Task 5: Provider base — add `getQuota` + shared parse helpers

**Files:**
- Modify: `src/web-search/web-search-provider-base.ts`

- [ ] **Step 1: Replace the whole file**

```ts
import type { Dict } from '../lib/types.js';
import type { HttpClient } from '../lib/http-client.js';
import type { ProviderQuota, WebSearchProviderId, WebSearchResult, WebSearchToolArgs } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

export type WebSearchProviderOptions = {
  resultCount: number;
  timeoutMs: number;
  client: HttpClient;
};

export abstract class WebSearchProvider {
  abstract readonly id: WebSearchProviderId;
  abstract search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]>;
  abstract getQuota(opts: WebSearchProviderOptions): Promise<ProviderQuota>;
}

export function asRecord(value: unknown): Dict {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {};
}

export function getText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toWebSearchResult(
  title: string,
  url: string,
  snippet: string,
  source: WebSearchProviderId,
): WebSearchResult | null {
  if (!title || !url) {
    return null;
  }
  try {
    assertPublicHttpUrl(url);
  } catch {
    return null;
  }
  return { title, url, snippet, source };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web-search/web-search-provider-base.ts
git commit -m "feat: add getQuota contract and shared provider parse helpers"
```

### Task 6: Tavily provider — TDD

**Files:**
- Create: `src/web-search/tavily-search-provider.ts`
- Test: `tests/web-search.test.ts`

> Tasks 6–9 collectively rewrite `tests/web-search.test.ts`. Replace the entire file in Task 9 Step 1 with the consolidated version shown there. For Task 6 work against the consolidated file's Tavily tests; if iterating before Task 9, you may temporarily add just the Tavily tests. The canonical full test file lives in Task 9.

- [ ] **Step 1: Write `src/web-search/tavily-search-provider.ts`**

```ts
import type { Dict } from '../lib/types.js';
import {
  WebSearchProvider,
  asRecord,
  getNumber,
  getText,
  toWebSearchResult,
  type WebSearchProviderOptions,
} from './web-search-provider-base.js';
import type { ProviderQuota, WebSearchResult, WebSearchToolArgs } from './types.js';

const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_USAGE_ENDPOINT = 'https://api.tavily.com/usage';

export class TavilySearchProvider extends WebSearchProvider {
  readonly id = 'tavily' as const;

  constructor(private readonly apiKey: string) {
    super();
  }

  private authHeaders(): Record<string, string> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) {
      throw new Error('Tavily API key not configured.');
    }
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]> {
    const headers = this.authHeaders();
    const body: Dict = { query: args.query, max_results: opts.resultCount, search_depth: 'basic' };
    if (args.timeFilter) {
      body.time_range = args.timeFilter;
    }
    const response = await opts.client.fetch(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Tavily search failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as Dict;
    const results = Array.isArray(payload.results) ? payload.results : [];
    return results
      .map((entry) => {
        const record = asRecord(entry);
        return toWebSearchResult(getText(record.title), getText(record.url), getText(record.content), 'tavily');
      })
      .filter((entry): entry is WebSearchResult => entry !== null);
  }

  async getQuota(opts: WebSearchProviderOptions): Promise<ProviderQuota> {
    const headers = this.authHeaders();
    const response = await opts.client.fetch(TAVILY_USAGE_ENDPOINT, {
      method: 'GET',
      timeoutMs: opts.timeoutMs,
      headers,
    });
    if (!response.ok) {
      throw new Error(`Tavily usage failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as Dict;
    const account = asRecord(payload.account);
    const used = getNumber(account.plan_usage);
    const limit = getNumber(account.plan_limit);
    const remaining = used !== null && limit !== null ? limit - used : null;
    return { provider: 'tavily', used, limit, remaining };
  }
}
```

- [ ] **Step 2: Run Tavily tests, verify pass (after Task 9 file is in place)**

Run: `npx tsx --test .\tests\web-search.test.ts`
Expected: Tavily-named tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web-search/tavily-search-provider.ts
git commit -m "feat: add Tavily search provider with quota lookup"
```

### Task 7: Firecrawl provider — TDD

**Files:**
- Create: `src/web-search/firecrawl-search-provider.ts`

- [ ] **Step 1: Write `src/web-search/firecrawl-search-provider.ts`**

```ts
import type { Dict } from '../lib/types.js';
import {
  WebSearchProvider,
  asRecord,
  getNumber,
  getText,
  toWebSearchResult,
  type WebSearchProviderOptions,
} from './web-search-provider-base.js';
import type { ProviderQuota, WebSearchResult, WebSearchToolArgs } from './types.js';

const FIRECRAWL_SEARCH_ENDPOINT = 'https://api.firecrawl.dev/v1/search';
const FIRECRAWL_CREDIT_ENDPOINT = 'https://api.firecrawl.dev/v1/team/credit-usage';

const TBS_BY_TIME_FILTER: Record<NonNullable<WebSearchToolArgs['timeFilter']>, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

export class FirecrawlSearchProvider extends WebSearchProvider {
  readonly id = 'firecrawl' as const;

  constructor(private readonly apiKey: string) {
    super();
  }

  private authHeaders(): Record<string, string> {
    const apiKey = this.apiKey.trim();
    if (!apiKey) {
      throw new Error('Firecrawl API key not configured.');
    }
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  }

  async search(args: WebSearchToolArgs, opts: WebSearchProviderOptions): Promise<WebSearchResult[]> {
    const headers = this.authHeaders();
    const body: Dict = { query: args.query, limit: opts.resultCount };
    if (args.timeFilter) {
      body.tbs = TBS_BY_TIME_FILTER[args.timeFilter];
    }
    const response = await opts.client.fetch(FIRECRAWL_SEARCH_ENDPOINT, {
      method: 'POST',
      timeoutMs: opts.timeoutMs,
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Firecrawl search failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as Dict;
    if (payload.success === false) {
      throw new Error(`Firecrawl search failed with HTTP ${response.status}.`);
    }
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data
      .map((entry) => {
        const record = asRecord(entry);
        return toWebSearchResult(getText(record.title), getText(record.url), getText(record.description), 'firecrawl');
      })
      .filter((entry): entry is WebSearchResult => entry !== null);
  }

  async getQuota(opts: WebSearchProviderOptions): Promise<ProviderQuota> {
    const headers = this.authHeaders();
    const response = await opts.client.fetch(FIRECRAWL_CREDIT_ENDPOINT, {
      method: 'GET',
      timeoutMs: opts.timeoutMs,
      headers,
    });
    if (!response.ok) {
      throw new Error(`Firecrawl usage failed with HTTP ${response.status}.`);
    }
    const payload = await response.json() as Dict;
    const data = asRecord(payload.data);
    const remaining = getNumber(data.remaining_credits);
    const limit = getNumber(data.plan_credits);
    const used = remaining !== null && limit !== null ? limit - remaining : null;
    return { provider: 'firecrawl', used, limit, remaining };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web-search/firecrawl-search-provider.ts
git commit -m "feat: add Firecrawl search provider with credit-usage lookup"
```

### Task 8: Factory `createWebSearchProviders`

**Files:**
- Modify: `src/web-search/web-search-provider.ts`

- [ ] **Step 1: Replace the whole file**

```ts
import { TavilySearchProvider } from './tavily-search-provider.js';
import { FirecrawlSearchProvider } from './firecrawl-search-provider.js';
import type { WebSearchConfig, WebSearchProviderId } from './types.js';
import { WebSearchProvider, type WebSearchProviderOptions } from './web-search-provider-base.js';

export { WebSearchProvider, type WebSearchProviderOptions };

function buildProvider(id: WebSearchProviderId, apiKey: string): WebSearchProvider {
  if (id === 'tavily') {
    return new TavilySearchProvider(apiKey);
  }
  if (id === 'firecrawl') {
    return new FirecrawlSearchProvider(apiKey);
  }
  throw new Error(`Unsupported web search provider: ${String(id)}`);
}

export function createWebSearchProviders(config: WebSearchConfig): WebSearchProvider[] {
  return config.ProviderOrder
    .filter((id) => config.Providers[id]?.Enabled && config.Providers[id].ApiKey.trim())
    .map((id) => buildProvider(id, config.Providers[id].ApiKey));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web-search/web-search-provider.ts
git commit -m "feat: build ordered web search provider chain from config"
```

### Task 9: Failover service + tools + consolidated test rewrite — TDD

**Files:**
- Modify: `src/web-search/web-search-service.ts`, `src/web-search/web-research-tools.ts`
- Test: `tests/web-search.test.ts` (full rewrite)

- [ ] **Step 1: Replace `tests/web-search.test.ts` entirely**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicHttpUrl } from '../src/web-search/url-safety.js';
import { WebSearchService } from '../src/web-search/web-search-service.js';
import { WebFetchService } from '../src/web-search/web-fetch-service.js';
import { WebResearchTools } from '../src/web-search/web-research-tools.js';
import { TavilySearchProvider } from '../src/web-search/tavily-search-provider.js';
import { FirecrawlSearchProvider } from '../src/web-search/firecrawl-search-provider.js';
import { createWebSearchProviders, WebSearchProvider, type WebSearchProviderOptions } from '../src/web-search/web-search-provider.js';
import type { ProviderQuota, WebSearchConfig, WebSearchResult, WebSearchToolArgs } from '../src/web-search/types.js';
import type { HttpClient } from '../src/lib/http-client.js';

const webConfig: WebSearchConfig = {
  EnabledDefault: false,
  Providers: {
    tavily: { Enabled: true, ApiKey: 'test-key' },
    firecrawl: { Enabled: true, ApiKey: 'fc-key' },
  },
  ProviderOrder: ['tavily', 'firecrawl'],
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function opts(client: StubHttpClient): WebSearchProviderOptions {
  return { resultCount: 2, timeoutMs: 15000, client: client as unknown as HttpClient };
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

test('createWebSearchProviders returns enabled providers in order', () => {
  const providers = createWebSearchProviders(webConfig);
  assert.equal(providers.length, 2);
  assert.ok(providers[0] instanceof TavilySearchProvider);
  assert.ok(providers[1] instanceof FirecrawlSearchProvider);
});

test('createWebSearchProviders skips disabled or keyless providers', () => {
  const providers = createWebSearchProviders({
    ...webConfig,
    Providers: { tavily: { Enabled: true, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: 'fc' } },
  });
  assert.equal(providers.length, 0);
});

test('TavilySearchProvider posts body, sends Bearer key, and normalizes content', async () => {
  const client = new StubHttpClient(async () => jsonResponse({
    results: [
      { title: 'One', url: 'https://example.com/1', content: 'First result.' },
      { title: 'Two', url: 'https://example.com/2', content: 'Second result.' },
      { title: '', url: 'https://example.com/3', content: 'drop me' },
    ],
  }));
  const provider = new TavilySearchProvider('test-key');

  const results = await provider.search({ query: 'siftkit', timeFilter: 'week' }, opts(client));

  const call = client.calls[0];
  assert.match(call.url, /api\.tavily\.com\/search/);
  assert.equal(call.init?.method, 'POST');
  const sent = JSON.parse(String(call.init?.body));
  assert.equal(sent.query, 'siftkit');
  assert.equal(sent.max_results, 2);
  assert.equal(sent.search_depth, 'basic');
  assert.equal(sent.time_range, 'week');
  assert.equal(new Headers(call.init?.headers).get('authorization'), 'Bearer test-key');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { title: 'One', url: 'https://example.com/1', snippet: 'First result.', source: 'tavily' });
});

test('TavilySearchProvider throws when key missing and on non-2xx', async () => {
  await assert.rejects(
    () => new TavilySearchProvider('').search({ query: 'x' }, opts(new StubHttpClient(async () => jsonResponse({})))),
    /Tavily API key not configured/,
  );
  await assert.rejects(
    () => new TavilySearchProvider('k').search({ query: 'x' }, opts(new StubHttpClient(async () => jsonResponse({}, 429)))),
    /Tavily search failed with HTTP 429/,
  );
});

test('TavilySearchProvider getQuota parses plan usage and limit', async () => {
  const client = new StubHttpClient(async () => jsonResponse({ account: { plan_usage: 120, plan_limit: 1000 } }));
  const quota = await new TavilySearchProvider('k').getQuota(opts(client));
  assert.deepEqual(quota, { provider: 'tavily', used: 120, limit: 1000, remaining: 880 });
});

test('TavilySearchProvider getQuota returns nulls when fields absent', async () => {
  const client = new StubHttpClient(async () => jsonResponse({ account: {} }));
  const quota = await new TavilySearchProvider('k').getQuota(opts(client));
  assert.deepEqual(quota, { provider: 'tavily', used: null, limit: null, remaining: null });
});

test('FirecrawlSearchProvider posts limit + tbs and normalizes description', async () => {
  const client = new StubHttpClient(async () => jsonResponse({
    success: true,
    data: [{ title: 'Doc', url: 'https://example.com/d', description: 'Desc.' }],
  }));
  const provider = new FirecrawlSearchProvider('fc-key');

  const results = await provider.search({ query: 'q', timeFilter: 'day' }, opts(client));

  const sent = JSON.parse(String(client.calls[0].init?.body));
  assert.equal(sent.query, 'q');
  assert.equal(sent.limit, 2);
  assert.equal(sent.tbs, 'qdr:d');
  assert.equal(new Headers(client.calls[0].init?.headers).get('authorization'), 'Bearer fc-key');
  assert.deepEqual(results[0], { title: 'Doc', url: 'https://example.com/d', snippet: 'Desc.', source: 'firecrawl' });
});

test('FirecrawlSearchProvider throws on success:false and getQuota parses credits', async () => {
  await assert.rejects(
    () => new FirecrawlSearchProvider('k').search({ query: 'x' }, opts(new StubHttpClient(async () => jsonResponse({ success: false })))),
    /Firecrawl search failed/,
  );
  const client = new StubHttpClient(async () => jsonResponse({ data: { remaining_credits: 300, plan_credits: 500 } }));
  const quota = await new FirecrawlSearchProvider('k').getQuota(opts(client));
  assert.deepEqual(quota, { provider: 'firecrawl', used: 200, limit: 500, remaining: 300 });
});

class FakeProvider extends WebSearchProvider {
  constructor(
    readonly id: 'tavily' | 'firecrawl',
    private readonly result: WebSearchResult[] | Error,
  ) { super(); }
  async search(): Promise<WebSearchResult[]> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async getQuota(): Promise<ProviderQuota> {
    return { provider: this.id, used: null, limit: null, remaining: null };
  }
}

test('WebSearchService caps results and trims query', async () => {
  const provider = new FakeProvider('tavily', [
    { title: 'a', url: 'https://example.com/a', snippet: '', source: 'tavily' },
    { title: 'b', url: 'https://example.com/b', snippet: '', source: 'tavily' },
    { title: 'c', url: 'https://example.com/c', snippet: '', source: 'tavily' },
  ]);
  const service = new WebSearchService(webConfig, undefined, [provider]);
  const results = await service.search({ query: '  spaced  ', timeFilter: 'day' });
  assert.equal(results.length, 2);
});

test('WebSearchService fails over to the next provider on error', async () => {
  const service = new WebSearchService(webConfig, undefined, [
    new FakeProvider('tavily', new Error('tavily down')),
    new FakeProvider('firecrawl', [{ title: 'ok', url: 'https://example.com/ok', snippet: '', source: 'firecrawl' }]),
  ]);
  const results = await service.search({ query: 'q' });
  assert.equal(results[0].source, 'firecrawl');
});

test('WebSearchService aggregates errors when all providers fail', async () => {
  const service = new WebSearchService(webConfig, undefined, [
    new FakeProvider('tavily', new Error('boom1')),
    new FakeProvider('firecrawl', new Error('boom2')),
  ]);
  await assert.rejects(() => service.search({ query: 'q' }), /tavily: boom1.*firecrawl: boom2/s);
});

test('WebSearchService throws when no provider is configured', async () => {
  const service = new WebSearchService(webConfig, undefined, []);
  await assert.rejects(() => service.search({ query: 'q' }), /No web search provider configured/);
});

test('WebSearchService rejects an empty query', async () => {
  const service = new WebSearchService(webConfig, undefined, [new FakeProvider('tavily', [])]);
  await assert.rejects(() => service.search({ query: '   ' }), /web_search requires query/);
});

test('WebFetchService converts HTML to markdown via Readability', async () => {
  const html = '<html><head><title>Example Title</title></head><body><article><h1>Heading</h1><p>Hello world paragraph for readability extraction.</p></article></body></html>';
  const client = new StubHttpClient(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
  const service = new WebFetchService(webConfig, client as unknown as HttpClient);

  const result = await service.fetch({ url: 'https://example.com/page' });

  assert.equal(result.title, 'Example Title');
  assert.match(result.text, /Heading/);
  assert.match(result.text, /Hello world paragraph/);
  assert.equal(result.truncated, false);
});

test('WebFetchService passes through plain text and truncates', async () => {
  const client = new StubHttpClient(async () => new Response('plain body text', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const service = new WebFetchService({ ...webConfig, FetchMaxCharacters: 5 }, client as unknown as HttpClient);
  const result = await service.fetch({ url: 'https://example.com/p.txt' });
  assert.equal(result.text, 'plain');
  assert.equal(result.truncated, true);
});

test('WebFetchService rejects redirects to private hosts', async () => {
  const client = new StubHttpClient(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/' } }));
  const service = new WebFetchService(webConfig, client as unknown as HttpClient);
  await assert.rejects(() => service.fetch({ url: 'https://example.com/redir' }), /private|internal|local/i);
});

test('WebResearchTools formats web_search output', async () => {
  const tools = new WebResearchTools(webConfig, undefined, [
    new FakeProvider('tavily', [{ title: 'Result', url: 'https://example.com', snippet: 'Snippet', source: 'tavily' }]),
  ]);
  const result = await tools.execute('web_search', { query: 'example' });
  assert.equal(result.command, 'web_search query="example"');
  assert.match(result.output, /Result/);
  assert.match(result.output, /https:\/\/example.com/);
});
```

- [ ] **Step 2: Replace `src/web-search/web-search-service.ts`**

```ts
import { httpClient, type HttpClient } from '../lib/http-client.js';
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';
import { createWebSearchProviders, type WebSearchProvider } from './web-search-provider.js';

export class WebSearchService {
  private readonly providers: WebSearchProvider[];

  constructor(
    private readonly config: WebSearchConfig,
    private readonly client: HttpClient = httpClient,
    providers?: WebSearchProvider[],
  ) {
    this.providers = providers ?? createWebSearchProviders(config);
  }

  async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('web_search requires query.');
    }
    if (this.providers.length === 0) {
      throw new Error('No web search provider configured.');
    }
    const opts = { resultCount: this.config.ResultCount, timeoutMs: this.config.TimeoutMs, client: this.client };
    const failures: string[] = [];
    for (const provider of this.providers) {
      try {
        const results = await provider.search({ query, timeFilter: args.timeFilter }, opts);
        return results.slice(0, this.config.ResultCount);
      } catch (error) {
        failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`All web search providers failed. ${failures.join('; ')}`);
  }
}
```

- [ ] **Step 3: Update `src/web-research-tools.ts` constructor**

In `src/web-search/web-research-tools.ts`, change the import and constructor to pass a providers array:

Replace line 13 import:
```ts
import type { WebSearchProvider } from './web-search-provider.js';
```
(unchanged) and replace the constructor (lines 32–39):

```ts
  constructor(
    private readonly config: WebSearchConfig,
    client: HttpClient = httpClient,
    providers?: WebSearchProvider[],
  ) {
    this.searchService = new WebSearchService(config, client, providers);
    this.fetchService = new WebFetchService(config, client);
  }
```

- [ ] **Step 4: Run web-search tests**

Run: `npx tsx --test .\tests\web-search.test.ts`
Expected: all PASS except the three `WebFetchService` tests if Task 11/12 (deps + loader) are not yet done — run those next. If executing in order, the loader tests will still fail until Task 12; that is expected.

- [ ] **Step 5: Commit**

```bash
git add src/web-search/web-search-service.ts src/web-search/web-research-tools.ts tests/web-search.test.ts
git commit -m "feat: fail over across web search providers; rewrite web-search tests"
```

### Task 10: Delete Brave provider

**Files:**
- Delete: `src/web-search/brave-search-provider.ts`

- [ ] **Step 1: Delete and confirm no references**

```bash
git rm src/web-search/brave-search-provider.ts
```

Run: `npx tsx -e "0"` then search:
Run (Grep tool): pattern `brave-search-provider|BraveSearchProvider` across `src` and `tests` — expect **zero** matches.

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor: remove Brave search provider"
```

---

## Phase 3 — Local page loader

### Task 11: Add Readability/Turndown dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime + type deps**

Run:
```bash
npm install jsdom @mozilla/readability turndown
npm install -D @types/jsdom @types/turndown
```
Expected: `package.json` dependencies gain `jsdom`, `@mozilla/readability`, `turndown`; devDependencies gain `@types/jsdom`, `@types/turndown`.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add jsdom, readability, turndown for local page loading"
```

### Task 12: Rewrite `WebFetchService` with Readability + Turndown — TDD

**Files:**
- Modify: `src/web-search/web-fetch-service.ts`
- Test: covered by the three `WebFetchService` tests in `tests/web-search.test.ts` (Task 9 Step 1)

- [ ] **Step 1: Replace the whole file**

```ts
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { httpClient, type HttpClient } from '../lib/http-client.js';
import type { WebFetchResult, WebFetchToolArgs, WebSearchConfig } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

function htmlToMarkdown(html: string, finalUrl: string): { title: string; markdown: string } {
  const dom = new JSDOM(html, { url: finalUrl });
  const article = new Readability(dom.window.document).parse();
  const title = (article?.title || dom.window.document.title || finalUrl).trim();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const markdown = turndown.turndown(article?.content || dom.window.document.body.innerHTML).trim();
  return { title, markdown };
}

function extractContent(rawText: string, contentType: string, finalUrl: string): { title: string; text: string } {
  const type = contentType.toLowerCase();
  if (type.includes('text/plain') || type.includes('text/markdown')) {
    return { title: finalUrl, text: rawText.trim() };
  }
  if (type.includes('text/html') || type.includes('application/xhtml+xml')) {
    const { title, markdown } = htmlToMarkdown(rawText, finalUrl);
    return { title, text: markdown };
  }
  throw new Error(`web_fetch unsupported content type: ${contentType || 'unknown'}.`);
}

export class WebFetchService {
  constructor(
    private readonly config: WebSearchConfig,
    private readonly client: HttpClient = httpClient,
  ) {}

  async fetch(args: WebFetchToolArgs): Promise<WebFetchResult> {
    const originalUrl = assertPublicHttpUrl(String(args.url || '').trim());
    let currentUrl = originalUrl;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await this.client.fetch(currentUrl, {
        redirect: 'manual',
        timeoutMs: this.config.TimeoutMs,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Redirect response did not include a Location header.');
        }
        currentUrl = assertPublicHttpUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        throw new Error(`web_fetch failed with HTTP ${response.status}.`);
      }
      const rawText = await response.text();
      const extracted = extractContent(rawText, response.headers.get('content-type') || '', currentUrl.toString());
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
```

- [ ] **Step 2: Run the loader tests**

Run: `npx tsx --test .\tests\web-search.test.ts`
Expected: all tests PASS, including the three `WebFetchService` tests.

- [ ] **Step 3: Commit**

```bash
git add src/web-search/web-fetch-service.ts
git commit -m "feat: load pages locally via Readability and Turndown markdown"
```

### Task 13: Delete `html-text.ts`

**Files:**
- Delete: `src/web-search/html-text.ts`

- [ ] **Step 1: Confirm no references, then delete**

Grep tool: pattern `html-text|stripHtml|decodeHtmlEntities` across `src` and `tests` — expect **zero** matches.

```bash
git rm src/web-search/html-text.ts
git commit -m "refactor: drop unused html-text helpers"
```

---

## Phase 4 — Quota service + route

### Task 14: `readWebSearchQuotas` aggregator — TDD

**Files:**
- Create: `src/status-server/web-search-quota.ts`
- Test: `tests/web-search-quota.test.ts`

- [ ] **Step 1: Write `tests/web-search-quota.test.ts`**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebSearchQuotas } from '../src/status-server/web-search-quota.js';
import type { WebSearchConfig } from '../src/web-search/types.js';
import type { HttpClient } from '../src/lib/http-client.js';

function makeConfig(): WebSearchConfig {
  return {
    EnabledDefault: false,
    Providers: {
      tavily: { Enabled: true, ApiKey: 't' },
      firecrawl: { Enabled: true, ApiKey: 'f' },
    },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('readWebSearchQuotas returns one quota per active provider', async () => {
  const client: Pick<HttpClient, 'fetch'> = {
    fetch: async (url) => String(url).includes('tavily')
      ? jsonResponse({ account: { plan_usage: 10, plan_limit: 100 } })
      : jsonResponse({ data: { remaining_credits: 40, plan_credits: 50 } }),
  };
  const quotas = await readWebSearchQuotas(makeConfig(), client as HttpClient);
  assert.deepEqual(quotas, [
    { provider: 'tavily', used: 10, limit: 100, remaining: 90 },
    { provider: 'firecrawl', used: 10, limit: 50, remaining: 40 },
  ]);
});

test('readWebSearchQuotas degrades to nulls when a provider errors', async () => {
  const client: Pick<HttpClient, 'fetch'> = {
    fetch: async (url) => String(url).includes('tavily')
      ? jsonResponse({}, 500)
      : jsonResponse({ data: { remaining_credits: 40, plan_credits: 50 } }),
  };
  const quotas = await readWebSearchQuotas(makeConfig(), client as HttpClient);
  assert.deepEqual(quotas[0], { provider: 'tavily', used: null, limit: null, remaining: null });
  assert.deepEqual(quotas[1], { provider: 'firecrawl', used: 10, limit: 50, remaining: 40 });
});

test('readWebSearchQuotas returns empty array when no provider active', async () => {
  const config = makeConfig();
  config.Providers.tavily.Enabled = false;
  config.Providers.firecrawl.Enabled = false;
  const quotas = await readWebSearchQuotas(config, { fetch: async () => jsonResponse({}) } as unknown as HttpClient);
  assert.deepEqual(quotas, []);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx tsx --test .\tests\web-search-quota.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/status-server/web-search-quota.ts`**

```ts
import { httpClient, type HttpClient } from '../lib/http-client.js';
import { createWebSearchProviders } from '../web-search/web-search-provider.js';
import type { ProviderQuota, WebSearchConfig } from '../web-search/types.js';

export async function readWebSearchQuotas(
  config: WebSearchConfig,
  client: HttpClient = httpClient,
): Promise<ProviderQuota[]> {
  const providers = createWebSearchProviders(config);
  const opts = { resultCount: config.ResultCount, timeoutMs: config.TimeoutMs, client };
  const quotas: ProviderQuota[] = [];
  for (const provider of providers) {
    try {
      quotas.push(await provider.getQuota(opts));
    } catch {
      quotas.push({ provider: provider.id, used: null, limit: null, remaining: null });
    }
  }
  return quotas;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx tsx --test .\tests\web-search-quota.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/web-search-quota.ts tests/web-search-quota.test.ts
git commit -m "feat: aggregate provider quota with per-provider error fallback"
```

### Task 15: `/dashboard/web-search-quota` route — TDD

**Files:**
- Modify: `src/status-server/routes/dashboard.ts`
- Test: `tests/dashboard-status-server.test.ts`

- [ ] **Step 1: Add a route test**

Append to `tests/dashboard-status-server.test.ts` (after the existing web-search replay test near line 1170, follow that test's setup pattern for `startStatusServer` and base URL). Add:

```ts
test('GET /dashboard/web-search-quota returns provider quotas array', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'siftkit-dashboard-quota-'));
  const previousCwd = enterDashboardTestRepo(tempRoot);
  const statusPath = path.join(tempRoot, '.siftkit', 'status', 'inference.txt');
  const configPath = path.join(tempRoot, '.siftkit', 'config.json');
  const envBackup = configureDashboardTestEnv(tempRoot, statusPath, configPath);
  const config = getDefaultConfig();
  config.WebSearch = {
    EnabledDefault: true,
    Providers: { tavily: { Enabled: false, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: '' } },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeConfig(configPath, config);
  const server = startStatusServer({ disableManagedLlamaStartup: true });
  try {
    const base = await waitForStatusServer(server);
    const response = await fetch(`${base}/dashboard/web-search-quota`);
    assert.equal(response.status, 200);
    const body = await response.json() as { quotas: unknown[] };
    assert.deepEqual(body.quotas, []);
  } finally {
    await stopStatusServer(server);
    restoreDashboardTestEnv(envBackup);
    restoreCwd(previousCwd);
  }
});
```

> Use the exact helper names already imported at the top of `tests/dashboard-status-server.test.ts` (`enterDashboardTestRepo`, `configureDashboardTestEnv`, `waitForStatusServer`, `stopStatusServer`, `restoreDashboardTestEnv`, `restoreCwd`). If a helper name differs, mirror the neighboring replay test exactly.

- [ ] **Step 2: Run, verify fail (404)**

Run: `npx tsx --test --test-name-pattern "web-search-quota returns" .\tests\dashboard-status-server.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Add the route to `handleDashboardRoute`**

In `src/status-server/routes/dashboard.ts`, add this import alongside the other `../` imports (near line 25 where `readWebSearchUsage` is imported):

```ts
import { readWebSearchQuotas } from '../web-search-quota.js';
```

Then add this branch right after the `'/dashboard/metrics/timeseries'` branch (after line 218):

```ts
  if (req.method === 'GET' && pathname === '/dashboard/web-search-quota') {
    const config = readConfig(ctx.configPath) as SiftConfig;
    const quotas = await readWebSearchQuotas(config.WebSearch);
    sendJson(res, 200, { quotas });
    return true;
  }
```

(`handleDashboardRoute` is already `async`/`Promise<boolean>`, so `await` is valid.)

- [ ] **Step 4: Run, verify pass**

Run: `npx tsx --test --test-name-pattern "web-search-quota returns" .\tests\dashboard-status-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/status-server/routes/dashboard.ts tests/dashboard-status-server.test.ts
git commit -m "feat: expose web search provider quota over dashboard route"
```

---

## Phase 5 — Dashboard UI

### Task 16: Dashboard types

**Files:**
- Modify: `dashboard/src/types.ts:388-396` (and add response/quota types)

- [ ] **Step 1: Replace `DashboardWebSearchConfig` and add quota types**

```ts
export type WebSearchProviderId = 'tavily' | 'firecrawl';

export type DashboardWebSearchProviderSettings = {
  Enabled: boolean;
  ApiKey: string;
};

export type DashboardWebSearchConfig = {
  EnabledDefault: boolean;
  Providers: Record<WebSearchProviderId, DashboardWebSearchProviderSettings>;
  ProviderOrder: WebSearchProviderId[];
  ResultCount: number;
  FetchMaxPages: number;
  TimeoutMs: number;
  FetchMaxCharacters: number;
};

export type ProviderQuota = {
  provider: WebSearchProviderId;
  used: number | null;
  limit: number | null;
  remaining: number | null;
};

export type WebSearchQuotaResponse = {
  quotas: ProviderQuota[];
};
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/types.ts
git commit -m "feat: dashboard types for provider config and quota"
```

### Task 17: Dashboard API client

**Files:**
- Modify: `dashboard/src/api.ts`

- [ ] **Step 1: Add the quota fetcher**

Add `WebSearchQuotaResponse` to the type import block (near line 7) and append after `getMetrics` (line 85):

```ts
export function getWebSearchQuota(): Promise<WebSearchQuotaResponse> {
  return fetchJson<WebSearchQuotaResponse>('/dashboard/web-search-quota');
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/api.ts
git commit -m "feat: dashboard api client for web search quota"
```

### Task 18: Settings section metadata — TDD

**Files:**
- Modify: `dashboard/src/settings-sections.ts:85-99`
- Test: `tests/settings-sections.test.ts:38-45`

- [ ] **Step 1: Update the field-label test**

In `tests/settings-sections.test.ts`, replace the web-search labels (lines 38–45) within the ordered list with:

```ts
      'Primary provider',
      'Web search enabled by default',
      'Tavily enabled',
      'Tavily API key',
      'Firecrawl enabled',
      'Firecrawl API key',
      'Result count',
      'Timeout ms',
      'Fetch max pages',
      'Fetch max characters',
      'Usage',
```

- [ ] **Step 2: Run, verify fail**

Run: `npx tsx --test .\tests\settings-sections.test.ts`
Expected: FAIL — labels mismatch.

- [ ] **Step 3: Update `dashboard/src/settings-sections.ts` web-search block**

```ts
  'web-search': {
    id: 'web-search',
    icon: 'W',
    title: 'Web Search',
    summary: 'Tavily + Firecrawl providers, failover order, API keys, limits, and usage.',
    fields: [
      { label: 'Primary provider', layout: 'half', helpText: 'Provider tried first. The other is the failover when the primary errors or runs out of credits.' },
      { label: 'Web search enabled by default', layout: 'half', helpText: 'Whether new chat/research sessions start with web search turned on.' },
      { label: 'Tavily enabled', layout: 'half', helpText: 'Include Tavily in the search failover chain.' },
      { label: 'Tavily API key', layout: 'full', helpText: 'Tavily API key. Sent as an Authorization: Bearer header; never written to logs.' },
      { label: 'Firecrawl enabled', layout: 'half', helpText: 'Include Firecrawl in the search failover chain.' },
      { label: 'Firecrawl API key', layout: 'full', helpText: 'Firecrawl API key. Sent as an Authorization: Bearer header; never written to logs.' },
      { label: 'Result count', layout: 'quarter', helpText: 'Number of results requested per search (1-20).' },
      { label: 'Timeout ms', layout: 'quarter', helpText: 'Per-request timeout for search and page fetches.' },
      { label: 'Fetch max pages', layout: 'quarter', helpText: 'Maximum pages a single research step will fetch.' },
      { label: 'Fetch max characters', layout: 'quarter', helpText: 'Maximum characters retained from a fetched page.' },
      { label: 'Usage', layout: 'full', helpText: 'Local searches executed this month/all-time, plus remote provider credit usage.' },
    ],
```

- [ ] **Step 4: Run, verify pass**

Run: `npx tsx --test .\tests\settings-sections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/settings-sections.ts tests/settings-sections.test.ts
git commit -m "feat: settings section copy for Tavily + Firecrawl"
```

### Task 19: Settings tab web-search section

**Files:**
- Modify: `dashboard/src/tabs/SettingsTab.tsx:93` (state), `306-377` (section render)

- [ ] **Step 1: Swap the show-key state (line 93)**

Replace:
```ts
  const [showBraveKey, setShowBraveKey] = React.useState(false);
```
with:
```ts
  const [showTavilyKey, setShowTavilyKey] = React.useState(false);
  const [showFirecrawlKey, setShowFirecrawlKey] = React.useState(false);
```

- [ ] **Step 2: Replace the Provider, key, and toggle fields (lines 313–342)**

Replace the `renderField('web-search', 'Provider', ...)` block and the `renderField('web-search', 'Brave API key', ...)` block with the following (keep the existing `Web search enabled by default` toggle as-is):

```tsx
        {renderField('web-search', 'Primary provider', (
          <select
            value={web.ProviderOrder[0]}
            onChange={(event) => updateSettingsDraft((next) => {
              const primary = event.target.value as 'tavily' | 'firecrawl';
              const fallback = primary === 'tavily' ? 'firecrawl' : 'tavily';
              next.WebSearch.ProviderOrder = [primary, fallback];
            })}
          >
            <option value="tavily">tavily</option>
            <option value="firecrawl">firecrawl</option>
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
        {renderField('web-search', 'Tavily enabled', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={web.Providers.tavily.Enabled}
              onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.Providers.tavily.Enabled = event.target.checked; })}
            />
            <span>{web.Providers.tavily.Enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('web-search', 'Tavily API key', (
          <div className="settings-live-nav-control">
            <input
              type={showTavilyKey ? 'text' : 'password'}
              value={web.Providers.tavily.ApiKey}
              onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.Providers.tavily.ApiKey = event.target.value; })}
            />
            <button type="button" onClick={() => setShowTavilyKey((value) => !value)}>
              {showTavilyKey ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
        {renderField('web-search', 'Firecrawl enabled', (
          <label className="settings-live-toggle-control">
            <input
              type="checkbox"
              checked={web.Providers.firecrawl.Enabled}
              onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.Providers.firecrawl.Enabled = event.target.checked; })}
            />
            <span>{web.Providers.firecrawl.Enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        ))}
        {renderField('web-search', 'Firecrawl API key', (
          <div className="settings-live-nav-control">
            <input
              type={showFirecrawlKey ? 'text' : 'password'}
              value={web.Providers.firecrawl.ApiKey}
              onChange={(event) => updateSettingsDraft((next) => { next.WebSearch.Providers.firecrawl.ApiKey = event.target.value; })}
            />
            <button type="button" onClick={() => setShowFirecrawlKey((value) => !value)}>
              {showFirecrawlKey ? 'Hide' : 'Show'}
            </button>
          </div>
        ))}
```

- [ ] **Step 3: Extend the Usage field to show remote quota (lines 371–377)**

Replace the `renderField('web-search', 'Usage', ...)` block with one that appends quota lines. This expects a `webSearchQuota` prop wired in Task 20 (`ProviderQuota[] | null`):

```tsx
        {renderField('web-search', 'Usage', (
          <span>
            {webSearchUsage
              ? `${formatNumber(webSearchUsage.currentMonthCount)} this month (${webSearchUsage.currentMonth}) / ${formatNumber(webSearchUsage.allTimeCount)} all-time`
              : 'No usage recorded yet.'}
            {(webSearchQuota ?? []).map((quota) => (
              <span key={quota.provider} style={{ display: 'block' }}>
                {`${quota.provider}: ${quota.remaining ?? '?'} left of ${quota.limit ?? '?'} (used ${quota.used ?? '?'})`}
              </span>
            ))}
          </span>
        ))}
```

- [ ] **Step 4: Add the prop to the component signature**

Add `webSearchQuota` to `SettingsTab`'s props type and destructured params (alongside the existing `webSearchUsage` prop). Type: `ProviderQuota[] | null`. Import `ProviderQuota` from `../types`.

- [ ] **Step 5: Typecheck dashboard**

Run: `npm run typecheck`
Expected: dashboard project errors only where `webSearchQuota` is not yet passed from `App.tsx` — fixed in Task 20.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/tabs/SettingsTab.tsx
git commit -m "feat: settings tab controls for Tavily + Firecrawl and quota display"
```

### Task 20: App wiring + Metrics quota card + fixtures

**Files:**
- Modify: `dashboard/src/App.tsx`, `dashboard/src/tabs/MetricsTab.tsx`, `dashboard/tests/tab-components.test.tsx`

- [ ] **Step 1: Add quota state + mount-only fetch in `App.tsx`**

Import `getWebSearchQuota` from `./api` and `ProviderQuota` from `./types`. Add state near line 123:

```ts
  const [webSearchQuota, setWebSearchQuota] = useState<ProviderQuota[] | null>(null);
```

Add an effect (gated on tab, so it does not run in the metrics poll loop):

```ts
  useEffect(() => {
    if (tab !== 'metrics' && tab !== 'settings') {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await getWebSearchQuota();
        if (!cancelled) {
          setWebSearchQuota(response.quotas);
        }
      } catch {
        if (!cancelled) {
          setWebSearchQuota(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [tab]);
```

Pass `webSearchQuota={webSearchQuota}` to both `MetricsTab` (near line 1277) and `SettingsTab` (near line 1316), beside the existing `webSearchUsage` prop.

- [ ] **Step 2: Add a quota card to `MetricsTab.tsx`**

Add `webSearchQuota: ProviderQuota[] | null;` to the props type (near line 19), destructure it (near line 29), import `ProviderQuota` from `../types`, and inside the existing Web Search `<section>` (after the `webSearchUsage` block, before `</section>` at line 299) add:

```tsx
            {(webSearchQuota ?? []).length > 0 && (
              <div className="idle-summary-cards">
                {(webSearchQuota ?? []).map((quota) => (
                  <article key={quota.provider} className="idle-card throughput">
                    <span>{quota.provider} credits left</span>
                    <strong>{quota.remaining !== null ? formatNumber(quota.remaining) : '—'}</strong>
                    <span>{quota.limit !== null ? `of ${formatNumber(quota.limit)}` : 'limit unknown'}</span>
                  </article>
                ))}
              </div>
            )}
```

- [ ] **Step 3: Fix `tab-components.test.tsx` config fixture + prop**

In `dashboard/tests/tab-components.test.tsx` replace the `WebSearch` fixture (lines 572–575 region) with:

```ts
    WebSearch: {
      EnabledDefault: true,
      Providers: {
        tavily: { Enabled: true, ApiKey: 'secret-key' },
        firecrawl: { Enabled: false, ApiKey: '' },
      },
      ProviderOrder: ['tavily', 'firecrawl'],
      ResultCount: 5,
      FetchMaxPages: 3,
      TimeoutMs: 15000,
      FetchMaxCharacters: 12000,
    },
```

Add `webSearchQuota: null` to the prop overrides wherever `MetricsTab`/`SettingsTab` are rendered in this test (mirror the existing `webSearchUsage` default pattern; search the file for `webSearchUsage` and add the matching `webSearchQuota` default).

- [ ] **Step 4: Typecheck + run dashboard tests**

Run: `npm run typecheck`
Expected: PASS.
Run: `npx tsx --test .\dashboard\tests\tab-components.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src/tabs/MetricsTab.tsx dashboard/tests/tab-components.test.tsx
git commit -m "feat: fetch and render provider quota on metrics and settings tabs"
```

---

## Phase 6 — Remaining fixtures + full verification

### Task 21: Update remaining test fixtures

**Files:**
- Modify: `tests/repo-search-chat-execute.test.ts:44`, `tests/repo-search-loop.core.test.ts:92-95`, `tests/dashboard-status-server.test.ts:1157-1165,1264-1272`

- [ ] **Step 1: Replace the inline `WebSearch` fixtures**

`tests/repo-search-chat-execute.test.ts:44`:
```ts
      WebSearch: { EnabledDefault: true, Providers: { tavily: { Enabled: false, ApiKey: '' }, firecrawl: { Enabled: false, ApiKey: '' } }, ProviderOrder: ['tavily', 'firecrawl'], ResultCount: 5, FetchMaxPages: 3, TimeoutMs: 15000, FetchMaxCharacters: 12000 },
```

`tests/repo-search-loop.core.test.ts:92-95` — replace the `WebSearch` object with:
```ts
      WebSearch: {
        EnabledDefault: true,
        Providers: { tavily: { Enabled: true, ApiKey: 'test-key' }, firecrawl: { Enabled: false, ApiKey: '' } },
        ProviderOrder: ['tavily', 'firecrawl'],
        ResultCount: 5,
        FetchMaxPages: 3,
        TimeoutMs: 15000,
        FetchMaxCharacters: 12000,
      },
```

`tests/dashboard-status-server.test.ts` — replace BOTH `config.WebSearch = { Provider: 'brave', BraveApiKey: 'test-key', ... }` literals (near lines 1157 and 1264) with:
```ts
  config.WebSearch = {
    EnabledDefault: true,
    Providers: { tavily: { Enabled: true, ApiKey: 'test-key' }, firecrawl: { Enabled: false, ApiKey: '' } },
    ProviderOrder: ['tavily', 'firecrawl'],
    ResultCount: 5,
    FetchMaxPages: 3,
    TimeoutMs: 15000,
    FetchMaxCharacters: 12000,
  };
```

- [ ] **Step 2: Grep for stragglers**

Grep tool: pattern `Provider: 'brave'|BraveApiKey|'brave'` across `src`, `tests`, `dashboard` — expect **zero** matches (the historical `docs/superpowers/...brave...` files are intentionally retained and excluded).

- [ ] **Step 3: Commit**

```bash
git add tests/repo-search-chat-execute.test.ts tests/repo-search-loop.core.test.ts tests/dashboard-status-server.test.ts
git commit -m "test: migrate remaining web search fixtures to provider record"
```

### Task 22: Full typecheck + test suite

- [ ] **Step 1: Typecheck everything**

Run: `npm run typecheck`
Expected: PASS (main, scripts, dashboard, tests).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 3: Final commit (if anything adjusted)**

```bash
git add -A
git commit -m "test: full suite green for Tavily + Firecrawl web search"
```

---

## Self-Review Notes

- **Spec coverage:** config record (Tasks 1–4), Tavily provider (6), Firecrawl provider (7), failover chain (8–9), local Readability loader (11–13), quota service+route (14–15), dashboard config/api/settings/metrics + quota display (16–20), Brave + html-text deletion (10, 13), test migration (3, 9, 18, 20, 21). All spec sections mapped.
- **Type consistency:** `WebSearchConfig` (`Providers`, `ProviderOrder`), `WebSearchProviderId` (`'tavily'|'firecrawl'`), `ProviderQuota` ({provider,used,limit,remaining}), `createWebSearchProviders`, `WebSearchService(config, client, providers?)`, `WebResearchTools(config, client, providers?)`, `readWebSearchQuotas(config, client?)` are used identically across source and tests.
- **Failover error format:** `All web search providers failed. tavily: <msg>; firecrawl: <msg>` — the aggregate test regex matches both ids in order.
- **Note:** `WEB_SEARCH_PROVIDER_IDS` is exported from `config-store.ts` and reused by the normalizer; if another module already defines a provider-id constant, import rather than duplicate.
