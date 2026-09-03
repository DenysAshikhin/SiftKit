# Assistant memory pipeline: findings and open decisions (2026-09-03)

Companion to `docs/plan-assistant-pipeline-defects.md`. That file is the work queue; this one is
the reasoning, the evidence, and the questions that still need an owner's answer.

Context: the assistant had produced **zero memories since inception**. Two defects were found and
fixed in this session; the pipeline now produces assertions but still does not reach the model in
conversation. Details below.

---

## 1. What was broken, and what fixing it proved

### Defect A — the wire schema silently disabled constrained decoding

`CandidateObjectRefSchema`'s literal branch used `JsonValueSchema`, which serialises to a
**self-recursive** `$ref`:

```json
"__schema0": { "anyOf": [ …, {"type":"array","items":{"$ref":"#/$defs/__schema0"}},
                              {"type":"object","additionalProperties":{"$ref":"#/$defs/__schema0"}} ] }
"value": { "$ref": "#/$defs/__schema0" }
```

A recursive schema has no finite grammar expansion. TabbyAPI/exl3 accepted the request, **silently
dropped the constraint**, and generated freely — returning markdown-fenced output that
`parseJsonObjectText` (`src/lib/json.ts:4-19`, strict `JSON.parse` with only a BOM strip) rejected.
Every extraction failed with `invalid_json` at `src/assistant/inference/structured-runner.ts:124`,
and `ImageExtractor.run` swallowed each one into an audit row and `markProcessed`.

Evidence: 216 `extraction_rejected` audit rows across three separate days, every one
`{"code":"invalid_json","attempts":2}`, including a 12-byte conversation input — which rules out
truncation at `ASSISTANT_MAX_OUTPUT_TOKENS = 2_048` (`src/assistant/inference/client.ts:66`).

Isolation against the live model, one field at a time:

| Wire schema | Constrained? |
|---|---|
| `rationale` only | yes |
| + `predicate` enum (38 values) | yes |
| + `subject` (28-value enum + string) | yes |
| + nullable `scope` | yes |
| + `object` (`CandidateObjectRefSchema`) | **no** |

### Defect B — the wire schema did not encode the relation constraints

With A fixed, extraction succeeded but **every** candidate was rejected at promotion: the model
received a flat 38-value predicate enum and a flat 28-value node-type enum with no indication of
which subject/object types each predicate accepts.

```
object_type_not_allowed    21  (62%)   "USES does not accept a project object."
scope_type_not_allowed     11  (32%)   "An assertion scope must be a preference_context node…"
node_object_not_allowed     1          "HAS_SETTING requires a literal object, not a node."
subject_type_not_allowed    1          "PART_OF does not accept a person subject."
```

Both defects are the same class: **the contract handed to the model did not encode the constraint
the system actually enforces.** The fix in both cases was to derive the wire schema from the single
source of truth (`RELATION_DEFINITIONS`) so the two cannot drift — see
`src/assistant/domain/proposal-schema.ts`.

### Measured effect

| | Before | After |
|---|---|---|
| Extractions succeeding | 0 / 216 | 15 / 15 |
| `image_extraction` observations | 0 ever | 34 |
| Candidates accepted | 0 / 34 (0%) | 62 / 64 (97%) |
| `graph_assertions` | 0 ever | 44 |
| `graph_nodes` | 1 | 61 |
| `memory_projections` | 0 | **0** — see §3 |

The 2 post-fix failures were `SqliteError: database is locked` from the forcing harness contending
with the running server, not a product defect. Reinforcement works: repeated assertion ids across
runs show re-observed facts strengthening an existing assertion rather than duplicating.

---

## 2. The 42KB schema — necessary, but probably not at this size

`z.toJSONSchema(ImageExtractionSchema)` is **42,437 bytes**: 38 variants, one per predicate, each
**inlining** its allowed subject and object node-type enums plus `rationale`, `suggestedConfidence`
and `scope`.

It is large because of that inlining. There are only ~10 distinct node-type groups in
`RELATION_DEFINITIONS` (`PERSON`, `PLACES`, `OWNABLE`, `TOOLS`, `TASTEABLE`, `AUTHORED`,
`WORK_ITEMS`, `TOPICAL`, `OCCURRENCES`, `ANY`). Ordinary JSON Schema would factor these into
`$defs` + `$ref` and shrink the document to an estimated 4–6KB.

That was avoided deliberately, because `$ref` is what broke enforcement in Defect A.

**Open question, not yet answered.** Only a *self-recursive* `$ref` was proven fatal. Whether a
*non-recursive* `$ref` compiles fine was never isolated — the one dereference test (variant "A3")
used a depth-capped expansion of the still-recursive schema, so it was not a clean control.

This is worth resolving because the schema costs roughly **10–12k prompt tokens on every
extraction**, paid per capture, against a backlog of ~380 queued captures.

Suggested experiment (~10 minutes): build a hand-written schema with a plain non-recursive
`$defs`/`$ref` for one node-type group, send it to the live model with a prompt whose natural
answer would violate it, and check whether the response conforms. If it does, factor the generated
schema and re-measure size. If it does not, keep the inlining and record the result here so nobody
re-litigates it.

The **per-predicate union itself is necessary** and should not be reverted for size — it is what
moved acceptance from 0% to 97%.

---

## 3. The pipeline is not end-to-end (corrected)

There are two representations, and the distinction matters:

- **`graph_assertions`** — the triples (`the user USES Visual Studio Code`) with evidence links,
  confidence and provenance.
- **`memory_projections`** — compiled plaintext tier documents built *from* assertions, injected
  into chat context.

An earlier verbal summary in this session claimed the assertions were "still real, queryable memory
in the graph" and that only the plaintext tiers were blocked. **That was wrong.**
`MemoryRetriever` applies the same sensitivity gate to assertions before rendering:

```ts
// src/assistant/retrieval/memory-retriever.ts:92
.filter(isProjectableInPlaintext)   // admits only 'low' | 'personal'
```

`isProjectableInPlaintext` is `src/assistant/projections/assertion-view.ts:49-51`.

And `src/assistant/observation/capture-intake.ts:129` hardcodes `sensitivity: 'sensitive'` for
every screenshot — not configurable, no policy hook.

**Consequence:** screenshot-derived assertions are excluded from chat retrieval *and* from
projections. The path runs capture → evidence → observation → candidate → assertion and stops.
The 44 assertions that now exist will never reach the model in conversation. As it stands the
screenshot path produces graph rows that nothing consumes.

A second, independent gate compounds this: `ProjectionCompiler.collectViews`
(`src/assistant/projections/projection-compiler.ts:200-211`) reads assertions **only** where the
subject is the canonical owner node (`person:owner`). Facts filed under any other handle are
invisible to projections regardless of sensitivity — see §5.

---

## 4. Open decision: screenshot sensitivity

**This needs the repository owner, not an agent.** It is a privacy decision about whether screen
contents may become eligible for plaintext memory. Recorded options:

1. **Classify screenshots `personal`.** Everything flows end-to-end immediately. Screen contents
   become eligible for plaintext tier documents and chat injection. Simplest, most permissive.
2. **Keep `sensitive`, let the retriever surface them; projections stay excluded.** Facts reach
   the model in conversation but are never written into compiled plaintext documents on disk.
   Requires splitting the currently-shared `isProjectableInPlaintext` gate into two predicates —
   retrieval eligibility and projection eligibility are not the same question and should not share
   one function.
3. **Per-application policy.** Reuse the existing `ProcessDenyList` / `TitleDenyPatterns`
   machinery (`packages/contracts/src/config.ts:209-214`) so sensitivity is assigned per source
   application — e.g. an editor is `personal`, a password manager or bank tab stays `sensitive`.
   Most work, best long-term fit with the existing capture-policy design.

Relevant risk evidence: a capture reviewed during this session contained a live OAuth client
secret visible in an editor. Whatever option is chosen, the `SecretScanner` path
(`CandidateGate`, `candidate-gate.ts:71-77`) remains the last line of defence and must not be
weakened alongside this change.

---

## 5. Identity fragmentation

`OWNER_ALIASES` (`src/assistant/ingestion/candidate-promoter.ts:12`) is
`['the user', 'user', 'me', 'i', 'myself']`. Any other name read off the screen becomes a separate
`person` node. Current state: `the user` (canonical `person:owner`), `demyus`, and `denys` are
three distinct nodes for one human.

**On a different machine this does not crash.** `EntityResolver.resolve` runs with
`createIfMissing: true` and creates the node on a miss
(`src/assistant/graph/entity-resolver.ts:110-113`), at sensitivity `personal`
(`RESOLVED_NODE_SENSITIVITY`). The failure mode is the opposite of a crash — it creates too
readily, and every new handle fragments the owner further.

Because projections read only the owner node, this silently discards facts even after §4 is
settled. Tracked as Task 6 in the plan. Note the constraint recorded there: `EntityResolver`'s
contract (`entity-resolver.ts:46-49`) is explicit that name similarity alone never merges
entities, and the fix must not weaken that.

---

## 6. Operational notes

**Starting the stack.** Use `npm run start:status:stable`. That runs `scripts/start-dev.ts`, which
supervises the status server, the dashboard, **and** the Tauri desktop shell — the shell is started
at `start-dev.ts:127` whenever `Assistant.Enabled`, from
`desktop/src-tauri/target/release/siftkit-assistant-shell.exe`
(`scripts/start-dev-assistant-shell.ts:34`).

Running `npm run start:status:stable:server` alone starts **only** the server. The shell never
launches, so no environment heartbeats arrive, so every drain blocks on
`environment_heartbeat_missing` and nothing processes. An earlier claim in this session that "the
desktop shell isn't running / is broken" was caused by exactly this mistake, not by a defect.

Under `KeyCustody: 'desktop'` the shell also pushes the evidence key into the daemon on connect
(`ImportedKeyProvider`), so a server started without the shell cannot decrypt any blob.

**Drain gates, in the order they block** (`src/status-server/assistant-idle-gate.ts:22-60`):
`server_busy` → `environment_heartbeat_missing` → `model_recently_active` → `mouse_idle_below_threshold`
→ `keyboard_idle_below_threshold`. `model_recently_active` against
`IdleSecondsBeforeProcessing` (180s default) is normal, not a fault.

**A blocked drain can be invisible.** `modelWorkDecision()` blocking on `model_not_resident` does
not call `recordBlock` (`src/assistant/jobs/job-runner.ts:142-149`), so drains appear to run while
doing nothing. Tracked as Task 5.

**Retention.** `RawRetentionHours` (72h default) is compared against `enqueued_at_utc`, so a
capture dies 72h after it was *taken*, regardless of whether it was ever consumed and regardless of
retry history (`src/assistant/images/capture-retention.ts:51-58`). Capacity eviction against
`RawStorageLimitGb` (5GB) has never fired here — live captures totalled ~546MB.

---

## 7. Latent issues not yet tracked as tasks

- **`StructuredOutputRunner` parses the chat *display* projection.**
  `toLiveContentResult` (`src/llm-protocol/live-content-classifier.ts:10-12`) returns
  `text: narrationText`, which preserves markdown fences and is blanked to `''` whenever the
  tool-call scanner classifies content as `undecided` (e.g. an unterminated code fence). Both
  behaviours were reproduced. It is not the current failure mode — today's responses classify as
  `narration` with `text === rawText` — but it is the wrong field for machine JSON parsing, and
  `rawText` is available on the same object.
- **An ambiguous entity name throws mid-promotion.** `candidate-promoter.ts:150-153` throws when
  the resolver returns `needs_confirmation`; the throw escapes `promote` and fails the whole
  extraction job rather than skipping the one candidate.
- **`.assistant-pending-captures`** (`dashboard/src/tabs/settings/AssistantSettings.tsx:447`)
  matches no CSS selector anywhere — dead class.
- **`extraction_rejected` audit rows now carry a `rawSample`** (added this session,
  `structured-runner.ts`). Before this, 216 identical failures recorded only `{code, attempts}`,
  which is why the root cause went undiagnosed for days.

---

## 8. State left behind by this session

Real data was written to the live runtime while proving the fix: 34 `image_extraction`
observations, 98 candidates (62 accepted / 34 rejected / 2 lock-failures), 44 assertions, 60 new
nodes — 13 of which are junk `person` nodes from the pre-fix run (`Discord`, `League of Legends`,
`Windows`, `VS Code`, `Git`, `project`, …) caused by the node leak in Task 1.

Retention also expired ~17 captures older than 72h while drains were temporarily unblocked. That
is normal policy behaviour that had been stalled, not extra deletion.

All configuration was restored to its original values and verified: `RawRetentionHours=72`,
`IdleSecondsBeforeProcessing=180`, `MaxJobsPerIdleSession=20`, `ImageExtraction=350`,
`CaptureRetention=900`.

Cleanup of the junk rows is Task 7, deliberately sequenced **after** tasks 1–6 so it is not
immediately re-polluted.
