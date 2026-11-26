# local-evals

Measures what a locally served model can do, and what changes when its weights, KV-cache precision,
context or drafting change. It talks only to SiftKit's benchmark route, so the model it measures is
exactly the one SiftKit loaded and verified.

Design: `docs/superpowers/specs/2026-11-26-local-evals-design.md`.

## Setup (Windows)

```powershell
cd local-evals
py -3.14 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.lock
python -m pip install -e ".[dev]" --no-deps
```

On Linux use `python3 -m venv .venv` and `source .venv/bin/activate`; the remaining commands are the same.
A suite with a dataset-backed task needs `--allow-dataset-download` on every run, not only the first:
tasks pin a dataset revision, and the evaluator contacts Hugging Face to resolve it even when the data
is cached. Without the flag such a suite is refused before anything is loaded (exit code 2). No model
weights are ever downloaded.

Never install into the EXL3 runtime interpreter that SiftKit launches TabbyAPI with.

## Use

Start SiftKit in stable mode from the repository root (`npm run start:status:stable`), then:

```powershell
local-evals list-models
local-evals doctor --model exl3-3-8-27b-5bpw
local-evals run --suite smoke --model exl3-3-8-27b-5bpw --dry-run
local-evals run --suite smoke --model exl3-3-8-27b-5bpw --allow-dataset-download
local-evals report --run-id <run-id>
```

`--json` goes before the command and makes the output machine-readable. Exit codes: 0 success,
1 a doctor check failed, 2 configuration, endpoint or run error.

`run --mock` uses a mock model. It proves the pipeline and nothing else; its report says so.

`doctor --check-overflow` also sends one prompt about 10% larger than the preset's context and requires
the engine to reject it. A 4xx answer passes; a 5xx answer or an accepted prompt fails.

## What a run writes

`runs/<run-id>/`: `manifest.resolved.json`, `environment.json`, `state.json`, `raw/` (the evaluator's
own logs, never rewritten), `samples.jsonl`, `errors.jsonl`, `summary.json`, `report.md`, `report.csv`.

A sample's status is one of `correct`, `incorrect`, `invalid_format`, `truncated` (model outcomes) or
`input_too_long`, `timeout`, `infra_error`, `unavailable`, `skipped` (operational outcomes). Operational
outcomes are never counted as wrong answers.

A task that produced no samples at all (skipped by the wall-clock cap, unavailable, or failed) is
written to `errors.jsonl` and listed in the report under "Tasks that did not produce samples".

`environment.json` records the machine, package versions, repository commits and the identity SiftKit
vouched for. A value that could not be read is null and its reason is listed under `unavailable`; the
report repeats those reasons.

## How a model is identified

`model` is a SiftKit model preset id. Before a run, the harness loads the preset through the benchmark
route and asks SiftKit what is resident. A run is refused when the resident model does not match. The
report prints context, KV-cache mode and drafting as verified or unverified; an unverified value is
never presented as measured. `configs/models.yaml` holds provenance SiftKit cannot know; leave unknown
values `null`.

Benchmark requests load a preset without changing your saved active preset. The next ordinary SiftKit
request switches back, which reloads the model; avoid using SiftKit for other work during a run.

## Safety

- Only loopback endpoints are accepted. Cloud API keys are removed from the process environment before
  an evaluator runs.
- Tasks that execute model output need a Docker sandbox and are reported unavailable without one.
- Reports contain no prompts or responses; those stay in `raw/`.

## Development

```powershell
python -m pytest
python -m ruff check .
python -m ruff format --check .
python -m pyright
```

Tests never contact a real server: they use an in-process fake of the benchmark route, a local capture
server, and Inspect's mock model. Only `evaluators/inspect_eval.py` and `tasks/inspect_bindings.py`
import `inspect_ai`; everything else depends on the `Evaluator` protocol in `evaluators/base.py`.

## Verified capabilities

Filled in from the gate checks and `doctor` on this machine. A row that was not checked says so.

| Item | Result | Date |
|---|---|---|
| Dependencies install on Python 3.14 | ok: Python 3.14.7, `inspect-ai==0.3.292`, `inspect-evals==0.30.0` | 2026-11-26 |
| Inspect API names match the adapter | ok | 2026-11-26 |
| Pyright strict on the Inspect-facing modules | strict; `reportUnknownVariableType` is off in `evaluators/inspect_eval.py` only, because `inspect_ai.eval` has a partially unknown type | 2026-11-26 |
| Mock model consumes outputs in sample order | ok | 2026-11-26 |
| Generation profile reaches the wire (`extra_body`) | ok: `top_k`, `min_p` and `chat_template_kwargs` arrive in the request body | 2026-11-26 |
| Bench route reachable, identity matches | ok: `Qwen3.8-27B-exl3-SCP_5.00bpw`, context 165000, chunk 1024 | 2026-11-26 |
| Backend prefill and decode timing in `usage` | ok | 2026-11-26 |
| Reasoning returned separately | ok: `reasoning_content` is separate from `content` | 2026-11-26 |
| Seed honoured | unsupported: two identical seeded requests returned different text; use repeats for variance | 2026-11-26 |
| Native tool calls | unsupported: the model writes the call as `<tool_call>` text in `content`; the engine returns `tool_calls: null` | 2026-11-26 |
| KV cache mode reported by the model card | ok: applied mode `8,8` | 2026-11-26 |
| Drafting confirmed at load | ok | 2026-11-26 |
| Context overflow rejected by the engine | ok: HTTP 400 for a 181,398-token prompt against a 165,000-token context | 2026-11-26 |
| Docker sandbox | unsupported: Docker is not installed | 2026-11-26 |
| Dataset-backed suite without `--allow-dataset-download` | refused before any load, exit code 2 | 2026-11-26 |
| Real smoke run | ok: run `20261126T200923Z-b4d08b`, 11 of 11 samples completed (a pipeline check, not a quality measurement) | 2026-11-26 |

Preset checked: `exl3-3-8-27b-5bpw`. Re-run `local-evals --json doctor --model <preset> --check-overflow`
after changing the engine, the preset or the pinned evaluator, and update this table.

Per-sample `reasoning_tokens` is null on this engine: its `usage` does not report reasoning tokens
separately, so they are included in `output_tokens`.
