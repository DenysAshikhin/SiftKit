# Handoff: `oneOf` in planner JSON schema wedges the EXL3 inference server

**Status:** root cause confirmed, fix identified and verified by experiment. Not yet implemented.
**Severity:** every repo-search run and every UI chat turn fails; the inference server stays dead until the model is reloaded.
**Estimated work:** ~2 line change + test updates. Under an hour including tests.

---

## Who

| Role | Who |
|---|---|
| Reported / reproduced | Denys Ashikhin (`lts.ai@longtermtec.com`), 2026-07-21 |
| Diagnosis | Claude Code session, 2026-07-21 |
| Implements this fix | **you** (SiftKit side, self-contained) |
| Upstream bug owners | exllamav3 (formatron/kbnf grammar), TabbyAPI (crash recovery) — see [Out of scope](#out-of-scope-upstream) |

---

## What

SiftKit sends `response_format: json_schema` on **every** planner turn. The schema it builds is a
top-level `oneOf` union. `oneOf` is broken in the grammar engine TabbyAPI uses
(formatron → kbnf): the engine masks logits to an allowed-token set, samples a token from that set,
then **rejects that same token** when asked to accept it.

That single rejection kills the whole inference server, not just the request.

**The fix: emit `anyOf` instead of `oneOf`.** Verified working with the real schema, thinking on and
MTP speculation on.

### User-visible symptom

```
Terminal synthesis produced no usable output after 3 attempts
(reason=invalid_response_limit, last=empty_output).
```

Also seen as `HTTP 503: Chat completion <id> aborted. Maybe the model was unloaded?`.
**Both messages are collateral, not the fault.** Do not start debugging from them — see
[Why the error message misleads](#why-the-error-message-misleads).

---

## Where

### The fix — SiftKit

`src/providers/structured-output-schema.ts`, two sites:

| Line | Current | Change to |
|---|---|---|
| 49-54 | `function buildOneOf(...)` returning `{ oneOf: values }` | rename `buildAnyOf`, return `{ anyOf: values }` |
| 139 | `oneOf: actionSchemas` | `anyOf: actionSchemas` |

No `oneOf` anywhere in `packages/`. These two sites cover both the repo-search planner schema and the
summary planner schema.

### Tests that must be updated

`tests/repo-search-planner-empty-tools.test.ts` — 4 references, all asserting `oneOf`:

- `:7-25` `ActionOneOfSchema` zod validator (rename + key)
- `:29-30` `schema.oneOf.length` / `schema.oneOf[0]`
- `:44-46` `body.response_format.json_schema.schema.oneOf`

`tests/structured-output-schema.test.ts` exists and is the natural home for the new regression test.

> Note the finish-only path (`toolDefinitions: []`) still emits a **single-variant** union,
> `{oneOf: [finish]}`. Single-variant `oneOf` is equally affected — this is not only a
> multi-tool problem.

### Where it breaks downstream (for context, don't patch these)

| Layer | Location |
|---|---|
| Grammar rejects its own token | `exllamav3/generator/filter/formatron.py:89` → `kbnf/engine.py:113` |
| TabbyAPI declares FATAL, schedules recreate | `TabbyAPI/backends/exllamav3/model.py:1384-1393` |
| Job deleted before it can be cancelled | `model.py:982-984` (`finally: del self.active_job_ids[...]`) |
| Recreate reuses the same cache | `model.py:692` (`cache=self.cache`) |
| Slot pool never rebuilt | `exllamav3/cache/cache.py:153`, assert at `:318` |

---

## When

| | |
|---|---|
| `oneOf` introduced | commit `f17a5b9` "more fixes", 2026-04-15, Denys Ashikhin |
| Diagnosed at HEAD | `129fd67` |
| Reproduced | 2026-07-21, ~11:15-11:25 local |

It is **100% reproducible on the first request of a freshly started server** — a plain `hi` in the UI
chat is enough. Earlier in the investigation it looked intermittent; that was a misreading. Requests
that succeed alongside it are requests that carry no grammar (e.g. terminal synthesis, which sends
`responseSchema: null`).

---

## Why

### Mechanism, in order

1. SiftKit sends `response_format: json_schema` with a top-level `oneOf`
   ([`planner-protocol.ts:491`](../src/repo-search/planner-protocol.ts#L491)). This goes out on
   **every** planner turn — `stage` defaults to `planner_action`
   ([`:459-463`](../src/repo-search/planner-protocol.ts#L459-L463)). Native tool-calling is not used
   (`tools: []` at [`:485`](../src/repo-search/planner-protocol.ts#L485)), so this grammar is the
   *only* thing enforcing valid action JSON.
2. TabbyAPI builds a `FormatronFilter` from the schema (`grammar.py:73-93` — note one schema produces
   **two** filters, the second forcing the leading `{`).
3. kbnf's mask and accept-state disagree on a `oneOf` grammar →
   `ValueError: The input token id is rejected and the [EngineLike]'s internal states are not updated.`
4. TabbyAPI logs `FATAL ERROR with generation. Attempting to recreate the generator.` and fires
   `asyncio.ensure_future(self.create_generator())` — **scheduled, not awaited** (`model.py:1393`).
5. `raise ex` propagates into the `finally` at `model.py:982-984`, which runs
   `del self.active_job_ids[request_id]` **synchronously, winning the race**. When
   `create_generator()` finally runs, `wait_for_jobs(skip_wait=True)` iterates an empty dict, so
   `job.cancel()` → `deallocate_pages()` → `free_recurrent_state()` never runs. The recurrent-state
   slot is orphaned and the only handle to it is gone.
6. `create_generator()` builds a new generator around **the same cache object** (`model.py:692`). The
   free list lives on the cache (`cache.py:153`), so recreation cannot rebuild it.
7. Preset `exl3-3-6-27b` has `ParallelSlots: 1` → `max_batch_size: 1` → **exactly one slot**. One leak
   empties the pool permanently. Every later request asserts at `cache.py:318`, which raises, which
   re-enters the same FATAL handler. Server is dead until model reload.

### Why the error message misleads

The grammar failure happens **after** streaming has already returned HTTP 200 and emitted the thinking
block. So SiftKit sees a 200 with an empty/aborted body, treats the empty text as an unparseable
planner action, and burns `invalidResponses` until it trips
[`task-loop.ts:543`](../src/repo-search/engine/task-loop.ts#L543) → `reason=invalid_response_limit`.
Terminal synthesis then retries 3× against an already-dead server and reports
`last=empty_output` ([`terminal-synthesizer.ts:106`](../src/repo-search/engine/terminal-synthesizer.ts#L106)).
Non-streaming calls surface the `503 ... Maybe the model was unloaded?` variant instead.

Nothing in either message points at the schema. Budget time for this if it recurs in another form.

### Why `anyOf` is a safe substitute, not a loosening

Every variant is discriminated by a `const` action name and carries
`additionalProperties: false`, so the variants are already mutually exclusive by construction. For
mutually exclusive variants `anyOf ≡ oneOf`. No validation strength is lost, and the grammar only ever
needs to *accept* — it never has to reject an over-matching document.

---

## Evidence

All rows below are direct observations against preset `exl3-3-6-27b` (`3.6_27B`, EXL3, `max_batch_size: 1`,
MTP speculation on), one request per fresh server where a failure occurred.

| thinking | schema | result |
|---|---|---|
| on | none | ✅ 195 tok, 87% draft accepted |
| off | flat object + `const` | ✅ |
| off | flat object + `const` + `additionalProperties:false` | ✅ |
| on | toy 1-field object | ✅ |
| on | **real planner, 19 tools, 6691 B, `oneOf`** | ❌ `ValueError` |
| **off** | real planner, 19 tools, `oneOf` | ❌ — rules out thinking as a factor |
| on | real planner, **1 tool, 753 B**, `oneOf` | ❌ — rules out schema size |
| off | `anyOf` + `const` | ✅ |
| off | `anyOf` + `enum` | ✅ |
| off | `anyOf`, no discriminator | ✅ |
| off | `oneOf`, no discriminator | ❌ |
| on | **real planner, 19 tools, `anyOf`** | ✅ **the fix** |

Final confirmation run: 817 chars of thinking, then
`{"action":"finish","output":"Hi there! How can I help you today?"}`, `eos_reason: end_filter`,
parses as valid JSON, server still healthy afterwards.

**Not established:** whether MTP speculation is a necessary co-factor for the `oneOf` failure —
`oneOf` was never tested with speculation disabled. It does not affect this fix. Do not repeat
"MTP is exonerated" as if it were verified.

---

## How to reproduce and verify

### Minimal repro (~200 bytes, no SiftKit involved)

Start the server, then one request. Expect abort; the server is dead afterwards and needs a restart.

```bash
curl -sS -X POST http://127.0.0.1:8098/v1/chat/completions \
  -H 'content-type: application/json' -d '{
  "model":"3.6_27B","messages":[{"role":"user","content":"hi"}],
  "max_tokens":200,"stream":true,"chat_template_kwargs":{"enable_thinking":false},
  "response_format":{"type":"json_schema","json_schema":{"name":"probe","strict":true,"schema":{
    "oneOf":[
      {"type":"object","properties":{"action":{"const":"finish"},"output":{"type":"string"}},"required":["action","output"]},
      {"type":"object","properties":{"action":{"const":"repo_read_file"},"path":{"type":"string"}},"required":["action","path"]}
    ]}}}}'
```

Swap `oneOf` → `anyOf` and it passes.

### Server control

```bash
node ./dist/status-server/index.js     # starts status server + managed Tabby
curl -s http://127.0.0.1:8098/v1/model # ready when it returns a model card
```

Ports: Tabby `8098`, status server `6876`. Tabby log:
`.siftkit/logs/managed-tabby/latest-startup.log` (interleaved `[stdout]`/`[stderr]` markers make it
awkward to read — strip them and re-split on timestamps).

### Acceptance

1. Failing test first: assert the planner schema contains no `oneOf` at any depth (or a fake provider
   that rejects `oneOf` schemas, mirroring kbnf).
2. Apply the two-line change.
3. Update the 4 assertions in `tests/repo-search-planner-empty-tools.test.ts`.
4. `npm test` green.
5. Live check: start the server, run one repo-search and one UI chat, confirm both complete and the
   Tabby log contains no `FATAL ERROR with generation`.

---

## Out of scope (upstream)

Worth filing separately; both have small repros and neither blocks the SiftKit fix.

1. **exllamav3 / formatron / kbnf** — `oneOf` grammars reject a token the mask allowed. Repro above.
   exllamav3 `1.1.0`.
2. **TabbyAPI** — one failed generation permanently kills the server. Two compounding defects:
   the failing job is deleted (`model.py:984`) before the scheduled `create_generator()`
   (`model.py:1393`) can cancel it, so its recurrent slot leaks; and recreation reuses the same cache
   (`model.py:692`), so the free list can never be rebuilt. Arguably a two-line ordering fix.

### Optional hardening in SiftKit (not required)

An aborted/empty provider stream is currently indistinguishable from a badly-behaved model — it
inflates `invalidResponses` and surfaces as `invalid_response_limit`, which sends you looking at the
planner instead of the backend. Failing fast with a provider-error reason, and/or auto-reloading the
preset on detecting the wedge (`TabbyModelClient.unload`/`load`,
`PresetRuntimeCoordinator.ensureActivePresetReady`) would have made this a 4-second reload instead of
a dead session. Raising `ParallelSlots` above 1 only buys N failures before the same dead end — it is
not a fix.
