# Local Evals 3: Performance and Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure prefill, decode, time to first token, memory and failure behaviour per variant and prompt size, test quality on long inputs, and put quality, speed and memory side by side.

**Architecture:** A streaming probe sends deterministic, tokenizer-sized prompts through the bench route and turns each stream into one observation. Client timing and backend timing are separate fields that are never merged. A background sampler records GPU and process memory. Long-context quality runs through the existing runner as ordinary tasks, one suite entry per length, so per-length comparison needs no new machinery. Everything in this plan is Python; the bench route is unchanged.

**Tech Stack:** As plans 1 and 2, plus `psutil` and `nvidia-ml-py`.

**Spec:** `docs/superpowers/specs/2026-11-26-local-evals-design.md`
**Depends on:** plans 1 and 2, complete and green.

## Ground rules for every task

- Do not commit. Do not use worktrees. Temporary files go in `.scratch/local-evals/` and are deleted at the end.
- Python: `pyright` strict, `ruff` clean, no `# type: ignore`. Only the two Inspect-facing modules import `inspect_ai`.
- Commands run from `local-evals/` with the venv active.
- No test loads a model, reads a real GPU or needs a running server. Hardware readers sit behind small classes that tests replace.
- A value that could not be measured is `null`. It is never 0 and never estimated.
- A probe that can exhaust memory (Task 7) is run for real only with the user's explicit go-ahead.

## Task format

As plan 2: goal, files, decisions (names, signatures, schemas, formulas, file contents), failing test, acceptance. Test code and contracts are exact; implementation bodies are the implementer's, within the stated interfaces. Each task follows the cycle: write the test, see it fail for the stated reason, implement, see it pass.

## What earlier plans provide

| Name | Where | Used here for |
|---|---|---|
| `BenchClient`, `StreamFrame`, `overrides_headers` | `siftkit.py` | The probe's transport; streaming is reshaped in Task 1. |
| `FakeBench` | `tests/fake_bench.py` | Extended with realistic streams and failure modes. |
| `Variant`, `ResolvedManifest`, `resolve_experiment`, `Strict`, `load_yaml` | `config.py` | Variants are reused as they are. |
| `RunStore` | `runstore.py` | Perf runs use the same directory layout. |
| `prepare` step of `run_manifest` | `runner.py` | Extracted in Task 5 so the probe loads and verifies a variant the same way. |
| `LOCAL_TASKS`, the adapter, catalogue fields | plan 2 | Long-context tasks are ordinary local tasks. |
| `load_variant`, `VariantData` | `compare.py` | The trade-off summary reads quality from a run. |

## File map

| File | Responsibility |
|---|---|
| `local-evals/pyproject.toml`, `requirements.lock` (modify) | `psutil`, `nvidia-ml-py`. |
| `src/local_evals/siftkit.py` (modify) | `open_stream`: status, headers and frames of one streamed chat. |
| `src/local_evals/records.py` (modify) | `PerfObservation`, `PerfStatus`. |
| `src/local_evals/timing.py` (create) | Pure analysis of one stream into timings and token counts. |
| `src/local_evals/corpus.py` (create) | Deterministic synthetic ledger text; prompts sized with the bench tokenizer. |
| `src/local_evals/telemetry.py` (create) | GPU, process and system memory readers; background sampler; engine process lookup. |
| `src/local_evals/perf.py` (create) | Profiles, the probe loop, failure classification, summary. |
| `src/local_evals/capacity.py` (create) | Largest-prompt probe with a VRAM ceiling and a stop rule. |
| `src/local_evals/tasks/long_context.py` (create) | Needle, multi-needle, join and conflict cases and scorer as plain functions. |
| `src/local_evals/tradeoff.py` (create) | Quality, speed and memory per variant; Pareto flag. |
| `src/local_evals/runner.py`, `doctor.py`, `cli.py`, `tasks/inspect_bindings.py` (modify) | Shared variant preparation; telemetry check; `perf`, `capacity`, `tradeoff`; task binding. |
| `configs/perf/{single-stream,context-matrix}.yaml`, `configs/suites/long_context.yaml`, `configs/experiments/context.yaml` (create) | Profiles, suite, experiment. |
| `fixtures/long_context/v1.jsonl`, `manifests/long_context/*.json` (create) | Case specifications and frozen samples. |

---

### Task 1: Dependencies, the perf record, and a stream that reports its status and headers

**Goal:** One streamed chat is observable in full: HTTP status, residency headers, every frame with its arrival time, and the error body when it fails. An HTTP error is a result, not an exception.

**Files:**
- Modify: `local-evals/pyproject.toml`, `requirements.lock`
- Modify: `local-evals/src/local_evals/siftkit.py`, `src/local_evals/doctor.py`
- Modify: `local-evals/src/local_evals/records.py`
- Modify: `local-evals/tests/fake_bench.py`
- Test: `local-evals/tests/test_siftkit.py`

**Decisions:**

- [ ] **Gate: install.** Add `psutil` and `nvidia-ml-py` to `dependencies`, install, and confirm both import on Python 3.14: `python -c "import psutil, pynvml; print(psutil.__version__, pynvml.__name__)"`. Pin the resolved versions and rewrite `requirements.lock`. If `psutil` has no wheel for this Python, stop and report; process memory cannot be measured without it.

Replace `stream_chat` (remove it; update `doctor.check_streaming`):

```python
@dataclass(frozen=True)
class StreamResult:
    status_code: int
    residency: str | None
    generation: int | None
    # perf_counter() just before the request was sent and just after the stream ended.
    started_at: float
    ended_at: float
    frames: Sequence[StreamFrame]
    # The response body when status_code is not 200, truncated to 2000 characters.
    error_body: str | None
    # Set when the connection failed or broke mid-stream; frames received before the break are kept.
    transport_error: str | None

class BenchClient:
    def open_stream(self, payload: dict[str, JsonValue], overrides: Overrides | None = None, *,
                    timeout_seconds: float | None = None) -> StreamResult: ...
```

- `open_stream` always asks for the final usage frame. It never raises for an HTTP status or a broken stream; `BenchError` is not used here. A read timeout sets `transport_error` to a string starting with `timeout`.
- `PerfObservation` in `records.py` (frozen, extra fields forbidden):

```python
PerfStatus = Literal["ok", "input_too_long", "oom", "timeout", "http_error", "stream_error", "backend_down", "skipped"]

class PerfObservation(BaseModel):
    run_id: str
    variant_id: str
    profile: str
    cell_tokens: int                                   # the prompt size asked for
    cache: Literal["cold", "warm"]
    phase: Literal["warmup", "timed"]
    repeat: int
    status: PerfStatus
    detail: str | None
    http_status: int | None
    started_at_utc: str
    prompt_tokens: int | None
    cached_tokens: int | None
    completion_tokens: int | None
    reasoning_tokens: int | None
    first_event_kind: Literal["content", "reasoning", "tool_call"] | None
    # Client clock, seconds from request start. Includes the SiftKit route and queue.
    ttft_seconds: float | None
    first_content_seconds: float | None
    total_seconds: float | None
    # Client-side streaming rate. Approximate: stream events are not guaranteed to be one token each.
    client_decode_tokens_per_second: float | None
    # Backend clock, as reported by the engine in `usage`. Null when the engine did not report it.
    backend_prompt_seconds: float | None
    backend_prefill_tokens_per_second: float | None
    backend_completion_seconds: float | None
    backend_decode_tokens_per_second: float | None
    draft_accepted_tokens: int | None
    draft_rejected_tokens: int | None
    vram_before_mib: float | None
    vram_peak_mib: float | None
    engine_rss_peak_mib: float | None
    system_commit_peak_mib: float | None
    residency_hash: str | None
    generation: int | None
```

- `FakeBench` streaming becomes configurable, with these new fields:
  - `tokens_per_char: float = 0.25` — prompt tokens are `ceil(len(prompt text) × tokens_per_char)`, where the prompt text is the concatenation of the message contents. `token/encode` switches to the same rule (for a plain string, the string itself), so sizing and usage agree. Adjust any plan-1 assertion that relied on floor division;
  - `context_tokens: int = 32000` — identity reports it as `NumCtx` and as the card's `max_seq_len`; a prompt above it answers 400 with body `{"detail": "Prompt length 40000 is greater than max_seq_len 32000"}` (numbers filled in);
  - `oom_above_tokens: int | None = None` — a prompt above it answers 500 with body `{"detail": "CUDA out of memory. Tried to allocate 2.00 GiB"}`;
  - `cached_prefixes: bool = True` — a prompt identical to an earlier one reports all but 1 prompt token as cached;
  - `drafting: bool = False` — when true the usage frame carries `completion_tokens_details` with accepted and rejected prediction tokens;
  - `break_stream_after: int | None = None` — the stream ends without `[DONE]` after that many frames.
  - With thinking enabled in the request and `reasoning` true, the stream starts with two `reasoning_content` deltas before content.

**Failing test** (replace the plan-1 streaming test in `tests/test_siftkit.py`):

```python
def test_a_stream_reports_status_headers_frames_and_usage() -> None:
    fake = FakeBench()
    result = client_for(fake).open_stream({"model": "preset-a", "messages": [{"role": "user", "content": "x" * 400}],
                                          "max_tokens": 8})
    assert result.status_code == 200 and result.error_body is None and result.transport_error is None
    assert result.residency == RESIDENCY and result.generation == 3
    assert result.started_at <= result.frames[0].received_at <= result.ended_at
    usage = [frame.data["usage"] for frame in result.frames if "usage" in frame.data]
    assert len(usage) == 1 and isinstance(usage[0], dict) and usage[0]["prompt_tokens"] == 100
    assert fake.bodies("/chat/completions")[0]["stream_options"] == {"include_usage": True}


def test_stream_failures_are_results() -> None:
    too_long = client_for(FakeBench(context_tokens=50)).open_stream(
        {"model": "preset-a", "messages": [{"role": "user", "content": "x" * 400}], "max_tokens": 8})
    assert too_long.status_code == 400 and len(too_long.frames) == 0 and "max_seq_len" in (too_long.error_body or "")

    oom = client_for(FakeBench(oom_above_tokens=50)).open_stream(
        {"model": "preset-a", "messages": [{"role": "user", "content": "x" * 400}], "max_tokens": 8})
    assert oom.status_code == 500 and "out of memory" in (oom.error_body or "")

    broken = client_for(FakeBench(break_stream_after=1)).open_stream(
        {"model": "preset-a", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8})
    assert broken.status_code == 200 and len(broken.frames) == 1

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    down = BenchClient(ENDPOINT, None, transport=httpx.MockTransport(refuse)).open_stream(
        {"model": "preset-a", "messages": [], "max_tokens": 8})
    assert down.status_code == 0 and down.transport_error is not None and len(down.frames) == 0
```

Run: `pytest tests/test_siftkit.py tests/test_doctor.py -v` — expected before implementing: `AttributeError: 'BenchClient' object has no attribute 'open_stream'`.

**Acceptance:** `stream_chat` no longer exists (`grep -rn "stream_chat" src tests` prints nothing); the doctor tests pass on `open_stream`.

---

### Task 2: Stream timing analysis

**Goal:** Turn one `StreamResult` into timings and counts with a pure function, so that every timing rule is tested with hand-written frames and no clock.

**Files:**
- Create: `local-evals/src/local_evals/timing.py`
- Test: `local-evals/tests/test_timing.py`

**Decisions:**

```python
@dataclass(frozen=True)
class StreamTiming:
    first_event_kind: Literal["content", "reasoning", "tool_call"] | None
    ttft_seconds: float | None
    first_content_seconds: float | None
    total_seconds: float
    client_decode_tokens_per_second: float | None
    prompt_tokens: int | None
    cached_tokens: int | None
    completion_tokens: int | None
    reasoning_tokens: int | None
    backend_prompt_seconds: float | None
    backend_prefill_tokens_per_second: float | None
    backend_completion_seconds: float | None
    backend_decode_tokens_per_second: float | None
    draft_accepted_tokens: int | None
    draft_rejected_tokens: int | None
    finish_reason: str | None

def analyze_stream(result: StreamResult) -> StreamTiming: ...
```

Rules:
- A *token event* is a frame whose first choice's `delta` has a non-empty `content`, a non-empty `reasoning_content`, or a non-empty `tool_calls`. Its kind is, in that order of precedence, `content`, `reasoning`, `tool_call`. A delta carrying only `role` is not a token event.
- `ttft_seconds` is the first token event's arrival minus `started_at`. `first_content_seconds` is the same for the first `content` event; `None` when there is none.
- `total_seconds` is `ended_at - started_at`, whether or not any frame arrived.
- `client_decode_tokens_per_second` is `(completion_tokens - 1) / (last token event arrival - first token event arrival)` when usage reports at least 2 completion tokens and the two arrivals differ; otherwise `None`. It deliberately excludes the time before the first token, so prefill never leaks into it.
- Usage is read from the last frame that has a `usage` object:
  - `prompt_tokens`, `completion_tokens`;
  - `cached_tokens` from `prompt_tokens_details.cached_tokens`;
  - `reasoning_tokens`, `accepted_prediction_tokens`, `rejected_prediction_tokens` from `completion_tokens_details`;
  - `prompt_time`, `prompt_tokens_per_sec`, `completion_time`, `completion_tokens_per_sec` into the four backend fields, unchanged.
  A field that is absent or not a number is `None`. Nothing is derived from client timing to fill a backend field, or the reverse.
- `finish_reason` is the last non-null `finish_reason` seen.

**Failing test:** `tests/test_timing.py`:

```python
import pytest
from pydantic import JsonValue

from local_evals.siftkit import StreamFrame, StreamResult
from local_evals.timing import analyze_stream


def delta(at: float, **fields: JsonValue) -> StreamFrame:
    return StreamFrame(at, {"choices": [{"index": 0, "delta": fields, "finish_reason": None}]})


def result(frames: list[StreamFrame], started: float = 10.0, ended: float = 11.8) -> StreamResult:
    return StreamResult(status_code=200, residency="r", generation=1, started_at=started, ended_at=ended,
                        frames=frames, error_body=None, transport_error=None)


USAGE: dict[str, JsonValue] = {
    "prompt_tokens": 1000, "completion_tokens": 4, "total_tokens": 1004,
    "prompt_tokens_details": {"cached_tokens": 200},
    "completion_tokens_details": {"reasoning_tokens": 2, "accepted_prediction_tokens": 3,
                                  "rejected_prediction_tokens": 1},
    "prompt_time": 0.4, "prompt_tokens_per_sec": 2000.0, "completion_time": 1.0, "completion_tokens_per_sec": 4.0,
}
FRAMES = [
    delta(10.2, role="assistant"),
    delta(10.5, reasoning_content="th"),
    delta(10.9, reasoning_content="ink"),
    delta(11.2, content="a"),
    delta(11.4, content="b"),
    StreamFrame(11.6, {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
    StreamFrame(11.7, {"choices": [], "usage": USAGE}),
]


def test_client_and_backend_timing_are_read_separately() -> None:
    timing = analyze_stream(result(FRAMES))
    assert timing.first_event_kind == "reasoning"
    assert timing.ttft_seconds == pytest.approx(0.5)
    assert timing.first_content_seconds == pytest.approx(1.2)
    assert timing.total_seconds == pytest.approx(1.8)
    assert timing.client_decode_tokens_per_second == pytest.approx(3 / 0.9)
    assert (timing.prompt_tokens, timing.cached_tokens, timing.completion_tokens, timing.reasoning_tokens) == (1000, 200, 4, 2)
    assert (timing.backend_prompt_seconds, timing.backend_prefill_tokens_per_second) == (0.4, 2000.0)
    assert (timing.backend_completion_seconds, timing.backend_decode_tokens_per_second) == (1.0, 4.0)
    assert (timing.draft_accepted_tokens, timing.draft_rejected_tokens) == (3, 1)
    assert timing.finish_reason == "stop"


def test_missing_backend_fields_stay_null_and_are_not_derived() -> None:
    bare = {"prompt_tokens": 1000, "completion_tokens": 4}
    timing = analyze_stream(result([*FRAMES[:-1], StreamFrame(11.7, {"choices": [], "usage": bare})]))
    assert timing.ttft_seconds == pytest.approx(0.5)
    assert timing.backend_prefill_tokens_per_second is None and timing.backend_decode_tokens_per_second is None
    assert timing.backend_prompt_seconds is None and timing.cached_tokens is None
    assert timing.draft_accepted_tokens is None and timing.reasoning_tokens is None


def test_degenerate_streams() -> None:
    empty = analyze_stream(result([]))
    assert empty.ttft_seconds is None and empty.first_event_kind is None and empty.total_seconds == pytest.approx(1.8)
    assert empty.prompt_tokens is None and empty.client_decode_tokens_per_second is None

    one_token = analyze_stream(result([delta(10.5, content="a"),
                                       StreamFrame(10.6, {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 1}})]))
    assert one_token.first_event_kind == "content" and one_token.first_content_seconds == pytest.approx(0.5)
    assert one_token.client_decode_tokens_per_second is None

    no_usage = analyze_stream(result(FRAMES[:-1]))
    assert no_usage.ttft_seconds == pytest.approx(0.5) and no_usage.completion_tokens is None
    assert no_usage.client_decode_tokens_per_second is None

    tool = analyze_stream(result([delta(10.3, tool_calls=[{"index": 0, "function": {"name": "f", "arguments": "{}"}}])]))
    assert tool.first_event_kind == "tool_call" and tool.first_content_seconds is None
```

Run: `pytest tests/test_timing.py -v` — expected before implementing: `ModuleNotFoundError: local_evals.timing`.

**Acceptance:** all three tests pass; `timing.py` performs no IO and reads no clock.

---

### Task 3: Deterministic corpus and tokenizer-sized prompts

**Goal:** Generate text that is reproducible from a seed, not compressible by prompt-lookup drafting or n-gram caches, and build a chat prompt of a requested token length measured by the model's own tokenizer.

**Files:**
- Create: `local-evals/src/local_evals/corpus.py`
- Test: `local-evals/tests/test_corpus.py`

**Decisions:**

The corpus is a synthetic shipment ledger. Each record is one line with independent random fields, so no long span repeats:

```
Record 004217: on day 212 warehouse Kestrel shipped 418 units of item QX-77 to Marlow.
```

```python
WAREHOUSES: tuple[str, ...]   # 40 invented single-word names, fixed in the module
DESTINATIONS: tuple[str, ...] # 40 invented single-word names, disjoint from WAREHOUSES
ITEM_PREFIXES: tuple[str, ...]  # 20 two-letter codes

@dataclass(frozen=True)
class LedgerRecord:
    number: int        # unique within a ledger, ascending
    day: int           # 1..365
    warehouse: str
    units: int         # 1..999
    item: str          # e.g. "QX-77"
    destination: str

    def line(self) -> str: ...

def generate_ledger(seed: int, count: int) -> list[LedgerRecord]:
    """`count` records from `random.Random(seed)`. (day, warehouse) is unique across the ledger."""

class SizingError(Exception): ...

@dataclass(frozen=True)
class SizedPrompt:
    messages: list[dict[str, JsonValue]]
    target_tokens: int
    measured_tokens: int
    records: int

def sized_prompt(client: BenchClient, model: str, overrides: Overrides | None, *, target_tokens: int, seed: int,
                 instruction: str, tolerance: float = 0.01) -> SizedPrompt: ...
```

- The uniqueness of `(day, warehouse)` is what later lets a question name exactly one record; `generate_ledger` raises `ValueError` when `count` exceeds `365 × len(WAREHOUSES)`.
- `sized_prompt` builds one user message: the ledger lines, a blank line, then `instruction`. It measures the *rendered chat prompt* with `client.count_tokens(model, messages, {"enable_thinking": False}, overrides)`, so the template's own tokens are counted.
- Sizing procedure: measure a 50-record probe to get tokens per record; estimate the record count for the target; then adjust by the measured error, at most 6 measurements in total. Accept when `abs(measured - target) <= max(16, tolerance × target)`. Records are always a prefix of `generate_ledger(seed, n)`, so a larger prompt extends a smaller one. Failing to converge is a `SizingError` stating the last measurement.
- A target smaller than the empty prompt (instruction plus template) is a `SizingError`.

**Failing test:** `tests/test_corpus.py`:

- `generate_ledger(7, 500)` equals itself on a second call, differs from seed 8, has 500 distinct `(day, warehouse)` pairs and ascending numbers; `generate_ledger(7, 300)` is the first 300 records of `generate_ledger(7, 500)`; `count=365*40+1` raises `ValueError`.
- No 12-word span occurs twice in the text of `generate_ledger(7, 2000)` (split on whitespace, slide a window, assert all windows are unique). The line format guarantees it: every 12-word window contains a record number or a `(day, warehouse)` pair. This is the property that keeps prompt-lookup drafting from inflating decode speed.
- With `FakeBench()` (4 characters per token): `sized_prompt(..., target_tokens=4000, seed=1, instruction="Reply with OK.")` returns `measured_tokens` within 40 of 4000, a single user message ending with the instruction, and made at most 6 `token/encode` requests; the same call twice returns identical messages; `target_tokens=8000` with the same seed yields a message whose ledger starts with the 4000-token ledger's lines.
- `target_tokens=2` raises `SizingError`.

Run: `pytest tests/test_corpus.py -v`.

**Acceptance:** the no-repeated-12-word-span property holds; sizing uses the bench tokenizer endpoint and nothing else to count tokens.

---

### Task 4: Telemetry

**Goal:** Sample GPU memory, the engine's process memory and system memory in the background while a request runs, and report peaks per time window. Anything unreadable is `null`.

**Files:**
- Create: `local-evals/src/local_evals/telemetry.py`
- Test: `local-evals/tests/test_telemetry.py`

**Decisions:**

```python
@dataclass(frozen=True)
class TelemetryReading:
    monotonic: float
    utc: str
    phase: str
    vram_used_mib: float | None            # whole device, dedicated memory in use
    vram_total_mib: float | None
    gpu_utilization: float | None          # percent
    engine_rss_mib: float | None           # engine process and its children
    system_ram_used_mib: float | None
    system_commit_mib: float | None        # Windows commit charge; null elsewhere

class GpuReader(Protocol):
    def read(self) -> tuple[float | None, float | None, float | None]: ...   # used, total, utilization

class NvmlGpuReader:                        # device index 0; every NVML error becomes (None, None, None)
class ProcessReader:                        # psutil; engine RSS for a root pid, system RAM, commit charge
    def __init__(self, engine_pid: int | None) -> None: ...
    def read(self) -> tuple[float | None, float | None, float | None]: ...   # engine rss, ram used, commit

def find_listener_pid(port: int) -> int | None:
    """The pid listening on a local TCP port, or None when it cannot be determined."""

def engine_port(identity: Identity) -> int | None:
    """The port of the variant's BaseUrl from identity settings."""

@dataclass(frozen=True)
class Peaks:
    vram_before_mib: float | None
    vram_peak_mib: float | None
    engine_rss_peak_mib: float | None
    system_commit_peak_mib: float | None

class TelemetrySampler:
    def __init__(self, gpu: GpuReader, process: ProcessReader, *, interval_seconds: float, sink: Path) -> None: ...
    def __enter__(self) -> "TelemetrySampler": ...
    def __exit__(self, *exc: object) -> None: ...
    def set_phase(self, phase: str) -> None: ...
    def mark(self) -> float: ...                       # takes one reading now and returns its monotonic time
    def peaks(self, since: float, until: float) -> Peaks: ...
```

- The sampler runs one daemon thread, appends every reading to `sink` (`telemetry.jsonl`) as it is taken, and keeps readings in memory for `peaks`. `__exit__` stops and joins the thread.
- `peaks(since, until)`: `vram_before_mib` is the last reading at or before `since`; the three peaks are maxima over readings in `[since, until]`. A dimension with no non-null reading in the window is `None`.
- `mark()` is how the probe makes sure there is a reading at the exact start and end of a request even when the interval is longer than the request.
- Commit charge on Windows comes from `GlobalMemoryStatusEx` through `ctypes` (`ullTotalPageFile - ullAvailPageFile`); on other systems it is `None`.
- `find_listener_pid` uses `psutil.net_connections(kind="tcp")` and returns `None` on `AccessDenied`. The process tree is the pid and `children(recursive=True)`; a process that vanishes mid-read is skipped.
- Per-process GPU memory is not reported: under the Windows driver model NVML usually cannot attribute it. Device-level memory is reported and the README says other GPU users inflate it.
- Phases the probe sets: `idle`, `load`, `request`. Prefill and decode are not separable from the client side by the sampler; the per-observation window is the whole request.

**Failing test:** `tests/test_telemetry.py`, with fake readers (two small classes in the test file whose `read` returns values from a list the test controls):

1. **Peaks over a window.** Feed readings through `mark()` with VRAM `[1000, 1200, 5000, 4000]`; `peaks(since=<2nd mark>, until=<4th mark>)` gives `vram_before_mib == 1200`, `vram_peak_mib == 5000`.
2. **Unreadable stays null.** A GPU reader returning `(None, None, None)`: `vram_before_mib` and `vram_peak_mib` are `None`, while engine RSS from the process reader is still reported. A window containing only `None` engine values gives `engine_rss_peak_mib is None`.
3. **Background sampling.** `interval_seconds=0.01`, enter, sleep 0.1, exit: the sink has at least 3 lines, each valid JSON with the `phase` set at the time, and no thread remains alive (`threading.active_count()` back to its starting value).
4. **`NvmlGpuReader` without a GPU library.** Monkeypatch `pynvml.nvmlInit` to raise: `read()` returns `(None, None, None)` and does not raise.
5. **`find_listener_pid`.** Open a listening socket on port 0 in the test: the function returns `os.getpid()` for that port and `None` for a port nothing listens on.
6. **`engine_port`.** An identity whose settings have `BaseUrl: "http://127.0.0.1:8098"` gives 8098; a null `BaseUrl` gives `None`.

Run: `pytest tests/test_telemetry.py -v`.

**Acceptance:** no test touches a real GPU; an NVML failure never raises out of the sampler; `telemetry.jsonl` is written incrementally.

---

### Task 5: Profiles and the probe loop

**Goal:** `run_perf` measures every cell of a profile for every variant, one variant at a time, and writes one observation per request.

**Files:**
- Create: `local-evals/src/local_evals/perf.py`
- Modify: `local-evals/src/local_evals/runner.py` (extract `prepare_variant`)
- Create: `local-evals/configs/perf/single-stream.yaml`, `configs/perf/context-matrix.yaml`
- Test: `local-evals/tests/test_perf.py`

**Decisions:**

```python
class PerfProfile(Strict):
    name: str
    # Prompt sizes in tokens. The string "max" means the variant's context minus output and margin.
    cells: list[int | Literal["max"]]
    output_tokens: int                     # max_tokens of every request
    warmups: int                           # 1..3, per cell, not recorded as timed
    repeats: int                           # 1..20 timed requests per cell and cache mode
    cache_modes: list[Literal["cold", "warm"]]
    enable_thinking: bool
    temperature: float
    seed: int
    margin_tokens: int                     # kept free below the context for the "max" cell
    request_timeout_seconds: int
    telemetry_interval_seconds: float

class ResolvedPerf(Strict):
    kind: Literal["perf"]
    name: str
    endpoint_name: str
    endpoint: Endpoint
    profile: PerfProfile
    variants: list[Variant]
    def digest(self) -> str: ...

def resolve_perf(config_dir: Path, *, endpoint: str, profile: str, variants: Sequence[Variant]) -> ResolvedPerf: ...

def classify_failure(result: StreamResult) -> tuple[PerfStatus, str]: ...

def run_perf(manifest: ResolvedPerf, client: BenchClient, sampler_factory: SamplerFactory, runs_root: Path,
             repo_root: Path, now: datetime) -> RunStore: ...
```

- Variant preparation moves out of `run_manifest` into a function both runners call. `run_manifest` behaviour is unchanged; its tests still pass.

```python
@dataclass(frozen=True)
class PreparedVariant:
    identity: Identity
    warm_seconds: float      # wall time of the one-token warm request
    reloaded: bool           # the runtime generation changed across the warm request

def prepare_variant(client: BenchClient, variant: Variant) -> PreparedVariant:
    """Warm chat with the variant's overrides, then identity, which must match; RunError otherwise."""
```

- The probe records `load_seconds` in `variants/<id>/environment.json`: `warm_seconds` when `reloaded` is true, otherwise `null` (the model was already resident and no load was observed).
- Device memory is read before and after preparing each variant and stored beside it as `vram_before_load_mib` and `vram_after_load_mib` (`null` when unreadable). When `reloaded` is false both describe an already-loaded model, and the file says so with `loaded_during_prepare: false`.
- `SamplerFactory` is a small class with two methods, `create(identity: Identity, sink: Path) -> TelemetrySampler` and `gpu_used_mib() -> float | None` (one device reading, usable before any model is loaded); the CLI passes the real one (NVML plus the engine process found from the identity's port), tests pass one built on fake readers.
- `RunStore.create` accepts `ResolvedManifest | ResolvedPerf`, and `RunStore.load_manifest` returns the model that matches the file's `kind`.
- Per variant, per cell, per cache mode:
  - The `max` cell resolves to `settings.NumCtx - output_tokens - margin_tokens` from the variant's identity.
  - A cell larger than `NumCtx - output_tokens` is not attempted: one observation with status `skipped` and detail `exceeds context <NumCtx>`.
  - **cold**: every request uses a prompt nobody has sent before. The ledger seed is `profile.seed + 1000 × repeat_index + cell_index`, with warmups using their own indices, so no request shares a prefix with an earlier one beyond the template.
  - **warm**: one prompt per cell (seed `profile.seed + cell_index`), sent `warmups` times untimed to populate the cache, then `repeats` times timed. The observation's `cached_tokens` shows how much was reused; a warm observation with `cached_tokens` of 0 or `null` keeps its measurements and gets detail `cache was not reused`.
  - The instruction is fixed: `Count from 1 upward, one number per line, and do not stop.` It makes output length depend on `max_tokens`, not on the prompt.
  - The request sets `max_tokens`, `temperature`, `seed`, `chat_template_kwargs.enable_thinking`, and nothing else.
  - Warmup requests are recorded with `phase: "warmup"` and excluded from every summary.
- `classify_failure`, in this order:
  - `transport_error` starting with `timeout` → `timeout`;
  - any other `transport_error` with no frames → `backend_down`;
  - status 200 with a `transport_error` after frames, or a stream with no token event → `stream_error`;
  - a non-200 body matching `out of memory` (case-insensitive) → `oom`;
  - a 4xx body matching `max_seq_len`, `context length`, `too long` or `greater than` → `input_too_long`;
  - any other non-200 → `http_error`.
  The detail is the first 300 characters of the body or error.
- After an `oom`, `backend_down` or `timeout`, the probe waits for the server: it polls `identity` every 5 seconds for up to 180 seconds. If it does not answer, the variant's remaining cells are recorded `skipped` with detail `backend did not recover` and the run moves to the next variant, which gets a fresh prepare. If it answers but the variant no longer matches, prepare it again once.
- Each observation's memory fields come from `sampler.peaks(mark_before, mark_after)`; `residency_hash` and `generation` come from the response headers. An observation whose `generation` differs from the variant's generation at prepare time gets detail `model reloaded` and is excluded from summaries.
- Output: `perf.jsonl`, `telemetry.jsonl`, `environment.json`, `variants/<id>/environment.json`, `state.json` in the run directory.

`configs/perf/single-stream.yaml`:

```yaml
# Everyday prompt sizes, one request at a time.
name: single-stream
cells: [512, 4096, 16384]
output_tokens: 256
warmups: 1
repeats: 5
cache_modes: [cold, warm]
enable_thinking: false
temperature: 0.0
seed: 20261126
margin_tokens: 512
request_timeout_seconds: 900
telemetry_interval_seconds: 0.25
```

`configs/perf/context-matrix.yaml`:

```yaml
# Prefill and memory across the context range. Cold only: warm reuse is covered by single-stream.
name: context-matrix
cells: [512, 4096, 16384, 32768, 65536, 131072, max]
output_tokens: 128
warmups: 1
repeats: 3
cache_modes: [cold]
enable_thinking: false
temperature: 0.0
seed: 20261126
margin_tokens: 1024
request_timeout_seconds: 1800
telemetry_interval_seconds: 0.5
```

**Failing test:** `tests/test_perf.py`, with `FakeBench`, a fake sampler factory, and small profiles built in the test:

1. **Observation count and labelling.** Cells `[400, 800]`, warmups 1, repeats 2, both cache modes, one variant: `perf.jsonl` has `2 cells × (cold: 1 warmup + 2 timed, warm: 1 warmup + 2 timed)` = 12 rows; exactly 8 are `phase == "timed"`; every timed row is `ok` with `prompt_tokens` within 16 of its cell, `ttft_seconds` and `backend_decode_tokens_per_second` set, and the residency hash of the variant.
2. **Cold prompts never repeat; warm prompts do.** Among the bodies the fake received, all cold prompts are pairwise different; each cell's warm prompts are identical; timed warm rows have `cached_tokens > 0` and cold rows have `cached_tokens == 0`.
3. **Requests carry only the profile's settings.** Each body has `max_tokens`, `temperature`, `seed`, `chat_template_kwargs == {"enable_thinking": False}`, `stream`, `stream_options`, `model`, `messages` and no other key.
4. **Cell above the context is skipped, not sent.** `FakeBench(context_tokens=600)` with identity `NumCtx` 600: the 800 cell yields `skipped` rows and no request of that size reached the fake.
5. **`max` cell.** With `NumCtx` 32000, `output_tokens` 100, `margin_tokens` 400: the cell's `cell_tokens` is 31500.
6. **Failure classification**, one assertion per row of the table above, using `StreamResult`s built in the test.
7. **OOM is an outcome and the run continues.** `FakeBench(oom_above_tokens=600)`: 800-token rows are `oom` with detail containing `out of memory`; 400-token rows are `ok`; state is `completed`.
8. **Backend does not recover.** A transport that refuses every request after the first OOM: remaining cells of that variant are `skipped` with `backend did not recover`; the polling wait is cut short by monkeypatching the module's sleep and deadline constants.
9. **Two variants run in order**, each prepared once, with different residency hashes on their rows; `variants/<id>/environment.json` has `load_seconds`, `vram_before_load_mib` and `vram_after_load_mib` set for the variant whose prepare changed the generation, and `load_seconds: null` with `loaded_during_prepare: false` for one that was already resident.
10. **Memory fields.** Fake readers returning rising VRAM: timed rows have `vram_peak_mib >= vram_before_mib`; with a GPU reader returning `None`, both are `None` and the row is still `ok`.

Run: `pytest tests/test_perf.py tests/test_runner.py -v`.

**Acceptance:** no summary input ever includes a warmup, a skipped row or a `model reloaded` row; TTFT and backend decode rate come from different fields in every row.

---

### Task 6: Perf summary

**Goal:** Reduce observations to a table per variant, cell and cache mode, honest about sample size.

**Files:**
- Modify: `local-evals/src/local_evals/perf.py`
- Test: `local-evals/tests/test_perf_summary.py`

**Decisions:**

```python
@dataclass(frozen=True)
class Spread:
    n: int
    median: float
    low: float          # minimum
    high: float         # maximum
    p95: float | None   # only when n >= 20

@dataclass(frozen=True)
class CellSummary:
    variant_id: str
    cell_tokens: int
    cache: Literal["cold", "warm"]
    attempted: int
    ok: int
    failures: Mapping[PerfStatus, int]
    prompt_tokens: Spread | None
    cached_tokens: Spread | None
    ttft_seconds: Spread | None
    total_seconds: Spread | None
    backend_prefill_tokens_per_second: Spread | None
    backend_decode_tokens_per_second: Spread | None
    client_decode_tokens_per_second: Spread | None
    draft_acceptance: float | None        # accepted / (accepted + rejected), summed over ok rows
    vram_peak_mib: float | None           # maximum over ok rows
    engine_rss_peak_mib: float | None
    system_commit_peak_mib: float | None

def spread(values: Sequence[float]) -> Spread | None: ...
def summarize_perf(observations: Sequence[PerfObservation]) -> list[CellSummary]: ...
def render_perf(summaries: Sequence[CellSummary], environment: Mapping[str, Mapping[str, JsonValue]]) -> str: ...
```

- Only `phase == "timed"` rows count. `attempted` includes failures; statistics use `ok` rows that are not marked `model reloaded`.
- `spread` of an empty list is `None`. The median of an even count is the mean of the two middle values. `p95` is nearest-rank (`ceil(0.95 × n)`-th smallest) and only for `n >= 20`.
- A metric whose every value is `null` has a `None` spread and renders as `n/a`, never as 0.
- `render_perf`: per variant, the identity lines from plan 1, `load_seconds` when observed, then a table with columns Cell (tokens), Cache, n ok / attempted, Prompt tokens, Cached, TTFT s, Prefill tok/s (backend), Decode tok/s (backend), Decode tok/s (client, approx.), Draft accept, VRAM peak MiB, Failures. Each numeric cell is `median (low–high)`; `p95` is added only when present. Below the table:
  - `TTFT and total time are client-side and include the SiftKit route. Prefill and decode rates are the engine's own figures.`
  - `VRAM is device-wide dedicated memory; other programs using the GPU are included.`
  - when any backend metric is `n/a`: `The engine reported no <field>; no value was substituted.`

**Failing test:** `tests/test_perf_summary.py`, building `PerfObservation`s directly:

1. `spread([3.0, 1.0, 2.0]) == Spread(3, 2.0, 1.0, 3.0, None)`; `spread([1.0, 2.0, 3.0, 4.0]).median == 2.5`; `spread([]) is None`; twenty values `1..20` give `p95 == 19.0`; nineteen values give `p95 is None`.
2. Five timed `ok` rows, one warmup row with an extreme value, one `oom` row and one `model reloaded` row for the same cell: `attempted == 7`, `ok == 5` (the reloaded row is attempted but not `ok` for statistics), `failures == {"oom": 1}`, medians computed from the five only.
3. Rows whose `backend_decode_tokens_per_second` are all `None`: the spread is `None`, the rendered cell is `n/a`, and the "reported no" note names the field.
4. Draft acceptance: rows with accepted/rejected `(30, 10)` and `(50, 10)` give `0.8`; rows with both `None` give `None`.
5. Rendering contains the two fixed notes and, for a cell with `median 2.0, low 1.0, high 3.0`, the text `2.00 (1.00–3.00)`.

Run: `pytest tests/test_perf_summary.py -v`.

**Acceptance:** `p95` never appears for fewer than 20 observations; no `0` is printed for an unmeasured value.

---

### Task 7: Capacity probe

**Goal:** Find the largest prompt a variant actually serves, stop early on repeated failure, and refuse to start on a GPU that is already in use.

**Files:**
- Create: `local-evals/src/local_evals/capacity.py`
- Test: `local-evals/tests/test_capacity.py`

**Decisions:**

```python
class CapacityProfile(Strict):
    name: str
    start_tokens: int
    growth: float                 # > 1; next size is round(previous × growth)
    output_tokens: int
    margin_tokens: int
    # Refuse to start when the GPU already uses more than this before the variant is loaded.
    vram_ceiling_mib: int
    request_timeout_seconds: int
    seed: int

class CapacityRefused(Exception): ...

@dataclass(frozen=True)
class CapacityResult:
    variant_id: str
    context_tokens: int
    largest_ok_tokens: int | None
    first_failure_tokens: int | None
    first_failure_status: PerfStatus | None
    stopped: Literal["reached_context", "two_consecutive_failures", "backend_down"]
    steps: Sequence[PerfObservation]

def run_capacity(profile: CapacityProfile, variant: Variant, client: BenchClient, sampler_factory: SamplerFactory,
                 store: RunStore) -> CapacityResult: ...
```

- Before preparing the variant, take one GPU reading (`sampler_factory.gpu_used_mib()`). Above `vram_ceiling_mib`: `CapacityRefused` naming the reading and the ceiling. A `null` reading is also a refusal: `GPU memory could not be read; the ceiling cannot be checked`.
- Sizes: `start_tokens`, then multiplied by `growth` each step, capped at `NumCtx - output_tokens - margin_tokens`; the cap itself is always the last size tried.
- Each step is one cold request built like a perf cell, recorded as a `PerfObservation` with `profile` set to the capacity profile's name.
- Stop rules, checked after every step in this order:
  - a failure after which the server does not answer identity within the same recovery wait as Task 5 → `backend_down`;
  - the last two steps both failed → `two_consecutive_failures`;
  - the cap was just tried → `reached_context`.
  One isolated failure followed by a success is recorded and the probe continues.
- The probe never deliberately sends more than the context: overflow behaviour is already covered by `doctor --check-overflow`.
- `configs/perf/capacity.yaml`: `start_tokens: 8192`, `growth: 2.0`, `output_tokens: 64`, `margin_tokens: 1024`, `vram_ceiling_mib: 2500`, `request_timeout_seconds: 1800`, `seed: 20261126`.

**Failing test:** `tests/test_capacity.py`:

1. **Refusal.** A GPU reader reporting 6000 MiB with ceiling 2500: `CapacityRefused`, no request sent, no model prepared. A reader returning `None`: refused with `could not be read`.
2. **Reaches the context.** `NumCtx` 32000, start 4000, growth 2, output 100, margin 400: sizes tried are 4000, 8000, 16000, 31500; `largest_ok_tokens == 31500`, `stopped == "reached_context"`, `first_failure_tokens is None`.
3. **Two consecutive failures.** `oom_above_tokens=10000`: 4000 and 8000 succeed, 16000 and 31500 fail; `largest_ok_tokens == 8000`, `first_failure_tokens == 16000`, `first_failure_status == "oom"`, `stopped == "two_consecutive_failures"`.
4. **One isolated failure does not stop it.** A fake that fails only the second request: the probe continues and reports the later success as the largest.
5. **Backend down.** A transport refusing everything after the first failure, with the recovery wait monkeypatched short: `stopped == "backend_down"`.

Run: `pytest tests/test_capacity.py -v`.

**Acceptance:** the size sequence in case 2 is exact; a refusal leaves no run directory content beyond the manifest and state.

---

### Task 8: Custom long-context tasks

**Goal:** Four kinds of long-input question over the ledger corpus, each with one exact answer, scored without a judge.

**Files:**
- Create: `local-evals/src/local_evals/tasks/long_context.py`
- Create: `local-evals/fixtures/long_context/v1.jsonl`
- Modify: `local-evals/src/local_evals/tasks/inspect_bindings.py`, `configs/tasks.yaml`
- Test: `local-evals/tests/test_long_context_task.py`

**Decisions:**

A case is a *specification*; the haystack is generated from it, so fixtures stay small and reproducible:

```python
class LongCase(Strict):
    id: str
    kind: Literal["needle", "multi_needle", "join", "conflict"]
    seed: int
    records: int               # ledger length; fixes the prompt size for a given tokenizer
    nominal_tokens: int        # the size this case is meant to be, for labelling
    depth: float               # 0..1, relative position of the (first) target record

@dataclass(frozen=True)
class BuiltCase:
    prompt: str
    answer: str
    # An answer that shows a specific mistake: the superseded value in a conflict case; None otherwise.
    stale_answer: str | None

@dataclass(frozen=True)
class LongScore:
    correct: float
    stale: float               # 1.0 when the stale answer was given
    status: SampleStatus       # correct | incorrect | invalid_format
    explanation: str

def load_long_cases(path: Path) -> list[LongCase]: ...
def build_case(case: LongCase) -> BuiltCase: ...
def score_long_case(output: str, built: BuiltCase) -> LongScore: ...
```

Construction, all from `random.Random(case.seed)` and `generate_ledger(case.seed, case.records)`:
- **needle** — the target is the record at index `round(depth × (records - 1))`. Question: `How many units did warehouse <W> ship on day <D>?` Answer: its units.
- **multi_needle** — three targets at depths `depth`, `(depth + 1/3) mod 1`, `(depth + 2/3) mod 1`. Question asks for the total units of the three named `(warehouse, day)` pairs. Answer: the sum.
- **join** — the ledger is followed by a second document, a price list of 40 lines in shuffled order: the target's item and 39 other distinct items from the ledger (fewer when the ledger has fewer), each as `Item QX-77 costs 12 credits per unit.` with prices 1..99 from the same generator. Forty lines keep the added length small and constant across sizes. Question: `What is the price per unit of the item that warehouse <W> shipped on day <D>?` Answer: that price. The answer is in neither document alone.
- **conflict** — after the ledger comes a section headed `Corrections (these replace the original records):` with three corrected records; one of them corrects the target's units to a different value. Question as for needle, plus `Apply any corrections.` Answer: the corrected units. `stale_answer`: the original units.

Every prompt ends with: `Answer with the number only on the last line, in the form "ANSWER: <number>".`

Scoring:
- The answer is read from the last line matching `ANSWER:\s*(-?\d+)`. No such line → `invalid_format`, `correct 0.0`.
- Equal to `answer` → `correct`. Equal to `stale_answer` → `incorrect` with `stale 1.0`. Anything else → `incorrect`.

Fixture `fixtures/long_context/v1.jsonl`: for each nominal size in 4096, 16384, 32768, 65536, 131072 and each kind, five cases at depths 0.0, 0.25, 0.5, 0.75, 1.0 — 100 cases. Ids are `lc-<kind>-<size>-<depth index>`; seeds are `1000 + line index`. `records` is `round(nominal_tokens / TOKENS_PER_RECORD)` with `TOKENS_PER_RECORD = 24`, a constant of fixture version 1.

- [ ] **Calibration step (needs the reference model's tokenizer; otherwise keep 24 and record `not calibrated`).** With a server running, measure tokens per record with `sized_prompt` on the reference preset and, if it differs from 24 by more than 10%, set the constant to the measured value rounded to one decimal *before* the fixture is first frozen. After freezing, the constant never changes; a different tokenizer simply yields different measured lengths, which the records carry in `prompt_tokens`.

The generator script that writes the fixture is `python -m local_evals.tasks.long_context --write-fixture`; the file it writes is committed.

Binding: `local_evals/long_context` in `LOCAL_TASKS`, with task arguments `nominal_tokens: int | None` and `kind: str | None` that filter the cases, so a suite can hold one entry per size. Scorer `long_context_scorer` returns `{"correct": ..., "stale": ...}`. Sample metadata carries `kind`, `nominal_tokens`, `depth`.

Catalogue entry: `id: local_evals/long_context`, `factory: null`, `tools: false`, `sandbox: false`, `judge: false`, `gated: false`, `dataset: null`, `primary_metric: long_context_scorer.correct`, `report_metrics: [long_context_scorer.stale]`, `stratify_by: kind`.

**Failing test:** `tests/test_long_context_task.py`:

1. The fixture has 100 cases with unique ids, 25 per kind, 20 per size; `build_case` is deterministic.
2. **needle**: the answer equals the units of the one ledger line naming that warehouse and day, and that line's position in the prompt is at the stated depth (first line for 0.0, last for 1.0).
3. **multi_needle**: the answer equals the sum of the three named records, and the three are distinct.
4. **join**: the price list comes after the ledger and has at most 40 lines; the answer equals the price on the list's line for the item named in the target's ledger line; the question names neither the item nor a price.
5. **conflict**: the corrected value differs from the original; both the original record and the correction are in the prompt; `stale_answer` is the original.
6. **Scoring**: `"reasoning...\nANSWER: 418"` → correct; `"ANSWER: 17\nANSWER: 418"` → correct (last line wins); `"418"` → `invalid_format`; a conflict case answered with the original value → `incorrect`, `stale 1.0`.
7. **Binding**: `list_samples("local_evals/long_context", {"nominal_tokens": 4096}, None, "kind")` returns 20 samples in four strata; a mock-model run of one case answering `ANSWER: <right>` is `correct` with both metrics present.
8. Prompt size sanity without a tokenizer: for each size, the prompt's character count is between 3 and 6 times `nominal_tokens`.

Run: `pytest tests/test_long_context_task.py tests/test_inspect_evaluator.py -v`.

**Acceptance:** every case's answer is derivable from its prompt by the test's own independent lookup; `tasks/long_context.py` does not import `inspect_ai`.

---

### Task 9: Upstream long-context tasks, the `long_context` suite and the context experiment

**Goal:** Add maintained long-context benchmarks where they run without a judge, freeze the suite, and define the context experiment. This task downloads datasets.

**Files:**
- Modify: `local-evals/configs/tasks.yaml`
- Create: `local-evals/configs/suites/long_context.yaml`, `manifests/long_context/*.json`
- Create: `local-evals/configs/experiments/context.yaml`
- Modify: `local-evals/tests/test_shipped_configs.py`

**Decisions:**

- [ ] **Step 1: Verify upstream tasks** with the procedure and rules of plan 2 Task 12 Step 1, for `inspect_evals/niah` and the `inspect_evals/infinite_bench_*` family. In addition record for each:
  - the token length range of its samples, and whether the task itself truncates inputs (and with which tokenizer); a task that silently truncates to a context it guesses is catalogued only if the truncation can be switched off or set explicitly by a task argument;
  - whether its scorer needs a grader model. `niah` is expected to; if so it is `judge: true`, left out of this suite, and listed for plan 4.
  From `infinite_bench_*`, take at most three tasks whose scorers are exact or inclusion matches (retrieval of a key, a number or a passkey are the likely ones).
- [ ] **Step 2: Suite.** `configs/suites/long_context.yaml` holds:
  - five entries of the custom task, one per size, `name: lc-<size>` (`lc-4k`, `lc-16k`, `lc-32k`, `lc-64k`, `lc-128k`), `task_args: { nominal_tokens: <size> }`, all 20 cases, `max_tokens: 8192`;
  - one entry per accepted upstream task, 20 samples, `max_tokens: 8192`.
  Freeze with seed `20261126` into `manifests/long_context/`.
- [ ] **Step 3: Context experiment.** `configs/experiments/context.yaml`:

```yaml
# The same long-input samples at increasing context sizes. A sample that does not fit a variant's
# context is `input_too_long`, and that length is reported infeasible for the variant, not wrong.
name: context-27b
endpoint: siftkit-local
generation: fixed-v1
suite: long_context
reference: ctx-170k
changed_field: NumCtx
repeats: 1
variants:
  - id: ctx-170k
    preset: exl3-3-8-27b-5bpw
  - id: ctx-64k
    preset: exl3-3-8-27b-5bpw
    overrides: { NumCtx: 65536 }
  - id: ctx-32k
    preset: exl3-3-8-27b-5bpw
    overrides: { NumCtx: 32768 }
```

  The reference is the saved preset, whose context is the largest. Matched lengths are the suite entries every variant can fit; the larger entries show where a smaller context becomes infeasible.

**Failing test:** extend `tests/test_shipped_configs.py`: the `long_context` suite and its manifests satisfy the same checks as the other suites; the five custom entries have distinct keys and each manifest holds exactly 20 ids; `context.yaml` resolves.

**Acceptance:** each upstream candidate is in the suite or listed in the README with its reason; `local-evals plan --experiment configs/experiments/context.yaml` prints one `NumCtx` diff per non-reference variant and no multi-field warning.

---

### Task 10: Quality, speed and memory side by side

**Goal:** One table per variant joining a quality run and a perf run, with the variants that are not dominated marked.

**Files:**
- Create: `local-evals/src/local_evals/tradeoff.py`
- Test: `local-evals/tests/test_tradeoff.py`

**Decisions:**

```python
class TradeoffError(Exception): ...

@dataclass(frozen=True)
class TradeoffRow:
    variant_id: str
    quality: float | None              # mean of per-task accuracy on completed samples, over the chosen tasks
    quality_tasks: int
    coverage: float | None             # completed / planned over those tasks
    decode_tokens_per_second: float | None     # backend median at the chosen cell, cold
    prefill_tokens_per_second: float | None
    ttft_seconds: float | None
    vram_peak_mib: float | None        # maximum over the perf run's cells
    pareto: bool | None                # None when a needed value is missing
    notes: Sequence[str]

def pareto_front(points: Mapping[str, tuple[float, float, float]]) -> set[str]:
    """Ids not dominated on (quality up, decode speed up, VRAM down)."""

def build_tradeoff(quality: Sequence[VariantData], perf_rows: Sequence[PerfObservation],
                   perf_variants: Mapping[str, Mapping[str, JsonValue]], *, tasks: Sequence[str] | None,
                   cell_tokens: int) -> list[TradeoffRow]: ...
def render_tradeoff(rows: Sequence[TradeoffRow], *, cell_tokens: int) -> str: ...
```

- A variant is joined by id. The residency hash recorded for it in the quality run must equal the one in the perf run; otherwise the row keeps its numbers and gets the note `quality and speed were measured on different loaded configurations` and `pareto` is `None`.
- A variant present in only one run appears with the missing side `None` and a note.
- `quality` averages per-task accuracy (on completed samples) over `tasks`, or over all tasks of the run when `tasks` is `None`. A variant marked infeasible has `quality None` and the note `infeasible`.
- A point dominates another when it is at least as good on all three axes and strictly better on one. `pareto_front` only considers variants with all three values present.
- Rendering: columns Variant, Quality, Coverage, Decode tok/s, Prefill tok/s, TTFT s, VRAM peak MiB, Pareto, Notes; then: `Quality is unweighted mean accuracy over <n> tasks; speed is the engine's figure at <cell> prompt tokens, cold cache; VRAM is the device-wide peak.` and `A Pareto mark means no other listed variant is at least as good on quality, decode speed and VRAM together. It is not a recommendation.`

**Failing test:** `tests/test_tradeoff.py`:

1. `pareto_front` with `a (0.8, 50, 20000)`, `b (0.7, 60, 18000)`, `c (0.7, 40, 21000)`, `d (0.8, 50, 20000)`: the front is `{a, b, d}` (`c` is dominated by `a`; equal points do not dominate each other).
2. A single point is on the front; an empty mapping gives an empty set.
3. `build_tradeoff` for two variants with matching residency hashes: values come from the right fields (quality from records, decode median from timed cold `ok` rows at the chosen cell only, VRAM as the maximum over all cells).
4. Mismatched residency hash: note present, `pareto is None`. Variant missing from the perf run: speed fields `None`, note present.
5. A variant whose perf rows at the chosen cell are all failures: `decode_tokens_per_second is None`, `pareto is None`.
6. Rendering contains both fixed sentences.

Run: `pytest tests/test_tradeoff.py -v`.

**Acceptance:** the Pareto example matches exactly; no row is silently dropped.

---

### Task 11: CLI and doctor

**Goal:** `perf`, `capacity` and `tradeoff` commands; a telemetry check in `doctor`.

**Files:**
- Modify: `local-evals/src/local_evals/cli.py`, `src/local_evals/doctor.py`
- Modify: `local-evals/tests/test_cli.py`, `tests/test_doctor.py`

**Decisions:**

```
local-evals perf      (--model <preset> | --experiment <file>) --profile <name> [--variant <id>] [--dry-run]
local-evals capacity  (--model <preset> | --experiment <file>) [--variant <id>] [--profile capacity] --confirm
local-evals tradeoff  --quality <run-id> --perf <run-id> [--task <key> ...] [--cell <tokens>]
local-evals report    --run-id <id>          # a perf run prints the perf table
```

- `--experiment` reuses an experiment file's variants (endpoint, variants and their overrides); its suite and generation are ignored by `perf`.
- `perf --dry-run` prints variants, cells, cache modes, request count and an upper bound on time (`requests × request_timeout_seconds`) and contacts nothing.
- `capacity` refuses to run without `--confirm`, printing: `This probe raises prompt size until the model fails and can exhaust GPU memory. Close other GPU programs, then pass --confirm.` With an experiment file it requires `--variant`.
- After `perf`, the CLI writes `perf.summary.json` and `report.md` (Task 6's rendering) and prints the table. `report --run-id` on a run whose manifest kind is `perf` prints that file.
- `tradeoff` defaults `--cell` to 4096 and exits 2 with `TradeoffError` when the perf run has no timed row at that cell, listing the cells it has.
- `doctor` gains a `telemetry` check after `identity`: `ok` with the GPU's total memory and the engine pid when both are readable; `unsupported` naming what is not readable (`GPU memory`, `engine process`) otherwise. It never fails a doctor run.

**Failing test:**

- `tests/test_doctor.py`: with fake readers injected, `telemetry` is `ok`; with a GPU reader returning `None` it is `unsupported` and names `GPU memory`; `has_failure` stays false.
- `tests/test_cli.py`:
  1. `perf --model m --profile single-stream --dry-run --json` prints 3 cells × 2 cache modes and a request count of `3 × (1 + 5) + 3 × (1 + 5)` = 36, and makes no request.
  2. `capacity --model m` without `--confirm` exits 2 with the warning text and makes no request.
  3. `tradeoff` against two run directories built in the test prints the table; an unknown `--cell` exits 2 listing available cells.
  4. `report --run-id <perf run>` prints the perf table.

Run: `pytest tests/test_cli.py tests/test_doctor.py -v`.

**Acceptance:** no command in this task loads a model in a test; `capacity` cannot start without `--confirm`.

---

### Task 12: README, validation, real measurements

**Files:**
- Modify: `local-evals/README.md`

- [ ] **Step 1: README.** Add a "Performance" section:
  - the metric table from the spec, with the source of each value and the sentence that client and backend timing are separate measurements;
  - what `cold` and `warm` mean here, and that the saved presets keep their prompt cache on a RAM disk, so `warm` measures that tier;
  - that VRAM is device-wide;
  - the capacity probe's risk and its ceiling;
  - how long-context accuracy is reported per size and why a size can be `infeasible`;
  - how to read the trade-off table.
  Add capability rows: `psutil` and NVML import on this Python; engine reports backend timing in streamed usage; engine reports cached tokens; engine reports draft acceptance; tokens per ledger record on the reference tokenizer; each upstream long-context task's status.
- [ ] **Step 2: Full validation.** `pytest`, `ruff check .`, `pyright` from `local-evals/`; `npm run typecheck` and `npm test` from the root (unchanged TypeScript must stay green). All exit 0.
- [ ] **Step 3: Offline checks.** `local-evals perf --model exl3-3-8-27b-5bpw --profile single-stream --dry-run` and `local-evals plan --experiment configs/experiments/context.yaml` print their plans and contact nothing.
- [ ] **Step 4: Real measurements (need a running SiftKit and the user's go-ahead for each).** When not available or not authorized, record `blocked` in the README and give the user the commands, in this order:

```powershell
local-evals doctor --model exl3-3-8-27b-5bpw
local-evals perf --model exl3-3-8-27b-5bpw --profile single-stream
local-evals perf --experiment configs/experiments/drafting.yaml --profile single-stream
local-evals perf --experiment configs/experiments/context.yaml --profile context-matrix
local-evals run --experiment configs/experiments/context.yaml
local-evals tradeoff --quality <quality run> --perf <perf run>
```

  `capacity` is not in this list: run it only when the user asks for it by name, with other GPU programs closed.
  For each run made, fill the capability rows from the observations (a backend field that came back `null` in every row is recorded as not reported) and note the run id.
- [ ] **Step 5: Clean up** `.scratch/local-evals`.

**Acceptance:** the spec's sub-project 3 "done when" holds under mocks — probes run against a mocked streaming endpoint with TTFT and decode never conflated (Task 2), unsupported telemetry is `null` (Task 4), OOM is recorded as a reliability outcome (Task 5); real measurements are reported with run ids or marked blocked.

---

## Handoff contents

Files changed; commands executed; test results; the capability rows; the perf table and trade-off table for any real run, with their run ids; which upstream long-context tasks were accepted; anything blocked and why.
