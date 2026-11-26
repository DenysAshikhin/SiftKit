# Local Evals 2: Paired Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the same frozen samples against two or more variants of a model preset, one variant at a time, and report paired differences with coverage, errors and intervals.

**Architecture:** The bench route accepts a whitelisted set of per-request preset overrides, so a variant is a saved preset plus overrides and saved config is never edited. In Python, one manifest shape and one runner serve both a single-model suite run and a multi-variant experiment; work is split into `(variant, task, repeat)` units written atomically, which is what makes resume duplicate-free. Statistics and comparison are pure functions over normalized records.

**Tech Stack:** As plan 1. No new dependencies; statistics use the standard library.

**Spec:** `docs/superpowers/specs/2026-11-26-local-evals-design.md`
**Depends on:** `docs/superpowers/plans/2026-11-26-local-evals-1-core.md`, complete and green.

## Ground rules for every task

- Do not commit. Do not use worktrees. Temporary files go in `.scratch/local-evals/` and are deleted at the end.
- Before editing `src/` or `packages/contracts/src/`, check whether a status server is listening on :4765 (`Get-NetTCPConnection -State Listen -LocalPort 4765`). If one is, stop and ask.
- TypeScript: no `any`, no type assertions, no non-null assertions; parse IO with zod; comments one or two lines.
- Python: `pyright` strict, `ruff` clean, no `# type: ignore`. Only `evaluators/inspect_eval.py` and `tasks/inspect_bindings.py` import `inspect_ai`.
- Python commands run from `local-evals/` with the venv active.
- No model is loaded and no dataset is downloaded by a test. Steps that need either say so and are skipped, with the reason recorded, when not authorized.

## Task format

Each task gives the goal, the files, the decisions already made (names, signatures, schemas, formulas, file contents), the failing test and the acceptance criteria. Test code and contracts are exact. Implementation bodies are left to the implementer and must satisfy the tests without widening the stated interfaces. Every task follows the same cycle: write the test, run it and see it fail for the stated reason, implement, run it and see it pass.

## What plan 1 provides

| Name | Where | Used here for |
|---|---|---|
| `BenchClient`, `Identity`, `ChatResponse` | `siftkit.py` | Overrides are added to its calls. |
| `Evaluator`, `TaskRunRequest`, `RawLogRef`, `classify_status` | `evaluators/base.py` | Gains sample listing, metrics, content hashes, extra headers. |
| `InspectEvaluator` | `evaluators/inspect_eval.py` | Same. |
| `EvaluatedSample`, `SampleRecord`, `MODEL_OUTCOMES` | `records.py` | `EvaluatedSample` gains `metrics` and `content_hash`; `SampleRecord` inherits them. |
| `ResolvedManifest`, `Suite`, `SuiteTask`, `TaskSpec`, `TaskCatalog` | `config.py` | Replaced or extended as stated in Tasks 6 and 8. |
| `RunStore` | `runstore.py` | Gains unit files and variant directories. |
| `run_suite`, `prepare_target`, `LiveTarget`, `MockTarget` | `runner.py` | Replaced by `run_manifest` in Task 9. |
| `summarize`, `render_markdown`, `render_csv` | `report.py` | Called once per variant. |
| `FakeBench`, `capture_server` | `tests/` | Extended. |

## File map

| File | Responsibility |
|---|---|
| `packages/contracts/src/bench.ts` (modify) | Override header name, override schema, identity carries overrides. |
| `src/lib/model-request-intent.ts` (modify) | `modelPresetOverrides` on the intent. |
| `src/status-server/model-request-context.ts` (modify) | Applies overrides to a clone of the selected preset. |
| `src/status-server/routes/bench.ts` (modify) | Reads the header, rejects unloadable variants with 400. |
| `tests/model-request-context.test.ts`, `tests/bench-route.e2e.test.ts` (modify) | Tests. |
| `local-evals/src/local_evals/siftkit.py` (modify) | Overrides on every call. |
| `local-evals/src/local_evals/evaluators/base.py`, `inspect_eval.py` (modify) | `list_samples`, metrics, content hash, extra headers. |
| `local-evals/src/local_evals/samples.py` (create) | Seeded stratified selection, frozen sample manifests. |
| `local-evals/src/local_evals/config.py` (modify) | `Variant`, experiment file, one resolved manifest for both run kinds. |
| `local-evals/src/local_evals/runner.py` (replace) | `run_manifest`: variants, units, repeats, resume. |
| `local-evals/src/local_evals/tasks/tools.py` (create) | Mock tools, tool-case fixtures and scorer as plain functions. |
| `local-evals/src/local_evals/planning.py` (create) | Planned work, variant diffs, warnings, time range. |
| `local-evals/src/local_evals/stats.py` (create) | Exact McNemar, Wilson interval, paired cluster bootstrap. |
| `local-evals/src/local_evals/compare.py` (create) | Compatibility check and paired comparison. |
| `local-evals/src/local_evals/report.py`, `cli.py` (modify) | Multi-variant report; `freeze`, `plan`, `run --experiment`, `resume`, `compare`. |
| `local-evals/fixtures/tools/v1.jsonl` (create) | Mock-tool cases. |
| `local-evals/manifests/` (create) | Frozen sample manifests: ids and content hashes only. |
| `local-evals/configs/suites/{quick,standard}.yaml`, `configs/experiments/*.yaml`, `configs/estimates.yaml` (create) | Suites, experiments, planning assumptions. |

---

### Task 1: Override schema, request intent and context resolution

**Goal:** A request intent can carry overrides for the model preset it names. They apply to a clone of that preset for this request only.

**Files:**
- Modify: `packages/contracts/src/bench.ts`
- Modify: `src/lib/model-request-intent.ts`
- Modify: `src/status-server/model-request-context.ts`
- Test: `tests/model-request-context.test.ts`

**Decisions:**

Add to `packages/contracts/src/bench.ts`. The schema is derived from the preset schema, so the field types are never restated:

```ts
/** Request header carrying a JSON object of preset overrides for one benchmark request. */
export const BENCH_OVERRIDES_HEADER = 'x-siftkit-bench-overrides';

/** The load-affecting preset fields a benchmark variant may change. Sampling and reasoning fields are not here: the request carries those. */
export const BenchPresetOverridesSchema = ModelRuntimePresetSchema.pick({
  Model: true, ModelPath: true, NumCtx: true, KvCacheQuantization: true, NcpuMoe: true, UBatchSize: true,
  ParallelSlots: true, SpeculativeEnabled: true, SpeculativeDraftMax: true, SpeculativeDynamic: true,
  HybridDraftTokens: true, SparseDraftHead: true, DiskCacheDir: true, RamDiskCache: true,
}).partial();
export type BenchPresetOverrides = z.infer<typeof BenchPresetOverridesSchema>;
```

Change the identity schemas in the same file:

```ts
export const BenchIdentityRequestSchema = z.strictObject({
  model: z.string().min(1),
  overrides: BenchPresetOverridesSchema.optional(),
});
// in BenchIdentityResponseSchema:
  requested: z.strictObject({ presetId: z.string(), overrides: BenchPresetOverridesSchema, settings: ModelRuntimePresetSchema }),
```

`ModelRequestIntentSchema` gains `modelPresetOverrides: BenchPresetOverridesSchema.optional()`.

In `resolveModelRequestContext`, after the preset is selected (all three existing branches) and before the execution config is cloned:
- overrides with at least one key and no `intent.modelPresetId` throw `Model preset overrides require modelPresetId.`;
- otherwise `modelPreset` becomes `{ ...modelPreset, ...intent.modelPresetOverrides }`;
- nothing else changes. The existing `ModelRequestContextSchema.parse` then validates the overridden preset inside the execution config, so a combination the config schema forbids is an error here.

If `pick` on the strict preset schema does not stay strict in this zod version (the unknown-key test below fails), append `.strict()` to the override schema.

**Failing test:** append to `tests/model-request-context.test.ts`:

```ts
test('model preset overrides apply to a clone of the selected preset and never to saved config', () => {
  const config = createPresetRoutingConfig();
  const [selected] = config.Server.ModelPresets.Presets;
  assert.ok(selected);
  const saved = JSON.stringify(config);
  const otherKv = selected.KvCacheQuantization === 'f16' ? 'q8_0' : 'f16';

  const context = resolveModelRequestContext(config, getActiveModelPreset(config), {
    presetId: null,
    model: null,
    modelPresetId: selected.id,
    modelPresetOverrides: { NumCtx: selected.NumCtx + 4096, KvCacheQuantization: otherKv },
  });

  assert.equal(context.modelPreset.id, selected.id);
  assert.equal(context.modelPreset.NumCtx, selected.NumCtx + 4096);
  assert.equal(context.modelPreset.KvCacheQuantization, otherKv);
  assert.equal(context.modelPreset.Temperature, selected.Temperature);
  assert.deepEqual(findModelPreset(context.config, selected.id), context.modelPreset);
  assert.equal(JSON.stringify(config), saved);
});

test('model preset overrides need a named model preset and must keep the config valid', () => {
  const config = createPresetRoutingConfig();
  const [selected] = config.Server.ModelPresets.Presets;
  assert.ok(selected);
  const applied = getActiveModelPreset(config);

  assert.throws(
    () => resolveModelRequestContext(config, applied, { presetId: null, model: null, modelPresetOverrides: { NumCtx: 8192 } }),
    /require modelPresetId/u,
  );
  assert.throws(
    () => resolveModelRequestContext(config, applied, {
      presetId: null, model: null, modelPresetId: selected.id,
      modelPresetOverrides: { RamDiskCache: true, DiskCacheDir: 'C:\\exl3-cache' },
    }),
    /two disk caches/u,
  );
  const unchanged = resolveModelRequestContext(config, applied, {
    presetId: null, model: null, modelPresetId: selected.id, modelPresetOverrides: {},
  });
  assert.deepEqual(unchanged.modelPreset, selected);
});
```

Run: `npm run typecheck:test` — expected FAIL: `modelPresetOverrides` is not a property of the intent.
After implementing: `node .\src\test-runner\run-tests.ts model-request-context` — expected: all pass.

**Acceptance:** the override schema rejects `{ Temperature: 0.2 }`; saved config is byte-identical after a resolution with overrides; every existing test in the file still passes.

---

### Task 2: Overrides on the bench route

**Goal:** `chat/completions` and `token/encode` read overrides from the request header, `identity` reads them from its body, and a variant that cannot be loaded is a 400 before anything is queued.

**Files:**
- Modify: `src/status-server/routes/bench.ts`
- Test: `tests/bench-route.e2e.test.ts`

**Decisions:**

- `requestJsonWithHeaders(url, options)` in `tests/helpers/dashboard-http.ts` already accepts request `headers`; no helper change is needed.
- New function in `bench.ts`: `readBenchOverrides(req: IncomingMessage): BenchPresetOverrides`. No header returns `{}`. A header that is not JSON, or that fails `BenchPresetOverridesSchema`, throws an `Error` whose message starts with `Invalid X-SiftKit-Bench-Overrides:` followed by the cause.
- `admitBenchRequest(ctx, req, res, presetId, overrides)` builds the intent `{ presetId: null, model: null, modelPresetId: presetId, modelPresetOverrides: overrides }`. Inside its existing preview `try` it also calls `benchResidencyHash(ctx, target.modelPreset)`, so a preset the adapter cannot turn into a load request (a model path outside the model root, a KV mode with no draft cache mode) is answered with 400 and the adapter's message.
- Chat and token-encode handlers call `readBenchOverrides` first and answer 400 with its message on failure.
- Identity takes `overrides` from the parsed body, resolves with the same intent, wraps the residency computation in the same 400 handling, and returns `requested.overrides` (the parsed overrides, `{}` when none).
- The upstream request never carries the header: `proxyStreamingRequest` already forwards only `content-type`, `accept` and `authorization`. No code is needed.
- Overrides do not persist. A following request without the header targets the saved preset and reloads it.

**Failing test:** add `BENCH_OVERRIDES_HEADER` to the contracts import in `tests/bench-route.e2e.test.ts` and append:

```ts
function postBenchWith(
  server: PassthroughServer,
  path: string,
  body: JsonValue,
  overridesHeader: string,
): Promise<HeaderedJsonResponse> {
  return requestJsonWithHeaders(`${server.baseUrl}/bench/v1${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: BENCH_TIMEOUT_MS,
    headers: { [BENCH_OVERRIDES_HEADER]: overridesHeader },
  });
}

test('bench overrides load a variant of a saved preset without touching saved config', async () => {
  await using server = await startBenchServer();
  const savedBefore = JSON.stringify(readConfig(getConfigPath()).Server.ModelPresets);
  const base = await postBench(server, '/chat/completions', chatBody('default'));
  const launchesBefore = server.launcher.launches.length;

  const variant = await postBenchWith(server, '/chat/completions', chatBody('default'), JSON.stringify({ NumCtx: 16_000 }));

  assert.equal(variant.statusCode, 200, JSON.stringify(variant.body));
  assert.notEqual(variant.headers[BENCH_RESIDENCY_HEADER], base.headers[BENCH_RESIDENCY_HEADER]);
  assert.ok(server.launcher.launches.length > launchesBefore, 'the variant was loaded');
  assert.equal(JSON.stringify(readConfig(getConfigPath()).Server.ModelPresets), savedBefore);

  const asVariant = BenchIdentityResponseSchema.parse(
    (await postBench(server, '/identity', { model: 'default', overrides: { NumCtx: 16_000 } })).body,
  );
  const asSaved = BenchIdentityResponseSchema.parse((await postBench(server, '/identity', { model: 'default' })).body);
  assert.deepEqual(asVariant.requested.overrides, { NumCtx: 16_000 });
  assert.equal(asVariant.requested.settings.NumCtx, 16_000);
  assert.equal(asVariant.resident.matches, true);
  assert.equal(asVariant.resident.card?.max_seq_len, 16_000);
  assert.equal(asVariant.residency.keyHash, variant.headers[BENCH_RESIDENCY_HEADER]);
  assert.deepEqual(asSaved.requested.overrides, {});
  assert.equal(asSaved.resident.matches, false);
});

test('a KV-cache override changes the cache mode the engine reports', async () => {
  await using server = await startBenchServer();
  await postBench(server, '/chat/completions', chatBody('default'));
  const saved = BenchIdentityResponseSchema.parse((await postBench(server, '/identity', { model: 'default' })).body);
  const overrides = { KvCacheQuantization: saved.requested.settings.KvCacheQuantization === 'f16' ? 'q8_0' : 'f16' };

  const chat = await postBenchWith(server, '/chat/completions', chatBody('default'), JSON.stringify(overrides));
  const variant = BenchIdentityResponseSchema.parse(
    (await postBench(server, '/identity', { model: 'default', overrides })).body,
  );

  assert.equal(chat.statusCode, 200, JSON.stringify(chat.body));
  assert.equal(variant.resident.matches, true);
  assert.ok(saved.resident.card);
  assert.ok(variant.resident.card);
  assert.notEqual(variant.resident.card.cache_mode, saved.resident.card.cache_mode);
});

test('bench overrides that are malformed, outside the whitelist or unloadable are rejected before any load', async () => {
  await using server = await startBenchServer();
  await postBench(server, '/chat/completions', chatBody('default'));
  const launchesBefore = server.launcher.launches.length;
  const send = (header: string) => postBenchWith(server, '/chat/completions', chatBody('default'), header);

  const sampling = await send(JSON.stringify({ Temperature: 0.2 }));
  assert.equal(sampling.statusCode, 400);
  assert.match(String(sampling.body.error), /X-SiftKit-Bench-Overrides.*Temperature/isu);
  assert.equal((await send('{not json')).statusCode, 400);
  assert.equal((await send(JSON.stringify({ NumCtx: 'big' }))).statusCode, 400);
  const conflicting = await send(JSON.stringify({ RamDiskCache: true, DiskCacheDir: 'C:\\exl3-cache' }));
  assert.equal(conflicting.statusCode, 400);
  assert.match(String(conflicting.body.error), /two disk caches/u);
  const outside = await send(JSON.stringify({ ModelPath: 'C:\\elsewhere\\model' }));
  assert.equal(outside.statusCode, 400);
  assert.match(String(outside.body.error), /inside ModelRoot/u);
  const identity = await postBench(server, '/identity', { model: 'default', overrides: { Temperature: 0.2 } });
  assert.equal(identity.statusCode, 400);
  const encode = await postBenchWith(server, '/token/encode', { model: 'default', text: 'abcd' }, '{not json');
  assert.equal(encode.statusCode, 400);

  assert.equal(server.launcher.launches.length, launchesBefore);
});
```

Add a fourth test, `every whitelisted override changes the residency identity`, written against the fixture preset:
- Read the saved settings from `identity`. For each row below, request `identity` twice, with the base overrides and with the changed overrides, and assert the two `residency.keyHash` values differ.

| Key under test | Base overrides | Changed overrides |
|---|---|---|
| `Model` | `{}` | `{ Model: 'bench-renamed' }` |
| `NumCtx` | `{}` | `{ NumCtx: saved + 4096 }` |
| `KvCacheQuantization` | `{}` | the other of `f16` / `q8_0` |
| `NcpuMoe` | `{}` | `{ NcpuMoe: saved + 8 }` |
| `UBatchSize` | `{}` | `{ UBatchSize: saved * 2 }` |
| `ParallelSlots` | `{}` | `{ ParallelSlots: saved + 1 }` |
| `SpeculativeEnabled` | `{}` | the negation |
| `SpeculativeDraftMax` | `{}` | `{ SpeculativeDraftMax: saved + 1 }` |
| `HybridDraftTokens` | `{}` | `{ HybridDraftTokens: saved + 1 }` |
| `SpeculativeDynamic` | `{ SpeculativeEnabled: true }` | plus the negated `SpeculativeDynamic` |
| `SparseDraftHead` | `{ SpeculativeEnabled: true }` | plus `SparseDraftHead: saved + 1024` |
| `RamDiskCache` | `{}` | the negation |
| `DiskCacheDir` | `{ RamDiskCache: false }` | plus `DiskCacheDir: 'C:\\exl3-cache-b'` |

- `ModelPath` is covered by the 400 case above; the fixture has one model directory.
- If a row is rejected with 400 because the fixture preset cannot take that value (for example a KV mode without a draft cache mode when drafting is switched on), change the row's values until both requests are accepted; do not drop the row.
- If both requests are accepted and the hashes are equal, the key does not affect what is loaded. Remove it from `BenchPresetOverridesSchema` and from the whitelist in the spec, and report it. A variant that differs only in such a key would be measured against an identical model.

Run: `npm run typecheck:test` then `node .\src\test-runner\run-tests.ts bench-route` — expected before implementing: FAIL on the missing `BENCH_OVERRIDES_HEADER` export.

**Acceptance:** all bench tests pass; saved `ModelPresets` are byte-identical after override requests; no rejected request launches or loads anything.

---

### Task 3: TypeScript gate

- [ ] `npm run typecheck` exits 0 (it runs lint).
- [ ] `npm test` exits 0. Report any failure by test name; do not weaken a test.
- [ ] Add one sentence to the "Benchmark route" section of `README.md`: `A request may carry X-SiftKit-Bench-Overrides, a JSON object of load-affecting preset fields, to run a variant of a saved preset without saving it.`

---

### Task 4: Overrides in the bench client

**Goal:** Every client call can name a variant; the fake route answers for variants the way the real one does.

**Files:**
- Modify: `local-evals/src/local_evals/siftkit.py`
- Modify: `local-evals/tests/fake_bench.py`
- Test: `local-evals/tests/test_siftkit.py`

**Decisions:**

```python
OVERRIDES_HEADER = "x-siftkit-bench-overrides"
Overrides = Mapping[str, JsonValue]

def overrides_headers(overrides: Overrides | None) -> dict[str, str]:
    """The request headers naming a variant; empty when there are no overrides. Keys are sorted, so the value is stable."""

class RequestedIdentity(_Wire):
    presetId: str
    overrides: dict[str, JsonValue]
    settings: dict[str, JsonValue]

class BenchClient:
    def identity(self, model: str, overrides: Overrides | None = None) -> Identity: ...
    def count_tokens(self, model: str, text: str | list[JsonValue], chat_template_kwargs: dict[str, JsonValue] | None = None,
                     overrides: Overrides | None = None) -> int: ...
    def chat(self, payload: dict[str, JsonValue], overrides: Overrides | None = None) -> ChatResponse: ...
    def stream_chat(self, payload: dict[str, JsonValue], overrides: Overrides | None = None) -> Iterator[StreamFrame]: ...
```

- `identity` sends overrides in the body (`{"model": ..., "overrides": {...}}`, the key omitted when empty); the other three send the header.
- `FakeBench` gains `resident_overrides: dict[str, Any]` (default `{}`) and `unloadable: frozenset[str]` (default empty; override keys the fake rejects with 400, standing for a variant that cannot load).
  - Identity: `matches` is true when `resident == model` and the request's overrides equal `resident_overrides`. `requested.overrides` echoes the request; `requested.settings` is the base settings with the overrides merged in. `residency.keyHash` is `RESIDENCY` for no overrides, otherwise the first 16 hex digits of the SHA-256 of the sorted-key JSON of the overrides.
  - Chat: reads the header; a header key in `unloadable` answers 400 `{"error": "variant cannot be loaded"}`; otherwise it sets `resident_overrides` to the header's overrides (the fake "loads" the variant), increments `generation` when they changed, and returns the matching residency header.

**Failing test** (append to `tests/test_siftkit.py`):

```python
def test_overrides_travel_in_the_header_for_chat_and_in_the_body_for_identity() -> None:
    fake = FakeBench()
    client = client_for(fake)
    variant = {"NumCtx": 32768, "KvCacheQuantization": "f16"}

    assert client.identity("preset-a", variant).resident.matches is False
    loaded = client.chat({"model": "preset-a", "messages": [], "max_tokens": 1}, variant)
    identity = client.identity("preset-a", variant)

    assert loaded.status_code == 200 and loaded.generation == 4
    assert identity.resident.matches is True
    assert identity.requested.overrides == variant
    assert identity.requested.settings["NumCtx"] == 32768
    assert identity.residency.keyHash == loaded.residency != RESIDENCY
    assert client.identity("preset-a").resident.matches is False
    sent = fake.requests[1]
    assert sent.headers["x-siftkit-bench-overrides"] == '{"KvCacheQuantization":"f16","NumCtx":32768}'
    assert all("x-siftkit-bench-overrides" not in request.headers for request in (fake.requests[0], fake.requests[2]))


def test_an_unloadable_variant_is_a_measured_400_not_an_exception() -> None:
    fake = FakeBench(unloadable=frozenset({"NumCtx"}))
    response = client_for(fake).chat({"model": "preset-a", "messages": [], "max_tokens": 1}, {"NumCtx": 999_999})
    assert response.status_code == 400 and fake.resident_overrides == {}
```

Run: `pytest tests/test_siftkit.py -v` — expected before implementing: FAIL, `identity()` takes no overrides.

**Acceptance:** the existing four client tests still pass unchanged apart from `requested.overrides` being present.

---

### Task 5: Metrics, content hashes and extra headers in the evaluator boundary

**Goal:** A normalized sample carries every numeric score component, the hash of the content it was scored on, and a named primary metric; a run can attach request headers.

**Files:**
- Modify: `local-evals/src/local_evals/evaluators/base.py`
- Modify: `local-evals/src/local_evals/evaluators/inspect_eval.py`
- Modify: `local-evals/src/local_evals/records.py`
- Test: `local-evals/tests/test_inspect_evaluator.py`, `local-evals/tests/test_inspect_wire.py`

**Decisions:**

```python
# base.py
@dataclass(frozen=True)
class TaskRunRequest:
    ...                                   # plan 1 fields, unchanged
    primary_metric: str | None            # None: the first scorer's scalar value
    extra_headers: Mapping[str, str]

@dataclass(frozen=True)
class RawLogRef:
    evaluator: str
    path: Path
    task: str
    primary_metric: str | None

# records.py (frozen pydantic model; SampleRecord inherits it)
class EvaluatedSample(BaseModel):
    ...                                   # plan 1 fields, unchanged
    metrics: dict[str, float]
    content_hash: str

# base.py

def content_hash(input_text: str, target: Sequence[str], choices: Sequence[str]) -> str:
    """SHA-256 of the canonical JSON of (input, target, choices). Identifies what was asked, independent of the harness."""
```

- `SampleRecord` inherits `metrics` and `content_hash` from `EvaluatedSample`; declare them once, there.
- Metric names: `<scorer>` for a scalar score, `<scorer>.<key>` for each numeric entry of a dict-valued score. Values go through the harness's own float conversion, so `C`/`I` become 1.0/0.0. Non-numeric entries are skipped.
- `score` is `metrics[primary_metric]` when a primary metric is named, else the first scorer's scalar value. A named primary metric that is absent from a sample makes that sample `infra_error` with `error` naming the missing metric and listing the available ones.
- Inspect input normalization for the hash: a string input is used as is; a message list becomes the JSON of `[[role, text], ...]`. Target is always a list of strings. Choices is the sample's choices or `[]`.
- Headers: pass `extra_headers` through Inspect's generation config. Gate before coding: `python -c "from inspect_ai.model import GenerateConfig; print('extra_headers' in GenerateConfig.model_fields)"`. If it prints `False`, pass them as `model_args={"default_headers": ...}` merged over the request's model args instead. Either way the wire test below is the proof. If neither reaches the wire, stop and report: the spec's fallback (overrides in `extra_body`) needs a route change.
- Plan 1 call sites and tests are updated for the new required fields: `primary_metric=None, extra_headers={}`.

**Failing tests:**

Append to `tests/test_inspect_evaluator.py`:

```python
def test_samples_carry_metrics_and_a_content_hash_that_follows_the_content(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    first = sorted(evaluator.read_samples(evaluator.run(request(tmp_path / "a", ["{}", "{}"], limit=2))),
                   key=lambda sample: sample.sample_id)
    again = sorted(evaluator.read_samples(evaluator.run(request(tmp_path / "b", ["{}", "{}"], limit=2))),
                   key=lambda sample: sample.sample_id)

    assert first[0].metrics == {"structured_scorer": 0.0}
    assert len(first[0].content_hash) == 64 and first[0].content_hash != first[1].content_hash
    assert [sample.content_hash for sample in first] == [sample.content_hash for sample in again]


def test_a_missing_primary_metric_is_an_infrastructure_error_that_names_what_exists(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    wanted = dataclasses.replace(request(tmp_path / "log", ["{}"], limit=1), primary_metric="structured_scorer.absent")
    sample = next(iter(evaluator.read_samples(evaluator.run(wanted))))
    assert sample.status == "infra_error" and sample.score is None
    assert sample.error is not None and "structured_scorer.absent" in sample.error and "structured_scorer" in sample.error
```

A dict-valued score is first produced by Task 11's mock-tool scorer, so the dict-valued normalization test is written there.

Append to `tests/test_inspect_wire.py`:

```python
def test_variant_overrides_reach_the_endpoint_as_a_header(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with capture_server() as server:
        monkeypatch.setenv("SIFTBENCH_BASE_URL", server.base_url)
        monkeypatch.setenv("SIFTBENCH_API_KEY", "local")
        InspectEvaluator().run(TaskRunRequest(
            task="local_evals/structured_output", task_args={}, model=LiveModel(preset="preset-a", endpoint=ENDPOINT, api_key=None),  # as built: a ModelRef, not a string
            sample_ids=["so-001"], limit=None, generation=GENERATION, max_tokens=256, max_retries=1,
            timeout_seconds=60, log_dir=tmp_path / "log", primary_metric=None,
            extra_headers={"x-siftkit-bench-overrides": '{"NumCtx":32768}'},
        ))
    assert server.chat_requests()[0].headers["x-siftkit-bench-overrides"] == '{"NumCtx":32768}'
```

Run: `pytest tests/test_inspect_evaluator.py tests/test_inspect_wire.py -v` — expected before implementing: FAIL, unexpected keyword `primary_metric`.

**Acceptance:** the override header is observed on the wire; two runs of the same samples produce equal content hashes; record the header mechanism used (`extra_headers` or `default_headers`) in the README capability table.

---

### Task 6: Catalogue fields and sample listing

**Goal:** The catalogue says how to build each task and which metric is primary; an evaluator can list a task's samples without calling a model.

**Files:**
- Modify: `local-evals/src/local_evals/config.py` (`TaskSpec`)
- Modify: `local-evals/src/local_evals/evaluators/base.py`, `inspect_eval.py`
- Modify: `local-evals/src/local_evals/tasks/inspect_bindings.py`
- Modify: `local-evals/configs/tasks.yaml`
- Test: `local-evals/tests/test_inspect_evaluator.py`, `local-evals/tests/test_config.py`

**Decisions:**

```python
class TaskSpec(Strict):
    id: str
    evaluator: Literal["inspect"]
    # "module:function" of the task factory in the evaluator's package; null for tasks in this package.
    factory: str | None
    sandbox: bool
    judge: bool
    # Needs native or emulated tool calling.
    tools: bool
    extras: list[str]
    dataset: str | None
    # The dataset needs accepted terms and a Hugging Face token.
    gated: bool
    license: str | None
    primary_metric: str | None
    # Further metrics a report shows beside the primary one.
    report_metrics: list[str]
    # Sample metadata key used for stratified selection; null selects without strata.
    stratify_by: str | None
    verified_with: str

# base.py
@dataclass(frozen=True)
class SampleInfo:
    sample_id: str
    content_hash: str
    stratum: str | None

class Evaluator(Protocol):
    name: str
    def list_samples(self, task: str, task_args: Mapping[str, JsonValue], factory: str | None,
                     stratify_by: str | None) -> list[SampleInfo]: ...
    def run(self, request: TaskRunRequest) -> RawLogRef: ...
    def read_samples(self, log: RawLogRef) -> Iterator[EvaluatedSample]: ...
```

- `inspect_bindings.LOCAL_TASKS` is an explicit mapping from local task id to its `@task` function; `local_evals/structured_output` is its first entry. The adapter's local-task branch becomes a lookup in it; an unknown `local_evals/...` id is still an `EvaluatorError`.
- `list_samples` builds the task (local: from `LOCAL_TASKS`; upstream: imports `factory` and calls it with `task_args`), reads its dataset, and returns one `SampleInfo` per sample with the same `content_hash` function `read_samples` uses. A missing `factory` for an upstream task, an import failure, or a dataset that cannot be loaded is an `EvaluatorError` naming the task. A sample without an id is an `EvaluatorError`: an unstable id cannot be frozen.
- `stratum` is `str(sample.metadata[stratify_by])`, or `None` when `stratify_by` is null. A sample lacking the key is an `EvaluatorError`.
- `configs/tasks.yaml`: the two plan-1 entries gain `factory` (`inspect_evals.gsm8k:gsm8k` and `null`), `tools: false`, `gated: false`, `primary_metric: null`, `report_metrics: []`, `stratify_by: null`. Confirm the gsm8k import path: `python -c "from inspect_evals.gsm8k import gsm8k"`.

**Failing test** (append to `tests/test_inspect_evaluator.py`):

```python
def test_list_samples_matches_what_a_run_scores_and_calls_no_model(tmp_path: Path) -> None:
    evaluator = InspectEvaluator()
    listed = evaluator.list_samples(TASK, {}, None, None)
    assert [info.sample_id for info in listed] == [case.id for case in CASES]
    assert all(info.stratum is None for info in listed)

    scored = {sample.sample_id: sample.content_hash
              for sample in evaluator.read_samples(evaluator.run(request(tmp_path / "log", ["{}"] * 6, limit=None)))}
    assert {info.sample_id: info.content_hash for info in listed} == scored


def test_list_samples_errors_name_the_task() -> None:
    evaluator = InspectEvaluator()
    with pytest.raises(EvaluatorError, match="no_such_task"):
        evaluator.list_samples("local_evals/no_such_task", {}, None, None)
    with pytest.raises(EvaluatorError, match="inspect_evals/upstream"):
        evaluator.list_samples("inspect_evals/upstream", {}, None, None)
    with pytest.raises(EvaluatorError, match="not.a.module"):
        evaluator.list_samples("inspect_evals/upstream", {}, "not.a.module:task", None)
    with pytest.raises(EvaluatorError, match="difficulty"):
        evaluator.list_samples(TASK, {}, None, "difficulty")
```

Add to `tests/test_config.py`: the shipped catalogue loads with the new fields, and a catalogue entry missing `factory` is a `ConfigError`.

Run: `pytest tests/test_inspect_evaluator.py tests/test_config.py -v`.

**Acceptance:** listed and scored content hashes are equal for the same samples; listing makes no model call (the mock model's outputs are untouched).

---

### Task 7: Seeded stratified selection and frozen sample manifests

**Goal:** Choose a sample subset once, reproducibly, and freeze it as ids plus content hashes.

**Files:**
- Create: `local-evals/src/local_evals/samples.py`
- Test: `local-evals/tests/test_samples.py`

**Decisions:**

```python
class SampleManifestError(Exception): ...

class FrozenSample(Strict):
    id: str
    content_hash: str

class SampleManifest(Strict):
    task: str
    task_args: dict[str, JsonValue]
    evaluator: str
    verified_with: str          # copied from the catalogue entry
    seed: int
    stratify_by: str | None
    population: int
    samples: list[FrozenSample]

    def digest(self) -> str: ...             # SHA-256 of the canonical JSON
    def ids(self) -> list[str]: ...

def select_samples(population: Sequence[SampleInfo], count: int, seed: int) -> list[SampleInfo]: ...
def freeze(spec: TaskSpec, task_args: Mapping[str, JsonValue], evaluator: Evaluator, count: int | None, seed: int) -> SampleManifest: ...
def load_manifest(path: Path) -> SampleManifest: ...
def write_manifest(path: Path, manifest: SampleManifest) -> None: ...
def verify(manifest: SampleManifest, scored: Mapping[str, str]) -> list[str]:
    """Ids whose scored content hash differs from the frozen one, or that were not scored at all."""
```

Selection algorithm, stated so two implementations agree:
1. Order key of a sample: `sha256(f"{seed}:{sample_id}")` as hex. It depends on nothing but the seed and the id, so reordering the population changes nothing.
2. `count >= len(population)` selects everything.
3. Without strata (every `stratum` is `None`): take the `count` smallest order keys.
4. With strata: quota for stratum `s` is `count * size(s) / len(population)`. Give each stratum the floor of its quota, then give the remaining seats one at a time to the largest fractional parts, ties broken by stratum name. Then, while `count >= number of strata` and some stratum has zero seats, move one seat to it from the stratum that currently has the most seats (ties by name). Within a stratum take the smallest order keys.
5. Mixed `None` and non-`None` strata is a `SampleManifestError`.
6. The result is sorted by sample id.

`freeze` with `count=None` freezes the whole population. A duplicate sample id in the population is a `SampleManifestError`.

Manifest files live at `manifests/<suite>/<task-key>.json` (key with `/` replaced by `__`), written as indented JSON with sorted keys. They hold ids and hashes only, never prompt or answer text.

**Failing test:** `tests/test_samples.py`:

```python
import pytest

from local_evals.evaluators.base import SampleInfo
from local_evals.samples import SampleManifestError, select_samples


def population(sizes: dict[str | None, int]) -> list[SampleInfo]:
    people: list[SampleInfo] = []
    for stratum, size in sizes.items():
        start = len(people)
        people += [SampleInfo(f"s{index:03d}", f"hash-{index}", stratum) for index in range(start, start + size)]
    return people


def counts(selected: list[SampleInfo]) -> dict[str | None, int]:
    result: dict[str | None, int] = {}
    for sample in selected:
        result[sample.stratum] = result.get(sample.stratum, 0) + 1
    return result


def test_selection_is_deterministic_and_independent_of_population_order() -> None:
    people = population({None: 100})
    first = select_samples(people, 10, seed=7)
    assert len(first) == 10 and first == sorted(first, key=lambda sample: sample.sample_id)
    assert select_samples(list(reversed(people)), 10, seed=7) == first
    assert select_samples(people, 10, seed=8) != first
    assert select_samples(people, 500, seed=7) == people


@pytest.mark.parametrize(("sizes", "count", "expected"), [
    ({"a": 60, "b": 30, "c": 10}, 10, {"a": 6, "b": 3, "c": 1}),
    ({"a": 50, "b": 30, "c": 20}, 7, {"a": 4, "b": 2, "c": 1}),
    ({"a": 97, "b": 2, "c": 1}, 5, {"a": 3, "b": 1, "c": 1}),
    ({"a": 97, "b": 2, "c": 1}, 2, {"a": 2}),
])
def test_strata_get_proportional_seats_and_none_is_left_empty_when_seats_allow(
        sizes: dict[str | None, int], count: int, expected: dict[str | None, int]) -> None:
    assert counts(select_samples(population(sizes), count, seed=1)) == expected


def test_a_growing_sample_keeps_the_smaller_one_within_a_stratum() -> None:
    people = population({None: 50})
    small = {sample.sample_id for sample in select_samples(people, 5, seed=3)}
    large = {sample.sample_id for sample in select_samples(people, 20, seed=3)}
    assert small <= large


def test_mixed_strata_are_rejected() -> None:
    with pytest.raises(SampleManifestError):
        select_samples(population({"a": 3, None: 3}), 2, seed=1)
```

Add tests for: `freeze` through a scripted evaluator (Task 9's helper is not needed; a five-line stub class with `list_samples` suffices) producing a manifest whose `digest()` is stable and changes when one content hash changes; `write_manifest`/`load_manifest` round trip; a malformed manifest file is a `SampleManifestError` naming the path; `verify` returns exactly the ids that drifted or are missing; duplicate ids are rejected.

Run: `pytest tests/test_samples.py -v` — expected before implementing: `ModuleNotFoundError: local_evals.samples`.

**Acceptance:** the four parametrized allocations pass exactly; a manifest file contains no prompt text.

---

### Task 8: One manifest for suite runs and experiments

**Goal:** A suite run is an experiment with one variant. Replace the suite-only manifest; do not keep both.

**Files:**
- Modify: `local-evals/src/local_evals/config.py`
- Modify: `local-evals/src/local_evals/runstore.py`
- Modify: `local-evals/tests/test_config.py`, `tests/test_runstore.py`

**Decisions:**

```python
VARIANT_ID = r"^[a-z0-9][a-z0-9._-]*$"

class Variant(Strict):
    id: str                                   # matches VARIANT_ID
    preset: str
    overrides: dict[str, JsonValue] = {}
    tool_mode: Literal["native", "emulated"] = "native"
    # manual: the backend itself is changed by hand between variants; the runner pauses before it.
    swap: Literal["auto", "manual"] = "auto"
    note: str | None = None

class SuiteTask(Strict):
    task: str
    # Labels this entry when a suite lists one task more than once.
    name: str | None = None
    limit: int | None = None
    # Path under manifests/ of the frozen sample manifest. Exclusive with `limit`.
    sample_manifest: str | None = None
    max_tokens: int
    task_args: dict[str, JsonValue] = {}

    @property
    def key(self) -> str: ...                 # name or task

class Suite(Strict):
    name: str
    tasks: list[SuiteTask]                    # keys unique; validated

class ExperimentFile(Strict):
    name: str                                 # matches VARIANT_ID
    endpoint: str
    generation: str
    suite: str
    reference: str
    variants: list[Variant]                   # at least two, ids unique, reference among them
    repeats: int = 1                          # 1..10
    # The single field this experiment means to vary; null for a deployment comparison.
    changed_field: str | None

class ResolvedManifest(Strict):
    kind: Literal["suite", "experiment"]
    name: str
    endpoint_name: str
    endpoint: Endpoint
    generation: GenerationProfile
    suite: Suite
    limits: Limits
    reference: str
    variants: list[Variant]
    repeats: int
    changed_field: str | None
    provenance: dict[str, ModelProvenance | None]      # by preset id
    sample_manifests: dict[str, str]                   # task key -> manifest digest; only tasks that have one

    def digest(self) -> str: ...
    def protocol_digest(self) -> str:
        """Digest of what two runs must share to be compared: generation, suite, repeats, sample manifests."""
    def variant(self, variant_id: str) -> Variant: ...  # ConfigError when absent

def resolve_manifest(config_dir: Path, manifests_dir: Path, *, endpoint: str, model: str, suite: str,
                     generation: str) -> ResolvedManifest: ...
def resolve_experiment(config_dir: Path, manifests_dir: Path, path: Path) -> ResolvedManifest: ...
```

- `resolve_manifest` yields `kind="suite"`, `name=<suite>`, one variant `Variant(id=<model>, preset=<model>)`, `reference=<model>`, `repeats=1`, `changed_field=None`. A preset id that does not match `VARIANT_ID` is a `ConfigError` telling the user to run it through an experiment file with an explicit variant id.
- Both resolvers load every `sample_manifest` named by the suite, check its `task` and `task_args` against the suite entry (a mismatch is a `ConfigError` naming both), and store its digest. A named manifest file that does not exist is a `ConfigError` that says to run `local-evals freeze`.
- A suite entry with both `limit` and `sample_manifest` is a `ConfigError`. An experiment (`kind="experiment"`) whose suite has an entry without `sample_manifest` is a `ConfigError`: a comparison needs frozen samples.
- `protocol_digest` excludes endpoint, variants, provenance, limits and name.
- `RunStore.create` is unchanged in signature and writes the new manifest. `RunStatus` gains `"paused_manual_swap"`.
- New `RunStore` members:

```python
    def load_manifest(self) -> ResolvedManifest: ...                       # from manifest.resolved.json
    def unit_path(self, variant: str, task_key: str, repeat: int) -> Path: ...   # units/<variant>/<key>.r<n>.jsonl
    def write_unit(self, variant: str, task_key: str, repeat: int, records: Sequence[dict[str, JsonValue]]) -> None: ...
    def completed_units(self) -> set[tuple[str, str, int]]: ...
    def rebuild_samples(self) -> None: ...                                 # samples.jsonl := all unit files, atomically
    def variant_dir(self, variant: str) -> Path: ...                       # variants/<variant>/
    def raw_dir(self, variant: str, evaluator: str, task_key: str, repeat: int) -> Path: ...
```

- A unit file is written whole with the atomic write, so a unit either exists completely or not at all. `samples.jsonl` is derived from unit files and is never appended to.
- `raw_dir` gains the repeat (`.../<key>/r<n>`); the plan-1 three-argument form is removed and its call sites updated.

**Failing test:** in `tests/test_config.py`, replace the plan-1 manifest assertions with these scenarios (write each as a test):

1. `resolve_manifest(..., model="exl3-3-8-27b-5bpw", suite="smoke", ...)` has `kind == "suite"`, one variant whose id and preset are the model, `reference` equal to it, `repeats == 1`, `sample_manifests == {}`, and provenance for that preset with `nominal_bpw == 5.0`.
2. Two resolutions with different generation profiles have different `protocol_digest()`; two resolutions that differ only in `model` have equal `protocol_digest()` and different `digest()`.
3. An experiment file in `tmp_path` with two variants over a suite whose only entry names a manifest written by `write_manifest` resolves with `kind == "experiment"`, both variants, and `sample_manifests == {<key>: <digest>}`.
4. Each of these is a `ConfigError` naming the offending value: reference not among variants; duplicate variant ids; one variant; variant id `Bad Id`; `repeats: 0`; suite entry with `limit` and `sample_manifest`; experiment over a suite entry without a manifest; manifest file missing (message contains `freeze`); manifest `task_args` differing from the suite entry; duplicate task keys in a suite.

In `tests/test_runstore.py` add: `write_unit` then `completed_units()` and `rebuild_samples()` produce exactly the unit's rows; writing the same unit twice leaves one copy; a `.tmp` file left in `units/` is ignored; `load_manifest()` round-trips the manifest.

Run: `pytest tests/test_config.py tests/test_runstore.py -v`.

**Acceptance:** no code path refers to `ResolvedManifest.model` or `.provenance` as a single value; `grep -rn "manifest\.model\b" src` prints nothing.

---

### Task 9: The runner, rewritten around variants and units

**Goal:** `run_manifest` replaces `run_suite`. It evaluates one variant completely before the next, verifies what is loaded before and after, and writes each `(variant, task, repeat)` unit atomically.

**Files:**
- Replace: `local-evals/src/local_evals/runner.py`
- Create: `local-evals/tests/scripted_evaluator.py`
- Replace: `local-evals/tests/test_runner.py`

**Decisions:**

```python
@dataclass(frozen=True)
class LiveTarget:
    client: BenchClient
    api_key: str | None                  # as built in plan 1: no test-only fields; tests stub the Evaluator

@dataclass(frozen=True)
class MockTarget:
    # Mock-model arguments per variant id; a variant without an entry uses the mock model's default output.
    model_args: Mapping[str, Mapping[str, object]]

def run_manifest(manifest: ResolvedManifest, catalog: TaskCatalog, evaluators: Mapping[str, Evaluator], target: Target,
                 runs_root: Path, repo_root: Path, now: datetime, *, sample_manifests: Mapping[str, SampleManifest],
                 resume: RunStore | None = None) -> RunStore: ...
```

Order of work:
1. Scrub cloud keys, assert the model string is local, check every suite task is catalogued.
2. Variants run in this order: the reference, then the others in manifest order.
3. Per variant, *prepare*: a one-token warm chat carrying the variant's overrides, then `identity(preset, overrides)`, which must report `matches`. The identity is written to `variants/<id>/environment.json` together with the Tabby commit, the ExLlamaV3 version and the model directory fingerprint derived from it (plan 1's `collect_environment` splits into `collect_host()` for `environment.json` and `collect_variant(identity)`).
   - `environment.model_fingerprint(model_path: Path) -> dict[str, JsonValue] | None`: for the directory named by the identity's `ModelPath`, the sorted list of file names with sizes and modification times, plus the SHA-256 of each `.json` file no larger than 1 MiB. Weight files are listed, never read. A missing directory gives `None`.
4. The run directory is created after the reference variant prepared successfully. If that prepare fails, raise `RunError` and create nothing. On creation the frozen sample manifests in use are written to `samples.manifest.json` (task key to manifest), so the planned ids travel with the run.
5. A non-reference variant whose warm chat answers an HTTP error, or whose identity does not match, is *infeasible*: write `variants/<id>/state.json` `{"status": "infeasible", "detail": ...}`, append one `errors.jsonl` row with category `unavailable`, and go on to the next variant. It is never scored as zero.
6. A `swap: manual` variant: before preparing it, if `variants/<id>/state.json` does not say `ready`, write `{"status": "awaiting_manual_swap"}`, finish the run as `paused_manual_swap` and return. Resuming (Task 10) confirms the backend changed.
7. Per task, per repeat `r` in `1..repeats`: skip if the unit is already complete. Otherwise read the runtime generation, run the evaluator, read its samples, read the generation again, verify content hashes against the frozen manifest, write the unit, rebuild `samples.jsonl`.
   - The request's `sample_ids` are the frozen manifest's ids when the entry has one, else `None` with the entry's `limit`.
   - The seed for repeat `r` is `generation.seed + r - 1` (or `None` when the profile has no seed). It is recorded on every record; `repeat` on the record is `r`.
   - `extra_headers` is `overrides_headers(variant.overrides)`. `model_args` gains `emulate_tools: True` when `variant.tool_mode == "emulated"`.
   - `primary_metric` comes from the catalogue entry.
   - A task with `tools: true` and a variant in `native` mode is run as is; nothing is skipped here. `doctor` already reported whether native tools work.
   - Content-hash drift (`samples.verify` returns ids): the unit is not written; one `errors.jsonl` row with category `infra_error` names the ids; the run continues.
   - An evaluator failure: as plan 1, one `errors.jsonl` row, the run continues, the unit is not written.
   - Wall-clock cap, sandbox without Docker: as plan 1 (`skipped`, `unavailable`).
8. After a variant's last unit, `identity` again. If `matches` is false, append an `errors.jsonl` row with category `infra_error` and detail `variant <id> was no longer resident after its last sample`; the records stay, already carrying the generation numbers that show where it changed.
9. `variants/<id>/state.json` ends as `completed`. The run finishes `completed`, `aborted_wall_cap` or `paused_manual_swap`.

`tests/scripted_evaluator.py` — a test double implementing the `Evaluator` protocol without Inspect:

```python
@dataclass
class ScriptedEvaluator:
    """Returns scripted outcomes per (variant header, task, sample id); can fail on chosen calls."""
    name: str = "scripted"
    # Maps (overrides-header value or "", sample id) to a score in [0, 1] or a SampleStatus for operational outcomes.
    outcomes: dict[tuple[str, str], float | SampleStatus] = field(default_factory=lambda: {})
    population: dict[str, list[SampleInfo]] = field(default_factory=lambda: {})
    fail_on_call: set[int] = field(default_factory=lambda: set())     # 1-based call numbers that raise EvaluatorError
    interrupt_on_call: int | None = None                              # raises KeyboardInterrupt
    calls: list[TaskRunRequest] = field(default_factory=lambda: [])
    drift: set[str] = field(default_factory=lambda: set())            # sample ids scored with a changed content hash
```

`run` writes a JSON file of the request's results into `log_dir`; `read_samples` reads it back. A sample with no scripted outcome scores 1.0. The catalogue used by runner tests marks its tasks `evaluator: inspect` and the tests pass `{"inspect": ScriptedEvaluator()}`, so no catalogue change is needed.

**Failing test:** `tests/test_runner.py`, one test per scenario. Shared setup: a suite with two tasks (`t1`, `t2`) each with a frozen manifest of four ids (`a`..`d`) built in `tmp_path`; a manifest with reference variant `ref` and candidate `cand` with overrides `{"NumCtx": 32768}`; `FakeBench`; `ScriptedEvaluator`.

1. **Two variants, units and order.** `ref` runs both tasks before `cand` starts (assert on `evaluator.calls` order and on each call's `extra_headers`). Unit files exist for all four units. `samples.jsonl` has 16 rows; every row has `variant_id`, `repeat == 1`, `seed == 42`, a 64-character `content_hash`, and `residency_hash` differing between the two variants. `variants/ref/environment.json` holds an identity with `overrides == {}` and `variants/cand/environment.json` one with `overrides == {"NumCtx": 32768}`. State is `completed`.
2. **Repeats.** `repeats=3` gives three calls per unit with seeds 42, 43, 44 and three unit files per task; records carry `repeat` 1..3.
3. **Emulated tools.** A variant with `tool_mode="emulated"` passes `emulate_tools=True` in `model_args`; a native variant does not pass the key.
4. **Reference cannot load.** `FakeBench(chat_status=502)`: `RunError`, `runs_root` is empty.
5. **Candidate cannot load.** `FakeBench(unloadable=frozenset({"NumCtx"}))`: the run completes; `variants/cand/state.json` is `infeasible`; `samples.jsonl` has only `ref` rows; `errors.jsonl` has one `unavailable` row naming `cand`.
6. **Evaluator failure.** `fail_on_call={2}`: the second unit is absent, one `infra_error` row, the remaining units exist, state `completed`.
7. **Content drift.** `drift={"b"}` on one task: that unit is absent and the `errors.jsonl` row names `b`.
8. **Reload mid-variant.** A `FakeBench` whose `generation` is bumped by the test between the unit's two identity reads (subclass the scripted evaluator's `run` to bump it): the unit's records have `generation_start != generation_end`.
9. **Manual swap.** A second variant with `swap="manual"`: the run returns with state `paused_manual_swap`, `ref` complete, `variants/<id>/state.json` `awaiting_manual_swap`, no calls made for it.
10. **Model fingerprint.** `model_fingerprint` on a `tmp_path` directory holding `config.json` and a 3 MiB `model.safetensors`: both are listed with sizes; only `config.json` has a hash; a missing directory returns `None`.
11. **Mock target.** `MockTarget({})` with the real `InspectEvaluator` and the structured task over a frozen manifest of its six ids: six rows, `environment.json` `mocked: true`, and `variants/<id>/environment.json` has `identity: null`.

Run: `pytest tests/test_runner.py -v` — expected before implementing: `ImportError: cannot import name 'run_manifest'`.

**Acceptance:** `run_suite` no longer exists (`grep -rn "run_suite" src tests` prints nothing); a unit file is either complete or absent in every scenario.

---

### Task 10: Resume

**Goal:** An interrupted or paused run continues in place, redoing only incomplete units, and only when nothing about it changed.

**Files:**
- Modify: `local-evals/src/local_evals/runner.py`
- Test: `local-evals/tests/test_resume.py`

**Decisions:**

```python
def resume_run(store: RunStore, catalog: TaskCatalog, evaluators: Mapping[str, Evaluator], target: Target,
               repo_root: Path, *, current: ResolvedManifest, sample_manifests: Mapping[str, SampleManifest]) -> RunStore: ...
```

- `current` is the manifest resolved again from today's config files. Resume is refused with `RunError` when `current.digest()` differs from the digest in `state.json`; the message names the first top-level manifest field that differs. Sample manifests are part of the digest, so a re-frozen manifest is refused by the same check.
- A run whose state is `completed` is returned unchanged.
- Completed units are skipped. An incomplete unit is rerun whole; its earlier evaluator logs are first moved to `raw/<variant>/<evaluator>/<key>/r<n>.interrupted-<k>/` and kept.
- A variant in state `infeasible` is not retried.
- A variant `awaiting_manual_swap`: prepare it; require that its engine fingerprint (interpreter path, working directory, entrypoint, environment, Tabby commit, ExLlamaV3 version) differs from the reference variant's recorded one. If it is identical, raise `RunError("The backend is unchanged since the reference variant ran; change it, then resume.")`. Otherwise mark it `ready` and continue.
- Before continuing a variant that already has completed units, prepare it again and require the same residency hash those units recorded; a different hash is a `RunError`, since the remaining samples would run on a different model than the earlier ones.
- `errors.jsonl` rows from the earlier attempt are kept; rows for units that then complete are not removed.

Resume works on `(variant, task, repeat)` units, not single samples, as the spec states.

**Failing test:** `tests/test_resume.py`, one test per scenario, same setup as Task 9:

1. **Interrupted mid-run.** `interrupt_on_call=3` raises `KeyboardInterrupt` out of `run_manifest`; state on disk is still `running`, two units exist. `resume_run` makes exactly two more evaluator calls (units 3 and 4), state `completed`, `samples.jsonl` has 16 rows and no `(variant_id, task, sample_id, repeat)` key twice.
2. **Changed generation profile.** Resolving `current` with another profile: `RunError` naming `generation`; no evaluator call.
3. **Re-frozen samples.** A manifest file rewritten with another seed: `RunError` naming `sample_manifests`.
4. **Completed run.** No evaluator call, same store.
5. **Manual swap, backend unchanged.** `RunError` with `unchanged`; **backend changed** (the fake's engine `environment` differs): the variant runs and the run completes.
6. **Different residency on resume.** The fake's resident hash for `cand` differs from the recorded one: `RunError`.
7. **Interrupted logs are kept.** After scenario 1, the directory `r1.interrupted-1` exists for the rerun unit when the first attempt had written anything there.

Run: `pytest tests/test_resume.py -v`.

**Acceptance:** scenario 1's duplicate check passes; nothing under `units/` is ever rewritten for a completed unit (compare file modification times before and after resume).

---

### Task 11: Mock-tool task

**Goal:** A custom tool-calling task with deterministic tools, usable under native and emulated tool calling.

**Files:**
- Create: `local-evals/fixtures/tools/v1.jsonl`
- Create: `local-evals/src/local_evals/tasks/tools.py`
- Modify: `local-evals/src/local_evals/tasks/inspect_bindings.py`
- Modify: `local-evals/configs/tasks.yaml`
- Test: `local-evals/tests/test_tools_task.py`, `tests/test_inspect_evaluator.py`

**Decisions:**

Mock tools are plain functions in `tasks/tools.py` with fixed tables; they touch nothing outside the process:

| Tool | Behaviour |
|---|---|
| `get_weather(city: str) -> str` | `Oslo` → `4C, snow`; `Lisbon` → `19C, clear`; `Nairobi` → `24C, cloudy`; other cities raise `ToolFailure("unknown city")`. |
| `lookup_order(order_id: str) -> str` | `A-1001` → `customer C-17, status shipped`; `A-1002` → `customer C-42, status pending`; others raise `ToolFailure("order not found")`. |
| `get_customer(customer_id: str) -> str` | `C-17` → `Ada Okafor, tier gold`; `C-42` → `Liang Wei, tier silver`; others raise `ToolFailure("customer not found")`. |
| `convert_currency(amount: float, source: str, target: str) -> str` | Fixed rates `EUR→USD 1.10`, `USD→EUR 0.90`, `GBP→USD 1.25`; result rounded to 2 decimals; other pairs raise `ToolFailure("unsupported currency pair")`. |
| `check_inventory(sku: str) -> str` | `SKU-7` → `12 in stock`; `SKU-9` raises `ToolFailure("inventory service unavailable")`; others → `0 in stock`. |

```python
class ToolFailure(Exception): ...

class ExpectedCall(Strict):
    name: str
    arguments: dict[str, JsonValue]

class ToolCase(Strict):
    id: str
    category: Literal["single", "parallel", "dependent", "tool_error", "no_tool"]
    prompt: str
    tools: list[str]                       # tools offered to the model
    expected_calls: list[ExpectedCall]
    # Whether expected_calls must occur in this order (dependent chains) or in any order.
    ordered: bool
    # Every string must appear in the final answer, case-insensitively.
    answer_contains: list[str]

@dataclass(frozen=True)
class ObservedCall:
    name: str
    arguments: Mapping[str, JsonValue]
    error: str | None

@dataclass(frozen=True)
class ToolScore:
    correct: float           # 1.0 only when calls and answer are both right
    calls_correct: float
    answer_correct: float
    status: SampleStatus     # "correct" or "incorrect"
    explanation: str

def load_tool_cases(path: Path) -> list[ToolCase]: ...
def score_tool_case(calls: Sequence[ObservedCall], answer: str, case: ToolCase) -> ToolScore: ...
```

Scoring rules:
- Argument comparison: numbers compare by value (`100` equals `100.0`); strings compare after trimming and case-folding.
- `calls_correct` is 1.0 when the observed calls, ignoring exact repeats of an already-made call, are exactly the expected calls: same multiset when `ordered` is false, same sequence when true. A call that is not expected makes it 0.0.
- `no_tool` cases expect no calls: any call makes `calls_correct` 0.0.
- `tool_error` cases expect the failing call to be made once and the answer to say the information is unavailable; the fixture's `answer_contains` carries the phrase to look for. A fabricated value cannot satisfy it because the fixture also lists no number to find; additionally, for `tool_error` cases an answer containing a digit sequence followed by `in stock` scores `answer_correct` 0.0.
- `answer_correct` is 1.0 when every `answer_contains` string is present.

`fixtures/tools/v1.jsonl` (twelve cases, one JSON object per line):

```json
{"id":"tool-001","category":"single","prompt":"What is the weather in Oslo right now?","tools":["get_weather","lookup_order"],"expected_calls":[{"name":"get_weather","arguments":{"city":"Oslo"}}],"ordered":false,"answer_contains":["4","snow"]}
{"id":"tool-002","category":"single","prompt":"What is the status of order A-1002?","tools":["get_weather","lookup_order","get_customer"],"expected_calls":[{"name":"lookup_order","arguments":{"order_id":"A-1002"}}],"ordered":false,"answer_contains":["pending"]}
{"id":"tool-003","category":"single","prompt":"Convert 200 EUR to USD.","tools":["convert_currency","get_weather"],"expected_calls":[{"name":"convert_currency","arguments":{"amount":200,"source":"EUR","target":"USD"}}],"ordered":false,"answer_contains":["220"]}
{"id":"tool-004","category":"parallel","prompt":"Compare the current weather in Oslo and Lisbon.","tools":["get_weather"],"expected_calls":[{"name":"get_weather","arguments":{"city":"Oslo"}},{"name":"get_weather","arguments":{"city":"Lisbon"}}],"ordered":false,"answer_contains":["snow","clear"]}
{"id":"tool-005","category":"parallel","prompt":"How many units of SKU-7 are in stock, and what is the weather in Nairobi?","tools":["check_inventory","get_weather","lookup_order"],"expected_calls":[{"name":"check_inventory","arguments":{"sku":"SKU-7"}},{"name":"get_weather","arguments":{"city":"Nairobi"}}],"ordered":false,"answer_contains":["12","cloudy"]}
{"id":"tool-006","category":"parallel","prompt":"Convert 100 GBP to USD and 100 USD to EUR.","tools":["convert_currency"],"expected_calls":[{"name":"convert_currency","arguments":{"amount":100,"source":"GBP","target":"USD"}},{"name":"convert_currency","arguments":{"amount":100,"source":"USD","target":"EUR"}}],"ordered":false,"answer_contains":["125","90"]}
{"id":"tool-007","category":"dependent","prompt":"Who is the customer for order A-1001, and what tier are they?","tools":["lookup_order","get_customer","get_weather"],"expected_calls":[{"name":"lookup_order","arguments":{"order_id":"A-1001"}},{"name":"get_customer","arguments":{"customer_id":"C-17"}}],"ordered":true,"answer_contains":["Ada Okafor","gold"]}
{"id":"tool-008","category":"dependent","prompt":"What tier is the customer who placed order A-1002?","tools":["lookup_order","get_customer"],"expected_calls":[{"name":"lookup_order","arguments":{"order_id":"A-1002"}},{"name":"get_customer","arguments":{"customer_id":"C-42"}}],"ordered":true,"answer_contains":["silver"]}
{"id":"tool-009","category":"tool_error","prompt":"How many units of SKU-9 are in stock?","tools":["check_inventory","lookup_order"],"expected_calls":[{"name":"check_inventory","arguments":{"sku":"SKU-9"}}],"ordered":false,"answer_contains":["unavailable"]}
{"id":"tool-010","category":"tool_error","prompt":"What is the status of order Z-9999? If it cannot be found, say that it was not found.","tools":["lookup_order","get_customer"],"expected_calls":[{"name":"lookup_order","arguments":{"order_id":"Z-9999"}}],"ordered":false,"answer_contains":["not found"]}
{"id":"tool-011","category":"no_tool","prompt":"What is 17 multiplied by 3? Answer with the number.","tools":["get_weather","convert_currency"],"expected_calls":[],"ordered":false,"answer_contains":["51"]}
{"id":"tool-012","category":"no_tool","prompt":"In one sentence, what does the abbreviation SKU stand for?","tools":["check_inventory","lookup_order"],"expected_calls":[],"ordered":false,"answer_contains":["stock keeping unit"]}
```

Inspect binding, `local_evals/mock_tools` in `LOCAL_TASKS`:
- one `Sample` per case, `id=case.id`, `metadata={"case": ..., "category": case.category}`;
- solver: the case's tools made available per sample, then generation with the tool loop; the task sets a message limit of 12 so a looping model ends as a limit, not a hang;
- each Inspect tool is a thin wrapper over the plain function; `ToolFailure` surfaces as a tool error the model sees;
- scorer `mock_tools_scorer` collects `ObservedCall`s from the assistant messages and tool results in the transcript, calls `score_tool_case`, and returns a dict-valued score `{"correct": ..., "calls_correct": ..., "answer_correct": ...}` with `metadata={"status": ...}`.

Catalogue entry: `id: local_evals/mock_tools`, `factory: null`, `tools: true`, `primary_metric: mock_tools_scorer.correct`, `report_metrics: [mock_tools_scorer.calls_correct, mock_tools_scorer.answer_correct]`, `stratify_by: category`, `dataset: null`, `gated: false`, `sandbox: false`, `judge: false`.

**Failing test:** `tests/test_tools_task.py`:

- Fixture loads twelve cases with unique ids; every `expected_calls` entry, when executed against the plain functions, either returns or raises `ToolFailure` exactly for the two `tool_error` cases; every tool named in a case exists.
- `score_tool_case` table, one assertion each: exact single call + right answer → `correct 1.0`; right call, answer missing a required string → `calls_correct 1.0, answer_correct 0.0, correct 0.0`; parallel calls in reverse order → 1.0; dependent calls in reverse order → `calls_correct 0.0`; an extra unexpected call → `calls_correct 0.0`; the same expected call made twice → still 1.0; numeric argument `200.0` matches `200`; city `" oslo "` matches `Oslo`; `no_tool` case with any call → `calls_correct 0.0`; `tool-009` with answer `SKU-9 is currently unavailable` → 1.0, with answer `There are 5 in stock, service unavailable` → `answer_correct 0.0`.

In `tests/test_inspect_evaluator.py`, the dict-valued score test deferred from Task 5: run `local_evals/mock_tools` for `tool-011` with the mock model answering `51` and `primary_metric="mock_tools_scorer.correct"`; the sample is `correct` with `metrics == {"mock_tools_scorer.correct": 1.0, "mock_tools_scorer.calls_correct": 1.0, "mock_tools_scorer.answer_correct": 1.0}`. Then run `tool-001` with a mock output that carries a tool call to `get_weather(city="Oslo")` followed by the answer `4C and snow`; the sample is `correct` and `tool_calls == 1`. Build the tool-call output with the mock model's own helper for tool calls (confirm its name with `python -c "from inspect_ai.model import ModelOutput; print([n for n in dir(ModelOutput) if not n.startswith('_')])"`).

Run: `pytest tests/test_tools_task.py tests/test_inspect_evaluator.py -v`.

**Acceptance:** all scorer rows pass; `list_samples("local_evals/mock_tools", {}, None, "category")` returns twelve samples in five strata; `tasks/tools.py` does not import `inspect_ai`.

---

### Task 12: Standard tasks, frozen manifests, `quick` and `standard` suites

**Goal:** Catalogue the standard tasks against the pinned evaluator release and freeze their sample sets. This task downloads datasets; it needs network access and, for gated datasets, the user's Hugging Face token.

**Files:**
- Modify: `local-evals/configs/tasks.yaml`
- Create: `local-evals/configs/suites/quick.yaml`, `configs/suites/standard.yaml`
- Create: `local-evals/manifests/quick/*.json`, `manifests/standard/*.json`
- Modify: `local-evals/src/local_evals/cli.py` (`freeze`, wired fully in Task 16; this task may call `samples.freeze` from a Python one-liner if Task 16 is not done)
- Test: `local-evals/tests/test_shipped_configs.py`

**Decisions:**

Candidate tasks: `inspect_evals/gpqa_diamond`, `inspect_evals/mmlu_pro`, `inspect_evals/bbh`, `inspect_evals/math`, `inspect_evals/ifeval`, `inspect_evals/bfcl`, plus `local_evals/mock_tools` and `local_evals/structured_output`.

- [ ] **Step 1: Verify each upstream task against the installed release.** For each task read its README and source in the installed package (`python -c "import inspect_evals.<module>, pathlib; print(pathlib.Path(inspect_evals.<module>.__file__).parent)"`), and record in `configs/tasks.yaml`:
  - `factory` (confirmed by importing it), `dataset`, `license`, `gated`;
  - `extras`: the optional dependency group the task needs, if any; install it with `python -m pip install "inspect-evals[<extra>]==0.30.0"` and refresh `requirements.lock`;
  - `sandbox`, `judge`, `tools`;
  - the scorer names and the shape of their scores, by running three samples under the mock model and printing `metrics` from `read_samples`; set `primary_metric` and `report_metrics` from what is actually there;
  - `stratify_by`: a metadata key that exists on every sample (subject, category, level), else `null`;
  - `task_args` needed for a fixed, non-shuffled, zero-shot-or-documented configuration; these go in the suite entry.

  Rules for what was found:
  - A task whose only scorer calls a grader model is marked `judge: true` and left out of both suites; it belongs to plan 4.
  - `math`: if it reports an exact or symbolic match metric beside a model-graded one, set `primary_metric` to the exact or symbolic one and `judge: false` only if the model-graded scorer can be switched off by a task argument. Otherwise `judge: true` and out of the suites.
  - `ifeval`: `primary_metric` is the prompt-level strict component and `report_metrics` holds the prompt-level loose one, so strict and loose are reported separately.
  - `bbh`: if one invocation covers one subset, add one suite entry per chosen subset with `name: bbh-<subset>` and `task_args` naming it. Choose `date_understanding`, `logical_deduction_three_objects`, `tracking_shuffled_objects_three_objects`, `word_sorting`, or the release's nearest equivalents.
  - `bfcl`: record which categories the release implements; the suite entry selects only categories that need no web access and no code execution.
  - A gated dataset without a token: leave the task out of the suites and record `blocked: gated dataset` in the README table. `HF_TOKEN` is not a cloud inference key and is not scrubbed.

- [ ] **Step 2: Freeze.** Seed `20261126` for every manifest.

| Suite | Per task | Notes |
|---|---|---|
| `quick` | 40 samples (10 per `bbh` subset; all 12 mock-tool and all 6 structured cases) | A regression screen. |
| `standard` | 200 samples, or the whole dataset when smaller (50 per `bbh` subset; all custom cases) | The comparison suite. |

  `max_tokens` per entry: 16384 for reasoning tasks (`gpqa_diamond`, `mmlu_pro`, `bbh`, `math`), 8192 for `ifeval`, 4096 for `bfcl`, `mock_tools` and `structured_output`. These bound thinking plus answer under `fixed-v1`.

- [ ] **Step 3: Write the suite files** with one entry per task or subset, each naming its `sample_manifest` and `task_args`.

**Failing test:** `tests/test_shipped_configs.py`:

- every suite file under `configs/suites/` loads; every task it names is catalogued; every `sample_manifest` it names exists, loads, matches the entry's task and arguments, and has unique ids;
- `quick` and `standard` share no manifest file but every `quick` manifest's ids are a subset of the corresponding `standard` manifest's ids (same seed, larger count);
- no manifest file contains a key other than those of `SampleManifest`;
- no suite contains a task whose catalogue entry has `judge: true` or `sandbox: true`.

Run: `pytest tests/test_shipped_configs.py -v`.

**Acceptance:** every candidate task is either in both suites with a frozen manifest, or listed in the README with the reason it is not (`judge`, `gated`, `not runnable in this release`). Nothing is silently dropped.

---

### Task 13: `plan`

**Goal:** Show what an experiment will do, what each variant changes, and roughly how long it takes, before anything is loaded.

**Files:**
- Create: `local-evals/src/local_evals/planning.py`
- Create: `local-evals/configs/estimates.yaml`
- Test: `local-evals/tests/test_planning.py`

**Decisions:**

`configs/estimates.yaml` — stated assumptions, each a low and a high bound:

```yaml
# Used only to print a time range. Replace with measurements via `plan --calibrate-from <run-id>`.
prompt_tokens_per_sample: [300, 3000]
prefill_tokens_per_second: [800, 4000]
decode_tokens_per_second: [15, 90]
# Share of max_tokens a sample actually generates.
output_fraction: [0.15, 1.0]
model_swap_seconds: [45, 600]
```

```python
# Preset fields the bench route never applies; a difference in them is not a variant difference.
REQUEST_LEVEL_FIELDS = frozenset({
    "id", "label", "Temperature", "TopP", "TopK", "MinP", "PresencePenalty", "RepetitionPenalty", "Reasoning",
    "ReasoningEffort", "ReasoningContent", "PreserveThinking", "MaintainPerStepThinking", "ReasoningBudget",
    "ReasoningBudgetMessage", "StartupTimeoutMs", "HealthcheckTimeoutMs", "HealthcheckIntervalMs",
    "SleepIdleSeconds", "IdleAction", "CompactionReserveTokens",
})

class Estimates(Strict): ...                       # the five pairs above, each validated low <= high

@dataclass(frozen=True)
class FieldDiff:
    field: str
    reference: JsonValue
    variant: JsonValue

@dataclass(frozen=True)
class VariantPlan:
    variant: Variant
    diffs: Sequence[FieldDiff]                      # against the reference; empty for the reference itself
    resolved: bool                                  # True when diffs come from the server's resolved settings
    warnings: Sequence[str]

@dataclass(frozen=True)
class TaskPlan:
    key: str; task: str; samples: int | None; max_tokens: int; sandbox: bool; judge: bool; tools: bool
    dataset: str | None; gated: bool

@dataclass(frozen=True)
class ExperimentPlan:
    manifest_digest: str; protocol_digest: str
    variants: Sequence[VariantPlan]; tasks: Sequence[TaskPlan]
    model_swaps: int; requests: int | None
    seconds_low: float | None; seconds_high: float | None
    time_basis: str                                  # "assumed (configs/estimates.yaml)" or "measured from <run-id>"
    datasets: Sequence[str]; warnings: Sequence[str]

def diff_settings(reference: Mapping[str, JsonValue], variant: Mapping[str, JsonValue]) -> list[FieldDiff]: ...
def build_plan(manifest: ResolvedManifest, catalog: TaskCatalog, sample_manifests: Mapping[str, SampleManifest],
               estimates: Estimates, *, resolved_settings: Mapping[str, Mapping[str, JsonValue]] | None,
               calibration: Sequence[SampleRecord] | None, calibration_run: str | None) -> ExperimentPlan: ...
```

- Offline (`resolved_settings=None`): diffs are computed from what the experiment file declares — `preset`, each override key, `tool_mode`, `swap` — and `resolved` is false. A differing `preset` produces the single diff `preset`, with a warning that the full difference is only known with `--resolve`.
- With `--resolve` the CLI calls `identity` for each variant (identity never loads a model) and passes `requested.settings`; diffs are over all settings keys except `REQUEST_LEVEL_FIELDS`, plus `tool_mode`.
- Warnings:
  - a non-reference variant with no diff: `variant <id> is identical to the reference`;
  - more than one diff: `variant <id> differs from the reference in <n> fields: <names>`;
  - `changed_field` set and the diff set is not exactly that field: `declared changed_field <f>, actual differences: <names>`;
  - a `swap: manual` variant: `variant <id> needs a manual backend change; the run pauses before it`;
  - any task with `tools: true` and a variant in emulated mode: `variant <id> uses emulated tool calling; compare it only with another emulated variant`;
  - a variant whose identity request failed with 400 under `--resolve`: `variant <id> cannot be loaded: <message>`.
- `model_swaps` is the number of variants (each is loaded once) and `requests` is `variants × repeats × Σ samples`, `None` when any task has no frozen manifest and no limit.
- Time range, assumed: per sample `low = prompt_low / prefill_high + max_tokens × fraction_low / decode_high`, `high = prompt_high / prefill_low + max_tokens × fraction_high / decode_low`; total adds `model_swaps × swap_seconds`. Measured: for a task that has records in the calibration run, low and high are that task's 10th and 90th percentile `total_seconds` per sample; tasks without records fall back to the assumption and the basis string says `mixed`.
- A plan is printable as text and as JSON. It is also written to `runs/<id>/plan.json` when a run starts.

**Failing test:** `tests/test_planning.py`:

1. `diff_settings` ignores every `REQUEST_LEVEL_FIELDS` key and reports `KvCacheQuantization` and `NumCtx` when those differ, sorted by field name.
2. Offline plan for reference `{NumCtx: 32768}` and candidate `{NumCtx: 32768, KvCacheQuantization: "f16"}`: the candidate's diffs are exactly `[KvCacheQuantization]`, no warning, `resolved` false.
3. `changed_field: KvCacheQuantization` with a candidate that also changes `NcpuMoe`: both warnings above are present and name `NcpuMoe`.
4. An identical variant, a manual variant and an emulated variant on a suite with a tools task each produce their warning.
5. With `Estimates` of `prompt [1000, 1000]`, `prefill [1000, 1000]`, `decode [10, 10]`, `output_fraction [0.5, 1.0]`, `swap [60, 60]`, one task of 4 samples at `max_tokens 100`, two variants, one repeat: `requests == 8`, `seconds_low == 8 × (1 + 5) + 120 == 168`, `seconds_high == 8 × (1 + 10) + 120 == 208`, basis `assumed (configs/estimates.yaml)`.
6. With calibration records for that task whose `total_seconds` are all 2.0: low and high are both `8 × 2 + 120 == 136` and the basis names the run.
7. `Estimates` with a low above its high is a `ConfigError`.

Run: `pytest tests/test_planning.py -v`.

**Acceptance:** `build_plan` performs no IO; the arithmetic cases match exactly.

---

### Task 14: Statistics

**Goal:** The three statistical functions the comparison needs, exact where exactness is cheap, seeded where resampling is used.

**Files:**
- Create: `local-evals/src/local_evals/stats.py`
- Test: `local-evals/tests/test_stats.py`

**Decisions:**

```python
@dataclass(frozen=True)
class Interval:
    low: float
    high: float

def mcnemar_exact(wins: int, losses: int) -> float:
    """Two-sided exact binomial p-value on the discordant pairs. 1.0 when there are none."""

def wilson_interval(successes: int, total: int) -> Interval | None:
    """95% Wilson score interval for a proportion; None when total is 0."""

def paired_bootstrap(cluster_deltas: Sequence[float], *, seed: int, resamples: int = 10_000) -> Interval | None:
    """95% percentile interval of the mean paired difference, resampling whole clusters. None for no clusters."""
```

- `mcnemar_exact`: `p = min(1, 2 × Σ_{k=0}^{min(w,l)} C(w+l, k) × 0.5^(w+l))`, computed with integers (`math.comb`) and one final division.
- `wilson_interval`: `z = 1.959963984540054`.
- `paired_bootstrap`: `random.Random(seed)`; each resample draws `len(cluster_deltas)` clusters with replacement and takes their mean; the interval is the 2.5th and 97.5th percentile by nearest-rank on the sorted means (`index = ceil(q × resamples) - 1`, clamped). A cluster is one sample id; its delta is the mean over repeats of candidate score minus reference score. Resampling clusters, not individual repeats, is what keeps repeats of one item from being counted as independent evidence.

**Failing test:** `tests/test_stats.py`:

```python
import pytest

from local_evals.stats import Interval, mcnemar_exact, paired_bootstrap, wilson_interval


@pytest.mark.parametrize(("wins", "losses", "expected"), [
    (0, 0, 1.0), (5, 5, 1.0), (1, 5, 0.21875), (5, 1, 0.21875), (0, 6, 0.03125), (2, 10, 0.03857421875),
])
def test_mcnemar_exact_matches_hand_computed_values(wins: int, losses: int, expected: float) -> None:
    assert mcnemar_exact(wins, losses) == expected


def test_wilson_interval() -> None:
    assert wilson_interval(0, 0) is None
    half = wilson_interval(50, 100)
    assert half is not None and half.low == pytest.approx(0.4038, abs=1e-4) and half.high == pytest.approx(0.5962, abs=1e-4)
    none = wilson_interval(0, 10)
    assert none is not None and none.low == 0.0 and none.high == pytest.approx(0.2775, abs=1e-4)
    every = wilson_interval(10, 10)
    assert every is not None and every.high == pytest.approx(1.0) and every.low == pytest.approx(0.7225, abs=1e-4)


def test_paired_bootstrap_is_seeded_and_degenerate_cases_are_exact() -> None:
    assert paired_bootstrap([], seed=1) is None
    assert paired_bootstrap([0.25] * 30, seed=1) == Interval(0.25, 0.25)
    mixed = [1.0, -1.0] * 50
    first = paired_bootstrap(mixed, seed=11, resamples=2000)
    assert first == paired_bootstrap(mixed, seed=11, resamples=2000)
    assert first is not None and first.low < 0.0 < first.high and first.low == pytest.approx(-first.high, abs=0.15)
    shifted = paired_bootstrap([0.5 + delta for delta in mixed], seed=11, resamples=2000)
    assert shifted is not None and shifted.low == pytest.approx(first.low + 0.5) and shifted.high == pytest.approx(first.high + 0.5)
```

Run: `pytest tests/test_stats.py -v` — expected before implementing: `ModuleNotFoundError: local_evals.stats`.

**Acceptance:** all values match; `stats.py` imports only the standard library.

---

### Task 15: Compare

**Goal:** Pair two variants on identical samples, refuse when they are not comparable, and report differences with coverage and uncertainty.

**Files:**
- Create: `local-evals/src/local_evals/compare.py`
- Test: `local-evals/tests/test_compare.py`

**Decisions:**

```python
class CompareError(Exception):
    """The two sides cannot be compared; the message lists every reason found."""

@dataclass(frozen=True)
class VariantData:
    run_id: str
    variant: Variant
    manifest: ResolvedManifest
    records: Sequence[SampleRecord]
    identity: Mapping[str, JsonValue] | None
    state: str                                  # completed | infeasible | ...
    planned: Mapping[str, Sequence[str]]        # task key -> frozen sample ids, from samples.manifest.json

@dataclass(frozen=True)
class SideSummary:
    planned: int; completed: int; correct_mean: float | None    # mean score over completed pairs
    accuracy_planned: float | None; interval: Interval | None   # Wilson, binary scores only
    counts: Mapping[SampleStatus, int]

@dataclass(frozen=True)
class TaskComparison:
    task: str; metric: str; binary: bool
    reference: SideSummary; candidate: SideSummary
    matched_samples: int
    delta: float | None                         # candidate minus reference on matched samples, in score units
    delta_interval: Interval | None
    wins: int; losses: int; ties: int
    p_value: float | None                       # exact McNemar / sign test on clusters; binary scores only
    infeasible: str | None                      # reason; when set, delta and tests are None

def load_variant(runs_root: Path, reference: str) -> VariantData: ...     # "<run-id>" or "<run-id>:<variant-id>"
def check_compatible(reference: VariantData, candidate: VariantData) -> None: ...
def compare_variants(reference: VariantData, candidate: VariantData, *, metric: str | None, seed: int = 20261126) -> list[TaskComparison]: ...
def render_comparison(reference: VariantData, candidate: VariantData, rows: Sequence[TaskComparison]) -> str: ...
```

- `load_variant`: a bare run id is accepted only when the run has one variant; otherwise the error lists the run's variant ids.
- `check_compatible` raises one `CompareError` listing all of:
  - different `protocol_digest()`, naming which of generation, suite, repeats or sample manifests differs;
  - a task present on both sides whose records differ in `evaluator`, `task_version` or `scorer`;
  - a sample id present on both sides with different `content_hash`;
  - the same run and the same variant on both sides.
  It does not require the two sides to be in the same run.
- Metric: `metric=None` uses each record's `score` (the task's primary metric); a named metric reads `record.metrics[metric]` and applies to tasks that have it, skipping the rest.
- Pairing unit is `(sample_id, repeat)`; a pair is *matched* when both sides have a model outcome for it. A sample is a *matched sample* when at least one of its repeats is matched; its cluster delta is the mean over its matched repeats.
- `delta` is the mean cluster delta. `wins`, `losses`, `ties` count matched samples whose cluster delta is above, below or equal to zero.
- `binary` is true when every score on both sides is 0.0 or 1.0. Then `p_value = mcnemar_exact(wins, losses)` and each side gets a Wilson interval on its completed pairs. With repeats above 1 the test is the exact sign test on samples; the rendered table says so.
- `delta_interval` is `paired_bootstrap` over matched samples' cluster deltas.
- `accuracy_planned` counts every planned pair that is not `correct` as a miss; planned is `len(planned[task]) × repeats`. A task without a frozen manifest (a plain suite run with a `limit`) has `planned` equal to the ids its records hold.
- `infeasible`: the candidate variant's state is `infeasible` (reason from its state file), or every planned pair of the task on a side is `input_too_long` (`"no sample fit the context"`). Such a row has no delta, no interval and no p-value.
- Rendering: one table per comparison with columns Task, Metric, n planned, n matched, Reference, Candidate, Δ (percentage points for binary metrics, score units otherwise), 95% CI, W/L/T, p. Under it, per side, the status counts that are not model outcomes. The header names each side by variant id and prints its identity lines (plan 1's `identity_lines`); a side whose KV mode or drafting is unverified is described as `configured`, and the header never states a quantization the server did not verify. A final line states: `Intervals are paired bootstrap over samples (seed <seed>); they do not cover prompt sensitivity or dataset choice.` When more than one task row is printed: `p-values are not adjusted for multiple comparisons.`

**Failing test:** `tests/test_compare.py`, built from `SampleRecord`s constructed in the test (no runner needed) and written into two `RunStore`s:

1. **Worked example.** Task `t`, six planned samples `s1..s6`, one repeat. Reference correct on `s1..s4`, incorrect on `s5`, `infra_error` on `s6`. Candidate correct on `s1, s2, s5`, incorrect on `s3, s4, s6`. Expect: `matched_samples == 5`; `wins == 1`, `losses == 2`, `ties == 2`; `delta == pytest.approx(-0.2)`; `p_value == 1.0`; reference `completed == 5`, `correct_mean == 0.8`, `accuracy_planned == pytest.approx(4 / 6)`; candidate `completed == 6`, `correct_mean == 0.5`, `accuracy_planned == 0.5`; `reference.counts["infra_error"] == 1`; `binary` true; `delta_interval` is not `None` and contains `-0.2`.
2. **Repeats cluster.** Two repeats, three samples; a sample that the candidate wins in both repeats counts as one win, not two; a sample with one win and one loss is a tie with cluster delta 0.
3. **Continuous metric.** Scores 0.25/0.75 etc.: `binary` false, `p_value` is `None`, intervals on sides are `None`, `delta_interval` present.
4. **Named metric.** `metric="x.loose"` uses `metrics["x.loose"]`; a task without it is absent from the result.
5. **Infeasible candidate.** Variant state `infeasible`: one row per reference task with `infeasible` set and `delta is None`. All-`input_too_long` task: the same with the context reason.
6. **Rejections**, each asserting the message names the cause: different generation profile; different sample manifest digest; different evaluator for the same task; different scorer; differing `content_hash` for one sample id; comparing a variant with itself; a bare run id for a two-variant run (message lists both ids).
7. **Rendering.** The worked example renders a row containing `-20.0`, `1/2/2`, and the status line `infra_error 1` for the reference; a side with `cache_mode` null renders `KV cache: unverified (configured q8_0)`.

Run: `pytest tests/test_compare.py -v`.

**Acceptance:** the worked example's numbers match exactly; every rejection is raised before any statistic is computed.

---

### Task 16: Multi-variant report and CLI

**Goal:** Wire the new capabilities into commands: `freeze`, `plan`, `run --experiment`, `resume`, `compare`; make `report` handle several variants.

**Files:**
- Modify: `local-evals/src/local_evals/report.py`
- Modify: `local-evals/src/local_evals/cli.py`
- Modify: `local-evals/tests/test_report.py`, `tests/test_cli.py`

**Decisions:**

```
local-evals freeze   --suite <name> [--task <key>] [--count N] [--seed N] [--allow-dataset-download]
local-evals plan     --experiment <file> [--resolve] [--calibrate-from <run-id>]
local-evals run      (--suite <name> --model <preset> | --experiment <file>) [--generation <name>] [--dry-run] [--mock] [--allow-dataset-download]
local-evals resume   --run-id <id>
local-evals compare  --reference <run[:variant]> --candidate <run[:variant]> [--metric <name>]
local-evals compare  --run-id <id>                 # the run's reference against each other variant
local-evals report   --run-id <id> --format markdown|csv
```

- Global `--manifests-dir` (default `manifests`) joins `--config-dir` and `--runs-dir`.
- `freeze` writes the manifest file for each suite entry that names one (or the one `--task`); it refuses to overwrite an existing manifest unless `--force`, because re-freezing invalidates earlier runs for comparison. Without `--allow-dataset-download` the offline variables are set as in plan 1.
- `plan` never loads a model. Without `--resolve` it contacts nothing. `run --dry-run` prints the same plan.
- `run --experiment` builds the plan with resolved settings first, prints its warnings to stderr, writes `plan.json`, then runs. Warnings do not stop a run; a variant that cannot be loaded is reported infeasible by the runner.
- `resume` re-resolves the manifest from the run's recorded kind: the experiment file path or the suite/model/generation names are stored in `state.json` under `source` when the run starts.
- `report`: `summary.json` holds one summary list per variant; `report.md` has one section per variant (plan 1's table and identity lines), then, for a run with more than one variant, the comparison of each variant against the reference (Task 15's rendering) or its incompatibility/infeasibility reason; `report.csv` gains a leading `variant` column.
- Reports show variant ids, preset ids and settings; absolute paths inside identity (`ModelPath`, interpreter, working directory) are reduced to their last path segment in `report.md` and `compare` output. The full values stay in `variants/<id>/environment.json`.
- Exit codes as plan 1: 0, 1 (doctor), 2 (configuration, endpoint, run, compare errors).
- `report.write_run_report(store)` owns report writing; the CLI calls it after `run` and `resume`.

**Failing test:** in `tests/test_cli.py` (mock target, structured and mock-tool tasks, experiment files written into `tmp_path`):

1. `freeze --suite <tmp suite>` writes the manifest; a second call exits 2 with `already frozen`; `--force` rewrites it.
2. `plan --experiment <file> --json` prints variants, diffs and a time range, writes nothing under the runs directory, and makes no HTTP request (endpoint is the dead port from plan 1's test; the command still exits 0).
3. `run --experiment <file> --mock --json` then `report --run-id` : the report has a section per variant, a comparison table, and `MOCKED RUN` once at the top.
4. `compare --run-id <id> --json` prints one comparison per non-reference variant; `compare --reference <id>:a --candidate <id>:a` exits 2.
5. `resume --run-id <completed id>` exits 0 and reports nothing to do; `resume` after editing the experiment file's `repeats` exits 2 naming `repeats`.
6. `run --suite structured --model exl3-3-8-27b-5bpw --mock` still works and its report has one variant section and no comparison.

In `tests/test_report.py`: two variants render two sections; the CSV has the `variant` column; a path `C:\models\served-model` in identity renders as `served-model`.

Run: `pytest tests/test_cli.py tests/test_report.py -v`.

**Acceptance:** the end-to-end mock path of the spec holds: two mocked variants compare, an interrupted run resumes without duplicates (Task 10), incompatible runs are rejected (Task 15).

---

### Task 17: Experiment files, README, validation, first real comparison

**Files:**
- Create: `local-evals/configs/experiments/kv_quant.yaml`, `drafting.yaml`, `model_choice.yaml`, `weight_quant.example.yaml`
- Modify: `local-evals/.gitignore` (add `configs/experiments/local/`)
- Modify: `local-evals/README.md`

**Decisions:**

`configs/experiments/kv_quant.yaml`:

```yaml
# KV-cache precision on the dense 27B. Both variants use a 32k context so that f16 fits in VRAM.
name: kv-quant-27b
endpoint: siftkit-local
generation: fixed-v1
suite: quick
reference: kv-q8
changed_field: KvCacheQuantization
repeats: 1
variants:
  - id: kv-q8
    preset: exl3-3-8-27b-5bpw
    overrides: { NumCtx: 32768 }
  - id: kv-f16
    preset: exl3-3-8-27b-5bpw
    overrides: { NumCtx: 32768, KvCacheQuantization: f16 }
```

`configs/experiments/drafting.yaml`:

```yaml
# MTP drafting on and off. Quality should not move; speed is measured by plan 3's perf probe.
name: drafting-27b
endpoint: siftkit-local
generation: fixed-v1
suite: quick
reference: draft-on
changed_field: SpeculativeEnabled
repeats: 1
variants:
  - id: draft-on
    preset: exl3-3-8-27b-5bpw
    overrides: { NumCtx: 32768 }
  - id: draft-off
    preset: exl3-3-8-27b-5bpw
    overrides: { NumCtx: 32768, SpeculativeEnabled: false }
```

`configs/experiments/model_choice.yaml`:

```yaml
# A deployment comparison between two saved presets. Not a quantization result: the models differ.
name: model-choice
endpoint: siftkit-local
generation: fixed-v1
suite: quick
reference: dense-27b
changed_field: null
repeats: 1
variants:
  - id: dense-27b
    preset: exl3-3-8-27b-5bpw
  - id: flash-next
    preset: exl3-3-8-next-4-18bpw-f16
```

`configs/experiments/weight_quant.example.yaml` — an example, because it needs a machine-specific model path. Copy it to `configs/experiments/local/weight_quant.yaml` (gitignored) and fill in the two marked values:

```yaml
# Weight quantization of Flash-Next: 4.18 bpw against 3.50 bpw. There is no saved preset for the
# 3.50 bpw directory, so the variant overrides ModelPath on the 4.18 bpw preset.
# NcpuMoe must differ for the smaller quant to use the VRAM it frees; `plan` will warn that two
# fields differ. That is expected and is reported as an operational difference.
name: weight-quant-flash-next
endpoint: siftkit-local
generation: fixed-v1
suite: quick
reference: bpw-4-18
changed_field: ModelPath
repeats: 1
variants:
  - id: bpw-4-18
    preset: exl3-3-8-next-4-18bpw-f16
  - id: bpw-3-50
    preset: exl3-3-8-next-4-18bpw-f16
    overrides:
      ModelPath: "<ModelRoot>\\<3.50 bpw model directory>"   # fill in
      NcpuMoe: 432                                           # fill in the value that fits
```

The context experiment is defined in plan 3, where the long-context suite exists.

README additions: a "Comparing variants" section (freeze → plan → run → compare, with the commands), the meaning of each comparison column, the unit-level resume rule, the list of standard tasks with their status from Task 12, the manual-swap procedure for backend regressions, and new rows in the capability table: override header mechanism; per-task catalogue verification; gated datasets.

- [ ] **Step 1: Shipped experiment files load.** Extend `tests/test_shipped_configs.py`: every non-example file under `configs/experiments/` resolves against the shipped suites and manifests; the example file resolves too, because model paths are not checked offline.
- [ ] **Step 2: Full validation.** From `local-evals/`: `pytest`, `ruff check .`, `pyright`. From the repository root: `npm run typecheck`, `npm test`. All exit 0.
- [ ] **Step 3: Offline plan of a real experiment.** `local-evals plan --experiment configs/experiments/kv_quant.yaml` — prints one diff for `kv-f16` and a time range; contacts nothing.
- [ ] **Step 4: First real comparison (needs a running SiftKit and the user's go-ahead).** If nothing listens on :4765, or a run was not authorized, record `blocked` in the README and give the user:

```powershell
local-evals doctor --model exl3-3-8-27b-5bpw
local-evals plan --experiment configs/experiments/kv_quant.yaml --resolve
local-evals run --experiment configs/experiments/kv_quant.yaml
local-evals compare --run-id <run-id>
```

  State the plan's time range to the user before starting a run; do not start one whose high estimate exceeds what they agreed to.
- [ ] **Step 5: Clean up** `.scratch/local-evals`.

**Acceptance:** the spec's sub-project 2 "done when" holds under mocks; each standard task is in a suite or listed with its reason; the real comparison is either reported with its run id and coverage, or marked blocked with the commands.

---

## Handoff contents

Files changed; commands executed; test results; which override keys survived the residency test; the header mechanism Inspect needed; the catalogue status of each standard task; the plan output for `kv_quant`; anything blocked and why.
