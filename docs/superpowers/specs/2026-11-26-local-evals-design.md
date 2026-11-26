# Local Model Evaluation Harness (`local-evals`) Design

Date: 2026-11-26

## Goal

Answer one question with reproducible evidence: on this machine and for these workloads, how much
model capability is gained or lost by changing weights, KV-cache precision, context length, drafting
or agent configuration, and is that worth the speed, memory and reliability cost?

The harness measures the model, not SiftKit's workflows. The existing `bench/benchmark`,
`bench/benchmark-matrix` and dashboard benchmark runner measure SiftKit end to end and are not
changed, replaced or reused.

## Decisions already made

| Decision | Choice |
|---|---|
| Language | Python package in this repo, as a scoped exception to the TypeScript-only rule. SiftKit-side changes stay TypeScript. |
| Evaluator | Inspect AI + Inspect Evals first, behind an adapter so other harnesses can be added. |
| Inference path | Through a new SiftKit benchmark route on the status server, never directly to TabbyAPI. |
| Variant | A SiftKit model preset, optionally with whitelisted overrides applied per request. Saved config is never modified. |
| Storage | Files under `local-evals/runs/`. No database, no dashboard. |
| Planning scope | One spec (this document) and four implementation plans. |

## Verified facts (2026-11-26)

Environment, read-only inventory:

- Windows 11, RTX 4090 (24564 MiB), driver 610.88, Node 26.7.0.
- System Python 3.14 at `%LOCALAPPDATA%\Programs\Python\Python314`. `httpx` and `pytest` installed;
  `inspect-ai`, `inspect-evals` and `openai` are not.
- No Docker, no `uv`. One WSL2 distro exists, stopped.
- Nothing was listening on :4765 or :8098, so no request was sent to a model.
- Model directories in the engine `ModelRoot`: `Qwen3.8-27B-exl3-SCP_5.00bpw` (18.2 GiB),
  `Qwen3.8-Flash-Next-exl3-3.50bpw_hq_h6_ng6` (92.4 GiB),
  `Qwen3.8-Flash-Next-exl3-4.18bpw_h6_ng8` (113.6 GiB).
- Saved model presets: `exl3-3-8-27b-5bpw` (q8 KV, 170000 context, MTP draft 4) and
  `exl3-3-8-next-4-18bpw-f16` (f16 KV, 200000 context, 432 CPU-MoE experts, MTP draft 3).
  The 3.50 bpw directory has no preset. The engine is managed and Tabby authentication is off.

Upstream:

- `inspect-ai` 0.3.292 and `inspect-evals` 0.30.0 both require Python >= 3.11.
- Provider syntax `openai-api/<provider>/<model>` reads `<PROVIDER>_BASE_URL` and
  `<PROVIDER>_API_KEY`. Model args: `emulate_tools`, `strict_tools`, `stream`.
  `--extra-body` exists. `--max-retries` defaults to unlimited.
- `eval-set` resumes from a dedicated log directory and reuses completed samples that have stable ids.
- Built-in sandboxes are `docker` (Engine >= 24.0.6, Compose >= 2.21.0) and `local` (no isolation).
- Tasks registered on `main`: `gsm8k`, `gpqa_diamond`, `mmlu_pro`, `bbh`, `livebench`, `math`,
  `aime2024`, `aime2025`, `aime2026`, `ifeval`, `ifevalcode`, `humaneval`, `mbpp`, `bigcodebench`,
  `bfcl`, `niah`, `infinite_bench_*`, `hle`, `swe_bench`, `swe_bench_verified_mini`.
- Not registered: IFBench, HumanEval+, MBPP+, LiveCodeBench (only `livecodebench_pro`), RULER,
  LongBench v2, NoLiMa.

SiftKit code:

- `resolveModelRequestContext` already selects a model preset per request through
  `intent.modelPresetId`, and admission drains other work and loads it.
- `PresetRuntimeCoordinator.ensureRequestPresetReady` loads the preset object it is given; it only
  checks that the id exists in saved config. A modified copy is therefore loadable.
- A requested switch persists `ActivePresetId`. A failed later switch writes the previously applied
  preset body back into saved config (`restorePreviousModelSelection`). Both must be prevented for
  benchmark traffic.
- `GET /config` without `skip_ready=1` calls `ensureActivePresetReady`, which switches the runtime
  back to the saved active preset whenever the applied preset differs. An unsaved benchmark switch
  would therefore be reverted by any dashboard or CLI config read.
- `ManagedInferenceRuntime.getGeneration()` already counts every process and model state change.
- The existing `/v1/chat/completions` passthrough replaces caller sampling, `max_tokens` and thinking
  settings with the preset's and counts prompt tokens to clamp output.
- Tabby `usage` carries `prompt_time`, `completion_time`, `prompt_tokens_per_sec`,
  `completion_tokens_per_sec`, cached and accepted/rejected prediction token counts.

## Verification gates

Each item is unconfirmed. The plan that depends on it starts with a check and names the fallback.

| Gate | Needed by | Fallback |
|---|---|---|
| Every dependency installs on Python 3.14 | Plan 1 | Create the venv from Python 3.13; installing it needs authorization. |
| Inspect's `openai-api` provider sends `extra_headers` and `extra_body` | Plan 1 | Carry overrides in `extra_body` only, or in the model name via a registered variant id. |
| Inspect surfaces Tabby's `reasoning_content` | Plan 1 | Record reasoning tokens from usage only; mark reasoning text unavailable. |
| Tabby honours `seed` | Plan 1 | `doctor` reports seed unsupported; repeats replace seeds. |
| Tabby's `/v1/model` card reports the applied `cache_mode` | Plan 1 | KV precision is reported as configured, verified `null`. |
| `inspect score` can grade a finished log with a different model | Plan 4 | Grade in a second `eval` over stored outputs with a replay solver. |
| A maintained harness carries LongBench v2, RULER, LiveCodeBench | Plan 4 | Use the benchmark's official harness; own port last, labelled non-official. |

## Architecture

```
local-evals  (Python: CLI, evaluator adapters, tasks, perf probe, statistics, reports)
     |   openai-api/siftbench/<model-preset-id>     X-SiftKit-Bench-Overrides: {...}
     v
SiftKit status server :4765   /bench/v1/*          (new, TypeScript)
     |   admission, preset switch, verified identity, usage passthrough
     v
TabbyAPI :8098 (SiftKit-managed)  ->  ExLlamaV3  ->  RTX 4090 + host RAM
```

### SiftKit benchmark route (TypeScript)

New module `src/status-server/routes/bench.ts`, registered in `src/status-server/routes.ts`.
Contracts live in `packages/contracts/src/bench.ts`.

| Endpoint | Behaviour |
|---|---|
| `GET /bench/v1/models` | Lists every saved model preset id. No wake. |
| `POST /bench/v1/chat/completions` | `model` is a preset id. Admits through the model queue with `intent.modelPresetId`, then forwards to Tabby. |
| `POST /bench/v1/token/encode` | Tokenizes with the variant's tokenizer. Admits like chat. |
| `POST /bench/v1/identity` | Body `{ model, overrides }`. Reports whether that variant is resident and what was verified. No wake. |

Chat forwarding rules, each differing from the existing passthrough:

- Caller `temperature`, `top_p`, `top_k`, `min_p`, penalties, `seed`, `stop`, `max_tokens`,
  `chat_template_kwargs`, `tools` and `response_format` are forwarded unchanged. The preset supplies
  none of them.
- No prompt-token count and no `max_tokens` clamp. Context overflow is Tabby's error, returned to the
  caller with its status, so "input too long" stays distinct from a wrong answer.
- `model` is rewritten to the preset's served model name. The override header is removed.
- A request without `max_tokens` is rejected with 400; a benchmark must state its output budget.
- Every response carries `X-SiftKit-Bench-Residency` (hash of the residency key) and
  `X-SiftKit-Bench-Generation` (the runtime's state-change counter), so the harness can detect a
  reload inside a run.
- The route requires the managed runtime coordinator and answers 503 without one.
- The admission kind is `bench`. It wakes an idle-unloaded model and applies its preset as
  *transient*: `AppliedModelPresetState` records the flag, the saved `ActivePresetId` is never
  written, and a config read does not revert a transient preset. The next ordinary SiftKit model
  request switches back through normal admission and clears the flag.
- A rollback from a transient preset restores the saved active preset by id and never writes a preset
  body into saved config.

Identity response:

```
requested   { presetId, overrides, settings }          settings = the resolved preset
resident    { matches, card: { id, max_seq_len, cache_size, chunk_size, cache_mode } | null }
drafting    { configured, verified }                   verified: true | false | null
engine      { managed, pythonPath, workingDirectory, entrypoint, environment }
residency   { keyHash, generation }
```

A field SiftKit cannot confirm is `null`. The harness labels such a run `unverified` for that
dimension and refuses to name it as a specific quantization in a report title. `drafting.verified`
is `true` only for a managed, resident preset with drafting configured, because that load path
already asserts the engine's drafting log line; otherwise it is `null`. The harness derives the
ExLlamaV3 version from the interpreter's `site-packages` metadata and the TabbyAPI commit from
`workingDirectory`, without importing or running the engine.

### Variant overrides (TypeScript, plan 2)

- Header `X-SiftKit-Bench-Overrides` holds a JSON object validated by a strict schema over this
  whitelist: `Model`, `ModelPath`, `NumCtx`, `KvCacheQuantization`, `NcpuMoe`, `UBatchSize`,
  `ParallelSlots`, `SpeculativeEnabled`, `SpeculativeDraftMax`, `SpeculativeDynamic`,
  `HybridDraftTokens`, `SparseDraftHead`, `DiskCacheDir`, `RamDiskCache`. Unknown keys are a 400.
- Sampling and reasoning fields are not overridable here; they come from the request.
- `ModelRequestIntent` gains `modelPresetOverrides`. `resolveModelRequestContext` applies it to a
  clone of the selected preset, so the residency key differs and the coordinator reloads.
- Engine-level settings (`Server.Engines.Exl3.Environment`, interpreter, Tabby commit) are not
  overridable. Backend-regression experiments change them by hand between runs; identity captures
  them, and the experiment marks those variants `swap: manual`.

### Python package

```
local-evals/
  pyproject.toml  requirements.lock  README.md  .env.example
  configs/
    models.yaml                         provenance SiftKit cannot know, keyed by preset id
    generation/{fixed-v1,greedy-v1}.yaml
    suites/{smoke,structured,quick,standard,long_context,coding,judged,workload,agent,siftkit_workflow}.yaml
    graders/default.yaml              the fixed grader for judged tasks
    estimates.yaml                    assumptions behind a plan's time range
    experiments/{weight_quant,kv_quant,context,drafting,model_choice}.yaml
    perf/{single-stream,context-matrix,capacity}.yaml
  src/local_evals/
    cli.py            argument parsing and exit codes only
    config.py         pydantic models; resolved manifest and its hash
    siftkit.py        bench route client (httpx)
    guard.py          loopback check, cloud-key scrub
    doctor.py         preflight checks
    runstore.py       run directory, atomic writes, run state, resume check
    records.py        SampleRecord, PerfObservation, error categories
    samples.py        frozen sample manifests
    evaluators/base.py          Evaluator protocol
    evaluators/inspect_eval.py  the only module that imports inspect_ai
    tasks/            fixtures loaders and scorers as plain functions
    tasks/inspect_bindings.py   thin @task wrappers over tasks/
    runner.py         one runner for suite runs and experiments: variants, units, resume
    planning.py       planned work, variant diffs, warnings, time range
    stats.py  compare.py  report.py
    perf.py  timing.py  corpus.py  telemetry.py  capacity.py  tradeoff.py  sandbox.py
  fixtures/           synthetic, versioned, no secrets
  manifests/          frozen sample ids and content hashes
  tests/
  runs/               gitignored
```

- Dedicated `.venv` created from system Python. The EXL3 runtime venv is never touched.
- Direct dependencies pinned with `==` in `pyproject.toml`; `requirements.lock` is written from the
  environment that passed the smoke test.
- Tooling: `pytest`, `ruff`, `pyright` in strict mode.

### Evaluator adapter

```python
class Evaluator(Protocol):
    name: str
    def run(self, request: TaskRunRequest) -> RawLogRef: ...     # frozen sample ids, generation profile
    def read_samples(self, log: RawLogRef) -> Iterator[EvaluatedSample]: ...
```

- `configs/tasks.yaml` is the task catalogue: each entry names its evaluator, sandbox and judge needs,
  extras, dataset, licence and the evaluator release it was checked against. Only catalogued tasks run.
- The runner turns an `EvaluatedSample` into a `SampleRecord` by adding run, variant and residency fields.
- Custom workload tasks keep fixtures as JSONL and scorers as plain functions; the Inspect binding
  only adapts them. Moving to another harness means writing another binding.
- `compare` refuses to pair runs of one benchmark made by different evaluators.

### Registry

`configs/models.yaml` is keyed by preset id and holds only `base_checkpoint`, `hf_repo`,
`hf_revision`, `quant_format`, `nominal_bpw`, `quantizer_revision`, `calibration`, `tokenizer`.
Unknown values are written as `null`. Path, size, context, KV mode and drafting come from the
identity endpoint at run time. Weight files are never hashed; the fingerprint is file names, sizes
and modification times of the model directory plus the hash of its small JSON metadata files.

### Generation protocol

| Profile | Definition |
|---|---|
| `fixed-v1` | Sampling values and thinking mode copied once from the reference preset into the profile file, then applied to every variant, with a fixed seed. Default for comparisons. |
| `greedy-v1` | Temperature 0, same thinking mode. |

Per-task `max_tokens` is set in the suite file. A profile is part of the resolved manifest, so two
runs with different profiles are incompatible for `compare`. The route's `max_tokens` requirement
and Inspect's `--max-retries` are always set explicitly.

### Run output

```
runs/<run-id>/
  manifest.resolved.json   environment.json   samples.manifest.json   plan.json   state.json
  variants/<variant>/            identity, engine and model fingerprint, state
  units/<variant>/<task>.r<n>.jsonl   one file per completed (variant, task, repeat), written atomically
  raw/<variant>/<evaluator>/     authoritative logs, never rewritten
  samples.jsonl                  rebuilt from unit files, never appended to
  perf.jsonl   telemetry.jsonl   errors.jsonl
  summary.json   report.md   report.csv
```

`SampleRecord`: run id, experiment id, variant id, evaluator, task and version, sample id, dataset
revision, repeat, seed, raw log reference, scorer, score, status, prompt and output token counts,
reasoning token count, nullable timing fields, finish reason, model calls, tool calls, retries,
error category, residency hash and runtime generation.

Status values: `correct`, `incorrect`, `invalid_format`, `truncated`, `input_too_long`, `timeout`,
`infra_error`, `unavailable`, `skipped`. The first four are outcomes the model produced; the rest are
operational and never count as wrong answers.

`environment.json` records OS build, CPU, GPU, driver, Python, package versions, the identity
response, Tabby and SiftKit git commits with dirty state, and UTC start and end times. Reports
redact absolute paths by default.

### Safety

- `guard.py` rejects any model or grader whose base URL is not loopback, and removes known cloud API
  keys from the process environment before an evaluator runs. `allow_cloud: false` is the only
  supported value; setting it true is a config error.
- Datasets download from Hugging Face on first use. `plan` lists them; `run` refuses a dataset not
  already cached unless `--allow-dataset-download` is given.
- A task whose requirements include a sandbox is `unavailable` when Docker is absent. The `local`
  sandbox is never used for model-generated code.
- No model weights are downloaded and no model file is written.

## CLI

```
local-evals doctor      --model <preset> [--endpoint siftkit-local] [--check-overflow] [--check-sandbox]
local-evals list-models --endpoint siftkit-local
local-evals list-tasks
local-evals freeze      --suite <name> [--task <key>] [--count N] [--seed N]
local-evals plan        --experiment <file> [--resolve] [--calibrate-from <run-id>]
local-evals run         --suite <name> --model <preset> | --experiment <file>
local-evals resume      --run-id <id>
local-evals perf        --model <preset> | --experiment <file>  --profile <name>
local-evals capacity    --model <preset> | --experiment <file> --variant <id>  --confirm
local-evals compare     --reference <run[:variant]> --candidate <run[:variant]> | --run-id <id>
local-evals tradeoff    --quality <run-id> --perf <run-id>
local-evals report      --run-id <id> --format markdown|csv
```

Every command accepts `--json`. `plan` and `run --dry-run` contact no model; `plan --resolve` asks the
server for each variant's resolved settings through `identity`, which never loads one. Exit code is nonzero for
preflight, config and fatal errors.

## Sub-projects

Each has its own implementation plan under `docs/superpowers/plans/`. They are built in order; each
ends with a green tree and a usable command.

### 1. Core harness — `2026-11-26-local-evals-1-core.md`

- TypeScript: transient applied-preset state in the coordinator, bench route (`models`,
  `chat/completions`, `token/encode`, `identity`), the `bench` admission kind, residency headers.
- Python: package scaffold, `config`, `siftkit`, `guard`, `doctor`, `runstore`, `records`, evaluator
  protocol, Inspect adapter, `list-models`, `list-tasks`, `run --suite smoke`, `report`.
- Tasks: `inspect_evals/gsm8k` (5 samples) and a custom structured-output task (JSON schema, enums,
  nested objects, no extra text).
- `doctor` checks: models list, one non-streaming and one streaming chat, finish reason, usage fields,
  reasoning handling, seed, stop sequences, native tool call with a mock tool, context overflow error
  shape, identity match, sandbox availability. Unsupported items are reported, never assumed.
- Done when: a mocked run and, with the server up, a real smoke run produce `samples.jsonl` and
  `report.md`; the gates for this plan are resolved and recorded in the README.

### 2. Paired comparison — `2026-11-26-local-evals-2-comparison.md`

- TypeScript: variant overrides on the bench route and request intent.
- Python: `samples` (seeded, stratified, frozen ids with content hashes), `quick` and `standard`
  suites, experiment manifests, `plan`, sequential runner, `resume`, `stats`, `compare`.
- Tasks: `gpqa_diamond`, `mmlu_pro`, `bbh`, `math`, `ifeval` (strict and loose reported separately),
  `bfcl`, custom mock-tool tasks (single, parallel, dependent, tool error, no-tool cases; native and
  emulated tool calling as separate labelled conditions).
- `plan` shows model swaps, sample counts, context and output budgets, judge and sandbox needs,
  datasets to download, the field diff between each variant and the reference, and a time range
  computed from stated assumptions or earlier measured throughput. It warns when a variant differs
  from the reference in more than one field.
- The runner evaluates one variant fully before switching. It verifies identity before the first
  sample and after the last, and flags samples whose runtime generation changed mid-variant.
- `resume` skips completed (variant, task, repeat) units and reruns an interrupted unit whole. It is
  refused when the resolved manifest or a sample manifest changed.
- `compare` requires equal resolved protocol, scorer and sample ids. It reports matched n, accuracy
  on completed samples and on all planned samples, percentage-point delta, win/loss/tie, exact
  McNemar for binary scores, seeded paired bootstrap for continuous scores, and 95% intervals,
  clustered by sample across repeats. A variant that cannot fit a context is `infeasible`, not zero.
- Done when: two mocked variants compare end to end, an interrupted run resumes without duplicates,
  and incompatible runs are rejected.

### 3. Performance and context — `2026-11-26-local-evals-3-performance.md`

- Python: `perf` streaming probe, `telemetry` sampler (NVML and psutil at a fixed interval, Tabby
  process tree located by port), cold and warm profiles, context matrix, capacity probe,
  `long_context` suite, quality/speed/VRAM summary with a Pareto table.
- Metrics and their source:

| Metric | Source |
|---|---|
| Client TTFT | Monotonic clock, request start to first content or reasoning event; the event kind is recorded. |
| Prefill tokens/s | Tabby `prompt_tokens_per_sec` over uncached prompt tokens. `null` when absent. |
| Decode tokens/s | Tabby `completion_tokens_per_sec`. A separate client streaming rate is labelled approximate. |
| End-to-end latency | Monotonic clock, request start to stream end, through the SiftKit route. |
| Cache reuse | `prompt_tokens_details.cached_tokens`. |
| Drafting | Accepted and rejected prediction tokens; acceptance rate. |
| Memory | NVML used and peak, process RSS, system RAM and commit, sampled before load, after load, during prefill and decode. |

- Prompts are generated deterministically from a seeded corpus and sized with the bench tokenizer
  endpoint. Cells: 512, 4k, 16k, 32k, 64k, 128k and near-maximum input; 1 to 3 warmups; 3 to 5 timed
  repeats; concurrency 1. Median and spread are reported; p95 only at 20 or more observations.
- The capacity probe raises input size until failure, stops after two consecutive failures, and
  refuses to start when dedicated VRAM is already above a configured ceiling.
- Long-context tasks: custom needle, multi-needle, cross-document join and conflicting-fact tasks at
  measured token lengths; `niah`; selected `infinite_bench_*`. Accuracy is reported per actual length.
- Done when: probes run against a mocked streaming endpoint with TTFT and decode never conflated,
  unsupported telemetry is `null`, and OOM is recorded as a reliability outcome.

### 4. Expanded suites — `2026-11-26-local-evals-4-expanded.md`

- Sandbox: Docker Engine installation is a separately authorized step with a WSL memory cap, because
  Flash-Next loads leave about 2 GB of free commit. Until then every sandbox task is `unavailable`.
- Coding: `humaneval`, `mbpp`, `ifevalcode`, pass@1 only.
- Judged tasks: `hle` in two phases, generation with the candidate and grading with one fixed grader
  preset, so the two never share VRAM. Grader preset and settings are part of the protocol.
- Second evaluator adapter for benchmarks Inspect Evals lacks. The plan opens with a spike that
  records which maintained harness carries LongBench v2, RULER and LiveCodeBench; EvalScope is the
  first candidate.
- Custom workload tasks: synthetic repository question answering with executable checks, long-document
  summarization scored against a fact ledger, constrained planning verified algorithmically, and
  benign prompt-injection cases with mock tools.
- Agent suite: synthetic multi-tool tasks first, then `swe_bench_verified_mini`, opt-in.
- SiftKit-workflow cases: fixed repo-search and summary prompts run through the SiftKit CLI and scored
  by the same scorers, as an agent-configuration experiment.

## Feasible first experiments on this machine

| Experiment | Variants | Note |
|---|---|---|
| Weight quantization | Flash-Next 3.50 bpw vs 4.18 bpw | CPU-MoE expert count must differ to fit VRAM; reported as an operational difference. |
| KV precision | f16 vs q8 on one model | Single-field override. |
| Context | One preset at increasing `NumCtx` | Matched lengths first, then maximum feasible. |
| Drafting | MTP on vs off | Quality on a regression subset, speed on the perf suite. |
| Model choice | 27B dense vs Flash-Next | A deployment comparison, not a quantization result. |

The dense 27B has one quantization on disk, so it has no weight-quantization experiment.

## Testing

- TypeScript: `node:test` end-to-end tests against the in-process fake Tabby used by the passthrough
  tests. Covers forwarding of caller sampling, no clamp, overflow error passthrough, missing
  `max_tokens`, unknown preset, no selection persistence, residency headers, identity fields, override
  whitelist, and rollback from a transient preset.
- Python: `pytest`. The bench route is faked with an in-process HTTP server; evaluator runs use
  Inspect's mock model. Covers malformed config, unreachable server, wrong model id, unexpected finish
  reason, incomplete logs, judge role binding, cloud guard, scoring, normalization, comparison
  compatibility, failures and resume.
- Before completion of each plan: `npm run typecheck`, `npm run lint`, `npm test`, and in
  `local-evals/`: `pytest`, `ruff check`, `pyright`.

## Out of scope

- Perplexity, KL divergence and other logit-level diagnostics.
- HTML dashboard and any SiftKit dashboard integration.
- llama.cpp, Ollama and cloud endpoints.
- Changes to TabbyAPI or ExLlamaV3.
- Automatic creation, editing or deletion of saved model presets.

## Acceptance

- A fresh environment is set up from the README on Windows.
- `plan` and `run --dry-run` validate manifests and print planned work without contacting a model.
- Loaded model, context, KV mode and drafting are verified or explicitly `null` before a run is labelled.
- One standard and one custom task pass the pipeline; mocked status is stated when no model was used.
- A comparison uses identical sample ids, reports coverage and errors, and rejects incompatible protocols.
- An interrupted run resumes without duplicates or changed configuration.
- Every reported metric states its unit, scope and source; unsupported values are `null`.
- No secrets in committed config or exported logs; generated code runs only in a sandbox; no cloud judge.
- Final handoff lists files changed, commands executed, results, blockers and assumptions.
