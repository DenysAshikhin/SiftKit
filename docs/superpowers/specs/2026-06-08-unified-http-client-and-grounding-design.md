# Unified HttpClient + Web-Search Grounding Fix — Design

Date: 2026-06-08

## Problem

A web-enabled chat ("What is Runescape") thrashed 45 identical `web_search` calls
then answered from memory with a confused uncertainty note. Forensics
(session `8a260c52`) found two independent defects:

1. **Zero-result search counted as grounded.** `web_search` returned exit 0 with
   `"No web search results found."`. `ChatGroundingPolicy.recordToolResult` gates
   success on `exitCode === 0 && output.length > 0`, so the non-empty "no results"
   string set `searchSucceeded = true` and registered the query in
   `searchedQueries`. That simultaneously (a) dedup-locked every retry of the same
   query and (b) made `evaluateFinish` demand a `web_fetch` of a URL that never
   existed (`<one returned URL>` placeholder). The model could not finish, fetch,
   or re-search — it thrashed until the turn budget ran out.

2. **Web search has no working backend, and failures are masked as empty success.**
   Default provider is SearXNG at `http://127.0.0.1:8080` (not running →
   connection refused) with a DuckDuckGo HTML fallback. Both error paths are
   swallowed by `try/catch` and return `[]`, rendered as the exit-0
   "No web search results found." string. The concrete reachability failure:
   undici `fetch`'s default `connectTimeout` is **10s**, but this machine's first
   ("cold") TLS handshake to any external host takes **~11s** (warm handshakes
   ~100ms — signature of OS revocation/CRL check or a TLS-inspecting middlebox).
   So undici aborts with `UND_ERR_CONNECT_TIMEOUT` before the handshake
   completes. The web services also send no `User-Agent`, which DDG's `/html/`
   endpoint also rejects.

## Goals

- A web_search that returns zero results must NOT be treated as grounded.
- Make external fetches survive the slow cold TLS handshake (raise connect
  timeout) and send a real User-Agent.
- Deliver the timeout/UA fix as ONE shared, generic HTTP client used by ALL
  Node-side outbound HTTP — not a one-off in the web-search service.

## Non-goals

- Fixing the environmental ~11s cold-TLS stall itself (OS/middlebox issue).
- Rewriting the llama.cpp streaming hot path onto a new transport.
- Changing browser-side (`dashboard/src/api.ts`) fetch — it cannot use undici.

## Architecture: one client API, two backends

New `src/lib/http-client.ts` exports class `HttpClient` and a shared singleton
`httpClient`. It is the single entry point for all Node-side outbound HTTP and
owns all transport policy (timeouts, User-Agent, connection agents). It is NOT a
single transport — it routes to the correct backend internally, because the two
backends have genuinely different requirements:

### External web — undici `fetch`
- Method: `fetch(url: string | URL, init?: HttpClientFetchInit): Promise<Response>`
- Injects a shared undici `Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } })`
  so the cold handshake is no longer killed at undici's 10s default.
- Injects a default `User-Agent` header (per-call `headers` may override).
- Injects `AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS)`; if the
  caller passes its own `signal`, both are honored.
- Returns a real `Response` (callers use `.ok`, `.status`, `.json()`, `.text()`,
  `.headers`, `redirect: 'manual'`).
- `undici` (`fetch`, `Agent`) is imported ONLY in this file — centralized.

### Local / llama.cpp — node:http, `keepAlive:false`
- Methods: `requestJson<T>`, `requestJsonFull<T>`, `requestText`, `streamSse`.
- Wrap the existing proven primitives in `src/lib/http.ts`, injecting the shared
  `keepAlive:false` agents (the llama.cpp idle-socket / `ECONNRESET` mitigation
  is preserved exactly).
- `streamSse` is `LlamaClient.streamChatCompletion` moved verbatim (SSE `data:`
  parsing, early-stop, abort, post-`[DONE]` reset tolerance) — re-homed, not
  rewritten.

### Why two backends
- llama/healthcheck traffic is local (`127.0.0.1`): no cold TLS, no UA need, and
  the `keepAlive:false` behavior is a hard correctness requirement undici would
  put at risk. The connect-timeout/UA fix is irrelevant there.
- Forcing the SSE streaming hot path onto undici is high-risk for zero benefit.

## Grounding fix — URL-keyed (no string matching)

In `src/repo-search/chat-grounding-policy.ts`, `recordToolResult` for
`web_search` sets `searchSucceeded = true` and registers the query in
`searchedQueries` **only if at least one candidate URL was extracted** from the
output (`rememberCandidateUrls` found ≥1 `URL:` line). Rationale: every real
search result emits a `URL: ` line (`formatSearchResults`); the empty case emits
only `"No web search results found."` with no `URL:` line. So "has ≥1 URL" is an
exact, format-driven signal for "real results" — no brittle sentinel matching.

Effect:
- Zero-result search → ungrounded, query NOT registered → no dedup lock, and
  `evaluateFinish` takes the bounded "search required" path (rejects up to
  `maxFinishRejections`, then allows the model to answer with the limitation).
- `web_fetch` grounding (`fetchSucceeded`) is unchanged.

## Migration map (complete — no legacy kept)

undici `fetch` backend (external):
- `src/web-search/web-search-service.ts` (SearXNG + DuckDuckGo)
- `src/web-search/web-fetch-service.ts` (arbitrary public URLs)
- `src/web-search/web-research-tools.ts` (constructs the two services)

These drop the `fetchImpl: FetchLike = fetch` constructor parameter and instead
take an injected `HttpClient` (default `httpClient`). This removes the
dynamically-passed function (project rule) and gives tests a single stub seam.

node:http backend (local), rewired to `httpClient`:
- Delete `src/lib/llama-client.ts`; `streamChatCompletion` → `HttpClient.streamSse`.
- `src/lib/http.ts` free functions (`requestJson`/`requestJsonFull`/`requestText`)
  become internal helpers consumed by `HttpClient`; their direct importers
  migrate to `httpClient`:
  - `src/providers/llama-cpp.ts` (tokenize, `/v1/models`, chat stream)
  - `src/repo-search/planner-protocol.ts`
  - `src/status-server/managed-llama.ts`
  - `src/status-server/routes/core.ts` (healthcheck config test)
  - `src/config/status-backend.ts`
  - `src/benchmark-matrix/config-rpc.ts`
  - `src/status-server/dashboard-benchmark-runner.ts` (currently native fetch to
    local service → `httpClient.requestJson`)
- Dev/CLI scripts migrate too (decision: include):
  - `scripts/start-dev.ts`
  - `scripts/profile-tool-loop-overhead.ts`

Excluded:
- `dashboard/src/api.ts` — browser fetch, same-origin; cannot use undici.

## Constants (hard-coded in http-client.ts — decision: not config)

- `CONNECT_TIMEOUT_MS = 20_000` — above the ~11s cold handshake so undici's
  internal connect timeout is no longer the limiter. Effective ceiling on a slow
  connect is then `min(CONNECT_TIMEOUT_MS, per-request AbortSignal)`; the web
  per-request budget stays `WebSearchConfig.TimeoutMs` (15s), which covers an
  ~11s handshake plus response.
- `DEFAULT_USER_AGENT` — a current desktop Chrome UA string.

`WebSearchConfig.TimeoutMs` (already 15000) is unchanged and remains the
per-request budget.

## Public API (shape)

```ts
export type HttpClientFetchInit = RequestInit & { timeoutMs?: number };

export class HttpClient {
  fetch(url: string | URL, init?: HttpClientFetchInit): Promise<Response>;
  requestJson<T>(options: RequestJsonOptions): Promise<T>;
  requestJsonFull<T>(options: RequestJsonOptions): Promise<FullJsonResponse<T>>;
  requestText(options: RequestTextOptions): Promise<TextResponse>;
  streamSse(
    options: SseStreamOptions,
    onData: (packet: SseStreamPacket) => SseStreamSignal,
  ): Promise<SseStreamResult>;
}
export const httpClient: HttpClient;
```

(`LlamaHttpError`, `FullJsonResponse`, `TextResponse`, and the stream
option/result types move with the methods; `LlamaStream*` names generalize to
`SseStream*`.)

## Error handling

- External `fetch`: connect/timeout/abort surface as the native fetch rejection
  (`UND_ERR_CONNECT_TIMEOUT`, `AbortError`); web services keep their existing
  `try/catch → []` and throw-on-non-ok behavior unchanged.
- node:http methods: status/throw semantics preserved exactly from `http.ts`
  (`requestJson` throws on ≥400; `requestJsonFull`/`requestText` return status).
- `streamSse`: preserves `LlamaHttpError` on ≥400, abort-reason rejection, and
  resolve-on-`[DONE]`-then-reset.

## Testing (TDD — failing test first for each unit)

`HttpClient`:
- `fetch` applies the undici Agent with the configured connect timeout.
- `fetch` injects the default User-Agent; per-call header overrides it.
- `fetch` aborts at `timeoutMs`; caller `signal` still honored.
- node methods select agent per protocol and preserve status/throw semantics
  (port existing `http.ts` / `LlamaClient` tests).
- `streamSse` preserves early-stop, abort, and post-`[DONE]` reset behavior
  (port existing streaming tests).

Grounding (`chat-grounding-policy`):
- search output with ≥1 `URL:` line → grounded; query registered (regression).
- zero-result search output → ungrounded; query NOT registered; finish path is
  the bounded "search required" path, not the impossible-fetch demand.

Web services:
- exercised through an injected stub `HttpClient` (replacing the old `fetchImpl`
  stub).

## Risks

- Re-homing `streamChatCompletion` (LLM hot path): mitigated by moving it
  verbatim and porting its full existing test suite before deleting `LlamaClient`.
- Direct importers of `http.ts` free functions must all migrate; a repo-wide
  search gates the "no legacy" cutover (the old exports are removed, so any miss
  fails loudly at compile time).
