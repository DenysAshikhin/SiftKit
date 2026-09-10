# Handoff: image_extraction dead letters and assertion promotion lag (2026-09-10)

Two independent issues surfaced while confirming that the Assistant tab's Memory Inspector
was not broken. Neither blocks memory capture, which is healthy and actively writing.
Both are worth a decision; **neither has been fixed, and no code was changed.**

Related prior context: [handoff-2026-08-31-assistant-idle-and-capture-backlog.md](handoff-2026-08-31-assistant-idle-and-capture-backlog.md).

## How the data below was read

All figures come from the repo-local database, opened read-only:

```js
const db = new (require('better-sqlite3'))('.siftkit/runtime.sqlite', { readonly: true });
```

Snapshot time: `2026-09-10T12:37Z`. Owner is `own_local` (single owner).
Re-run the queries before acting — this database is live and moves constantly.

---

## Issue 1: 30 `image_extraction` jobs stuck in `dead_letter`

### What is actually true

My first pass at this called the subsystem "persistently broken and not draining." **That was
wrong** and the correction matters for prioritisation: the queue *is* draining normally.

```
job_type            status        n
image_extraction    completed     816
image_extraction    dead_letter    30
image_extraction    queued         32
```

`image_extraction` completions by day: 428 on 09-03, 324 on 09-04, 49 on 09-08, 5 on 09-09,
10 on 09-10. The 32 currently queued rows are fresh (created up to `12:33:25Z` today), have
`attempts = 0`, `lease_owner = null`, and `available_at_utc` already in the past. They are
waiting on the idle gate, not failing.

### The real finding

All 30 dead letters landed inside a **single ~2 hour window on 2026-09-03**
(`13:54:52Z` – `15:56:49Z`) and every one exhausted `max_attempts = 3`. Three causes:

| `last_error` | n | window |
|---|---|---|
| `llama.cpp stream failed with HTTP 500: Internal Server Error` | 18 | 13:54:52Z – 13:56:21Z |
| `database is locked` | 11 | 15:45:36Z – 15:56:49Z |
| `Chat stream ended without a [DONE] sentinel after 1 frame(s) (url=http://127.0.0.1:8098/v1/chat/completions). The response may be truncated.` | 1 | 13:56:19Z |

Payloads are single evidence references, e.g. `{"evidenceId":"ev_d1ec0c5752bc460fa5775deeffb2d248"}`.

This is a historical incident, not an ongoing fault. Note the llama.cpp errors are themselves
stale — see [handoff-2026-09-02-remove-llama-backend.md](handoff-2026-09-02-remove-llama-backend.md);
that backend was being removed around this period, which plausibly explains the HTTP 500 burst.

### Why it still deserves attention

1. **All three causes are transient infrastructure failures, but retry treats them as permanent.**
   A backend 500, a SQLite lock, and a truncated stream are all retryable in principle. Three
   attempts inside ~2 minutes exhausted the budget while the backend was down for longer than that.
   There is no backoff long enough to outlive a backend restart.
2. **`database is locked` is a SQLite contention signal**, not a model problem. Worth confirming the
   job runner's write path uses WAL and a sane `busy_timeout`. A ~1GB database with an active WAL is
   in use here.
3. **Dead letters appear to be terminal with no operator path back.** No requeue/replay surface was
   found for them, so 30 evidence records are silently never extracted.

### Suggested work

- Decide the policy: auto-requeue dead letters on transient error classes, or expose a manual
  "retry dead letters" action. Classify `database is locked` / connection-refused / 5xx as retryable
  and separate them from genuine permanent failures.
- Add backoff that can span a backend restart rather than three attempts in two minutes.
- Verify `busy_timeout` and WAL settings on the job runner's writes.
- Confirm whether these 30 evidence records are recoverable, and backfill them if so.

### Entry points

- Job rows and statuses: `assistant_jobs` (`id, owner_id, job_type, priority, payload_json,
  idempotency_key, status, attempts, max_attempts, available_at_utc, lease_owner,
  lease_expires_at_utc, last_error, created_at_utc, updated_at_utc`).
- Runner and admission logic: [src/assistant/jobs/job-runner.ts](../src/assistant/jobs/job-runner.ts).
- Evidence payload targets: `evidence_records` (4,324 rows, captured `2026-08-28` → `2026-09-10`).

### Separate observation in the same table

`projection_maintenance` shows **405 cancelled vs 16 completed**, with 1 queued. A ~96% cancellation
rate looks like repeated supersede/debounce rather than useful work. Not investigated. This may be
entirely by design (newer maintenance job cancels the pending one), but it is worth one look, and
it is directly relevant to Issue 2's staleness question.

---

## Issue 2: assertions are promoted ~1.5 days after the evidence was captured

### The original symptom, and why it is not a bug by itself

`graph_assertions.last_observed_at_utc` maxed out at `2026-09-09T01:01:28Z` while
`created_at_utc` reached `2026-09-10T12:33:08Z`. That looked like a stalled timestamp. It is not.

`last_observed_at_utc` is deliberately **source-content time, not wall-clock time**. The insert path
sets both `first_observed_at_utc` and `last_observed_at_utc` from `input.observedAtUtc`
([src/assistant/storage/assertion-store.ts:79-93](../src/assistant/storage/assertion-store.ts#L79-L93)),
and reinforcement takes `MIN`/`MAX` against the incoming observation rather than `now`
([assertion-store.ts:295-306](../src/assistant/storage/assertion-store.ts#L295-L306)):

```sql
UPDATE graph_assertions
SET first_observed_at_utc = MIN(first_observed_at_utc, ?),
    last_observed_at_utc  = MAX(last_observed_at_utc, ?),
    updated_at_utc        = ?
WHERE id = ?
```

The promoter passes the evidence capture time, not the clock
([src/assistant/ingestion/candidate-promoter.ts:107,126](../src/assistant/ingestion/candidate-promoter.ts#L107)):

```ts
observedAtUtc: evidence.captured_at_utc,
```

That is semantically correct. The only wall-clock writer is the direct user-mutation path
([src/assistant/control/memory-mutation-service.ts:129](../src/assistant/control/memory-mutation-service.ts#L129)).

### The real finding

The timestamps expose a genuine **promotion backlog**. For the 56 assertions created today,
`created_at_utc - last_observed_at_utc`:

```
n = 56    min = 1.48 d    median = 1.49 d    max = 1.67 d
```

Evidence is being captured continuously (newest `2026-09-10T12:37:21Z`), but what is being promoted
today is evidence from ~36 hours ago. Supporting signal: `candidate_assertions` holds
**1,244 `pending`** rows against 2,922 `accepted`, 74 `rejected`, 16 `needs_confirmation`.

### Why this matters beyond throughput

Recency decay is computed as `now - lastObservedAtUtc` in three separate scoring paths:

- [src/assistant/graph/assertion-service.ts:529](../src/assistant/graph/assertion-service.ts#L529)
- [src/assistant/projections/projection-compiler.ts:258](../src/assistant/projections/projection-compiler.ts#L258)
- [src/assistant/retrieval/memory-retriever.ts:164](../src/assistant/retrieval/memory-retriever.ts#L164)

So every newly promoted assertion is born already ~1.5 days decayed. If decay is steep, fresh
knowledge is systematically down-ranked at the moment it enters the graph, and the backlog
directly degrades retrieval quality rather than merely delaying it.

Corroborating staleness: newest `memory_projections.generated_at_utc` is `2026-09-09T18:04:08Z`,
roughly 18 hours behind the newest node, at `graph_version` 6608.

### Open questions for the next agent

1. Is the ~1.5 day lag intended pacing (idle-gated batch promotion) or an unintended backlog?
   The idle gate from the 2026-08-31 handoff is the obvious suspect and should be ruled in or out first.
2. Is `1,244 pending` a steady state or monotonically growing? Sample it over time — a single
   snapshot cannot distinguish the two, and this determines whether anything needs fixing at all.
3. Should decay use observation time or promotion time? Current behaviour is defensible; the
   interaction with a multi-day backlog probably is not. This is a design decision, not a bug fix.
4. Does the `projection_maintenance` cancellation rate (Issue 1) explain the 18-hour projection lag?

**Do not "fix" `last_observed_at_utc` to use wall-clock time.** That would destroy real temporal
semantics and silently corrupt decay for reinforced assertions. Fix the backlog, or change the
decay input deliberately.

---

## Reproduction queries

```js
const D = require('better-sqlite3');
const db = new D('.siftkit/runtime.sqlite', { readonly: true });

// Issue 1
db.prepare(`SELECT job_type, status, count(*) n FROM assistant_jobs
            GROUP BY job_type, status ORDER BY job_type`).all();
db.prepare(`SELECT last_error, count(*) n, min(updated_at_utc) first, max(updated_at_utc) last
            FROM assistant_jobs WHERE status='dead_letter' GROUP BY last_error`).all();

// Issue 2
const rows = db.prepare(`SELECT created_at_utc, last_observed_at_utc FROM graph_assertions
                         WHERE created_at_utc >= '2026-09-10'`).all();
const lags = rows
  .map((r) => (Date.parse(r.created_at_utc) - Date.parse(r.last_observed_at_utc)) / 86_400_000)
  .sort((a, b) => a - b);

db.prepare('SELECT status, count(*) n FROM candidate_assertions GROUP BY status').all();
```

## Scope boundary

Diagnosis only. No files were modified, no jobs requeued, no tests run. Both issues were found
incidentally; the original question (whether memory was being stored) resolved as **yes, working
normally** — the Memory Inspector renders a pre-search hint whenever `results === null`
([dashboard/src/tabs/AssistantTab.tsx:79](../dashboard/src/tabs/AssistantTab.tsx#L79)), which is
what an empty-looking panel means. `/assistant/search` was verified live and returns real results.
