# UI-Gated Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dashboard-only `web_search` and `web_fetch` capability to SiftKit, available only when web search is enabled in the UI.

**Architecture:** Implement typed web tool services, then wire them into direct chat and repo-search/plan as first-class gated tools. UI owns session/default/per-message controls; server enforces the effective gate.

**Tech Stack:** TypeScript, Node built-in `fetch`, React dashboard, SiftKit chat/session/preset/repo-search tool infrastructure.

**Odysseus references:**
- `web_search`/`web_fetch`/research tool surface: https://raw.githubusercontent.com/pewdiepie-archdaemon/odysseus/main/src/tool_index.py
- Search orchestration: https://raw.githubusercontent.com/pewdiepie-archdaemon/odysseus/main/services/search/core.py
- Search providers: https://raw.githubusercontent.com/pewdiepie-archdaemon/odysseus/main/services/search/providers.py
- URL fetch/private-network protections: https://raw.githubusercontent.com/pewdiepie-archdaemon/odysseus/main/services/search/content.py

---

## File Map

- Create `src/web-search/types.ts`: config, search result, fetch result, tool argument/result contracts.
- Create `src/web-search/url-safety.ts`: public HTTP(S) URL validation and private/internal host blocking.
- Create `src/web-search/web-search-service.ts`: SearXNG JSON search plus DuckDuckGo fallback.
- Create `src/web-search/web-fetch-service.ts`: safe URL fetch, redirect handling, text extraction.
- Create `src/web-search/web-research-tools.ts`: explicit dispatcher for `web_search` and `web_fetch`.
- Modify `src/config/index.ts`, `src/state/runtime-db.ts`, `src/state/chat-sessions.ts`, `dashboard/src/types.ts`: config/session typing and SQLite persistence.
- Modify `dashboard/src/tabs/ChatTab.tsx`, `dashboard/src/hooks/useChatComposer.ts`, `dashboard/src/api.ts`: UI and payloads.
- Modify `src/status-server/chat.ts`, `src/status-server/routes/chat.ts`: direct-chat web tool loop and gate.
- Modify `src/presets.ts`, `dashboard/src/preset-editor.ts`, `src/repo-search/planner-protocol.ts`, `src/lib/model-json.ts`, `src/repo-search/engine.ts`: repo-search/plan web tools.
- Add/update tests in `tests/` and `dashboard/tests/`.

---

## Task 1: Web Tool Core

**Files:**
- Create: `src/web-search/types.ts`
- Create: `src/web-search/url-safety.ts`
- Create: `src/web-search/web-search-service.ts`
- Create: `src/web-search/web-fetch-service.ts`
- Create: `src/web-search/web-research-tools.ts`
- Test: `tests/web-search.test.ts`

- [ ] **Step 1: Write failing URL safety tests**

Add tests that define the URL safety contract before implementation.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicHttpUrl } from '../src/web-search/url-safety.js';

test('assertPublicHttpUrl rejects non-http schemes', () => {
  assert.throws(() => assertPublicHttpUrl('file:///c:/secret.txt'), /http/i);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/file.txt'), /http/i);
});

test('assertPublicHttpUrl rejects loopback and private hosts', () => {
  assert.throws(() => assertPublicHttpUrl('http://localhost:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1:8080'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://10.0.0.5'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://172.16.0.2'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://192.168.1.1'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://169.254.1.1'), /private|internal|local/i);
});

test('assertPublicHttpUrl rejects internal suffixes', () => {
  assert.throws(() => assertPublicHttpUrl('http://printer.local'), /private|internal|local/i);
  assert.throws(() => assertPublicHttpUrl('http://service.internal'), /private|internal|local/i);
});

test('assertPublicHttpUrl accepts public http and https URLs', () => {
  assert.equal(assertPublicHttpUrl('https://example.com/a').hostname, 'example.com');
  assert.equal(assertPublicHttpUrl('http://example.org/search?q=x').protocol, 'http:');
});
```

Run:

```powershell
npm test -- web-search
```

Expected: FAIL because `src/web-search/url-safety.ts` does not exist.

- [ ] **Step 2: Implement URL safety**

Create `src/web-search/url-safety.ts`.

```ts
const PRIVATE_HOST_SUFFIXES = ['.local', '.internal'] as const;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized || normalized === 'localhost') {
    return true;
  }
  if (normalized === '::1' || normalized.startsWith('[')) {
    return true;
  }
  if (isPrivateIpv4(normalized)) {
    return true;
  }
  return PRIVATE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function assertHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Expected a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Expected an http or https URL.');
  }
  return url;
}

export function assertPublicHttpUrl(value: string): URL {
  const url = assertHttpUrl(value);
  if (isBlockedHostname(url.hostname)) {
    throw new Error('Blocked private, internal, or local URL host.');
  }
  return url;
}
```

Run:

```powershell
npm test -- web-search
```

Expected: PASS for URL safety tests; remaining tests may fail once added.

- [ ] **Step 3: Add web tool types**

Create `src/web-search/types.ts`.

```ts
export type WebSearchProvider = 'searxng';

export type WebSearchConfig = {
  EnabledDefault: boolean;
  Provider: WebSearchProvider;
  SearxngBaseUrl: string;
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
  source: 'searxng' | 'duckduckgo';
};

export type WebFetchResult = {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
};

export type WebToolExecutionResult = {
  command: string;
  output: string;
  outputTokens: number | null;
};
```

- [ ] **Step 4: Write failing search service tests**

Extend `tests/web-search.test.ts`.

```ts
import { WebSearchService } from '../src/web-search/web-search-service.js';
import type { WebSearchConfig } from '../src/web-search/types.js';

const webConfig: WebSearchConfig = {
  EnabledDefault: false,
  Provider: 'searxng',
  SearxngBaseUrl: 'https://search.example.test',
  ResultCount: 2,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
};

test('WebSearchService returns capped SearXNG results', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL): Promise<Response> => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      results: [
        { title: 'One', url: 'https://example.com/1', content: 'First result.' },
        { title: 'Two', url: 'https://example.com/2', content: 'Second result.' },
        { title: 'Three', url: 'https://example.com/3', content: 'Third result.' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const service = new WebSearchService(webConfig, fetchImpl);

  const results = await service.search({ query: 'siftkit web search' });

  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'One');
  assert.equal(results[0].source, 'searxng');
  assert.match(calls[0], /format=json/);
});
```

Run:

```powershell
npm test -- web-search
```

Expected: FAIL because `WebSearchService` does not exist.

- [ ] **Step 5: Implement search service**

Create `src/web-search/web-search-service.ts`.

```ts
import type { WebSearchConfig, WebSearchResult, WebSearchToolArgs } from './types.js';
import { assertHttpUrl, assertPublicHttpUrl } from './url-safety.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function getText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeResult(item: unknown, source: WebSearchResult['source']): WebSearchResult | null {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const title = getText(record.title);
  const url = getText(record.url);
  const snippet = getText(record.content) || getText(record.snippet);
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

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export class WebSearchService {
  constructor(
    private readonly config: WebSearchConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async search(args: WebSearchToolArgs): Promise<WebSearchResult[]> {
    const query = String(args.query || '').trim();
    if (!query) {
      throw new Error('web_search requires query.');
    }
    const searxngResults = await this.searchSearxng(query);
    if (searxngResults.length > 0) {
      return searxngResults;
    }
    return await this.searchDuckDuckGo(query);
  }

  private async searchSearxng(query: string): Promise<WebSearchResult[]> {
    try {
      const baseUrl = assertHttpUrl(this.config.SearxngBaseUrl);
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('language', 'en');
      url.searchParams.set('safesearch', '2');
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.config.TimeoutMs) });
      if (!response.ok) {
        return [];
      }
      const body = await response.json() as Record<string, unknown>;
      const results = Array.isArray(body.results) ? body.results : [];
      return results
        .map((item) => normalizeResult(item, 'searxng'))
        .filter((item): item is WebSearchResult => Boolean(item))
        .slice(0, this.config.ResultCount);
    } catch {
      return [];
    }
  }

  private async searchDuckDuckGo(query: string): Promise<WebSearchResult[]> {
    try {
      const url = new URL('https://duckduckgo.com/html/');
      url.searchParams.set('q', query);
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.config.TimeoutMs) });
      if (!response.ok) {
        return [];
      }
      const html = await response.text();
      const matches = Array.from(html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/giu));
      return matches
        .map((match) => normalizeResult({
          title: stripHtml(match[2] || ''),
          url: match[1] || '',
          snippet: stripHtml(match[3] || ''),
        }, 'duckduckgo'))
        .filter((item): item is WebSearchResult => Boolean(item))
        .slice(0, this.config.ResultCount);
    } catch {
      return [];
    }
  }
}
```

Run:

```powershell
npm test -- web-search
```

Expected: PASS for search service tests.

The SearXNG endpoint is operator-configured infrastructure and may intentionally be `http://127.0.0.1:8080` or a LAN host. Use `assertHttpUrl()` for `SearxngBaseUrl`; use `assertPublicHttpUrl()` only for model-supplied URLs and result URLs returned to the model.

- [ ] **Step 6: Write failing fetch service tests**

Extend `tests/web-search.test.ts`.

```ts
import { WebFetchService } from '../src/web-search/web-fetch-service.js';

test('WebFetchService blocks private URLs before fetching', async () => {
  const service = new WebFetchService(webConfig, async () => {
    throw new Error('fetch should not run');
  });

  await assert.rejects(() => service.fetch({ url: 'http://127.0.0.1:1234' }), /private|internal|local/i);
});

test('WebFetchService extracts title and capped body text', async () => {
  const fetchImpl = async (): Promise<Response> => new Response(
    '<html><head><title>Example Title</title><style>x{}</style></head><body><script>x()</script><main>Hello   world</main></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  );
  const service = new WebFetchService({ ...webConfig, FetchMaxCharacters: 5 }, fetchImpl);

  const result = await service.fetch({ url: 'https://example.com/page' });

  assert.equal(result.title, 'Example Title');
  assert.equal(result.text, 'Hello');
  assert.equal(result.truncated, true);
});
```

Run:

```powershell
npm test -- web-search
```

Expected: FAIL because `WebFetchService` does not exist.

- [ ] **Step 7: Implement fetch service**

Create `src/web-search/web-fetch-service.ts`.

```ts
import type { WebFetchResult, WebFetchToolArgs, WebSearchConfig } from './types.js';
import { assertPublicHttpUrl } from './url-safety.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return normalizeWhitespace(match?.[1]?.replace(/<[^>]+>/gu, ' ') || '');
}

function extractText(content: string, contentType: string): { title: string; text: string } {
  if (!contentType.toLowerCase().includes('html')) {
    return { title: '', text: normalizeWhitespace(content) };
  }
  const title = extractTitle(content);
  const text = normalizeWhitespace(content
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '));
  return { title, text };
}

export class WebFetchService {
  constructor(
    private readonly config: WebSearchConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async fetch(args: WebFetchToolArgs): Promise<WebFetchResult> {
    const originalUrl = assertPublicHttpUrl(String(args.url || '').trim());
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
        currentUrl = assertPublicHttpUrl(new URL(location, currentUrl).toString());
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
```

Run:

```powershell
npm test -- web-search
```

Expected: PASS for fetch service tests.

- [ ] **Step 8: Write failing `WebResearchTools` tests**

Extend `tests/web-search.test.ts`.

```ts
import { WebResearchTools } from '../src/web-search/web-research-tools.js';

test('WebResearchTools formats web_search output', async () => {
  const tools = new WebResearchTools(webConfig, async () => new Response(JSON.stringify({
    results: [{ title: 'Result', url: 'https://example.com', content: 'Snippet' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));

  const result = await tools.execute('web_search', { query: 'example' });

  assert.equal(result.command, 'web_search query="example"');
  assert.match(result.output, /Result/);
  assert.match(result.output, /https:\/\/example.com/);
});
```

Run:

```powershell
npm test -- web-search
```

Expected: FAIL because `WebResearchTools` does not exist.

- [ ] **Step 9: Implement `WebResearchTools`**

Create `src/web-search/web-research-tools.ts`.

```ts
import { estimateTokenCount } from '../state/chat-sessions.js';
import type {
  WebFetchToolArgs,
  WebSearchConfig,
  WebSearchResult,
  WebSearchToolArgs,
  WebToolArgs,
  WebToolExecutionResult,
} from './types.js';
import { WebFetchService } from './web-fetch-service.js';
import { WebSearchService } from './web-search-service.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function quoteValue(value: string): string {
  return JSON.stringify(value);
}

function formatSearchResults(results: WebSearchResult[]): string {
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

export class WebResearchTools {
  private readonly searchService: WebSearchService;
  private readonly fetchService: WebFetchService;

  constructor(
    private readonly config: WebSearchConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    this.searchService = new WebSearchService(config, fetchImpl);
    this.fetchService = new WebFetchService(config, fetchImpl);
  }

  async search(args: WebSearchToolArgs): Promise<WebToolExecutionResult> {
    const query = String(args.query || '').trim();
    const results = await this.searchService.search({ query, timeFilter: args.timeFilter });
    const output = formatSearchResults(results);
    return {
      command: `web_search query=${quoteValue(query)}`,
      output,
      outputTokens: estimateTokenCount(output),
    };
  }

  async fetch(args: WebFetchToolArgs): Promise<WebToolExecutionResult> {
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
      outputTokens: estimateTokenCount(output),
    };
  }

  async execute(toolName: 'web_search' | 'web_fetch', args: WebToolArgs): Promise<WebToolExecutionResult> {
    if (toolName === 'web_search') {
      return await this.search(args as WebSearchToolArgs);
    }
    if (toolName === 'web_fetch') {
      return await this.fetch(args as WebFetchToolArgs);
    }
    throw new Error(`Unsupported web tool: ${String(toolName)}`);
  }
}
```

Run:

```powershell
npm test -- web-search
```

Expected: PASS.

- [ ] **Step 10: Commit Task 1**

```powershell
git add src/web-search tests/web-search.test.ts
git commit -m "feat: add web research tool services"
```

---

## Task 2: Config And Session State

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/state/runtime-db.ts`
- Modify: `src/state/chat-sessions.ts`
- Modify: `dashboard/src/types.ts`
- Test: `tests/config.test.ts`
- Test: `tests/chat-sessions.test.ts`

- [ ] **Step 1: Write failing config default tests**

Add assertions to existing config tests.

```ts
assert.deepEqual(normalized.WebSearch, {
  EnabledDefault: false,
  Provider: 'searxng',
  SearxngBaseUrl: 'http://127.0.0.1:8080',
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
});
```

Run:

```powershell
npm test -- config
```

Expected: FAIL because `WebSearch` is missing.

- [ ] **Step 2: Add web search config types/defaults**

Modify `src/config/index.ts` to include:

```ts
export const DEFAULT_WEB_SEARCH_CONFIG = {
  EnabledDefault: false,
  Provider: 'searxng',
  SearxngBaseUrl: 'http://127.0.0.1:8080',
  ResultCount: 5,
  FetchMaxPages: 3,
  TimeoutMs: 15000,
  FetchMaxCharacters: 12000,
} as const;
```

Normalize with explicit numeric bounds:
- `ResultCount`: integer 1-10
- `FetchMaxPages`: integer 1-8
- `TimeoutMs`: integer 1000-60000
- `FetchMaxCharacters`: integer 1000-50000

Run:

```powershell
npm test -- config
```

Expected: PASS for config tests.

- [ ] **Step 3: Write failing SQLite schema tests**

Add runtime database tests that assert the schema column exists after opening a fresh runtime DB and after migration from the prior schema.

```ts
const columns = database.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>;
assert(columns.some((column) => column.name === 'web_search_enabled'));
```

Run:

```powershell
npm test -- runtime-db chat-sessions
```

Expected: FAIL because `chat_sessions.web_search_enabled` does not exist.

- [ ] **Step 4: Add SQLite schema column and migration**

Modify `src/state/runtime-db.ts`.

Required schema changes:
- Increment `CURRENT_SCHEMA_VERSION` from `28` to `29`.
- Add to base `chat_sessions` DDL:

```sql
web_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK (web_search_enabled IN (0, 1)),
```

- Add an `ensureSchema()` migration block after the version 28 migration:

```ts
if (currentVersion < 29) {
  if (!tableHasColumn(database, 'chat_sessions', 'web_search_enabled')) {
    database.exec(`
      ALTER TABLE chat_sessions
      ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK (web_search_enabled IN (0, 1));
    `);
  }
  setSchemaVersion(database, 29);
}
```

Run:

```powershell
npm test -- runtime-db chat-sessions
```

Expected: PASS for schema tests.

- [ ] **Step 5: Write failing session state tests**

Add tests:

```ts
test('new chat sessions default webSearchEnabled from config', async () => {
  const response = await postCreateSession({ title: 'Web default' }, { WebSearch: { EnabledDefault: true } });
  assert.equal(response.session.webSearchEnabled, true);
});

test('chat session update persists webSearchEnabled', async () => {
  const created = await postCreateSession({ title: 'Web toggle' });
  const updated = await putSession(created.session.id, { webSearchEnabled: true });
  assert.equal(updated.session.webSearchEnabled, true);
});
```

Run:

```powershell
npm test -- chat-sessions status-server-chat
```

Expected: FAIL because session state does not include `webSearchEnabled`.

- [ ] **Step 6: Add session type and route persistence**

Modify session type to include:

```ts
webSearchEnabled?: boolean;
```

Create session with:

```ts
webSearchEnabled: currentConfig.WebSearch?.EnabledDefault === true,
```

In session update route:

```ts
if (typeof parsedBody.webSearchEnabled === 'boolean') {
  updated.webSearchEnabled = parsedBody.webSearchEnabled;
}
```

Update `src/state/chat-sessions.ts` explicitly because sessions are SQLite column-based:
- Add `web_search_enabled: number;` to `SessionRow`.
- Add `web_search_enabled` to `readSessionById()` SELECT.
- Hydrate `webSearchEnabled: row.web_search_enabled === 1`.
- Add `web_search_enabled` to the `INSERT INTO chat_sessions` column list.
- Add `web_search_enabled = excluded.web_search_enabled` to the `ON CONFLICT(id) DO UPDATE SET` clause.
- Add `session.webSearchEnabled === true ? 1 : 0` to the `.run(...)` arguments immediately after `thinking_enabled` or in the same column order chosen in the INSERT.

Do not rely on adding a TypeScript field alone; unsaved columns are dropped on read.

- [ ] **Step 7: Update dashboard types**

Add to `dashboard/src/types.ts`:

```ts
export type WebSearchOverride = 'default' | 'on' | 'off';

export type DashboardWebSearchConfig = {
  EnabledDefault: boolean;
  Provider: 'searxng';
  SearxngBaseUrl: string;
  ResultCount: number;
  FetchMaxPages: number;
  TimeoutMs: number;
  FetchMaxCharacters: number;
};
```

Add `WebSearch: DashboardWebSearchConfig` to `DashboardConfig`.

Add `webSearchEnabled?: boolean` to `ChatSession`.

Run:

```powershell
npm test -- config chat-sessions status-server-chat
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```powershell
git add src dashboard tests
git commit -m "feat: persist dashboard web search state"
```

---

## Task 3: Dashboard UI Controls

**Files:**
- Modify: `dashboard/src/tabs/ChatTab.tsx`
- Modify: `dashboard/src/hooks/useChatComposer.ts`
- Modify: `dashboard/src/api.ts`
- Create: `dashboard/src/lib/web-search-controls.ts`
- Test: `dashboard/tests/tab-components.test.tsx`
- Test: `dashboard/tests/hooks/useChatComposer.test.tsx`

- [ ] **Step 1: Create small web override helper tests**

Create tests for helper behavior:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { getNextWebSearchOverride, resolveEffectiveWebSearchEnabled } from '../../src/lib/web-search-controls';

test('getNextWebSearchOverride cycles composer override', () => {
  assert.equal(getNextWebSearchOverride('default'), 'on');
  assert.equal(getNextWebSearchOverride('on'), 'off');
  assert.equal(getNextWebSearchOverride('off'), 'default');
});

test('resolveEffectiveWebSearchEnabled applies override', () => {
  assert.equal(resolveEffectiveWebSearchEnabled(false, 'default'), false);
  assert.equal(resolveEffectiveWebSearchEnabled(true, 'default'), true);
  assert.equal(resolveEffectiveWebSearchEnabled(false, 'on'), true);
  assert.equal(resolveEffectiveWebSearchEnabled(true, 'off'), false);
});
```

Run:

```powershell
npm test -- web-search-controls
```

Expected: FAIL because helper does not exist.

- [ ] **Step 2: Implement dashboard helper**

Create `dashboard/src/lib/web-search-controls.ts`.

```ts
import type { WebSearchOverride } from '../types';

export function getNextWebSearchOverride(value: WebSearchOverride): WebSearchOverride {
  if (value === 'default') return 'on';
  if (value === 'on') return 'off';
  return 'default';
}

export function resolveEffectiveWebSearchEnabled(sessionEnabled: boolean, override: WebSearchOverride): boolean {
  if (override === 'on') return true;
  if (override === 'off') return false;
  return sessionEnabled;
}
```

- [ ] **Step 3: Write failing `ChatTab` UI tests**

Add assertions:
- repo-search first message controls render `AGENTS.md`, `File scan`, and `Web`
- composer toolbar always renders a `Web` override button
- clicking override cycles button title/text through default/on/off

Expected visible titles:
- `Web follows session setting`
- `Web forced on for next message`
- `Web forced off for next message`

Run:

```powershell
npm test -- dashboard
```

Expected: FAIL because controls do not exist.

- [ ] **Step 4: Extend `ChatTabProps` and render controls**

Add props:

```ts
webSearchEnabled: boolean;
webSearchOverride: WebSearchOverride;
onToggleWebSearchEnabled(enabled: boolean): Promise<void>;
onChangeWebSearchOverride(value: WebSearchOverride): void;
```

Add `RepoAutoAppendButton` near AGENTS.md/File scan:

```tsx
<RepoAutoAppendButton
  label="Web"
  icon="W"
  enabled={webSearchEnabled}
  loading={false}
  available
  tokenCount={null}
  tokenSource="estimate"
  enableTitle="Enable web search for this session"
  disableTitle="Disable web search for this session"
  onToggle={() => { void onToggleWebSearchEnabled(!webSearchEnabled); }}
/>
```

Add composer override button:

```tsx
<button
  type="button"
  className={`composer-pill web-toggle ${webSearchOverride !== 'default' ? 'active' : ''}`}
  onClick={() => onChangeWebSearchOverride(getNextWebSearchOverride(webSearchOverride))}
  disabled={chatBusy}
  title={getWebSearchOverrideTitle(webSearchOverride)}
>
  <span aria-hidden="true">W</span>
  <span>Web</span>
</button>
```

Create explicit title helper in `ChatTab.tsx`:

```ts
function getWebSearchOverrideTitle(value: WebSearchOverride): string {
  if (value === 'on') return 'Web forced on for next message';
  if (value === 'off') return 'Web forced off for next message';
  return 'Web follows session setting';
}
```

- [ ] **Step 5: Write failing composer payload tests**

Expected:

```ts
assert.equal(requestPayload.webSearchOverride, 'on');
```

Also assert reset:

```ts
assert.equal(result.webSearchOverride, 'default');
```

Run:

```powershell
npm test -- useChatComposer
```

Expected: FAIL because composer does not track override.

- [ ] **Step 6: Wire composer state**

In `useChatComposer`:
- add `const [webSearchOverride, setWebSearchOverride] = useState<WebSearchOverride>('default');`
- include `webSearchOverride` in chat message payloads and plan/repo-search stream payloads
- for direct chat only, call the buffered message endpoint when the effective web gate is on; keep the existing streaming chat endpoint when web is off
- reset to `default` after successful send
- expose `webSearchOverride` and `setWebSearchOverride`

- [ ] **Step 7: Wire App session update**

Pass `webSearchEnabled={selectedSession?.webSearchEnabled === true}`.

Implement:

```ts
async function onToggleWebSearchEnabled(enabled: boolean): Promise<void> {
  if (!selectedSession) return;
  await chatSessionsHook.updateSession({ webSearchEnabled: enabled });
}
```

Use existing session update hook shape. If the hook only supports specific update methods, add explicit `toggleWebSearch(enabled: boolean)` to that hook.

Run:

```powershell
npm test -- dashboard
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```powershell
git add dashboard
git commit -m "feat: add dashboard web search controls"
```

---

## Task 4: Direct Chat Web Tool Loop

**Files:**
- Modify: `src/status-server/chat.ts`
- Modify: `src/status-server/routes/chat.ts`
- Modify: `src/status-server/tool-command-display.ts`
- Test: `tests/status-server-chat.test.ts`

Current direct dashboard chat is plain completion: `generateChatAssistantMessage(...)` and `streamChatAssistantMessage(...)` each make one model request and do not execute tool calls. The llama.cpp-compatible transport body has no OpenAI-style `tools` array, and the streaming parser reads only `delta.reasoning_content` and `delta.content`. Do not add OpenAI tool schema framing for direct chat.

V1 decision: web-enabled direct chat uses the buffered `POST /dashboard/chat/sessions/:id/messages` path only. Direct chat with web disabled keeps the existing streaming path. Do not implement a streaming web-tool loop in V1; it would require stream completion detection, JSON action parsing after stream end, tool execution, and a second stream.

This task adds a bounded JSON-action tool loop modeled on repo-search's `ModelJson.parseRepoSearchPlannerAction(...)` protocol. The loop sits inside the buffered direct-chat route before `appendChatMessagesWithUsage(...)`.

- [ ] **Step 1: Write failing gate resolver tests**

Add server-side tests:

```ts
assert.equal(resolveEffectiveWebSearchEnabled(false, 'default'), false);
assert.equal(resolveEffectiveWebSearchEnabled(true, 'default'), true);
assert.equal(resolveEffectiveWebSearchEnabled(false, 'on'), true);
assert.equal(resolveEffectiveWebSearchEnabled(true, 'off'), false);
```

Run:

```powershell
npm test -- status-server-chat
```

Expected: FAIL because resolver does not exist.

- [ ] **Step 2: Implement server resolver**

Add in `src/status-server/routes/chat.ts` or a focused helper file:

```ts
export type WebSearchOverride = 'default' | 'on' | 'off';

export function getWebSearchOverride(value: unknown): WebSearchOverride {
  return value === 'on' || value === 'off' ? value : 'default';
}

export function resolveEffectiveWebSearchEnabled(sessionEnabled: boolean, override: WebSearchOverride): boolean {
  if (override === 'on') return true;
  if (override === 'off') return false;
  return sessionEnabled;
}
```

- [ ] **Step 3: Write failing disabled direct-chat tests**

Mock model output attempts to call `web_search` while effective web is off.

Expected:
- no web JSON-action instruction is added to the prompt
- no web tool execution
- forged JSON web action output from the model is treated as plain assistant content or rejected by the web-loop gate
- no persisted web tool bubble

- [ ] **Step 4: Add direct-chat JSON action prompt**

Do not add an OpenAI `tools` array. Instead add a prompt suffix used only by the buffered web-enabled direct-chat path:

```ts
const WEB_CHAT_JSON_ACTION_PROMPT = [
  'When web access is enabled, respond with exactly one JSON object and no markdown.',
  'To search the web: {"action":"web_search","query":"...","timeFilter":"week"}',
  'To fetch a public URL: {"action":"web_fetch","url":"https://example.com/page"}',
  'To answer the user: {"action":"finish","output":"final answer text"}',
  'Use web tools only when current or external information is needed.',
  'Private, local, and internal URLs are blocked.',
].join('\n');
```

Append this instruction to the system content only when effective web is true. Reuse or extend `ModelJson.parseRepoSearchPlannerAction(response.text, { allowedToolNames: ['web_search', 'web_fetch'] })` to parse each model response. Do not create a second JSON parser for direct chat.

- [ ] **Step 5: Write failing enabled direct-chat tests**

Mock sequence:
1. model returns `{"action":"web_search","query":"example"}`
2. mocked `WebResearchTools.search()` returns result
3. model returns `{"action":"finish","output":"final answer citing https://example.com"}`

Expected persisted messages:
- user message
- assistant tool message with `toolCallCommand: 'web_search query="..."'`
- assistant answer

- [ ] **Step 6: Implement bounded direct-chat web loop**

Add explicit loop:
- max 4 tool calls
- tool names allowed only `web_search`, `web_fetch`
- parse each assistant response with `ModelJson.parseRepoSearchPlannerAction`
- execute through `WebResearchTools`
- append tool result text to the next request as conversation evidence
- persist only the final `finish.output` as the assistant answer through existing `appendChatMessagesWithUsage`

Do not pass functions dynamically. Use direct branches:

```ts
if (toolName === 'web_search') {
  toolResult = await webTools.search(args);
} else if (toolName === 'web_fetch') {
  toolResult = await webTools.fetch(args);
} else {
  throw new Error(`Unsupported web tool: ${toolName}`);
}
```

If parsing fails while the effective web gate is on, persist a clear assistant error instead of silently treating malformed JSON as a final answer. If the gate is off, do not parse JSON actions and do not execute web tools.

- [ ] **Step 7: Persist tool bubbles**

Use existing `turns` option:

```ts
turns: [{
  thinkingText: generated.thinkingContent,
  toolMessages: webToolMessages,
}]
```

Each web tool message:

```ts
{
  id: crypto.randomUUID(),
  content: toolResult.command,
  toolCallCommand: toolResult.command,
  toolCallTurn: turn,
  toolCallMaxTurns: maxTurns,
  toolCallExitCode: 0,
  toolCallPromptTokenCount: null,
  toolCallOutputSnippet: toolResult.output.length > 200 ? `${toolResult.output.slice(0, 200)}...` : toolResult.output,
  toolCallOutput: toolResult.output,
  outputTokens: toolResult.outputTokens,
}
```

- [ ] **Step 8: Update command display if needed**

Ensure `getDisplayToolCommand()` returns web tool command text unchanged.

Run:

```powershell
npm test -- status-server-chat
```

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

```powershell
git add src tests/status-server-chat.test.ts
git commit -m "feat: enable gated web tools in dashboard chat"
```

---

## Task 5: Plan/Repo-Search Native Web Tools

**Files:**
- Modify: `src/presets.ts`
- Modify: `dashboard/src/preset-editor.ts`
- Modify: `dashboard/src/types.ts`
- Modify: `src/repo-search/planner-protocol.ts`
- Modify: `src/lib/model-json.ts`
- Modify: `src/repo-search/engine.ts`
- Test: `tests/preset-editor.test.ts`
- Test: `tests/repo-search-planner-protocol.test.ts`
- Test: `tests/repo-search-loop.core.test.ts`
- Test: `tests/preset-execution.test.ts`

- [ ] **Step 1: Write failing preset tests**

Expected:

```ts
assert(PRESET_TOOL_OPTIONS.some((tool) => tool.name === 'web_search'));
assert(PRESET_TOOL_OPTIONS.some((tool) => tool.name === 'web_fetch'));
assert.equal(PRESET_TOOL_OPTIONS.filter((tool) => tool.name === 'web_search').length, 1);
assert.equal(PRESET_TOOL_OPTIONS.filter((tool) => tool.name === 'web_fetch').length, 1);
```

Run:

```powershell
npm test -- preset
```

Expected: FAIL because web tools are not known preset tools.

- [ ] **Step 2: Add canonical tool names**

Do not add web tools to `REPO_SEARCH_TOOLS`. In current `src/presets.ts`, `READ_ONLY_TOOLS = [...REPO_SEARCH_TOOLS]` and `DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only'] = [...READ_ONLY_TOOLS]`, so adding web tools to `REPO_SEARCH_TOOLS` would silently enable them by default.

Instead add a separate constant:

```ts
const WEB_RESEARCH_TOOLS = ['web_search', 'web_fetch'] as const;
const PRESET_TOOL_NAMES = [...SUMMARY_TOOLS, ...REPO_SEARCH_TOOLS, ...WEB_RESEARCH_TOOLS] as const;
const READ_ONLY_TOOLS = [...REPO_SEARCH_TOOLS] as const;
```

Keep `DEFAULT_OPERATION_MODE_ALLOWED_TOOLS['read-only']` unchanged:

```ts
'read-only': [...READ_ONLY_TOOLS] as PresetToolName[],
```

Route-level gating appends `web_search` and `web_fetch` only when effective web is enabled.

Add to dashboard type union:

```ts
| 'web_search'
| 'web_fetch'
```

Add to `dashboard/src/preset-editor.ts` options with descriptions:
- `web_search`: `Search public web results`
- `web_fetch`: `Fetch public URL text`

- [ ] **Step 3: Write failing repo-search protocol tests**

Expected:

```ts
const withoutWeb = resolveRepoSearchPlannerToolDefinitions(['repo_rg']);
assert(!withoutWeb.some((tool) => tool.function.name === 'web_search'));

const withWeb = resolveRepoSearchPlannerToolDefinitions(['repo_rg', 'web_search', 'web_fetch']);
assert(withWeb.some((tool) => tool.function.name === 'web_search'));
assert(withWeb.some((tool) => tool.function.name === 'web_fetch'));
```

Run:

```powershell
npm test -- repo-search-planner-protocol
```

Expected: FAIL because native schemas are missing.

- [ ] **Step 4: Add native web tool schemas**

In `src/repo-search/planner-protocol.ts`, add to `NATIVE_REPO_SEARCH_TOOL_REGISTRY`:

```ts
web_search: {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the public web and return concise result titles, URLs, and snippets. Use only when external/current information is needed.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        timeFilter: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
      },
      required: ['query'],
    },
  },
},
web_fetch: {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Fetch one public HTTP(S) URL and return extracted text. Private, local, and internal URLs are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
},
```

- [ ] **Step 5: Write failing model-json parser tests**

Expected:

```ts
assert.throws(
  () => ModelJson.parseRepoSearchPlannerAction('{"action":"web_search","query":"x"}', { allowedToolNames: ['repo_rg'] }),
  /unknown|invalid/i,
);

assert.deepEqual(
  ModelJson.parseRepoSearchPlannerAction('{"action":"web_search","query":"x"}', { allowedToolNames: ['web_search'] }),
  { action: 'tool', tool_name: 'web_search', args: { query: 'x' } },
);
```

Run:

```powershell
npm test -- model-json repo-search
```

Expected: FAIL because parser does not normalize web tools.

- [ ] **Step 6: Extend parser normalization**

In `src/lib/model-json.ts`:

```ts
if (toolName === 'web_search') {
  const query = typeof rawArgs.query === 'string' ? rawArgs.query.trim() : '';
  if (!query) return null;
  const timeFilter = rawArgs.timeFilter === 'day'
    || rawArgs.timeFilter === 'week'
    || rawArgs.timeFilter === 'month'
    || rawArgs.timeFilter === 'year'
    ? rawArgs.timeFilter
    : undefined;
  return {
    action: 'tool',
    tool_name: toolName,
    args: {
      query,
      ...(timeFilter ? { timeFilter } : {}),
    },
  };
}

if (toolName === 'web_fetch') {
  const url = typeof rawArgs.url === 'string' ? rawArgs.url.trim() : '';
  return url ? { action: 'tool', tool_name: toolName, args: { url } } : null;
}
```

- [ ] **Step 7: Write failing repo-search execution tests**

Test a mocked repo-search loop where model calls `web_search` and verify:
- `tool_start.command` is `web_search query="..."`
- `tool_result.outputSnippet` includes mocked result
- persisted scorecard command type is `web_search`

Run:

```powershell
npm test -- repo-search-loop.core
```

Expected: FAIL because engine does not execute web native tools.

- [ ] **Step 8: Execute native web tools in repo-search engine**

Verify `NativeRepoToolExecution` before changing it. The current type already has an optional `outputUnit` field; only extend its union if `results` and `characters` are not already valid.

Add explicit command builder:

```ts
if (toolName === 'web_search') {
  return `web_search query=${JSON.stringify(String(args.query || '').trim())}`;
}
if (toolName === 'web_fetch') {
  return `web_fetch url=${JSON.stringify(String(args.url || '').trim())}`;
}
```

Add execution branches:

```ts
if (toolName === 'web_search') {
  const result = await webTools.search(args as WebSearchToolArgs);
  return { ok: true, command: result.command, exitCode: 0, output: result.output, toolType: 'web_search', outputUnit: 'results' };
}
if (toolName === 'web_fetch') {
  const result = await webTools.fetch(args as WebFetchToolArgs);
  return { ok: true, command: result.command, exitCode: 0, output: result.output, toolType: 'web_fetch', outputUnit: 'characters' };
}
```

The engine currently has synchronous native execution:
- `executeNativeRepoTool(...)` is a plain function in `src/repo-search/engine.ts`.
- The non-`repo_read_file` native branch assigns `nativeExecution = executeNativeRepoTool(...)` directly inside `runTaskLoop(...)`.
- `runTaskLoop(...)` and `runRepoSearch(...)` are already async, so the async boundary can stay inside the existing awaited loop.

Make the smallest async change:
- Rename or change `executeNativeRepoTool(...)` to `async function executeNativeRepoTool(...)`.
- Add `webTools: WebResearchTools` to `RunTaskLoopOptions` or construct it once at the start of `runTaskLoop` from `options.config`; do not create it per tool call.
- Change the call site to `nativeExecution = await executeNativeRepoTool(...)`.
- Keep `repo_read_file`'s special preplanned branch synchronous unless its shared type requires wrapping.
- Do not pass execution functions dynamically; dispatch explicit `if (toolName === 'web_search')` and `if (toolName === 'web_fetch')` branches.

- [ ] **Step 9: Gate route allowed tools**

In plan/repo-search routes:

```ts
function withEffectiveWebTools(allowedTools: SiftPreset['allowedTools'] | undefined, enabled: boolean): SiftPreset['allowedTools'] | undefined {
  if (!enabled || !allowedTools) return allowedTools;
  return [...new Set([...allowedTools, 'web_search', 'web_fetch'])];
}
```

Use effective web gate from session and request override before calling `executeRepoSearchRequest`.

If disabled, do not append web tools.

Run:

```powershell
npm test -- repo-search preset
```

Expected: PASS.

- [ ] **Step 10: Commit Task 5**

```powershell
git add src dashboard tests
git commit -m "feat: add gated web tools to repo modes"
```

---

## Task 6: End-To-End Validation

**Files:**
- No planned edits. Only fix issues exposed by validation.

- [ ] **Step 1: Run focused tests**

```powershell
npm test -- web-search status-server-chat repo-search preset dashboard
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run build**

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual verification checklist**

Verify:
- new dashboard session has web off by default
- repo mode shows `AGENTS.md`, `File scan`, and `Web`
- chatbox override can force on/off for one send
- web tool bubbles persist after refresh
- forged disabled web tool call is rejected by server tests
- private/internal fetch targets are blocked by tests

- [ ] **Step 5: Final commit**

```powershell
git add -A
git commit -m "feat: add UI-gated web search"
```

---

## Acceptance Criteria

- Web access exists only in dashboard UI paths.
- Default is off.
- Persistent session toggle works.
- Per-message override works in all UI modes.
- Server-side gate enforces disabled state against forged requests.
- Direct chat, plan, and repo-search can use `web_search` and `web_fetch` only when enabled.
- Direct chat uses the buffered endpoint when web is enabled; streaming direct chat remains web-off only in V1.
- Private/internal URLs are blocked.
- Tool calls render and persist like existing SiftKit tool bubbles.
- `npm test` and `npm run build` pass.

## Assumptions

- Scope is all dashboard modes.
- Override is a composer button, not an inline command.
- V1 implements research as multi-step `web_search` plus `web_fetch`, not a separate long-running research job.
- V1 does not implement a streaming direct-chat web loop; web-enabled direct chat is buffered.
- No worktrees.
- TDD is mandatory.

## Discovery Compliance

- Discovery/search used `siftkit repo-search` first.
- Prompts were extraction-oriented and requested file:line anchors.
- Raw output reads were narrow follow-up on known files only.
