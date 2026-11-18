# Prompt-cache break warnings and the Engine (exl3) log section

## Goal

Make two kinds of engine trouble visible in the dashboard as they happen, instead of only through manual log digging:

- **Prompt-cache breaks:** a turn whose prompt the engine re-prefills although its prefix should still be cached.
- **Engine errors:** errors exllamav3/TabbyAPI logs internally, and engine exits that were not asked for.

## Why

- In orchestrator run b3c5c019, the cache broke on 12 of 13 orchestrator ↔ worker switches. Each break cost 100–220 s of prefill, about 34 of 110 minutes. This was found only by reading run transcripts against the engine log.
- Engine errors (for example `Exception in ASGI application … RuntimeError: Cannot call write() when UVStream is closed`) appear only in the stored engine stdout/stderr, which no dashboard view shows.
- The live Tabby exiting with code 1 during the 2026-11-17 process-test run was noticed only because a run slowed down.

## Detecting a cache break

Detection runs in the task loop (`src/repo-search/engine/task-loop.ts`). Every agent run goes through it: orchestrator, repo-agent, repo-search, and chat repo operations.

A new class `PromptCacheWatch` (`src/repo-search/engine/prompt-cache-watch.ts`) observes each model response with:

- `promptTokens`: the prepared prompt's token count;
- `promptEvalTokens`: the tokens the engine prefilled;
- `compacted`: whether this turn's prompt was compacted (`prepared.compactionSummary !== null`).

It keeps the previous response's `promptTokens`.

**Rule:** a response is a cache break when `promptEvalTokens > (promptTokens − previousPromptTokens) + 500`. The prompt's growth since the last response is everything that should be new to the cache; the previous response's generated tokens are already cached. The 500-token tolerance (`PROMPT_CACHE_BREAK_TOLERANCE_TOKENS`) absorbs differences between SiftKit's token count and the engine's.

**Not checked:**

- the run's first model response (nothing is cached yet);
- the first response after a compaction (the rewritten history is new);
- a response whose `promptEvalTokens` the provider did not report.

A request that failed without a response does not reset the previous `promptTokens`. The next response is compared with the last one that succeeded.

On a break, the task loop emits:

- a transcript event `prompt_cache_break` with `turn`, `promptTokens`, `previousPromptTokens`, `promptEvalTokens` and `promptCacheTokens`;
- a progress event `prompt_cache_break` with the same fields.

## Recording: the `engine_events` table

Schema 93 → 94 adds:

```sql
CREATE TABLE engine_events (
  id TEXT PRIMARY KEY,
  occurred_at_utc TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prompt_cache_break', 'engine_error', 'engine_exit')),
  inference_run_id TEXT,   -- the engine run whose log holds it; null for cache breaks
  run_id TEXT,             -- the agent run it happened in; null for engine errors and exits
  turn INTEGER,            -- cache breaks only
  summary TEXT NOT NULL,   -- one line, shown in lists
  detail TEXT NOT NULL     -- full text, shown when selected
);
CREATE INDEX idx_engine_events_occurred ON engine_events(occurred_at_utc DESC);
CREATE INDEX idx_engine_events_run ON engine_events(run_id);
```

`src/state/engine-events.ts` owns inserts, listing and deletion, with a zod row schema.

### Cache breaks

The run's lifecycle writer in `src/repo-search/execute.ts` sees the `prompt_cache_break` progress event and inserts a row:

- `run_id`: the run's request id.
- `summary`: `Turn 14 re-prefilled 182,301 tokens; the prompt grew 3,210`.
- `detail`: the event's numbers, one per line.

### Engine errors

`TabbyRunRecorder` (`src/status-server/tabby-run-recorder.ts`) already splits engine stderr into lines to find the last Python exception. It extends this to both engine streams and recognises TabbyAPI log records:

- A record starts at a line matching `^\d{2}:\d{2}:\d{2}\.\d{3} (ERROR|CRITICAL):`.
- It continues until the next line that starts with a timestamp. This takes in the traceback and TabbyAPI's wrapped continuation lines.
- When the record ends, one `engine_error` row is inserted:
  - `summary`: the record's message, followed by the last Python exception line inside it when there is one (e.g. `Exception in ASGI application — RuntimeError: Cannot call write() when UVStream is closed`);
  - `detail`: the full record, capped at 16,000 characters;
  - `inference_run_id`: the recorder's run.

  A record still open when the stream ends is closed at that point.

### Engine exits

When a Tabby inference run that reached `ready` finishes with status `failed` or a non-zero exit code, without SiftKit having stopped it, the recorder inserts an `engine_exit` row:

- `summary`: `Engine exited with code 1`, followed by the last engine exception line when there is one.
- `detail`: the last 40 lines of engine stderr.

### Retention

- `pruneRuntimeHistory` deletes `engine_events` older than its cutoff.
- Deleting runs from the Logs tab deletes their cache-break rows.
- Deleting an inference run deletes its rows.

### Errors

Inserts from stream handlers follow the recorder's existing rule: they must not throw inside an EventEmitter handler. A failed insert goes to `serverLogger.error` with the event's summary, so it is never silently dropped.

## Showing it

### 1. Warning on the live run

The progress event is shown through the paths `context_warning` already uses:

- `chat-stream-progress-writer.ts` records it as a presentation warning, so the chat's warning banner shows it.
- The CLI progress renderer prints it as it prints context warnings.

Text: `Prompt cache broke on turn 14: re-prefilled 182,301 tokens where the prompt grew 3,210.`

### 2. Warning on the run in the Logs tab

- `RunRecord` (`packages/contracts/src/runs.ts`) gains `promptCacheBreakCount: number`. One grouped query over `engine_events` by `run_id` fills it for each listed page.
- A run row with breaks shows `⚠ cache ×N` beside its status.
- The run detail shows a warning card above the events. It lists each break: turn, tokens re-prefilled, and prompt growth.

### 3. The Engine (exl3) section in the Logs tab

- **Endpoint:** `GET /dashboard/engine-events?limit=200` returns the newest events of all three kinds, as `EngineEventSchema` in contracts.
- **List pane:** an `Engine (exl3) · N` group sits above the run groups.
  - Events with the same kind and the same summary once digits are replaced collapse into one row, showing `×count` and the latest time. This stops the repeated ASGI error from flooding the list.
- **Detail pane:** selecting a row shows the kind, first and last time, every occurrence's time, and the latest `detail` text. A cache break links to its run; clicking the link selects that run.
- **Filter chip:** a new kind chip, `Engine`, shows only this section.

## Tests (TDD)

- **`PromptCacheWatch`:**
  - the first response is not checked;
  - growth within tolerance passes;
  - eval of exactly growth + 500 passes, and growth + 501 is a break;
  - the first response after compaction is not checked, and the next one is;
  - an unreported eval is not checked;
  - a failed request in between compares against the last successful response.
- **Task loop, end to end:** a repo-search run on the mock provider, with reported cache stats that break on turn 3, writes:
  - the transcript event;
  - the progress event;
  - one `engine_events` row for the run.

  An unbroken run writes none of them.
- **`TabbyRunRecorder`:**
  - an `ERROR:` record with a traceback split across chunks gives one `engine_error` row, with the summary above and the full detail;
  - wrapped continuation lines stay in the record;
  - `INFO`/`WARNING` records give nothing;
  - a record open at stream end is closed;
  - an unrequested non-zero exit after `ready` gives one `engine_exit` row;
  - a requested stop gives none.
- **Schema 93 → 94:** the table and indexes exist, and running the upgrade twice is harmless.
- **Retention and deletion:**
  - pruning removes old rows;
  - deleting a run removes its cache breaks;
  - deleting an inference run removes its rows.
- **Endpoint:** the limit is clamped to 1..500, results are newest first, and rows parse against `EngineEventSchema`.
- **Dashboard:**
  - the Engine group collapses repeated summaries and opens a detail pane;
  - a cache break links to its run;
  - the `Engine` chip filters the list;
  - a run row shows `⚠ cache ×N`;
  - the run detail shows the warning card;
  - the chat banner shows the live warning.

## Live check

1. Run an orchestrator task with a worker on the active preset (Auto, 1.5 contexts). Expect no cache-break warnings, or only ones whose numbers explain themselves.
2. Set the preset's manual `CacheRam` small (Auto off), restart, and run the same task. Expect:
   - warnings on the orchestrator turns after each worker run, in the live view and on the run's Logs row;
   - matching rows in the Engine (exl3) section.
3. Cancel a chat mid-generation. The client disconnect makes TabbyAPI log `Exception in ASGI application`; confirm it appears as an `engine_error` row.
4. Restore the preset.

## Out of scope

- Back-filling events from engine logs recorded before this change.
- Matching a cache break to the engine request line that served it.
- A notification outside the dashboard and CLI.
